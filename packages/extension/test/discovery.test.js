/**
 * The discovery core, without a browser.
 *
 * `src/background/discovery.js` is a classic script (the background event page
 * and the popup have no module loader), so it is evaluated in a `node:vm`
 * context that contains the generated protocol global and nothing else the
 * script may touch. Everything is pure and synchronous except `collectHosts`,
 * whose `request` is injected: the one timer it owns is the per-request
 * timeout, and the timeout test spends a real 20 ms rather than faking a clock.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)
const SCRIPTS = ['src/shared/protocol.global.js', 'src/background/discovery.js']

/** Evaluate the extension's discovery module and return its published API. */
async function loadDiscovery() {
  const sandbox = {
    console: { debug() {}, info() {}, warn() {}, error() {} },
    URL,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  for (const path of SCRIPTS) {
    const code = await readFile(join(extensionRoot, path), 'utf8')
    vm.runInContext(code, context, { filename: path })
  }
  const discovery = sandbox.__DSH_ANNO_BG__?.discovery
  assert.ok(discovery !== undefined, 'discovery.js published ns.discovery')
  return discovery
}

/**
 * A structural copy, so assertions compare data across the `vm` realm boundary
 * instead of each object's prototype identity.
 * @param {any} value
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

/** @param {number} ms */
function after(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const INSTANCE = '9f1c0b7a5e2d4c31'
const STARTED_AT = '2026-11-19T13:59:00.000Z'
const FOCUS_AT = '2026-11-19T14:03:11.000Z'
const NOW = Date.parse('2026-11-19T14:10:00.000Z')

/** The documented locator answer, §5 of docs/DISCOVERY.md. */
const LOCATE_BODY = {
  app: 'dsh-marker',
  version: 1,
  instanceId: INSTANCE,
  origin: 'http://127.0.0.1:51234',
  wsUrl: 'ws://127.0.0.1:51234/ext/anno',
  startedAt: STARTED_AT,
  focusAt: FOCUS_AT,
  profile: 'desktop',
}

/** What `parseLocate` must make of that answer. */
const EXPECTED_HOST = {
  origin: 'http://127.0.0.1:51234',
  instanceId: INSTANCE,
  profile: 'desktop',
  startedAt: STARTED_AT,
  focusAt: FOCUS_AT,
  port: 51234,
}

/** The documented endpoint record, §6 of docs/DISCOVERY.md, plus a stray token. */
const ENDPOINT_RECORD = {
  version: 1,
  app: 'dsh-marker',
  instanceId: INSTANCE,
  pid: 23144,
  profile: 'desktop',
  origin: 'http://127.0.0.1:51234',
  wsUrl: 'ws://127.0.0.1:51234/ext/anno',
  startedAt: STARTED_AT,
}

/** A candidate host for the ranking tests; every field is overridable. */
function host(overrides) {
  return {
    origin: 'http://127.0.0.1:30810',
    instanceId: '1111111111111111',
    profile: null,
    startedAt: null,
    focusAt: null,
    port: 30810,
    ...overrides,
  }
}

test('the locator URLs are the three documented ports, in order', async () => {
  const discovery = await loadDiscovery()
  assert.deepEqual(plain(discovery.locateUrls()), [
    'http://127.0.0.1:30810/ext/anno/locate',
    'http://127.0.0.1:30811/ext/anno/locate',
    'http://127.0.0.1:30812/ext/anno/locate',
  ])
  // The two TTLs are part of the contract the preference reader relies on.
  assert.equal(discovery.LAST_GOOD_TTL_MS, 12 * 60 * 60 * 1_000)
  assert.equal(discovery.FOCUS_TTL_MS, 6 * 60 * 60 * 1_000)
})

test('a documented locator answer becomes exactly one host', async () => {
  const discovery = await loadDiscovery()
  assert.deepEqual(plain(discovery.parseLocate(LOCATE_BODY)), EXPECTED_HOST)
  // The origin is normalized, including a trailing slash the host never writes.
  assert.deepEqual(plain(discovery.parseLocate({ ...LOCATE_BODY, origin: 'http://127.0.0.1:51234/' })), EXPECTED_HOST)
})

test('anything that is not a DSH locator answer is rejected', async () => {
  const discovery = await loadDiscovery()
  const rejected = {
    'a foreign app': { ...LOCATE_BODY, app: 'dsh-other' },
    'a newer protocol': { ...LOCATE_BODY, version: 2 },
    'a string version': { ...LOCATE_BODY, version: '1' },
    'a missing instanceId': { ...LOCATE_BODY, instanceId: undefined },
    'a short instanceId': { ...LOCATE_BODY, instanceId: '9f1c0b7a' },
    'an uppercase instanceId': { ...LOCATE_BODY, instanceId: INSTANCE.toUpperCase() },
    'a LAN origin': { ...LOCATE_BODY, origin: 'http://192.168.1.5:1' },
    'a public origin': { ...LOCATE_BODY, origin: 'https://example.com' },
    'an origin with a path': { ...LOCATE_BODY, origin: 'http://127.0.0.1:51234/ext/anno' },
    'an origin with a query': { ...LOCATE_BODY, origin: 'http://127.0.0.1:51234/?x=1' },
    'an IPv6 origin': { ...LOCATE_BODY, origin: 'http://[::1]:51234' },
    'a missing origin': { ...LOCATE_BODY, origin: undefined },
    'an origin without a port': { ...LOCATE_BODY, origin: 'http://127.0.0.1' },
    'a wsUrl on another port': { ...LOCATE_BODY, wsUrl: 'ws://127.0.0.1:51235/ext/anno' },
    'a wsUrl on another host': { ...LOCATE_BODY, wsUrl: 'ws://example.com:51234/ext/anno' },
    'a wsUrl without a port': { ...LOCATE_BODY, wsUrl: 'ws://127.0.0.1/ext/anno' },
  }
  for (const [label, body] of Object.entries(rejected)) {
    assert.equal(discovery.parseLocate(body), null, label)
  }
  for (const body of [null, undefined, 'ok', 42, [], ['http://127.0.0.1:51234']]) {
    assert.equal(discovery.parseLocate(body), null, `accepted ${JSON.stringify(body)}`)
  }
})

test('a malformed timestamp weakens a host instead of discarding it', async () => {
  const discovery = await loadDiscovery()
  const parsed = discovery.parseLocate({
    ...LOCATE_BODY,
    startedAt: 'yesterday',
    focusAt: 1_700_000_000_000,
    profile: 42,
  })
  assert.notEqual(parsed, null)
  assert.equal(parsed.startedAt, null)
  assert.equal(parsed.focusAt, null)
  assert.equal(parsed.profile, null)
  // Missing optional fields are normal, not malformed.
  assert.deepEqual(
    plain(
      discovery.parseLocate({
        app: 'dsh-marker',
        version: 1,
        instanceId: INSTANCE,
        origin: 'http://127.0.0.1:3080/',
      }),
    ),
    {
      origin: 'http://127.0.0.1:3080',
      instanceId: INSTANCE,
      profile: null,
      startedAt: null,
      focusAt: null,
      port: 3080,
    },
  )
})

test('the endpoint record is reduced to its five known fields', async () => {
  const discovery = await loadDiscovery()
  const token = 'a'.repeat(64)
  const parsed = discovery.parseEndpointRecord({ ...ENDPOINT_RECORD, token, extra: { nested: true } })
  assert.deepEqual(plain(parsed), {
    origin: 'http://127.0.0.1:51234',
    instanceId: INSTANCE,
    profile: 'desktop',
    startedAt: STARTED_AT,
    pid: 23144,
  })
  // The stray secret must not survive the trip, even as a key.
  assert.equal('token' in parsed, false)
  assert.equal('extra' in parsed, false)
  assert.deepEqual([...Object.keys(parsed)].sort(), ['instanceId', 'origin', 'pid', 'profile', 'startedAt'])
  // A malformed pid or profile degrades like a malformed timestamp.
  const degraded = discovery.parseEndpointRecord({ ...ENDPOINT_RECORD, pid: '23144', profile: 42 })
  assert.equal(degraded.pid, null)
  assert.equal(degraded.profile, null)
})

test('a record that is not this app, version, or loopback is rejected', async () => {
  const discovery = await loadDiscovery()
  const rejected = {
    'a foreign app': { ...ENDPOINT_RECORD, app: 'dsh-other' },
    'a newer protocol': { ...ENDPOINT_RECORD, version: 2 },
    'an uppercase instanceId': { ...ENDPOINT_RECORD, instanceId: INSTANCE.toUpperCase() },
    'a LAN origin': { ...ENDPOINT_RECORD, origin: 'http://192.168.1.5:51234' },
    'a public origin': { ...ENDPOINT_RECORD, origin: 'https://example.com' },
    'an origin with a path': { ...ENDPOINT_RECORD, origin: 'http://127.0.0.1:51234/ext/anno' },
  }
  for (const [label, body] of Object.entries(rejected)) {
    assert.equal(discovery.parseEndpointRecord(body), null, label)
  }
  for (const body of [null, undefined, 'ok', 42, []]) {
    assert.equal(discovery.parseEndpointRecord(body), null, `accepted ${JSON.stringify(body)}`)
  }
})

test('health supplies the instanceId, and null when it has none', async () => {
  const discovery = await loadDiscovery()
  assert.equal(discovery.healthInstanceId({ ok: true, instanceId: INSTANCE }), INSTANCE)
  assert.equal(discovery.healthInstanceId({ ok: true }), null)
  assert.equal(discovery.healthInstanceId({ instanceId: 'nope' }), null)
  assert.equal(discovery.healthInstanceId({ instanceId: 42 }), null)
  assert.equal(discovery.healthInstanceId(null), null)
  assert.equal(discovery.healthInstanceId(INSTANCE), null)
})

test('auto mode only owns an untouched default address', async () => {
  const discovery = await loadDiscovery()
  const address = { host: '127.0.0.1', port: 3080, secure: null }
  assert.equal(discovery.isDefaultAddress(address), true)
  assert.deepEqual(plain(discovery.planResolution({ mode: 'auto', address })), { auto: true })
  assert.deepEqual(plain(discovery.planResolution({ mode: 'manual', address })), { auto: false })
  // A typed scheme, a typed other host, or a typed other port is an override.
  assert.equal(discovery.planResolution({ mode: 'auto', address: { ...address, secure: true } }).auto, false)
  assert.equal(discovery.planResolution({ mode: 'auto', address: { ...address, secure: false } }).auto, false)
  assert.equal(discovery.planResolution({ mode: 'auto', address: { ...address, host: '10.0.0.7' } }).auto, false)
  assert.equal(discovery.planResolution({ mode: 'auto', address: { ...address, host: 'localhost' } }).auto, false)
  assert.equal(discovery.planResolution({ mode: 'auto', address: { ...address, port: 8123 } }).auto, false)
  // An install that predates the preference keeps the old behaviour.
  assert.equal(discovery.planResolution({ address }).auto, false)
  assert.equal(discovery.planResolution().auto, false)
  assert.equal(discovery.isDefaultAddress(null), false)
})

test('a remembered address survives a round trip until its TTL', async () => {
  const discovery = await loadDiscovery()
  const parsed = discovery.parseLocate(LOCATE_BODY)
  const stored = discovery.makeLastGood(parsed, NOW)
  assert.deepEqual(plain(stored), {
    origin: EXPECTED_HOST.origin,
    instanceId: INSTANCE,
    profile: 'desktop',
    startedAt: STARTED_AT,
    focusAt: FOCUS_AT,
    at: NOW,
  })
  // The port is derived from the origin on read, not stored twice.
  assert.equal('port' in stored, false)
  assert.deepEqual(plain(discovery.readLastGood(stored, NOW + 60_000)), { ...EXPECTED_HOST, at: NOW })
  // The boundary is inclusive; one millisecond later the address is stale.
  assert.notEqual(discovery.readLastGood(stored, NOW + discovery.LAST_GOOD_TTL_MS), null)
  assert.equal(discovery.readLastGood(stored, NOW + discovery.LAST_GOOD_TTL_MS + 1), null)
})

test('a stored address with an unusable origin or instanceId is dropped', async () => {
  const discovery = await loadDiscovery()
  const stored = {
    origin: 'http://127.0.0.1:51234',
    instanceId: INSTANCE,
    profile: 'desktop',
    startedAt: STARTED_AT,
    focusAt: null,
    at: NOW,
  }
  assert.equal(discovery.readLastGood(null, NOW), null)
  assert.equal(discovery.readLastGood('http://127.0.0.1:51234', NOW), null)
  assert.equal(discovery.readLastGood([], NOW), null)
  assert.equal(discovery.readLastGood({ ...stored, origin: 'http://192.168.1.5:51234' }, NOW), null)
  assert.equal(discovery.readLastGood({ ...stored, origin: 'https://example.com' }, NOW), null)
  assert.equal(discovery.readLastGood({ ...stored, at: 'now' }, NOW), null)
  assert.equal(discovery.readLastGood({ ...stored, at: Number.NaN }, NOW), null)
  assert.equal(discovery.readLastGood({ ...stored, instanceId: 'NOT-AN-ID' }, NOW), null)
  // A host with no id is legitimate: the default-port candidate has none.
  const noId = discovery.readLastGood({ ...stored, instanceId: null }, NOW)
  assert.equal(noId.instanceId, null)
  assert.equal(noId.origin, stored.origin)
})

test('ranking follows preference, recency, and port order', async () => {
  const discovery = await loadDiscovery()
  const ids = {
    preferred: 'aaaaaaaaaaaaaaaa',
    last: 'bbbbbbbbbbbbbbbb',
    focused: 'cccccccccccccccc',
    newest: 'dddddddddddddddd',
    oldest: 'eeeeeeeeeeeeeeee',
  }
  const candidates = [
    host({ instanceId: ids.oldest, startedAt: '2026-11-19T12:00:00.000Z' }),
    host({
      instanceId: ids.newest,
      origin: 'http://127.0.0.1:30811',
      port: 30811,
      startedAt: '2026-11-19T13:30:00.000Z',
    }),
    host({
      instanceId: ids.focused,
      origin: 'http://127.0.0.1:30812',
      port: 30812,
      focusAt: '2026-11-19T14:05:00.000Z',
    }),
    host({
      instanceId: ids.last,
      origin: 'http://127.0.0.1:51234',
      port: 51234,
      startedAt: '2026-11-19T11:00:00.000Z',
    }),
    host({
      instanceId: ids.preferred,
      origin: 'http://127.0.0.1:50000',
      port: 50000,
      startedAt: '2026-11-19T10:00:00.000Z',
    }),
  ]
  const ranked = discovery.rankCandidates(candidates, {
    preferredInstanceId: ids.preferred,
    lastInstanceId: ids.last,
    now: NOW,
  })
  assert.deepEqual(plain(ranked.map((entry) => entry.instanceId)), [
    ids.preferred,
    ids.last,
    ids.focused,
    ids.newest,
    ids.oldest,
  ])

  // Nothing else differs, so the lower locator port wins.
  const byPort = discovery.rankCandidates(
    [
      host({ instanceId: '1111111111111112', origin: 'http://127.0.0.1:30812', port: 30812 }),
      host({ instanceId: '1111111111111113' }),
    ],
    { now: NOW },
  )
  assert.deepEqual(plain(byPort.map((entry) => entry.instanceId)), ['1111111111111113', '1111111111111112'])
})

test('a focus older than six hours no longer counts for ranking', async () => {
  const discovery = await loadDiscovery()
  const stale = host({ instanceId: 'aaaaaaaaaaaaaaa1', focusAt: '2026-11-19T07:00:00.000Z' })
  const freshStart = host({
    instanceId: 'aaaaaaaaaaaaaaa2',
    origin: 'http://127.0.0.1:30811',
    port: 30811,
    startedAt: '2026-11-19T14:00:00.000Z',
  })
  assert.deepEqual(
    plain(discovery.rankCandidates([stale, freshStart], { now: NOW }).map((entry) => entry.instanceId)),
    [freshStart.instanceId, stale.instanceId],
  )
  // Exactly at the TTL the report still counts, so it beats a newer start.
  const boundary = host({
    instanceId: 'aaaaaaaaaaaaaaa3',
    origin: 'http://127.0.0.1:30812',
    port: 30812,
    focusAt: new Date(NOW - discovery.FOCUS_TTL_MS).toISOString(),
  })
  const newerStart = host({
    instanceId: 'aaaaaaaaaaaaaaa4',
    origin: 'http://127.0.0.1:30813',
    port: 30813,
    startedAt: '2026-11-19T14:09:00.000Z',
  })
  assert.deepEqual(
    plain(discovery.rankCandidates([newerStart, boundary], { now: NOW }).map((entry) => entry.instanceId)),
    [boundary.instanceId, newerStart.instanceId],
  )
})

test('the no-id default candidate never wins a preference or a tie', async () => {
  const discovery = await loadDiscovery()
  // A null preference must not act as a wildcard for the candidate that has
  // no id: the identified host is still the one that wins on port order.
  const identified = host({ instanceId: 'ffffffffffffffff', origin: 'http://127.0.0.1:3080', port: 3080 })
  const fallback = host({ instanceId: null, origin: 'http://127.0.0.1:30812', port: 30812 })
  assert.deepEqual(
    plain(
      discovery
        .rankCandidates([fallback, identified], { preferredInstanceId: null, lastInstanceId: null, now: NOW })
        .map((entry) => entry.instanceId),
    ),
    ['ffffffffffffffff', null],
  )
  // Equal on focus, start, and port: the identified host goes first.
  const tied = discovery.rankCandidates(
    [
      host({ instanceId: null, origin: 'http://127.0.0.1:3080', port: 3080 }),
      host({ instanceId: 'fffffffffffffffe', origin: 'http://127.0.0.1:3080', port: 3080 }),
    ],
    { now: NOW },
  )
  assert.deepEqual(plain(tied.map((entry) => entry.instanceId)), ['fffffffffffffffe', null])
  // In the real round the default candidate is ranked, not assumed: a locator
  // host that started later wins even though 3080 has the lower port.
  const locator = host({
    instanceId: 'dddddddddddddddd',
    origin: 'http://127.0.0.1:30811',
    port: 30811,
    startedAt: STARTED_AT,
  })
  const defaults = host({ instanceId: null, origin: 'http://127.0.0.1:3080', port: 3080 })
  assert.deepEqual(plain(discovery.rankCandidates([defaults, locator], { now: NOW }).map((entry) => entry.origin)), [
    'http://127.0.0.1:30811',
    'http://127.0.0.1:3080',
  ])
})

test('equal candidates keep a deterministic order and the input is untouched', async () => {
  const discovery = await loadDiscovery()
  const input = [
    host({ instanceId: '1111111111111111', origin: 'https://127.0.0.1:30811', port: 30811 }),
    host({ instanceId: '2222222222222222', origin: 'http://127.0.0.1:30811', port: 30811 }),
  ]
  const before = plain(input)
  const first = discovery.rankCandidates(input, { now: NOW })
  // Nothing but the origin differs, so that is the last word.
  assert.deepEqual(plain(first.map((entry) => entry.instanceId)), ['2222222222222222', '1111111111111111'])
  const second = discovery.rankCandidates(input, { now: NOW })
  assert.deepEqual(plain(second.map((entry) => entry.instanceId)), plain(first.map((entry) => entry.instanceId)))
  assert.deepEqual(plain(input), before, 'rankCandidates must not sort the caller array')
})

test('one round probes every locator port at once', async () => {
  const discovery = await loadDiscovery()
  let inFlight = 0
  let peak = 0
  const request = () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    return new Promise((resolve) => {
      setTimeout(() => {
        inFlight -= 1
        resolve(LOCATE_BODY)
      }, 20)
    })
  }
  const round = await discovery.collectHosts({ request })
  assert.equal(round.hosts.length, 3)
  assert.equal(round.failures.length, 0)
  assert.equal(peak, 3, 'all three locator requests must be in flight together')
})

test('one answered port and two refusals are one host and two failures', async () => {
  const discovery = await loadDiscovery()
  const requested = []
  const request = async (url) => {
    requested.push(url)
    if (url.includes(':30810/')) return LOCATE_BODY
    const error = new Error('connect ECONNREFUSED 127.0.0.1')
    error.statusCode = 503
    throw error
  }
  const round = await discovery.collectHosts({ request })
  assert.deepEqual(requested, plain(discovery.locateUrls()), 'the default round is the three locator ports, in order')
  assert.equal(round.hosts.length, 1)
  assert.deepEqual(plain(round.hosts[0]), EXPECTED_HOST)
  assert.equal(round.failures.length, 2)
  assert.deepEqual(plain(round.failures.map((entry) => entry.port)), [30811, 30812])
  for (const failure of round.failures) {
    assert.equal(typeof failure.error, 'string')
    assert.match(failure.error, /ECONNREFUSED/)
    // The HTTP status the rejection carried is part of the sentence.
    assert.match(failure.error, /HTTP 503/)
  }
})

test('a body from something else is a failure, not a host', async () => {
  const discovery = await loadDiscovery()
  const round = await discovery.collectHosts({
    request: async () => ({ ...LOCATE_BODY, app: 'dsh-other' }),
    ports: [30811],
  })
  assert.equal(round.hosts.length, 0)
  assert.equal(round.failures.length, 1)
  assert.equal(round.failures[0].port, 30811)
  assert.match(round.failures[0].error, /not a DSH locator/)
  // A request implementation that throws synchronously must also be contained.
  const sync = await discovery.collectHosts({
    request: () => {
      throw new Error('boom')
    },
    ports: [30812],
  })
  assert.equal(sync.failures.length, 1)
  assert.match(sync.failures[0].error, /boom/)
})

test('a failed probe is logged at debug, and a healthy round is not', async () => {
  const discovery = await loadDiscovery()
  const logged = []
  const warned = []
  const logger = { debug: (message) => logged.push(message), warn: () => warned.push(true) }
  await discovery.collectHosts({ request: async () => LOCATE_BODY, ports: [30810], logger })
  assert.equal(logged.length, 0, 'a healthy round is not worth a log line')
  await discovery.collectHosts({
    request: async () => {
      throw new Error('refused')
    },
    ports: [30811],
    logger,
  })
  assert.equal(logged.length, 1)
  assert.match(logged[0], /30811/)
  assert.match(logged[0], /refused/)
  assert.equal(warned.length, 0, 'a locator probe is never worth a warning')
})

test('a request that never settles is cut by the timeout budget', async () => {
  const discovery = await loadDiscovery()
  const round = await Promise.race([
    discovery.collectHosts({ request: () => new Promise(() => {}), ports: [30810], timeoutMs: 20 }),
    after(1_000).then(() => assert.fail('collectHosts did not resolve')),
  ])
  assert.equal(round.hosts.length, 0)
  assert.equal(round.failures.length, 1)
  assert.equal(round.failures[0].port, 30810)
  assert.match(round.failures[0].error, /20 ms/)
})

test('the ports override replaces the default list', async () => {
  const discovery = await loadDiscovery()
  const requested = []
  const round = await discovery.collectHosts({
    request: async (url) => {
      requested.push(url)
      throw new Error('nothing there')
    },
    ports: [30999],
  })
  assert.deepEqual(requested, ['http://127.0.0.1:30999/ext/anno/locate'])
  assert.deepEqual(plain(round.failures.map((entry) => entry.port)), [30999])
  assert.equal(round.hosts.length, 0)
})

test('the module refuses to publish anything without the protocol global', async () => {
  const errors = []
  const sandbox = {
    console: { debug() {}, info() {}, warn() {}, error: (message) => errors.push(message) },
    URL,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  const path = 'src/background/discovery.js'
  vm.runInContext(await readFile(join(extensionRoot, path), 'utf8'), context, { filename: path })
  assert.equal(sandbox.__DSH_ANNO_BG__?.discovery, undefined)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /protocol\.global\.js must load before src\/background\/discovery\.js/)
})
