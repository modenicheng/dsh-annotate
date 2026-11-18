/**
 * End-to-end coverage for the `/ext/anno` bridge without DSH: a real
 * node:http server, the real websocket upgrade path, and Node's built-in
 * WebSocket client. Only the two route-registration calls the DSH host
 * webserver normally performs are faked, so every frame in these tests
 * travels over a real socket rather than a stub.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createSecureServer, request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'
import WsClient from 'ws'

import { acceptKey, createBridge } from '../src/bridge.js'
import { AnnotationStore } from '../src/store.js'
import { HEALTH_PATH, PROTOCOL_VERSION, WS_PATH } from '../src/protocol.js'

const TOKEN = 'bridge-test-token'
const silent = { debug() {}, info() {}, warn() {} }
const run = promisify(execFile)

/**
 * A throwaway self-signed certificate for `127.0.0.1`, created at test time.
 *
 * Nothing is checked in: the repository ships no key material, and the TLS test
 * only needs a certificate the local client is told to trust. `null` means the
 * local toolchain cannot create one, and the TLS test skips rather than silently
 * passing without exercising the path.
 */
async function createTestCertificate() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-anno-tls-'))
  try {
    await run(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '2',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ],
      { timeout: 20_000 },
    )
    return { dir, cert: await readFile(join(dir, 'cert.pem')), key: await readFile(join(dir, 'key.pem')) }
  } catch {
    await rm(dir, { recursive: true, force: true })
    return null
  }
}

/** @type {string} */
let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-anno-bridge-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/**
 * A complete record that passes `validateRecord`, so tests can focus on the
 * bridge instead of the shape of an anchor.
 * @param {string} name six hex characters, so ids stay distinguishable
 * @param {Record<string, any>} [overrides]
 */
function record(name, overrides = {}) {
  return {
    id: `an-20261118-${name}`,
    url: 'https://example.com/docs?tab=one',
    title: 'Docs',
    anchor: {
      kind: 'element',
      selectors: { cssPath: '#save' },
      fingerprint: { tag: 'button' },
      rect: { x: 1, y: 2, w: 3, h: 4 },
    },
    comment: `comment ${name}`,
    routing: { source: 'user' },
    state: 'open',
    createdAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * @param {number} port
 * @param {string} path
 * @param {{ headers?: Record<string, string>, secure?: boolean }} [options]
 */
function httpGet(port, path, options = {}) {
  const { headers = {}, secure = false } = options
  return new Promise((resolve, reject) => {
    // `agent: false` avoids a keep-alive socket, which would otherwise keep
    // `server.close()` waiting at the end of a test.
    const send = secure ? httpsRequest : httpRequest
    const request = send(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false, headers, rejectUnauthorized: false },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }))
      },
    )
    request.on('error', reject)
    request.end()
  })
}

