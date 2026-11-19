/**
 * The locator's contract, exercised over real sockets.
 *
 * Every case here is about the one thing a fixed, anonymous HTTP listener can
 * get wrong: answering a request it must not (a foreign `Host`, a method other
 * than GET, an unknown path), disappearing when the first port is taken, or
 * outliving the effect that started it. Tests ask the OS for a port by binding
 * `0` — never the shipped 30810-30812 — so a developer running them beside a
 * real host disturbs nothing.
 */

import assert from 'node:assert/strict'
import { createServer, request as sendRequest } from 'node:http'
import { test } from 'node:test'

import { startLocator } from '../src/locator.js'
import { LOCATE_PATH } from '../src/protocol.js'

/**
 * @typedef {object} Response
 * @property {number} status
 * @property {import('node:http').IncomingHttpHeaders} headers
 * @property {string} text
 * @property {any} json
 */

/**
 * One real HTTP request. `agent: false` keeps every probe on its own socket, so
 * a refused connection after disposal is unambiguous, and `setHost: false`
 * leaves the `Host` header entirely under this helper's control.
 * @param {number} port
 * @param {{ method?: string, path?: string, host?: string | null, headers?: Record<string, string> }} [options]
 * @returns {Promise<Response>}
 */
function request(port, options = {}) {
  const host = options.host === undefined ? `127.0.0.1:${port}` : options.host
  const headers = { ...(host === null ? {} : { host }), ...options.headers }
  return new Promise((resolve, reject) => {
    const probe = sendRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? LOCATE_PATH,
        agent: false,
        setHost: false,
        headers,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json: parseJson(text) })
        })
      },
    )
    probe.on('error', reject)
    probe.end()
  })
}

/**
 * Start a locator on an OS-chosen port and register its disposal.
 * @param {import('node:test').TestContext} t
 * @param {{ card?: () => object, ports?: number[], logger?: { warn?: Function, debug?: Function } }} [options]
 * @returns {Promise<{ handle: import('../src/locator.js').LocatorHandle, port: number }>}
 */
async function start(t, options = {}) {
  const handle = startLocator({
    card: options.card ?? (() => ({ app: 'dsh-annotate', origin: 'http://127.0.0.1:51234' })),
    ports: options.ports ?? [0],
    logger: options.logger,
  })
  t.after(() => handle.dispose())
  const port = await handle.ready
  assert.notEqual(port, null)
  return { handle, port }
}

/**
 * @param {import('node:http').Server} server
 * @param {number} [port]
 * @returns {Promise<number>}
 */
function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      resolve(address !== null && typeof address === 'object' ? address.port : 0)
    })
  })
}

/** @param {import('node:http').Server} server @returns {Promise<void>} */
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

/** @param {string} body @returns {import('node:http').Server} */
function occupiedServer(body) {
  return createServer((_request, response) => response.end(body))
}

/** @param {string} text @returns {any} */
function parseJson(text) {
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** @param {unknown} error @returns {boolean} */
function isRefused(error) {
  return error instanceof Error && /** @type {{ code?: string }} */ (error).code === 'ECONNREFUSED'
}

test('GET answers the card with the mandated headers and no CORS', async (t) => {
  const card = { app: 'dsh-annotate', version: 1, origin: 'http://127.0.0.1:51234' }
  const { port } = await start(t, { card: () => card })

  const response = await request(port, { host: `127.0.0.1:${port}` })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, card)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
  assert.equal(response.headers['access-control-allow-origin'], undefined)
})

test('the card is read per request, not cached at bind time', async (t) => {
  let card = { focusAt: null }
  let calls = 0
  const { port } = await start(t, {
    card: () => {
      calls += 1
      return card
    },
  })

  assert.deepEqual((await request(port)).json, { focusAt: null })
  card = { focusAt: '2026-11-19T14:03:11.000Z' }
  assert.deepEqual((await request(port)).json, { focusAt: '2026-11-19T14:03:11.000Z' })
  assert.equal(calls, 2)
})

