/**
 * WebSocket client for the host bridge (`ws://<host>:<port>/ext/anno`).
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
    console.error('dsh-annotate: core.js must load before socket.js')
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

  /** @type {WebSocket | null} */
  let socket = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let helloTimer = null
  /** @type {((frame: any) => Promise<void>) | null} */
  let frameHandler = null

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
   * @param {{ reason?: string, resetAttempts?: boolean }} [options]
   * @returns {Promise<boolean>} true when a new socket was created
   */
  async function connect(options = {}) {
    const { reason = 'manual', resetAttempts = false } = options
    if (PROTOCOL === undefined) {
      ns.setNetState({ connection: 'error', lastError: 'protocol.global.js did not load' })
      void ns.publishStatus('protocol-missing')
      return false
    }
    if (socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return false
    }
    clearRetryTimer()
    if (resetAttempts) ns.setNetState({ attempts: 0 })

    const prefs = await ns.readPrefs()
    const token = await ns.readToken()
    const wsUrl = `ws://${prefs.host}:${prefs.port}${PROTOCOL.WS_PATH}`
    ns.setNetState({ wsUrl, tokenPresent: token !== '' })

    if (token === '') {
      ns.setNetState({
        connection: 'no-token',
        lastError: 'No bridge token saved. Paste the contents of $DSH_HOME/ext-bridge-token in the popup.',
      })
      void ns.publishStatus('no-token')
      return false
    }

    ns.setNetState({ connection: 'connecting', lastError: null, nextRetryAt: 0 })
    ns.log.info(`connecting to ${wsUrl} (${reason})`)
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
        client: `dsh-annotate-extension/${ns.manifest.version}`,
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
    const code = typeof event?.code === 'number' ? event.code : 0
    const reason = typeof event?.reason === 'string' && event.reason !== '' ? ` (${event.reason})` : ''
    switch (code) {
      case 1000:
        return 'the host closed the connection'
      case 1006:
        return `could not connect; is "dsh web" running at ${ns.netState.wsUrl}?`
      case 1015:
        // Firefox reports a destroyed upgrade handshake as 1015. In practice
        // this is the port being served by a DSH profile without the bundle
        // mounted: the TCP connection opens, then the unmatched upgrade path
        // closes it before the websocket handshake completes.
        return `nothing answers the websocket at ${ns.netState.wsUrl}: either that port belongs to a DSH profile without the dsh-annotate bundle, or "dsh web" is not running there. Install the bundle in the profile serving this port, or change the port in the popup`
      case 4400:
        return `the host rejected the handshake${reason}`
      case 4401:
        return `the host requires the bridge token${reason}`
      case 4403:
        return `the token was rejected; paste the current $DSH_HOME/ext-bridge-token in the popup${reason}`
      default:
        return code === 0 ? `connection failed${reason}` : `connection closed with code ${code}${reason}`
    }
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
    return connect({ reason, resetAttempts: true })
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
      closeSocket(code, reason)
      ns.setNetState({ connection: 'idle', connectedAt: 0 })
      void ns.publishStatus('closed')
    },
  }
})()
