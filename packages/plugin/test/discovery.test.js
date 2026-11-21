/**
 * The endpoint record and the trigger that decides whether a host needs a
 * locator at all.
 *
 * The record is the manual and diagnostic half of discovery: it exists so a
 * human, a script, or the popup's file import can find a host whose port moved.
 * The two properties worth testing are that it is written whole or not at all,
 * and that it never carries the bridge token. The trigger matrix is the one
 * place "3080 means a stock `dsh web`" is encoded, so it is pinned case by case.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename as fsRename, rm, stat, writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_WEB_PORT,
  createDiscovery,
  isIpv4Loopback,
  shouldLocate,
  writeJsonAtomically,
} from '../src/discovery.js'
import { DISCOVERY_APP, ENDPOINT_FILE, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION, WS_PATH } from '../src/protocol.js'

const ORIGIN = 'http://127.0.0.1:51234'
const WS_URL = `ws://127.0.0.1:51234${WS_PATH}`
const FIXED_NOW = new Date('2026-11-19T13:59:00.000Z')
const INSTANCE_ID = '9f1c0b7a5e2d4c31'

/**
 * A temporary `$DSH_HOME`, removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {Promise<string>}
 */
async function makeHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-anno-discovery-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

/**
 * A discovery instance wired to the documented fake webserver and a fixed clock.
 * @param {string} home
 * @param {Record<string, any>} [overrides]
 */
function discoveryIn(home, overrides = {}) {
  return createDiscovery({
    webServer: { getOrigin: () => ORIGIN },
    home,
    profile: 'desktop',
    instanceId: INSTANCE_ID,
    pid: 23144,
    now: () => FIXED_NOW,
    ...overrides,
  })
}

/** The Windows rename failure the in-place fallback exists for. */
function eperm() {
  return Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
}

test('the record is written whole, in the documented order, and holds no secret', async (t) => {
  const home = await makeHome(t)
  const discovery = discoveryIn(home)

  assert.equal(discovery.instanceId, INSTANCE_ID)
  assert.equal(discovery.startedAt, FIXED_NOW.toISOString())
  assert.equal(discovery.profile, 'desktop')
  assert.equal(discovery.pid, 23144)
  assert.equal(discovery.path, join(home, ENDPOINT_FILE))

  assert.equal(await discovery.write(), true)

  const text = await readFile(join(home, ENDPOINT_FILE), 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(text)), [
    'version',
    'minProtocol',
    'app',
    'instanceId',
    'pid',
    'profile',
    'origin',
    'wsUrl',
    'startedAt',
  ])
  assert.deepEqual(JSON.parse(text), {
    version: PROTOCOL_VERSION,
    minProtocol: MIN_PROTOCOL_VERSION,
    app: DISCOVERY_APP,
    instanceId: INSTANCE_ID,
    pid: 23144,
    profile: 'desktop',
    origin: ORIGIN,
    wsUrl: WS_URL,
    startedAt: FIXED_NOW.toISOString(),
  })
  // The token is 64 hex characters with exactly one home. A JSON file holding a
  // second copy would be a liability, so the whole file is checked for the shape.
  assert.equal(/\b[0-9a-f]{64}\b/.test(text), false)
  assert.equal(text.endsWith('\n'), true)
})

test('the record is 0600 on POSIX, and always a parseable file', async (t) => {
  const home = await makeHome(t)
  const discovery = discoveryIn(home)
  assert.equal(await discovery.write(), true)

  const path = join(home, ENDPOINT_FILE)
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  }
  // Windows ignores POSIX modes and inherits the profile's ACL; parsing is the
  // half that must hold everywhere.
  assert.equal(JSON.parse(await readFile(path, 'utf8')).app, DISCOVERY_APP)
})

test('a TLS host publishes wss, because the extension upgrades with what it is told', async (t) => {
  const home = await makeHome(t)
  const discovery = discoveryIn(home, { webServer: { getOrigin: () => 'https://127.0.0.1:8443' } })

  assert.equal(discovery.origin, 'https://127.0.0.1:8443')
  assert.equal(discovery.wsUrl, `wss://127.0.0.1:8443${WS_PATH}`)
  assert.equal(discovery.record().wsUrl, `wss://127.0.0.1:8443${WS_PATH}`)
})

test('a fresh instance id is 16 hex characters, and a host without a profile says so', async (t) => {
  const home = await makeHome(t)
  const first = createDiscovery({ webServer: { getOrigin: () => ORIGIN }, home, now: () => FIXED_NOW })
  const second = createDiscovery({ webServer: { getOrigin: () => ORIGIN }, home, now: () => FIXED_NOW })

  assert.match(first.instanceId, /^[0-9a-f]{16}$/)
  assert.notEqual(first.instanceId, second.instanceId)
  assert.equal(first.profile, null)
  assert.equal(first.record().profile, null)
  assert.equal(first.pid, process.pid)
})