/** @param {WebSocket} socket @param {number} [timeoutMs] */
function closeSocket(socket, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, timeoutMs)
    socket.addEventListener(
      'close',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    try {
      socket.close()
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

/**
 * Wrap a websocket client in something tests can await: a frame queue so a
 * frame that arrives before the assertion is not lost, and a close promise so
 * the closing code is observable.
 *
 * Every case uses the `ws` client, including the plain one. The platform
 * `WebSocket` (undici) cannot be told to accept the test certificate, and it
 * has been observed reporting a teardown handshake failure as an uncaught error
 * inside the runner — that fails the whole file even though every assertion had
 * already passed, which made the pre-commit hook flaky. `ws` is the library the
 * host serves with, so the handshake under test is the same one, and its events
 * are plain and catchable.
 * @param {{ port: number, secure?: boolean, sockets: Set<WebSocket> }} runtime
 * @param {{ headers?: Record<string, string> }} [options]
 */
async function openClient(runtime, { headers } = {}) {
  const target = `${runtime.secure === true ? 'wss' : 'ws'}://127.0.0.1:${runtime.port}${WS_PATH}`
  const socket = new WsClient(target, { headers, rejectUnauthorized: false })
  runtime.sockets.add(socket)
  /** @type {any[]} */
  const messages = []
  /** @type {Set<() => void>} */
  const waiting = new Set()
  /** @type {{ code: number, reason: string } | null} */
  let closedWith = null
  /** @type {Error | null} */
  let failure = null

  const wake = () => {
    const pending = [...waiting]
    waiting.clear()
    for (const resolve of pending) resolve()
  }

  socket.addEventListener('message', (event) => {
    const text = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8')
    messages.push(JSON.parse(text))
    wake()
  })
  socket.addEventListener('close', (event) => {
    closedWith = { code: event.code, reason: event.reason }
    wake()
  })
  socket.addEventListener('error', () => {
    failure = new Error('the websocket client reported an error')
    wake()
  })

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('the websocket failed to open')), { once: true })
    socket.addEventListener(
      'close',
      (event) => {
        reject(new Error(`the websocket closed during the handshake (code ${event.code})`))
      },
      { once: true },
    )
  })

  /**
   * Resolve on the next frame, socket close, socket failure, or timeout. The
   * caller re-inspects its own state, so the timeout is not an error here.
   * @param {number} timeoutMs
   */
  function change(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(waiter)
        resolve()
      }, timeoutMs)
      const waiter = () => {
        clearTimeout(timer)
        resolve()
      }
      waiting.add(waiter)
    })
  }

  /**
   * Take the first buffered frame matching `predicate`, waiting for new frames
   * while the deadline allows. Matched frames are consumed in arrival order.
   * @param {(frame: any) => boolean} predicate
   * @param {number} [timeoutMs]
   */
  async function waitFor(predicate, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = messages.findIndex(predicate)
      if (index !== -1) return messages.splice(index, 1)[0]
      if (closedWith !== null) {
        throw new Error(`the socket closed (code ${closedWith.code}) before a matching frame arrived`)
      }
      if (failure !== null) throw failure
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timed out after ${timeoutMs}ms waiting for a frame`)
      await change(remaining)
    }
  }

  /**
   * Assert that no matching frame arrives in the window. Used for events that
   * must *not* be broadcast (a replayed create, a stale pick cancel).
   * @param {(frame: any) => boolean} predicate
   * @param {number} [timeoutMs]
   */
  async function expectNone(predicate, timeoutMs = 150) {
    await assert.rejects(waitFor(predicate, timeoutMs), /timed out/, 'a frame arrived that should not have')
  }

  /** @param {number} [timeoutMs] */
  async function closed(timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs
    while (closedWith === null) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('the socket did not close in time')
      await change(remaining)
    }
    return closedWith
  }

  /** @param {Record<string, any>} frame */
  function send(frame) {
    socket.send(JSON.stringify(frame))
  }

  return {
    socket,
    messages,
    waitFor,
    expectNone,
    closed,
    send,
    close: () => closeSocket(socket),
  }
}

/**
 * Build one throwaway deployment: temp store, an HTTP or HTTPS server, the
 * bridge attached to a fake webserver, and a client factory. Registers its own
 * teardown with the test context so a failing assertion cannot leak a listening
 * server.
 * @param {import('node:test').TestContext} t
 * @param {string} name
 * @param {{ tls?: { cert: Buffer, key: Buffer } }} [options]
 */
async function openHost(t, name, options = {}) {
  const store = await new AnnotationStore({ dir: join(root, name), logger: silent }).load()
  /** @type {Map<string, any>} */
  const routes = new Map()
  /** @type {Map<string, any>} */
  const upgrades = new Map()

  /** Exact-path matching mirrors the DSH host webserver. */
  const pathnameOf = (request) => new URL(request.url ?? '/', 'http://127.0.0.1').pathname

  const onRequest = (request, response) => {
    const route = routes.get(pathnameOf(request))
    if (route === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain', connection: 'close' })
      response.end('not found')
      return
    }
    route.handler(request, response)
  }
  const onUpgrade = (request, socket, head) => {
    const route = upgrades.get(pathnameOf(request))
    if (route === undefined) {
      socket.destroy()
      return
    }
    route.handler(request, socket, head)
  }

  const secure = options.tls !== undefined
  const server =
    options.tls === undefined
      ? createServer(onRequest)
      : createSecureServer({ cert: options.tls.cert, key: options.tls.key }, onRequest)
  server.on('upgrade', onUpgrade)

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  const protocol = secure ? 'https:' : 'http:'
  /** The parts of the DSH webserver service the bridge reads. */
  const webServer = {
    protocol,
    getOrigin: () => `${protocol}//127.0.0.1:${port}`,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    registerUpgrade(route) {
      upgrades.set(route.path, route)
      return () => upgrades.delete(route.path)
    },
  }

  const bridge = createBridge({ store, token: TOKEN, logger: silent })
  const dispose = bridge.attach(webServer)
  /** @type {Set<WebSocket>} */
  const sockets = new Set()
  let stopped = false

  const runtime = {
    store,
    bridge,
    port,
    secure,
    sockets,
    /** @param {{ headers?: Record<string, string> }} [clientOptions] */
    client(clientOptions) {
      return openClient(runtime, clientOptions)
    },
  }

  t.after(async () => {
    if (stopped) return
    stopped = true
    // Disposing first closes every tracked browser socket from the server
    // side, which is also the path the plugin takes on profile unload.
    dispose()
    for (const socket of sockets) await closeSocket(socket)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve()))
  })

  return runtime
}

