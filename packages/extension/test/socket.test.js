/**
 * The socket's retry policy, without a browser.
 *
 * `src/background/socket.js` is evaluated in a `node:vm` context with a fake
 * `WebSocket`, fake timers the tests advance by hand, and a pinned
 * `Math.random` so the jitter arithmetic is exact. These tests pin the parts
 * the reconnect cadence relies on: the exponential delays, the jitter bounds,
 * the 4403 attempt bump, and the backoff position surviving an event-page
 * restart through the persisted status record.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)

const WS_URL = 'ws://127.0.0.1:3080/ext/anno'

/** A WebSocket whose lifecycle the test drives by hand. */
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  constructor(url) {
    this.url = String(url)
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    FakeWebSocket.instances.push(this)
  }

  send(text) {
    this.sent.push(String(text))
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED
    if (this.onclose) this.onclose({ code, reason })
  }

  /** Fail before the handshake, the way a refused connection does. */
  fail(code = 1006) {
    if (this.onerror) this.onerror({})
    this.close(code, '')
  }
}
FakeWebSocket.instances = []

/**
 * Boot the socket module.
 *
 * @param {{ store?: Record<string, any>, random?: number }} [options] the fake
 *   storage area (prefilled with `anno.status` to model a restart) and the
 *   value `Math.random` is pinned to inside the realm.
 */