test('HEAD and POST are refused with 405 and Allow: GET', async (t) => {
  const { port } = await start(t)

  const head = await request(port, { method: 'HEAD' })
  assert.equal(head.status, 405)
  assert.equal(head.headers.allow, 'GET')
  assert.equal(head.headers['content-type'], 'application/json; charset=utf-8')
  // Node suppresses a response body for HEAD; the status and Allow are the
  // whole answer, and the connection must stay usable afterwards.
  assert.equal(head.text, '')

  const post = await request(port, { method: 'POST' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET')
  assert.equal(post.headers['cache-control'], 'no-store')
  assert.equal(post.headers['x-content-type-options'], 'nosniff')
  assert.equal(post.headers['access-control-allow-origin'], undefined)
  assert.deepEqual(post.json, { ok: false, error: 'method' })

  assert.equal((await request(port)).status, 200)
})

test('the Host allowlist refuses rebinding and IPv6 loopback', async (t) => {
  const { port } = await start(t)

  for (const host of ['evil.example', '127.0.0.1.evil.example', '[::1]:30810', 'localhost.:30810', null]) {
    const response = await request(port, { host })
    assert.equal(response.status, 403, `accepted ${String(host)}`)
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(response.headers['access-control-allow-origin'], undefined)
    assert.deepEqual(response.json, { ok: false, error: 'host' })
  }

  assert.equal((await request(port, { host: '127.0.0.1' })).status, 200)
  assert.equal((await request(port, { host: 'localhost' })).status, 200)
  assert.equal((await request(port, { host: `LOCALHOST:${port}` })).status, 200)
})

test('only the exact path is served, and its query string is ignored', async (t) => {
  const { port } = await start(t)

  for (const path of ['/', `${LOCATE_PATH}/extra`, '/ext/anno/locate2']) {
    const response = await request(port, { path })
    assert.equal(response.status, 404, path)
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(response.headers['access-control-allow-origin'], undefined)
    assert.deepEqual(response.json, { ok: false, error: 'not-found' })
  }

  assert.equal((await request(port, { path: `${LOCATE_PATH}?probe=1` })).status, 200)
})

test('an occupied first port is skipped for the next candidate', async (t) => {
  const occupied = occupiedServer('occupied')
  const occupiedPort = await listen(occupied)
  t.after(() => close(occupied))

  const { handle, port } = await start(t, { ports: [occupiedPort, 0] })
  assert.notEqual(port, occupiedPort)
  assert.equal(handle.port, port)

  assert.equal((await request(occupiedPort)).text, 'occupied')
  assert.equal((await request(port)).status, 200)
})

test('all ports occupied resolves null, warns once, and leaves the occupiers alone', async (t) => {
  const first = occupiedServer('first')
  const second = occupiedServer('second')
  const ports = [await listen(first), await listen(second)]
  t.after(async () => {
    await close(first)
    await close(second)
  })

  const warnings = []
  const handle = startLocator({
    card: () => ({ app: 'dsh-annotate' }),
    ports,
    logger: {
      warn: (message) => warnings.push(String(message)),
      debug: () => {},
    },
  })
  t.after(() => handle.dispose())

  assert.equal(await handle.ready, null)
  assert.equal(handle.port, null)
  assert.equal(warnings.length, 1)
  for (const port of ports) assert.match(warnings[0], new RegExp(`\\b${port}\\b`))
  assert.equal((await request(ports[0])).text, 'first')
  assert.equal((await request(ports[1])).text, 'second')
})

test('dispose closes the listener and is idempotent', async (t) => {
  const { handle, port } = await start(t)
  assert.equal((await request(port)).status, 200)

  const disposing = handle.dispose()
  assert.equal(handle.dispose(), disposing)
  await disposing
  await handle.dispose()

  await assert.rejects(request(port), isRefused)
})

test('dispose before ready closes a listener that was still binding', async (t) => {
  const probe = occupiedServer('probe')
  const freePort = await listen(probe)
  await close(probe)

  const handle = startLocator({ card: () => ({ origin: 'http://127.0.0.1:1' }), ports: [freePort] })
  t.after(() => handle.dispose())
  // Called with no `await` in between: the bind may or may not have settled.
  await handle.dispose()

  assert.equal(await handle.ready, null)
  assert.equal(handle.port, null)
  await assert.rejects(request(freePort), isRefused)
})
