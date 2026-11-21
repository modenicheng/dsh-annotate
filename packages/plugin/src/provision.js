/**
 * Online session creation for the overlay's "new session" target.
 *
 * The overlay's picker lists Sessions that already exist; this module is the
 * other arm — "this annotation starts a new conversation" — which only the
 * Host can honour, because only it owns `sessionController.create` and the
 * workspace registry. Three workspace modes:
 *
 *   - `default`  the deployment's first-use Workspace ("默认工作区"), joined by
 *                its fixed title when the registry has it; a bare no-location
 *                create otherwise;
 *   - `existing` one registered workspace by id, the Session joins it;
 *   - `new`      an absolute path (and optional title), registered first — a
 *                missing directory is created here (the registry itself will
 *                not), and an already-registered directory resolves
 *                idempotently.
 *
 * Nothing here is queued. A session that does not exist yet has no outbox
 * entry to replay, so a failure is answered while the composer is still open
 * and the annotation stays unsent in the browser.
 *
 * @module dsh-marker/provision
 */

import { mkdir } from 'node:fs/promises'

import { LIMITS, SESSION_CREATE_PATH, validateSessionCreateRequest } from './protocol.js'

/** The Client picks its workspace rows per open; a second of staleness is invisible. */
const WORKSPACES_TTL_MS = 1_000

/**
 * Fixed first-use Workspace title (DSH's `DEFAULT_WORKSPACE_DIRECTORY`, on the
 * Documents path). Language-neutral by design, so a title comparison is enough.
 */
const DEFAULT_WORKSPACE_TITLE = 'default-workspace'

/**
 * @param {object} options
 * @param {(name: string) => any} options.get Cordis service lookup for the mounting context.
 * @param {{ list: (options?: object) => Promise<{ items?: any[] }> } | undefined} [options.catalog]
 *   Session catalog, when one is mounted; its blank rows are what "reuse the
 *   workspace's blank Session" is answered from.
 * @param {(body: any) => void | Promise<void>} options.onCreated Side effect after one created session (push, focus hints).
 * @param {{ warn?: (...args: any[]) => void, info?: (...args: any[]) => void }} [options.logger]
 * @param {() => number} [options.now] Clock, injected by tests.
 */
export function createProvisioner({ get, catalog, onCreated, logger, now = Date.now }) {
  /** @type {{ at: number, items: any[] } | null} */
  let workspaceCache = null

  /**
   * Every registered workspace, ordered as the registry keeps them (display
   * order). Cached for a moment so the picker's workspaces list and a create
   * that follows in the same gesture do not scan the registry twice.
   * @returns {Promise<any[]>} `{ id, title, path }` rows
   */
  async function listWorkspaces() {
    const registry = get('workspaceRegistry')
    if (registry === undefined) throw new Error('the workspace registry is not mounted in this profile')
    if (workspaceCache !== null && now() - workspaceCache.at < WORKSPACES_TTL_MS) return workspaceCache.items
    const items = []
    try {
      for (const workspace of registry.list()) {
        items.push({ id: workspace.id, title: workspace.title, path: workspace.path })
      }
    } catch (error) {
      throw new Error(`the workspace registry could not be read (${messageOf(error)})`)
    }
    workspaceCache = { at: now(), items }
    return items
  }

  /**
   * Create one Session in the requested workspace mode.
   *
   * @param {any} body validated request: `{ mode, workspaceId?, path?, title? }`
   * @returns {Promise<{ sessionId: string, workspace: { id: string, title: string, path: string } | null }>}
   */
  async function createSession(body) {
    const controller = get('sessionController')
    if (controller === undefined) throw new Error('the session controller is not mounted in this profile')

    let workspace = null
    let request = {}
    if (body.mode === 'existing') {
      workspace = await findByWorkspaceId(String(body.workspaceId))
      if (workspace === null) throw new Error('that workspace no longer exists on this host')
      // `workspaceId` joins the Session to the workspace record; `cwd` is the
      // standalone alternative and the two are exclusive by contract.
      request = await requestFor(workspace)
    } else if (body.mode === 'new') {
      workspace = await registerWorkspace(String(body.path), typeof body.title === 'string' ? body.title : undefined)
      request = await requestFor(workspace)
    } else {
      // `default` is the row the Client labels "默认工作区": the deployment's
      // first-use Workspace, recognised by its fixed title. A Session created
      // without it belongs to no Workspace row and never shows in that group,
      // so join it when the registry has it. A registry that cannot be read
      // (missing, or a failed scan) keeps the bare no-location create: this
      // mode has always worked without one.
      try {
        const items = await listWorkspaces()
        workspace = items.find((item) => item.title === DEFAULT_WORKSPACE_TITLE) ?? null
      } catch {
        workspace = null
      }
      if (workspace !== null) request = await requestFor(workspace)
    }

    const value = await controller.create(request)
    const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : ''
    if (sessionId === '') throw new Error('the host created the session but returned no identity')
    logger?.info?.(`annotations: session ${sessionId} created (mode ${String(body.mode)})`)
    if (onCreated) await onCreated({ sessionId, workspace })
    return { sessionId, workspace }
  }

  /** @param {string} workspaceId */
  async function findByWorkspaceId(workspaceId) {
    const items = await listWorkspaces()
    return items.find((item) => item.id === workspaceId) ?? null
  }

  /**
   * Join the workspace, reusing its blank Session when the catalog can name
   * one: annotations that target "a new conversation here" must append to the
   * same conversation, not mint a sibling per send. The controller owns the
   * final say — it re-checks that the named Session is still blank and still a
   * workspace member before reusing it, so a stale answer here can only cost a
   * fresh Session, never a wrong reuse.
   * @param {{ id: string, title: string, path: string }} workspace
   */
  async function requestFor(workspace) {
    const blank = await findBlankIn(workspace)
    return { workspaceId: workspace.id, ...(blank === undefined ? {} : { sessionId: blank }) }
  }

  /**
   * The workspace's most recently active blank Session, when the catalog can
   * name one. A failed lookup is a warning, not a failed create.
   * @param {{ id: string, title: string, path: string }} workspace
   * @returns {Promise<string | undefined>}
   */
  async function findBlankIn(workspace) {
    if (catalog === undefined) return undefined
    try {
      const value = await catalog.list({ query: workspace.title, limit: 50 })
      const rows = Array.isArray(value?.items) ? value.items : []
      let best = null
      for (const row of rows) {
        if (row?.workspace?.id !== workspace.id || row.blank !== true) continue
        if (best === null || Number(row.updatedAt ?? 0) > Number(best.updatedAt ?? 0)) best = row
      }
      return best !== null && typeof best.id === 'string' ? best.id : undefined
    } catch (error) {
      logger?.warn?.(`annotations: blank session lookup failed (${messageOf(error)})`)
      return undefined
    }
  }

  /**
   * Register (or idempotently resolve) one workspace over an absolute path.
   *
   * The registry canonicalises through `realpath` and does not create the
   * directory (verified against DSH 0.2.2), while the browser half cannot make
   * one at all — so a missing directory is made here and the registration
   * retried once before the failure is reported.
   * @param {string} path
   * @param {string | undefined} title
   */
  async function registerWorkspace(path, title) {
    const registry = get('workspaceRegistry')
    if (registry === undefined) throw new Error('the workspace registry is not mounted in this profile')
    try {
      return await register(registry, path, title)
    } catch (error) {
      const message = messageOf(error)
      if (!/ENOENT/.test(message)) throw new Error(`the workspace could not be created (${message})`)
      try {
        await mkdir(path, { recursive: true })
      } catch (madeError) {
        throw new Error(`the workspace directory could not be created (${messageOf(madeError)})`)
      }
      try {
        return await register(registry, path, title)
      } catch (again) {
        throw new Error(`the workspace could not be created (${messageOf(again)})`)
      }
    }
  }

  /**
   * One registration attempt, bare: the ENOENT test in {@link registerWorkspace}
   * must see the registry's own error, not this module's wrapping of it.
   * @param {any} registry
   * @param {string} path
   * @param {string | undefined} title
   */
  async function register(registry, path, title) {
    const workspace = await registry.create(path, title)
    workspaceCache = null
    return { id: workspace.id, title: workspace.title, path: workspace.path }
  }

  return { listWorkspaces, createSession }
}

