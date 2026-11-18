/**
 * The `/ext/anno` bridge: one websocket endpoint on the DSH host webserver,
 * a token handshake, annotation fan-out, and the agent-initiated pick queue.
 *
 * The bridge owns no storage of its own — every mutation goes through
 * `AnnotationStore` so the browser and the model see the same record.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

import { WebSocketServer } from 'ws'

import { describeEndpoint } from './endpoint.js'
import {
  HELLO_TIMEOUT_MS,
  HEALTH_PATH,
  LIMITS,
  PICK_TIMEOUT_MS,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
  WS_PATH,
  encodeFrame,
  newPickId,
  normalizeRecord,
  parseClientFrame,
  sameDocument,
} from './protocol.js'

const CLOSE_UNAUTHORIZED = 4401
const CLOSE_FORBIDDEN = 4403
const CLOSE_PROTOCOL = 4400

/** RFC 6455 handshake constant, pinned here so `acceptKey` stays pure. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * Compute the `Sec-WebSocket-Accept` value for a client key.
 *
 * Exported for the handshake test vector; the `ws` package performs the real
 * handshake, so nothing in the bridge calls this.
 * @param {string} key
 */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
}

/**
 * Constant-time token comparison. Hashing first gives both sides the same
 * length, which `timingSafeEqual` requires.
 * @param {string} presented
 * @param {string} expected
 */
export function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false
  const left = createHash('sha256').update(presented).digest()
  const right = createHash('sha256').update(expected).digest()
  return timingSafeEqual(left, right)
}

/** @param {unknown} error */
export function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {object} options
 * @param {import('./store.js').AnnotationStore} options.store
 * @param {string} options.token
 * @param {(input: { data: Uint8Array, mediaType: string, name?: string }) => Promise<any>} [options.saveImage]
 * @param {{ info?: Function, warn?: Function, debug?: Function }} [options.logger]
 */
