/**
 * The Web Client's push channel.
 *
 * Everything the browser half needs is a *pull*: the extension owns a socket,
 * the page reads HTTP. That is right for data — the queue is authoritative and
 * a read can always repair a missed event — but it left the one human-visible
 * step, "this Session just received something", waiting on a poll.
 *
 * So the Host says *when* to read. Each frame is a nudge naming the Session it
 * concerns (`{ t: 'mention', sessionId }`), never the payload: the page still
 * reads `GET /ext/anno/queue?session=…` and still acknowledges it. A dropped
 * stream therefore costs latency, not a delivery.
 *
 * Server-sent events rather than a websocket because the page needs one
 * direction, one stream, and no handshake: `EventSource` reconnects on its own,
 * the Host webserver already turns compression off for `text/event-stream`, and
 * no new protocol surface has to be owned here.
 *
 * @module dsh-marker/events
 */

import { EVENTS_PATH } from './protocol.js'

/** How long a quiet stream is kept visibly alive; a dead socket is dropped. */
const HEARTBEAT_MS = 25_000

/** One page holds one stream, so this is a runaway guard rather than a limit. */
const MAX_CLIENTS = 32

/** A client this far behind is not reading; keeping it only grows the Host. */
const MAX_BACKLOG_BYTES = 64 * 1024

/**
 * @typedef {object} StreamClient
 * @property {any} response The node response the stream writes to.
 * @property {number} id Stable per connection, for diagnostics.
 */

/**
 * @param {object} [options]
 * @param {{ warn?: (...args: any[]) => void, debug?: (...args: any[]) => void }} [options.logger]
 * @param {number} [options.heartbeatMs]
 * @param {number} [options.maxClients]
 */
export function createEventStream({ logger, heartbeatMs = HEARTBEAT_MS, maxClients = MAX_CLIENTS } = {}) {
  /** @type {Set<StreamClient>} */
  const clients = new Set()
  let heartbeat = null
  let sequence = 0

  /** @param {StreamClient} client @param {string} chunk */
  function write(client, chunk) {
    const { response } = client
    if (response.writableEnded === true || response.destroyed === true) {
      clients.delete(client)
      return false
    }
    if (response.writableLength > MAX_BACKLOG_BYTES) {
      // A page that stopped reading its own event stream will reconnect when it
      // comes back; buffering for it here is how a Host leaks memory.
      drop(client, 'backlog')
      return false
    }
    try {
      response.write(chunk)
      return true
    } catch (error) {
      logger?.warn?.(`annotations: event stream write failed (${messageOf(error)})`)
      clients.delete(client)
      return false
    }
  }

  /** @param {StreamClient} client @param {string} reason */
  function drop(client, reason) {
    clients.delete(client)
    logger?.debug?.(`annotations: event client ${client.id} dropped (${reason})`)
    try {
      client.response.end()
    } catch {
      // The socket is already gone in every case worth reaching here.
    }
  }

  /** Keep a quiet stream visibly alive and prove the peer is still reading. */
  function pulse() {
    for (const client of [...clients]) write(client, ': ping\n\n')
  }

  function start() {
    if (heartbeat !== null) return
    heartbeat = setInterval(pulse, heartbeatMs)
    heartbeat.unref?.()
  }

  /**
   * Open one stream. The caller has already checked the method and origin.
   * @param {any} request
   * @param {any} response
   * @returns {() => void} closes just this stream
   */
  function subscribe(request, response) {
    if (clients.size >= maxClients) {
      // Oldest first: a stale page that never closed its stream loses, because
      // the page that is actually being looked at is the one that reconnects.
      const [oldest] = clients
      if (oldest !== undefined) drop(oldest, 'evicted')
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      // A reverse proxy that buffers would hold every event until the stream
      // ends, which is the whole latency this route exists to remove.
      'x-accel-buffering': 'no',
      vary: 'sec-fetch-site',
    })
    response.flushHeaders?.()

    sequence += 1
    const client = { response, id: sequence }
    clients.add(client)
    // The browser's own reconnect delay; a Host restart is the common case.
    write(client, 'retry: 2000\n\n')
    start()

    const forget = () => {
      clients.delete(client)
    }
    request.on?.('close', forget)
    request.on?.('aborted', forget)
    response.on?.('close', forget)
    return forget
  }

  /**
   * Tell every open page that one Session has something waiting. A page whose
   * Session this is not ignores it; the payload is a hint, so fan-out is free.
   * @param {{ t: string, sessionId?: string }} event
   */
  function publish(event) {
    if (clients.size === 0) return
    const chunk = `data: ${JSON.stringify(event)}\n\n`
    for (const client of [...clients]) write(client, chunk)
  }

  /** End every stream and stop the heartbeat (plugin shutdown). */
  function close() {
    if (heartbeat !== null) {
      clearInterval(heartbeat)
      heartbeat = null
    }
    for (const client of [...clients]) drop(client, 'closing')
  }

  return {
    subscribe,
    publish,
    close,
    stats() {
      return { clients: clients.size }
    },
  }
}

/**
 * Serve the event stream to the page this Host serves.
 *
 * The gate is the shared page gate, exactly like the queue and focus routes:
 * `ctx.connection.requestRejection` where the host provides it (Host/Origin
 * fence plus the browser session the page holds), the same-origin header
 * otherwise. The extension's bridge token has no business in it (D12).
 *
 * @param {any} webServer
 * @param {object} options
 * @param {ReturnType<typeof createEventStream>} options.events
 * @param {(request: any) => 401 | 403 | undefined} [options.gate] page gate; defaults to the same-origin header check
 * @param {string} [options.path]
 * @returns {() => void} disposer
 */
export function registerEventsRoute(webServer, { events, gate = headerGate, path = EVENTS_PATH }) {
  return webServer.register({
    kind: 'exact',
    path,
    auth: 'anonymous',
    handler: (request, response) => {
      const rejection = gate(request)
      if (rejection !== undefined) {
        response.writeHead(rejection, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(JSON.stringify({ ok: false, error: rejection === 401 ? 'auth' : 'origin' }))
        return
      }
      if (request.method !== 'GET') {
        response.writeHead(405, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          allow: 'GET',
        })
        response.end(JSON.stringify({ ok: false, error: 'method' }))
        return
      }
      events.subscribe(request, response)
    },
  })
}

/**
 * The GUI is served by this Host, so the browser marks its own requests
 * `same-origin`. A request without the header is not the page.
 * @param {any} request
 */
function sameOrigin(request) {
  return request.headers?.['sec-fetch-site'] === 'same-origin'
}
/**
 * The shipped gate when no other is provided: the same-origin header, in the
 * admission contract the routes speak (undefined admits, a status refuses).
 * @param {any} request
 * @returns {403 | undefined}
 */
function headerGate(request) {
  return sameOrigin(request) ? undefined : 403
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
