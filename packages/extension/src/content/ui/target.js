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
 * directory). Confirming a workspace targets a session the Host will create at
 * send time; the choice travels to `main.js` through `handlers.onTargetNew`.
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
    const pathLabel = createElement('label', 'target-new-label', t('workspacePathLabel'))
    const pathInput = createElement('input', 'target-new-path')
    pathInput.type = 'text'
    pathInput.placeholder = t('workspacePathPlaceholder')
    pathInput.setAttribute('aria-label', t('workspacePathLabel'))
    pathInput.spellcheck = false
    const titleLabel = createElement('label', 'target-new-label', t('workspaceTitleLabel'))
    const titleInput = createElement('input', 'target-new-title-input')
    titleInput.type = 'text'
    titleInput.placeholder = t('workspaceTitleLabel')
    titleInput.setAttribute('aria-label', t('workspaceTitleLabel'))
    titleInput.spellcheck = false
    const targetNewUse = createElement('button', 'target-new-use', t('workspaceUse'))
    targetNewUse.type = 'button'
    targetNewFields.append(pathLabel, pathInput, titleLabel, titleInput, targetNewUse)
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
            pathInput.focus()
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
      targetSearch.value = ''
      pathInput.value = ''
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
    targetNewUse.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const path = pathInput.value.trim()
      if (path === '') {
        targetNewError.textContent = t('workspacePathRequired')
        pathInput.focus()
        return
      }
      targetNewError.textContent = ''
      state.newPath = path
      state.newTitle = titleInput.value.trim()
      confirmNewSession('new')
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