async function loadSocket(options = {}) {
  const store = { ...(options.store || {}) }
  FakeWebSocket.instances.length = 0
  /** Fake timers: due callbacks run only when the test advances the clock. */
  let now = 0
  const timers = new Map()
  let timerId = 0

  const sandbox = {
    console: { debug() {}, info() {}, warn() {}, error() {} },
    WebSocket: FakeWebSocket,
    navigator: { userAgent: 'socket-test' },
    setTimeout: (fn, ms) => {
      timerId += 1
      timers.set(timerId, { at: now + Number(ms || 0), fn })
      return timerId
    },
    clearTimeout: (id) => {
      timers.delete(id)
    },
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  const pinned = options.random === undefined ? 0.5 : options.random
  vm.runInContext(`Math.random = () => ${pinned}`, context)

  const ns = {
    PROTOCOL: {
      PROTOCOL_VERSION: 1,
      HELLO_TIMEOUT_MS: 5_000,
      encodeFrame: (frame) => JSON.stringify(frame),
      parseServerFrame: () => ({ ok: false, reason: 'not needed here' }),
    },
    manifest: { version: '0.0.0-test' },
    msg: { STORAGE_KEYS: { lastStatus: 'anno.status' } },
    netState: {
      connection: 'idle',
      attempts: 0,
      nextRetryAt: 0,
      lastError: null,
      connectedAt: 0,
      lastPongAt: 0,
      lastFrameAt: 0,
      tokenPresent: false,
      wsUrl: '',
      secure: false,
      wsUrlSource: 'health',
      healthUrl: '',
      discoveryError: '',
      discoveryMode: 'manual',
      discoverySource: 'manual',
      instanceId: '',
      discovered: [],
      discoveryFailures: [],
    },
    storageGet: async (key, fallback) => (Object.hasOwn(store, key) ? store[key] : fallback),
    storageSet: async (key, value) => {
      store[key] = value
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    describeError: (error) => String(error?.message ?? error),
    isPlainObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    setNetState(patch) {
      Object.assign(ns.netState, patch)
    },
    publishStatus() {
      // The one persistence the restart path depends on: the status record.
      store['anno.status'] = { ...ns.netState }
      return Promise.resolve()
    },
    readPrefs: async () => ({ host: '127.0.0.1', port: 3080, secure: null }),
    readToken: async () => 'token',
    normalizeAddress: (host, port, secure) => ({ host, port, secure }),
    discoveryModeOf: () => 'manual',
    ensureClientId: async () => 'client-test',
    endpoints: {
      fallbackWsUrl: () => WS_URL,
      formatAuthority: () => '127.0.0.1:3080',
      describeClose: ({ code, reason }) => `close ${code}${reason === '' ? '' : ` (${reason})`}`,
    },
    connection: {
      resolve: async () => ({
        wsUrl: WS_URL,
        secure: false,
        source: 'health',
        healthUrl: '',
        error: '',
        instanceId: '',
      }),
      invalidate: async () => {},
    },
  }
  sandbox.__DSH_ANNO_BG__ = ns
  vm.runInContext(await readFile(join(extensionRoot, 'src/background/socket.js'), 'utf8'), context, {
    filename: 'src/background/socket.js',
  })

  /** Deliver every fake timer that has come due at the (virtual) moment. */
  function advance(ms) {
    now += ms
    for (const [id, timer] of [...timers.entries()]) {
      if (timer.at <= now) {
        timers.delete(id)
        timer.fn()
      }
    }
  }

  return { net: ns.net, ns, store, advance, sockets: () => FakeWebSocket.instances }
}

/** The delay the last scheduleRetry picked: nextRetryAt minus the wall clock. */
function delayFrom(harness) {
  return harness.ns.netState.nextRetryAt - Date.now()
}

/** Run one failed attempt: connect, let the handshake fail. */
async function failOnce(harness, closeCode = 1006) {
  await harness.net.connect({ reason: 'test' })
  harness.sockets().at(-1).fail(closeCode)
}

test('each failed attempt doubles the delay, capped at 30 s', async () => {
  const harness = await loadSocket({ random: 0.5 })
  // With jitter pinned to the middle the factor is exactly 1.
  await failOnce(harness)
  assert.equal(harness.ns.netState.attempts, 1)
  assert.ok(Math.abs(delayFrom(harness) - 1_000) <= 25, `first delay ~1 s, got ${delayFrom(harness)}`)

  await failOnce(harness)
  assert.equal(harness.ns.netState.attempts, 2)
  assert.ok(Math.abs(delayFrom(harness) - 2_000) <= 25, `second delay ~2 s, got ${delayFrom(harness)}`)

  // Cap: attempts beyond the max exponent keep the 30 s delay.
  for (let index = 0; index < 5; index += 1) await failOnce(harness)
  assert.equal(harness.ns.netState.attempts, 7)
  assert.ok(Math.abs(delayFrom(harness) - 30_000) <= 25, `late delay capped at 30 s, got ${delayFrom(harness)}`)

  // The scheduled retry really fires and opens the next socket (its attempt
  // resolves on a microtask, so flush before counting).
  harness.advance(30_000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.sockets().length, 8, 'the timer reconnects')
})

test('jitter keeps the delay inside [0.8, 1.2] of the base, floored at 1 s', async () => {
  for (const [pinned, expected] of [
    [0, 1_000],
    [1, 1_200],
  ]) {
    const harness = await loadSocket({ random: pinned })
    await failOnce(harness)
    assert.ok(
      Math.abs(delayFrom(harness) - expected) <= 25,
      `jitter ${pinned} gives ${expected} ms, got ${delayFrom(harness)}`,
    )
  }
})

test('a rejected token bumps the attempts so retries start slow', async () => {
  const harness = await loadSocket({ random: 0.5 })
  await failOnce(harness, 4403)
  // The bump raises the stored attempts to the max exponent minus one, and
  // the retry scheduled on the same close is already attempt 5: base 16 s.
  assert.equal(harness.ns.netState.attempts, 5)
  assert.ok(Math.abs(delayFrom(harness) - 16_000) <= 25, `bumped delay ~16 s, got ${delayFrom(harness)}`)
  await failOnce(harness)
  assert.ok(Math.abs(delayFrom(harness) - 30_000) <= 25, 'the cadence stays at the 30 s cap')
})

test('a pending backoff survives an event-page restart via the status record', async () => {
  const first = await loadSocket({ random: 0.5 })
  for (let index = 0; index < 5; index += 1) await failOnce(first)
  assert.equal(first.ns.netState.attempts, 5)
  assert.equal(first.store['anno.status'].attempts, 5, 'the retry state is persisted with the status')

  // A "restart": a fresh socket module whose netState is empty, reading the
  // same storage. The stored nextRetryAt is 30 s ahead of the real clock, so
  // it still counts as pending.
  const second = await loadSocket({
    random: 0.5,
    store: { 'anno.status': first.store['anno.status'] },
  })
  await second.net.connect({ reason: 'ensure' })
  assert.equal(second.ns.netState.attempts, 5, 'the restored backoff carried over')
  // The restored attempt count shapes the next delay, not a fresh 1 s one.
  second.sockets().at(-1).fail(1006)
  assert.equal(second.ns.netState.attempts, 6)
  assert.ok(Math.abs(delayFrom(second) - 30_000) <= 25, 'the restart keeps the 30 s cadence')
})

test('an expired or absent backoff record changes nothing', async () => {
  const expired = await loadSocket({
    store: { 'anno.status': { attempts: 5, nextRetryAt: Date.now() - 60_000 } },
  })
  await expired.net.connect({ reason: 'ensure' })
  expired.sockets().at(-1).fail(1006)
  assert.equal(expired.ns.netState.attempts, 1, 'a stale record is not restored')

  const garbage = await loadSocket({ store: { 'anno.status': { attempts: 'many' } } })
  await garbage.net.connect({ reason: 'ensure' })
  garbage.sockets().at(-1).fail(1006)
  assert.equal(garbage.ns.netState.attempts, 1, 'a malformed record is ignored')
})
