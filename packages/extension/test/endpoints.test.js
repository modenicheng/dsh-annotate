/**
 * Endpoint selection for the extension, without a browser.
 *
 * `src/background/endpoints.js` is a classic script (the event page and the
 * popup have no module loader), so it is evaluated in a `node:vm` context that
 * contains the generated protocol global and nothing else. Everything the tests
 * call is pure: typed address in, URL out, or a close code in, sentence out.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)
const SCRIPTS = ['src/shared/protocol.global.js', 'src/background/endpoints.js']

/** Evaluate the extension's endpoint module and return its published API. */
async function loadEndpoints() {
  const sandbox = {
    console: { debug() {}, info() {}, warn() {}, error() {} },
    URL,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  for (const path of SCRIPTS) {
    const code = await readFile(join(extensionRoot, path), 'utf8')
    vm.runInContext(code, context, { filename: path })
  }
  const endpoints = sandbox.__DSH_ANNO_BG__?.endpoints
  assert.ok(endpoints !== undefined, 'endpoints.js published ns.endpoints')
  return endpoints
}

/**
 * A structural copy, so assertions compare data across the `vm` realm boundary
 * instead of each object's prototype identity.
 * @param {any} value
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

/** @param {any} endpoints @param {string} host @param {string|number} [port] @param {boolean|null} [secure] */
function addressOf(endpoints, host, port, secure) {
  const parsed = endpoints.parseAddress(host, port, secure)
  assert.equal(parsed.ok, true, `parseAddress(${JSON.stringify(host)}) failed: ${parsed.reason}`)
  return parsed
}

test('the legacy host+port shape still parses, with no scheme opinion', async () => {
  const endpoints = await loadEndpoints()
  assert.deepEqual(plain(addressOf(endpoints, '127.0.0.1', 3080)), {
    ok: true,
    host: '127.0.0.1',
    port: 3080,
    secure: null,
    explicitScheme: false,
  })
  // A port typed into the host field wins over the port field, as before.
  assert.equal(addressOf(endpoints, '127.0.0.1:3098', 3080).port, 3098)
  assert.equal(addressOf(endpoints, 'localhost:3080/', 1).port, 3080)
  assert.equal(addressOf(endpoints, 'LOCALHOST', '3080').host, 'localhost')
})

test('a full URL carries an explicit scheme and its own port', async () => {
  const endpoints = await loadEndpoints()
  const secure = addressOf(endpoints, 'https://anno.example.com/ext/anno?x=1', 3080)
  assert.equal(secure.host, 'anno.example.com')
  assert.equal(secure.port, 443, 'a URL without a port uses the scheme default, not the port field')
  assert.equal(secure.secure, true)
  assert.equal(secure.explicitScheme, true)

  const explicitPort = addressOf(endpoints, 'wss://anno.example.com:8443/ext/anno', 3080)
  assert.equal(explicitPort.port, 8443)
  assert.equal(explicitPort.secure, true)

  const plain = addressOf(endpoints, 'http://127.0.0.1:3098/', 1)
  assert.equal(plain.port, 3098)
  assert.equal(plain.secure, false)

  const legacyScheme = addressOf(endpoints, 'ws://127.0.0.1:3099', 1)
  assert.equal(legacyScheme.secure, false)
  assert.equal(legacyScheme.port, 3099)
})

test('an IPv6 literal is kept bracketed', async () => {
  const endpoints = await loadEndpoints()
  const parsed = addressOf(endpoints, 'ws://[::1]:3099', 1)
  assert.equal(parsed.host, '[::1]')
  assert.equal(parsed.port, 3099)
  assert.equal(endpoints.fallbackWsUrl(parsed), 'ws://[::1]:3099/ext/anno')
})

test('a stored scheme override survives, and a typed scheme overrides it', async () => {
  const endpoints = await loadEndpoints()
  const stored = addressOf(endpoints, '127.0.0.1', 3080, true)
  assert.equal(stored.secure, true, 'the popup saved wss for this host')
  const typed = addressOf(endpoints, 'http://127.0.0.1', 3080, true)
  assert.equal(typed.secure, false, 'the scheme typed into the field is more specific')
})

test('unusable input is rejected with a sentence the popup can show', async () => {
  const endpoints = await loadEndpoints()
  for (const host of ['', '   ', 'not a host', 'example.com:abc', 'http://', '[::1', 'http://exa mple.com']) {
    const parsed = endpoints.parseAddress(host, 3080)
    assert.equal(parsed.ok, false, `accepted ${JSON.stringify(host)}`)
    assert.equal(typeof parsed.reason, 'string')
    assert.ok(parsed.reason.length > 0)
  }
  assert.equal(endpoints.parseAddress('127.0.0.1:0').ok, false)
  assert.equal(endpoints.parseAddress('127.0.0.1:70000').ok, false)
  // An unusable port *field* is treated as absent, matching the old normalizer.
  assert.equal(addressOf(endpoints, '127.0.0.1', 'nonsense').port, 3080)
})

test('health candidates follow the scheme: both when unknown, one when explicit', async () => {
  const endpoints = await loadEndpoints()
  const auto = endpoints.healthCandidates(addressOf(endpoints, '127.0.0.1', 3080))
  assert.deepEqual(
    [...auto.map((candidate) => candidate.url)],
    ['http://127.0.0.1:3080/ext/anno/health', 'https://127.0.0.1:3080/ext/anno/health'],
  )
  const secure = endpoints.healthCandidates(addressOf(endpoints, 'https://anno.example.com'))
  assert.deepEqual([...secure.map((candidate) => candidate.url)], ['https://anno.example.com:443/ext/anno/health'])
  const plain = endpoints.healthCandidates(addressOf(endpoints, 'http://127.0.0.1:3098'))
  assert.deepEqual([...plain.map((candidate) => candidate.url)], ['http://127.0.0.1:3098/ext/anno/health'])
})

test('a health body is accepted only when it describes an endpoint', async () => {
  const endpoints = await loadEndpoints()
  assert.deepEqual(plain(endpoints.parseHealth({ ok: true, secure: false, wsUrl: 'ws://host:1/ext/anno' })), {
    secure: false,
    wsUrl: 'ws://host:1/ext/anno',
  })
  assert.deepEqual(plain(endpoints.parseHealth({ secure: true })), { secure: true, wsUrl: '' })
  assert.deepEqual(plain(endpoints.parseHealth({ wsUrl: 'wss://host/ext/anno' })), {
    secure: true,
    wsUrl: 'wss://host/ext/anno',
  })
  for (const body of [null, undefined, 'ok', 42, [], {}, { secure: 'yes' }, { wsUrl: 'https://host/' }]) {
    assert.equal(endpoints.parseHealth(body), null, `accepted ${JSON.stringify(body)}`)
  }
})

test('the advertised wsUrl is used when it names the configured host', async () => {
  const endpoints = await loadEndpoints()
  const address = addressOf(endpoints, '127.0.0.1', 3098)
  const sameHost = endpoints.selectWsUrl({
    address,
    health: { secure: true, wsUrl: 'wss://127.0.0.1:3098/ext/anno' },
  })
  assert.deepEqual(plain(sameHost), { wsUrl: 'wss://127.0.0.1:3098/ext/anno', secure: true, source: 'health' })

  // Behind a proxy the advertised host is the public one, and that is what the
  // user configured in the popup.
  const proxied = endpoints.selectWsUrl({
    address: addressOf(endpoints, 'https://anno.example.com'),
    health: { secure: true, wsUrl: 'wss://anno.example.com/ext/anno' },
  })
  assert.equal(proxied.wsUrl, 'wss://anno.example.com/ext/anno')
  assert.equal(proxied.source, 'health')
})

test('a foreign authority in the health body keeps the configured address', async () => {
  const endpoints = await loadEndpoints()
  const address = addressOf(endpoints, '127.0.0.1', 3098)
  const selection = endpoints.selectWsUrl({
    address,
    health: { secure: true, wsUrl: 'wss://anno.example.com/ext/anno' },
  })
  assert.equal(selection.wsUrl, 'wss://127.0.0.1:3098/ext/anno')
  assert.equal(selection.secure, true)
  assert.equal(selection.source, 'health')
})

test('a failed probe falls back to the configured address and scheme', async () => {
  const endpoints = await loadEndpoints()
  const auto = endpoints.selectWsUrl({ address: addressOf(endpoints, '127.0.0.1', 3098), health: null })
  assert.deepEqual(plain(auto), { wsUrl: 'ws://127.0.0.1:3098/ext/anno', secure: false, source: 'configured' })
  const secure = endpoints.selectWsUrl({ address: addressOf(endpoints, 'https://anno.example.com'), health: null })
  assert.equal(secure.wsUrl, 'wss://anno.example.com:443/ext/anno')
  assert.equal(secure.secure, true)
})

test('the default local host resolves to ws:// from an http probe answer', async () => {
  const endpoints = await loadEndpoints()
  // What a stock `dsh web` on 127.0.0.1:3080 answers over http. The extension
  // must keep using ws://: no upgrade-insecure-requests, no wss guess.
  const address = addressOf(endpoints, '127.0.0.1', 3080)
  const selection = endpoints.selectWsUrl({
    address,
    health: { secure: false, wsUrl: 'ws://127.0.0.1:3080/ext/anno' },
  })
  assert.deepEqual(plain(selection), { wsUrl: 'ws://127.0.0.1:3080/ext/anno', secure: false, source: 'health' })
})

test('an older host without the scheme fields still gets a usable ws:// URL', async () => {
  const endpoints = await loadEndpoints()
  // Health from before the negotiation existed: `ok`, `version`, `wsPath`,
  // counts. It is not a usable answer, so the probe counts as failed and the
  // configured address is used.
  const legacy = endpoints.parseHealth({ ok: true, version: 1, wsPath: '/ext/anno', openCount: 0, clients: 0 })
  assert.equal(legacy, null)
  const selection = endpoints.selectWsUrl({ address: addressOf(endpoints, '127.0.0.1', 3080), health: legacy })
  assert.equal(selection.wsUrl, 'ws://127.0.0.1:3080/ext/anno')
  assert.equal(selection.source, 'configured')
})

test('a health body without a wsUrl still supplies the scheme', async () => {
  const endpoints = await loadEndpoints()
  const selection = endpoints.selectWsUrl({
    address: addressOf(endpoints, '127.0.0.1', 3098),
    health: { secure: true, wsUrl: '' },
  })
  assert.equal(selection.wsUrl, 'wss://127.0.0.1:3098/ext/anno')
  assert.equal(selection.secure, true)
})

test('close codes are explained by failure mode, not by generic code', async () => {
  const endpoints = await loadEndpoints()
  const plain = endpoints.describeClose({
    code: 1006,
    url: 'ws://127.0.0.1:3098/ext/anno',
    source: 'configured',
    healthUrl: 'http://127.0.0.1:3098/ext/anno/health',
  })
  assert.match(plain, /plaintext ws:\/\//)
  assert.match(plain, /upgrade-insecure-requests/)
  assert.match(plain, /health probe at http:\/\/127\.0\.0\.1:3098\/ext\/anno\/health/)
  assert.match(plain, /saved in the popup/)

  const advertised = endpoints.describeClose({
    code: 1006,
    url: 'ws://127.0.0.1:3098/ext/anno',
    source: 'health',
    healthUrl: 'http://127.0.0.1:3098/ext/anno/health',
  })
  assert.match(advertised, /switch the popup address to wss:\/\//)

  const tls = endpoints.describeClose({ code: 1006, url: 'wss://anno.example.com/ext/anno' })
  assert.match(tls, /secure websocket/)
  assert.match(tls, /plain "dsh web"/)

  const missing = endpoints.describeClose({
    code: 1015,
    url: 'wss://anno.example.com/ext/anno',
    source: 'health',
    healthUrl: 'https://anno.example.com/ext/anno/health',
  })
  assert.match(missing, /no bridge endpoint/)
  assert.match(missing, /not a scheme mismatch/)

  assert.match(endpoints.describeClose({ code: 1000 }), /host closed/)
  assert.match(endpoints.describeClose({ code: 4403, reason: 'bad token' }), /token was rejected.*bad token/)
})