test('remove() deletes its own record and leaves a newer one alone', async (t) => {
  const home = await makeHome(t)
  const older = discoveryIn(home, { instanceId: 'aaaaaaaaaaaaaaaa' })
  const newer = discoveryIn(home, { instanceId: 'bbbbbbbbbbbbbbbb' })
  const path = join(home, ENDPOINT_FILE)

  assert.equal(await older.write(), true)
  // Two profiles share `$DSH_HOME`, so the last writer owns the file.
  assert.equal(await newer.write(), true)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).instanceId, 'bbbbbbbbbbbbbbbb')

  await older.remove()
  assert.equal(JSON.parse(await readFile(path, 'utf8')).instanceId, 'bbbbbbbbbbbbbbbb')

  await newer.remove()
  await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' })
  // Shutting down with no record to remove is not an error.
  await assert.doesNotReject(older.dispose())
})

test('a torn record is left alone by remove()', async (t) => {
  const home = await makeHome(t)
  const path = join(home, ENDPOINT_FILE)
  await fsWriteFile(path, '{"instanceId": "9f1c')

  await assert.doesNotReject(discoveryIn(home).remove())
  assert.equal(await readFile(path, 'utf8'), '{"instanceId": "9f1c')
})

test('a home that cannot be created is one warning, not a crash', async (t) => {
  const home = await makeHome(t)
  // A path below a regular file can never become a directory.
  const file = join(home, 'not-a-directory')
  await fsWriteFile(file, 'occupied')
  const warnings = []
  const discovery = discoveryIn(join(file, 'nested'), { logger: { warn: (message) => warnings.push(message) } })

  assert.equal(await discovery.write(), false)
  assert.equal(warnings.length, 1)
})

test('a rename that hits EPERM is retried once and the record lands', async (t) => {
  const home = await makeHome(t)
  const path = join(home, ENDPOINT_FILE)
  let attempts = 0

  const ok = await writeJsonAtomically(path, '{"a":1}\n', {
    rename: async (from, to) => {
      attempts += 1
      if (attempts === 1) throw eperm()
      await fsRename(from, to)
    },
  })

  assert.equal(ok, true)
  assert.equal(attempts, 2)
  assert.equal(await readFile(path, 'utf8'), '{"a":1}\n')
})

test('a rename failure that cannot clear is not retried', async (t) => {
  const home = await makeHome(t)
  const path = join(home, ENDPOINT_FILE)
  let attempts = 0

  const ok = await writeJsonAtomically(path, '{"a":1}\n', {
    rename: async () => {
      attempts += 1
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' })
    },
  })

  // The retry exists for a held handle on Windows, not for a broken filesystem.
  assert.equal(ok, false)
  assert.equal(attempts, 1)
  assert.equal(await readFile(path, 'utf8'), '{"a":1}\n')
})

test('when every rename fails, the record is written in place and reported', async (t) => {
  const home = await makeHome(t)
  const path = join(home, ENDPOINT_FILE)
  const temporary = `${path}.${process.pid}.tmp`
  const writes = []
  const warnings = []
  let attempts = 0

  const ok = await writeJsonAtomically(path, '{"a":1}\n', {
    logger: { warn: (message) => warnings.push(message) },
    rename: async () => {
      attempts += 1
      throw eperm()
    },
    writeFile: async (file, text, options) => {
      writes.push(file)
      await fsWriteFile(file, text, options)
    },
  })

  assert.equal(ok, false)
  assert.equal(attempts, 2)
  // Once for the temp file, once for the in-place fallback.
  assert.deepEqual(writes, [temporary, path])
  assert.equal(await readFile(path, 'utf8'), '{"a":1}\n')
  assert.equal(warnings.length, 1)
  await assert.rejects(stat(temporary), { code: 'ENOENT' })
})

