/**
 * Which Session the Web Client is showing.
 *
 * The overlay has to answer "where does this annotation go?" before the user
 * has said anything, and the only honest answer is the conversation they are
 * looking at. The Host cannot see browser focus, but the Client it serves can:
 * every mounted Session dock reports itself here, so the catalog's default and
 * the routing of an untargeted annotation both follow the user's attention.
 *
 * The report is a hint, not authority. It carries the moment it was made, and a
 * hint older than {@link FOCUS_TTL_MS} is discarded rather than resurrected:
 * yesterday's focus is not today's intent.
 *
 * @module dsh-marker/focus
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { FOCUS_PATH } from './protocol.js'

/** How long a focus report stays believable. */
export const FOCUS_TTL_MS = 6 * 60 * 60 * 1_000

/** A focus report carries one id; anything larger is not our Client. */
const MAX_BODY_BYTES = 1_024

/** Session ids are the Client's own strings, but never unbounded ones. */
const MAX_SESSION_ID_CHARS = 200

/**
 * @typedef {object} FocusEntry
 * @property {string} sessionId The Session the Client reported.
 * @property {number} at Unix epoch milliseconds of that report.
 */

/**
 * @param {object} options
 * @param {string} options.dir Directory holding the annotations state.
 * @param {{ warn?: (...args: any[]) => void }} [options.logger]
 * @param {string} [options.file]
 */
export function createFocusStore({ dir, logger, file = 'focus.json' }) {
  const path = join(dir, file)
  /** @type {FocusEntry | null} */
  let entry = null
  /** @type {Promise<void> | null} */
  let writing = null

  async function load() {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      entry = isEntry(parsed) ? parsed : null
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.warn?.(`annotations: focus report unreadable (${messageOf(error)})`)
      entry = null
    }
    return entry
  }

  /** @returns {FocusEntry | null} */
  function get() {
    return entry
  }

  /**
   * Record that the Client is showing one Session.
   * @param {string} sessionId
   * @returns {Promise<FocusEntry>}
   */
  async function set(sessionId) {
    const next = { sessionId: String(sessionId), at: Date.now() }
    entry = next
    // Serialized the same way the queue is: two overlapping renames would
    // interleave and leave one report half-written.
    writing = (writing ?? Promise.resolve()).then(async () => {
      const temporary = `${path}.tmp`
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(temporary, path)
    })
    await writing
    return next
  }

  return { load, get, set, flush: () => writing ?? Promise.resolve(), path }
}

/**
 * The Session a fresh report names, or undefined when there is none.
 * @param {{ get: () => FocusEntry | null } | undefined} store
 * @param {number} [now]
 * @returns {string | undefined}
 */
export function focusedSession(store, now = Date.now()) {
  const entry = store?.get?.()
  if (entry === null || entry === undefined) return undefined
  if (typeof entry.sessionId !== 'string' || entry.sessionId === '') return undefined
  if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) return undefined
  if (now - entry.at > FOCUS_TTL_MS) return undefined
  return entry.sessionId
}

/**
 * Serve the focus report to the page this Host serves.
 *
 * Like the queue, the gate is the browser's own same-origin header: the GUI is
 * the page the Host serves, and a cross-site request cannot claim to be it.
 *
 * @param {any} webServer
 * @param {object} options
 * @param {ReturnType<typeof createFocusStore>} options.store
 * @param {string} [options.path]
 * @returns {() => void} disposer
 */
export function registerFocusRoute(webServer, { store, path = FOCUS_PATH }) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'sec-fetch-site',
  }

  return webServer.register({
    kind: 'exact',
    path,
    auth: 'anonymous',
    handler: (request, response) => {
      /** @param {number} status @param {any} payload */
      const send = (status, payload) => {
        response.writeHead(status, headers)
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(payload))
      }
      if (!sameOrigin(request)) {
        send(403, { ok: false, error: 'origin' })
        return
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        send(200, { ok: true, ...(store.get() ?? {}) })
        return
      }
      if (request.method !== 'POST') {
        send(405, { ok: false, error: 'method' })
        return
      }
      readJson(request)
        .then(async (body) => {
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
          if (sessionId === '' || sessionId.length > MAX_SESSION_ID_CHARS) {
            send(400, { ok: false, error: 'sessionId' })
            return
          }
          const next = await store.set(sessionId)
          send(200, { ok: true, ...next })
        })
        .catch((error) => {
          send(400, { ok: false, error: 'body', message: messageOf(error) })
        })
    },
  })
}

/** @param {unknown} value */
function isEntry(value) {
  if (value === null || typeof value !== 'object') return false
  return typeof value.sessionId === 'string' && value.sessionId !== '' && typeof value.at === 'number'
}

/**
 * The GUI is served by this Host, so the browser marks its own requests
 * `same-origin`. A request without the header is not the page.
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

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
