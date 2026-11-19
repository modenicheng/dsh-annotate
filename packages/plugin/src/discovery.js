/**
 * Publishing where this host is.
 *
 * A host whose port the launcher chose (`dsh --port 0`, DSH Desktop) cannot be
 * found at a fixed address, so it says where it is in two places: a locator on
 * a stable loopback port (see `locator.js`), and a record file under
 * `$DSH_HOME` for a human, a script, or the popup's file import.
 *
 * Both answer *where*, never *whether*. The bridge token has exactly one home,
 * `$DSH_HOME/ext-bridge-token`, and nothing here reads or copies it: an origin
 * is already visible to any local process through `netstat`, while the token is
 * the only admission check, so a second copy of it in JSON would be pure
 * liability.
 *
 * The record is a snapshot, never authority. Whatever it says is verified
 * against `/ext/anno/health` and the `hello` handshake before it is trusted,
 * which is what lets a stale file be harmless.
 *
 * @module dsh-annotate/discovery
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { dshHome } from './paths.js'
import { DISCOVERY_APP, ENDPOINT_FILE, PROTOCOL_VERSION, WS_PATH, isInstanceId } from './protocol.js'

/**
 * The port a stock `dsh web` binds, and the one the extension already assumes.
 *
 * The locator's trigger is this number, deliberately, and not "is this the
 * Desktop app": Desktop is only one way to land on another port, and a product
 * marker would be an undocumented dependency that breaks silently the day the
 * launcher changes.
 */
export const DEFAULT_WEB_PORT = 3080

/** A canonical dotted-decimal octet: no leading zero, no sign, no padding. */
const OCTET = /^(?:0|[1-9]\d{0,2})$/

/** IPv4 and IPv6 disagree about what an address is, so only one is accepted. */
const MAX_PORT = 65_535

/**
 * Whether a bind address is an IPv4 loopback literal, `127.0.0.1` through
 * `127.255.255.255`.
 *
 * The locator binds IPv4 loopback only, because that is what the extension's
 * host permissions cover and what a DNS-rebinding page cannot claim. `localhost`
 * is refused rather than resolved: on a dual-stack Linux box it may become
 * `::1`, and comparing strings is the only check that cannot disagree with what
 * the browser will later do.
 * @param {unknown} host
 * @returns {boolean}
 */
export function isIpv4Loopback(host) {
  if (typeof host !== 'string') return false
  const parts = host.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  // Leading zeros are refused as well: `0177.0.0.1` is octal to some resolvers,
  // and an OS never hands us a padded address to begin with.
  return parts.slice(1).every((part) => OCTET.test(part) && Number(part) <= 255)
}

/**
 * Whether this host needs a locator.
 *
 * The trigger is the bound port, not the product (§9): a stock `dsh web` on
 * {@link DEFAULT_WEB_PORT} is findable without one, and every other port — a
 * launcher's choice, `--port 0`, an edited profile — is the same problem. A
 * non-loopback bind gets no locator either, because the extension has no
 * permission for those origins; the record and a manual address remain, which
 * is why the record is written in every case.
 * @param {{ port?: number, host?: string, mode?: 'auto' | 'off' }} [input]
 * @returns {boolean}
 */
export function shouldLocate({ port, host, mode = 'auto' } = {}) {
  if (mode === 'off') return false
  // `0` means "the OS picked one" and is what the launcher passed, not what the
  // listener bound; the caller reads `webServer.port` after `listen` resolved.
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > MAX_PORT) return false
  if (port === DEFAULT_WEB_PORT) return false
  return isIpv4Loopback(host)
}

/**
 * @typedef {object} AtomicWriteOptions
 * @property {number} [mode] Permission bits for the new file; `0600` by default.
 * @property {{ warn?: Function, debug?: Function }} [logger]
 * @property {Function} [rename] Injected `rename(from, to)`, so tests can fail it.
 * @property {Function} [writeFile] Injected `writeFile(path, text, options)`.
 */

/**
 * Put text in a file so a reader never sees it half-written.
 *
 * The temp file lives beside the target, so the rename stays on one filesystem
 * and is atomic there; `0600` is chosen at creation, which is the only moment
 * the permission can be set without a window in which the content is readable
 * by others.
 *
 * Windows refuses to replace a file another handle holds open (`EPERM`), and
 * that is usually transient — a virus scanner, an editor, the user's own `type`
 * command. One retry covers the common case; a persistent failure falls back to
 * writing the target in place, which is still correct content, just not atomic,
 * and is reported as `false` so the caller can say so.
 * @param {string} target file to replace
 * @param {string} text exact bytes to write
 * @param {AtomicWriteOptions} [options]
 * @returns {Promise<boolean>} true only when a rename put the text in place.
 */