/**
 * Complete the hello handshake and return the `hello.ok` frame.
 * @param {Awaited<ReturnType<typeof openClient>>} client
 * @param {Record<string, any>} [overrides]
 */
async function authenticate(client, overrides = {}) {
  client.send({ t: 'hello', token: TOKEN, version: PROTOCOL_VERSION, clientId: 'test-client', ...overrides })
  return client.waitFor((frame) => frame.t === 'hello.ok')
}

test('the handshake refuses a bad token, accepts a good one and rejects traffic before hello', async (t) => {
  const host = await openHost(t, 'handshake')
  await host.store.put(record('000000'))
  await host.store.put(record('111111', { state: 'resolved' }))

  const intruder = await host.client()
  intruder.send({ t: 'hello', token: 'not-the-token', version: PROTOCOL_VERSION, clientId: 'intruder' })
  assert.equal((await intruder.closed()).code, 4403)
  assert.equal(
    intruder.messages.some((frame) => frame.t === 'hello.ok'),
    false,
  )

  const guest = await host.client()
  guest.send({ t: 'hello', token: TOKEN, version: PROTOCOL_VERSION, clientId: 'guest' })
  const hello = await guest.waitFor((frame) => frame.t === 'hello.ok')
  assert.equal(hello.version, PROTOCOL_VERSION)
  assert.equal(hello.wsPath, WS_PATH)
  assert.equal(hello.openCount, 1, 'only the open record counts')

  const eager = await host.client()
  eager.send({ t: 'anno.query', reqId: 'early', url: 'https://example.com/docs' })
  const error = await eager.waitFor((frame) => frame.t === 'error')
  assert.equal(error.code, 'protocol')
  assert.match(error.message, /hello/)
  assert.equal((await eager.closed()).code, 4401)
})

test('a hello with the wrong protocol version is refused with an error frame and close 4400', async (t) => {
  const host = await openHost(t, 'version')
  const client = await host.client()

  client.send({ t: 'hello', token: TOKEN, version: PROTOCOL_VERSION + 1, clientId: 'stale' })
  const error = await client.waitFor((frame) => frame.t === 'error')
  assert.equal(error.code, 'protocol-version')
  assert.match(error.message, new RegExp(String(PROTOCOL_VERSION)))
  assert.equal((await client.closed()).code, 4400)
})

