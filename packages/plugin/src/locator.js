/**
 * A fixed loopback address that says where this host is.
 *
 * The locator and the endpoint record answer the same question — where — and
 * split by availability rather than by content: the locator is live but may be
 * absent when its ports are taken, while the record is always written but has
 * to be opened by hand. Neither ever carries the token, whose only home is
 * `$DSH_HOME/ext-bridge-token`.
 *
 * There is deliberately no `access-control-allow-origin`: the extension reads
 * the body through its host permission, a web page must not be able to, and the
 * `Host` allowlist closes the DNS-rebinding route that would otherwise let one
 * try.
 *
 * @module dsh-annotate/locator
 */

import { createServer } from 'node:http'

import { LOCATE_HOST, LOCATE_PATH, LOCATE_PORTS } from './protocol.js'

/** The largest legal TCP port, used to refuse `Host: 127.0.0.1:99999`. */
const MAX_PORT = 65_535

/**
 * Loopback names a browser may put in `Host`, with an optional port. Matching
 * strings rather than resolving names is the point: `localhost` is accepted
 * literally, while `[::1]`, `127.0.0.1.evil.example`, and every other name are
 * refused.
 */
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost)(?::([0-9]{1,5}))?$/i

/**
 * Every response carries these. In particular there is no
 * `access-control-allow-origin`: an extension with host permission reads the
 * body anyway, and a page that cannot read it has nothing to gain from asking.
 */
const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

/**
 * @typedef {object} LocatorHandle
 * @property {number | null} port The bound port, or null until a bind succeeds and after a dispose-before-bind.
 * @property {Promise<number | null>} ready Resolves with the port, or null once every candidate failed.
 * @property {() => Promise<void>} dispose Closes the listener; idempotent and never rejects.
 */

/**
 * Bind the locator on the first free port. Never throws: an occupied port is
 * skipped, and when every port is occupied the host stays discoverable through
 * the endpoint record alone.
 *
 * The handle is returned synchronously, before the first bind settles, because
 * the caller registers a synchronous disposer with `ctx.effect`; a disposer
 * that runs before `ready` resolves must still close the listener.
 *
 * @param {object} [options]
 * @param {() => object} options.card Returns the documented JSON body; called per request.
 * @param {string} [options.host] Bind address; defaults to `LOCATE_HOST`.
 * @param {number[]} [options.ports] Ports tried in order; defaults to `LOCATE_PORTS`.
 * @param {string} [options.path] Exact locate path; defaults to `LOCATE_PATH`.
 * @param {{ warn?: Function, debug?: Function }} [options.logger]
 * @returns {LocatorHandle}
 */
export function startLocator({ card, host = LOCATE_HOST, ports = LOCATE_PORTS, path = LOCATE_PATH, logger } = {}) {
  /** Set by `dispose`; every await in the bind loop re-checks it. */
  let disposed = false
  /** @type {import('node:http').Server | null} */
  let server = null
  /** @type {Promise<void> | null} */
  let disposing = null
  /** @type {Promise<void> | null} */
  let binding = null
  let readyResolved = false
  /** @type {((port: number | null) => void) | null} */
  let resolveReady = null
  const ready = new Promise((resolve) => {
    resolveReady = resolve
  })

  /**
   * Resolve `ready` once, with whichever answer came first.
   * @param {number | null} port
   */
  function settle(port) {
    if (readyResolved) return
    readyResolved = true
    resolveReady?.(port)
  }

  const handle = {
    port: null,
    ready,
    dispose,
  }

  /**
   * Close the listener, including one whose bind is still in flight.
   * @returns {Promise<void>}
   */
  function dispose() {
    if (disposing !== null) return disposing
    disposed = true
    disposing = (async () => {
      // The bind loop owns a listener from the moment it calls `listen`; the
      // loop closes one that settles after this flag was seen. Waiting for it
      // means "dispose resolved" implies "nothing is listening".
      if (binding !== null) await binding
      const target = server
      server = null
      await closeServer(target)
      settle(null)
    })()
    return disposing
  }

  /**
   * Try the ports in order, stopping at the first one that binds.
   * @returns {Promise<void>}
   */
  async function bindPorts() {
    for (const port of ports) {
      if (disposed) break
      const candidate = createLocatorServer({ card, path, logger })
      try {
        await listenOn(candidate, port, host)
      } catch (error) {
        // Occupied and unusable are the same decision — try the next port —
        // but they are worth different amounts of noise.
        logger?.debug?.(`annotations: locator could not bind ${host}:${port} (${describeError(error)})`)
        continue
      }
      // A disposer can run while a bind is in flight, and it had no listener
      // to close then. Re-check after the await and close the one this loop
      // created, or it would outlive the effect that owns it.
      if (disposed) {
        await closeServer(candidate)
        break
      }
      server = candidate
      handle.port = portOf(candidate, port)
      settle(handle.port)
      return
    }
    // No port is not a failure of the host: the record and a manual address
    // remain, so one warning naming what was tried is all this deserves.
    if (disposed) {
      settle(null)
      return
    }
    logger?.warn?.(
      `annotations: locator could not bind any of ${ports.join(', ')}; ` +
        'discovery falls back to the endpoint record or a manual address',
    )
    settle(null)
  }

  binding = bindPorts().catch((error) => {
    // A logger that throws, or a bug in the loop, must not escape as an
    // unhandled rejection from a call that promises to never throw.
    settle(null)
    logger?.debug?.(`annotations: locator stopped unexpectedly (${describeError(error)})`)
  })

  return handle
}