export async function writeJsonAtomically(target, text, options = {}) {
  const mode = options.mode ?? 0o600
  const renameFile = options.rename ?? rename
  const writeText = options.writeFile ?? writeFile
  const temporary = `${target}.${process.pid}.tmp`
  /** @param {string} reason */
  const warn = (reason) => options.logger?.warn?.(`annotations: ${reason}`)

  try {
    await writeText(temporary, text, { mode })
  } catch (error) {
    // Nothing was replaced: the target still carries the previous, valid record,
    // which is the better failure than a truncated file.
    warn(`endpoint record not written (${messageOf(error)})`)
    return false
  }

  let failure = await attemptRename(renameFile, temporary, target)
  if (failure !== null && isRetryableRename(failure)) failure = await attemptRename(renameFile, temporary, target)
  if (failure === null) {
    await chmodQuietly(target, mode)
    return true
  }

  try {
    await writeText(target, text, { mode })
    await unlinkQuietly(temporary)
    await chmodQuietly(target, mode)
    warn(`endpoint record replaced in place after a failed rename (${messageOf(failure)})`)
    return false
  } catch (error) {
    await unlinkQuietly(temporary)
    warn(`endpoint record not written (${messageOf(failure)}; in-place write failed: ${messageOf(error)})`)
    return false
  }
}

/**
 * @param {Function} renameFile
 * @param {string} from
 * @param {string} to
 * @returns {Promise<Error | null>} the failure, or null when the rename landed.
 */
