/**
 * WebSocket client for the host bridge (`ws://<host>:<port>/ext/anno` by
 * default, `wss://` when the host says it serves TLS).
 *
 * The scheme is not a guess: the background reads `/ext/anno/health` first and
 * follows the `wsUrl` it advertises (`endpoints.js` holds that decision). The
 * default local host answers over plain HTTP and therefore resolves to `ws://`;
 * the extension page CSP must not rewrite that request (the manifest declares
 * an explicit `extension_pages` policy for exactly that reason).
 *
 * The event page is torn down when Firefox decides the extension is idle, so
 * this module must assume it can lose the socket at any moment: every failure
 * path schedules a bounded, jittered retry, and `main.js` reconnects on start
 * plus on a 20 s keepalive alarm. The connection state lives in
 * `ns.netState` (`core.js`) so the status builder and the UI see one truth.
 */
;(() => {
  const ns = globalThis.__DSH_ANNO_BG__
  if (ns === undefined) {
    console.error('dsh-marker: core.js must load before socket.js')
    return
  }
  const PROTOCOL = ns.PROTOCOL

  /** First retry delay; doubles per attempt up to the cap. */
  const BACKOFF_START_MS = 1_000
  /** Never wait longer than this between attempts, even after many failures. */
  const BACKOFF_CAP_MS = 30_000
  /** Each delay is multiplied by a factor in [1 - J, 1 + J]; jitter spreads
   * reconnects when several browsers share a host. */
  const BACKOFF_JITTER = 0.2
  /** The exponent stops growing here; BACKOFF_CAP_MS takes over. */
  const BACKOFF_MAX_EXPONENT = 5
  /** A rejected token will not fix itself; do not hammer the host either. */
  const UNAUTHORIZED_CLOSE_CODE = 4403
  const HELLO_TIMEOUT_MS = PROTOCOL === undefined ? 5_000 : PROTOCOL.HELLO_TIMEOUT_MS
  /**
   * Budget for one health probe. The probe runs before the socket opens, so it
   * must be short enough not to read as connection latency; a loopback answer
   * takes milliseconds and a dead port is refused immediately.
   */
  const HEALTH_PROBE_TIMEOUT_MS = 1_500
  /**
   * How long a health answer is reused. Every reconnect must not re-probe (the
   * event page restarts often), but a host that moves from plain HTTP to TLS
   * has to be noticed, so the answer expires and a failed socket invalidates it
   * immediately.
   */
  const DISCOVERY_TTL_MS = 10 * 60_000
  /** Background-private cache of the discovered endpoint (like the client id). */
  const DISCOVERY_KEY = ns.msg.STORAGE_KEYS.endpoint

  /** @type {WebSocket | null} */
  let socket = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let helloTimer = null
  /** @type {((frame: any) => Promise<void>) | null} */
  let frameHandler = null
  /** One connection attempt at a time; a second one would race the first. */
  let inFlight = null
  /** Bumped by `reconnectNow` so an attempt started under old settings bails. */
  let generation = 0
  /** @type {Record<string, any> | null} */
  let discovered = null

  function isOpen() {
    return socket !== null && socket.readyState === WebSocket.OPEN
  }

  function isAuthed() {
    return isOpen() && ns.netState.connection === 'connected'
  }

  function clearRetryTimer() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function clearHelloTimer() {
    if (helloTimer !== null) {
      clearTimeout(helloTimer)
      helloTimer = null
    }
  }

  /**
   * Send a client frame. Only authenticated sockets may carry frames: the host
   * closes a connection that speaks before `hello`, so an early outbox flush
   * must wait rather than race the handshake.
   * @param {Record<string, unknown>} frame
   */
  function send(frame) {
    if (!isAuthed() || socket === null || PROTOCOL === undefined) return false
    try {
      socket.send(PROTOCOL.encodeFrame(frame))
      return true
    } catch (error) {
      ns.log.warn(`could not send ${String(frame?.t ?? '?')}: ${ns.describeError(error)}`)
      return false
    }
  }

  /** @param {string} code @param {string} reason */
  function closeSocket(code, reason) {
    const current = socket
    socket = null
    clearHelloTimer()
    if (current !== null) {
      try {
        current.close(code, reason)
      } catch (error) {
        ns.log.debug(`closing the socket failed: ${ns.describeError(error)}`)
      }
    }
  }

  /**
   * Exponential backoff with jitter. Attempt N waits
   * `min(30 s, 1 s * 2^(N-1)) * (0.8..1.2)`, so a host that is briefly down is
   * retried quickly and a host that stays down costs one request every 30 s.
   */
  function scheduleRetry() {
    if (retryTimer !== null) return
    const attempts = ns.netState.attempts + 1
    const exponent = Math.min(attempts - 1, BACKOFF_MAX_EXPONENT)
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** exponent)
    const jitter = 1 - BACKOFF_JITTER + Math.random() * BACKOFF_JITTER * 2
    const delay = Math.max(BACKOFF_START_MS, Math.round(base * jitter))
    ns.setNetState({ attempts, nextRetryAt: Date.now() + delay })
    ns.log.info(`bridge retry in ${delay} ms (attempt ${attempts})`)
    retryTimer = setTimeout(() => {
      retryTimer = null
      void connect({ reason: 'retry' })
    }, delay)
    void ns.publishStatus('backoff')
  }

  /**
   * Read the remembered endpoint when it still describes this address.
   * @param {{ host: string, port: number, secure: boolean | null }} address
   */
  async function readCachedDiscovery(address) {
    let record = discovered
    if (record === null) {
      const stored = await ns.storageGet(DISCOVERY_KEY, null)
      record = ns.isPlainObject(stored) ? stored : null
      discovered = record
    }
    if (record === null) return null
    if (record.host !== address.host || record.port !== address.port) return null
    if ((record.configuredSecure ?? null) !== (address.secure ?? null)) return null
    if (!Number.isFinite(record.at) || Date.now() - record.at > DISCOVERY_TTL_MS) return null
    if (typeof record.wsUrl !== 'string' || !/^wss?:\/\//i.test(record.wsUrl)) return null
    return record
  }

  /**
   * Persist the host's answer so an event-page restart does not probe again.
   * @param {{ host: string, port: number, secure: boolean | null }} address
   * @param {{ wsUrl: string, secure: boolean, healthUrl: string }} selection
   */
  async function rememberDiscovery(address, selection) {
    const record = {
      host: address.host,
      port: address.port,
      configuredSecure: address.secure ?? null,
      secure: selection.secure,
      wsUrl: selection.wsUrl,
      healthUrl: selection.healthUrl,
      at: Date.now(),
    }
    discovered = record
    try {
      await ns.storageSet(DISCOVERY_KEY, record)
    } catch (error) {
      ns.log.debug(`could not remember the discovered endpoint: ${ns.describeError(error)}`)
    }
  }

  /** Forget the host's answer; the next attempt probes again. */
  async function invalidateDiscovery() {
    discovered = null
    try {
      await browser.storage.local.remove(DISCOVERY_KEY)
    } catch (error) {
      ns.log.debug(`could not clear the discovered endpoint: ${ns.describeError(error)}`)
    }
  }

  /**
   * One health request. Rejects on a network error, a non-2xx answer, a body
   * that is not the bridge's health JSON, or the probe budget expiring.
   * @param {string} url
   * @returns {Promise<{ secure: boolean, wsUrl: string }>}
   */
  async function probeHealth(url) {
    if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this context')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      })
      if (response.ok !== true) throw new Error(`HTTP ${response.status}`)
      const health = ns.endpoints.parseHealth(await response.json())
      if (health === null) throw new Error('the response is not the bridge health JSON')
      return health
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Probe the candidates in order and stop at the first usable answer.
   *
   * The default local host is plain HTTP, so `http` is tried first and the
   * common path costs exactly one request. `https` is only attempted when the
   * plain probe does not answer (a TLS listener, or a proxy that redirects
   * plaintext away): racing both would send a TLS ClientHello to every plain
   * listener on every probe, and a redirect from http to https cannot be
   * followed usefully by a WebSocket anyway.
   * @param {{ url: string, secure: boolean }[]} candidates
   */
  async function probeFirst(candidates) {
    /** @type {string[]} */
    const failures = []
    for (const candidate of candidates) {
      try {
        return { winner: { url: candidate.url, health: await probeHealth(candidate.url) }, failures }
      } catch (error) {
        failures.push(`${candidate.url}: ${ns.describeError(error)}`)
      }
    }
    return { winner: null, failures }
  }

  /**
   * Ask the host which URL to use.
   *
   * A fresh cached answer is reused; otherwise `/ext/anno/health` decides.
   * When nothing answers the probe the configured address is used as-is, which
   * is the pre-negotiation behaviour and keeps a host whose health route is
   * behind an auth proxy usable.
   * @param {{ host: string, port: number, secure: boolean | null }} address
   * @param {{ force?: boolean }} [options]
   */
  async function discover(address, { force = false } = {}) {
    const cached = force ? null : await readCachedDiscovery(address)
    if (cached !== null) {
      ns.log.debug(`reusing ${cached.wsUrl} discovered ${Date.now() - cached.at} ms ago`)
      return {
        wsUrl: cached.wsUrl,
        secure: cached.secure === true,
        source: 'health',
        healthUrl: typeof cached.healthUrl === 'string' ? cached.healthUrl : '',
        error: '',
      }
    }

    const candidates = ns.endpoints.healthCandidates(address)
    const { winner, failures } = await probeFirst(candidates)
    if (winner === null) {
      // The configured address is the fallback: a host that answers the socket
      // but not health (a proxy that swallows GETs, an older host) still works.
      const selection = ns.endpoints.selectWsUrl({ address, health: null })
      ns.log.info(`health probe failed (${failures.join('; ')}); using ${selection.wsUrl}`)
      return {
        ...selection,
        healthUrl: candidates[0] === undefined ? '' : candidates[0].url,
        error: failures.join('; '),
      }
    }

    const selection = ns.endpoints.selectWsUrl({ address, health: winner.health })
    await rememberDiscovery(address, { ...selection, healthUrl: winner.url })
    ns.log.info(
      `host advertises ${winner.health.wsUrl === '' ? '(no url)' : winner.health.wsUrl} (secure ${String(winner.health.secure)}); using ${selection.wsUrl}`,
    )
    return { ...selection, healthUrl: winner.url, error: '' }
  }

  /**
   * Open one socket. Connection attempts are serialized: a second attempt
   * while the first is probing would race it, so it is coalesced instead.
   * @param {{ reason?: string, resetAttempts?: boolean, forceProbe?: boolean }} [options]
   * @returns {Promise<boolean>} true when a new socket was created
   */
  function connect(options = {}) {
    if (inFlight !== null) {
      if (options.resetAttempts !== true) return Promise.resolve(false)
      // A settings change must win over an attempt that started before it.
      const again = () => connect({ ...options, resetAttempts: false })
      return inFlight.then(again, again)
    }
    const pending = attempt(options)
    inFlight = pending
    const clear = () => {
      if (inFlight === pending) inFlight = null
    }
    pending.then(clear, clear)
    return pending.catch((error) => {
      ns.log.warn(`connect failed: ${ns.describeError(error)}`)
      return false
    })
  }

  /**
   * @param {{ reason?: string, resetAttempts?: boolean, forceProbe?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async function attempt(options = {}) {
    const { reason = 'manual', resetAttempts = false, forceProbe = false } = options
    if (PROTOCOL === undefined) {
      ns.setNetState({ connection: 'error', lastError: 'protocol.global.js did not load' })
      void ns.publishStatus('protocol-missing')
      return false
    }
    if (socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return false
    }
    const started = generation
    clearRetryTimer()
    if (resetAttempts) ns.setNetState({ attempts: 0 })

    const prefs = await ns.readPrefs()
    const token = await ns.readToken()
    const address = ns.normalizeAddress(prefs.host, prefs.port, prefs.secure ?? null)
    ns.setNetState({ tokenPresent: token !== '' })

    if (token === '') {
      ns.setNetState({
        connection: 'no-token',
        wsUrl: ns.endpoints.fallbackWsUrl(address),
        secure: address.secure === true,
        wsUrlSource: 'configured',
        healthUrl: '',
        discoveryError: '',
        lastError: 'No bridge token saved. Paste the contents of $DSH_HOME/ext-bridge-token in the popup.',
      })
      void ns.publishStatus('no-token')
      return false
    }
    if (started !== generation || socket !== null) return false

    ns.setNetState({ connection: 'connecting', lastError: null, nextRetryAt: 0, discoveryError: '' })
    void ns.publishStatus('connecting')

    const discovery = await discover(address, { force: forceProbe })
    if (started !== generation || socket !== null) return false

    const wsUrl = discovery.wsUrl
    ns.setNetState({
      wsUrl,
      secure: discovery.secure,
      wsUrlSource: discovery.source,
      healthUrl: discovery.healthUrl,
      discoveryError: discovery.error,
      connection: 'connecting',
      lastError: null,
      nextRetryAt: 0,
    })
    ns.log.info(
      `connecting to ${wsUrl} (${reason}, ${discovery.source === 'health' ? 'host advertised' : 'popup fallback'})`,
    )
    void ns.publishStatus('connecting')

    let nextSocket
    try {
      nextSocket = new WebSocket(wsUrl)
    } catch (error) {
      ns.setNetState({ connection: 'offline', lastError: `cannot open ${wsUrl}: ${ns.describeError(error)}` })
      void ns.publishStatus('socket-error')
      scheduleRetry()
      return false
    }

    socket = nextSocket
    nextSocket.onopen = () => {
      void handleOpen(nextSocket, token)
    }
    nextSocket.onmessage = (event) => {
      void handleMessage(nextSocket, event)
    }
    nextSocket.onerror = () => {
      // Firefox fires `error` before `close`; the close handler schedules the
      // retry and carries the useful detail, so this only records intent.
      ns.log.warn(`websocket error on ${wsUrl}`)
    }
    nextSocket.onclose = (event) => {
      handleClose(nextSocket, event)
    }
    return true
  }

  /**
   * @param {WebSocket} current
   * @param {string} token
   */
  async function handleOpen(current, token) {
    if (socket !== current) return
    ns.setNetState({ connection: 'open' })
    void ns.publishStatus('socket-open')

    let hello
    try {
      hello = {
        t: 'hello',
        version: PROTOCOL.PROTOCOL_VERSION,
        token,
        clientId: await ns.ensureClientId(),
        client: `dsh-marker-extension/${ns.manifest.version}`,
        browser: navigator.userAgent,
      }
    } catch (error) {
      ns.log.warn(`could not build the hello frame: ${ns.describeError(error)}`)
      closeSocket(4400, 'hello failed')
      scheduleRetry()
      return
    }
    if (socket !== current) return

    try {
      current.send(PROTOCOL.encodeFrame(hello))
    } catch (error) {
      ns.log.warn(`could not send hello: ${ns.describeError(error)}`)
      closeSocket(4400, 'hello send failed')
      scheduleRetry()
      return
    }

    clearHelloTimer()
    helloTimer = setTimeout(() => {
      helloTimer = null
      if (socket === current && ns.netState.connection !== 'connected') {
        ns.log.warn(`host did not acknowledge hello within ${HELLO_TIMEOUT_MS} ms`)
        closeSocket(4400, 'hello timeout')
        scheduleRetry()
      }
    }, HELLO_TIMEOUT_MS)
  }

  /**
   * @param {WebSocket} current
   * @param {MessageEvent} event
   */
  async function handleMessage(current, event) {
    if (socket !== current) return
    ns.setNetState({ lastFrameAt: Date.now() })
    if (typeof event.data !== 'string') {
      ns.log.warn('ignoring a non-text websocket frame')
      return
    }
    const parsed = PROTOCOL.parseServerFrame(event.data)
    if (!parsed.ok) {
      ns.log.warn(`ignoring host frame: ${parsed.reason}`)
      return
    }
    const frame = parsed.frame

    switch (frame.t) {
      case 'hello.ok':
        clearHelloTimer()
        if (socket === current) {
          ns.setNetState({
            connection: 'connected',
            attempts: 0,
            nextRetryAt: 0,
            lastError: null,
            connectedAt: Date.now(),
          })
          ns.log.info(`bridge connected to ${ns.netState.wsUrl} (protocol ${frame.version})`)
          void ns.publishStatus('connected')
        }
        break
      case 'pong':
        ns.setNetState({ lastPongAt: Date.now() })
        return
      case 'error':
        ns.setNetState({ lastError: describeHostError(frame) })
        ns.log.warn(`host reported ${String(frame.code ?? 'error')}: ${String(frame.message ?? '')}`)
        void ns.publishStatus('host-error')
        break
      default:
        break
    }

    if (frameHandler === null) {
      ns.log.debug(`no frame handler for ${frame.t} yet`)
      return
    }
    try {
      await frameHandler(frame)
    } catch (error) {
      ns.log.warn(`frame ${frame.t} failed: ${ns.describeError(error)}`)
    }
  }

  /**
   * @param {WebSocket} current
   * @param {CloseEvent} event
   */
  function handleClose(current, event) {
    if (socket !== current) return
    socket = null
    clearHelloTimer()
    const wasConnected = ns.netState.connection === 'connected'
    const detail = describeClose(event)
    ns.setNetState({
      connection: 'offline',
      connectedAt: 0,
      lastError: detail,
      // A bad token never succeeds on a retry either: start from a longer
      // delay so the host log stays readable until the user pastes a new one.
      attempts:
        typeof event?.code === 'number' && event.code === UNAUTHORIZED_CLOSE_CODE
          ? Math.max(ns.netState.attempts, BACKOFF_MAX_EXPONENT - 1)
          : ns.netState.attempts,
    })
    ns.log.warn(`bridge disconnected: ${detail}`)
    // A failed upgrade or a dead connection means the host's advertised scheme
    // may have changed (plain `dsh web` restarted with TLS, a proxy moved): drop
    // the cached answer so the next attempt asks health again. A clean close and
    // a rejected token keep it, because the URL itself was fine.
    const code = typeof event?.code === 'number' ? event.code : 0
    if ((code === 1006 || code === 1015) && ns.netState.wsUrlSource === 'health') {
      void invalidateDiscovery()
    }
    void ns.publishStatus('socket-closed')
    if (ns.routing !== undefined && typeof ns.routing.onConnectionClosed === 'function') {
      try {
        ns.routing.onConnectionClosed(wasConnected)
      } catch (error) {
        ns.log.warn(`connection-closed cleanup failed: ${ns.describeError(error)}`)
      }
    }
    scheduleRetry()
  }

  /**
   * @param {CloseEvent} event
   * @returns {string}
   */
  function describeClose(event) {
    return ns.endpoints.describeClose({
      code: typeof event?.code === 'number' ? event.code : 0,
      url: ns.netState.wsUrl,
      source: ns.netState.wsUrlSource === 'health' ? 'health' : 'configured',
      healthUrl: ns.netState.healthUrl,
      reason: typeof event?.reason === 'string' ? event.reason : '',
    })
  }

  /** @param {Record<string, unknown>} frame */
  function describeHostError(frame) {
    const code = typeof frame.code === 'string' ? frame.code : 'error'
    const message = typeof frame.message === 'string' ? frame.message : 'the host reported an error'
    return `${code}: ${message}`
  }

  /**
   * Start a connection if nothing is open and no retry is already scheduled.
   * The keepalive alarm calls this; repeated calls are cheap and idempotent.
   */
  async function ensure() {
    if (socket !== null) return false
    if (retryTimer !== null) return false
    return connect({ reason: 'ensure' })
  }

  /**
   * Drop the current socket and connect immediately with a fresh backoff.
   * Used when the user edits the token or the bridge address.
   * @param {string} reason
   */
  async function reconnectNow(reason = 'manual') {
    clearRetryTimer()
    clearHelloTimer()
    // Invalidate an attempt that is still probing: it read the old settings and
    // must not open a socket after this reconnect was requested.
    generation += 1
    const current = socket
    socket = null
    if (current !== null) {
      try {
        current.close(1000, 'reconnect requested')
      } catch (error) {
        ns.log.debug(`closing the socket for a reconnect failed: ${ns.describeError(error)}`)
      }
    }
    ns.setNetState({ attempts: 0, nextRetryAt: 0, connection: 'idle' })
    // A user-initiated reconnect re-asks the host: the settings (or the host
    // behind them) may have changed since the last probe.
    return connect({ reason, resetAttempts: true, forceProbe: true })
  }

  ns.net = {
    /** @param {(frame: any) => Promise<void>} handler */
    onFrame(handler) {
      frameHandler = typeof handler === 'function' ? handler : null
    },
    connect,
    ensure,
    reconnectNow,
    send,
    isOpen,
    isAuthed,
    close(code = 1000, reason = 'client shutdown') {
      clearRetryTimer()
      // Stop an attempt that is mid-probe from opening a socket after shutdown.
      generation += 1
      closeSocket(code, reason)
      ns.setNetState({ connection: 'idle', connectedAt: 0 })
      void ns.publishStatus('closed')
    },
  }
})()