test('anno.create acks the assigned seq, fans out to other clients and stays idempotent on replay', async (t) => {
  const host = await openHost(t, 'create')
  const alice = await host.client()
  const bob = await host.client()
  await authenticate(alice)
  await authenticate(bob)

  alice.send({ t: 'anno.create', reqId: 'c1', record: record('aaaaaa') })
  const ack = await alice.waitFor((frame) => frame.t === 'anno.ack' && frame.reqId === 'c1')
  assert.equal(ack.id, 'an-20261118-aaaaaa')
  assert.equal(ack.state, 'open')
  assert.equal(ack.seq, 1)
  assert.equal(host.store.get('an-20261118-aaaaaa')?.comment, 'comment aaaaaa')

  const event = await bob.waitFor((frame) => frame.t === 'anno.event')
  assert.equal(event.type, 'created')
  assert.equal(event.seq, ack.seq)
  assert.equal(event.record.id, 'an-20261118-aaaaaa')
  assert.equal(event.record.comment, 'comment aaaaaa')
  assert.equal('host' in event.record, false, 'attachment refs stay on the host')

  alice.send({ t: 'anno.create', reqId: 'c2', record: record('aaaaaa', { comment: 'a duplicate delivery' }) })
  const replay = await alice.waitFor((frame) => frame.t === 'anno.ack' && frame.reqId === 'c2')
  assert.equal(replay.id, 'an-20261118-aaaaaa')
  assert.equal(host.store.size, 1, 'a replay must not append a second record')
  assert.equal(host.store.get('an-20261118-aaaaaa')?.comment, 'comment aaaaaa', 'a replay must not overwrite')
  await bob.expectNone((frame) => frame.t === 'anno.event')
})

test('anno.query matches the same document regardless of query string and hash', async (t) => {
  const host = await openHost(t, 'query')
  await host.store.put(record('aaaaaa', { url: 'https://example.com/docs?tab=one' }))
  await host.store.put(record('bbbbbb', { url: 'https://example.com/docs?tab=two' }))
  await host.store.put(record('cccccc', { url: 'https://example.com/other?tab=one' }))
  await host.store.put(record('dddddd', { url: 'https://other.test/docs?tab=one' }))
  const client = await host.client()
  await authenticate(client)

  client.send({ t: 'anno.query', reqId: 'q1', url: 'https://example.com/docs?tab=two#section' })
  const reply = await client.waitFor((frame) => frame.t === 'anno.query.ok' && frame.reqId === 'q1')
  assert.deepEqual(reply.records.map((item) => item.id).sort(), ['an-20261118-aaaaaa', 'an-20261118-bbbbbb'])
  assert.equal(reply.openCount, 2)
})

test('anno.mutate resolve and delete update the store and broadcast the change', async (t) => {
  const host = await openHost(t, 'mutate')
  const alice = await host.client()
  const bob = await host.client()
  await authenticate(alice)
  await authenticate(bob)

  alice.send({ t: 'anno.create', reqId: 'c1', record: record('aaaaaa') })
  await alice.waitFor((frame) => frame.t === 'anno.ack' && frame.reqId === 'c1')
  await bob.waitFor((frame) => frame.t === 'anno.event' && frame.type === 'created')

  alice.send({ t: 'anno.mutate', reqId: 'm1', id: 'an-20261118-aaaaaa', action: 'resolve', note: 'fixed the label' })
  const updated = await bob.waitFor((frame) => frame.t === 'anno.event' && frame.type === 'updated')
  assert.equal(updated.record.id, 'an-20261118-aaaaaa')
  assert.equal(updated.record.state, 'resolved')
  assert.equal(updated.record.resolution.note, 'fixed the label')
  const resolveAck = await alice.waitFor((frame) => frame.t === 'anno.ack' && frame.reqId === 'm1')
  assert.equal(resolveAck.state, 'resolved')
  assert.equal(host.store.get('an-20261118-aaaaaa')?.state, 'resolved')

  alice.send({ t: 'anno.mutate', reqId: 'm2', id: 'an-20261118-aaaaaa', action: 'delete' })
  const deleted = await bob.waitFor((frame) => frame.t === 'anno.event' && frame.type === 'deleted')
  assert.equal(deleted.record.id, 'an-20261118-aaaaaa')
  assert.equal(host.store.get('an-20261118-aaaaaa'), undefined)
  const deleteAck = await alice.waitFor((frame) => frame.t === 'anno.ack' && frame.reqId === 'm2')
  assert.equal(deleteAck.state, 'deleted')
})

