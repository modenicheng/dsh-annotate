/**
 * dsh-marker content script 3/4 (ui) — the session target picker.
 *
 * An annotation is stored for a page, not for a Session, so the composer has to
 * ask where the mention goes. The Host owns the catalog: this part only renders
 * what `setTargets` was given, filters it locally, and reports the chosen id
 * back — a failure to read the list must never block writing the annotation.
 * The picker owns its own reset so the composer does not have to know which
 * nodes or flags are involved in opening and closing it.
 *
 * The picker's second arm is "new session": a pinned action row above the list
 * opens a workspace sub-panel (default / an existing workspace / a brand-new
 * directory). The brand-new directory is chosen, not typed: anchor rows come
 * from the registered workspaces' own paths and parents, and only the optional
 * folder name is written (D26). When the host serves `/ext/anno/dirs` the same
 * panel browses the host's real directories instead (M4.7b); any browse
 * failure falls back to the anchors without losing the panel. Confirming a
 * workspace targets a session the Host will create at send time; the choice
 * travels to `main.js` through `handlers.onTargetNew`.
 */
;(function installUiTarget(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  const ui = (ns.ui = ns.ui || {})
  if (ui.target) return

  /**
   * @param {any} ctx
   */
  function install(ctx) {
    const { t, state, handlers, dom } = ctx
    const { createElement, setVisible, fill } = dom

    const target = createElement('div', 'target')
    const targetButton = createElement('button', 'target-btn')
    targetButton.type = 'button'
    const targetKey = createElement('span', 'target-key', t('targetChoose'))
    const targetValue = createElement('span', 'target-value', '')
    const targetCaret = createElement('span', 'target-caret', '▾')
    targetButton.append(targetKey, targetValue, targetCaret)
    const targetPanel = createElement('div', 'target-panel')
    const targetSearch = createElement('input', 'target-search')
    targetSearch.type = 'search'
    targetSearch.setAttribute('aria-label', t('targetSearch'))
    targetSearch.placeholder = t('targetSearch')
    const targetList = createElement('div', 'target-list')
    targetList.setAttribute('role', 'listbox')

    // The "new session" arm lives above the list: it is an action, not one of
    // the options, so it never takes part in the listbox's arrow navigation —
    // a keyboard user reaches it with Tab, exactly like the search field.
    const targetNewRow = createElement('button', 'target-row target-new')
    targetNewRow.type = 'button'
    targetNewRow.append(createElement('span', 'target-row-title', t('targetNewRow')))

    // The workspace sub-panel replaces the list while it is open. Its rows are
    // an immediate choice, not a draft: picking one confirms the new-session
    // target and closes the panel, the same shape as choosing a Session.
    const targetNewPanel = createElement('div', 'target-new-panel')
    const targetNewHead = createElement('div', 'target-new-head')
    const targetNewBack = createElement('button', 'target-back', t('targetBack'))
    targetNewBack.type = 'button'
    const targetNewHeadTitle = createElement('span', 'target-new-title', t('targetNewTitle'))
    targetNewHead.append(targetNewBack, targetNewHeadTitle)
    const targetNewOptions = createElement('div', 'target-new-options')
    const targetNewFields = createElement('div', 'target-new-fields')
    // The M4.7b browser: an Up affordance and the current directory above the
    // same scrolling list the anchors use.
    const fsHead = createElement('div', 'target-fs-head')
    const fsUp = createElement('button', 'target-fs-up', t('fsUp'))
    fsUp.type = 'button'
    const fsPathLabel = createElement('span', 'target-fs-path', '')
    fsHead.append(fsUp, fsPathLabel)
    const fsList = createElement('div', 'target-anchor-list')
    const anchorLabel = createElement('div', 'target-new-label', t('workspaceAnchorLabel'))
    const anchorList = createElement('div', 'target-anchor-list')
    const nameLabel = createElement('label', 'target-new-label', t('workspaceNameLabel'))
    const nameInput = createElement('input', 'target-new-name')
    nameInput.type = 'text'
    nameInput.placeholder = t('workspaceNameLabel')
    nameInput.setAttribute('aria-label', t('workspaceNameLabel'))
    nameInput.spellcheck = false
    const titleLabel = createElement('label', 'target-new-label', t('workspaceTitleLabel'))
    const titleInput = createElement('input', 'target-new-title-input')
    titleInput.type = 'text'
    titleInput.placeholder = t('workspaceTitleLabel')
    titleInput.setAttribute('aria-label', t('workspaceTitleLabel'))
    titleInput.spellcheck = false
    const targetNewUse = createElement('button', 'target-new-use', t('workspaceUse'))
    targetNewUse.type = 'button'
    // The typed path is the demoted fallback (D26): anchors are the flow, the
    // manual input covers a host that reported no workspace at all.
    const manualToggle = createElement('button', 'target-new-manual-toggle', t('workspaceManualToggle'))
    manualToggle.type = 'button'
    const pathLabel = createElement('label', 'target-new-label', t('workspacePathLabel'))
    const pathInput = createElement('input', 'target-new-path')
    pathInput.type = 'text'
    pathInput.placeholder = t('workspacePathPlaceholder')
    pathInput.setAttribute('aria-label', t('workspacePathLabel'))
    pathInput.spellcheck = false
    const noAnchorsHint = createElement('div', 'target-new-hint', t('workspaceNoAnchors'))
    targetNewFields.append(
      fsHead,
      fsList,
      anchorLabel,
      anchorList,
      nameLabel,
      nameInput,
      titleLabel,
      titleInput,
      targetNewUse,
      manualToggle,
      pathLabel,
      pathInput,
      noAnchorsHint,
    )
    const targetNewError = createElement('div', 'target-new-error')
    targetNewPanel.append(targetNewHead, targetNewOptions, targetNewFields, targetNewError)
    setVisible(targetNewPanel, false)

    const targetTip = createElement('div', 'target-tip')
    // Absolute and pointer-events:none: it must never take part in layout, or
    // showing it would move the rows under the pointer.
    setVisible(targetTip, false)
    targetPanel.append(targetSearch, targetNewRow, targetList, targetNewPanel)
    target.append(targetButton, targetPanel, targetTip)
    setVisible(targetPanel, false)
    setVisible(target, false)

    /** @param {number} ms */
    function relativeAge(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (seconds < 60) return t('timeNow')
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return fill(t('timeMinutes'), { n: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return fill(t('timeHours'), { n: hours })
      return fill(t('timeDays'), { n: Math.round(hours / 24) })
    }

    /** @param {any} item */
    function targetTitle(item) {
      const title = String((item && item.title) || '').trim()
      if (title !== '') return title
      // An untitled Session is common (titles are a separate fold and can be
      // missing); a raw uuid tells the user nothing.
      const workspace = item && typeof item.workspace === 'object' && item.workspace !== null ? item.workspace : null
      const name = String((workspace && workspace.title) || '').trim()
      return name === '' ? t('targetUntitled') : `${name} · ${t('targetUntitled')}`
    }

    /** The workspace a row belongs to, or '' when the Host did not record one. */
    function targetWorkspace(item) {
      const workspace = item && typeof item.workspace === 'object' && item.workspace !== null ? item.workspace : null
      return String((workspace && workspace.title) || '').trim()
    }

    /**
     * Point the tooltip at one row, without touching layout.
     *
     * Rows are single-line by design: a detail line that appears on hover used
     * to change the list's height, which made the row slide out from under the
     * pointer. The workspace therefore lives in a floating bubble, and which
     * side it takes depends on the room that row has.
     * @param {HTMLElement | null} row
     * @param {any} [item]
     */
    function showTargetTip(row, item) {
      const workspace = targetWorkspace(item)
      if (row === null || workspace === '') {
        setVisible(targetTip, false)
        return
      }
      targetTip.textContent = workspace
      setVisible(targetTip, true)
      const rowRect = row.getBoundingClientRect()
      // The tip is a child of `.target` — its offset parent, and the same box the
      // panel is positioned in. Measuring against the panel instead shifted the
      // bubble up by the button's height, so it sat on the previous row and fell
      // off the clip on the first one.
      const baseRect = target.getBoundingClientRect()
      const width = targetTip.offsetWidth || 120
      const fitsRight = baseRect.right + 8 + width <= document.documentElement.clientWidth - 8
      targetTip.style.top = `${Math.round(rowRect.top - baseRect.top + (rowRect.height - targetTip.offsetHeight) / 2)}px`
      targetTip.style.left = fitsRight ? `${Math.round(baseRect.width + 8)}px` : `${Math.round(-width - 8)}px`
      targetTip.dataset.side = fitsRight ? 'right' : 'left'
    }

    /** @param {number} index */
    function highlight(index) {
      let activeRow = null
      let activeItem
      for (const [at, row] of [...targetList.children].entries()) {
        if (!(row instanceof HTMLElement)) continue
        const on = at === index
        row.dataset.active = on ? '1' : '0'
        if (on) {
          activeRow = row
          activeItem = visibleTargets()[index]
        }
      }
      showTargetTip(activeRow, activeItem)
      return activeRow
    }

    function visibleTargets() {
      const needle = state.targetQuery.trim().toLowerCase()
      if (needle === '') return state.targets
      return state.targets.filter((item) => {
        const workspace = item && typeof item.workspace === 'object' && item.workspace !== null ? item.workspace : null
        return [targetTitle(item), String(item.id), item.cwd || '', workspace?.title || '', workspace?.path || ''].some(
          (value) => String(value).toLowerCase().includes(needle),
        )
      })
    }

    function renderTargetButton() {
      if (state.targetMode === 'new') {
        targetValue.textContent = fill(t('newSessionLabel'), { name: newSessionName() })
        targetButton.title = t('targetNew')
        return
      }
      const current = state.targets.find((item) => item.id === state.targetId)
      targetValue.textContent = current ? targetTitle(current) : state.targetNote || t('targetLatest')
      targetButton.title = current ? targetWorkspace(current) || targetTitle(current) : t('targetHint')
    }

    // ── the "new session" arm ────────────────────────────────────────────────

    /** Workspace rows the Host reported; an older host sends none, which is fine. */
    function workspaces() {
      return Array.isArray(state.workspaces) ? state.workspaces : []
    }

    /**
     * Host locations a new workspace can start from (M4.7a): every registered
     * workspace's own path and its parent, deduplicated, registry order. The
     * paths are host-side truth the picker already holds, so choosing needs no
     * new wire surface at all.
     * @returns {string[]}
     */
    function anchors() {
      const seen = new Set()
      const rows = []
      for (const workspace of workspaces()) {
        if (!workspace || typeof workspace.path !== 'string' || workspace.path === '') continue
        for (const candidate of [workspace.path, parentDirectory(workspace.path)]) {
          if (candidate === null) continue
          const key = anchorKey(candidate)
          if (seen.has(key)) continue
          seen.add(key)
          rows.push(candidate)
        }
      }
      return rows
    }

    /**
     * One step up from a host path, or `null` at a root. Windows and POSIX
     * shapes both parse, because the registry reports the host's own separators.
     * @param {string} path
     * @returns {string | null}
     */
    function parentDirectory(path) {
      const trimmed = path.replace(/[\\/]+$/, '')
      if (trimmed === '') return null
      if (/^[A-Za-z]:$/.test(trimmed)) return null
      const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
      if (cut < 0) return null
      if (cut === 0) return '/'
      const parent = trimmed.slice(0, cut)
      return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent
    }

    /**
     * Join one folder name onto a location, keeping the separator the location
     * itself uses, so the host always receives a native path.
     * @param {string} anchor
     * @param {string} name
     * @returns {string}
     */
    function joinPath(anchor, name) {
      const windows = anchor.includes('\\') || /^[A-Za-z]:/.test(anchor)
      const separator = windows ? '\\' : '/'
      const base = anchor.replace(/[\\/]+$/, '')
      if (base === '') return `${separator}${name}`
      return `${base}${separator}${name}`
    }

    /** Windows-style paths compare the way their filesystem does. */
    function anchorKey(path) {
      return path.includes('\\') || /^[A-Za-z]:/.test(path) ? path.toLowerCase() : path
    }

    /** The short name a location shows; roots show as themselves. */
    function anchorTitle(path) {
      const segments = path.split(/[\\/]/).filter((part) => part !== '')
      return segments[segments.length - 1] ?? path
    }

    /** A folder name is one path segment, never a path or a dot-directory. */
    function isBadName(name) {
      return name === '.' || name === '..' || /[\\/]/.test(name) || name.includes('\0')
    }

    /**
     * What the composer's send button will ask the background to create, or
     * `null` when the target is an existing Session after all.
     * @returns {{ mode: string, workspaceId: string, path: string, title: string } | null}
     */
    function newChoice() {
      if (state.targetMode !== 'new') return null
      return {
        mode: state.newMode || 'default',
        workspaceId: String(state.newWorkspaceId || ''),
        path: String(state.newPath || ''),
        title: String(state.newTitle || ''),
      }
    }

    /** The workspace name shown on the target button once a mode is chosen. */
    function newSessionName() {
      if (state.newMode === 'existing') {
        const workspace = workspaces().find((item) => item && item.id === state.newWorkspaceId)
        return String((workspace && (workspace.title || workspace.path)) || t('workspaceDefault'))
      }
      if (state.newMode === 'new') {
        const path = String(state.newPath || '').trim()
        const segment = path
          .split(/[\\/]/)
          .filter((part) => part !== '')
          .pop()
        return segment || t('workspaceNew')
      }
      return t('workspaceDefault')
    }

    /** @param {string} mode @param {string} [workspaceId] */
    function confirmNewSession(mode, workspaceId) {
      state.targetMode = 'new'
      state.newMode = mode
      state.newWorkspaceId = String(workspaceId || '')
      state.targetId = ''
      state.targetNote = ''
      closeTargetPanel()
      renderTargetButton()
      if (typeof handlers.onTargetNew === 'function') handlers.onTargetNew(newChoice())
    }

    /** Leave the new-session arm without choosing anything. */
    function abandonNewSession() {
      if (state.targetMode !== 'new') return
      state.targetMode = 'pick'
      state.newMode = 'default'
      state.newWorkspaceId = ''
      renderTargetButton()
      if (typeof handlers.onTargetNew === 'function') handlers.onTargetNew(null)
    }

    function renderNewPanel() {
      targetNewOptions.textContent = ''
      targetNewError.textContent = ''
      setVisible(targetNewFields, state.newMode === 'new')

      /**
       * @param {string} mode
       * @param {string} label
       * @param {string} [meta]
       * @param {string} [workspaceId]
       */
      const addOption = (mode, label, meta, workspaceId) => {
        const row = createElement('button', 'target-row target-new-option')
        row.type = 'button'
        row.setAttribute('aria-pressed', state.newMode === mode ? 'true' : 'false')
        row.append(createElement('span', 'target-row-title', label))
        if (meta) row.append(createElement('span', 'target-row-meta', meta))
        row.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          state.newMode = mode
          state.newWorkspaceId = String(workspaceId || '')
          if (mode === 'new') {
            renderNewPanel()
            if (state.newManual === true) pathInput.focus()
            else nameInput.focus()
            return
          }
          confirmNewSession(mode, workspaceId)
        })
        targetNewOptions.appendChild(row)
      }

      addOption('default', t('workspaceDefault'), '')
      for (const workspace of workspaces()) {
        if (!workspace || typeof workspace.id !== 'string' || workspace.id === '') continue
        addOption(
          'existing',
          String(workspace.title || workspace.path || workspace.id),
          String(workspace.path || ''),
          workspace.id,
        )
      }
      addOption('new', t('workspaceNew'), '')
      renderAnchorArea()
    }

    /**
     * The 新建工作区 flow: the Host's real directories when it can browse
     * (M4.7b), anchor rows from its registered paths when it cannot, one
     * optional folder name either way, and the manual path as the demoted
     * fallback for a host that reported no workspace at all.
     */
    function renderAnchorArea() {
      const rows = anchors()
      // Browsing owns the view whenever the host could still answer: ready,
      // mid-probe, or merely capable (the probe follows this render). Only a
      // host that cannot browse at all falls back to anchors or the manual
      // path, so an empty workspace list never forces the typed input first.
      const browseCapable = typeof handlers.onBrowseDirs === 'function' && state.fsUnsupported !== true
      const browseView = state.fsReady === true || state.fsBusy === true || browseCapable
      if (rows.length === 0 && browseCapable !== true) {
        state.newManual = true
        state.newAnchor = ''
      } else if (rows.length > 0 && !rows.some((row) => anchorKey(row) === anchorKey(state.newAnchor))) {
        state.newAnchor = rows[0]
      }
      const manual = state.newManual === true
      const pick = browseView !== true && !manual && rows.length > 0
      const naming = state.fsReady === true ? state.fsPath !== '' : pick

      fsPathLabel.textContent = state.fsPath
      fsList.textContent = ''
      if (browseView) renderFsRows()
      anchorList.textContent = ''
      for (const path of rows) {
        const row = createElement('button', 'target-row target-anchor')
        row.type = 'button'
        row.setAttribute('aria-pressed', anchorKey(path) === anchorKey(state.newAnchor) ? 'true' : 'false')
        row.append(createElement('span', 'target-row-title', anchorTitle(path)))
        row.append(createElement('span', 'target-row-meta', path))
        row.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          state.newAnchor = path
          state.newManual = false
          renderAnchorArea()
        })
        anchorList.appendChild(row)
      }

      setVisible(fsHead, browseView)
      setVisible(fsList, browseView)
      setVisible(anchorLabel, pick)
      setVisible(anchorList, pick)
      setVisible(nameLabel, naming)
      setVisible(nameInput, naming)
      setVisible(targetNewUse, naming || pick || manual)
      setVisible(manualToggle, pick)
      setVisible(pathLabel, manual)
      setVisible(pathInput, manual)
      setVisible(noAnchorsHint, browseView !== true && rows.length === 0)
      startBrowse()
    }

    /** The browse list: loading, an inline error, the roots view, or one level. */
    function renderFsRows() {
      if (state.fsBusy === true || state.fsReady !== true) {
        fsUp.disabled = true
        fsList.appendChild(createElement('div', 'target-empty', t('fsLoading')))
        return
      }
      fsUp.disabled = false
      if (state.fsError !== '') {
        fsList.appendChild(createElement('div', 'target-new-error', state.fsError))
        return
      }
      /** @param {string} label @param {string} path */
      const addRow = (label, path) => {
        const row = createElement('button', 'target-row target-fs-row')
        row.type = 'button'
        row.append(createElement('span', 'target-row-title', label))
        row.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          browseDirs(path)
        })
        fsList.appendChild(row)
      }
      if (Array.isArray(state.fsRoots)) {
        // The roots view is the top: Up has nowhere to go, and the flow starts
        // by picking the home directory or a drive.
        fsUp.disabled = true
        if (state.fsHome !== '') addRow(t('fsHome'), state.fsHome)
        for (const root of state.fsRoots) addRow(String(root), String(root))
        return
      }
      if (state.fsEntries.length === 0) {
        fsList.appendChild(createElement('div', 'target-empty', t('fsEmpty')))
        return
      }
      for (const entry of state.fsEntries) {
        if (!entry || typeof entry.path !== 'string' || entry.path === '') continue
        addRow(String(entry.name || entry.path), entry.path)
      }
      if (state.fsTruncated === true) fsList.appendChild(createElement('div', 'target-empty', t('fsTruncated')))
    }

    /**
     * Begin browsing once per composer open: one probe decides whether the
     * host can browse at all. The landing directory is the newest workspace's
     * parent — the likeliest home for a sibling — and the host's home
     * directory when no workspace exists yet.
     */
    function startBrowse() {
      if (state.fsReady === true || state.fsBusy === true || state.fsUnsupported === true) return
      if (typeof handlers.onBrowseDirs !== 'function') {
        state.fsUnsupported = true
        return
      }
      const newest = workspaces()[0]
      const landing =
        newest && typeof newest.path === 'string' && newest.path !== '' ? parentDirectory(newest.path) : null
      if (landing !== null && landing !== undefined) browseDirs(landing)
      else browseDirs('', true)
    }

    /**
     * Ask the host for one level of its tree. A failure before the first
     * success retires the browser for this open — the anchors are the whole
     * flow then, exactly as M4.7a shipped; a later failure keeps the current
     * level and shows the host's message inline.
     * @param {string} path
     * @param {boolean} [descendHome] after the roots answer, continue into home
     */
    function browseDirs(path, descendHome = false) {
      if (typeof handlers.onBrowseDirs !== 'function') {
        state.fsUnsupported = true
        return
      }
      state.fsBusy = true
      state.fsError = ''
      renderAnchorArea()
      Promise.resolve(handlers.onBrowseDirs(path)).then(
        (reply) => {
          state.fsBusy = false
          // A user who picked the manual path while the probe was in flight
          // has made a choice; honour it rather than swapping the panel.
          if (reply && reply.ok === true && state.newManual !== true) {
            state.fsReady = true
            const roots = Array.isArray(reply.roots) ? reply.roots : null
            state.fsRoots = roots
            state.fsHome = typeof reply.home === 'string' ? reply.home : ''
            state.fsPath = roots !== null ? '' : String(reply.path || path)
            state.fsParent = typeof reply.parent === 'string' ? reply.parent : ''
            state.fsEntries = Array.isArray(reply.entries) ? reply.entries : []
            state.fsTruncated = reply.truncated === true
            if (roots !== null && descendHome === true && state.fsHome !== '') {
              browseDirs(state.fsHome)
              return
            }
          } else if (state.fsReady !== true) {
            state.fsUnsupported = true
          } else {
            state.fsError = String((reply && reply.error) || t('fsFailed'))
          }
          renderAnchorArea()
        },
        () => {
          state.fsBusy = false
          if (state.fsReady !== true) state.fsUnsupported = true
          else state.fsError = t('fsFailed')
          renderAnchorArea()
        },
      )
    }

    function openNewPanel() {
      state.newPanelOpen = true
      state.newMode = 'default'
      state.newWorkspaceId = ''
      setVisible(targetSearch, false)
      setVisible(targetList, false)
      setVisible(targetNewRow, false)
      setVisible(targetNewPanel, true)
      renderNewPanel()
      targetNewBack.focus()
    }

    function closeNewPanel() {
      state.newPanelOpen = false
      setVisible(targetNewPanel, false)
      setVisible(targetSearch, true)
      setVisible(targetList, true)
      setVisible(targetNewRow, true)
      renderTargetList()
      targetSearch.focus()
    }

    /** Reflect the connection: a new session cannot be created offline. */
    function setNewSessionAvailable(available) {
      const enabled = available === true
      if (state.newUnavailable === !enabled) return
      state.newUnavailable = !enabled
      targetNewRow.disabled = !enabled
      targetNewRow.title = enabled ? '' : t('targetNewOffline')
    }

    function renderTargetList() {
      const items = visibleTargets()
      targetList.textContent = ''
      if (state.busy === true && items.length === 0) {
        targetList.appendChild(createElement('div', 'target-empty', t('targetLoading')))
        return
      }
      if (items.length === 0) {
        targetList.appendChild(createElement('div', 'target-empty', state.targetNote || t('targetEmpty')))
        setVisible(targetTip, false)
        return
      }
      if (state.targetActive >= items.length) state.targetActive = 0
      for (const [index, item] of items.entries()) {
        const row = createElement('button', 'target-row')
        row.type = 'button'
        row.setAttribute('role', 'option')
        row.dataset.sessionId = String(item.id)
        row.dataset.active = index === state.targetActive ? '1' : '0'
        row.setAttribute('aria-selected', String(item.id) === state.targetId ? 'true' : 'false')
        // One line, always: title on the left, age on the right. The row's height
        // never depends on the pointer, so hovering cannot move it.
        row.append(
          createElement('span', 'target-row-title', targetTitle(item)),
          createElement('span', 'target-row-time', relativeAge(item.updatedAt)),
        )
        row.addEventListener('pointerenter', () => {
          state.targetActive = index
          highlight(index)
        })
        row.addEventListener('pointerleave', () => {
          const activeRow = highlight(state.targetActive)
          if (activeRow === null) setVisible(targetTip, false)
        })
        row.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          chooseTarget(item.id)
        })
        targetList.appendChild(row)
      }
      highlight(state.targetActive)
    }

    function openTargetPanel() {
      if (state.targetOpen || state.busy) return
      state.targetOpen = true
      state.targetActive = 0
      setVisible(targetPanel, true)
      renderTargetList()
      targetSearch.focus()
      handlers.onTargetRequest()
    }

    function closeTargetPanel() {
      if (!state.targetOpen) return
      state.targetOpen = false
      state.newPanelOpen = false
      setVisible(targetPanel, false)
      setVisible(targetNewPanel, false)
      setVisible(targetSearch, true)
      setVisible(targetList, true)
      setVisible(targetNewRow, true)
      targetSearch.value = ''
      state.targetQuery = ''
    }

    /** @param {string} id */
    function chooseTarget(id) {
      abandonNewSession()
      state.targetId = String(id)
      state.targetNote = ''
      closeTargetPanel()
      renderTargetButton()
      handlers.onTarget(state.targetId)
    }

    /**
     * Adopt the catalog for the current composer. The default target follows the
     * Host's most recently active Session until the user picks another one.
     * @param {any[]} items
     * @param {string} [defaultId]
     * @param {string} [note] Failure text shown in place of rows.
     * @param {any[]} [workspacesList] Registered workspaces for the new-session arm.
     */
    function setTargets(items, defaultId, note, workspacesList) {
      state.targets = Array.isArray(items) ? items : []
      state.targetNote = String(note || '')
      state.workspaces = Array.isArray(workspacesList) ? workspacesList : []
      if (state.targetMode === 'new' && state.newMode === 'existing') {
        // A workspace that disappeared is not a choice any more; the arm keeps
        // working on the default rather than silently targeting nothing.
        if (!state.workspaces.some((item) => item && item.id === state.newWorkspaceId)) {
          state.newMode = 'default'
          state.newWorkspaceId = ''
          renderTargetButton()
          if (typeof handlers.onTargetNew === 'function') handlers.onTargetNew(newChoice())
        }
      }
      if (state.targetId === '' && typeof defaultId === 'string' && defaultId !== '') state.targetId = defaultId
      if (state.targetId !== '' && !state.targets.some((item) => item.id === state.targetId)) {
        // A target that disappeared from the catalog is not a choice any more.
        state.targetId = typeof defaultId === 'string' ? defaultId : ''
      }
      setVisible(
        target,
        state.composerOpen && (state.targets.length > 0 || state.targetNote !== '' || state.targetMode === 'new'),
      )
      renderTargetButton()
      if (state.targetOpen) {
        if (state.newPanelOpen === true) renderNewPanel()
        else renderTargetList()
      }
    }

    /** Opening the composer starts with no query, no panel and no chosen row. */
    function resetForOpen() {
      state.targetQuery = ''
      state.targetActive = 0
      state.targetOpen = false
      state.targetMode = 'pick'
      state.newPanelOpen = false
      state.newMode = 'default'
      state.newWorkspaceId = ''
      state.newPath = ''
      state.newTitle = ''
      state.newAnchor = ''
      state.newManual = false
      state.fsReady = false
      state.fsUnsupported = false
      state.fsBusy = false
      state.fsPath = ''
      state.fsParent = ''
      state.fsEntries = []
      state.fsRoots = null
      state.fsHome = ''
      state.fsTruncated = false
      state.fsError = ''
      targetSearch.value = ''
      pathInput.value = ''
      nameInput.value = ''
      titleInput.value = ''
      targetNewError.textContent = ''
      setVisible(targetNewPanel, false)
      setVisible(targetSearch, true)
      setVisible(targetList, true)
      setVisible(targetNewRow, true)
      setVisible(targetPanel, false)
      setVisible(target, false)
      if (typeof handlers.onTargetNew === 'function') handlers.onTargetNew(null)
    }

    /** Closing the composer abandons the picker without touching the catalog. */
    function resetForClose() {
      state.targetOpen = false
      state.targetQuery = ''
      state.targetMode = 'pick'
      state.newPanelOpen = false
      setVisible(targetNewPanel, false)
      setVisible(targetSearch, true)
      setVisible(targetList, true)
      setVisible(targetNewRow, true)
      setVisible(targetPanel, false)
      setVisible(target, false)
    }

    targetButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (state.targetOpen) closeTargetPanel()
      else openTargetPanel()
    })
    targetNewRow.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (targetNewRow.disabled) return
      openNewPanel()
    })
    targetNewBack.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      closeNewPanel()
    })
    /** Refuse a folder name that is really a path, keeping the panel open. */
    function refuseBadName() {
      targetNewError.textContent = t('workspaceNameInvalid')
      nameInput.focus()
    }

    targetNewUse.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const name = nameInput.value.trim()
      if (state.fsReady === true && state.newManual !== true) {
        if (isBadName(name)) {
          refuseBadName()
          return
        }
        state.newPath = name === '' ? state.fsPath : joinPath(state.fsPath, name)
      } else if (state.newManual === true || anchors().length === 0) {
        const path = pathInput.value.trim()
        if (path === '') {
          targetNewError.textContent = t('workspacePathRequired')
          pathInput.focus()
          return
        }
        state.newPath = path
      } else {
        if (isBadName(name)) {
          refuseBadName()
          return
        }
        state.newPath = name === '' ? state.newAnchor : joinPath(state.newAnchor, name)
      }
      targetNewError.textContent = ''
      state.newTitle = titleInput.value.trim()
      confirmNewSession('new')
    })
    fsUp.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      // `fsParent === ''` at a filesystem top means the roots view is Up.
      browseDirs(Array.isArray(state.fsRoots) ? '' : state.fsParent)
    })
    manualToggle.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      state.newManual = !(state.newManual === true)
      renderAnchorArea()
    })
    nameInput.addEventListener('input', () => {
      if (targetNewError.textContent !== '') targetNewError.textContent = ''
    })
    pathInput.addEventListener('input', () => {
      state.newPath = pathInput.value.trim()
      if (targetNewError.textContent !== '') targetNewError.textContent = ''
    })
    titleInput.addEventListener('input', () => {
      state.newTitle = titleInput.value.trim()
    })
    targetSearch.addEventListener('input', () => {
      state.targetQuery = targetSearch.value
      state.targetActive = 0
      renderTargetList()
    })
    // The whole picker answers the keyboard, not just the search field: after a
    // Tab lands on a row the arrows must still move the selection.
    target.addEventListener(
      'keydown',
      (event) => {
        const items = visibleTargets()
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (state.newPanelOpen === true) closeNewPanel()
          else closeTargetPanel()
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (items.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          const step = event.key === 'ArrowDown' ? 1 : -1
          state.targetActive = (state.targetActive + step + items.length) % items.length
          highlight(state.targetActive)
          return
        }
        if (event.key === 'Enter') {
          const item = items[state.targetActive]
          if (item === undefined) return
          event.preventDefault()
          event.stopPropagation()
          chooseTarget(item.id)
        }
      },
      true,
    )

    return {
      row: target,
      panel: targetPanel,
      search: targetSearch,
      setTargets,
      setNewSessionAvailable,
      newChoice,
      resetForOpen,
      resetForClose,
    }
  }

  ui.target = { install }
})(globalThis)