async function attemptRename(renameFile, from, to) {
  try {
    await renameFile(from, to)
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * The codes Node reports when another handle owns the destination. Anything
 * else — a missing directory, a full disk — will not clear by waiting, so it
 * falls straight through to the in-place write.
 * @param {Error} error
 * @returns {boolean}
 */
function isRetryableRename(error) {
  const code = /** @type {any} */ (error).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

/** @param {string} file @param {number} mode */
async function chmodQuietly(file, mode) {
  try {
    await chmod(file, mode)
  } catch {
    // Windows has no POSIX modes to set; the file inherits the profile's ACL,
    // which is the same treatment the token file gets.
  }
}

/** @param {string} file */
async function unlinkQuietly(file) {
  try {
    await unlink(file)
  } catch {
    // Already gone, or the rename consumed it: nothing to clean up either way.
  }
}

/**
 * @typedef {object} DiscoveryRecord
 * @property {number} version `PROTOCOL_VERSION` of the running host.
 * @property {string} app The discriminator; a record naming anything else is ignored.
 * @property {string} instanceId 16 lowercase hex, fresh per process.
 * @property {number} pid The process that wrote the record.
 * @property {string | null} profile Display hint, or null when the host has none.
 * @property {string | null} origin The bound origin, e.g. `http://127.0.0.1:51234`.
 * @property {string | null} wsUrl The same authority with the bridge path.
 * @property {string} startedAt ISO timestamp of this process's start.
 */

/**
 * @typedef {object} LocatorCard
 * @property {string} app
 * @property {number} version
 * @property {string} instanceId
 * @property {string | null} origin
 * @property {string | null} wsUrl
 * @property {string} startedAt
 * @property {string | null} focusAt Latest Client focus report, or null.
 * @property {string | null} profile
 */

/**
 * @typedef {object} PublishedEndpoint
 * @property {string | null} origin
 * @property {string | null} wsUrl
 */

/**
 * Create this process's published view of where it is.
 *
 * The origin is resolved once, at construction: the caller builds this from the
 * inject callback that runs after `listen` resolved, so a host with no address
 * at that moment will never have one for this process, and reading it lazily
 * would only turn a construction-time bug into a `null` written to disk.
 * `focusAt` is the opposite case and is read on every {@link LocatorCard}
 * request, because the user changes Sessions while the host runs.
 *
 * Nothing here throws. Discovery is an optimisation for the client, so a
 * filesystem failure is a warning and a `false`, never something that could
 * take the host down.
 * @param {object} options
 * @param {any} options.webServer the DSH webserver service (`getOrigin()`, `.port`).
 * @param {{ get: () => ({ sessionId: string, at: number } | null) } | undefined} [options.focus]
 * @param {string} [options.home] defaults to `dshHome()`.
 * @param {string | null} [options.profile]
 * @param {{ warn?: Function, info?: Function, debug?: Function }} [options.logger]
 * @param {string} [options.instanceId] test injection; default: 16 random hex.
 * @param {number} [options.pid] test injection; default: `process.pid`.
 * @param {() => Date} [options.now] test injection.
 */
export function createDiscovery({ webServer, focus, home = dshHome(), profile, logger, instanceId, pid, now } = {}) {
  const recordPath = join(home, ENDPOINT_FILE)
  const processId = typeof pid === 'number' && Number.isInteger(pid) ? pid : process.pid
  // A malformed id would never match itself in `remove()` and would be dropped
  // by the extension's `isInstanceId` check, so an injected one is validated
  // rather than trusted.
  const id = isInstanceId(instanceId) ? instanceId : randomBytes(8).toString('hex')
  const startedAt = startStamp(now)
  const profileName = typeof profile === 'string' && profile !== '' ? profile : null
  const endpoint = resolveEndpoint(webServer)

  /**
   * The latest known focus, as an ISO timestamp.
   * @returns {string | null}
   */
  function focusAt() {
    try {
      const entry = focus?.get?.()
      return isoOf(entry?.at)
    } catch {
      // A store that cannot answer is "no focus", not a failed request: the
      // locator must still return an origin when focus reporting is broken.
      return null
    }
  }

  /** @returns {LocatorCard | null} */
  function card() {
    if (endpoint.origin === null) return null
    return {
      app: DISCOVERY_APP,
      version: PROTOCOL_VERSION,
      instanceId: id,
      origin: endpoint.origin,
      wsUrl: endpoint.wsUrl,
      startedAt,
      focusAt: focusAt(),
      profile: profileName,
    }
  }

  /** @returns {DiscoveryRecord | null} */
  function record() {
    if (endpoint.origin === null) return null
    // Key order is part of the file's appearance in the docs, and this JSON is
    // the thing a human reads in a support session.
    return {
      version: PROTOCOL_VERSION,
      app: DISCOVERY_APP,
      instanceId: id,
      pid: processId,
      profile: profileName,
      origin: endpoint.origin,
      wsUrl: endpoint.wsUrl,
      startedAt,
    }
  }

  /** @returns {Promise<boolean>} */
  async function write() {
    const body = record()
    if (body === null) {
      logger?.warn?.('annotations: endpoint record skipped — the webserver has no origin to publish')
      return false
    }
    try {
      await mkdir(home, { recursive: true })
      return await writeJsonAtomically(recordPath, `${JSON.stringify(body, null, 2)}\n`, { logger })
    } catch (error) {
      // A read-only or otherwise unusable home is not a failure of the host:
      // the locator still answers, so discovery degrades to "no file".
      logger?.warn?.(`annotations: endpoint record not written (${messageOf(error)})`)
      return false
    }
  }

  /** @returns {Promise<void>} */
  async function remove() {
    try {
      const parsed = JSON.parse(await readFile(recordPath, 'utf8'))
      if (parsed?.instanceId !== id) {
        // Two profiles share `$DSH_HOME`; the last writer owns the file, and an
        // older instance shutting down must not delete a newer one's record.
        logger?.debug?.('annotations: endpoint record belongs to another instance; left in place')
        return
      }
      await unlink(recordPath)
    } catch {
      // Missing, unreadable, or torn: there is nothing this process may safely
      // remove, and shutdown must not fail over a stale hint.
    }
  }

  /** @returns {Promise<void>} */
  async function dispose() {
    await remove()
  }

  return {
    instanceId: id,
    startedAt,
    profile: profileName,
    pid: processId,
    path: recordPath,
    origin: endpoint.origin,
    wsUrl: endpoint.wsUrl,
    card,
    record,
    write,
    remove,
    dispose,
  }
}

/**
 * @param {() => Date} now
 * @returns {string} an ISO timestamp, from the injected clock when it yields one.
 */
function startStamp(now) {
  try {
    const value = new Date(now())
    if (Number.isFinite(value.getTime())) return value.toISOString()
  } catch {
    // A clock that throws is still a host worth publishing; fall back to now.
  }
  return new Date().toISOString()
}

/**
 * @param {unknown} value
 * @returns {string | null} an ISO timestamp for a finite epoch-millisecond value.
 */
function isoOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value)
  // A finite number can still be outside the range `toISOString` accepts.
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/**
 * The address this host is bound to, or a pair of nulls when it is not bound.
 * @param {any} webServer
 * @returns {PublishedEndpoint}
 */
function resolveEndpoint(webServer) {
  let origin
  try {
    origin = typeof webServer?.getOrigin === 'function' ? webServer.getOrigin() : undefined
  } catch {
    // Before `listen` resolves, `getOrigin()` throws instead of returning a
    // half-built URL; "not bound yet" is the honest reading of that.
    return { origin: null, wsUrl: null }
  }
  if (typeof origin !== 'string' || origin === '') return { origin: null, wsUrl: null }
  return { origin, wsUrl: websocketUrl(origin) }
}

/**
 * The websocket URL for an HTTP origin.
 *
 * The scheme is carried over rather than forced: a TLS listener, or a proxy
 * advertising `https`, must publish `wss`, or the extension's first upgrade is
 * refused. The authority is kept verbatim so an unusual port survives.
 * @param {string} origin
 * @returns {string | null}
 */
function websocketUrl(origin) {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}${WS_PATH}`
  } catch {
    return null
  }
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
