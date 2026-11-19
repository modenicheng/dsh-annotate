/**
 * Session catalog for the overlay's target picker.
 *
 * The picker answers one question — "which conversation does this annotation
 * belong to?" — so the catalog is a flat list ordered by last activity, with
 * the workspace carried as a detail line rather than a grouping level. Every
 * Session the Host knows is a candidate, including ones the browser has never
 * shown; there is no per-Session state here, only reads.
 *
 * @module dsh-marker/sessions
 */

import { LIMITS, SESSIONS_PATH } from './protocol.js'

/** Session titles are optional: an empty catalog row still lists. */
const TITLE_TIMEOUT_MS = 4_000

/**
 * @typedef {object} SessionCatalogItem
 * @property {string} id Session identity used by the reference mention.
 * @property {string} title Latest log-backed title, or an empty string.
 * @property {number} updatedAt Last activity in Unix epoch milliseconds.
 * @property {boolean} running Whether a turn is in flight right now.
 * @property {boolean} blank Whether the Session has no conversation yet.
 * @property {boolean} agentAvailable Whether a live Agent currently owns it.
 * @property {string | null} cwd Working directory the Host recorded.
 * @property {{ id: string, title: string, path: string } | null} workspace Owning workspace, when one claims the Session.
 */

/**
 * @param {object} options
 * @param {(name: string) => any} options.get Cordis service lookup for the mounting context.
 * @param {{ warn?: (...args: any[]) => void }} [options.logger]
 */
export function createSessionCatalog({ get, logger }) {
  /**
   * @param {object} [options]
   * @param {string} [options.query] Case-insensitive substring over title, id, cwd and workspace.
   * @param {number} [options.limit]
   * @param {boolean} [options.includeSubagents] Subagent Sessions are noise for a human picker; opt in to list them.
   * @param {AbortSignal} [options.signal]
   */
  async function list(options = {}) {
    const controller = get('sessionController')
    if (controller === undefined) throw new Error('the session controller is not mounted in this profile')

    const limit = clamp(options.limit ?? 20, 1, LIMITS.sessionsLimit)
    const signal = options.signal ?? AbortSignal.timeout(8_000)
    const value = await controller.list({}, signal)
    const summaries = (Array.isArray(value?.items) ? value.items : []).filter(
      (row) => options.includeSubagents === true || row?.origin !== 'subagent',
    )

    const titles = await readTitles(
      summaries.map((row) => row.sessionId),
      signal,
    )
    const workspaces = workspaceIndex()
    const needle = (options.query ?? '').trim().toLowerCase()

    const items = summaries
      .map((row) => describe(row, titles.get(row.sessionId), workspaces.get(row.sessionId)))
      .filter((item) => needle === '' || matches(item, needle))
      .sort((left, right) => right.updatedAt - left.updatedAt)

    return {
      items: items.slice(0, limit),
      /** Rows after filtering, before the limit. */
      total: items.length,
      truncated: items.length > limit,
    }
  }

  /**
   * Titles live in a separate fold; a failure here must not hide the catalog.
   * @param {string[]} ids
   * @param {AbortSignal} outer
   * @returns {Promise<Map<string, string>>}
   */
  async function readTitles(ids, outer) {
    const titles = new Map()
    const query = get('sessionQuery')
    if (query === undefined || ids.length === 0) return titles

    const budget = AbortSignal.timeout(TITLE_TIMEOUT_MS)
    try {
      const results = await query.readTitleSnapshots(ids, AbortSignal.any([outer, budget]))
      for (const [index, result] of (Array.isArray(results) ? results : []).entries()) {
        // `{sessionId, status, value: {session, title?: SessionTitleSnapshot}}`;
        // a rejected row carries only a reason and must not drop the others.
        const title = result?.value?.title?.title ?? result?.title
        if (typeof title !== 'string' || title === '') continue
        const id = typeof result?.sessionId === 'string' ? result.sessionId : ids[index]
        if (typeof id === 'string') titles.set(id, title)
      }
    } catch (error) {
      logger?.warn?.(`annotations: session titles unavailable (${messageOf(error)})`)
    }
    return titles
  }

  /** @returns {Map<string, { id: string, title: string, path: string }>} */
  function workspaceIndex() {
    const index = new Map()
    const registry = get('workspaceRegistry')
    if (registry === undefined) return index
    try {
      for (const workspace of registry.list()) {
        const info = { id: workspace.id, title: workspace.title, path: workspace.path }
        for (const sessionId of workspace.sessionIds ?? []) index.set(sessionId, info)
      }
    } catch (error) {
      logger?.warn?.(`annotations: workspace index unavailable (${messageOf(error)})`)
    }
    return index
  }

  return { list }
}

