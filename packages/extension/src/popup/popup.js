/**
 * Toolbar popup: connection state, bridge settings, the current page's
 * annotations, and the outbox controls.
 *
 * A classic script (popup.html uses `<script src>`), so the shared contract is
 * mirrored below and the generated `src/shared/protocol.global.js` supplies the
 * record helpers. The popup never talks to the host socket itself: every host
 * interaction goes through the background, which owns the connection.
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
  const CONNECTION_LABELS = {
    connected: 'Connected to the host',
    open: 'Handshaking with the host',
    connecting: 'Connecting to the host',
    idle: 'Not connected',
    offline: 'Host unreachable',
    'no-token': 'Bridge token required',
    error: 'Bridge error',
  }
  const BUSY_ATTRIBUTE = 'aria-busy'

  /** @type {{ status: any, records: any[], activeTab: any, outbox: any, token: string, busyIds: Set<string> }} */
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

  document.addEventListener('DOMContentLoaded', () => {
    void init()
  })

  async function init() {
    bindElements()
    bindEvents()
    // Paint the last known status immediately, then ask the background for
    // the authoritative state (which also re-reads the token and address).
    const stored = await browser.storage.local.get(MSG.STORAGE_KEYS.lastStatus).catch(() => ({}))
    const lastStatus = stored?.[MSG.STORAGE_KEYS.lastStatus]
    if (lastStatus !== undefined) applyStatus(lastStatus)
    await loadSettings()
  }

  function bindElements() {
    const ids = [
      'connection-dot',
      'connection-label',
      'connection-detail',
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

    browser.runtime.onMessage.addListener((message) => {
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
    })

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
      feedback(`Could not read the saved settings: ${describeError(error)}`, 'error')
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
    await refreshState()
  }

  /** @param {SubmitEvent} event */
  async function saveSettings(event) {
    event.preventDefault()
    const host = el.host === undefined ? '' : el.host.value.trim()
    const port = el.port === undefined ? Number.NaN : Number(el.port.value)
    const token = el.token === undefined ? '' : el.token.value.trim()
    if (host === '') {
      feedback('Enter the host that runs "dsh web" (usually 127.0.0.1).', 'error')
      if (el.host !== undefined) el.host.focus()
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      feedback('The port must be a whole number between 1 and 65535.', 'error')
      if (el.port !== undefined) el.port.focus()
      return
    }
    try {
      // Read the stored prefs first: the content script keeps its own keys
      // (such as `hidden`) in the same object and they must survive.
      const stored = await browser.storage.local.get(MSG.STORAGE_KEYS.prefs)
      const raw = stored?.[MSG.STORAGE_KEYS.prefs]
      const prefs = raw !== null && typeof raw === 'object' ? { ...raw } : {}
      prefs.host = host
      prefs.port = port
      await browser.storage.local.set({
        [MSG.STORAGE_KEYS.prefs]: prefs,
        [MSG.STORAGE_KEYS.token]: token,
      })
      state.token = token
      feedback(`Saved. Connecting to ws://${host}:${port}/ext/anno`, 'ok')
      // The background reconnects on the storage change; give it a moment.
      setTimeout(() => {
        void refreshState()
      }, 500)
    } catch (error) {
      feedback(`Could not save the settings: ${describeError(error)}`, 'error')
    }
  }

  function toggleTokenVisibility() {
    if (el.token === undefined || el['toggle-token'] === undefined) return
    const hidden = el.token.type === 'password'
    el.token.type = hidden ? 'text' : 'password'
    el['toggle-token'].textContent = hidden ? 'Hide' : 'Show'
    el['toggle-token'].setAttribute('aria-pressed', hidden ? 'true' : 'false')
  }

  // ── background state ──────────────────────────────────────────────────────

  async function refreshState() {
    const response = await send(MSG.TO_BACKGROUND_POPUP.state)
    if (response === null || typeof response !== 'object' || response.ok !== true) {
      feedback(`The background could not report its state: ${response?.error ?? 'no response'}`, 'error')
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
    if (el['connection-label'] !== undefined)
      el['connection-label'].textContent = CONNECTION_LABELS[connection] ?? 'Bridge state unknown'
    if (el['connection-detail'] !== undefined) {
      const url =
        typeof status.wsUrl === 'string' && status.wsUrl !== ''
          ? status.wsUrl
          : `ws://${status.host ?? '127.0.0.1'}:${status.port ?? 3080}/ext/anno`
      const token = status.tokenPresent === true ? 'token saved' : 'no token saved'
      el['connection-detail'].textContent = `${url} · ${token}`
    }
    if (typeof status.lastError === 'string' && status.lastError !== '') {
      feedback(status.lastError, 'error')
    } else if (connection === 'connected') {
      feedback('Connected. Annotations sync through the host.', 'ok')
    }
    if (status.outbox !== undefined) applyOutbox(status.outbox)
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
      el['pending-badge'].textContent = `${count} pending`
    }
    if (el.flush !== undefined) el.flush.textContent = count === 0 ? 'Flush outbox' : `Flush outbox (${count})`
    if (el['outbox-summary'] !== undefined) {
      el['outbox-summary'].textContent =
        count === 0
          ? 'Outbox empty.'
          : `${count} annotation(s) waiting to reach the host${pendingImages === 0 ? '' : `, ${pendingImages} with a screenshot waiting for the crop`}.`
    }
  }

  // ── page and records ──────────────────────────────────────────────────────

  function renderPage() {
    const tab = state.activeTab
    if (el['page-title'] === undefined || el['page-url'] === undefined) return
    if (tab === null) {
      el['page-title'].textContent = 'No active page'
      el['page-url'].textContent = ''
      return
    }
    el['page-title'].textContent = typeof tab.title === 'string' && tab.title !== '' ? tab.title : 'Untitled page'
    el['page-url'].textContent =
      tab.restricted === true
        ? 'This page cannot host annotations (browser-internal or protected page).'
        : String(tab.url ?? '')
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
    stateChip.textContent = stateName.replace('_', ' ')
    head.append(stateChip)
    const kindChip = document.createElement('span')
    kindChip.className = 'chip'
    kindChip.textContent = typeof record.anchor?.kind === 'string' ? record.anchor.kind : 'anchor'
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
    preview.setAttribute('aria-label', `Focus the page and highlight annotation ${record.id ?? ''}`)
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
      note.textContent = `Resolution: ${record.resolution.note}`
      item.append(note)
    }

    const actions = document.createElement('div')
    actions.className = 'record__actions'
    const busy = state.busyIds.has(String(record.id ?? ''))
    const lifecycle = document.createElement('button')
    lifecycle.type = 'button'
    lifecycle.dataset.action = stateName === 'open' ? 'resolve' : 'reopen'
    lifecycle.textContent = stateName === 'open' ? 'Resolve' : 'Reopen'
    lifecycle.disabled = busy
    actions.append(lifecycle)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.dataset.action = 'delete'
    remove.textContent = 'Delete'
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
    return 'Annotation'
  }

  /** @param {string} iso */
  function relativeTime(iso) {
    const value = Date.parse(typeof iso === 'string' ? iso : '')
    if (Number.isNaN(value)) return ''
    const seconds = Math.max(0, Math.round((Date.now() - value) / 1000))
    if (seconds < 45) return 'just now'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} h ago`
    const days = Math.round(hours / 24)
    if (days < 7) return `${days} d ago`
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
        feedback(response?.error ?? 'The host did not accept the change.', 'error')
        return
      }
      feedback(
        action === 'delete'
          ? 'Annotation deleted.'
          : action === 'resolve'
            ? 'Annotation resolved.'
            : 'Annotation reopened.',
        'ok',
      )
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
      feedback('No page is available to focus.', 'error')
      return
    }
    try {
      await browser.tabs.update(tab.id, { active: true })
      if (typeof tab.windowId === 'number') await browser.windows.update(tab.windowId, { focused: true })
    } catch (error) {
      feedback(`Could not focus the page: ${describeError(error)}`, 'error')
      return
    }
    const delivered = await sendToTab(tab.id, MSG.TO_CONTENT.activate, { recordId: record.id, mode: 'auto' })
    if (!delivered) {
      feedback('The annotation overlay is not available in this tab; reload the page and try again.', 'error')
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
        const files = contentScriptFiles()
        if (files.length > 0) await browser.scripting.executeScript({ target: { tabId }, files })
        await browser.tabs.sendMessage(tabId, message)
        return true
      } catch (retryError) {
        return false
      }
    }
  }

  function contentScriptFiles() {
    const manifest = browser.runtime.getManifest()
    const groups = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []
    const files = []
    for (const group of groups) {
      for (const file of Array.isArray(group.js) ? group.js : []) {
        if (!files.includes(file)) files.push(file)
      }
    }
    return files
  }

  // ── outbox ────────────────────────────────────────────────────────────────

  async function flushOutbox() {
    if (el.flush !== undefined) el.flush.disabled = true
    feedback('Flushing the outbox through the host.', 'info')
    try {
      const response = await send(MSG.TO_BACKGROUND_POPUP.flush)
      if (response === null || typeof response !== 'object' || response.ok !== true) {
        feedback(response?.error ?? 'The flush failed.', 'error')
        return
      }
      if (response.status !== undefined) applyStatus(response.status)
      if (response.outbox !== undefined) applyOutbox(response.outbox)
      const remaining = Number.isInteger(response.outbox?.count) ? response.outbox.count : 0
      const sent = Number.isInteger(response.sent) ? response.sent : 0
      if (remaining > 0) feedback(`Sent ${sent} annotation(s); ${remaining} still queued.`, 'warn')
      else feedback(sent > 0 ? `Sent ${sent} annotation(s).` : 'The outbox was already empty.', 'ok')
      await refreshState()
    } finally {
      if (el.flush !== undefined) el.flush.disabled = false
    }
  }
})()
