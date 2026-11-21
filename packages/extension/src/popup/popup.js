/**
 * Toolbar popup: connection state, bridge settings, the current page's
 * annotations, and the outbox controls.
 *
 * A classic script (popup.html uses `<script src>`), so the shared contract is
 * mirrored below and the generated `src/shared/protocol.global.js` supplies the
 * record helpers. The popup never talks to the host socket itself: every host
 * interaction goes through the background, which owns the connection.
 *
 * The discovery panel lives beside this file in `popup.discovery.js`; this
 * script is the shell around it and hands the panel its status and callbacks.
 */
;(() => {
  /**
   * Message names, mirrored verbatim from `src/shared/messages.js` (an ES
   * module, which classic scripts cannot import).
   */
  const MSG = {
    TO_BACKGROUND_POPUP: {
      state: 'anno.popup.state',
      flush: 'anno.popup.flush',
      mutate: 'anno.popup.mutate',
      remove: 'anno.popup.remove',
      scan: 'anno.popup.scan',
      chooseHost: 'anno.popup.choose',
      importRecord: 'anno.popup.import',
    },
    TO_CONTENT: {
      status: 'anno.status',
      event: 'anno.event',
      activate: 'anno.activate',
    },
    STORAGE_KEYS: {
      token: 'anno.token',
      prefs: 'anno.prefs',
      lastStatus: 'anno.status',
    },
  }

  const PROTOCOL = globalThis.__DSH_PROTOCOL__
  /**
   * The background's address parser, loaded by popup.html from
   * `src/background/endpoints.js`: one implementation decides what a typed
   * host, URL, or port means, so the popup cannot store an address the socket
   * reads differently.
   */
  const ENDPOINTS = globalThis.__DSH_ANNO_BG__?.endpoints
  /**
   * The popup's shared namespace. `popup.discovery.js` loads first and publishes
   * the discovery panel on it, so `init` can attach it before anything paints.
   */
  const POPUP = (globalThis.__DSH_POPUP__ ??= {})
  const I18N = globalThis.__DSH_I18N__
  const language = I18N ? I18N.pickLanguage(I18N.browserLanguage(globalThis)) : 'en'
  const t = I18N ? I18N.make(language) : (key) => key
  const CONNECTION_KEYS = {
    connected: 'statusConnected',
    open: 'statusOpen',
    connecting: 'statusConnecting',
    idle: 'statusIdle',
    offline: 'statusOffline',
    'no-token': 'statusNoToken',
    error: 'statusError',
  }
  const BUSY_ATTRIBUTE = 'aria-busy'

  /**
   * @type {{
   *   status: any,
   *   records: any[],
   *   activeTab: any,
   *   outbox: any,
   *   token: string,
   *   busyIds: Set<string>,
   * }}
   */
  const state = {
    status: null,
    records: [],
    activeTab: null,
    outbox: { count: 0, pendingImages: 0 },
    token: '',
    busyIds: new Set(),
  }

  /** @type {Record<string, HTMLElement>} */
  const el = {}

  /**
   * The discovery panel, attached in `init`. Declared here because `bindEvents`
   * and `applyStatus` reach it; `init` assigns it before either can run.
   * @type {null | {
   *   bind: () => void,
   *   applyStatus: (status: any) => void,
   *   setStoredMode: (connection: any) => void,
   * }}
   */
  let component = null

  document.addEventListener('DOMContentLoaded', () => {
    void init()
  })

  async function init() {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    applyStaticText()
    bindElements()
    // The panel looks up its own nodes, but it writes the shell's host and port
    // fields when an endpoint record is imported, so it is attached after `el`
    // exists and before any event can reach either half.
    component = POPUP.discovery.attach({
      el,
      send,
      feedback,
      describeError,
      relativeTime,
      applyStatus,
      refreshState,
      // The popup keeps one mirror of the message contract; the panel sends
      // through it rather than declaring a fourth copy of the same names.
      messages: MSG,
    })
    bindEvents()
    // The stored mode is read below, but paint the default first so the radio
    // group is never left with nothing checked.
    component.setStoredMode(undefined)
    // Paint the last known status immediately, then ask the background for
    // the authoritative state (which also re-reads the token and address).
    const stored = await browser.storage.local.get(MSG.STORAGE_KEYS.lastStatus).catch(() => ({}))
    const lastStatus = stored?.[MSG.STORAGE_KEYS.lastStatus]
    if (lastStatus !== undefined) applyStatus(lastStatus)
    await loadSettings()
  }

  /**
   * Apply the table to the static markup. The English text in `popup.html` is
   * the no-script fallback; every visible label, placeholder, and accessible
   * name comes from here so the two languages cannot drift apart.
   */
  function applyStaticText() {
    for (const node of document.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.dataset.i18n)
    }
    for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
      node.placeholder = t(node.dataset.i18nPlaceholder)
    }
    for (const node of document.querySelectorAll('[data-i18n-title]')) {
      node.title = t(node.dataset.i18nTitle)
    }
    for (const node of document.querySelectorAll('[data-i18n-aria-label]')) {
      node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel))
    }
    const records = document.getElementById('records')
    if (records !== null) records.setAttribute('aria-label', t('annotationsAria'))
  }

  function bindElements() {
    const ids = [
      'connection-dot',
      'connection-label',
      'pending-badge',
      'settings-form',
      'host',
      'port',
      'token',
      'toggle-token',
      'save',
      'flush',
      'outbox-summary',
      'page-title',
      'page-url',
      'records',
      'records-empty',
      'feedback',
    ]
    for (const id of ids) {
      const node = document.getElementById(id)
      if (node !== null) el[id] = node
    }
  }

  function bindEvents() {
    if (el['settings-form'] !== undefined)
      el['settings-form'].addEventListener('submit', (event) => void saveSettings(event))
    if (el.flush !== undefined) el.flush.addEventListener('click', () => void flushOutbox())
    if (el['toggle-token'] !== undefined) el['toggle-token'].addEventListener('click', toggleTokenVisibility)
    if (el.records !== undefined) el.records.addEventListener('click', onRecordsClick)

    // The mode control, the host list, the scan action, and the endpoint drop
    // zone belong to the discovery panel, which wires its own listeners.
    component.bind()

    // A file dropped outside the zone must not navigate the popup away from
    // its own page, which is the browser default for an unhandled drop.
    document.addEventListener('dragover', (event) => event.preventDefault())
    document.addEventListener('drop', (event) => event.preventDefault())

    // One listener for status pushes and host events. It goes through the
    // platform shim (popup.html loads it first) so that Chromium below 148,
    // where a promise-returning listener's reply is dropped, sees the same
    // empty answer Gecko gets; on Gecko the shim registers it unchanged.
    const platform = globalThis.__DSH_PLATFORM__
    const onMessage = (message) => {
      if (message === null || typeof message !== 'object') return undefined
      if (message.type === MSG.TO_CONTENT.status && typeof message.connection === 'string') {
        applyStatus(message)
        return undefined
      }
      if (message.type === MSG.TO_CONTENT.event) {
        void refreshState()
        return undefined
      }
      return undefined
    }
    if (platform !== undefined && typeof platform.onMessage === 'function') platform.onMessage(onMessage)
    else browser.runtime.onMessage.addListener(onMessage)

    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return
      if (changes[MSG.STORAGE_KEYS.prefs] !== undefined || changes[MSG.STORAGE_KEYS.token] !== undefined) {
        void loadSettings()
      }
    })
  }

  /** @param {string} type @param {Record<string, unknown>} [payload] */
  async function send(type, payload = {}) {
    try {
      return await browser.runtime.sendMessage({ type, ...payload })
    } catch (error) {
      return { ok: false, error: describeError(error) }
    }
  }

  /** @param {unknown} error */
  function describeError(error) {
    return error instanceof Error ? error.message : String(error)
  }

  /** @param {string} message @param {'info' | 'ok' | 'warn' | 'error'} [tone] */
  function feedback(message, tone = 'info') {
    if (el.feedback === undefined) return
    el.feedback.textContent = message
    el.feedback.className = 'feedback'
    if (tone !== 'info') el.feedback.classList.add(`feedback--${tone}`)
  }

  // ── settings ──────────────────────────────────────────────────────────────

  async function loadSettings() {
    let stored = {}
    try {
      stored = await browser.storage.local.get([MSG.STORAGE_KEYS.prefs, MSG.STORAGE_KEYS.token])
    } catch (error) {
      feedback(t('readSettingsFailed', { reason: describeError(error) }), 'error')
      return
    }
    const prefs = stored?.[MSG.STORAGE_KEYS.prefs]
    const host = typeof prefs?.host === 'string' && prefs.host !== '' ? prefs.host : '127.0.0.1'
    const port = Number.isInteger(prefs?.port) ? prefs.port : 3080
    const token = typeof stored?.[MSG.STORAGE_KEYS.token] === 'string' ? stored[MSG.STORAGE_KEYS.token] : ''
    state.token = token
    if (el.host !== undefined) el.host.value = host
    if (el.port !== undefined) el.port.value = String(port)
    if (el.token !== undefined && document.activeElement !== el.token) el.token.value = token
    // The panel owns the mode radios and their hint: it adopts a stored choice
    // and otherwise leaves its current paint (the default) alone.
    component.setStoredMode(prefs?.connection)
    await refreshState()
  }

  /** @param {SubmitEvent} event */
  async function saveSettings(event) {
    event.preventDefault()
    if (ENDPOINTS === undefined) {
      feedback(t('addressParserMissing'), 'error')
      return
    }
    const rawHost = el.host === undefined ? '' : el.host.value.trim()
    const rawPort = el.port === undefined ? '' : el.port.value.trim()
    const typedScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost)
    if (rawHost === '') {
      feedback(t('enterHost'), 'error')
      if (el.host !== undefined) el.host.focus()
      return
    }
    // Without a typed URL the port field is the authority, so a typo there is
    // an error rather than silently falling back to the default port.
    if (!typedScheme && rawPort !== '') {
      const port = Number(rawPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        feedback(t('badPort'), 'error')
        if (el.port !== undefined) el.port.focus()
        return
      }
    }
    // Read the stored prefs before parsing: the content script keeps its own
    // keys (such as `hidden`) in the same object and they must survive, and a
    // previously saved scheme override has to survive a resave of host/port.
    let storedPrefs = {}
    try {
      const stored = await browser.storage.local.get(MSG.STORAGE_KEYS.prefs)
      const raw = stored?.[MSG.STORAGE_KEYS.prefs]
      storedPrefs = raw !== null && typeof raw === 'object' ? { ...raw } : {}
    } catch (error) {
      feedback(t('readSettingsFailed', { reason: describeError(error) }), 'error')
      return
    }
    const storedSecure = typeof storedPrefs.secure === 'boolean' ? storedPrefs.secure : null
    const parsed = ENDPOINTS.parseAddress(rawHost, rawPort === '' ? undefined : rawPort, storedSecure)
    if (!parsed.ok) {
      feedback(parsed.reason, 'error')
      if (el.host !== undefined) el.host.focus()
      return
    }
    const token = el.token === undefined ? '' : el.token.value.trim()
    try {
      const prefs = storedPrefs
      prefs.host = parsed.host
      prefs.port = parsed.port
      // `null` means "no explicit scheme typed": the background asks the host.
      prefs.secure = parsed.secure
      await browser.storage.local.set({
        [MSG.STORAGE_KEYS.prefs]: prefs,
        [MSG.STORAGE_KEYS.token]: token,
      })
      state.token = token
      const scheme = parsed.secure === true ? 'wss' : parsed.secure === false ? 'ws' : 'ws or wss'
      const decision = parsed.secure === null ? t('savedSchemeCheck') : ''
      feedback(t('savedConnect', { scheme, host: parsed.host, port: parsed.port, decision }), 'ok')
      // The background reconnects on the storage change; give it a moment.
      setTimeout(() => {
        void refreshState()
      }, 500)
    } catch (error) {
      feedback(t('saveFailed', { reason: describeError(error) }), 'error')
    }
  }

  function toggleTokenVisibility() {
    if (el.token === undefined || el['toggle-token'] === undefined) return
    const hidden = el.token.type === 'password'
    el.token.type = hidden ? 'text' : 'password'
    el['toggle-token'].textContent = hidden ? t('hide') : t('show')
    el['toggle-token'].setAttribute('aria-pressed', hidden ? 'true' : 'false')
  }

  // ── background state ──────────────────────────────────────────────────────

  async function refreshState() {
    const response = await send(MSG.TO_BACKGROUND_POPUP.state)
    if (response === null || typeof response !== 'object' || response.ok !== true) {
      feedback(t('backgroundStateFailed', { reason: response?.error ?? t('noResponse') }), 'error')
      return
    }
    if (response.status !== undefined) applyStatus(response.status)
    if (response.outbox !== undefined) applyOutbox(response.outbox)
    state.records = Array.isArray(response.records) ? response.records : []
    state.activeTab = response.activeTab ?? null
    renderPage()
    renderRecords()
  }

  /** @param {any} status */
  function applyStatus(status) {
    if (status === null || typeof status !== 'object') return
    state.status = status
    const connection = typeof status.connection === 'string' ? status.connection : 'idle'
    const tone = connectionTone(connection)
    if (el['connection-dot'] !== undefined) el['connection-dot'].className = `dot dot--${tone}`
    if (el['connection-label'] !== undefined) {
      el['connection-label'].textContent = t(CONNECTION_KEYS[connection] ?? 'statusUnknown')
    }
    if (typeof status.lastError === 'string' && status.lastError !== '') {
      // The background's strings are diagnostics and stay English; the one a
      // first-run user actually meets (no token yet) has a translated twin.
      feedback(connection === 'no-token' ? t('noTokenFeedback') : status.lastError, 'error')
    } else if (connection === 'connected') {
      feedback(t('connectedFeedback'), 'ok')
    }
    if (status.outbox !== undefined) applyOutbox(status.outbox)
    // The panel owns the detail line, the mode control, and the hosts list; it
    // paints them from the same status, after the shell's own parts.
    component.applyStatus(status)
  }

  /** @param {string} connection */
  function connectionTone(connection) {
    if (connection === 'connected') return 'ok'
    if (connection === 'open' || connection === 'connecting') return 'pending'
    if (connection === 'no-token' || connection === 'offline' || connection === 'error') return 'bad'
    return 'idle'
  }

  /** @param {any} outbox */
  function applyOutbox(outbox) {
    const count = Number.isInteger(outbox?.count) ? outbox.count : 0
    const pendingImages = Number.isInteger(outbox?.pendingImages) ? outbox.pendingImages : 0
    state.outbox = { count, pendingImages }
    if (el['pending-badge'] !== undefined) {
      el['pending-badge'].hidden = count === 0
      el['pending-badge'].textContent = count === 0 ? '' : t('pending', { n: count })
    }
    if (el.flush !== undefined) {
      el.flush.textContent = count === 0 ? t('flush') : t('flushCount', { n: count })
    }
    if (el['outbox-summary'] !== undefined) {
      el['outbox-summary'].textContent =
        count === 0
          ? t('outboxEmpty')
          : t('outboxWaiting', { n: count }) +
            (pendingImages === 0 ? '' : t('outboxWaitingImages', { n: pendingImages }))
    }
  }
  // ── page and records ──────────────────────────────────────────────────────

  function renderPage() {
    const tab = state.activeTab
    if (el['page-title'] === undefined || el['page-url'] === undefined) return
    if (tab === null) {
      el['page-title'].textContent = t('noPage')
      el['page-url'].textContent = ''
      return
    }
    el['page-title'].textContent = typeof tab.title === 'string' && tab.title !== '' ? tab.title : t('untitledPage')
    el['page-url'].textContent = tab.restricted === true ? t('restrictedPage') : String(tab.url ?? '')
  }

  function renderRecords() {
    const list = el.records
    if (list === undefined) return
    list.replaceChildren()
    const empty = el['records-empty']
    if (state.records.length === 0) {
      if (empty !== undefined) empty.hidden = false
      return
    }
    if (empty !== undefined) empty.hidden = true
    for (const record of state.records) list.append(buildRecordRow(record))
  }

  /** @param {any} record */
  function buildRecordRow(record) {
    const item = document.createElement('li')
    item.className = 'record'
    item.dataset.recordId = String(record.id ?? '')

    const head = document.createElement('div')
    head.className = 'record__head'
    const stateName = typeof record.state === 'string' ? record.state : 'open'
    const stateChip = document.createElement('span')
    stateChip.className = `chip chip--${stateName === 'open' ? 'open' : 'resolved'}`
    stateChip.textContent = stateLabel(stateName)
    head.append(stateChip)
    const kindChip = document.createElement('span')
    kindChip.className = 'chip'
    kindChip.textContent = kindLabel(record.anchor?.kind)
    head.append(kindChip)
    if (typeof record.intent === 'string' && record.intent !== '') {
      const intentChip = document.createElement('span')
      intentChip.className = 'chip'
      intentChip.textContent = record.intent
      head.append(intentChip)
    }
    const when = document.createElement('time')
    when.className = 'record__time'
    if (typeof record.createdAt === 'string') when.dateTime = record.createdAt
    when.textContent = relativeTime(record.createdAt)
    head.append(when)
    item.append(head)

    const preview = document.createElement('button')
    preview.type = 'button'
    preview.className = 'record__open'
    preview.dataset.openRecord = String(record.id ?? '')
    preview.textContent = previewText(record)
    preview.setAttribute('aria-label', t('recordOpenAria', { id: record.id ?? '' }))
    item.append(preview)

    const comment = typeof record.comment === 'string' ? record.comment : ''
    if (comment !== '') {
      const commentNode = document.createElement('p')
      commentNode.className = 'record__comment'
      commentNode.textContent = PROTOCOL !== undefined ? PROTOCOL.truncate(comment, 280) : comment.slice(0, 280)
      item.append(commentNode)
    }

    if (typeof record.resolution?.note === 'string' && record.resolution.note !== '') {
      const note = document.createElement('p')
      note.className = 'record__resolution'
      note.textContent = `${t('resolutionPrefix')}${record.resolution.note}`
      item.append(note)
    }

    const actions = document.createElement('div')
    actions.className = 'record__actions'
    const busy = state.busyIds.has(String(record.id ?? ''))
    const lifecycle = document.createElement('button')
    lifecycle.type = 'button'
    lifecycle.dataset.action = stateName === 'open' ? 'resolve' : 'reopen'
    lifecycle.textContent = stateName === 'open' ? t('resolve') : t('reopen')
    lifecycle.disabled = busy
    actions.append(lifecycle)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.dataset.action = 'delete'
    remove.textContent = t('delete')
    remove.disabled = busy
    actions.append(remove)
    item.append(actions)

    if (busy) item.setAttribute(BUSY_ATTRIBUTE, 'true')
    return item
  }

  /** @param {any} record */
  function previewText(record) {
    if (PROTOCOL !== undefined && typeof PROTOCOL.describeAnchor === 'function') {
      const described = PROTOCOL.describeAnchor(record)
      if (typeof described === 'string' && described !== '') return described
    }
    return t('previewFallback')
  }

  /** @param {string} value */
  function stateLabel(value) {
    if (value === 'resolved') return t('stateResolved')
    if (value === 'wont_fix') return t('stateWontFix')
    return t('stateOpen')
  }

  /** @param {unknown} kind */
  function kindLabel(kind) {
    if (kind === 'selection') return t('kindSelection')
    if (kind === 'region') return t('kindRegion')
    if (kind === 'element') return t('kindElement')
    return String(kind ?? '')
  }

  /** @param {string} iso */
  function relativeTime(iso) {
    const value = Date.parse(typeof iso === 'string' ? iso : '')
    if (Number.isNaN(value)) return ''
    const seconds = Math.max(0, Math.round((Date.now() - value) / 1000))
    if (seconds < 45) return t('justNow')
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return t('minutesAgo', { n: minutes })
    const hours = Math.round(minutes / 60)
    if (hours < 24) return t('hoursAgo', { n: hours })
    const days = Math.round(hours / 24)
    if (days < 7) return t('daysAgo', { n: days })
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(value)
  }

  // ── record actions ────────────────────────────────────────────────────────

  /** @param {MouseEvent} event */
  function onRecordsClick(event) {
    const target = event.target instanceof Element ? event.target : null
    if (target === null) return
    const actionButton = target.closest('button[data-action]')
    if (actionButton instanceof HTMLButtonElement) {
      const id = actionButton.closest('[data-record-id]')?.getAttribute('data-record-id') ?? ''
      const record = state.records.find((item) => item.id === id)
      if (record !== undefined) void changeRecord(record, actionButton.dataset.action ?? '')
      return
    }
    const openButton = target.closest('button[data-open-record]')
    if (openButton instanceof HTMLButtonElement) {
      const id = openButton.dataset.openRecord ?? ''
      const record = state.records.find((item) => item.id === id)
      if (record !== undefined) void openRecord(record)
    }
  }

  /** @param {any} record @param {string} action */
  async function changeRecord(record, action) {
    if (action !== 'resolve' && action !== 'reopen' && action !== 'delete') return
    const id = String(record.id ?? '')
    if (id === '') return
    setBusy(id, true)
    try {
      const response =
        action === 'delete'
          ? await send(MSG.TO_BACKGROUND_POPUP.remove, { id })
          : await send(MSG.TO_BACKGROUND_POPUP.mutate, { id, action })
      if (response === null || typeof response !== 'object' || response.ok !== true) {
        feedback(response?.error ?? t('hostRejected'), 'error')
        return
      }
      feedback(action === 'delete' ? t('deleted') : action === 'resolve' ? t('resolved') : t('reopened'), 'ok')
      await refreshState()
    } finally {
      setBusy(id, false)
    }
  }

  /** @param {string} id @param {boolean} busy */
  function setBusy(id, busy) {
    if (busy) state.busyIds.add(id)
    else state.busyIds.delete(id)
    renderRecords()
  }

  /** @param {any} record */
  async function openRecord(record) {
    const tab = state.activeTab
    if (tab === null || typeof tab.id !== 'number') {
      feedback(t('noPageFocus'), 'error')
      return
    }
    try {
      await browser.tabs.update(tab.id, { active: true })
      if (typeof tab.windowId === 'number') await browser.windows.update(tab.windowId, { focused: true })
    } catch (error) {
      feedback(t('focusFailed', { reason: describeError(error) }), 'error')
      return
    }
    const delivered = await sendToTab(tab.id, MSG.TO_CONTENT.activate, { recordId: record.id, mode: 'auto' })
    if (!delivered) {
      feedback(t('overlayUnavailable'), 'error')
      return
    }
    window.close()
  }

  /**
   * Message the content script, repairing a tab that was open before the
   * extension was installed by injecting the declared files once. Opening the
   * popup grants `activeTab`, which is what makes that injection legal.
   * @param {number} tabId
   * @param {string} type
   * @param {Record<string, unknown>} payload
   */
  async function sendToTab(tabId, type, payload) {
    const message = { type, ...payload }
    try {
      await browser.tabs.sendMessage(tabId, message)
      return true
    } catch (error) {
      const missing = /receiving end does not exist|could not establish connection|no receiver/i.test(
        describeError(error),
      )
      if (!missing) return false
      try {
        const files = globalThis.__DSH_INJECT__.contentScriptFiles(browser.runtime.getManifest())
        if (files.length > 0) await browser.scripting.executeScript({ target: { tabId }, files })
        await browser.tabs.sendMessage(tabId, message)
        return true
      } catch {
        return false
      }
    }
  }

  // ── outbox ────────────────────────────────────────────────────────────────

  async function flushOutbox() {
    if (el.flush !== undefined) el.flush.disabled = true
    feedback(t('flushStarted'), 'info')
    try {
      const response = await send(MSG.TO_BACKGROUND_POPUP.flush)
      if (response === null || typeof response !== 'object' || response.ok !== true) {
        feedback(response?.error ?? t('flushFailed'), 'error')
        return
      }
      if (response.status !== undefined) applyStatus(response.status)
      if (response.outbox !== undefined) applyOutbox(response.outbox)
      const remaining = Number.isInteger(response.outbox?.count) ? response.outbox.count : 0
      const sent = Number.isInteger(response.sent) ? response.sent : 0
      if (remaining > 0) feedback(t('flushPartial', { sent, remaining }), 'warn')
      else feedback(sent > 0 ? t('flushSent', { sent }) : t('flushEmpty'), 'ok')
      await refreshState()
    } finally {
      if (el.flush !== undefined) el.flush.disabled = false
    }
  }
})()
