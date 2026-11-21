/**
 * Session catalog for the overlay's target picker.
 *
 * The picker answers one question — "which conversation does this annotation
 * belong to?" — so the catalog is a flat list ordered by last activity, with
 * the workspace carried as a detail line rather than a grouping level. Every
 * Session the Host knows is a candidate, including ones the browser has never
 * shown; there is no per-Session state here, only reads.
 *
 * The expensive part of that read is the *title*, which is a fold over a
 * Session's whole log. Folding every log on every picker open is what made a
 * local list take seconds, so a title is answered in three tiers: the Session
 * summary's own projection hints (zero I/O, already folded by the Host), then
 * this module's memo, and only then a bounded fold for the rows that will
 * actually be shown.
 *
 * @module dsh-marker/sessions
 */

import { LIMITS, SESSIONS_PATH } from './protocol.js'

/** A bounded fold is a fallback, not a wait: a title never owns the response. */
const TITLE_READ_BUDGET_MS = 1_500

/** Within this window a memoized title is reused without asking again. */
const TITLE_TTL_MS = 5 * 60 * 1_000

/** A failed title read is retried on a later picker open, not on every request. */
const TITLE_RETRY_MS = 30_000

/** Session summaries change on activity; a picker cannot see a sub-second difference. */
const SUMMARY_TTL_MS = 1_000

/** How many rows a warm-up asks for; the extension asks for 50. */
const WARM_LIMIT = 50

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
 * @param {() => number} [options.now] Clock, injected by tests.
 */