/**
 * Serve session creation on the Host webserver.
 *
 * The bridge token is the only gate, exactly like the catalog: the overlay
 * runs on an arbitrary http(s) page, so no cookie or Origin assumption can
 * hold. POST only; the body is bounded far below anything the parser cares
 * about, and validation happens before any Host service is touched.
 *
 * @param {any} webServer
 * @param {object} options
 * @param {ReturnType<typeof createProvisioner>} options.provisioner
 * @param {string} options.token
 * @param {(presented: unknown, expected: string) => boolean} options.matchesToken
 * @param {string} [options.path]
 * @returns {() => void} disposer
 */
export function registerProvisionRoutes(webServer, { provisioner, token, matchesToken, path = SESSION_CREATE_PATH }) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-anno-token',
    'access-control-allow-methods': 'POST, OPTIONS',
  }
  /** @param {number} status @param {any} payload @param {any} request @param {any} response */
  const send = (status, payload, request, response) => {
    const body = JSON.stringify(payload)
    response.writeHead(status, headers)
    response.end(request.method === 'HEAD' ? undefined : body)
  }

  return webServer.register({
    kind: 'exact',
    path,
    auth: 'anonymous',
    handler: (request, response) => {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, headers)
        response.end()
        return
      }
      if (request.method !== 'POST' && request.method !== 'HEAD') {
        send(405, { ok: false, error: 'method' }, request, response)
        return
      }
      if (!matchesToken(presentedToken(request), token)) {
        send(401, { ok: false, error: 'token' }, request, response)
        return
      }
      if (request.method === 'HEAD') {
        send(200, { ok: true }, request, response)
        return
      }

      readJson(request)
        .then(async (body) => {
          const errors = validateSessionCreateRequest(body)
          if (errors.length > 0) {
            send(400, { ok: false, error: 'request', message: errors.join('; ') }, request, response)
            return
          }
          const value = await provisioner.createSession(body)
          send(200, { ok: true, ...value }, request, response)
        })
        .catch((error) => {
          // A Host service refusing the operation is the expected failure
          // (missing registry, unusable path); answer it, do not log it twice.
          send(500, { ok: false, error: 'create', message: messageOf(error) }, request, response)
        })
    },
  })
}

/** Accept the token from a bearer header or the dedicated header; the query string never carries credentials (log safety). */
function presentedToken(request) {
  const header = request.headers?.authorization
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const custom = request.headers?.['x-anno-token']
  if (typeof custom === 'string' && custom !== '') return custom
  return ''
}

/** @param {any} request */
function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > LIMITS.createBodyChars) {
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
