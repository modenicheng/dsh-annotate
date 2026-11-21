/**
 * Where is the host now, and which of several hosts should win?
 *
 * The bridge asks two different questions, and three artifacts answer them in
 * deliberately separate ways:
 *
 *   - "where is the host?" — the locator on a fixed loopback port answers with
 *     an origin; the endpoint record answers the same question for the manual
 *     path, where the user picks the file, and for scripts;
 *   - "which host may I talk to, and how?" — `/ext/anno/health` announces the
 *     scheme and the host's `instanceId`, and the token in `hello` decides
 *     admission. This module never holds or forwards the token.
 *
 * This is the pure core between them: it validates locator answers and imported
 * records, remembers one address across event-page restarts, ranks the hosts a
 * round found, and runs that round. Nothing here touches the network, storage,
 * or `browser.*`; `collectHosts` takes an injected `request`, which is what
 * keeps the whole module testable in `node:vm` with no browser and no fake
 * clock. The caller owns the retry policy, the health probe, and the choice to
 * add the default-port candidate that has no locator to answer for it.
 *
 * Classic script: the background event page and the popup are loaded without a
 * module loader, so this publishes `ns.discovery` on the shared namespace. It
 * must load after `src/shared/protocol.global.js` and works in either context.
 */
;(() => {
  const ns = globalThis.__DSH_ANNO_BG__ ?? (globalThis.__DSH_ANNO_BG__ = {})
  const PROTOCOL = globalThis.__DSH_PROTOCOL__
  if (PROTOCOL === undefined) {
    console.error('dsh-marker: src/shared/protocol.global.js must load before src/background/discovery.js')
    return
  }

  /**
   * How long a remembered address is tried before a fresh round replaces it.
   * Long enough to cover an afternoon of event-page restarts, short enough that
   * a host that moved overnight is found without the user clearing storage.
   */
  const LAST_GOOD_TTL_MS = 12 * 60 * 60 * 1_000

  /**
   * How far into the future a remembered timestamp may sit and still count.
   * `at` comes from the same clock that read it, so a future value means a
   * clock rollback or a hand-edited record; without this tolerance such a
   * record would stay valid until real time catches up with the bogus stamp.
   */
  const LAST_GOOD_FUTURE_TOLERANCE_MS = 5 * 60_000

  /**
   * A focus report older than this stops counting for ranking: a host left on a
   * Session yesterday must not outrank the one the user is actually using.
   */
  const FOCUS_TTL_MS = 6 * 60 * 60 * 1_000

  /**
   * `dsh web`'s default port, and the only address auto mode may assume without
   * asking. Deliberately duplicated from `endpoints.DEFAULT_PORT` so this file
   * has no load-order dependency on `endpoints.js`.
   */
  const DEFAULT_PORT = 3080

  /** A locator round without an explicit budget still has to end. */
  const DEFAULT_TIMEOUT_MS = 700

  /** Locator ports, in the order the host tries to bind them. */
  const LOCATE_PORTS = Array.isArray(PROTOCOL.LOCATE_PORTS) ? PROTOCOL.LOCATE_PORTS : []

  /**
   * `http(s)://127.0.0.1:<port>`: loopback, an explicit port, and nothing else.
   * Hand-rolled rather than `new URL` because the URL parser hides a scheme's
   * default port (`http://127.0.0.1:80` serializes without `:80`), and the port
   * is exactly what has to be compared and returned here.
   */
  const ORIGIN_PATTERN = /^(https?):\/\/127\.0\.0\.1:(\d{1,5})\/?$/i

  /** `ws(s)://127.0.0.1:<port>` plus an optional bridge path. */
  const WS_PATTERN = /^(wss?):\/\/127\.0\.0\.1:(\d{1,5})(?:\/[^\s?#]*)?$/i

  /**
   * @typedef {object} Host
   * @property {string} origin Plain http(s) origin, e.g. `http://127.0.0.1:51234`.
   * @property {string | null} instanceId 16 lowercase hex, or null when the candidate has none.
   * @property {string | null} profile Display hint from the host, never trusted further.
   * @property {string | null} startedAt ISO timestamp of the host process's start.
   * @property {string | null} focusAt ISO timestamp of the latest Client focus report.
   * @property {number} port Taken from the origin, never from a body field.
   */

  /**
   * @typedef {object} EndpointImport
   * @property {string} origin
   * @property {string} instanceId
   * @property {string | null} profile
   * @property {string | null} startedAt
   * @property {number | null} pid The process that wrote the record; diagnostics only.
   */

  /**
   * @typedef {object} LastGood
   * @property {string} origin
   * @property {string | null} instanceId
   * @property {string | null} profile
   * @property {string | null} startedAt
   * @property {string | null} focusAt
   * @property {number} at When the address last answered, for the TTL.
   */

  /**
   * One candidate's sort keys, computed once so the comparator stays cheap and
   * the parse of a timestamp never happens inside a comparison.
   * @typedef {object} RankRow
   * @property {Host} host
   * @property {boolean} preferred
   * @property {boolean} last
   * @property {number} focus Parsed focus time, or `-Infinity` when stale or absent.
   * @property {number} started Parsed start time, or `-Infinity` when absent.
   * @property {number} port Ascending; `Infinity` when the host names no usable one.
   * @property {boolean} identified
   * @property {string} origin Final deterministic tiebreak.
   */

  /**
   * A port number from its textual form, or null when it is not one.
   * @param {string} text
   * @returns {number | null}
   */
  function usablePort(text) {
    const port = Number(text)
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
  }

  /**
   * Validate and normalize a loopback origin.
   *
   * Only IPv4 loopback is accepted: the extension's host permissions cover
   * `127.0.0.1`/`localhost`, the locator binds IPv4, and a host on `::1` is a
   * documented manual-path case rather than something to guess at here.
   * @param {unknown} value
   * @returns {{ origin: string, port: number } | null}
   */
  function loopbackOrigin(value) {
    if (typeof value !== 'string') return null
    const match = ORIGIN_PATTERN.exec(value.trim())
    if (match === null) return null
    const port = usablePort(match[2])
    if (port === null) return null
    return { origin: `${match[1].toLowerCase()}://${PROTOCOL.LOCATE_HOST}:${port}`, port }
  }

  /**
   * The port a locator's `wsUrl` names, or null when it is not a loopback
   * websocket URL.
   * @param {unknown} value
   * @returns {number | null}
   */
  function wsPortOf(value) {
    if (typeof value !== 'string') return null
    const match = WS_PATTERN.exec(value.trim())
    return match === null ? null : usablePort(match[2])
  }

  /**
   * An ISO timestamp, or null when the value cannot be read as one.
   *
   * Timestamps are display and ranking data, so a malformed one is not a reason
   * to discard an otherwise usable host.
   * @param {unknown} value
   * @returns {string | null}
   */
  function isoTimestamp(value) {
    if (typeof value !== 'string') return null
    const text = value.trim()
    return text !== '' && Number.isFinite(Date.parse(text)) ? text : null
  }

  /**
   * The host's profile label, never validated further: it is a hint for the
   * status line, not an identity.
   * @param {unknown} value
   * @returns {string | null}
   */
  function optionalProfile(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null
  }

  /**
   * @param {unknown} value
   * @returns {number | null}
   */
  function optionalPid(value) {
    return typeof value === 'number' && Number.isInteger(value) ? value : null
  }

  /**
   * The URL one locator port is expected to answer on.
   * @param {number} port
   * @returns {string}
   */
  function locateUrl(port) {
    return `http://${PROTOCOL.LOCATE_HOST}:${port}${PROTOCOL.LOCATE_PATH}`
  }

  /**
   * Locator URLs, one per `LOCATE_PORTS` entry, in port order.
   * @returns {string[]}
   */
  function locateUrls() {
    return LOCATE_PORTS.map((port) => locateUrl(port))
  }

  /**
   * Validate one `/ext/anno/locate` body.
   *
   * `app` is the discriminator: something else listening on 30810 is a failure,
   * not a host. `version` is checked so a future protocol is ignored rather
   * than half-read. The origin's port is the only port believed — a body that
   * names one port in `origin` and another in `wsUrl` disagrees with itself, so
   * it is stale or confused and is dropped.
   * @param {unknown} body
   * @returns {Host | null}
   */
  function parseLocate(body) {
    if (!PROTOCOL.isPlainObject(body)) return null
    if (body.app !== PROTOCOL.DISCOVERY_APP) return null
    if (body.version !== PROTOCOL.PROTOCOL_VERSION) return null
    if (!PROTOCOL.isInstanceId(body.instanceId)) return null
    const where = loopbackOrigin(body.origin)
    if (where === null) return null
    // An absent `wsUrl` is tolerated (older shapes); a present one must agree.
    if (body.wsUrl !== undefined && body.wsUrl !== null && wsPortOf(body.wsUrl) !== where.port) return null
    return {
      origin: where.origin,
      instanceId: body.instanceId,
      profile: optionalProfile(body.profile),
      startedAt: isoTimestamp(body.startedAt),
      focusAt: isoTimestamp(body.focusAt),
      port: where.port,
    }
  }

  /**
   * Validate one `ext-bridge-endpoint.json` body.
   *
   * The file reaches the extension through a user pick, so it is untrusted in a
   * different way than a locator answer: it may have been hand-edited, and it
   * may carry fields the host would never write. Only the five documented keys
   * leave this function — a stray `token` above all — so nothing downstream can
   * log it, store it, or show it. `wsUrl` is intentionally not copied either:
   * health remains the authority for the scheme.
   * @param {unknown} body
   * @returns {EndpointImport | null}
   */
  function parseEndpointRecord(body) {
    if (!PROTOCOL.isPlainObject(body)) return null
    if (body.app !== PROTOCOL.DISCOVERY_APP) return null
    if (body.version !== PROTOCOL.PROTOCOL_VERSION) return null
    if (!PROTOCOL.isInstanceId(body.instanceId)) return null
    const where = loopbackOrigin(body.origin)
    if (where === null) return null
    return {
      origin: where.origin,
      instanceId: body.instanceId,
      profile: optionalProfile(body.profile),
      startedAt: isoTimestamp(body.startedAt),
      pid: optionalPid(body.pid),
    }
  }

  /**
   * The `instanceId` of a `/ext/anno/health` body, or null.
   *
   * Older hosts answer health without the field. Null then means "there is
   * nothing to compare", not "the host is wrong": the candidate is still usable
   * by origin alone.
   * @param {unknown} body
   * @returns {string | null}
   */
  function healthInstanceId(body) {
    if (!PROTOCOL.isPlainObject(body)) return null
    return PROTOCOL.isInstanceId(body.instanceId) ? body.instanceId : null
  }

  /**
   * Whether the popup's address is still the untouched default.
   *
   * Only this exact triple means "the user did not say where the host is".
   * A typed `localhost`, a typed scheme, or any other port is an explicit
   * instruction, and auto mode must not second-guess it.
   * @param {unknown} address
   * @returns {boolean}
   */
  function isDefaultAddress(address) {
    if (!PROTOCOL.isPlainObject(address)) return false
    return address.host === PROTOCOL.LOCATE_HOST && address.port === DEFAULT_PORT && address.secure === null
  }

  /**
   * Whether auto mode applies at all.
   *
   * An absent `mode` is an install that predates the preference, and those keep
   * exactly their old behaviour: manual.
   * @param {{ mode?: string, address?: unknown }} [input]
   * @returns {{ auto: boolean }}
   */
  function planResolution({ mode, address } = {}) {
    return { auto: mode === 'auto' && isDefaultAddress(address) }
  }

  /**
   * The remembered host, or null when it can no longer be trusted.
   *
   * `anno.address` is ordinary extension storage, so an older version of this
   * extension (or a bug elsewhere) may have written something else there; the
   * value is re-validated as strictly as a locator answer. An unusable
   * `instanceId` is a rejection, because there would be nothing to compare
   * against health, while a missing or null one is a legitimate host.
   * @param {unknown} value
   * @param {number} [now]
   * @returns {(Host & { at: number }) | null}
   */
  function readLastGood(value, now = Date.now()) {
    if (!PROTOCOL.isPlainObject(value)) return null
    const where = loopbackOrigin(value.origin)
    if (where === null) return null
    if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return null
    const clock = Number.isFinite(now) ? now : Date.now()
    if (clock - value.at > LAST_GOOD_TTL_MS) return null
    if (value.at - clock > LAST_GOOD_FUTURE_TOLERANCE_MS) return null
    const instanceId = value.instanceId
    if (instanceId !== undefined && instanceId !== null && !PROTOCOL.isInstanceId(instanceId)) return null
    return {
      origin: where.origin,
      instanceId: PROTOCOL.isInstanceId(instanceId) ? instanceId : null,
      profile: optionalProfile(value.profile),
      startedAt: isoTimestamp(value.startedAt),
      focusAt: isoTimestamp(value.focusAt),
      port: where.port,
      at: value.at,
    }
  }

  /**
   * The value to store so {@link readLastGood} returns this host next time.
   *
   * The port is not stored: `origin` already carries it, and two copies could
   * disagree after a hand-edited record.
   * @param {Host} host
   * @param {number} [now]
   * @returns {LastGood}
   */
  function makeLastGood(host, now = Date.now()) {
    const source = PROTOCOL.isPlainObject(host) ? host : {}
    const where = loopbackOrigin(source.origin)
    return {
      origin: where === null ? '' : where.origin,
      instanceId: PROTOCOL.isInstanceId(source.instanceId) ? source.instanceId : null,
      profile: optionalProfile(source.profile),
      startedAt: isoTimestamp(source.startedAt),
      focusAt: isoTimestamp(source.focusAt),
      // A storage write with a NaN timestamp would be dropped on read anyway.
      at: Number.isFinite(now) ? now : Date.now(),
    }
  }

  /**
   * Whether a host carries exactly the choice being looked for. A null or
   * malformed preference never matches, so the default-port candidate cannot
   * win a preference by having nothing to match against.
   * @param {unknown} instanceId
   * @param {unknown} wanted
   * @returns {boolean}
   */
  function isChoice(instanceId, wanted) {
    return PROTOCOL.isInstanceId(wanted) && PROTOCOL.isInstanceId(instanceId) && instanceId === wanted
  }

  /**
   * @param {unknown} value
   * @returns {number} epoch ms, or `-Infinity` when unusable
   */
  function timeOf(value) {
    if (typeof value !== 'string' || value === '') return Number.NEGATIVE_INFINITY
    const at = Date.parse(value)
    return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
  }

  /**
   * The focus time if it still counts, or `-Infinity` when it is stale or
   * absent. A stale report is discarded rather than demoted, so it does not
   * sneak into a later comparison.
   * @param {unknown} focusAt
   * @param {number} now
   * @returns {number}
   */
  function freshFocus(focusAt, now) {
    const at = timeOf(focusAt)
    if (at === Number.NEGATIVE_INFINITY) return at
    return now - at <= FOCUS_TTL_MS ? at : Number.NEGATIVE_INFINITY
  }

  /**
   * The port a candidate advertises, or its origin's port, or `Infinity` so a
   * host with no usable port sorts after every one that has one.
   * @param {Host} host
   * @returns {number}
   */
  function hostPort(host) {
    if (typeof host.port === 'number' && Number.isInteger(host.port) && host.port >= 1 && host.port <= 65535) {
      return host.port
    }
    const where = loopbackOrigin(host.origin)
    return where === null ? Number.POSITIVE_INFINITY : where.port
  }

  /**
   * @param {RankRow} left
   * @param {RankRow} right
   * @returns {number}
   */
  function compareRows(left, right) {
    if (left.preferred !== right.preferred) return left.preferred ? -1 : 1
    if (left.last !== right.last) return left.last ? -1 : 1
    if (left.focus !== right.focus) return left.focus > right.focus ? -1 : 1
    if (left.started !== right.started) return left.started > right.started ? -1 : 1
    if (left.port !== right.port) return left.port < right.port ? -1 : 1
    if (left.identified !== right.identified) return left.identified ? -1 : 1
    if (left.origin === right.origin) return 0
    return left.origin < right.origin ? -1 : 1
  }

  /**
   * Rank discovered hosts, best first.
   *
   * The order is the one the design doc promises: an explicit preference, then
   * the instance connected last, then the liveliest focus, then the newest
   * process, then port order. It is applied to a copy, because the caller also
   * publishes the original list as `netState.discovered` and sorting it in
   * place would make the popup's list jump around.
   *
   * A host with no `instanceId` (the health-only default-port candidate) can
   * never match a preference, and loses an otherwise complete tie to an
   * identified host: the identified one is the one a locator vouched for. The
   * final `origin` comparison exists only so two equal entries cannot swap
   * places between event-page restarts.
   * @param {Host[]} hosts
   * @param {{ preferredInstanceId?: string | null, lastInstanceId?: string | null, now?: number }} [options]
   * @returns {Host[]}
   */
  function rankCandidates(hosts, { preferredInstanceId, lastInstanceId, now = Date.now() } = {}) {
    const clock = Number.isFinite(now) ? now : Date.now()
    const source = Array.isArray(hosts) ? hosts : []
    /** @type {RankRow[]} */
    const rows = source
      .filter((host) => PROTOCOL.isPlainObject(host))
      .map((host) => ({
        host,
        preferred: isChoice(host.instanceId, preferredInstanceId),
        last: isChoice(host.instanceId, lastInstanceId),
        focus: freshFocus(host.focusAt, clock),
        started: timeOf(host.startedAt),
        port: hostPort(host),
        identified: PROTOCOL.isInstanceId(host.instanceId),
        origin: typeof host.origin === 'string' ? host.origin : '',
      }))
    rows.sort(compareRows)
    return rows.map((row) => row.host)
  }

  /**
   * A short sentence from whatever a rejected request threw.
   *
   * The request implementation is the caller's, so the HTTP status is read from
   * the places one is normally attached (`status`, `statusCode`, a fetch
   * `Response`) and only appended when the message does not already name it.
   * @param {unknown} error
   * @returns {string}
   */
  function describeFailure(error) {
    const message =
      typeof error === 'object' && error !== null && typeof error.message === 'string' && error.message !== ''
        ? error.message
        : String(error ?? 'the request failed')
    const status = httpStatusOf(error)
    if (status === null || message.includes(String(status))) return message
    return `${message} (HTTP ${status})`
  }

  /**
   * @param {unknown} error
   * @returns {number | null}
   */
  function httpStatusOf(error) {
    if (typeof error !== 'object' || error === null) return null
    const candidates = [error.status, error.statusCode, error.response?.status]
    for (const value of candidates) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value
    }
    return null
  }

  /**
   * Settle `pending`, or reject once `limit` ms have passed.
   *
   * The timer is always cleared: a leftover 700 ms timer per probe would keep
   * the event page's event loop busy after the round is over.
   * @param {Promise<unknown>} pending
   * @param {number} limit
   * @returns {Promise<unknown>}
   */
  function settleWithin(pending, limit) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer
    const expiry = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${limit} ms`)), limit)
    })
    return Promise.race([pending, expiry]).finally(() => clearTimeout(timer))
  }

  /**
   * @param {unknown} timeoutMs
   * @returns {number} a positive budget, defaulting to {@link DEFAULT_TIMEOUT_MS}
   */
  function budgetOf(timeoutMs) {
    return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  }

  /**
   * The ports a round probes: the caller's list when it is an array, otherwise
   * the protocol's. Unusable entries are dropped rather than guessed at.
   * @param {unknown} ports
   * @returns {number[]}
   */
  function usablePorts(ports) {
    const source = Array.isArray(ports) ? ports : LOCATE_PORTS
    return source.filter((port) => typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535)
  }

  /**
   * Log a failed probe at `debug` only: a healthy round is already the caller's
   * signal that nothing needs attention, and a logger is host-supplied, so a
   * bug there must not fail a round that promises never to throw.
   * @param {{ debug?: Function } | undefined} logger
   * @param {string} message
   */
  function logFailure(logger, message) {
    try {
      if (typeof logger?.debug === 'function') logger.debug(`dsh-marker: ${message}`)
    } catch {
      // See the function comment: discovery must not depend on the logger.
    }
  }

  /**
   * @param {number} port
   * @param {{ debug?: Function } | undefined} logger
   * @param {string} error
   * @returns {{ port: number, host: null, error: string }}
   */
  function failedProbe(port, logger, error) {
    const message = error === '' ? 'the locator probe failed' : error
    logFailure(logger, `locator on ${PROTOCOL.LOCATE_HOST}:${port} failed: ${message}`)
    return { port, host: null, error: message }
  }

  /**
   * One locator probe. Resolves; never rejects.
   *
   * `request` is called before the first `await` so that every port of a round
   * is in flight at once, and a request implementation that throws
   * synchronously is still just one failure.
   * @param {number} port
   * @param {(url: string) => Promise<unknown>} request
   * @param {number} limit
   * @param {{ debug?: Function } | undefined} logger
   * @returns {Promise<{ port: number, host: Host | null, error: string | null }>}
   */
  async function probePort(port, request, limit, logger) {
    let pending
    try {
      pending = Promise.resolve(request(locateUrl(port)))
    } catch (error) {
      return failedProbe(port, logger, describeFailure(error))
    }
    try {
      const body = await settleWithin(pending, limit)
      const host = parseLocate(body)
      if (host === null) {
        return failedProbe(port, logger, `the answer from ${PROTOCOL.LOCATE_HOST}:${port} is not a DSH locator`)
      }
      return { port, host, error: null }
    } catch (error) {
      return failedProbe(port, logger, describeFailure(error))
    }
  }

  /**
   * One discovery round: probe every locator port in parallel.
   *
   * The budget wraps each request rather than the round, so one slow port
   * cannot eat another's time, and the round always resolves — a caller in the
   * connect path has nothing to catch. The default-port candidate is not probed
   * here: it has no locator, so the caller adds it and lets
   * {@link rankCandidates} place it.
   * @param {object} [options]
   * @param {(url: string) => Promise<unknown>} [options.request] injected transport
   * @param {number[]} [options.ports] defaults to the protocol's `LOCATE_PORTS`
   * @param {number} [options.timeoutMs] per-request budget; `700` by default
   * @param {{ debug?: Function, warn?: Function }} [options.logger]
   * @returns {Promise<{ hosts: Host[], failures: { port: number, error: string }[] }>}
   */
  async function collectHosts({ request, ports, timeoutMs, logger } = {}) {
    const limit = budgetOf(timeoutMs)
    const probes = usablePorts(ports).map((port) => probePort(port, request, limit, logger))
    const results = await Promise.all(probes)
    /** @type {Host[]} */
    const hosts = []
    /** @type {{ port: number, error: string }[]} */
    const failures = []
    for (const result of results) {
      if (result.host === null) failures.push({ port: result.port, error: result.error })
      else hosts.push(result.host)
    }
    return { hosts, failures }
  }

  ns.discovery = {
    LAST_GOOD_TTL_MS,
    FOCUS_TTL_MS,
    locateUrls,
    parseLocate,
    parseEndpointRecord,
    healthInstanceId,
    isDefaultAddress,
    planResolution,
    readLastGood,
    makeLastGood,
    rankCandidates,
    collectHosts,
  }
})()