test('requestPick rejects when no browser is connected', async (t) => {
  const host = await openHost(t, 'pick-none')
  await assert.rejects(host.bridge.requestPick({ prompt: 'Where?' }), /no browser connected/)

  // A socket that never sent hello cannot answer a pick either.
  const idle = await host.client()
  await assert.rejects(host.bridge.requestPick({ prompt: 'Where?' }), /no browser connected/)
  await idle.close()
})

test('requestPick resolves the record the browser sends back', async (t) => {
  const host = await openHost(t, 'pick-ok')
  const client = await host.client()
  await authenticate(client)

  const pending = host.bridge.requestPick({ prompt: 'Which chart?', mode: 'region', timeoutMs: 5_000 })
  const request = await client.waitFor((frame) => frame.t === 'pick.request')
  assert.equal(request.prompt, 'Which chart?')
  assert.equal(request.mode, 'region')
  assert.equal(typeof request.pickId, 'string')

  client.send({ t: 'pick.result', pickId: request.pickId, ok: true, record: record('abc123') })
  const result = await pending
  assert.equal(result.ok, true)
  assert.equal(result.record.id, 'an-20261118-abc123')
  assert.equal(host.bridge.stats().picks, 0)
})

test('requestPick times out and cancels the browser banner', async (t) => {
  const host = await openHost(t, 'pick-timeout')
  const client = await host.client()
  await authenticate(client)

  // The bridge floors a pick budget at one second, so the cancel arrives about
  // a second after the request even though 100ms was asked for.
  const pending = host.bridge.requestPick({ prompt: 'Nobody answers', timeoutMs: 100 })
  const request = await client.waitFor((frame) => frame.t === 'pick.request')
  const cancel = await client.waitFor((frame) => frame.t === 'pick.cancel' && frame.pickId === request.pickId, 3_000)
  assert.equal(cancel.pickId, request.pickId)
  assert.deepEqual(await pending, { ok: false, reason: 'timeout' })
  assert.equal(host.bridge.stats().picks, 0)
})

test('requestPick rejects on abort and cancels exactly once', async (t) => {
  const host = await openHost(t, 'pick-abort')
  const client = await host.client()
  await authenticate(client)

  const controller = new AbortController()
  const pending = host.bridge.requestPick({ prompt: 'Abort me', timeoutMs: 500, signal: controller.signal })
  const request = await client.waitFor((frame) => frame.t === 'pick.request')
  controller.abort()
  await assert.rejects(pending, /cancelled/)
  await client.waitFor((frame) => frame.t === 'pick.cancel' && frame.pickId === request.pickId)

  // An aborted pick is already cancelled. The abandoned deadline must not fire
  // later and broadcast a second cancel for a pick that no longer exists.
  await client.expectNone((frame) => frame.t === 'pick.cancel' && frame.pickId === request.pickId, 1_400)
  assert.equal(host.bridge.stats().picks, 0)
})

