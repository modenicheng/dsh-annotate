/**
 * dsh-marker content script 3/4 (ui) — the comment card.
 *
 * The card is positioned in viewport pixels next to the outlined target and
 * flipped above it when there is no room below, because the whole point is to
 * keep the anchor visible while the sentence about it is written. The mark is
 * the annotation and the comment is optional, so an empty card is sendable and
 * the primary button says so instead of looking broken.
 */
;(function installUiComposer(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  const ui = (ns.ui = ns.ui || {})
  if (ui.composer) return

  /**
   * @param {any} ctx
   */
  function install(ctx) {
    const { t, state, handlers, dom } = ctx
    const { createElement, setVisible, clamp, viewportSize } = dom

    let composerRect = null

    const composer = createElement('div', 'composer')
    const composerHead = createElement('div', 'composer-head')
    const composerKind = createElement('span', 'composer-kind')
    const composerSummary = createElement('span', 'composer-summary')
    composerHead.append(composerKind, composerSummary)
    const textarea = createElement('textarea')
    textarea.rows = 3
    textarea.spellcheck = false
    const chips = createElement('div', 'chips')
    const composerFoot = createElement('div', 'composer-foot')
    const composerHint = createElement('span', 'composer-hint')
    const composerActions = createElement('div', 'composer-actions')
    const cancelButton = createElement('button', 'btn', t('cancel'))
    cancelButton.type = 'button'
    const sendButton = createElement('button', 'btn btn-primary', t('send'))
    sendButton.type = 'button'
    sendButton.disabled = true
    composerActions.append(cancelButton, sendButton)
    composerFoot.append(composerHint, composerActions)
    const composerError = createElement('div', 'composer-error')
    // The target row is the picker's node; the card only decides where it sits.
    composer.append(composerHead, textarea, chips, ctx.target.row, composerFoot, composerError)

    function composerTitle(kind) {
      if (kind === 'selection') return t('composerSelection')
      if (kind === 'region') return t('composerRegion')
      return t('composerElement')
    }

    function positionComposer(size) {
      const measured = composer.offsetHeight || 190
      const width = Math.min(340, Math.max(240, size.width - 24))
      composer.style.width = `${width}px`
      const margin = 10
      const rect = composerRect
      const left = clamp(rect.x, margin, Math.max(margin, size.width - width - margin))
      let top = rect.y + rect.h + 8
      if (top + measured > size.height - margin) top = rect.y - measured - 8
      top = clamp(top, margin, Math.max(margin, size.height - measured - margin))
      composer.style.left = `${Math.round(left)}px`
      composer.style.top = `${Math.round(top)}px`
    }

    /** Reposition the open card after a scroll or a resize; no card, no work. */
    function position(size) {
      if (!composerRect) return
      positionComposer(size)
    }

    function syncSendState() {
      const text = textarea.value.trim()
      // The mark is the annotation; the comment is optional metadata. An empty
      // composer is therefore sendable, and the label says so instead of
      // leaving an enabled button that looks like it is waiting for words.
      sendButton.disabled = state.busy
      cancelButton.disabled = state.busy
      textarea.disabled = state.busy
      sendButton.textContent = state.busy ? t('sending') : text === '' ? t('sendMark') : t('send')
    }

    function selectIntent(intent) {
      state.intent = state.intent === intent ? '' : intent
      for (const chip of chips.children) {
        const pressed = chip.dataset.intent === state.intent && state.intent !== ''
        chip.setAttribute('aria-pressed', pressed ? 'true' : 'false')
      }
    }

    function buildChips() {
      for (const intent of ctx.global.__DSH_PROTOCOL__.INTENTS) {
        const chip = createElement('button', 'chip', intent)
        chip.type = 'button'
        chip.dataset.intent = intent
        chip.setAttribute('aria-pressed', 'false')
        chip.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          selectIntent(intent)
        })
        chips.appendChild(chip)
      }
    }
    buildChips()

    function submitComposer() {
      if (state.busy) return
      // Trim both ends but keep interior whitespace: an empty result is a
      // sendable annotation that carries the mark alone.
      const text = textarea.value.trim()
      handlers.onSend({ text, intent: state.intent })
    }

    function openComposer(options) {
      const config = options || {}
      state.composerOpen = true
      state.intent = ''
      // The picker never opens with the composer: it starts collapsed and
      // unfiltered, and it hides itself until a catalog answers.
      ctx.target.resetForOpen()
      for (const chip of chips.children) chip.setAttribute('aria-pressed', 'false')
      composerKind.textContent = composerTitle(config.kind)
      composerSummary.textContent = String(config.summary || '')
      composerError.textContent = ''
      setVisible(composerError, false)
      textarea.value = ''
      composerRect = config.rect || { x: 8, y: 8, w: 0, h: 0 }
      setVisible(composer, true)
      syncSendState()
      positionComposer(viewportSize())
      // Fonts/scrollbars settle one frame later; measuring again avoids a card
      // that hangs off the bottom on first paint.
      ctx.global.requestAnimationFrame(() => {
        if (state.composerOpen) positionComposer(viewportSize())
      })
      textarea.focus()
      composerHint.textContent = t('placeholder').split('·')[0].trim()
    }

    function closeComposer() {
      state.composerOpen = false
      state.busy = false
      state.intent = ''
      ctx.target.resetForClose()
      composerRect = null
      setVisible(composer, false)
      composerError.textContent = ''
      setVisible(composerError, false)
      textarea.value = ''
      syncSendState()
      ctx.overlay.clearLocked('composer')
    }

    function setComposerBusy(busy) {
      state.busy = busy === true
      syncSendState()
    }

    function setComposerError(message) {
      const text = String(message || '')
      composerError.textContent = text
      setVisible(composerError, text !== '')
    }

    function isComposerOpen() {
      return state.composerOpen
    }

    function composerText() {
      return textarea.value
    }

    function focusComposer() {
      if (state.composerOpen) textarea.focus()
    }

    textarea.addEventListener('input', () => {
      syncSendState()
      if (composerError.textContent) {
        composerError.textContent = ''
        setVisible(composerError, false)
      }
    })

    textarea.addEventListener('keydown', (event) => {
      // Enter sends, Shift+Enter is a newline, and an in-progress IME
      // composition (Chinese/Japanese input) owns Enter until it commits.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        event.stopPropagation()
        submitComposer()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!state.busy) handlers.onCancel('escape')
      }
    })

    // Keep clicks/keys inside the card from reaching the page or the gesture
    // layer; the host is pointer-events:none but children are not.
    composer.addEventListener('pointerdown', (event) => event.stopPropagation())
    composer.addEventListener('click', (event) => event.stopPropagation())

    sendButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      submitComposer()
    })
    cancelButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!state.busy) handlers.onCancel('button')
    })

    return {
      node: composer,
      openComposer,
      closeComposer,
      setComposerBusy,
      setComposerError,
      isComposerOpen,
      composerText,
      focusComposer,
      position,
    }
  }

  ui.composer = { install }
})(globalThis)