export function createBridge({ store, token, saveImage, logger = {} }) {
  const log = {
    info: logger.info ?? (() => {}),
    warn: logger.warn ?? (() => {}),
    debug: logger.debug ?? (() => {}),
  }
  /** @type {Set<any>} */
  const clients = new Set()
  /** @type {Map<string, any>} */
  const picks = new Map()
  let heartbeat = null

  /** @param {any} client @param {any} frame */
  function send(client, frame) {
    if (client.closed === true) return
    // 1 is WebSocket.OPEN; a closing socket must not throw into the caller.
    if (client.connection.readyState !== 1) return
    client.connection.send(encodeFrame(frame))
  }

  /** @param {any} frame */
  function broadcast(frame) {
    for (const client of clients) if (client.authed) send(client, frame)
  }

  /** @param {string} type @param {any} record @param {number} seq */
  function broadcastEvent(type, record, seq) {
    broadcast({ t: 'anno.event', seq, type, record: toWire(record) })
  }

  /**
   * @param {import('ws').WebSocket} connection
   * @param {import('node:http').IncomingMessage} request
   */
  function onConnection(connection, request) {
    const client = {
      connection,
      authed: false,
      closed: false,
      clientId: '',
      remote: request?.socket?.remoteAddress ?? '',
      helloDeadline: setTimeout(() => {
        if (!client.authed) connection.close(CLOSE_PROTOCOL, 'hello timeout')
      }, HELLO_TIMEOUT_MS),
    }
    client.helloDeadline.unref?.()
    clients.add(client)

    // `isAlive` is bridge state, not a ws property: the heartbeat clears it and
    // a pong restores it, which is the standard liveness check for `ws`.
    connection.isAlive = true
    connection.on('pong', () => {
      connection.isAlive = true
    })
    connection.on('message', (data) => {
      void onMessage(client, data.toString())
    })
    connection.on('close', () => {
      clearTimeout(client.helloDeadline)
      client.closed = true
      clients.delete(client)
    })
    connection.on('error', (error) => {
      log.warn(`annotations: socket error: ${describeError(error)}`)
      clearTimeout(client.helloDeadline)
      client.closed = true
      clients.delete(client)
    })
  }

  /**
   * @param {any} client
   * @param {string} text
   */
  async function onMessage(client, text) {
    const parsed = parseClientFrame(text)
    if (!parsed.ok) {
      reject(client, parsed.reason)
      return
    }
    const frame = parsed.frame

    if (frame.t === 'hello') {
      if (!tokenMatches(frame.token, token)) {
        client.connection.close(CLOSE_FORBIDDEN, 'bad token')
        return
      }
      if (frame.version !== PROTOCOL_VERSION) {
        send(client, {
          t: 'error',
          code: 'protocol-version',
          message: `host speaks protocol ${PROTOCOL_VERSION}, client sent ${String(frame.version)}`,
        })
        client.connection.close(CLOSE_PROTOCOL, 'protocol version')
        return
      }
      client.authed = true
      client.clientId = typeof frame.clientId === 'string' ? frame.clientId : ''
      clearTimeout(client.helloDeadline)
      send(client, {
        t: 'hello.ok',
        version: PROTOCOL_VERSION,
        wsPath: WS_PATH,
        openCount: store.count((record) => record.state === 'open'),
        activeSessions: [],
        caps: { pick: true, query: true, mutate: true },
      })
      log.debug(`annotations: client ${client.clientId || '(anon)'} connected`)
      return
    }

    if (!client.authed) {
      reject(client, 'hello required before any other frame')
      client.connection.close(CLOSE_UNAUTHORIZED, 'hello required')
      return
    }

    switch (frame.t) {
      case 'ping':
        send(client, { t: 'pong' })
        return
      case 'anno.create':
        await onCreate(client, frame)
        return
      case 'anno.query':
        await onQuery(client, frame)
        return
      case 'anno.mutate':
        await onMutate(client, frame)
        return
      case 'pick.result':
        onPickResult(frame)
        return
      default:
        reject(client, `unhandled frame ${frame.t}`)
    }
  }

  /** @param {any} client @param {string} reason */
  function reject(client, reason) {
    send(client, { t: 'error', code: 'protocol', message: reason })
  }

  /**
   * @param {any} client
   * @param {any} frame
   */
  async function onCreate(client, frame) {
    const record = normalizeRecord(frame.record)
    const existing = store.get(record.id)
    if (existing !== undefined) {
      // Offline replay is expected: the same id may arrive twice.
      send(client, { t: 'anno.ack', reqId: frame.reqId, id: record.id, seq: store.seq, state: existing.state })
      return
    }

    if (typeof frame.targetImageB64 === 'string' && saveImage !== undefined) {
      try {
        const ref = await saveImage({
          data: Buffer.from(frame.targetImageB64, 'base64'),
          mediaType: imageMediaType(frame.targetImageMime),
          name: `${record.id}.png`,
        })
        await store.setImage(record.id, ref)
        record.host = { image: ref }
      } catch (error) {
        // A rejected crop must not cost the user their comment.
        log.warn(`annotations: crop rejected for ${record.id}: ${describeError(error)}`)
      }
    }

    const seq = await store.put(record)
    send(client, { t: 'anno.ack', reqId: frame.reqId, id: record.id, seq, state: record.state })
    broadcastEvent('created', record, seq)
    void store.maybeCompact().catch(() => {})
  }

  /**
   * @param {any} client
   * @param {any} frame
   */
  async function onQuery(client, frame) {
    const url = typeof frame.url === 'string' ? frame.url : ''
    const all = store.list({ status: 'all', limit: LIMITS.listLimit })
    const records = url === '' ? all : all.filter((record) => sameDocument(record, url))
    send(client, {
      t: 'anno.query.ok',
      reqId: frame.reqId,
      records: records.map(toWire),
      openCount: records.filter((record) => record.state === 'open').length,
    })
  }

  /**
   * @param {any} client
   * @param {any} frame
   */
  async function onMutate(client, frame) {
    const current = store.get(frame.id)
    if (current === undefined) {
      send(client, { t: 'error', code: 'not-found', message: `no annotation ${frame.id}` })
      return
    }
    if (frame.action === 'delete') {
      await store.delete(frame.id)
      broadcastEvent('deleted', { ...current, id: frame.id }, store.seq)
      send(client, { t: 'anno.ack', reqId: frame.reqId, id: frame.id, seq: store.seq, state: 'deleted' })
      return
    }
    /** @type {Record<string, any>} */
    const patch = { updatedAt: new Date().toISOString() }
    switch (frame.action) {
      case 'resolve':
        patch.state = 'resolved'
        patch.resolution = {
          by: 'user',
          note: typeof frame.note === 'string' ? frame.note : '',
          resolvedAt: Date.now(),
        }
        break
      case 'wont_fix':
        patch.state = 'wont_fix'
        patch.resolution = {
          by: 'user',
          note: typeof frame.note === 'string' ? frame.note : '',
          resolvedAt: Date.now(),
        }
        break
      case 'reopen':
        patch.state = 'open'
        patch.resolution = null
        break
      case 'edit':
        patch.comment = String(frame.comment)
        break
      default:
        break
    }
    const updated = await store.patch(frame.id, patch)
    send(client, { t: 'anno.ack', reqId: frame.reqId, id: frame.id, seq: store.seq, state: updated?.state })
    broadcastEvent('updated', updated, store.seq)
  }

  /** @param {any} frame */
  function onPickResult(frame) {
    const pending = picks.get(frame.pickId)
    if (pending === undefined) {
      log.debug(`annotations: ignoring stale pick ${frame.pickId}`)
      return
    }
    clearTimeout(pending.timer)
    picks.delete(frame.pickId)
    if (frame.ok === true) pending.resolve({ ok: true, record: frame.record })
    else pending.resolve({ ok: false, reason: typeof frame.reason === 'string' ? frame.reason : 'cancelled' })
  }

  /**
   * Ask the browser for one annotation and wait for the answer.
   * @param {{ mode?: string, prompt: string, timeoutMs?: number, sessionId?: string, signal?: AbortSignal }} request
   * @returns {Promise<{ ok: true, record: any } | { ok: false, reason: string }>}
   */
  function requestPick({ mode, prompt, timeoutMs, sessionId, signal }) {
    const authed = [...clients].filter((client) => client.authed)
    if (authed.length === 0) {
      return Promise.reject(new Error('no browser connected: open Firefox/Zen with the dsh-annotate extension'))
    }
    if (signal?.aborted === true) return Promise.reject(new Error('cancelled'))
    const pickId = newPickId()
    const budget = Math.max(1_000, Math.min(Number(timeoutMs) || PICK_TIMEOUT_MS, 15 * 60_000))

    return new Promise((resolve, reject) => {
      const settle = (result) => {
        cleanup()
        resolve(result)
      }
      const fail = (error) => {
        cleanup()
        reject(error)
      }
      const timer = setTimeout(() => {
        broadcast({ t: 'pick.cancel', pickId })
        settle({ ok: false, reason: 'timeout' })
      }, budget)
      timer.unref?.()
      const onAbort = () => {
        broadcast({ t: 'pick.cancel', pickId })
        fail(new Error('cancelled'))
      }
      const cleanup = () => {
        // An abort settles the pick without going through `onPickResult`, so
        // the deadline must be disarmed here or it fires later and broadcasts
        // a second `pick.cancel` for a banner that is already gone.
        clearTimeout(timer)
        picks.delete(pickId)
        signal?.removeEventListener('abort', onAbort)
      }
      picks.set(pickId, { resolve: settle, reject: fail, timer })
      signal?.addEventListener('abort', onAbort, { once: true })
      broadcast({
        t: 'pick.request',
        pickId,
        mode: mode ?? 'auto',
        prompt,
        timeoutMs: budget,
        sessionId: sessionId ?? '',
      })
    })
  }

  /** Cancel every pending pick (profile unload). */
  function cancelAllPicks() {
    for (const [pickId, pending] of picks) {
      clearTimeout(pending.timer)
      broadcast({ t: 'pick.cancel', pickId })
      pending.resolve({ ok: false, reason: 'host shutting down' })
    }
    picks.clear()
  }

  /**
   * Register the HTTP health route and the websocket upgrade route.
   * @param {any} webServer
   * @returns {() => void} disposer
   */
  function attach(webServer) {
    // `noServer` keeps the HTTP layer owned by DSH: the upgrade route decides
    // which requests become websockets, and `ws` only frames the connection.
    const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.imageBase64Chars })
    wss.on('connection', onConnection)

    const health = webServer.register({
      kind: 'exact',
      path: HEALTH_PATH,
      auth: 'anonymous',
      handler: (request, response) => {
        // Scheme negotiation: the host says which URL works, the browser does
        // not guess. `describeEndpoint` reads the serving socket, the listener
        // configuration, and the forwarding headers a TLS proxy sets.
        const endpoint = describeEndpoint({ request, webServer })
        const body = JSON.stringify({
          ok: true,
          version: PROTOCOL_VERSION,
          secure: endpoint.secure,
          wsUrl: endpoint.wsUrl,
          wsPath: WS_PATH,
          openCount: store.count((record) => record.state === 'open'),
          clients: [...clients].filter((client) => client.authed).length,
        })
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'content-type',
        })
        response.end(request.method === 'HEAD' ? undefined : body)
      },
    })

    // The upgrade route is scheme-independent on purpose: `handleUpgrade` only
    // needs the raw socket, and on a TLS listener that socket is already the
    // decrypted stream. Nothing here may read `x-forwarded-*` or the request's
    // origin to decide whether to accept the connection — a proxy that
    // terminates TLS is invisible to the handshake, and the token is the only
    // admission check.
    const upgrade = webServer.registerUpgrade({
      path: WS_PATH,
      auth: 'anonymous',
      handler: (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, (connection) => {
          wss.emit('connection', connection, request)
        })
      },
    })

    heartbeat = setInterval(() => {
      for (const client of clients) {
        if (!client.authed) continue
        if (client.connection.isAlive === false) {
          client.connection.terminate()
          continue
        }
        client.connection.isAlive = false
        client.connection.ping()
      }
    }, PING_INTERVAL_MS)
    heartbeat.unref?.()

    return () => {
      clearInterval(heartbeat)
      heartbeat = null
      cancelAllPicks()
      for (const client of clients) client.connection.close(1001, 'host shutting down')
      clients.clear()
      wss.close()
      health()
      upgrade()
    }
  }

  return {
    attach,
    broadcast,
    requestPick,
    cancelAllPicks,
    stats() {
      return { clients: [...clients].filter((client) => client.authed).length, picks: picks.size }
    },
  }
}

/** @param {any} record */
function toWire(record) {
  if (!record) return record
  const { host: _host, ...wire } = record
  return wire
}

/** @param {unknown} mime */
function imageMediaType(mime) {
  return mime === 'image/jpeg' || mime === 'image/webp' ? mime : 'image/png'
}
