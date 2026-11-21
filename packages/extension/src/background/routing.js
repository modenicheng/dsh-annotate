/**
 * Routing between the three worlds: content scripts and the popup on one side,
 * the DSH host on the other.
 *
 * Everything the background does on behalf of the browser lives here:
 *
 *   - content messages (`anno.submit`, `anno.query`, `anno.pick.result`, ...)
 *   - popup messages (`anno.popup.*`)
 *   - host frames (`anno.event`, `pick.request`, `anno.ack`, ...)
 *
 * The last-known host records are kept in an in-memory snapshot so a page can
 * still be hydrated while the host is offline; it is refreshed on `hello.ok`
 * and on a slow keepalive cadence, and patched by `anno.event`.
 *
 * Message shapes are flat envelopes: `{ type, ...fields }` (the contract locked
 * with the content-script and popup code). Responses are plain objects and a
 * failure is always `{ ok: false, error }` - a thrown error must never cross a
 * `runtime`/`tabs` messaging boundary.
 */
;(() => {
  const ns = globalThis.__DSH_ANNO_BG__
  if (ns === undefined) {
    console.error('dsh-marker: core.js must load before routing.js')
    return
  }
  const PROTOCOL = ns.PROTOCOL
  const MSG = ns.msg

  const MUTATE_ACK_TIMEOUT_MS = 8_000
  const QUERY_TIMEOUT_MS = 5_000
  /** A pick needs its annotation stored before the result is relayed. */
  const PICK_CREATE_ACK_TIMEOUT_MS = 4_000
  /** At most one injection attempt per tab per window. */
  const INJECT_COOLDOWN_MS = 60_000
  /** Do not spam full `anno.records` replacements more often than this. */
  const RECORDS_BROADCAST_MIN_INTERVAL_MS = 5_000
  const MUTATE_ACTIONS = ['resolve', 'wont_fix', 'reopen', 'delete', 'edit']

  /** @type {Map<string, any>} */
  const snapshot = new Map()
  /** @type {Map<string, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const waiters = new Map()
  /** @type {Map<number, number>} tab id -> last script injection attempt */
  const injectionHistory = new Map()

  let requestSeq = 0
  /** @type {{ pickId: string, tabId: number, mode: string, prompt: string, timeoutMs: number, sessionId: string } | null} */
  let activePick = null
  /** Last tab that submitted or hydrated; the pick fallback target. */
  let lastTabId = null
  let lastRecordsBroadcastAt = 0

  // ── small helpers ─────────────────────────────────────────────────────────

  /**
   * Read a message field from the flat envelope every sender uses
   * (test/messages-mirror.test.js guards that contract on all edges).
   * @param {any} message
   * @param {string} name
   */
  function field(message, name) {
    return ns.isPlainObject(message) ? message[name] : undefined
  }

  /** @param {unknown} error */
  function failure(error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  /** @param {any} record */
  function recordTimestamp(record) {
    const value = Date.parse(typeof record?.createdAt === 'string' ? record.createdAt : '')
    return Number.isNaN(value) ? 0 : value
  }

  /**
   * Records for one document, newest first. An empty URL means "everything"
   * (used to refresh the whole snapshot); otherwise the comparison ignores
   * query and hash so an annotation survives anchor navigation.
   * @param {string} url
   */
  function recordsFor(url) {
    if (PROTOCOL === undefined) return []
    const all = Array.from(snapshot.values())
    const filtered = url === '' ? all : all.filter((record) => PROTOCOL.sameDocument(record, url))
    filtered.sort((left, right) => recordTimestamp(right) - recordTimestamp(left))
    return filtered.slice(0, PROTOCOL.LIMITS.listLimit)
  }

  /** @param {any[]} records */
  function mergeSnapshot(records) {
    if (!Array.isArray(records)) return
    for (const record of records) {
      if (ns.isPlainObject(record) && typeof record.id === 'string') snapshot.set(record.id, record)
    }
  }

  /**
   * @param {string} type created | updated | deleted
   * @param {any} record
   */
  function applyEvent(type, record) {
    if (!ns.isPlainObject(record) || typeof record.id !== 'string') return false
    if (type === 'deleted') snapshot.delete(record.id)
    else snapshot.set(record.id, record)
    return true
  }

  // ── request/ack correlation ───────────────────────────────────────────────

  /**
   * @param {string} kind
   * @param {string} reqId
   * @param {number} timeoutMs
   * @param {string} label
   * @returns {Promise<any>}
   */
  function wait(kind, reqId, timeoutMs, label) {
    if (typeof reqId !== 'string' || reqId === '') return Promise.reject(new Error('missing request id'))
    const key = `${kind}:${reqId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(key)
        reject(new Error(`${label} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      waiters.set(key, {
        resolve(value) {
          clearTimeout(timer)
          resolve(value)
        },
        reject(error) {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }

  /** @param {string} kind @param {unknown} reqId @param {any} value */
  function settle(kind, reqId, value) {
    if (typeof reqId !== 'string') return
    const key = `${kind}:${reqId}`
    const waiter = waiters.get(key)
    if (waiter === undefined) return
    waiters.delete(key)
    waiter.resolve(value)
  }

  /** @param {string} reqId */
  function waitForAck(reqId, timeoutMs = 10_000) {
    return wait('ack', reqId, timeoutMs, `acknowledgement for ${reqId}`)
  }

  // ── tabs and content scripts ──────────────────────────────────────────────

  /** @returns {Promise<any | null>} */
  async function activeTab() {
    try {
      const tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true })
      return tabs.length > 0 ? tabs[0] : null
    } catch (error) {
      ns.log.debug(`could not read the active tab: ${ns.describeError(error)}`)
      return null
    }
  }

  /** @param {any} tab */
  function rememberTab(tab) {
    if (tab !== undefined && tab !== null && typeof tab.id === 'number') lastTabId = tab.id
  }

  /**
   * Inject the declared content scripts into a tab that predates the install.
   * The content scripts guard against double boot, so a second injection is a
   * no-op; this is only attempted after `tabs.sendMessage` found no receiver.
   * The file list itself comes from the shared `src/shared/inject.js`, the one
   * place that reads the manifest's `content_scripts`.
   * @param {number} tabId
   */
  async function injectContentScripts(tabId) {
    const now = Date.now()
    const previous = injectionHistory.get(tabId) ?? 0
    if (now - previous < INJECT_COOLDOWN_MS) return false
    injectionHistory.set(tabId, now)
    const files = globalThis.__DSH_INJECT__.contentScriptFiles(ns.manifest)
    if (files.length === 0) return false
    try {
      await browser.scripting.executeScript({ target: { tabId }, files })
      ns.log.info(`injected the annotation scripts into tab ${tabId}`)
      return true
    } catch (error) {
      ns.log.debug(`cannot inject annotation scripts into tab ${tabId}: ${ns.describeError(error)}`)
      return false
    }
  }

  /**
   * Deliver one message to one tab. Returns whether a content script received
   * it; a missing receiver is not logged as an error because every ordinary
   * page without a content script (about:, AMO, a tab opened before install)
   * produces it.
   * @param {number} tabId
   * @param {string} type
   * @param {Record<string, unknown>} [payload]
   * @param {{ allowInject?: boolean }} [options]
   */
  async function sendToContent(tabId, type, payload = {}, options = {}) {
    if (!Number.isInteger(tabId)) return false
    const message = { type, ...payload }
    try {
      await browser.tabs.sendMessage(tabId, message)
      return true
    } catch (error) {
      if (!ns.isMissingReceiverError(error)) {
        ns.log.debug(`message ${type} to tab ${tabId} failed: ${ns.describeError(error)}`)
        return false
      }
      if (options.allowInject !== true) return false
      const injected = await injectContentScripts(tabId)
      if (!injected) return false
      try {
        await browser.tabs.sendMessage(tabId, message)
        return true
      } catch {
        ns.log.debug(`message ${type} still reached no content script in tab ${tabId}`)
        return false
      }
    }
  }

  /**
   * Send a push to every ordinary tab whose document matches `url`.
   * @param {string} type
   * @param {Record<string, unknown>} payload
   * @param {string} url
   */
  async function broadcastToMatchingTabs(type, payload, url) {
    if (PROTOCOL === undefined || url === '') return
    let tabs
    try {
      tabs = await browser.tabs.query({})
    } catch (error) {
      ns.log.debug(`could not list tabs for an event broadcast: ${ns.describeError(error)}`)
      return
    }
    for (const tab of tabs) {
      if (typeof tab.id !== 'number' || !ns.isHttpUrl(tab.url)) continue
      if (!PROTOCOL.sameDocument({ url }, tab.url)) continue
      void sendToContent(tab.id, type, payload)
    }
  }

  /**
   * Ask the host for records (or answer from the snapshot while offline).
   * @param {string} url
   */
  async function queryRecords(url) {
    if (ns.net.isAuthed() && PROTOCOL !== undefined) {
      const reqId = `query:${++requestSeq}`
      const frame = { t: 'anno.query', reqId, ...(url === '' ? {} : { url }) }
      if (ns.net.send(frame)) {
        try {
          const answer = await wait('query', reqId, QUERY_TIMEOUT_MS, 'annotation query')
          mergeSnapshot(answer.records)
          return { ok: true, records: recordsFor(url), offline: false }
        } catch (error) {
          ns.log.debug(`annotation query fell back to the local snapshot: ${ns.describeError(error)}`)
        }
      }
    }
    return { ok: true, records: recordsFor(url), offline: true }
  }

  /** Refresh the whole snapshot from the host, and hand pages their records. */
  async function refreshRecords() {
    const result = await queryRecords('')
    if (result.offline === false && Date.now() - lastRecordsBroadcastAt >= RECORDS_BROADCAST_MIN_INTERVAL_MS) {
      lastRecordsBroadcastAt = Date.now()
      void broadcastRecords()
    }
    return result.records
  }

  /** Replace each page's record set; they reconcile by id. */
  async function broadcastRecords() {
    let tabs
    try {
      tabs = await browser.tabs.query({})
    } catch (error) {
      ns.log.debug(`could not list tabs for a records broadcast: ${ns.describeError(error)}`)
      return
    }
    for (const tab of tabs) {
      if (typeof tab.id !== 'number' || !ns.isHttpUrl(tab.url)) continue
      void sendToContent(tab.id, MSG.TO_CONTENT.records, { records: recordsFor(tab.url), reason: 'refresh' })
    }
  }

  /**
   * Where a pick banner should appear: the tab the user is looking at, else
   * the tab of the last annotation, else the most recently used ordinary tab.
   * @returns {Promise<any | null>}
   */
  async function choosePickTarget() {
    const focused = await activeTab()
    if (focused !== null && ns.isHttpUrl(focused.url)) return focused
    if (lastTabId !== null) {
      try {
        const previous = await browser.tabs.get(lastTabId)
        if (ns.isHttpUrl(previous.url)) return previous
      } catch (error) {
        ns.log.debug(`the last annotation tab is gone: ${ns.describeError(error)}`)
        lastTabId = null
      }
    }
    try {
      const tabs = await browser.tabs.query({})
      const candidates = tabs.filter((tab) => typeof tab.id === 'number' && ns.isHttpUrl(tab.url))
      candidates.sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))
      return candidates.length > 0 ? candidates[0] : null
    } catch (error) {
      ns.log.debug(`could not pick a tab for the annotation request: ${ns.describeError(error)}`)
      return null
    }
  }

  /** @param {any} tab */
  async function focusTab(tab) {
    try {
      await browser.tabs.update(tab.id, { active: true })
    } catch (error) {
      ns.log.debug(`could not activate tab ${tab.id}: ${ns.describeError(error)}`)
    }
    try {
      await browser.windows.update(tab.windowId, { focused: true })
    } catch (error) {
      ns.log.debug(`could not focus window ${tab.windowId}: ${ns.describeError(error)}`)
    }
  }

  // ── building annotations ──────────────────────────────────────────────────

  /** @param {any} anchor */
  function rectFromAnchor(anchor) {
    if (!ns.isPlainObject(anchor)) return null
    if (anchor.kind === 'region') return ns.capture.normalizeRect(anchor.viewportRect)
    return ns.capture.normalizeRect(anchor.rect)
  }

  /**
   * Turn a content-script draft into a queued annotation: assign the id and
   * lifecycle fields the background owns, capture a crop, and persist the
   * result in the outbox before anything is sent.
   * @param {any} draft
   * @param {any} tab
   * @param {{ viewport?: unknown, cropRect?: unknown }} message
   * @param {{ source: 'user' | 'agent', sessionId?: string }} routing
   */
  async function queueAnnotation(draft, tab, message, routing) {
    if (PROTOCOL === undefined) return failure('the protocol bundle did not load')
    const url = String(draft.url ?? tab.url ?? '')
    if (url === '') return failure('the annotation has no document URL')
    const viewport = ns.capture.normalizeViewport(field(message, 'viewport'))
    const cropRect = ns.capture.normalizeRect(field(message, 'cropRect')) ?? rectFromAnchor(draft.anchor)
    const pageContext = ns.isPlainObject(draft.pageContext) ? { ...draft.pageContext } : {}
    const record = PROTOCOL.normalizeRecord({
      id: PROTOCOL.newAnnotationId(),
      url,
      title: typeof draft.title === 'string' ? draft.title : (tab.title ?? ''),
      anchor: draft.anchor,
      comment: typeof draft.comment === 'string' ? draft.comment : '',
      ...(draft.intent === undefined ? {} : { intent: draft.intent }),
      // The frame the content script froze at click time, not a re-reading of
      // the page now: the crop rect below is part of it.
      ...(ns.isPlainObject(draft.snapshot) ? { snapshot: draft.snapshot } : {}),
      pageContext,
      routing: {
        source: routing.source,
        ...(typeof routing.sessionId === 'string' && routing.sessionId !== '' ? { sessionId: routing.sessionId } : {}),
        // The page names the chip in its own language; the Host has no copy of
        // those strings, and an untargeted annotation still needs one because it
        // is routed there instead.
        ...(typeof draft.routing?.label === 'string' && draft.routing.label !== ''
          ? { label: draft.routing.label }
          : {}),
      },
      state: 'open',
    })
    const errors = PROTOCOL.validateRecord(record)
    if (errors.length > 0) return failure(`the annotation is invalid: ${errors.join('; ')}`)

    const request = {
      tabId: tab.id,
      windowId: typeof tab.windowId === 'number' ? tab.windowId : undefined,
      cropRect,
      viewport,
    }
    const captured = await ns.capture.captureRequest(request)
    const entry = buildOutboxEntry(record, request, captured)
    await ns.outbox.add(entry)
    return {
      ok: true,
      record: entry.record,
      capture:
        captured.ok === true
          ? {
              status: captured.meta.cropped ? 'captured' : 'uncropped',
              ...(captured.meta.reason === undefined ? {} : { reason: captured.meta.reason }),
            }
          : { status: 'deferred', error: captured.error },
    }
  }

  /**
   * @param {any} record normalized record
   * @param {{ tabId: number, windowId?: number, cropRect: any, viewport: any }} request
   * @param {{ ok: boolean, image?: any, meta?: any, error?: string }} captured
   */
  function buildOutboxEntry(record, request, captured) {
    const now = Date.now()
    if (captured.ok === true) {
      return {
        record: ns.capture.withNote(record, {
          status: captured.meta.cropped ? 'captured' : 'uncropped',
          ...(captured.meta.reason === undefined ? {} : { reason: captured.meta.reason }),
          ...(typeof captured.meta.scale === 'number' ? { scale: captured.meta.scale } : {}),
        }),
        image: { b64: captured.image.b64, mime: captured.image.mime },
        captureRequest: null,
        captureAttempts: 0,
        nextCaptureAt: 0,
        enqueuedAt: now,
        sendAttempts: 0,
        blocked: false,
        lastError: null,
      }
    }
    return {
      record: ns.capture.withNote(record, { status: 'deferred', reason: captured.error }),
      image: null,
      captureRequest: request,
      captureAttempts: 1,
      nextCaptureAt: now + (ns.outbox.CAPTURE_RETRY_DELAYS_MS[0] ?? 1_500),
      enqueuedAt: now,
      sendAttempts: 0,
      blocked: false,
      lastError: captured.error ?? null,
    }
  }

  // ── content-script messages ───────────────────────────────────────────────

  /** @param {any} message @param {any} sender */
  async function onReady(message, sender) {
    const tab = sender?.tab
    rememberTab(tab)
    const restricted = field(message, 'restricted') === true
    const url = String(field(message, 'url') ?? tab?.url ?? '')
    if (!restricted && tab !== undefined && activePick !== null && activePick.tabId === tab.id) {
      // The pick arrived before this page finished booting; show it now.
      void deliverPick(tab.id)
    }
    return { ok: true, records: restricted ? [] : recordsFor(url), status: ns.status() }
  }

  /** @param {any} message @param {any} sender */
  async function onSubmit(message, sender) {
    const tab = sender?.tab
    if (tab === undefined || typeof tab.id !== 'number') {
      return failure('annotations must be submitted from a content script')
    }
    rememberTab(tab)
    const draft = field(message, 'record')
    if (!ns.isPlainObject(draft)) return failure('anno.submit needs a record draft')
    // The draft's routing.sessionId is the target the composer chose (a picked
    // Session, or the one a "new session" target just created); dropping it
    // here sent every targeted annotation to the focused Session instead.
    const queued = await queueAnnotation(draft, tab, message, {
      source: 'user',
      ...(typeof draft.routing?.sessionId === 'string' && draft.routing.sessionId !== ''
        ? { sessionId: draft.routing.sessionId }
        : {}),
    })
    if (queued.ok !== true) return queued
    void ns.outbox.flush({ reason: 'submit' })
    ns.log.info(`queued annotation ${queued.record.id} for ${tab.url ?? 'unknown page'}`)
    return queued
  }

  /** @param {any} message */
  async function onQuery(message) {
    const url = field(message, 'url')
    return queryRecords(typeof url === 'string' ? url : '')
  }

  /**
   * A pick is the agent's question answered by a click. The annotation is
   * created first, and its ack awaited briefly, so the agent's tool can render
   * the crop for the pick instead of a bare record; the pick result then
   * carries the same record id.
   * @param {any} message @param {any} sender
   */
  async function onPickResult(message, sender) {
    const pickId = field(message, 'pickId')
    if (typeof pickId !== 'string' || pickId === '') return failure('anno.pick.result needs a pickId')
    const tab = sender?.tab

    if (field(message, 'ok') !== true) {
      const reason = String(field(message, 'reason') ?? field(message, 'error') ?? 'cancelled').slice(0, 400)
      const pending = activePick
      activePick = null
      if (ns.net.isAuthed() && PROTOCOL !== undefined) {
        ns.net.send({ t: 'pick.result', pickId, ok: false, reason })
      }
      if (pending !== null && pending.tabId !== undefined) {
        void sendToContent(pending.tabId, MSG.TO_CONTENT.pickCancel, { pickId })
      }
      ns.log.info(`pick ${pickId} answered: ${reason}`)
      return { ok: true }
    }

    if (tab === undefined || typeof tab.id !== 'number') return failure('a pick must come from a content script')
    rememberTab(tab)
    const draft = field(message, 'record')
    if (!ns.isPlainObject(draft)) return failure('a successful pick needs a record')

    // The content script falls back to `anno.submit` plus a second
    // `anno.pick.result` when the pick answer was rejected once (for example
    // because an older background did not understand it). That record already
    // carries a valid id and may already be queued, so relay it instead of
    // inventing a second annotation for the same pick.
    if (typeof draft.id === 'string' && PROTOCOL !== undefined) {
      const errors = PROTOCOL.validateRecord(draft)
      if (errors.length === 0) {
        activePick = null
        if (!ns.net.isAuthed()) return { ok: true, queued: true }
        if (!ns.net.send({ t: 'pick.result', pickId, ok: true, record: draft })) return { ok: true, queued: true }
        ns.log.info(`pick ${pickId} answered with existing annotation ${draft.id}`)
        return { ok: true }
      }
    }

    const sessionId = activePick !== null && activePick.pickId === pickId ? activePick.sessionId : ''
    const queued = await queueAnnotation(draft, tab, message, { source: 'agent', sessionId })
    if (queued.ok !== true) {
      // Tell the host so the agent gets a definite answer instead of a timeout.
      if (ns.net.isAuthed() && PROTOCOL !== undefined) {
        ns.net.send({ t: 'pick.result', pickId, ok: false, reason: `the pick result was rejected: ${queued.error}` })
      }
      activePick = null
      return queued
    }
    activePick = null

    if (!ns.net.isAuthed()) {
      // The host dropped the socket mid-pick; the annotation is safe in the
      // outbox and will appear as an ordinary annotation once it reconnects.
      // Report success so the content script does not retry the submit path
      // and queue a second copy under a new id.
      ns.log.warn(`pick ${pickId}: the host went offline; annotation ${queued.record.id} was queued instead`)
      return { ok: true, queued: true }
    }

    const entry = ns.outbox.entries().find((item) => item.record.id === queued.record.id)
    const reqId = `pick:${queued.record.id}:${++requestSeq}`
    const createFrame = { t: 'anno.create', reqId, record: queued.record }
    if (entry !== undefined && entry.image) {
      createFrame.targetImageB64 = entry.image.b64
      createFrame.targetImageMime = entry.image.mime
    }
    if (ns.net.send(createFrame)) {
      try {
        await wait('ack', reqId, PICK_CREATE_ACK_TIMEOUT_MS, 'pick annotation acknowledgement')
        void ns.outbox.remove(queued.record.id)
      } catch (error) {
        ns.log.warn(
          `pick ${pickId}: annotation ${queued.record.id} was not acknowledged before the pick was relayed (${ns.describeError(error)})`,
        )
      }
    }

    if (!ns.net.send({ t: 'pick.result', pickId, ok: true, record: queued.record })) {
      ns.log.warn(`pick ${pickId}: the socket closed before the pick result could be sent`)
      return { ok: true, queued: true }
    }
    ns.log.info(`pick ${pickId} answered with annotation ${queued.record.id}`)
    return { ok: true }
  }

  /**
   * Resolve/reopen/delete one annotation through the host. Mutations are not
   * queued offline: they are user intent about an existing record, and a stale
   * replay is worse than asking the user to retry.
   * @param {any} payload
   */
  async function mutate(payload) {
    const id = field(payload, 'id')
    const action = field(payload, 'action')
    if (typeof id !== 'string' || id === '') return failure('this change needs an annotation id')
    if (!MUTATE_ACTIONS.includes(action)) return failure(`unsupported annotation action ${String(action)}`)
    if (!ns.net.isAuthed()) return failure('the host is offline; changes need a live connection')
    const reqId = `mutate:${id}:${++requestSeq}`
    const frame = {
      t: 'anno.mutate',
      reqId,
      id,
      action,
      ...(typeof field(payload, 'note') === 'string' ? { note: field(payload, 'note') } : {}),
      ...(typeof field(payload, 'comment') === 'string' ? { comment: field(payload, 'comment') } : {}),
    }
    if (!ns.net.send(frame)) return failure('the socket is not ready')
    try {
      await wait('ack', reqId, MUTATE_ACK_TIMEOUT_MS, 'annotation change')
    } catch (error) {
      return failure(error)
    }
    return { ok: true }
  }

  // ── popup messages ────────────────────────────────────────────────────────

  async function popupState() {
    const tab = await activeTab()
    const url = tab !== null && ns.isHttpUrl(tab.url) ? tab.url : ''
    return {
      ok: true,
      status: ns.status(),
      records: url === '' ? [] : recordsFor(url),
      activeTab:
        tab === null
          ? null
          : {
              id: tab.id,
              windowId: tab.windowId,
              url: tab.url ?? '',
              title: tab.title ?? '',
              restricted: !ns.isHttpUrl(tab.url),
            },
      outbox: ns.outbox.summary(),
    }
  }

  async function popupFlush() {
    if (!ns.net.isAuthed()) ns.net.reconnectNow('popup-flush')
    try {
      const result = await ns.outbox.flushNow()
      return { ok: true, sent: result.sent, outbox: ns.outbox.summary(), status: ns.status() }
    } catch (error) {
      return failure(error)
    }
  }

  /**
   * One discovery round, on demand, so the popup can explain what answered
   * without disturbing a working socket.
   */
  async function popupScan() {
    if (ns.net === undefined || typeof ns.net.scan !== 'function') return failure('discovery is unavailable')
    const round = await ns.net.scan()
    return { ok: true, hosts: round.hosts, status: ns.status() }
  }

  /**
   * Remember an explicitly chosen host. Writing the preference is also the
   * reconnect trigger: `main.js` reacts to the storage change, so this does not
   * need a second code path to the socket.
   * @param {any} message
   */
  async function popupChooseHost(message) {
    const instanceId = field(message, 'instanceId')
    if (typeof instanceId !== 'string' || instanceId === '') return failure('instanceId is required')
    await ns.writePrefs({ preferredInstanceId: instanceId })
    return { ok: true, status: ns.status() }
  }

  /**
   * Seed the fast path from a picked endpoint record.
   *
   * The record is address-only by design, so this fills the remembered-host
   * fast path and never touches the token. The `anno.prefs` address is not
   * written either: a non-default typed address would demote `auto` discovery
   * to the manual path forever, and importing is a discovery aid, not an
   * address override. The reconnect below uses the seeded fast path. Every
   * field is re-validated here because a page handed us the payload.
   * @param {any} message
   */
  async function popupImportRecord(message) {
    const origin = field(message, 'origin')
    if (typeof origin !== 'string' || origin === '') return failure('the record has no origin')
    const address = ns.endpoints.parseAddress(origin)
    if (address.ok !== true) return failure(address.reason)
    if (address.host !== '127.0.0.1' || address.secure === true) {
      return failure('the record must name a plain http origin on 127.0.0.1')
    }
    const instanceId = field(message, 'instanceId')
    if (typeof instanceId !== 'string' || !ns.PROTOCOL.isInstanceId(instanceId)) {
      return failure('the record has no usable instanceId')
    }
    const host = {
      origin: `${origin.startsWith('http://') ? origin : `http://${origin}`}`,
      instanceId,
      profile: typeof field(message, 'profile') === 'string' ? field(message, 'profile') : null,
      startedAt: typeof field(message, 'startedAt') === 'string' ? field(message, 'startedAt') : null,
      focusAt: null,
      port: address.port,
    }
    let record
    try {
      record = ns.discovery.makeLastGood(host)
    } catch (error) {
      return failure(error)
    }
    await ns.storageSet(ns.msg.STORAGE_KEYS.address, record)
    // Drop a cached scheme answer for the old address; the seeded fast path must
    // win the next resolution, so no forced locator round either.
    await ns.connection?.invalidate()
    if (ns.net !== undefined) await ns.net.reconnectNow('import-record', { forceProbe: false })
    return { ok: true, status: ns.status() }
  }

  /** @param {string} type @param {any} message */
  async function handlePopup(type, message) {
    switch (type) {
      case MSG.TO_BACKGROUND_POPUP.state:
        return popupState()
      case MSG.TO_BACKGROUND_POPUP.flush:
        return popupFlush()
      case MSG.TO_BACKGROUND_POPUP.mutate:
        return mutate({ id: field(message, 'id'), action: field(message, 'action'), note: field(message, 'note') })
      case MSG.TO_BACKGROUND_POPUP.remove:
        return mutate({ id: field(message, 'id'), action: 'delete' })
      case MSG.TO_BACKGROUND_POPUP.scan:
        return popupScan()
      case MSG.TO_BACKGROUND_POPUP.chooseHost:
        return popupChooseHost(message)
      case MSG.TO_BACKGROUND_POPUP.importRecord:
        return popupImportRecord(message)
      case MSG.TO_BACKGROUND_POPUP.activate:
        // The button names an action, not a state: it enters the mode rather
        // than toggling it, so pressing it twice never leaves the mode.
        return activateCurrentPage('enter')
      default:
        return undefined
    }
  }

  // ── content-script dispatch ───────────────────────────────────────────────

  /** @param {string} type @param {any} message @param {any} sender */
  async function handleContent(type, message, sender) {
    switch (type) {
      case MSG.TO_BACKGROUND.ready:
        return onReady(message, sender)
      case MSG.TO_BACKGROUND.submit:
        return onSubmit(message, sender)
      case MSG.TO_BACKGROUND.query:
        return onQuery(message)
      case MSG.TO_BACKGROUND.status:
        return ns.status()
      case MSG.TO_BACKGROUND.pickResult:
        return onPickResult(message, sender)
      case MSG.TO_BACKGROUND.mutate:
        return mutate(message)
      case MSG.TO_BACKGROUND.sessions:
        return onSessions(message)
      case MSG.TO_BACKGROUND.createSession:
        return onCreateSession(message)
      default:
        return undefined
    }
  }

  // ── session catalog ───────────────────────────────────────────────────────

  /** The picker opens per composer, so a short cache keeps it snappy without lying. */
  const SESSIONS_TTL_MS = 15_000
  let sessionsCache = { at: 0, payload: null }

  /**
   * Read the target Session catalog over HTTP, not the bridge: the catalog is a
   * read-only list and must not queue behind a socket that is still connecting.
   * @param {any} message
   */
  async function onSessions(message) {
    const force = field(message, 'force') === true
    if (!force && sessionsCache.payload !== null && Date.now() - sessionsCache.at < SESSIONS_TTL_MS) {
      return sessionsCache.payload
    }
    const token = await ns.readToken()
    if (typeof token !== 'string' || token === '') return failure('the bridge token is missing')

    // The token travels in the x-anno-token header, never the URL: a query
    // string would land in host and reverse-proxy access logs.
    const target = bridgeHttpUrl('/ext/anno/sessions')
    if (target.ok !== true) return failure(target.error)
    const url = `${target.url}?limit=50`

    try {
      const response = await fetch(url, { cache: 'no-store', headers: { 'x-anno-token': token } })
      const body = await response.json()
      if (response.ok !== true || body?.ok === false) {
        return failure(typeof body?.message === 'string' ? body.message : `the host answered ${response.status}`)
      }
      const payload = {
        ok: true,
        items: Array.isArray(body.items) ? body.items : [],
        workspaces: Array.isArray(body.workspaces) ? body.workspaces : [],
        defaultSessionId: typeof body.defaultSessionId === 'string' ? body.defaultSessionId : '',
        truncated: body.truncated === true,
      }
      sessionsCache = { at: Date.now(), payload }
      return payload
    } catch (error) {
      return failure(`could not read the session list (${ns.describeError(error)})`)
    }
  }

  /**
   * Turn the websocket origin into the http origin a bridge route lives on.
   * @param {string} pathname
   * @returns {{ ok: true, url: string } | { ok: false, error: string }}
   */
  function bridgeHttpUrl(pathname) {
    const wsUrl = ns.netState.wsUrl
    if (typeof wsUrl !== 'string' || wsUrl === '') return { ok: false, error: 'not connected to DeepSeek Harness yet' }
    try {
      const parsed = new URL(wsUrl)
      parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
      parsed.pathname = pathname
      parsed.search = ''
      return { ok: true, url: parsed.href }
    } catch (error) {
      return { ok: false, error: `unusable bridge address (${ns.describeError(error)})` }
    }
  }

  /**
   * Create a Session on the host for the composer's "new session" target.
   *
   * Creation is online-only: a session that does not exist yet has no outbox
   * entry to replay, so an offline answer is a definite no rather than a queue.
   * The sessions cache is dropped afterwards so the next picker open sees the
   * new conversation.
   * @param {any} message
   */
  async function onCreateSession(message) {
    if (!ns.net.isAuthed()) return failure('the host is offline; a new session needs a live connection')
    const token = await ns.readToken()
    if (typeof token !== 'string' || token === '') return failure('the bridge token is missing')
    if (PROTOCOL === undefined) return failure('the protocol bundle did not load')

    const body = {
      mode: field(message, 'mode'),
      ...(field(message, 'workspaceId') === undefined ? {} : { workspaceId: field(message, 'workspaceId') }),
      ...(field(message, 'path') === undefined ? {} : { path: field(message, 'path') }),
      ...(field(message, 'title') === undefined ? {} : { title: field(message, 'title') }),
    }
    const errors = PROTOCOL.validateSessionCreateRequest(body)
    if (errors.length > 0) return failure(`the new-session request is invalid: ${errors.join('; ')}`)

    const target = bridgeHttpUrl('/ext/anno/session-create')
    if (target.ok !== true) return failure(target.error)
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-anno-token': token },
        body: JSON.stringify(body),
      })
      const answer = await response.json()
      if (response.ok !== true || answer?.ok === false) {
        return failure(typeof answer?.message === 'string' ? answer.message : `the host answered ${response.status}`)
      }
      sessionsCache = { at: 0, payload: null }
      return {
        ok: true,
        sessionId: typeof answer.sessionId === 'string' ? answer.sessionId : '',
        workspace: ns.isPlainObject(answer.workspace) ? answer.workspace : null,
      }
    } catch (error) {
      return failure(`could not create the session (${ns.describeError(error)})`)
    }
  }

  /**
   * One listener for both content scripts and the popup. Unknown message types
   * resolve to `undefined` so another listener can answer instead.
   * @param {any} message
   * @param {any} sender
   */
  async function handleMessage(message, sender) {
    if (!ns.isPlainObject(message) || typeof message.type !== 'string') return undefined
    const type = message.type
    const isPopup = ns.popupMessageTypes.has(type)
    const isContent = ns.contentMessageTypes.has(type)
    if (!isPopup && !isContent) return undefined
    try {
      return isPopup ? await handlePopup(type, message, sender) : await handleContent(type, message, sender)
    } catch (error) {
      ns.log.warn(`message ${type} failed: ${ns.describeError(error)}`)
      return failure(error)
    }
  }

  // ── host frames ───────────────────────────────────────────────────────────

  /** @param {any} frame */
  async function onHelloOk(frame) {
    ns.log.info(`host hello: protocol ${String(frame.version)}, ${String(frame.openCount ?? 0)} open annotation(s)`)
    ns.outbox.clearBlocked()
    void ns.outbox.flush({ reason: 'hello' })
    try {
      await refreshRecords()
    } catch (error) {
      ns.log.warn(`could not refresh annotations after connecting: ${ns.describeError(error)}`)
    }
  }

  /** @param {any} frame */
  async function onEvent(frame) {
    const type = frame.type === 'deleted' ? 'deleted' : frame.type === 'updated' ? 'updated' : 'created'
    if (!applyEvent(type, frame.record)) return
    const payload = {
      event: type,
      record: frame.record,
      ...(typeof frame.seq === 'number' ? { seq: frame.seq } : {}),
    }
    // The popup also lists records, so it hears about host-side changes too.
    void ns.notifyExtensionPages(MSG.TO_CONTENT.event, payload)
    if (typeof frame.record.url === 'string') {
      await broadcastToMatchingTabs(MSG.TO_CONTENT.event, payload, frame.record.url)
    }
  }

  /** @param {string} pickId @param {string} reason */
  function replyPickFailure(pickId, reason) {
    if (!ns.net.isAuthed() || PROTOCOL === undefined) {
      ns.log.warn(`pick ${pickId} failed (${reason}) but the host is offline`)
      return
    }
    ns.net.send({ t: 'pick.result', pickId, ok: false, reason: String(reason).slice(0, 400) })
  }

  /** @param {number} tabId */
  async function deliverPick(tabId) {
    if (activePick === null) return false
    return sendToContent(
      tabId,
      MSG.TO_CONTENT.pickRequest,
      {
        pickId: activePick.pickId,
        mode: activePick.mode,
        prompt: activePick.prompt,
        timeoutMs: activePick.timeoutMs,
        sessionId: activePick.sessionId,
      },
      { allowInject: true },
    )
  }

  /** @param {any} frame */
  async function onPickRequest(frame) {
    if (PROTOCOL === undefined) return
    const pickId = typeof frame.pickId === 'string' ? frame.pickId : ''
    if (pickId === '') return
    const mode = ['selection', 'element', 'region'].includes(frame.mode) ? frame.mode : 'auto'
    const previous = activePick
    if (previous !== null) {
      void sendToContent(previous.tabId, MSG.TO_CONTENT.pickCancel, { pickId: previous.pickId })
    }
    activePick = {
      pickId,
      tabId: -1,
      mode,
      prompt: typeof frame.prompt === 'string' ? frame.prompt : 'Point at the relevant element',
      timeoutMs: typeof frame.timeoutMs === 'number' ? frame.timeoutMs : PROTOCOL.PICK_TIMEOUT_MS,
      sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : '',
    }
    const target = await choosePickTarget()
    if (target === null) {
      activePick = null
      replyPickFailure(pickId, 'no ordinary page is open to point at')
      return
    }
    activePick.tabId = target.id
    const delivered = await deliverPick(target.id)
    if (!delivered) {
      activePick = null
      replyPickFailure(pickId, 'restricted-page: the foreground tab cannot host the annotation overlay')
      return
    }
    if (target.active !== true) await focusTab(target)
    ns.log.info(`pick ${pickId} shown in tab ${target.id}`)
  }

  /** @param {any} frame */
  function onPickCancel(frame) {
    const pickId = typeof frame.pickId === 'string' ? frame.pickId : ''
    if (pickId === '') return
    const pending = activePick
    if (pending !== null && pending.pickId === pickId) activePick = null
    const tabId = pending !== null && pending.pickId === pickId ? pending.tabId : -1
    if (tabId >= 0) void sendToContent(tabId, MSG.TO_CONTENT.pickCancel, { pickId })
    ns.log.info(`pick ${pickId} was withdrawn`)
  }

  /** @param {any} frame */
  async function onHostFrame(frame) {
    switch (frame.t) {
      case 'hello.ok':
        await onHelloOk(frame)
        return
      case 'anno.ack':
        settle('ack', frame.reqId, frame)
        ns.outbox.onAck(frame)
        return
      case 'anno.query.ok':
        settle('query', frame.reqId, frame)
        mergeSnapshot(frame.records)
        return
      case 'anno.event':
        await onEvent(frame)
        return
      case 'pick.request':
        await onPickRequest(frame)
        return
      case 'pick.cancel':
        onPickCancel(frame)
        return
      case 'pong':
        return
      case 'error':
        // The socket layer already recorded and published the message.
        ns.log.warn(`host error ${String(frame.code ?? '')}: ${String(frame.message ?? '')}`)
        return
      default:
        ns.log.debug(`unhandled host frame ${String(frame.t)}`)
    }
  }

  // ── lifecycle hooks ───────────────────────────────────────────────────────

  /**
   * @param {boolean} wasConnected
   */
  function onConnectionClosed(wasConnected) {
    const pending = activePick
    activePick = null
    if (pending !== null && pending.tabId >= 0) {
      // The pick can no longer reach the agent; hide the banner rather than
      // letting the user answer a question nobody will hear.
      void sendToContent(pending.tabId, MSG.TO_CONTENT.pickCancel, { pickId: pending.pickId })
    }
    if (wasConnected) ns.log.info('annotation pages keep their records while the host is offline')
  }

  /** @param {number} tabId */
  function onTabRemoved(tabId) {
    injectionHistory.delete(tabId)
    if (lastTabId === tabId) lastTabId = null
    const pending = activePick
    if (pending !== null && pending.tabId === tabId) {
      activePick = null
      replyPickFailure(pending.pickId, 'the tab was closed before the pick was answered')
    }
  }

  /**
   * Enter annotation mode in the active tab; the keyboard command and a popup
   * button both use it. A tab that predates the install is repaired by
   * injecting the declared content scripts once.
   */
  async function activateCurrentPage(mode = 'auto') {
    const tab = await activeTab()
    if (tab === null || typeof tab.id !== 'number') return failure('no active tab')
    if (!ns.isHttpUrl(tab.url)) return failure('restricted-page: this page cannot host annotations')
    const delivered = await sendToContent(tab.id, MSG.TO_CONTENT.activate, { mode }, { allowInject: true })
    if (!delivered) return failure('restricted-page: the annotation overlay is not available in this tab')
    return { ok: true }
  }

  ns.routing = {
    handleMessage,
    onHostFrame,
    onConnectionClosed,
    onTabRemoved,
    waitForAck,
    activateCurrentPage,
    refreshRecords,
    recordsFor,
    stats() {
      return {
        snapshot: snapshot.size,
        waiters: waiters.size,
        activePick: activePick === null ? null : activePick.pickId,
        lastTabId,
      }
    },
  }

  ns.net.onFrame(onHostFrame)
})()