/**
 * Serve the catalog over the Host webserver.
 *
 * The bridge token is the only gate: the overlay runs on an arbitrary http(s)
 * page, so no cookie or Origin assumption can hold.
 *
 * @param {any} webServer
 * @param {object} options
 * @param {ReturnType<typeof createSessionCatalog>} options.catalog
 * @param {string} options.token
 * @param {(presented: unknown, expected: string) => boolean} options.matchesToken
 * @param {() => string | undefined} [options.preferred] Session the Client is showing, when it said so
 * @param {string} [options.path]
 * @returns {() => void} disposer
 */
export function registerSessionsRoute(webServer, { catalog, token, matchesToken, preferred, path = SESSIONS_PATH }) {
  return webServer.register({
    kind: 'exact',
    path,
    auth: 'anonymous',
    handler: (request, response) => {
      const headers = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, x-anno-token',
        'access-control-allow-methods': 'GET, OPTIONS',
      }
      /** @param {number} status */
      const send = (status, payload) => {
        const body = JSON.stringify(payload)
        response.writeHead(status, headers)
        response.end(request.method === 'HEAD' ? undefined : body)
      }

      if (request.method === 'OPTIONS') {
        response.writeHead(204, headers)
        response.end()
        return
      }
      if (!matchesToken(presentedToken(request), token)) {
        send(401, { ok: false, error: 'token' })
        return
      }

      const url = new URL(request.url ?? path, 'http://127.0.0.1')
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
      catalog
        .list({
          query: url.searchParams.get('q') ?? '',
          ...(Number.isFinite(limit) ? { limit } : {}),
          includeSubagents: url.searchParams.get('subagents') === '1',
        })
        .then((value) => {
          send(200, { ok: true, ...value, defaultSessionId: defaultId(value.items, preferred?.()) })
        })
        .catch((error) => {
          send(500, { ok: false, error: 'catalog', message: messageOf(error) })
        })
    },
  })
}

/**
 * The row the picker starts on: the Session the Client is showing while the
 * catalog still lists it, otherwise the most recently active one. A hint that
 * points at a deleted or filtered-out Session is not a choice, so it loses.
 * @param {readonly { id: string }[]} items
 * @param {string | undefined} preferredId
 * @returns {string | null}
 */
export function defaultId(items, preferredId) {
  if (preferredId !== undefined && items.some((item) => item.id === preferredId)) return preferredId
  return items[0]?.id ?? null
}

/** Accept the token from the query string, a bearer header, or the dedicated header. */
function presentedToken(request) {
  const header = request.headers?.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const custom = request.headers?.['x-anno-token']
  if (typeof custom === 'string' && custom !== '') return custom
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('token') ?? ''
  } catch {
    return ''
  }
}

/** @param {any} row @param {string | undefined} title @param {{ id: string, title: string, path: string } | undefined} workspace */
function describe(row, title, workspace) {
  return {
    id: row.sessionId,
    title: typeof title === 'string' ? title : '',
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
    running: row.running === true,
    blank: row.blank === true,
    agentAvailable: row.agentAvailable === true,
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
    workspace: workspace ?? null,
  }
}

/** @param {SessionCatalogItem} item @param {string} needle */
function matches(item, needle) {
  return [item.title, item.id, item.cwd ?? '', item.workspace?.title ?? '', item.workspace?.path ?? ''].some((value) =>
    value.toLowerCase().includes(needle),
  )
}

/** @param {number} value @param {number} low @param {number} high */
function clamp(value, low, high) {
  const number = Number.isFinite(value) ? Math.trunc(value) : low
  return Math.min(Math.max(number, low), high)
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
