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
 * The picker's second arm is "new session", and its panel mirrors the
 * picker's own shape (D26): the workspace list first — the ＋ 新建工作区 row
 * pinned above the registered workspaces, one click on a workspace targeting
 * that exact record the way DSH itself would (`existing` + id) — and the ＋
 * row opening the creation form one level deeper. That form is the directory
 * browser: the host's real tree via `/ext/anno/dirs` (M4.7b), starting from
 * the locations view (home, drives) and reaching any absolute path through
 * the breadcrumb. Registration is a property of the directory the user
 * stands on, shown inline: confirming a registered directory targets that
 * workspace (`existing`), any other path registers it (`new` + path). The
 * result line and the confirm button always name the exact path being acted
 * on; a host that cannot browse gets the typed absolute path (checked
 * against the shared protocol rules) instead. The choice travels to
 * `main.js` through `handlers.onTargetNew`.
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
    const { createElement, createIcon, setVisible, fill } = dom

    // material-symbols:arrow-back and :chevron-right from Iconify (Apache-2.0):
    // the back button's icon and the breadcrumb separators.
    const ICON_BACK = 'm7.825 13l5.6 5.6L12 20l-8-8l8-8l1.425 1.4l-5.6 5.6H20v2z'
    const ICON_CHEVRON = 'M12.6 12L8 7.4L9.4 6l6 6l-6 6L8 16.6z'

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

    // The new-session sub-panel replaces the list while it is open: it is one
    // directory browser — navigate anywhere on the host, and the result line
    // always names the exact path the confirm button will act on.
    const targetNewPanel = createElement('div', 'target-new-panel')
    const targetNewHead = createElement('div', 'target-new-head')
    const targetNewBack = createElement('button', 'target-back')
    targetNewBack.type = 'button'
    targetNewBack.append(createIcon(ICON_BACK), createElement('span', 'target-back-text', t('targetBack')))
    // The head is a real breadcrumb — 新建会话 › 工作区 › 位置 — right aligned,
    // every ancestor segment one click away.
    const targetNewCrumb = createElement('nav', 'target-new-crumb')
    targetNewHead.append(targetNewBack, targetNewCrumb)
    const targetNewFields = createElement('div', 'target-new-fields')
    // Level one mirrors the session picker itself: the ＋ 新建工作区 row
    // first, then the registered workspaces — one click targets a workspace,
    // the ＋ row goes one level deeper. Client-side catalog data, so the list
    // works on every Host.
    const targetNewOptions = createElement('div', 'target-new-options')
    // The browser toolbar: climb one level, jump to the host home, and the
    // breadcrumb of ancestors — every segment is a jump, the current directory
    // is plain text. Together with the locations view this reaches any absolute
    // path the host can read.
    const fsToolbar = createElement('div', 'target-fs-head')
    const fsUp = createElement('button', 'target-fs-btn', t('fsUp'))
    fsUp.type = 'button'
    const fsHomeBtn = createElement('button', 'target-fs-btn', t('fsHome'))
    fsHomeBtn.type = 'button'
    const fsCrumb = createElement('div', 'target-fs-crumb')
    fsToolbar.append(fsUp, fsHomeBtn, fsCrumb)
    const fsList = createElement('div', 'target-fs-list')
    const nameLabel = createElement('label', 'target-new-label', t('workspaceNameLabel'))
    const nameInput = createElement('input', 'target-new-name')
    nameInput.type = 'text'
    nameInput.placeholder = t('workspaceNamePlaceholder')
    nameInput.setAttribute('aria-label', t('workspaceNameLabel'))
    nameInput.spellcheck = false
    // The one line the whole arm exists for: the exact absolute path the
    // confirm button will act on, recomputed live while browsing or typing —
    // with the registered-workspace badge when the host already knows it.
    const resultRow = createElement('div', 'target-new-result')
    const resultLabel = createElement('span', 'target-new-result-label', t('workspaceResultLabel'))
    const resultBadge = createElement('span', 'target-new-result-badge', t('workspaceRegistered'))
    const resultPath = createElement('span', 'target-new-result-path', '')
    resultRow.append(resultLabel, resultBadge, resultPath)
    const titleLabel = createElement('label', 'target-new-label', t('workspaceTitleLabel'))
    const titleInput = createElement('input', 'target-new-title-input')
    titleInput.type = 'text'
    titleInput.placeholder = t('workspaceTitleLabel')
    titleInput.setAttribute('aria-label', t('workspaceTitleLabel'))
    titleInput.spellcheck = false
    const targetNewUse = createElement('button', 'target-new-use', t('workspaceChooseLocation'))
    targetNewUse.type = 'button'
    // The typed path is the degraded mode (D26): the only flow on a host that
    // cannot browse, and a power shortcut behind a two-way toggle on one that
    // can — never a dead end.
    const manualToggle = createElement('button', 'target-new-manual-toggle', t('manualToType'))
    manualToggle.type = 'button'
    const pathLabel = createElement('label', 'target-new-label', t('workspacePathLabel'))
    const pathInput = createElement('input', 'target-new-path')
    pathInput.type = 'text'
    pathInput.placeholder = t('workspacePathPlaceholder')
    pathInput.setAttribute('aria-label', t('workspacePathLabel'))
    pathInput.spellcheck = false
    const manualHint = createElement('div', 'target-new-hint', t('fsManualHint'))
    targetNewFields.append(
      fsToolbar,
      fsList,
      nameLabel,
      nameInput,
      resultRow,
      titleLabel,
      titleInput,
      targetNewUse,
      manualToggle,
      pathLabel,
      pathInput,
      manualHint,
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
        // The full path is the one fact worth hovering for: the last segment
        // alone cannot say where the workspace lives.
        targetButton.title = String(state.newPath || t('targetNew'))
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
     * The breadcrumb chain from the filesystem top down to `path`, inclusive:
     * `['D:\\', 'D:\\coding']`, `['/', '/home', '/home/u']`. Every entry but
     * the last is a jump target; the last is where the user stands.
     * @param {string} path
     * @returns {string[]}
     */
    function crumbChain(path) {
      const chain = []
      let current = path
      while (typeof current === 'string' && current !== '') {
        chain.unshift(current)
        current = parentDirectory(current) ?? ''
      }
      return chain
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

    /** The short name a breadcrumb segment shows; roots show as themselves. */
    function lastSegment(path) {
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

    /** The workspace name shown on the target button once a choice is made. */
    function newSessionName() {
      if (state.newMode === 'existing') {
        const workspace = workspaces().find((item) => item && item.id === state.newWorkspaceId)
        return String((workspace && (workspace.title || workspace.path)) || t('targetNew'))
      }
      if (state.newMode === 'new') {
        const path = String(state.newPath || '').trim()
        const segment = path
          .split(/[\\/]/)
          .filter((part) => part !== '')
          .pop()
        return segment || t('targetNew')
      }
      return t('targetNew')
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

    /** Windows-style paths compare the way their filesystem does. */
    function pathKey(path) {
      const trimmed = String(path).replace(/[\\/]+$/, '')
      return trimmed.includes('\\') || /^[A-Za-z]:/.test(trimmed) ? trimmed.toLowerCase() : trimmed
    }

    /**
     * The registered workspace standing at `path`, if any. Registration is a
     * property of the directory, not a choice the user makes: confirming a
     * registered directory targets that exact workspace record — the same one
     * DSH itself would use — instead of registering it a second time.
     * @param {string} path
     */
    function workspaceAt(path) {
      return (
        workspaces().find((item) => item && typeof item.path === 'string' && pathKey(item.path) === pathKey(path)) ??
        null
      )
    }

    /**
     * The sub-panel is two levels, the same shape as the picker itself: the
     * workspace list, then the creation form the ＋ row opens.
     */
    function renderNewSessionPanel() {
      const creating = state.newMode === 'new'
      setVisible(targetNewOptions, !creating)
      setVisible(targetNewFields, creating)
      renderPanelCrumb(creating)
      if (creating) renderBrowseArea()
      else renderWorkspaceOptions()
    }

    /**
     * The head breadcrumb: 新建会话 › 工作区 › 位置. Ancestor segments
     * navigate (the picker, the workspace list); the current one just says
     * where the user stands.
     * @param {boolean} creating
     */
    function renderPanelCrumb(creating) {
      targetNewCrumb.textContent = ''

      /** @param {string} label @param {(() => void) | null} go */
      const addSegment = (label, go) => {
        if (targetNewCrumb.children.length > 0) targetNewCrumb.appendChild(createIcon(ICON_CHEVRON))
        if (go === null) {
          const here = createElement('span', 'target-new-crumb-here', label)
          here.setAttribute('aria-current', 'page')
          targetNewCrumb.appendChild(here)
          return
        }
        const link = createElement('button', 'target-new-crumb-seg', label)
        link.type = 'button'
        link.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          go()
        })
        targetNewCrumb.appendChild(link)
      }

      addSegment(t('crumbNewSession'), closeNewPanel)
      if (creating) {
        addSegment(t('crumbWorkspace'), leaveBrowse)
        addSegment(t('crumbLocation'), null)
      } else {
        addSegment(t('crumbWorkspace'), null)
      }
    }

    /**
     * Level one, mirroring the session picker's own shape: the ＋ 新建工作区
     * row first, then every registered workspace — one click on a workspace
     * targets that exact record (`existing` + id, the same pick DSH itself
     * makes), and the ＋ row opens the creation form one level deeper.
     */
    function renderWorkspaceOptions() {
      targetNewOptions.textContent = ''
      const addRow = createElement('button', 'target-row target-new')
      addRow.type = 'button'
      addRow.append(createElement('span', 'target-row-title', t('workspaceNewRow')))
      addRow.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        state.newMode = 'new'
        renderNewSessionPanel()
        if (state.newManual === true) pathInput.focus()
        else nameInput.focus()
      })
      targetNewOptions.appendChild(addRow)
      for (const workspace of workspaces()) {
        if (!workspace || typeof workspace.id !== 'string' || workspace.id === '') continue
        const path = String(workspace.path || '')
        const row = createElement('button', 'target-row target-ws')
        row.type = 'button'
        // The human title leads; the path — the directory's identity — rides
        // beside it, truncated, and in full on hover.
        row.append(createElement('span', 'target-row-title', String(workspace.title || path || workspace.id)))
        if (path !== '') row.append(createElement('span', 'target-row-meta', path))
        row.title = path
        row.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          targetNewError.textContent = ''
          state.newTitle = titleInput.value.trim()
          confirmNewSession('existing', workspace.id)
        })
        targetNewOptions.appendChild(row)
      }
    }

    /**
     * The folder browser: the host's real directories when it serves
     * `/ext/anno/dirs`, the typed absolute path when it cannot. Whatever the
     * mode, the result line and the confirm button always name the exact path
     * that will be registered — the user never has to predict it.
     */
    function renderBrowseArea() {
      const capable = typeof handlers.onBrowseDirs === 'function' && state.fsUnsupported !== true
      // A host that cannot browse has no other flow: the typed path is the
      // whole screen, and the toggle stays hidden rather than dead-ending.
      state.newManual = state.newManual === true || capable !== true
      const manual = state.newManual === true

      renderCrumb()
      fsList.textContent = ''
      renderFsRows()
      setVisible(fsToolbar, !manual)
      setVisible(fsList, !manual)
      setVisible(nameLabel, !manual)
      setVisible(nameInput, !manual)
      setVisible(pathLabel, manual)
      setVisible(pathInput, manual)
      setVisible(manualHint, capable !== true)
      setVisible(manualToggle, capable)
      manualToggle.textContent = t(manual ? 'manualToBrowse' : 'manualToType')
      renderResult()
      if (capable) startBrowse()
    }

    /** The breadcrumb of the current directory; every ancestor is a jump. */
    function renderCrumb() {
      fsCrumb.textContent = ''
      fsHomeBtn.disabled = state.fsHome === ''
      // The locations view is the virtual top of the world: the crumb always
      // begins there, and Up never climbs past it.
      const top = createElement('button', 'target-fs-seg target-fs-top', t('fsLocations'))
      top.type = 'button'
      top.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        browseDirs('')
      })
      fsCrumb.append(top)
      if (state.fsBusy === true || state.fsReady !== true) {
        fsUp.disabled = true
        return
      }
      if (state.fsError !== '') {
        // Keep the last known location legible beside the error the list carries.
        fsUp.disabled = true
        fsCrumb.append(
          createElement('span', 'target-fs-sep', '›'),
          createElement('span', 'target-fs-here', state.fsPath),
        )
        return
      }
      if (Array.isArray(state.fsRoots)) {
        fsUp.disabled = true
        return
      }
      fsUp.disabled = false
      const chain = crumbChain(state.fsPath)
      for (const [index, path] of chain.entries()) {
        fsCrumb.append(createElement('span', 'target-fs-sep', '›'))
        if (index === chain.length - 1) {
          fsCrumb.append(createElement('span', 'target-fs-here', lastSegment(path)))
          continue
        }
        const jump = createElement('button', 'target-fs-seg', lastSegment(path))
        jump.type = 'button'
        jump.title = path
        jump.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          browseDirs(path)
        })
        fsCrumb.append(jump)
      }
    }

    /**
     * Client-side shape check for the typed path, from the same shared
     * protocol rules the host enforces: catching a relative path here beats a
     * host refusal after the send.
     * @param {string} path
     * @returns {string} '' when usable
     */
    function manualPathError(path) {
      const protocol = globalThis.__DSH_PROTOCOL__
      if (!protocol || typeof protocol.validateDirsPath !== 'function') return ''
      const errors = protocol.validateDirsPath(path)
      return Array.isArray(errors) && errors.length > 0 ? t('workspacePathInvalid') : ''
    }

    /**
     * The live result: the exact path the confirm button will act on, shown
     * as a line — with the registered badge when the host already knows the
     * directory — and again inside the button's own label, so the outcome is
     * readable before anything is committed.
     */
    function renderResult() {
      let path = null
      let action = 'use'
      if (state.newManual === true) {
        path = pathInput.value.trim()
        const invalid = path === '' ? '' : manualPathError(path)
        if (invalid !== '') {
          resultBadge.setAttribute('f-hidden', '')
          resultPath.className = 'target-new-result-path is-invalid'
          resultPath.textContent = invalid
          targetNewUse.disabled = true
          targetNewUse.textContent = t('workspaceChooseLocation')
          return
        }
      } else if (state.fsReady === true && !Array.isArray(state.fsRoots)) {
        const name = nameInput.value.trim()
        if (isBadName(name)) {
          resultBadge.setAttribute('f-hidden', '')
          resultPath.className = 'target-new-result-path is-invalid'
          resultPath.textContent = t('workspaceNameInvalid')
          targetNewUse.disabled = true
          targetNewUse.textContent = t('workspaceChooseLocation')
          return
        }
        path = name === '' ? state.fsPath : joinPath(state.fsPath, name)
        action = name === '' ? 'use' : 'create'
      }
      if (path === null || path === '') {
        resultBadge.setAttribute('f-hidden', '')
        resultPath.className = 'target-new-result-path is-empty'
        resultPath.textContent = t('fsPickLocation')
        targetNewUse.disabled = true
        targetNewUse.textContent = t('workspaceChooseLocation')
        return
      }
      const workspace = workspaceAt(path)
      if (workspace !== null) resultBadge.removeAttribute('f-hidden')
      else resultBadge.setAttribute('f-hidden', '')
      resultPath.className = 'target-new-result-path'
      resultPath.textContent = path
      resultPath.title = path
      targetNewUse.disabled = false
      targetNewUse.textContent = fill(
        t(action === 'create' && workspace === null ? 'workspaceCreateAt' : 'workspaceUseAt'),
        { path },
      )
    }

    /** The browse list: loading, an inline error, the locations view, or one level. */
    function renderFsRows() {
      if (state.fsBusy === true || state.fsReady !== true) {
        fsList.appendChild(createElement('div', 'target-empty', t('fsLoading')))
        return
      }
      if (state.fsError !== '') {
        fsList.appendChild(createElement('div', 'target-new-error', state.fsError))
        return
      }
      /**
       * @param {string} label
       * @param {string} path
       * @param {boolean} [pathFirst]
       */
      const addRow = (label, path, pathFirst) => {
        const row = createElement('button', 'target-row target-fs-row')
        row.type = 'button'
        const titleClass = pathFirst === true ? 'target-row-title target-row-path' : 'target-row-title'
        const title = createElement('span', titleClass, label)
        title.title = path
        row.append(title)
        row.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          browseDirs(path)
        })
        fsList.appendChild(row)
      }
      if (Array.isArray(state.fsRoots)) {
        // The locations view is the top of the world: home first, then the
        // drives. (The registered workspaces are their own group above.)
        if (state.fsHome !== '') addRow(t('fsHome'), state.fsHome)
        for (const root of state.fsRoots) addRow(String(root), String(root), true)
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
     * host can browse at all, and every open starts from the locations view —
     * the known workspaces, the home and the drives — instead of guessing
     * where the user probably wants to be.
     */
    function startBrowse() {
      if (state.fsReady === true || state.fsBusy === true || state.fsUnsupported === true) return
      if (typeof handlers.onBrowseDirs !== 'function') {
        state.fsUnsupported = true
        return
      }
      browseDirs('')
    }

    /**
     * Ask the host for one level of its tree. A failure before the first
     * success retires the browser for this open — the typed absolute path is
     * the whole flow then; a later failure keeps the current level and shows
     * the host's message inline.
     * @param {string} path
     */
    function browseDirs(path) {
      if (typeof handlers.onBrowseDirs !== 'function') {
        state.fsUnsupported = true
        return
      }
      state.fsBusy = true
      state.fsError = ''
      renderBrowseArea()
      Promise.resolve(handlers.onBrowseDirs(path)).then(
        (reply) => {
          state.fsBusy = false
          if (reply && reply.ok === true) {
            // Adopt the level even while the user types a path by hand: the
            // position waits behind the toggle instead of being thrown away.
            state.fsReady = true
            const roots = Array.isArray(reply.roots) ? reply.roots : null
            state.fsRoots = roots
            // Only the locations answer carries `home`; a plain listing must
            // not wipe it, or the home button dies after one jump.
            if (typeof reply.home === 'string') state.fsHome = reply.home
            state.fsPath = roots !== null ? '' : String(reply.path || path)
            state.fsParent = typeof reply.parent === 'string' ? reply.parent : ''
            state.fsEntries = Array.isArray(reply.entries) ? reply.entries : []
            state.fsTruncated = reply.truncated === true
          } else if (state.fsReady !== true) {
            state.fsUnsupported = true
          } else {
            state.fsError = String((reply && reply.error) || t('fsFailed'))
          }
          renderBrowseArea()
        },
        () => {
          state.fsBusy = false
          if (state.fsReady !== true) state.fsUnsupported = true
          else state.fsError = t('fsFailed')
          renderBrowseArea()
        },
      )
    }

    function openNewPanel() {
      state.newPanelOpen = true
      state.newMode = 'default'
      state.newWorkspaceId = ''
      targetNewError.textContent = ''
      setVisible(targetSearch, false)
      setVisible(targetList, false)
      setVisible(targetNewRow, false)
      setVisible(targetNewPanel, true)
      renderNewSessionPanel()
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
        if (state.newPanelOpen === true) renderNewSessionPanel()
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
    /** Return from the creation form to the workspace list without choosing. */
    function leaveBrowse() {
      state.newMode = 'default'
      renderNewSessionPanel()
      targetNewBack.focus()
    }

    /** Refuse a folder name that is really a path, keeping the panel open. */
    function refuseBadName() {
      targetNewError.textContent = t('workspaceNameInvalid')
      nameInput.focus()
    }

    /** Commit the path the result line names; the button is disabled otherwise. */
    function confirmWorkspace() {
      let path = ''
      if (state.newManual === true) {
        path = pathInput.value.trim()
        if (path === '') {
          targetNewError.textContent = t('workspacePathRequired')
          pathInput.focus()
          return
        }
        const invalid = manualPathError(path)
        if (invalid !== '') {
          targetNewError.textContent = invalid
          pathInput.focus()
          return
        }
      } else {
        if (state.fsReady !== true || Array.isArray(state.fsRoots)) return
        const name = nameInput.value.trim()
        if (isBadName(name)) {
          refuseBadName()
          return
        }
        path = name === '' ? state.fsPath : joinPath(state.fsPath, name)
      }
      targetNewError.textContent = ''
      state.newTitle = titleInput.value.trim()
      // A directory the host already registered is targeted as that workspace —
      // the same record DSH itself would use — never registered a second time.
      const workspace = workspaceAt(path)
      if (workspace !== null) {
        state.newPath = ''
        confirmNewSession('existing', workspace.id)
        return
      }
      state.newPath = path
      confirmNewSession('new')
    }

    targetNewBack.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (state.newMode === 'new' && state.newPanelOpen === true) leaveBrowse()
      else closeNewPanel()
    })
    targetNewUse.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      confirmWorkspace()
    })
    fsUp.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      // `fsParent === ''` at a filesystem top means the roots view is Up.
      browseDirs(Array.isArray(state.fsRoots) ? '' : state.fsParent)
    })
    fsHomeBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (state.fsHome !== '') browseDirs(state.fsHome)
    })
    manualToggle.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      state.newManual = !(state.newManual === true)
      renderBrowseArea()
      if (state.newManual === true) pathInput.focus()
      else nameInput.focus()
    })
    nameInput.addEventListener('input', () => {
      if (targetNewError.textContent !== '') targetNewError.textContent = ''
      renderResult()
    })
    pathInput.addEventListener('input', () => {
      if (targetNewError.textContent !== '') targetNewError.textContent = ''
      renderResult()
    })
    titleInput.addEventListener('input', () => {
      state.newTitle = titleInput.value.trim()
    })
    for (const input of [nameInput, pathInput, titleInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        event.stopPropagation()
        confirmWorkspace()
      })
    }
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
          if (state.newPanelOpen === true) {
            // Escape walks the panel backwards: creation form → workspace
            // list → out, one level per press.
            if (state.newMode === 'new') leaveBrowse()
            else closeNewPanel()
          } else closeTargetPanel()
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