export function createSessionCatalog({ get, logger, now = Date.now }) {
  /** @type {Map<string, { at: number, title: string }>} */
  const titles = new Map()
  /** @type {{ at: number, rows: readonly any[] } | null} */
  let listing = null
  /** When the last fold failed, or null while folds are worth trying. */
  let titleFailingAt = null

  /**
   * @param {object} [options]
   * @param {string} [options.query] Case-insensitive substring over title, id, cwd and workspace.
   * @param {number} [options.limit]
   * @param {boolean} [options.includeSubagents] Subagent Sessions are noise for a human picker; opt in to list them.
   * @param {AbortSignal} [options.signal]
   */
  async function list(options = {}) {
    const limit = clamp(options.limit ?? 20, 1, LIMITS.sessionsLimit)
    const signal = options.signal ?? AbortSignal.timeout(8_000)
    const rows = (await readSummaries(signal)).filter(
      (row) => options.includeSubagents === true || row?.origin !== 'subagent',
    )
    const needle = (options.query ?? '').trim().toLowerCase()
    const ordered = [...rows].sort((left, right) => timestampOf(right) - timestampOf(left))

    // A search matches on the title, so it has to know all of them; a plain
    // open only needs the rows it is about to draw.
    await ensureTitles(needle === '' ? ordered.slice(0, limit) : ordered, signal)

    const workspaces = workspaceIndex()
    const items = ordered
      .map((row) => describe(row, titleOf(row), workspaces.get(row.sessionId)))
      .filter((item) => needle === '' || matches(item, needle))

    return {
      items: items.slice(0, limit),
      /** Rows after filtering, before the limit. */
      total: items.length,
      truncated: items.length > limit,
    }
  }

  /**
   * Read the Session summaries, reusing the last read for a moment.
   *
   * The rows carry `running`/`updatedAt`, which move during a turn; a second of
   * staleness is invisible in a picker and keeps two quick opens from scanning
   * the corpus twice.
   *
   * @param {AbortSignal} signal
   * @returns {Promise<readonly any[]>}
   */
  async function readSummaries(signal) {
    const controller = get('sessionController')
    if (controller === undefined) throw new Error('the session controller is not mounted in this profile')
    if (listing !== null && now() - listing.at < SUMMARY_TTL_MS) return listing.rows
    const value = await controller.list({}, signal)
    const rows = Array.isArray(value?.items) ? value.items : []
    listing = { at: now(), rows }
    return rows
  }

  /**
   * Fill this module's title memo for the rows a response will need.
   *
   * A hint is free and authoritative; a fold is bounded and best-effort. A fold
   * failure costs titles, never the catalog.
   *
   * @param {readonly any[]} rows
   * @param {AbortSignal} signal
   */
  async function ensureTitles(rows, signal) {
    if (rows.length === 0) return

    /** @type {any[]} */
    const missing = []
    for (const row of rows) {
      const cached = titles.get(row.sessionId)
      if (cached !== undefined && now() - cached.at < TITLE_TTL_MS) continue
      const hinted = projectionTitle(row)
      if (hinted !== undefined) {
        titles.set(row.sessionId, { at: now(), title: hinted })
        continue
      }
      missing.push(row)
    }
    if (missing.length === 0) return

    const query = get('sessionQuery')
    if (query === undefined) return
    // A failed fold backs off; a hint is not a fold, so the loop above ran first.
    if (titleFailingAt !== null && now() - titleFailingAt < TITLE_RETRY_MS) return

    const ids = missing.map((row) => row.sessionId)
    const budget = AbortSignal.timeout(TITLE_READ_BUDGET_MS)
    try {
      const results = await query.readTitleSnapshots(ids, AbortSignal.any([signal, budget]))
      for (const [index, result] of (Array.isArray(results) ? results : []).entries()) {
        // `{sessionId, status, value: {session, title?: SessionTitleSnapshot}}`;
        // a rejected row carries only a reason and must not drop the others.
        const title = result?.value?.title?.title ?? result?.title
        const id = typeof result?.sessionId === 'string' ? result.sessionId : ids[index]
        if (typeof id !== 'string') continue
        // An untitled Session is an answer too: memoizing the miss is what
        // keeps a corpus full of new conversations from being re-folded.
        titles.set(id, { at: now(), title: typeof title === 'string' ? title : '' })
      }
      titleFailingAt = null
    } catch (error) {
      if (signal.aborted) return
      titleFailingAt = now()
      logger?.warn?.(`annotations: session titles unavailable (${messageOf(error)})`)
    }
  }

  /** @param {any} row */
  function titleOf(row) {
    const cached = titles.get(row.sessionId)
    if (cached === undefined) return ''
    return now() - cached.at < TITLE_TTL_MS ? cached.title : ''
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

  /**
   * Pay the first fold before anyone is looking, so the picker's first open is
   * as fast as every later one. Failures are logged and forgotten: a cold
   * catalog is a slow open, not a broken Host.
   * @returns {Promise<void>}
   */
  function warm() {
    return list({ limit: WARM_LIMIT }).then(
      () => undefined,
      (error) => logger?.warn?.(`annotations: catalog warm-up failed (${messageOf(error)})`),
    )
  }

  return { list, warm }
}

/**
 * A title the Host already folded, when the Session summary carries one.
 *
 * `SessionSummary.projections.values.title` is the title projection's value —
 * a string in the shipped build, a snapshot object in the type. Both are read,
 * because guessing wrong here would silently restore the fold we are removing.
 * @param {any} row
 * @returns {string | undefined}
 */
function projectionTitle(row) {
  const value = row?.projections?.values?.title
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.title === 'string') return value.title
  return undefined
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
 * @param {{ warn?: (...args: any[]) => void }} [options.logger]
 * @param {() => string | undefined} [options.preferred] Session the Client is showing, when it said so
 * @param {() => Promise<any[]>} [options.workspaces] registered workspaces, when a provisioner is mounted
 * @param {string} [options.path]
 * @returns {() => void} disposer
 */
export function registerSessionsRoute(
  webServer,
  { catalog, token, matchesToken, logger, preferred, workspaces, path = SESSIONS_PATH },
) {
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
        .then(async (value) => {
          // The "new session" arm of the picker needs the workspace list on the
          // same open; a failure only loses that arm, never the catalog.
          let rows = []
          if (workspaces !== undefined) {
            try {
              rows = await workspaces()
            } catch (error) {
              logger?.warn?.(`annotations: workspace list unavailable (${messageOf(error)})`)
            }
          }
          send(200, {
            ok: true,
            ...value,
            workspaces: rows,
            defaultSessionId: defaultId(value.items, preferred?.()),
          })
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

/** Accept the token from a bearer header or the dedicated header; the query string never carries credentials (log safety). */
function presentedToken(request) {
  const header = request.headers?.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const custom = request.headers?.['x-anno-token']
  if (typeof custom === 'string' && custom !== '') return custom
  return ''
}

/** @param {any} row @param {string} title @param {{ id: string, title: string, path: string } | undefined} workspace */
function describe(row, title, workspace) {
  return {
    id: row.sessionId,
    title,
    updatedAt: timestampOf(row),
    running: row.running === true,
    blank: row.blank === true,
    agentAvailable: row.agentAvailable === true,
    cwd: typeof row.cwd === 'string' ? row.cwd : null,
    workspace: workspace ?? null,
  }
}

/** @param {any} row */
function timestampOf(row) {
  return typeof row?.updatedAt === 'number' ? row.updatedAt : 0
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
