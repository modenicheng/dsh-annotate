/**
 * Pending mention deliveries.
 *
 * An annotation carries `routing.sessionId` when the user picked a target in
 * the overlay. The Host cannot write that Session's composer — drafts live in
 * the browser — so the delivery is queued here, durably, and the Web Client
 * appends it the next time that Session is open. Nothing is sent, no turn is
 * started: the user decides when the message leaves.
 *
 * @module dsh-marker/queue
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { QUEUE_ACK_PATH, QUEUE_PATH } from './protocol.js'

/** A queue is a hand-off, not a backlog: an unsent pile helps nobody. */
const MAX_ENTRIES = 50

/** Acknowledged ids are the whole request; anything larger is not our client. */
const MAX_BODY_BYTES = 4_096

/**
 * @typedef {object} QueuedMention
 * @property {string} id Annotation id, also the entry identity.
 * @property {string} sessionId Target Session.
 * @property {string} mention Canonical mention text to append to the draft.
 * @property {string} label Chip label the mention carries.
 * @property {number} createdAt Unix epoch milliseconds.
 */

/**
 * @param {object} options
 * @param {string} options.dir Directory holding the annotations log.
 * @param {{ warn?: (...args: any[]) => void }} [options.logger]
 * @param {string} [options.file]
 */
export function createMentionQueue({ dir, logger, file = 'pending-mentions.json' }) {
  const path = join(dir, file)
  /** @type {QueuedMention[]} */
  let entries = []
  let writing = null

  async function load() {
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = JSON.parse(raw)
      entries = (Array.isArray(parsed) ? parsed : []).filter(isEntry).slice(-MAX_ENTRIES)
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.warn?.(`annotations: pending queue unreadable (${messageOf(error)})`)
      entries = []
    }
    return entries.length
  }

  /**
   * Queue one delivery. Re-enqueuing an id replaces its entry, so a replayed
   * offline submission cannot pile up duplicates.
   * @param {{ id: string, sessionId: string, mention: string, label?: string }} input
   * @returns {Promise<void>}
   */
  async function enqueue(input) {
    if (!isUsable({ ...input, createdAt: Date.now() })) return
    const entry = {
      id: String(input.id),
      sessionId: String(input.sessionId),
      mention: String(input.mention),
      label: typeof input.label === 'string' ? input.label : '',
      createdAt: Date.now(),
    }
    entries = entries.filter((item) => item.id !== entry.id)
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
    await save()
  }

  /**
   * Entries waiting for one Session, oldest first.
   * @param {string} sessionId
   * @returns {QueuedMention[]}
   */
  function list(sessionId) {
    return entries.filter((entry) => entry.sessionId === sessionId)
  }

  /** @returns {QueuedMention[]} */
  function all() {
    return [...entries]
  }

  /**
   * Drop acknowledged entries.
   * @param {readonly string[]} ids
   * @returns {Promise<number>} how many were actually queued
   */
  async function ack(ids) {
    const wanted = new Set(ids.map(String))
    const before = entries.length
    entries = entries.filter((entry) => !wanted.has(entry.id))
    const removed = before - entries.length
    if (removed > 0) await save()
    return removed
  }

  /** Drop entries whose annotation no longer exists, without a client round trip. */
  async function prune(exists) {
    const before = entries.length
    entries = entries.filter((entry) => exists(entry.id))
    if (before !== entries.length) await save()
    return before - entries.length
  }

  function save() {
    // Serialize writes: two overlapping renames would interleave.
    writing = (writing ?? Promise.resolve()).then(async () => {
      const temp = `${path}.tmp`
      await writeFile(temp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
      await rename(temp, path)
    })
    return writing
  }

  return { load, enqueue, list, all, ack, prune, flush: () => writing ?? Promise.resolve(), path }
}

/**
 * Serve the queue to the Web Client that owns the target composers.
 *
 * The bridge token cannot gate this: the page is a different trust anchor from
 * the extension, and handing it the extension's token would be worse than the
 * route. What gates it is the browser's own same-origin header — the Client is
 * the page this Host serves, and a cross-site request cannot claim otherwise.
 *
 * @param {any} webServer
 * @param {object} options
 * @param {ReturnType<typeof createMentionQueue>} options.queue
 * @param {string} [options.path]
 * @param {string} [options.ackPath]
 * @returns {() => void} disposer
 */
export function registerQueueRoutes(webServer, { queue, path = QUEUE_PATH, ackPath = QUEUE_ACK_PATH }) {
  const baseHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'sec-fetch-site',
  }

  const disposeRead = webServer.register({
    kind: 'exact',
    path,
    auth: 'anonymous',
    handler: (request, response) => {
      /** @param {number} status @param {any} payload */
      const send = (status, payload) => {
        response.writeHead(status, baseHeaders)
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(payload))
      }
      if (!sameOrigin(request)) {
        send(403, { ok: false, error: 'origin' })
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        send(405, { ok: false, error: 'method' })
        return
      }
      const url = new URL(request.url ?? path, 'http://127.0.0.1')
      const sessionId = url.searchParams.get('session') ?? ''
      if (sessionId === '') {
        send(400, { ok: false, error: 'session' })
        return
      }
      send(200, { ok: true, items: queue.list(sessionId).map(toWire) })
    },
  })

  const disposeAck = webServer.register({
    kind: 'exact',
    path: ackPath,
    auth: 'anonymous',
    handler: (request, response) => {
      /** @param {number} status @param {any} payload */
      const send = (status, payload) => {
        response.writeHead(status, baseHeaders)
        response.end(JSON.stringify(payload))
      }
      if (!sameOrigin(request)) {
        send(403, { ok: false, error: 'origin' })
        return
      }
      if (request.method !== 'POST') {
        send(405, { ok: false, error: 'method' })
        return
      }
      readJson(request)
        .then(async (body) => {
          const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string') : []
          if (ids.length === 0) {
            send(400, { ok: false, error: 'ids' })
            return
          }
          send(200, { ok: true, removed: await queue.ack(ids) })
        })
        .catch((error) => {
          send(400, { ok: false, error: 'body', message: messageOf(error) })
        })
    },
  })

  return () => {
    disposeRead()
    disposeAck()
  }
}

/**
 * The GUI is served by this Host, so the browser marks its own requests
 * `same-origin`. A request without the header is not the page (and a page that
 * omits it cannot use this route at all — an honest 403 beats a guess).
 * @param {any} request
 */
function sameOrigin(request) {
  return request.headers?.['sec-fetch-site'] === 'same-origin'
}

/** @param {any} request */
function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

/** @param {QueuedMention} entry */
function toWire(entry) {
  return { id: entry.id, mention: entry.mention, label: entry.label, createdAt: entry.createdAt }
}

/** @param {unknown} value */
function isEntry(value) {
  return isUsable(value) && typeof value.label === 'string' && typeof value.createdAt === 'number'
}

/** @param {any} value */
function isUsable(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    value.id !== '' &&
    typeof value.sessionId === 'string' &&
    value.sessionId !== '' &&
    typeof value.mention === 'string' &&
    value.mention !== ''
  )
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
