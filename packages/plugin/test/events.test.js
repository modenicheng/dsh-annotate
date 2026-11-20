/**
 * The page's push channel: a stream that says *when* to read, never what.
 *
 * These tests pin the parts a browser cannot be asked about in this repo — the
 * frame shape, the same-origin gate, and that a departed page stops costing
 * anything — while the delivery itself stays covered by the queue tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createEventStream, registerEventsRoute } from '../src/events.js'
import { EVENTS_PATH } from '../src/protocol.js'

const PAGE = { 'sec-fetch-site': 'same-origin' }

/**
 * Subscribe a fake page to a stream and keep what it was sent.
 * @param {ReturnType<typeof createEventStream>} events
 * @param {object} [init]
 */
function page(events, init = {}) {
  /** @type {string[]} */
  const chunks = []
  /** @type {Record<string, Function[]>} */
  const listeners = {}
  let status = 0
  /** @type {Record<string, string>} */
  let headers = {}
  const request = {
    method: 'GET',
    url: EVENTS_PATH,
    headers: init.headers ?? PAGE,
    on(event, listener) {
      ;(listeners[event] ??= []).push(listener)
      return request
    },
  }
  const response = {
    writeHead(code, value) {
      status = code
      headers = value ?? {}
    },
    flushHeaders() {},
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    end() {},
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
  }
  events.subscribe(request, response)
  return {
    chunks,
    headers: () => headers,
    status: () => status,
    /** Simulate the browser dropping the connection. */
    leave() {
      for (const listener of listeners.close ?? []) listener()
    },
  }
}

/** @param {string[]} chunks */
function payloads(chunks) {
  return chunks.filter((chunk) => chunk.startsWith('data: ')).map((chunk) => JSON.parse(chunk.slice(6).trim()))
}

test('a published nudge reaches every open page, as a bare event frame', () => {
  const events = createEventStream()
  const first = page(events)
  const second = page(events)

  events.publish({ t: 'mention', sessionId: 'session-a' })

  for (const client of [first, second]) {
    assert.deepEqual(payloads(client.chunks), [{ t: 'mention', sessionId: 'session-a' }])
  }
  assert.equal(events.stats().clients, 2)
  events.close()
})

test('the stream announces itself as events and names its reconnect delay', () => {
  const events = createEventStream()
  const client = page(events)

  assert.equal(client.status(), 200)
  assert.equal(client.headers()['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(client.headers()['cache-control'], 'no-store')
  assert.ok(client.chunks[0].startsWith('retry: '), 'the browser is told how long to wait')
  events.close()
})

test('a page that leaves is forgotten instead of being written to', () => {
  const events = createEventStream()
  const client = page(events)
  client.leave()

  assert.equal(events.stats().clients, 0)
  events.publish({ t: 'mention', sessionId: 'session-a' })
  assert.deepEqual(payloads(client.chunks), [])
  events.close()
})

test('closing the stream ends every page and publishes nothing afterwards', () => {
  const events = createEventStream()
  const client = page(events)
  events.close()

  assert.equal(events.stats().clients, 0)
  events.publish({ t: 'mention', sessionId: 'session-a' })
  assert.deepEqual(payloads(client.chunks), [])
})

/** Capture the handler a route registration produced. */
function mount(events) {
  /** @type {any} */
  let registration
  const webServer = {
    register(route) {
      assert.equal(route.path, EVENTS_PATH)
      registration = route
      return () => {}
    },
  }
  const dispose = registerEventsRoute(webServer, { events })
  return { dispose, registration }
}

/** @param {any} handler @param {{ method?: string, headers?: Record<string, string> }} [init] */
function call(handler, init = {}) {
  /** @type {string[]} */
  const chunks = []
  let status = 0
  let body = ''
  const request = {
    method: init.method ?? 'GET',
    url: EVENTS_PATH,
    headers: init.headers ?? {},
    on() {
      return request
    },
  }
  const response = {
    writeHead(code) {
      status = code
    },
    flushHeaders() {},
    write(chunk) {
      chunks.push(String(chunk))
    },
    end(value) {
      if (typeof value === 'string') body += value
    },
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
  }
  handler(request, response)
  return { status: () => status, body: () => body, chunks }
}

test('the route serves only the page this Host serves', () => {
  const events = createEventStream()
  const { registration } = mount(events)
  const handler = registration.handler

  const streamed = call(handler, { headers: PAGE })
  assert.equal(streamed.status(), 200)
  assert.ok(streamed.chunks.length > 0, 'a same-origin GET is a stream')

  const foreign = call(handler, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(foreign.status(), 403)
  assert.equal(JSON.parse(foreign.body()).error, 'origin')

  const missing = call(handler)
  assert.equal(missing.status(), 403)

  const posted = call(handler, { method: 'POST', headers: PAGE })
  assert.equal(posted.status(), 405)
  assert.equal(JSON.parse(posted.body()).error, 'method')

  events.close()
})
