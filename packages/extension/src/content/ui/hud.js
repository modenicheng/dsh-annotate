/**
 * dsh-marker content script 3/4 (ui) — the HUD, the pick banner and toasts.
 *
 * The HUD is the only chrome that tells the user which mode is armed and what
 * the gesture is, so it is also where the bulk-clear actions live. Those are
 * destructive, which is why `清空全部` arms on the first click and only deletes
 * on the second: the same button that shows the count is the one that asks for
 * confirmation.
 */
;(function installUiHud(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  const ui = (ns.ui = ns.ui || {})
  if (ui.hud) return

  /**
   * @param {any} ctx
   */
  function install(ctx) {
    const { t, state, handlers, dom } = ctx
    const { createElement, setVisible, fill } = dom

    const hud = createElement('div', 'hud')
    const hudDot = createElement('span', 'hud-dot')
    const hudMode = createElement('span', 'hud-mode')
    const hudHint = createElement('span', 'hud-hint')
    const hudClearResolved = createElement('button', 'hud-btn')
    hudClearResolved.type = 'button'
    const hudClearAll = createElement('button', 'hud-btn')
    hudClearAll.type = 'button'
    const hudToggle = createElement('button', 'hud-btn')
    hudToggle.type = 'button'
    const hudExit = createElement('button', 'hud-btn', 'Esc')
    hudExit.type = 'button'
    hudExit.title = t('exit')
    hud.append(hudDot, hudMode, hudHint, hudClearResolved, hudClearAll, hudToggle, hudExit)

    const pick = createElement('div', 'pick')
    const pickText = createElement('div', 'pick-text')
    const pickMeta = createElement('div', 'pick-meta')
    pick.append(pickText, pickMeta)

    const toastNode = createElement('div', 'toast')

    function modeLabel() {
      if (state.mode === 'selection') return t('modeSelection')
      if (state.mode === 'element') return t('modeElement')
      if (state.mode === 'region') return t('modeRegion')
      return t('modeAuto')
    }

    function hintLabel() {
      if (state.mode === 'selection') return t('hintSelection')
      if (state.mode === 'element') return t('hintElement')
      if (state.mode === 'region') return t('hintRegion')
      return t('hintAuto')
    }

    function syncHud() {
      setVisible(hud, state.hudVisible)
      hudMode.textContent = modeLabel()
      hudHint.textContent = hintLabel()
      hudDot.dataset.state = state.connected === 'ok' || state.connected === 'warn' ? state.connected : 'off'
      hudToggle.textContent = state.hidden ? t('showLayers') : t('hideLayers')
      hudToggle.setAttribute('aria-pressed', state.hidden ? 'true' : 'false')
      hudToggle.title = hudToggle.textContent
      hudExit.title = t('exit')
      syncClearButtons()
    }

    function clearProgressLabel() {
      if (state.clearTotal <= 0) return t('clearing')
      return `${t('clearing')} ${Math.min(state.clearProgress, state.clearTotal)}/${state.clearTotal}`
    }

    function countLabel(label, count) {
      return count > 0 ? `${label} (${count})` : label
    }

    /**
     * The two bulk actions live in the HUD and only exist while annotation mode
     * is on. `清空全部` is destructive enough to need a second click: the first
     * click arms it for a few seconds, the second one deletes.
     */
    function syncClearButtons() {
      const counts = state.counts
      const busy = state.clearing !== ''
      const armed = state.clearArmed === 'all'
      // Hidden layers cannot be reviewed before deleting them, so the bulk
      // actions only exist while the markers are on screen.
      const hasAnything = counts.total > 0 && !state.hidden
      setVisible(hudClearResolved, hasAnything)
      setVisible(hudClearAll, hasAnything)
      hudClearResolved.textContent =
        state.clearing === 'resolved' ? clearProgressLabel() : countLabel(t('clearResolved'), counts.resolved)
      hudClearResolved.disabled = busy || counts.resolved === 0
      hudClearResolved.title = t('clearResolved')
      if (state.clearing === 'all') hudClearAll.textContent = clearProgressLabel()
      else if (armed) hudClearAll.textContent = fill(t('clearConfirm'), { n: counts.total })
      else hudClearAll.textContent = countLabel(t('clearAll'), counts.total)
      hudClearAll.disabled = busy || counts.total === 0
      hudClearAll.dataset.armed = armed ? '1' : '0'
      hudClearAll.title = armed ? fill(t('clearConfirm'), { n: counts.total }) : t('clearAll')
    }

    function disarmClear() {
      if (state.clearTimer) {
        ctx.global.clearTimeout(state.clearTimer)
        state.clearTimer = 0
      }
      if (state.clearArmed === '') return
      state.clearArmed = ''
      syncClearButtons()
    }

    function armClear() {
      state.clearArmed = 'all'
      syncClearButtons()
      if (state.clearTimer) ctx.global.clearTimeout(state.clearTimer)
      state.clearTimer = ctx.global.setTimeout(() => {
        state.clearTimer = 0
        disarmClear()
      }, 5000)
    }

    function setHud(options) {
      const next = options || {}
      if (next.visible !== undefined) {
        const wasVisible = state.hudVisible
        state.hudVisible = next.visible === true
        // Leaving annotation mode must not leave a pinned card (or an armed
        // bulk delete) pointing at a HUD that is gone.
        if (wasVisible && !state.hudVisible) {
          ctx.badges.closeAllBadgeCards()
          disarmClear()
        }
      }
      if (next.mode !== undefined) state.mode = next.mode || 'auto'
      if (next.connected !== undefined) state.connected = next.connected || ''
      if (next.counts !== undefined) {
        const counts = next.counts || {}
        state.counts = {
          total: Math.max(0, Math.trunc(Number(counts.total) || 0)),
          resolved: Math.max(0, Math.trunc(Number(counts.resolved) || 0)),
        }
        if (state.counts.total === 0) disarmClear()
      }
      syncHud()
    }

    function setPickBanner(info) {
      if (!info) {
        setVisible(pick, false)
        return
      }
      pickText.textContent = String(info.prompt || '')
      const parts = [t('pickTitle')]
      if (info.mode && info.mode !== 'auto') parts.push(modeLabelFor(info.mode))
      parts.push(t('pickCancelHint'))
      pickMeta.textContent = parts.join(' · ')
      setVisible(pick, true)
    }

    function modeLabelFor(mode) {
      if (mode === 'selection') return t('modeSelection')
      if (mode === 'element') return t('modeElement')
      if (mode === 'region') return t('modeRegion')
      return t('modeAuto')
    }

    /**
     * Write one transient line into the toast element. It is named for what it
     * does because `toast` below is the element, and appending the wrong one to
     * the shadow root turns a function into page text.
     */
    function showToast(message, tone) {
      const text = String(message || '')
      if (text === '') return
      toastNode.textContent = text
      toastNode.dataset.tone = tone === 'error' ? 'error' : tone === 'ok' ? 'ok' : 'info'
      setVisible(toastNode, true)
      if (state.toastTimer) ctx.global.clearTimeout(state.toastTimer)
      state.toastTimer = ctx.global.setTimeout(() => {
        state.toastTimer = 0
        setVisible(toastNode, false)
      }, 2800)
    }

    /** @param {boolean} busy @param {'all'|'resolved'} [kind] */
    function setClearBusy(busy, kind) {
      state.clearing = busy === true ? (kind === 'all' ? 'all' : 'resolved') : ''
      if (busy !== true) {
        state.clearProgress = 0
        state.clearTotal = 0
      }
      syncClearButtons()
    }

    function setClearProgress(done, total) {
      state.clearProgress = Math.max(0, Math.trunc(Number(done) || 0))
      state.clearTotal = Math.max(0, Math.trunc(Number(total) || 0))
      syncClearButtons()
    }

    /** Initial paint: the HUD, the pick banner and the toast appear on demand. */
    function hide() {
      setVisible(hud, false)
      setVisible(pick, false)
      setVisible(toastNode, false)
    }

    hud.addEventListener('click', (event) => event.stopPropagation())
    pick.addEventListener('click', (event) => event.stopPropagation())

    hudToggle.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      handlers.onToggleHidden()
    })
    hudExit.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      handlers.onExit()
    })
    hudClearResolved.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (state.clearing !== '' || state.counts.resolved === 0) return
      disarmClear()
      handlers.onClear('resolved')
    })
    hudClearAll.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (state.clearing !== '' || state.counts.total === 0) return
      if (state.clearArmed === 'all') {
        disarmClear()
        handlers.onClear('all')
        return
      }
      armClear()
    })

    // The three nodes are exported under their CSS class names (`node` and
    // `pick` above, `toast` here) because `index.js` appends them to the shadow
    // root; `showToast` is the one that writes into the toast. Handing the
    // function to `append()` instead of the element does not throw — it
    // stringifies the body into the page — so the two names stay distinct.
    return {
      node: hud,
      pick,
      toast: toastNode,
      syncHud,
      setHud,
      setPickBanner,
      setClearBusy,
      setClearProgress,
      disarmClear,
      showToast,
      hide,
    }
  }

  ui.hud = { install }
})(globalThis)