/**
 * Create the one-route listener.
 *
 * `card` is captured rather than read once at bind time: its answer changes
 * while the host runs (`focusAt` moves), so every request builds a fresh body.
 * @param {object} options
 * @param {() => object} options.card
 * @param {string} options.path
 * @param {{ warn?: Function, debug?: Function }} [options.logger]
 * @returns {import('node:http').Server}
 */
function createLocatorServer({ card, path, logger }) {
  // `requireHostHeader: false` hands a missing `Host` to the handler instead of
  // letting Node answer 400 first. The allowlist must own that refusal, or the
  // documented "missing Host is 403" would depend on the runtime's parser.
  return createServer({ requireHostHeader: false }, (request, response) => {
    /**
     * @param {number} status
     * @param {unknown} payload
     * @param {Record<string, string>} [extra]
     */
    const send = (status, payload, extra) => {
      response.writeHead(status, { ...BASE_HEADERS, ...extra })
      response.end(JSON.stringify(payload))
    }

    // The fence comes first. A page that rebinds a name to loopback sends its
    // own name in `Host`, and no fact about method or path may be learned from
    // a request a web page controls.
    if (!isLoopbackHost(request.headers.host)) {
      send(403, { ok: false, error: 'host' })
      return
    }
    if (pathnameOf(request.url) !== path) {
      send(404, { ok: false, error: 'not-found' })
      return
    }
    if (request.method !== 'GET') {
      // `HEAD` is refused like every other non-GET: the contract is a GET, and
      // answering it with a body-free HEAD would still be a success status.
      send(405, { ok: false, error: 'method' }, { allow: 'GET' })
      return
    }
    let body
    try {
      body = JSON.stringify(card())
    } catch (error) {
      // A throwing card is a host bug, not a request. Answer a JSON error
      // rather than let it escape the handler and become the uncaught
      // exception that takes the whole host down.
      logger?.debug?.(`annotations: locator card failed (${describeError(error)})`)
      send(500, { ok: false, error: 'card' })
      return
    }
    response.writeHead(200, BASE_HEADERS)
    response.end(body)
  })
}

/**
 * Whether a `Host` names this machine's loopback interface.
 * @param {unknown} value
 * @returns {boolean}
 */
function isLoopbackHost(value) {
  if (typeof value !== 'string') return false
  const match = LOOPBACK_HOST.exec(value)
  if (match === null) return false
  const port = match[1]
  return port === undefined || Number(port) <= MAX_PORT
}

/**
 * The path of a request target, with any query string removed.
 * @param {string | undefined} url
 * @returns {string}
 */
function pathnameOf(url) {
  if (typeof url !== 'string') return ''
  const end = url.indexOf('?')
  return end === -1 ? url : url.slice(0, end)
}

/**
 * Resolve once a server is listening, or reject with its bind error.
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 * @returns {Promise<void>}
 */
function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Close a listener and every connection it still holds.
 *
 * A keep-alive probe would otherwise keep the socket — and therefore the port
 * — alive until it times out, so `closeAllConnections` runs first where the
 * runtime has it. A server that never listened is not an error here.
 * @param {import('node:http').Server | null} target
 * @returns {Promise<void>}
 */
function closeServer(target) {
  if (target === null) return Promise.resolve()
  try {
    target.closeAllConnections?.()
  } catch {
    // An older runtime without the call still stops new connections below.
  }
  return new Promise((resolve) => {
    try {
      target.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * The port the listener actually bound. `0` asks the OS to choose, so the
 * number from `address()` is the answer, not the requested one.
 * @param {import('node:http').Server} server
 * @param {number} requested
 * @returns {number}
 */
function portOf(server, requested) {
  const address = server.address()
  return address !== null && typeof address === 'object' && typeof address.port === 'number' ? address.port : requested
}

/** @param {unknown} error @returns {string} */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}
