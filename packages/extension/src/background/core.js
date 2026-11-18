/**
 * Background core: namespace, runtime-message contract, storage, and status.
 *
 * Firefox MV3 background pages are event pages that load classic scripts (see
 * `background.scripts` in manifest.json), so the background files cannot use
 * `import`/`export`. They share one namespace object on `globalThis` instead;
 * this file creates it and must load before every other background file.
 *
 * `src/shared/protocol.global.js` is loaded by the manifest before this file
 * and publishes the protocol API on `globalThis.__DSH_PROTOCOL__`.
 */
;(() => {
  const NAMESPACE_KEY = '__DSH_ANNO_BG__'
  const ns = globalThis[NAMESPACE_KEY] ?? (globalThis[NAMESPACE_KEY] = {})
  const PROTOCOL = globalThis.__DSH_PROTOCOL__

  if (PROTOCOL === undefined) {
    // Without the protocol no frame can be encoded or validated, so say so
    // loudly instead of half-booting and failing later with obscure errors.
    console.error('dsh-annotate: src/shared/protocol.global.js must load before src/background/*.js')
  }
  ns.PROTOCOL = PROTOCOL
  ns.manifest = browser.runtime.getManifest()

  /**
   * Runtime-message names, mirrored verbatim from `src/shared/messages.js`.
   *
   * That module is an ES module while every background script is classic, so
   * the background cannot import it. These literals are the contract; when the
   * shared module changes, this block changes with it. Every other background
   * file refers to `ns.msg` rather than writing a message name inline, so the
   * mirror exists exactly once.
   */
  ns.msg = {
    TO_BACKGROUND: {
      submit: 'anno.submit',
      query: 'anno.query',
      status: 'anno.status',
      pickResult: 'anno.pick.result',
      mutate: 'anno.mutate',
      ready: 'anno.content.ready',
    },
    TO_CONTENT: {
      records: 'anno.records',
      status: 'anno.status',
      pickRequest: 'anno.pick.request',
      pickCancel: 'anno.pick.cancel',
      event: 'anno.event',
      activate: 'anno.activate',
    },
    TO_BACKGROUND_POPUP: {
      state: 'anno.popup.state',
      flush: 'anno.popup.flush',
      mutate: 'anno.popup.mutate',
      remove: 'anno.popup.remove',
    },
    STORAGE_KEYS: {
      token: 'anno.token',
      outbox: 'anno.outbox',
      prefs: 'anno.prefs',
      lastStatus: 'anno.status',
      endpoint: 'anno.endpoint',
    },
  }

  /** Storage keys the background owns outside of the shared contract. */
  const CLIENT_ID_KEY = 'anno.clientId'

  /** Alarm that wakes the event page while the browser is idle. */
  const ALARM_NAME = 'anno.keepalive'

  /**
   * Address parsing lives in `endpoints.js`, which loads first and is also
   * loaded by the popup (the two contexts must normalise a typed URL the same
   * way, so the parser exists once).
   */
  const ENDPOINTS = ns.endpoints
  if (ENDPOINTS === undefined) {
    console.error('dsh-annotate: src/background/endpoints.js must load before src/background/core.js')
  }

  ns.ALARM_NAME = ALARM_NAME
  ns.clientIdKey = CLIENT_ID_KEY
  ns.defaultAddress = ENDPOINTS.DEFAULT_ADDRESS
  ns.contentMessageTypes = new Set(Object.values(ns.msg.TO_BACKGROUND))
  ns.popupMessageTypes = new Set(Object.values(ns.msg.TO_BACKGROUND_POPUP))

  const LOG_PREFIX = 'dsh-annotate'

  ns.log = {
    debug: (...args) => console.debug(`${LOG_PREFIX}:`, ...args),
    info: (...args) => console.info(`${LOG_PREFIX}:`, ...args),
    warn: (...args) => console.warn(`${LOG_PREFIX}:`, ...args),
    error: (...args) => console.error(`${LOG_PREFIX}:`, ...args),
  }

  /** @param {unknown} value */
  ns.isPlainObject = function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /** @param {unknown} error */
  ns.describeError = function describeError(error) {
    if (error instanceof Error) return error.message
    return String(error)
  }

  /** @param {string} url */
  ns.isHttpUrl = function isHttpUrl(url) {
    return /^https?:\/\//i.test(String(url ?? ''))
  }

  const MISSING_RECEIVER = /receiving end does not exist|could not establish connection|no receiver/i

  /** True when `tabs.sendMessage` found no content script to talk to. */
  ns.isMissingReceiverError = function isMissingReceiverError(error) {
    return MISSING_RECEIVER.test(ns.describeError(error))
  }

  /** @param {number} ms */
  ns.sleep = function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Reject when a promise takes longer than `timeoutMs`; the timer is always
   * cleared so a settled promise does not keep the event page awake.
   * @template T
   * @param {Promise<T>} promise
   * @param {number} timeoutMs
   * @param {string} label
   * @returns {Promise<T>}
   */
  ns.withTimeout = function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs)
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  ns.randomId = function randomId() {
    if (globalThis.crypto !== undefined && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
    // `randomUUID` is available in every Firefox that supports MV3, but a
    // random hex fallback keeps a single odd build from breaking the hello
    // frame (the host only wants a stable, opaque client id).
    let fallback = ''
    for (let index = 0; index < 16; index += 1) fallback += Math.floor(Math.random() * 16).toString(16)
    return `client-${fallback}`
  }

  /** @param {string} key @param {unknown} fallback */
  ns.storageGet = async function storageGet(key, fallback) {
    try {
      const bag = await browser.storage.local.get(key)
      const value = bag?.[key]
      return value === undefined ? fallback : value
    } catch (error) {
      ns.log.warn(`could not read ${key} from storage.local: ${ns.describeError(error)}`)
      return fallback
    }
  }

  /** @param {string} key @param {unknown} value */
  ns.storageSet = async function storageSet(key, value) {
    await browser.storage.local.set({ [key]: value })
  }

  /**
   * Normalize a user-typed bridge address.
   *
   * The popup accepts what a user is likely to paste (`127.0.0.1:3080`,
   * `http://localhost:3080/`, `wss://anno.example.com`) and keeps `host`/`port`
   * as the stored shape so older preferences keep working. The parsing itself
   * lives in `endpoints.js`; this wrapper only supplies the documented default
   * when the stored value is unusable, which is what the previous normalizer
   * did for garbage.
   * @param {unknown} rawHost
   * @param {unknown} rawPort
   * @param {boolean | null} [fallbackSecure]
   */
  function normalizeAddress(rawHost, rawPort, fallbackSecure = null) {
    const parsed = ENDPOINTS.parseAddress(rawHost, rawPort, fallbackSecure)
    if (parsed.ok) return parsed
    return {
      ok: true,
      host: ENDPOINTS.DEFAULT_HOST,
      port: ENDPOINTS.DEFAULT_PORT,
      secure: typeof fallbackSecure === 'boolean' ? fallbackSecure : null,
      explicitScheme: false,
    }
  }
  ns.normalizeAddress = normalizeAddress

  ns.prefs = { ...ENDPOINTS.DEFAULT_ADDRESS, secure: null }

  /**
   * Read `anno.prefs` without discarding keys other contexts own: the content
   * script stores its `hidden` flag in the same object, so the background only
   * interprets `host`, `port`, and `secure` and copies everything else through.
   */
  ns.readPrefs = async function readPrefs() {
    const raw = await ns.storageGet(ns.msg.STORAGE_KEYS.prefs, {})
    const base = ns.isPlainObject(raw) ? raw : {}
    const stored = typeof base.secure === 'boolean' ? base.secure : null
    const address = normalizeAddress(base.host, base.port, stored)
    ns.prefs = { ...base, host: address.host, port: address.port, secure: address.secure }
    return ns.prefs
  }

  /** @param {Record<string, unknown>} patch */
  ns.writePrefs = async function writePrefs(patch) {
    const current = await ns.readPrefs()
    const next = { ...current, ...patch }
    const address = normalizeAddress(next.host, next.port, next.secure ?? null)
    next.host = address.host
    next.port = address.port
    next.secure = address.secure
    await ns.storageSet(ns.msg.STORAGE_KEYS.prefs, next)
    ns.prefs = next
    return next
  }

  /** The bridge token equals the contents of `$DSH_HOME/ext-bridge-token`. */
  ns.readToken = async function readToken() {
    const raw = await ns.storageGet(ns.msg.STORAGE_KEYS.token, '')
    return typeof raw === 'string' ? raw.trim() : ''
  }

  /**
   * The host logs a client id and uses it to attribute reconnects; keep it
   * stable across event-page restarts by persisting it once.
   */
  ns.ensureClientId = async function ensureClientId() {
    if (typeof ns.clientId === 'string' && ns.clientId !== '') return ns.clientId
    const stored = await ns.storageGet(CLIENT_ID_KEY, '')
    if (typeof stored === 'string' && /^[a-z0-9-]{6,80}$/i.test(stored)) {
      ns.clientId = stored
      return stored
    }
    const fresh = ns.randomId()
    ns.clientId = fresh
    try {
      await ns.storageSet(CLIENT_ID_KEY, fresh)
    } catch (error) {
      ns.log.warn(`could not persist the client id: ${ns.describeError(error)}`)
    }
    return fresh
  }

  /**
   * Live connection state, written by socket.js and read by the status
   * builder. `connection` is the value the content script and popup switch on:
   * idle | connecting | open | connected | offline | no-token | error.
   */
  ns.netState = {
    connection: 'idle',
    attempts: 0,
    nextRetryAt: 0,
    lastError: null,
    connectedAt: 0,
    lastPongAt: 0,
    lastFrameAt: 0,
    tokenPresent: false,
    wsUrl: '',
    /** Whether the attempted URL uses wss:// (set from the chosen endpoint). */
    secure: false,
    /** Where the URL came from: the host's health response, or the popup. */
    wsUrlSource: 'configured',
    /** The health URL that was probed last, whether it answered or not. */
    healthUrl: '',
    /** Why the probe failed, when it did; the socket then used the popup URL. */
    discoveryError: '',
  }

  /** @param {Record<string, unknown>} patch */
  ns.setNetState = function setNetState(patch) {
    if (ns.isPlainObject(patch)) Object.assign(ns.netState, patch)
  }

  ns.status = function status() {
    const state = ns.netState
    return {
      ok: true,
      connection: state.connection,
      wsUrl: state.wsUrl,
      secure: state.secure,
      wsUrlSource: state.wsUrlSource,
      healthUrl: state.healthUrl,
      discoveryError: state.discoveryError,
      host: ns.prefs.host,
      port: ns.prefs.port,
      tokenPresent: state.tokenPresent,
      clientId: typeof ns.clientId === 'string' ? ns.clientId : '',
      protocolVersion: PROTOCOL === undefined ? null : PROTOCOL.PROTOCOL_VERSION,
      attempts: state.attempts,
      nextRetryAt: state.nextRetryAt,
      connectedAt: state.connectedAt,
      lastPongAt: state.lastPongAt,
      lastError: state.lastError,
      outbox: ns.outbox === undefined ? { count: 0, pendingImages: 0 } : ns.outbox.summary(),
      updatedAt: new Date().toISOString(),
    }
  }

  /**
   * Broadcast a typed message to extension pages (popup) and, separately, to
   * every ordinary tab. Content scripts only receive `tabs.sendMessage` while
   * extension pages only receive `runtime.sendMessage`, so both fan-outs are
   * needed for one status object.
   * @param {string} type
   * @param {Record<string, unknown>} payload
   */
  ns.notifyExtensionPages = function notifyExtensionPages(type, payload = {}) {
    const message = { type, ...payload }
    return browser.runtime.sendMessage(message).catch((error) => {
      // A closed popup is the normal case, not a failure worth logging.
      if (!ns.isMissingReceiverError(error)) {
        ns.log.debug(`message ${type} reached no extension page: ${ns.describeError(error)}`)
      }
    })
  }

  /** @param {number} tabId @param {string} type @param {Record<string, unknown>} payload */
  ns.notifyTab = async function notifyTab(tabId, type, payload = {}) {
    if (!Number.isInteger(tabId)) return false
    try {
      await browser.tabs.sendMessage(tabId, { type, ...payload })
      return true
    } catch (error) {
      if (!ns.isMissingReceiverError(error)) {
        ns.log.debug(`message ${type} to tab ${tabId} failed: ${ns.describeError(error)}`)
      }
      return false
    }
  }

  let statusChain = Promise.resolve()
  let lastStatusFingerprint = ''

  /**
   * Publish the status to storage (the popup paints from it before its first
   * round-trip), to the popup, and to every page HUD. Publishing is serialized
   * and de-duplicated so a reconnect storm cannot flood content scripts.
   */
  ns.publishStatus = function publishStatus(reason = '') {
    statusChain = statusChain
      .then(() => deliverStatus(reason))
      .catch((error) => ns.log.warn(`status broadcast failed: ${ns.describeError(error)}`))
    return statusChain
  }

  /** @param {string} reason */
  async function deliverStatus(reason) {
    const status = ns.status()
    const fingerprint = JSON.stringify({ ...status, updatedAt: null, lastPongAt: null })
    if (fingerprint === lastStatusFingerprint) return
    lastStatusFingerprint = fingerprint
    ns.log.debug(`status: ${status.connection}${reason === '' ? '' : ` (${reason})`}`)
    try {
      await browser.storage.local.set({ [ns.msg.STORAGE_KEYS.lastStatus]: status })
    } catch (error) {
      ns.log.warn(`could not persist the bridge status: ${ns.describeError(error)}`)
    }
    void ns.notifyExtensionPages(ns.msg.TO_CONTENT.status, status)
    void broadcastStatusToTabs(status)
  }

  /** @param {Record<string, unknown>} status */
  async function broadcastStatusToTabs(status) {
    let tabs
    try {
      tabs = await browser.tabs.query({})
    } catch (error) {
      ns.log.debug(`could not list tabs for the status broadcast: ${ns.describeError(error)}`)
      return
    }
    for (const tab of tabs) {
      if (typeof tab.id !== 'number' || !ns.isHttpUrl(tab.url)) continue
      void ns.notifyTab(tab.id, ns.msg.TO_CONTENT.status, status)
    }
  }
})()
