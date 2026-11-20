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
  const MODE_AUTO = 'auto'
  const MODE_MANUAL = 'manual'
  /**
   * One line under the mode control: the setting has to explain what it does
   * to the fields, because those fields are the same in both modes.
   */
  const MODE_HINTS = {
    auto: 'The extension finds a host whose port is not 3080. Leave the fields at 127.0.0.1 / 3080; anything else is treated as an override.',
    manual: 'The extension uses the address below, exactly as typed.',
  }

  /**
   * @type {{
   *   status: any,
   *   records: any[],
   *   activeTab: any,
   *   outbox: any,
   *   token: string,
   *   busyIds: Set<string>,
   *   mode: 'auto' | 'manual',
   *   modeKnown: boolean,
   *   discovered: any[],
   *   failures: any[],
   *   imported: any,
   *   pendingHost: string,
   *   importing: boolean,
   *   scanning: boolean,
   * }}
   */
  const state = {
    status: null,
    records: [],
    activeTab: null,
    outbox: { count: 0, pendingImages: 0 },
    token: '',
    busyIds: new Set(),
    /** `anno.prefs.connection`: 'auto' finds the host, 'manual' uses the fields. */
    mode: MODE_MANUAL,
    /** True once a stored mode is known, so a status that predates a choice cannot undo it. */
    modeKnown: false,
    /** `status.discovered`, normalized to one row shape; `[]` when absent (older background). */
    discovered: [],
    /** `status.discoveryFailures`, normalized; `[]` when absent. */
    failures: [],
    /** The endpoint record read from the last imported file. */
    imported: null,
    /** instanceId whose `chooseHost` is in flight; `''` when idle. */
    pendingHost: '',
    /** True while an import is reading or sending, so a second drop is ignored. */
    importing: false,
    /** True while a scan is running, so the button cannot be pressed twice. */
    scanning: false,
  }

  /** @type {Record<string, HTMLElement>} */
  const el = {}

  document.addEventListener('DOMContentLoaded', () => {
    void init()
  })

  async function init() {
    bindElements()
    bindEvents()
    // The stored mode is read below, but paint the default first so the radio
    // group is never left with nothing checked.
    renderConnectionMode()
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
      'mode-auto',
      'mode-manual',
      'mode-hint',
      'discovered',
      'discovered-title',
      'discovered-list',
      'discovery-actions',
      'discovery-hint',
      'scan-again',
      'drop-zone',
      'import-file',
      'import-hint',
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

    for (const id of ['mode-auto', 'mode-manual']) {
      if (el[id] !== undefined) el[id].addEventListener('change', onConnectionModeChange)
    }

    if (el['scan-again'] !== undefined) el['scan-again'].addEventListener('click', () => void scanAgain())
    if (el['discovered-list'] !== undefined) el['discovered-list'].addEventListener('click', onHostsClick)
    if (el['import-file'] !== undefined) el['import-file'].addEventListener('change', onImportFileChange)

    const zone = el['drop-zone']
    if (zone !== undefined) {
      zone.addEventListener('click', (event) => {
        if (event.target === zone) openImportPicker()
      })
      zone.addEventListener('keydown', onDropZoneKeyDown)
      zone.addEventListener('dragenter', onDragEnter)
      zone.addEventListener('dragover', onDragOver)
      zone.addEventListener('dragleave', onDragLeave)
      zone.addEventListener('drop', onDrop)
    }
    // A file dropped outside the zone must not navigate the popup away from
    // its own page, which is the browser default for an unhandled drop.
    document.addEventListener('dragover', (event) => event.preventDefault())
    document.addEventListener('drop', (event) => event.preventDefault())

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
    const storedMode = prefs?.connection === MODE_AUTO || prefs?.connection === MODE_MANUAL ? prefs.connection : null
    if (storedMode !== null) {
      state.mode = storedMode
      state.modeKnown = true
    }
    const token = typeof stored?.[MSG.STORAGE_KEYS.token] === 'string' ? stored[MSG.STORAGE_KEYS.token] : ''
    state.token = token
    if (el.host !== undefined) el.host.value = host
    if (el.port !== undefined) el.port.value = String(port)
    if (el.token !== undefined && document.activeElement !== el.token) el.token.value = token
    renderConnectionMode()
    await refreshState()
  }

  /** @param {SubmitEvent} event */
  async function saveSettings(event) {
    event.preventDefault()
    if (ENDPOINTS === undefined) {
      feedback('The address parser did not load; reopen the popup.', 'error')
      return
    }
    const rawHost = el.host === undefined ? '' : el.host.value.trim()
    const rawPort = el.port === undefined ? '' : el.port.value.trim()
    const typedScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost)
    if (rawHost === '') {
      feedback(
        'Enter the host that runs "dsh web" (usually 127.0.0.1), or a URL such as wss://anno.example.com.',
        'error',
      )
      if (el.host !== undefined) el.host.focus()
      return
    }
    // Without a typed URL the port field is the authority, so a typo there is
    // an error rather than silently falling back to the default port.
    if (!typedScheme && rawPort !== '') {
      const port = Number(rawPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        feedback('The port must be a whole number between 1 and 65535.', 'error')
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
      feedback(`Could not read the saved settings: ${describeError(error)}`, 'error')
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
      const decision = parsed.secure === null ? '; the host health check picks the scheme' : ''
      feedback(`Saved. Connecting to ${scheme}://${parsed.host}:${parsed.port}/ext/anno${decision}`, 'ok')
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

  // ── connection mode and discovery ─────────────────────────────────────────

  /** `anno.prefs` as a copy, so a write preserves every key this popup does not own. */
  async function readPrefs() {
    const stored = await browser.storage.local.get(MSG.STORAGE_KEYS.prefs)
    const raw = stored?.[MSG.STORAGE_KEYS.prefs]
    return raw !== null && typeof raw === 'object' ? { ...raw } : {}
  }

  /**
   * Paint the mode control and its explanation. The radios are the only place
   * the mode is shown; the host and port fields are identical in both modes.
   */
  function renderConnectionMode() {
    const mode = state.mode === MODE_AUTO ? MODE_AUTO : MODE_MANUAL
    if (el['mode-auto'] !== undefined) el['mode-auto'].checked = mode === MODE_AUTO
    if (el['mode-manual'] !== undefined) el['mode-manual'].checked = mode === MODE_MANUAL
    if (el['mode-hint'] !== undefined) el['mode-hint'].textContent = MODE_HINTS[mode]
  }

  /** @param {Event} event */
  function onConnectionModeChange(event) {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || input.name !== 'connection-mode') return
    void saveConnectionMode(input.value === MODE_AUTO ? MODE_AUTO : MODE_MANUAL)
  }

  /**
   * Store `anno.prefs.connection`. The `host`, `port`, and `secure` keys and
   * everything the content script keeps in the same object (such as `hidden`)
   * are read back and written unchanged: the background watches that object
   * and reconnects on the change. The token is deliberately not read or written.
   * @param {'auto' | 'manual'} mode
   */
  async function saveConnectionMode(mode) {
    const previousMode = state.mode
    const previousKnown = state.modeKnown
    state.mode = mode
    state.modeKnown = true
    renderConnectionMode()
    try {
      const prefs = await readPrefs()
      prefs.connection = mode
      await browser.storage.local.set({ [MSG.STORAGE_KEYS.prefs]: prefs })
      // Repaint before the confirmation: the status line and the discovery
      // blocks are mode-dependent, and the background's next broadcast may
      // still describe the previous mode.
      if (state.status !== null) applyStatus(state.status)
      feedback(mode === MODE_AUTO ? 'Automatic discovery on.' : 'Manual address on.', 'ok')
      // The background reconnects on the storage change; give it a moment.
      setTimeout(() => {
        void refreshState()
      }, 500)
    } catch (error) {
      state.mode = previousMode
      state.modeKnown = previousKnown
      renderConnectionMode()
      if (state.status !== null) applyStatus(state.status)
      feedback(`Could not save the connection mode: ${describeError(error)}`, 'error')
    }
  }

  /** The mode to show: a stored preference wins once it is known, otherwise the background's answer. */
  function modeOf(status) {
    if (!state.modeKnown && status !== null) {
      if (status.discoveryMode === MODE_AUTO || status.discoveryMode === MODE_MANUAL) return status.discoveryMode
    }
    return state.mode
  }

  /** `127.0.0.1:51234` from an origin, a ws URL, or a bare address. */
  function hostAuthority(value) {
    if (typeof value !== 'string' || value === '') return ''
    try {
      return new URL(value).host || value
    } catch {
      return value
    }
  }

  /** The `host:port` the background says it used, or `''` when it did not say. */
  function configuredAuthority(status) {
    const host = typeof status.host === 'string' ? status.host : ''
    if (host === '') return ''
    return Number.isInteger(status.port) ? `${host}:${status.port}` : host
  }

  /** The websocket URL the background reports, or the one its host and port imply. */
  function wsUrlOf(status) {
    if (typeof status.wsUrl === 'string' && status.wsUrl !== '') return status.wsUrl
    const scheme = status.secure === true ? 'wss' : 'ws'
    const host = typeof status.host === 'string' && status.host !== '' ? status.host : '127.0.0.1'
    const port = Number.isInteger(status.port) ? status.port : 3080
    return `${scheme}://${host}:${port}/ext/anno`
  }

  /** @param {string} address @param {string} profile */
  function withProfile(address, profile) {
    return profile === '' ? address : `${address} (${profile})`
  }

  /** The discovered row that describes the connected host, when one does. */
  function currentHost(status) {
    const instanceId = typeof status.instanceId === 'string' ? status.instanceId : ''
    if (instanceId !== '') {
      const match = state.discovered.find((host) => host.instanceId === instanceId)
      if (match !== undefined) return match
    }
    const address = configuredAuthority(status)
    if (address !== '') {
      const match = state.discovered.find((host) => hostAuthority(host.origin) === address)
      if (match !== undefined) return match
    }
    return undefined
  }

  /**
   * The detail line: the discovery source first, then the address, the number
   * of hosts found, and the token state. Every field is read defensively,
   * because an older background sends none of the discovery fields.
   */
  function connectionDetail(status) {
    const mode = modeOf(status)
    const connection = typeof status.connection === 'string' ? status.connection : 'idle'
    const tokenState = status.tokenPresent === true ? 'token saved' : 'no token saved'
    const advertised = status.wsUrlSource === 'health' ? ' · advertised by the host' : ''
    const parts = [mode === MODE_AUTO ? 'Automatic' : 'Manual']
    if (mode !== MODE_AUTO) {
      parts.push(wsUrlOf(status), tokenState)
      return `${parts.join(' · ')}${advertised}`
    }
    const hosts = state.discovered
    if (hosts.length > 0) {
      const row = currentHost(status) ?? hosts[0]
      parts.push(withProfile(hostAuthority(row.origin), row.profile))
      if (hosts.length > 1) parts.push(`${hosts.length} hosts found`)
      parts.push(tokenState)
      return `${parts.join(' · ')}${advertised}`
    }
    if (connection === 'connected' || connection === 'open' || connection === 'no-token') {
      const address = configuredAuthority(status) || hostAuthority(wsUrlOf(status))
      if (address !== '') {
        parts.push(address, tokenState)
        return `${parts.join(' · ')}${advertised}`
      }
    }
    if (state.failures.length > 0 || connection === 'offline' || connection === 'error') {
      parts.push('no host found')
      const tried = state.failures.length
      if (tried > 0) parts.push(`${tried} port${tried === 1 ? '' : 's'} tried`)
      parts.push(tokenState)
      return parts.join(' · ')
    }
    parts.push('searching…', tokenState)
    return parts.join(' · ')
  }

  /**
   * One shape for a `status.discovered` row: every field is a string except
   * `port`, and an entry without an origin is dropped. A missing array (an
   * older background) becomes `[]`.
   * @param {unknown} value
   */
  function normalizeDiscovered(value) {
    if (!Array.isArray(value)) return []
    const rows = []
    for (const raw of value) {
      if (raw === null || typeof raw !== 'object') continue
      const host = /** @type {Record<string, unknown>} */ (raw)
      const origin = typeof host.origin === 'string' ? host.origin : ''
      if (origin === '') continue
      rows.push({
        origin,
        instanceId: typeof host.instanceId === 'string' ? host.instanceId : '',
        profile: typeof host.profile === 'string' ? host.profile : '',
        startedAt: typeof host.startedAt === 'string' ? host.startedAt : '',
        focusAt: typeof host.focusAt === 'string' ? host.focusAt : '',
        port: Number.isInteger(host.port) ? host.port : originPort(origin),
      })
    }
    return rows
  }

  /** @param {string} origin */
  function originPort(origin) {
    try {
      const url = new URL(origin)
      return url.port === '' ? 0 : Number(url.port)
    } catch {
      return 0
    }
  }

  /** @param {unknown} value */
  function normalizeFailures(value) {
    if (!Array.isArray(value)) return []
    const rows = []
    for (const raw of value) {
      if (raw === null || typeof raw !== 'object') continue
      const failure = /** @type {Record<string, unknown>} */ (raw)
      rows.push({
        port: Number.isInteger(failure.port) ? failure.port : 0,
        error: typeof failure.error === 'string' ? failure.error : '',
      })
    }
    return rows
  }

  /** The discovery module's description of one host, when it exports one. */
  function describeHostRow(host) {
    const discovery = globalThis.__DSH_ANNO_BG__?.discovery
    if (typeof discovery?.describeHost !== 'function') return ''
    try {
      const described = discovery.describeHost(host)
      return typeof described === 'string' ? described : ''
    } catch {
      return ''
    }
  }

  /**
   * The discovered-hosts block (only for more than one host: a single host is
   * already named in the status line), the scan action, and the failure hint.
   */
  function renderDiscovered() {
    const status = state.status === null || typeof state.status !== 'object' ? {} : state.status
    const mode = modeOf(state.status)
    const connection = typeof status.connection === 'string' ? status.connection : 'idle'
    const hosts = state.discovered
    if (el.discovered !== undefined) el.discovered.hidden = hosts.length <= 1
    if (el['discovered-list'] !== undefined) {
      el['discovered-list'].replaceChildren()
      if (hosts.length > 1) {
        const connectedId = typeof status.instanceId === 'string' ? status.instanceId : ''
        for (const host of hosts) el['discovered-list'].append(buildHostRow(host, connectedId))
      }
    }
    const live = connection === 'connected' || connection === 'open' || connection === 'no-token'
    const nothingAnswered =
      mode === MODE_AUTO && hosts.length === 0 && !live && (state.failures.length > 0 || connection !== 'connecting')
    if (el['discovery-actions'] !== undefined) el['discovery-actions'].hidden = !nothingAnswered
    if (el['discovery-hint'] !== undefined) {
      el['discovery-hint'].hidden = !(mode === MODE_AUTO && hosts.length === 0 && state.failures.length > 0)
    }
  }

  /**
   * One discovered host: profile, origin, when it was last focused, and the
   * action that makes it the preferred one. The connected host is marked, not
   * offered again.
   * @param {{ origin: string, instanceId: string, profile: string, focusAt: string }} host
   * @param {string} connectedId
   */
  function buildHostRow(host, connectedId) {
    const item = document.createElement('li')
    item.className = 'host'
    item.dataset.instanceId = host.instanceId

    const head = document.createElement('div')
    head.className = 'host__head'
    const profile = document.createElement('span')
    profile.className = 'host__profile'
    profile.textContent = host.profile === '' ? 'unnamed profile' : host.profile
    head.append(profile)
    const origin = document.createElement('span')
    origin.className = 'host__origin'
    origin.textContent = hostAuthority(host.origin)
    head.append(origin)
    const connected = connectedId !== '' && host.instanceId === connectedId
    if (connected) {
      const chip = document.createElement('span')
      chip.className = 'chip chip--resolved'
      chip.textContent = 'connected'
      head.append(chip)
      item.setAttribute('aria-current', 'true')
    }
    item.append(head)

    const foot = document.createElement('div')
    foot.className = 'host__foot'
    const focus = document.createElement('span')
    focus.className = 'host__focus'
    const when = relativeTime(host.focusAt)
    focus.textContent = when === '' ? 'no focus reported' : `focused ${when}`
    foot.append(focus)
    if (!connected) {
      const choose = document.createElement('button')
      choose.type = 'button'
      choose.className = 'button button--secondary host__choose'
      choose.dataset.chooseHost = host.instanceId
      choose.disabled = state.pendingHost !== '' || host.instanceId === ''
      choose.textContent = state.pendingHost === host.instanceId ? 'Switching…' : 'Use this host'
      const name = host.profile === '' ? 'this host' : host.profile
      choose.setAttribute('aria-label', `Use ${name} at ${hostAuthority(host.origin)}`)
      foot.append(choose)
    }
    item.append(foot)
    const described = describeHostRow(host)
    if (described !== '') item.title = described
    return item
  }

  /** @param {MouseEvent} event */
  function onHostsClick(event) {
    const target = event.target instanceof Element ? event.target : null
    if (target === null) return
    const button = target.closest('button[data-choose-host]')
    if (!(button instanceof HTMLButtonElement)) return
    const instanceId = button.dataset.chooseHost ?? ''
    if (instanceId !== '') void chooseHost(instanceId)
  }

  /**
   * Make one discovered host the preferred one. The background stores
   * `anno.prefs.preferredInstanceId`, reconnects, and answers with the new
   * status, which is what marks the row.
   * @param {string} instanceId
   */
  async function chooseHost(instanceId) {
    if (state.pendingHost !== '') return
    const host = state.discovered.find((item) => item.instanceId === instanceId)
    state.pendingHost = instanceId
    renderDiscovered()
    try {
      const response = await send(MSG.TO_BACKGROUND_POPUP.chooseHost, { instanceId })
      if (response === null || typeof response !== 'object' || response.ok !== true) {
        feedback(response?.error ?? 'The background did not switch to that host.', 'error')
        return
      }
      if (response.status !== undefined) applyStatus(response.status)
      const name = host === undefined || host.profile === '' ? 'the chosen host' : host.profile
      feedback(`Switching to ${name}.`, 'ok')
    } finally {
      state.pendingHost = ''
      renderDiscovered()
    }
  }

  /** One discovery round on demand; the failing state is exactly when it is offered. */
  async function scanAgain() {
    if (state.scanning) return
    state.scanning = true
    if (el['scan-again'] !== undefined) {
      el['scan-again'].disabled = true
      el['scan-again'].textContent = 'Scanning…'
    }
    feedback('Scanning for a host on loopback…', 'info')
    try {
      const response = await send(MSG.TO_BACKGROUND_POPUP.scan)
      if (response === null || typeof response !== 'object' || response.ok !== true) {
        feedback(response?.error ?? 'The scan did not run.', 'error')
        return
      }
      if (response.status !== undefined) applyStatus(response.status)
      const hosts = Array.isArray(response.hosts) ? response.hosts : []
      feedback(
        hosts.length === 0
          ? 'No host answered the scan.'
          : `${hosts.length} ${hosts.length === 1 ? 'host' : 'hosts'} answered the scan.`,
        hosts.length === 0 ? 'warn' : 'ok',
      )
    } finally {
      state.scanning = false
      if (el['scan-again'] !== undefined) {
        el['scan-again'].disabled = false
        el['scan-again'].textContent = 'Scan again'
      }
    }
  }

  // ── endpoint import ───────────────────────────────────────────────────────

  /** The drag counter: nested dragenter/dragleave pairs must not flicker the highlight. */
  let dragDepth = 0

  /** @param {boolean} active */
  function setDropActive(active) {
    if (el['drop-zone'] !== undefined) el['drop-zone'].classList.toggle('dropzone--active', active)
  }

  function openImportPicker() {
    if (state.importing || el['import-file'] === undefined) return
    el['import-file'].click()
  }

  /** @param {KeyboardEvent} event */
  function onDropZoneKeyDown(event) {
    if (event.target !== el['drop-zone']) return
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
    event.preventDefault()
    openImportPicker()
  }

  /** @param {DragEvent} event */
  function onDragEnter(event) {
    event.preventDefault()
    dragDepth += 1
    setDropActive(true)
  }

  /** @param {DragEvent} event */
  function onDragOver(event) {
    event.preventDefault()
    const transfer = event.dataTransfer
    if (transfer !== null && transfer !== undefined) transfer.dropEffect = 'copy'
    setDropActive(true)
  }

  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) setDropActive(false)
  }

  /** @param {DragEvent} event */
  function onDrop(event) {
    event.preventDefault()
    dragDepth = 0
    setDropActive(false)
    const file = event.dataTransfer?.files?.[0]
    if (file !== undefined) void importEndpointFile(file)
  }

  /** @param {Event} event */
  function onImportFileChange(event) {
    const input = event.target
    if (!(input instanceof HTMLInputElement)) return
    const file = input.files?.[0]
    // Clearing the value lets the same file be picked again after an error.
    input.value = ''
    if (file !== null && file !== undefined) void importEndpointFile(file)
  }

  /**
   * Read one picked or dropped endpoint record: parse it, validate it with the
   * background's own parser, hand the address over, and fill the fields for
   * manual use. The token field is never read or written.
   * @param {File} file
   */
  async function importEndpointFile(file) {
    if (state.importing) return
    state.importing = true
    setDropActive(false)
    if (el['drop-zone'] !== undefined) el['drop-zone'].setAttribute(BUSY_ATTRIBUTE, 'true')
    const name = typeof file.name === 'string' && file.name !== '' ? file.name : 'That file'
    try {
      let raw = ''
      try {
        raw = await file.text()
      } catch (error) {
        feedback(`Could not read ${name}: ${describeError(error)}`, 'error')
        return
      }
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        feedback(`${name} is not valid JSON.`, 'error')
        return
      }
      const discovery = globalThis.__DSH_ANNO_BG__?.discovery
      if (typeof discovery?.parseEndpointRecord !== 'function') {
        feedback('The discovery parser did not load; reopen the popup.', 'error')
        return
      }
      let record
      try {
        record = discovery.parseEndpointRecord(body)
      } catch (error) {
        feedback(`${name} could not be validated: ${describeError(error)}`, 'error')
        return
      }
      if (record === null || typeof record !== 'object' || typeof record.origin !== 'string' || record.origin === '') {
        feedback(
          `${name} is not a DSH endpoint record: it must be a copy of $DSH_HOME/ext-bridge-endpoint.json (app, version, instance id, loopback origin).`,
          'error',
        )
        return
      }
      const profile = typeof record.profile === 'string' ? record.profile : ''
      const instanceId = typeof record.instanceId === 'string' ? record.instanceId : ''
      const response = await send(MSG.TO_BACKGROUND_POPUP.importRecord, {
        origin: record.origin,
        instanceId,
        profile,
        startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
      })
      if (response === null || typeof response !== 'object' || response.ok !== true) {
        feedback(response?.error ?? 'The background did not accept the imported address.', 'error')
        return
      }
      state.imported = { origin: record.origin, instanceId, profile }
      fillAddressFromOrigin(record.origin)
      renderImportState()
      if (response.status !== undefined) applyStatus(response.status)
      feedback(`Imported ${record.origin} (${profile === '' ? 'unnamed profile' : profile})`, 'ok')
    } finally {
      state.importing = false
      if (el['drop-zone'] !== undefined) el['drop-zone'].removeAttribute(BUSY_ATTRIBUTE)
    }
  }

  /** Show the last imported record on the drop zone, so an old import stays visible. */
  function renderImportState() {
    if (el['drop-zone'] === undefined) return
    const imported = state.imported
    if (imported === null || typeof imported !== 'object') {
      el['drop-zone'].removeAttribute('title')
      return
    }
    const profile = typeof imported.profile === 'string' && imported.profile !== '' ? ` (${imported.profile})` : ''
    el['drop-zone'].title = `Last imported: ${imported.origin}${profile}`
  }

  /**
   * Put an imported origin in the address fields. The mode and the token are
   * left exactly as they were: the record carries an address, never a secret.
   * @param {string} origin
   */
  function fillAddressFromOrigin(origin) {
    if (ENDPOINTS === undefined) return
    const parsed = ENDPOINTS.parseAddress(origin)
    if (!parsed.ok) return
    if (el.host !== undefined) el.host.value = parsed.host
    if (el.port !== undefined) el.port.value = String(parsed.port)
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
    state.discovered = normalizeDiscovered(status.discovered)
    state.failures = normalizeFailures(status.discoveryFailures)
    // A fresh install may have no stored mode yet: the background's answer is
    // the authority then. A choice the user just made is kept, because a status
    // that predates it must not undo it.
    if (!state.modeKnown && (status.discoveryMode === MODE_AUTO || status.discoveryMode === MODE_MANUAL)) {
      state.mode = status.discoveryMode
    }
    const connection = typeof status.connection === 'string' ? status.connection : 'idle'
    const tone = connectionTone(connection)
    if (el['connection-dot'] !== undefined) el['connection-dot'].className = `dot dot--${tone}`
    if (el['connection-label'] !== undefined)
      el['connection-label'].textContent = CONNECTION_LABELS[connection] ?? 'Bridge state unknown'
    if (el['connection-detail'] !== undefined) el['connection-detail'].textContent = connectionDetail(status)
    renderConnectionMode()
    renderDiscovered()
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
      } catch {
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
