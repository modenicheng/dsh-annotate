/**
 * The connection layer's cached-discovery contract, without a browser.
 *
 * `src/background/connection.js` is a classic script resolved against the
 * shared background namespace, so it is evaluated in a `node:vm` context with
 * the real protocol/endpoints/discovery scripts and fake storage, log, and
 * fetch seams. These tests pin the parts the socket relies on: when the
 * 10-minute scheme cache may be reused (TTL, address and scheme match) and
 * what a cache hit must carry back (the instanceId the host answered with).
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)

const INSTANCE = '9f1c0b7a5e2d4c31'
const ADDRESS = { host: '127.0.0.1', port: 3080, secure: null }

const HEALTH_BODY = {
  ok: true,
  secure: false,
  wsUrl: 'ws://127.0.0.1:3080/ext/anno',
  instanceId: INSTANCE,
}

/**
 * Boot the connection layer.
 *
 * @param {{ store?: Record<string, any>, health?: any[] }} [options] a fake
 *   storage area prefilled by the caller, and a queue of health bodies the
 *   fake `fetch` answers with (each popped once, in order).
 */
async function loadConnection(options = {}) {
  const store = { ...(options.store || {}) }
  const healthQueue = [...(options.health || [])]
  const fetched = []
  const removed = []
  const sandbox = {
    console: { debug() {}, info() {}, warn() {}, error() {} },
    URL,
    TextEncoder,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url) => {
      fetched.push(String(url))
      const body = healthQueue.shift()
      if (body instanceof Error) throw body
      return { ok: body !== undefined, status: 200, json: async () => body }
    },
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  for (const path of ['src/shared/protocol.global.js', 'src/background/endpoints.js', 'src/background/discovery.js']) {
    vm.runInContext(await readFile(join(extensionRoot, path), 'utf8'), context, { filename: path })
  }
  const ns = sandbox.__DSH_ANNO_BG__
  ns.storageGet = async (key, fallback) => (Object.hasOwn(store, key) ? store[key] : fallback)
  ns.storageSet = async (key, value) => {
    store[key] = value
  }
  ns.storageRemove = async (key) => {
    removed.push(key)
    delete store[key]
  }
  ns.log = { debug() {}, info() {}, warn() {} }
  ns.describeError = (error) => String(error?.message ?? error)
  ns.isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  ns.msg = { STORAGE_KEYS: { endpoint: 'anno.endpoint', address: 'anno.address' } }
  ns.setNetState = () => {}
  ns.prefs = {}
  ns.publishStatus = () => Promise.resolve()
  vm.runInContext(await readFile(join(extensionRoot, 'src/background/connection.js'), 'utf8'), context, {
    filename: 'src/background/connection.js',
  })
  return { connection: ns.connection, store, removed, fetched }
}

/** A scheme-cache record exactly as `rememberDiscovery` would store it. */
function cachedRecord(overrides = {}) {
  return {
    host: ADDRESS.host,
    port: ADDRESS.port,
    configuredSecure: null,
    secure: false,
    wsUrl: 'ws://127.0.0.1:3080/ext/anno',
    healthUrl: 'http://127.0.0.1:3080/ext/anno/health',
    instanceId: INSTANCE,
    at: Date.now(),
    ...overrides,
  }
}

test('a fresh cache hit is reused and carries the stored instanceId', async () => {
  const { connection, fetched } = await loadConnection({ store: { 'anno.endpoint': cachedRecord() } })
  const found = await connection.resolve(ADDRESS, { mode: 'manual' })
  assert.equal(found.source, 'health')
  assert.equal(found.wsUrl, 'ws://127.0.0.1:3080/ext/anno')
  assert.equal(found.instanceId, INSTANCE, 'the cache hit reports which instance answered')
  assert.equal(fetched.length, 0, 'a valid cache entry means no probe at all')
})

test('a cache entry past the ten-minute TTL is probed again', async () => {
  const stale = cachedRecord({ at: Date.now() - 10 * 60_000 - 1_000 })
  const { connection, fetched } = await loadConnection({
    store: { 'anno.endpoint': stale },
    health: [HEALTH_BODY],
  })
  const found = await connection.resolve(ADDRESS, { mode: 'manual' })
  assert.equal(fetched.length, 1, 'the stale entry forces a fresh probe')
  assert.equal(found.instanceId, INSTANCE, 'the probe answer carries the instanceId too')
})

test('a cache entry for another address or scheme is ignored', async () => {
  for (const label of ['another host', 'another port', 'another configured scheme']) {
    const record = cachedRecord(
      label === 'another host'
        ? { host: 'localhost' }
        : label === 'another port'
          ? { port: 8123 }
          : { configuredSecure: true },
    )
    const { connection, fetched } = await loadConnection({
      store: { 'anno.endpoint': record },
      health: [HEALTH_BODY],
    })
    const found = await connection.resolve(ADDRESS, { mode: 'manual' })
    assert.equal(fetched.length > 0, true, `${label}: the mismatched entry is not reused`)
    assert.equal(found.wsUrl, 'ws://127.0.0.1:3080/ext/anno')
  }
})

test('a successful probe remembers the instanceId for the next cache hit', async () => {
  const { connection, store } = await loadConnection({ health: [HEALTH_BODY] })
  await connection.resolve(ADDRESS, { mode: 'manual' })
  const record = store['anno.endpoint']
  assert.equal(record.instanceId, INSTANCE, 'the scheme cache stores who answered')
})

test('invalidate clears the storage key through the ns shim', async () => {
  const { connection, store, removed, fetched } = await loadConnection({
    store: { 'anno.endpoint': cachedRecord() },
    health: [HEALTH_BODY],
  })
  await connection.invalidate()
  assert.equal('anno.endpoint' in store, false)
  assert.deepEqual(removed, ['anno.endpoint'], 'the removal went through ns.storageRemove')
  await connection.resolve(ADDRESS, { mode: 'manual' })
  assert.equal(fetched.length, 1, 'the next attempt probes again')
})