test('the health route advertises the bridge, its scheme, and allows cross-origin reads', async (t) => {
  const host = await openHost(t, 'health')
  await host.store.put(record('aaaaaa'))
  const client = await host.client()
  await authenticate(client)

  const response = await httpGet(host.port, HEALTH_PATH)
  assert.equal(response.status, 200)
  assert.match(String(response.headers['content-type']), /application\/json/)
  assert.equal(response.headers['access-control-allow-origin'], '*')
  const body = JSON.parse(response.text)
  assert.equal(body.ok, true)
  assert.equal(body.version, PROTOCOL_VERSION)
  assert.equal(body.wsPath, WS_PATH)
  assert.equal(body.openCount, 1)
  assert.equal(body.clients, 1)
  // A plain listener says so: the browser should keep using ws://.
  assert.equal(body.secure, false)
  assert.equal(body.wsUrl, `ws://127.0.0.1:${host.port}${WS_PATH}`)
})

test('health answers wss:// when a TLS-terminating proxy forwards the request', async (t) => {
  const host = await openHost(t, 'health-forwarded')

  const forwarded = await httpGet(host.port, HEALTH_PATH, {
    headers: { 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'anno.example.com' },
  })
  const body = JSON.parse(forwarded.text)
  assert.equal(body.secure, true)
  assert.equal(body.wsUrl, `wss://anno.example.com${WS_PATH}`)
  assert.equal(forwarded.headers['access-control-allow-origin'], '*')

  // `X-Forwarded-Host` may carry the proxy's port; `Host` is the fallback when
  // the proxy does not set it at all.
  const withPort = JSON.parse(
    (
      await httpGet(host.port, HEALTH_PATH, {
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'anno.example.com:8443' },
      })
    ).text,
  )
  assert.equal(withPort.wsUrl, `wss://anno.example.com:8443${WS_PATH}`)

  const hostHeaderOnly = JSON.parse(
    (await httpGet(host.port, HEALTH_PATH, { headers: { 'x-forwarded-proto': 'https' } })).text,
  )
  assert.equal(hostHeaderOnly.secure, true)
  assert.equal(hostHeaderOnly.wsUrl, `wss://127.0.0.1:${host.port}${WS_PATH}`)

  // An explicit `http` from the proxy must not be upgraded to wss.
  const plain = JSON.parse(
    (
      await httpGet(host.port, HEALTH_PATH, {
        headers: { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'anno.example.com' },
      })
    ).text,
  )
  assert.equal(plain.secure, false)
  assert.equal(plain.wsUrl, `ws://anno.example.com${WS_PATH}`)
})

test('a TLS listener serves health and the websocket upgrade over wss', async (t) => {
  const credentials = await createTestCertificate()
  if (credentials === null) {
    t.skip('openssl is not installed, so no throwaway certificate can be created')
    return
  }
  t.after(() => rm(credentials.dir, { recursive: true, force: true }))
  const host = await openHost(t, 'health-tls', { tls: credentials })
  await host.store.put(record('aaaaaa'))

  const response = await httpGet(host.port, HEALTH_PATH, { secure: true })
  assert.equal(response.status, 200)
  const body = JSON.parse(response.text)
  assert.equal(body.secure, true)
  assert.equal(body.wsUrl, `wss://127.0.0.1:${host.port}${WS_PATH}`)

  // The same `handleUpgrade` path, now on a TLS socket: the token handshake
  // must complete exactly as over plain HTTP.
  const client = await host.client()
  const hello = await authenticate(client)
  assert.equal(hello.version, PROTOCOL_VERSION)
  assert.equal(hello.openCount, 1)
})

test('the upgrade handshake ignores proxy headers and an https Origin', async (t) => {
  const host = await openHost(t, 'upgrade-headers')
  // The extension runs on an arbitrary page, so the browser may attach an
  // https Origin to a ws:// handshake. Nothing in the upgrade route reads it,
  // and the forwarding headers a proxy adds must not disturb `handleUpgrade`.
  const client = await host.client({
    headers: {
      origin: 'https://example.com',
      'x-forwarded-proto': 'https, http',
      'x-forwarded-host': 'anno.example.com',
      'x-forwarded-for': '203.0.113.7',
    },
  })
  const hello = await authenticate(client)
  assert.equal(hello.version, PROTOCOL_VERSION)
})

test('acceptKey reproduces the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
})
