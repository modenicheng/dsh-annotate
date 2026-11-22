/**
 * Host-side directory browsing for the workspace picker's 新建工作区 mode
 * (M4.7b, D26).
 *
 * The browser cannot choose a host path by itself and the registry only knows
 * directories that are already workspaces, so this module answers one level
 * of the host's real tree: directories only, symlinks skipped, bounded. An
 * extension that finds the route browses; one that does not falls back to
 * its anchors — the route is additive and never negotiated.
 *
 * @module dsh-marker/dirs
 */

import { readdir as fsReaddir, stat as fsStat } from 'node:fs/promises'
import { homedir } from 'node:os'

import { DIRS_PATH, LIMITS, validateDirsPath } from './protocol.js'

/** Probed for the roots answer on Windows; every other platform answers ['/']. */
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * @param {object} [options]
 * @param {typeof fsReaddir} [options.readdir] injected so tests stay deterministic
 * @param {typeof fsStat} [options.stat] injected so tests stay deterministic
 * @param {() => string} [options.homedir]
 * @param {string} [options.platform] `process.platform` outside tests
 */
export function createDirBrowser({
  readdir = fsReaddir,
  stat = fsStat,
  homedir: homeOf = homedir,
  platform = process.platform,
} = {}) {
  const windows = platform === 'win32'

  /**
   * Answer one request: the roots view for an empty path, otherwise one
   * level of directories under it.
   * @param {string} path
   */
  async function list(path) {
    if (path === '') return rootsAnswer()
    const rows = await readdir(path, { withFileTypes: true })
    /** @type {{ name: string, path: string }[]} */
    const entries = []
    for (const row of rows) {
      // Files never travel: the picker chooses a directory, and file names
      // are a disclosure it has no use for. A symlink is skipped rather than
      // resolved for the same reason — the answer stays one real level.
      if (row.isDirectory() !== true || row.isSymbolicLink() === true) continue
      entries.push({ name: row.name, path: joinPath(path, row.name) })
    }
    entries.sort((left, right) => compare(left.name, right.name))
    return {
      path,
      parent: parentOf(path),
      entries: entries.slice(0, LIMITS.fsEntries),
      truncated: entries.length > LIMITS.fsEntries,
    }
  }

  /** The view one Up affordance lands on: the home directory plus the roots. */
  async function rootsAnswer() {
    let home = ''
    try {
      home = homeOf() ?? ''
    } catch {
      home = ''
    }
    return { roots: windows ? await driveRoots() : ['/'], home }
  }

  async function driveRoots() {
    const roots = []
    for (const letter of DRIVE_LETTERS) {
      const root = `${letter}:\\`
      try {
        const value = await stat(root)
        if (value.isDirectory() === true) roots.push(root)
      } catch {
        // A letter that is not there is not an error; it is just absent.
      }
    }
    return roots
  }

  return { list }
}

/**
 * Case-insensitive, tie-broken by the raw name, so the order never depends on
 * the host locale.
 * @param {string} left
 * @param {string} right
 */
function compare(left, right) {
  const first = left.toLowerCase()
  const second = right.toLowerCase()
  if (first < second) return -1
  if (first > second) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Join one segment onto a directory with the separator the directory itself
 * uses, so a Windows host answers Windows paths and a POSIX host POSIX ones.
 * @param {string} base
 * @param {string} name
 */
function joinPath(base, name) {
  const windows = base.includes('\\') || /^[A-Za-z]:/.test(base)
  const separator = windows ? '\\' : '/'
  const trimmed = base.replace(/[\\/]+$/, '')
  if (trimmed === '') return `${separator}${name}`
  return `${trimmed}${separator}${name}`
}

/** One step up; `''` at the top means the roots view. */
function parentOf(path) {
  const trimmed = path.replace(/[\\/]+$/, '')
  if (trimmed === '') return ''
  if (/^[A-Za-z]:$/.test(trimmed)) return ''
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (cut <= 0) return cut === 0 ? '/' : ''
  const parent = trimmed.slice(0, cut)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
}

/**
 * Serve the directory browser on the Host webserver.
 *
 * The bridge token is the only gate, exactly like the catalog and the create
 * route: the overlay runs on an arbitrary http(s) page, so no cookie or
 * Origin assumption can hold. GET only; the path rides in the query string —
 * it names a directory, never a credential (log safety is about the token).
 *
 * @param {any} webServer
 * @param {object} options
 * @param {ReturnType<typeof createDirBrowser>} options.browser
 * @param {string} options.token
 * @param {(presented: unknown, expected: string) => boolean} options.matchesToken
 * @param {string} [options.path]
 * @returns {() => void} disposer
 */
export function registerDirsRoute(webServer, { browser, token, matchesToken, path = DIRS_PATH }) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-anno-token',
    'access-control-allow-methods': 'GET, OPTIONS',
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
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        send(405, { ok: false, error: 'method' }, request, response)
        return
      }
      if (!matchesToken(presentedToken(request), token)) {
        send(401, { ok: false, error: 'token' }, request, response)
        return
      }
      const url = new URL(request.url ?? path, 'http://127.0.0.1')
      const wanted = url.searchParams.get('path') ?? ''
      const errors = validateDirsPath(wanted)
      if (errors.length > 0) {
        send(400, { ok: false, error: 'request', message: errors.join('; ') }, request, response)
        return
      }
      browser
        .list(wanted)
        .then((value) => send(200, { ok: true, ...value }, request, response))
        .catch((error) => {
          // A directory that vanished or refuses reading is a picker state,
          // not a host failure; anything else is reported like the catalog does.
          const code = typeof error?.code === 'string' ? error.code : ''
          const status =
            code === 'ENOENT' || code === 'ENOTDIR' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 500
          send(status, { ok: false, error: 'dirs', message: messageOf(error) }, request, response)
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

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
