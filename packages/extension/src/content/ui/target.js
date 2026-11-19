/**
 * dsh-annotate content script 3/4 (ui) — the session target picker.
 *
 * An annotation is stored for a page, not for a Session, so the composer has to
 * ask where the mention goes. The Host owns the catalog: this part only renders
 * what `setTargets` was given, filters it locally, and reports the chosen id
 * back — a failure to read the list must never block writing the annotation.
 * The picker owns its own reset so the composer does not have to know which
 * nodes or flags are involved in opening and closing it.
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
    const targetTip = createElement('div', 'target-tip')
    // Absolute and pointer-events:none: it must never take part in layout, or
    // showing it would move the rows under the pointer.
    setVisible(targetTip, false)
    targetPanel.append(targetSearch, targetList)
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
      const panelRect = targetPanel.getBoundingClientRect()
      const width = targetTip.offsetWidth || 120
      const right = panelRect.right + 8
      const fitsRight = right + width <= document.documentElement.clientWidth - 8
      targetTip.style.top = `${Math.round(rowRect.top - panelRect.top + (rowRect.height - targetTip.offsetHeight) / 2)}px`
      targetTip.style.left = fitsRight ? `${Math.round(panelRect.width + 8)}px` : `${Math.round(-width - 8)}px`
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
      const current = state.targets.find((item) => item.id === state.targetId)
      targetValue.textContent = current ? targetTitle(current) : state.targetNote || t('targetLatest')
      targetButton.title = current ? targetWorkspace(current) || targetTitle(current) : t('targetHint')
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
      setVisible(targetPanel, false)
      targetSearch.value = ''
      state.targetQuery = ''
    }

    /** @param {string} id */
    function chooseTarget(id) {
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
     */
    function setTargets(items, defaultId, note) {
      state.targets = Array.isArray(items) ? items : []
      state.targetNote = String(note || '')
      if (state.targetId === '' && typeof defaultId === 'string' && defaultId !== '') state.targetId = defaultId
      if (state.targetId !== '' && !state.targets.some((item) => item.id === state.targetId)) {
        // A target that disappeared from the catalog is not a choice any more.
        state.targetId = typeof defaultId === 'string' ? defaultId : ''
      }
      setVisible(target, state.composerOpen && (state.targets.length > 0 || state.targetNote !== ''))
      renderTargetButton()
      if (state.targetOpen) renderTargetList()
    }

    /** Opening the composer starts with no query, no panel and no chosen row. */
    function resetForOpen() {
      state.targetQuery = ''
      state.targetActive = 0
      state.targetOpen = false
      targetSearch.value = ''
      setVisible(targetPanel, false)
      setVisible(target, false)
    }

    /** Closing the composer abandons the picker without touching the catalog. */
    function resetForClose() {
      state.targetOpen = false
      state.targetQuery = ''
      setVisible(targetPanel, false)
      setVisible(target, false)
    }

    targetButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (state.targetOpen) closeTargetPanel()
      else openTargetPanel()
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
          closeTargetPanel()
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
      resetForOpen,
      resetForClose,
    }
  }

  ui.target = { install }
})(globalThis)
