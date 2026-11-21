import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createPageGate } from '../src/pagegate.js'
import { registerEventsRoute, createEventStream } from '../src/events.js'
import { registerFocusRoute, createFocusStore } from '../src/focus.js'
import { createMentionQueue, registerQueueRoutes } from '../src/queue.js'
import { registerPresentationRoutes } from '../src/presentation.js'

/** A host Connection service reduced to the one member the gate reads. */
function connectionWith(requestRejection) {
  return { requestRejection }
}

/** A request the GUI page would send, or a rebound attacker page. */
function request(headers) {
  return { method: 'GET', url: '/', headers }
}

test('the gate consults the connection fence per request and relays its verdict', () => {
  const seen = []
  const connection = connectionWith((req) => {
    seen.push(req)
    return req.headers.host === '127.0.0.1:3080' ? undefined : req.headers.cookie ? 403 : 401
  })
  /** @type {{ current?: any }} */
  const services = {}
  const gate = createPageGate({ get: (service) => (service === 'connection' ? services.current : undefined) })

  // No service yet: the fallback answers, and the fence is not consulted.
  assert.equal(gate(request({ 'sec-fetch-site': 'same-origin' })), undefined)
  assert.equal(gate(request({ 'sec-fetch-site': 'cross-site' })), 403)
  assert.deepEqual(seen, [])

  // The service appears: the next request goes through it, whatever its verdict.
  services.current = connection
  assert.equal(gate(request({ host: '127.0.0.1:3080' })), undefined)
  assert.equal(gate(request({ host: 'evil.example:3080' })), 401)
  assert.equal(gate(request({ host: 'evil.example:3080', cookie: 'dsh-session=x' })), 403)
  assert.equal(seen.length, 3)

  // And disappears again without a restart.
  services.current = undefined
  assert.equal(gate(request({})), 403)
})

test('the fallback keeps the header check and says so once', () => {
  const lines = []
  const logger = { debug: (message) => lines.push(message) }
  const gate = createPageGate({ get: () => undefined, logger })

  assert.equal(gate(request({ 'sec-fetch-site': 'same-origin' })), undefined)
  assert.equal(gate(request({ 'sec-fetch-site': 'same-origin' })), undefined)
  assert.equal(gate(request({ 'sec-fetch-site': 'same-site' })), 403)
  assert.equal(gate(request({})), 403)
  assert.equal(lines.length, 1)
})

/** The one-request server harness the route tests use. */
function mount(routeFactory) {
  /** @type {Record<string, Function>} */
  const handlers = {}
  const webServer = {
    register: (route) => {
      handlers[route.path] = route.handler
      return () => {}
    },
  }
  routeFactory(webServer)
  return handlers
}

/** @param {Function} handler @param {{ method?: string, url?: string, headers?: object, body?: string }} [init] */
function call(handler, init = {}) {
  return new Promise((resolve) => {
    let status = 0
    const request = {
      method: init.method ?? 'GET',
      url: init.url ?? '/x',
      headers: init.headers ?? {},
      on: (event, listener) => {
        if (event === 'data' && init.body !== undefined) listener(Buffer.from(init.body))
        if (event === 'end') listener()
        return request
      },
      destroy: () => {},
    }
    const response = {
      writeHead: (code) => {
        status = code
      },
      end: (body) => resolve({ status, body: body === undefined ? undefined : JSON.parse(body) }),
    }
    handler(request, response)
  })
}

test('a rebound page is refused on every GUI route, and an authenticated page passes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-anno-gate-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  // The fence the host provides: the GUI page holds a session cookie and a
  // loopback Host; the rebound page holds its own Host and no cookie.
  const hostFence = (req) => {
    if (req.headers.host !== '127.0.0.1:3080') return 403
    if (req.headers.cookie !== 'dsh-session=1') return 401
    return undefined
  }
  const gate = createPageGate({ get: () => connectionWith(hostFence) })

  const queue = createMentionQueue({ dir })
  await queue.load()
  const focus = createFocusStore({ dir })
  await focus.load()
  const events = createEventStream({ logger: { debug: () => {}, info: () => {}, warn: () => {} } })
  t.after(() => events.close())
  const store = { get: () => undefined, image: () => undefined }

  const queueMount = mount((webServer) => registerQueueRoutes(webServer, { queue, gate }))
  const focusMount = mount((webServer) => registerFocusRoute(webServer, { store: focus, gate }))
  const eventsMount = mount((webServer) => registerEventsRoute(webServer, { events, gate }))
  const presentationMount = mount((webServer) => registerPresentationRoutes(webServer, { store, gate }))

  // The rebound page: same-origin by its own lights, attacker Host. And the
  // no-session case: a loopback Host without the GUI's cookie (curl, or a
  // logged-out tab) — the fence distinguishes forbidden from unauthenticated.
  const rebound = { 'sec-fetch-site': 'same-origin', host: 'evil.example:3080' }
  const noSession = { 'sec-fetch-site': 'same-origin', host: '127.0.0.1:3080' }
  for (const [label, handler] of [
    ['queue read', Object.values(queueMount)[0]],
    ['focus report', Object.values(focusMount)[0]],
    ['event stream', Object.values(eventsMount)[0]],
    ['annotation item', Object.values(presentationMount)[0]],
  ]) {
    assert.equal((await call(handler, { headers: rebound })).status, 403, `${label}: rebound Host`)
    assert.equal((await call(handler, { headers: noSession })).status, 401, `${label}: no session`)
  }

  // The page itself: the fence admits it and the route answers on its merits.
  const page = { 'sec-fetch-site': 'same-origin', host: '127.0.0.1:3080', cookie: 'dsh-session=1' }
  const queueRead = Object.keys(queueMount).find((p) => p.endsWith('/queue'))
  assert.equal((await call(queueMount[queueRead], { headers: page, url: '/x?session=s-1' })).status, 200)
  assert.equal((await call(Object.values(focusMount)[0], { headers: page })).status, 200)
})