test('card() reads focus on every call and record() never carries it', async (t) => {
  const home = await makeHome(t)
  /** @type {{ get: () => any }} */
  const store = { get: () => null }
  const discovery = discoveryIn(home, { focus: store })

  assert.deepEqual(discovery.card(), {
    app: DISCOVERY_APP,
    version: PROTOCOL_VERSION,
    minProtocol: MIN_PROTOCOL_VERSION,
    instanceId: INSTANCE_ID,
    origin: ORIGIN,
    wsUrl: WS_URL,
    startedAt: FIXED_NOW.toISOString(),
    focusAt: null,
    profile: 'desktop',
  })

  const at = Date.parse('2026-11-19T14:03:11.000Z')
  store.get = () => ({ sessionId: 'session-a', at })
  assert.equal(discovery.card().focusAt, '2026-11-19T14:03:11.000Z')

  // The locator serves this field per request, so a later call must see a later
  // report without rebuilding the instance.
  store.get = () => ({ sessionId: 'session-b', at: at + 60_000 })
  assert.equal(discovery.card().focusAt, '2026-11-19T14:04:11.000Z')

  store.get = () => ({ sessionId: 'session-c', at: Number.NaN })
  assert.equal(discovery.card().focusAt, null)
  store.get = () => ({ sessionId: 'session-d', at: 'later' })
  assert.equal(discovery.card().focusAt, null)
  store.get = () => undefined
  assert.equal(discovery.card().focusAt, null)
  store.get = () => {
    throw new Error('store exploded')
  }
  assert.equal(discovery.card().focusAt, null)

  // No focus store at all is the same answer, not a special case.
  assert.equal(discoveryIn(home).card().focusAt, null)

  const record = discovery.record()
  assert.equal('focusAt' in record, false)
  assert.equal('sessionId' in record, false)
})

test('an unbound webserver publishes nothing and does not throw', async (t) => {
  const home = await makeHome(t)
  const warnings = []
  const discovery = createDiscovery({
    webServer: {
      getOrigin: () => {
        throw new Error('not listening')
      },
    },
    home,
    logger: { warn: (message) => warnings.push(message) },
    instanceId: INSTANCE_ID,
    now: () => FIXED_NOW,
  })

  assert.equal(discovery.origin, null)
  assert.equal(discovery.wsUrl, null)
  assert.equal(discovery.card(), null)
  assert.equal(discovery.record(), null)
  assert.equal(await discovery.write(), false)
  assert.equal(warnings.length, 1)
  await assert.rejects(readFile(join(home, ENDPOINT_FILE), 'utf8'), { code: 'ENOENT' })
})

test('the locator starts for a moving port on loopback and for nothing else', () => {
  assert.equal(DEFAULT_WEB_PORT, 3080)
  assert.equal(shouldLocate({ port: 3080, host: '127.0.0.1' }), false)
  assert.equal(shouldLocate({ port: 3081, host: '127.0.0.1' }), true)
  assert.equal(shouldLocate({ port: 51234, host: '127.0.0.1' }), true)
  assert.equal(shouldLocate({ port: 51234, host: '127.9.9.9' }), true)
  assert.equal(shouldLocate({ port: 51234, host: '127.0.0.1', mode: 'auto' }), true)
  assert.equal(shouldLocate({ port: 51234, host: '127.0.0.1', mode: 'off' }), false)
  assert.equal(shouldLocate({ port: 51234, host: '0.0.0.0' }), false)
  assert.equal(shouldLocate({ port: 51234, host: '::1' }), false)
  assert.equal(shouldLocate({ port: 51234, host: 'localhost' }), false)
  assert.equal(shouldLocate({ port: 51234, host: '192.168.1.4' }), false)
  // `0` is what a launcher passed, not what the listener bound.
  assert.equal(shouldLocate({ port: 0, host: '127.0.0.1' }), false)
  assert.equal(shouldLocate({ port: undefined, host: '127.0.0.1' }), false)
  assert.equal(shouldLocate({ port: 3081.5, host: '127.0.0.1' }), false)
  assert.equal(shouldLocate({}), false)
  assert.equal(shouldLocate(), false)
})

test('only an IPv4 loopback literal counts as loopback', () => {
  assert.equal(isIpv4Loopback('127.0.0.1'), true)
  assert.equal(isIpv4Loopback('127.0.0.2'), true)
  assert.equal(isIpv4Loopback('127.255.255.255'), true)

  assert.equal(isIpv4Loopback('127.0.0.256'), false)
  assert.equal(isIpv4Loopback('127.0.0.01'), false)
  assert.equal(isIpv4Loopback('127.0.0'), false)
  assert.equal(isIpv4Loopback('128.0.0.1'), false)
  assert.equal(isIpv4Loopback('0.0.0.0'), false)
  assert.equal(isIpv4Loopback('192.168.1.4'), false)
  assert.equal(isIpv4Loopback('::1'), false)
  assert.equal(isIpv4Loopback('localhost'), false)
  assert.equal(isIpv4Loopback(''), false)
  assert.equal(isIpv4Loopback('127.0.0.1:3080'), false)
  assert.equal(isIpv4Loopback(' 127.0.0.1'), false)
  assert.equal(isIpv4Loopback(undefined), false)
  assert.equal(isIpv4Loopback(null), false)
})
