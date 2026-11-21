/**
 * dsh-marker popup — the discovery panel.
 *
 * One component, one boundary: the background `status` object is its only
 * input (`applyStatus`), and its outputs are DOM — the detail line, the mode
 * control, the discovered-host list, and the endpoint drop zone — plus three
 * messages: `anno.popup.scan`, `anno.popup.choose`, and `anno.popup.import`.
 * The mode preference and the host rows belong to this file, so `popup.js`
 * never reads them and keeps only the shell around this panel.
 *
 * A classic script, like the rest of the popup (there is no module loader):
 * `popup.html` loads it before `popup.js`, and it publishes on the popup's
 * shared namespace exactly as the content UI's parts publish on
 * `__DSH_ANNO__`. `attach()` takes the one explicit context object the shell
 * builds, following `src/content/ui/index.js`.
 */
;(() => {
  const ns = (globalThis.__DSH_POPUP__ ??= {})
  if (ns.discovery) return

  const ENDPOINTS = globalThis.__DSH_ANNO_BG__?.endpoints
  /**
   * The background's endpoint-record parser and host descriptions, loaded by
   * popup.html before this file: an imported record is validated with the same
   * code that wrote it.
   */
  const DISCOVERY = globalThis.__DSH_ANNO_BG__?.discovery

  /**
   * The popup keeps one mirror of `src/shared/messages.js`, and it lives in
   * `popup.js`; `attach` receives it, so the panel sends under names it does not
   * declare a second time.
   */

  const I18N = globalThis.__DSH_I18N__
  const LANGUAGE = I18N ? I18N.pickLanguage(I18N.browserLanguage(globalThis)) : 'en'
  const t = I18N ? I18N.make(LANGUAGE) : (key) => key
  const MODE_AUTO = 'auto'
  const MODE_MANUAL = 'manual'
  /**
   * One line under the mode control: the setting has to explain what it does
   * to the fields, because those fields are the same in both modes.
   */
  const MODE_HINTS = {
    auto: t('modeAutoHint'),
    manual: t('modeManualHint'),
  }
  const BUSY_ATTRIBUTE = 'aria-busy'

  /**
   * The nodes this panel owns. The shell's `el` map stops at this boundary, so
   * the panel looks them up itself; the host and port fields stay the shell's
   * and are written through the `el` it passes in.
   */
  const IDS = [
    'connection-detail',
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
  ]

  /**
   * Attach the discovery panel to the popup document.
   *
   * Two shell services come back in the context object. `applyStatus` is needed
   * because a scan, a host choice, or an import answers with a full status: the
   * connection dot, the label, and the outbox are the shell's, so only the
   * shell may paint them. `refreshState` is needed because switching the mode
   * makes the background reconnect, and the page and record panels that the
   * answer refreshes are the shell's too.
   *
   * @param {{
   *   el: Record<string, HTMLElement>,
   *   send: (type: string, payload?: Record<string, unknown>) => Promise<any>,
   *   feedback: (message: string, tone?: 'info' | 'ok' | 'warn' | 'error') => void,
   *   describeError: (error: unknown) => string,
   *   relativeTime: (iso: any) => string,
   *   applyStatus: (status: any) => void,
   *   refreshState: () => Promise<void>,
   * }} host
   * @returns {{
   *   bind: () => void,
   *   applyStatus: (status: any) => void,
   *   setStoredMode: (connection: any) => void,
   * }}
   */
  function attach(host) {
    const {
      el: shellEl,
      send,
      feedback,
      describeError,
      relativeTime,
      applyStatus: applyShellStatus,
      refreshState: refreshShellState,
      messages: MESSAGES,
    } = host

    /** @type {Record<string, HTMLElement>} */
    const el = {}
    for (const id of IDS) {
      const node = document.getElementById(id)
      if (node !== null) el[id] = node
    }

    /**
     * @type {{
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

    /**
     * The last status the shell handed over. A mode change repaints the detail
     * line and the host blocks, which are mode-dependent, and the shell may not
     * have a newer status than the one it just painted.
     */
    let lastStatus = null

    /** The drag counter: nested dragenter/dragleave pairs must not flicker the highlight. */
    let dragDepth = 0

    // ── connection mode ─────────────────────────────────────────────────────

    /** `anno.prefs` as a copy, so a write preserves every key this popup does not own. */
    async function readPrefs() {
      const stored = await browser.storage.local.get(MESSAGES.STORAGE_KEYS.prefs)
      const raw = stored?.[MESSAGES.STORAGE_KEYS.prefs]
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
        await browser.storage.local.set({ [MESSAGES.STORAGE_KEYS.prefs]: prefs })
        // Repaint before the confirmation: the status line and the discovery
        // blocks are mode-dependent, and the background's next broadcast may
        // still describe the previous mode.
        if (lastStatus !== null) applyShellStatus(lastStatus)
        feedback(mode === MODE_AUTO ? 'Automatic discovery on.' : 'Manual address on.', 'ok')
        // The background reconnects on the storage change; give it a moment.
        setTimeout(() => {
          void refreshShellState()
        }, 500)
      } catch (error) {
        state.mode = previousMode
        state.modeKnown = previousKnown
        renderConnectionMode()
        if (lastStatus !== null) applyShellStatus(lastStatus)
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

    // ── status text and discovered hosts ────────────────────────────────────

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
      const tokenState = status.tokenPresent === true ? t('tokenSaved') : t('tokenMissing')
      const advertised = status.wsUrlSource === 'health' ? t('advertisedByHost') : ''
      const parts = [mode === MODE_AUTO ? t('automatic') : t('manual')]
      if (mode !== MODE_AUTO) {
        parts.push(wsUrlOf(status), tokenState)
        return `${parts.join(' · ')}${advertised}`
      }
      const hosts = state.discovered
      if (hosts.length > 0) {
        const row = currentHost(status) ?? hosts[0]
        parts.push(withProfile(hostAuthority(row.origin), row.profile))
        if (hosts.length > 1) parts.push(t('hostsFound', { n: hosts.length }))
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
        parts.push(t('noHostFound'))
        // In auto mode with an explicit address, this is the one place the
        // address can be shown: no host was discovered to name instead.
        const explicit = configuredAuthority(status)
        if (explicit !== '') parts.push(explicit)
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
      if (typeof DISCOVERY?.describeHost !== 'function') return ''
      try {
        const described = DISCOVERY.describeHost(host)
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
      const status = lastStatus === null || typeof lastStatus !== 'object' ? {} : lastStatus
      const mode = modeOf(lastStatus)
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
      profile.textContent = host.profile === '' ? t('unnamedProfile') : host.profile
      head.append(profile)
      const origin = document.createElement('span')
      origin.className = 'host__origin'
      origin.textContent = hostAuthority(host.origin)
      head.append(origin)
      const connected = connectedId !== '' && host.instanceId === connectedId
      if (connected) {
        const chip = document.createElement('span')
        chip.className = 'chip chip--resolved'
        chip.textContent = t('connectedChip')
        head.append(chip)
        item.setAttribute('aria-current', 'true')
      }
      item.append(head)

      const foot = document.createElement('div')
      foot.className = 'host__foot'
      const focus = document.createElement('span')
      focus.className = 'host__focus'
      const when = relativeTime(host.focusAt)
      focus.textContent = when === '' ? t('noFocus') : t('focusedAt', { when })
      foot.append(focus)
      if (!connected) {
        const choose = document.createElement('button')
        choose.type = 'button'
        choose.className = 'button button--secondary host__choose'
        choose.dataset.chooseHost = host.instanceId
        choose.disabled = state.pendingHost !== '' || host.instanceId === ''
        choose.textContent = state.pendingHost === host.instanceId ? t('switchingHost') : t('useHost')
        const name = host.profile === '' ? t('thisHost') : host.profile
        choose.setAttribute('aria-label', t('chooseHostAria', { name, origin: hostAuthority(host.origin) }))
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
        const response = await send(MESSAGES.TO_BACKGROUND_POPUP.chooseHost, { instanceId })
        if (response === null || typeof response !== 'object' || response.ok !== true) {
          feedback(response?.error ?? t('switchFailed'), 'error')
          return
        }
        if (response.status !== undefined) applyShellStatus(response.status)
        const name = host === undefined || host.profile === '' ? t('chosenHost') : host.profile
        feedback(t('switchingTo', { name }), 'ok')
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
        el['scan-again'].textContent = t('scanning')
      }
      feedback(t('scanStarted'), 'info')
      try {
        const response = await send(MESSAGES.TO_BACKGROUND_POPUP.scan)
        if (response === null || typeof response !== 'object' || response.ok !== true) {
          feedback(response?.error ?? t('scanFailed'), 'error')
          return
        }
        if (response.status !== undefined) applyShellStatus(response.status)
        const hosts = Array.isArray(response.hosts) ? response.hosts : []
        feedback(
          hosts.length === 0 ? t('noHostAnswered') : t('hostsAnswered', { n: hosts.length }),
          hosts.length === 0 ? 'warn' : 'ok',
        )
      } finally {
        state.scanning = false
        if (el['scan-again'] !== undefined) {
          el['scan-again'].disabled = false
          el['scan-again'].textContent = t('scanAgain')
        }
      }
    }

    // ── endpoint import ─────────────────────────────────────────────────────

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
      const name = typeof file.name === 'string' && file.name !== '' ? file.name : t('thisFile')
      try {
        let raw = ''
        try {
          raw = await file.text()
        } catch (error) {
          feedback(t('readFileFailed', { name, reason: describeError(error) }), 'error')
          return
        }
        let body
        try {
          body = JSON.parse(raw)
        } catch {
          feedback(t('invalidJson', { name }), 'error')
          return
        }
        if (typeof DISCOVERY?.parseEndpointRecord !== 'function') {
          feedback(t('discoveryParserMissing'), 'error')
          return
        }
        let record
        try {
          record = DISCOVERY.parseEndpointRecord(body)
        } catch (error) {
          feedback(t('validationFailed', { name, reason: describeError(error) }), 'error')
          return
        }
        if (
          record === null ||
          typeof record !== 'object' ||
          typeof record.origin !== 'string' ||
          record.origin === ''
        ) {
          feedback(t('notEndpointRecord', { name }), 'error')
          return
        }
        const profile = typeof record.profile === 'string' ? record.profile : ''
        const instanceId = typeof record.instanceId === 'string' ? record.instanceId : ''
        const response = await send(MESSAGES.TO_BACKGROUND_POPUP.importRecord, {
          origin: record.origin,
          instanceId,
          profile,
          startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
        })
        if (response === null || typeof response !== 'object' || response.ok !== true) {
          feedback(response?.error ?? t('importRejected'), 'error')
          return
        }
        state.imported = { origin: record.origin, instanceId, profile }
        fillAddressFromOrigin(record.origin)
        renderImportState()
        if (response.status !== undefined) applyShellStatus(response.status)
        feedback(
          t('imported', { origin: record.origin, profile: profile === '' ? t('unnamedProfile') : profile }),
          'ok',
        )
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
      el['drop-zone'].title = t('lastImported', { origin: imported.origin, profile })
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
      if (shellEl.host !== undefined) shellEl.host.value = parsed.host
      if (shellEl.port !== undefined) shellEl.port.value = String(parsed.port)
    }

    // ── the panel's public surface ──────────────────────────────────────────

    /** Wire the panel's own controls. The shell calls this once, from `bindEvents`. */
    function bind() {
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
    }

    /**
     * Paint the parts of `/status` this panel owns. The shell has already
     * painted the dot, the label, and the outbox.
     * @param {any} status
     */
    function applyStatus(status) {
      if (status === null || typeof status !== 'object') return
      lastStatus = status
      state.discovered = normalizeDiscovered(status.discovered)
      state.failures = normalizeFailures(status.discoveryFailures)
      // A fresh install may have no stored mode yet: the background's answer is
      // the authority then. A choice the user just made is kept, because a status
      // that predates it must not undo it.
      if (!state.modeKnown && (status.discoveryMode === MODE_AUTO || status.discoveryMode === MODE_MANUAL)) {
        state.mode = status.discoveryMode
      }
      if (el['connection-detail'] !== undefined) el['connection-detail'].textContent = connectionDetail(status)
      renderConnectionMode()
      renderDiscovered()
    }

    /**
     * Adopt `anno.prefs.connection` once the shell has read it. Only a real
     * stored value may override the default or the background's answer; an
     * absent one paints whatever the panel already shows.
     * @param {any} connection
     */
    function setStoredMode(connection) {
      if (connection === MODE_AUTO || connection === MODE_MANUAL) {
        state.mode = connection
        state.modeKnown = true
      }
      renderConnectionMode()
    }

    return { bind, applyStatus, setStoredMode }
  }

  ns.discovery = { attach }
})()
