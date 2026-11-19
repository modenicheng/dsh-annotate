/**
 * dsh-marker content script 3/4 (ui) — the numbered markers and their cards.
 *
 * A marker is a tag pinned in viewport pixels over its anchor's document rect,
 * so scrolling moves it without re-anchoring. Hover opens the card, a short
 * grace period keeps it open while the pointer travels across the gap, and a
 * click pins it so the pointer can rest anywhere while the comment is read (or
 * deleted). A respawn — the agent added a note, the state changed — must not
 * tear an open card from under the pointer, so the open id is restored.
 */
;(function installUiBadges(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  const ui = (ns.ui = ns.ui || {})
  if (ui.badges) return

  /**
   * @param {any} ctx
   */
  function install(ctx) {
    const { t, state, handlers, shadow, host, styles, dom } = ctx
    const { createElement, setVisible, clamp, badgeLabel, viewportSize, scrollOffset } = dom
    const BADGE_PX = styles.BADGE_PX

    /** Grace period for the pointer to travel from a marker onto its card. */
    const BADGE_CLOSE_DELAY_MS = 160

    /** @type {Array<{ item: any, node: HTMLElement, card: HTMLElement, del: HTMLElement }>} */
    let badgeEntries = []

    /**
     * One card is open at a time. Hover opens it, a short grace period keeps it
     * open while the pointer travels, and a click pins it so the pointer can
     * rest anywhere (the delete button is the whole point of the card).
     */
    const badgeHover = { openId: '', pinnedId: '', timer: 0 }

    function stateLabel(value) {
      if (value === 'resolved') return t('stateResolved')
      if (value === 'wont_fix') return t('stateWontFix')
      return t('stateOpen')
    }

    function kindLabel(value) {
      if (value === 'selection') return t('kindSelection')
      if (value === 'element') return t('kindElement')
      if (value === 'region') return t('kindRegion')
      return ''
    }

    /**
     * Paint the hover outline with the badge as its owner. The composer keeps
     * priority: its outline is what the user is writing about.
     */
    function applyBadgeLock(item) {
      if (state.lockHolder === 'composer' || state.hidden) return
      const pageRect = item.pageRect || { x: 0, y: 0, w: 0, h: 0 }
      const scroll = scrollOffset()
      ctx.overlay.setLocked(
        { x: pageRect.x - scroll.x, y: pageRect.y - scroll.y, w: pageRect.w, h: pageRect.h },
        kindLabel(item.kind),
        'badge',
        pageRect,
      )
    }

    function setBadgeOpen(entry, open) {
      if (open) entry.node.dataset.open = '1'
      else entry.node.removeAttribute('data-open')
    }

    function cancelBadgeTimer() {
      if (!badgeHover.timer) return
      ctx.global.clearTimeout(badgeHover.timer)
      badgeHover.timer = 0
    }

    function closeBadgeEntry(entry) {
      cancelBadgeTimer()
      const id = String(entry.item.id)
      setBadgeOpen(entry, false)
      if (badgeHover.openId === id) badgeHover.openId = ''
      if (badgeHover.pinnedId === id) badgeHover.pinnedId = ''
      ctx.overlay.clearLocked('badge')
    }

    /** @returns {boolean} whether anything was open */
    function closeAllBadgeCards() {
      cancelBadgeTimer()
      const had = badgeHover.openId !== '' || badgeHover.pinnedId !== ''
      badgeHover.openId = ''
      badgeHover.pinnedId = ''
      for (const entry of badgeEntries) setBadgeOpen(entry, false)
      ctx.overlay.clearLocked('badge')
      return had
    }

    /**
     * Show one card. `pinned` keeps it open after the pointer leaves; hovering
     * another marker closes whatever was open before.
     */
    function openBadgeCard(entry, pinned) {
      if (state.hidden) return
      cancelBadgeTimer()
      const id = String(entry.item.id)
      for (const other of badgeEntries) {
        if (String(other.item.id) !== id) setBadgeOpen(other, false)
      }
      // Re-entering a pinned marker with the pointer must not silently unpin it.
      if (pinned === true) badgeHover.pinnedId = id
      else if (badgeHover.pinnedId !== id) badgeHover.pinnedId = ''
      badgeHover.openId = id
      setBadgeOpen(entry, true)
      applyBadgeLock(entry.item)
    }

    function scheduleBadgeClose(entry) {
      const id = String(entry.item.id)
      if (badgeHover.pinnedId === id) return
      cancelBadgeTimer()
      badgeHover.timer = ctx.global.setTimeout(() => {
        badgeHover.timer = 0
        if (badgeHover.pinnedId === id) return
        closeBadgeEntry(entry)
      }, BADGE_CLOSE_DELAY_MS)
    }

    function toggleBadgePin(entry) {
      if (badgeHover.pinnedId === String(entry.item.id)) closeBadgeEntry(entry)
      else openBadgeCard(entry, true)
    }

    function buildBadge(item) {
      const node = createElement('div', 'badge', badgeLabel(item.index))
      node.dataset.state = item.state || 'open'
      node.dataset.id = item.id
      // Not `role="img"`: that would make the card's delete button presentational.
      node.setAttribute('role', 'group')
      node.setAttribute('aria-label', `${badgeLabel(item.index)} ${stateLabel(item.state)}`)
      node.title = t('openCard')

      const card = createElement('div', 'badge-card')
      const head = createElement('div', 'badge-card-head')
      const meta = createElement(
        'div',
        'badge-card-meta',
        [stateLabel(item.state), kindLabel(item.kind)].filter(Boolean).join(' · '),
      )
      const del = createElement('button', 'badge-card-del', '×')
      del.type = 'button'
      del.title = t('deleteAnnotation')
      del.setAttribute('aria-label', t('deleteAnnotation'))
      head.append(meta, del)
      card.append(head)
      // An empty comment is a real annotation, so the card falls back to what
      // was marked rather than saying nothing happened.
      card.appendChild(createElement('div', 'badge-card-text', item.comment || item.summary || t('noComment')))
      if (item.note) card.appendChild(createElement('div', 'badge-card-note', `${t('agentNote')}: ${item.note}`))

      node.appendChild(card)
      const entry = { item, node, card, del }
      positionBadge(node, item.pageRect)

      // Hover opens the card; the CSS bridge above the gap plus the close delay
      // keep it alive while the pointer travels from the marker onto the card.
      node.addEventListener('pointerenter', () => openBadgeCard(entry, false))
      node.addEventListener('pointerleave', () => scheduleBadgeClose(entry))
      card.addEventListener('pointerenter', () => openBadgeCard(entry, false))
      card.addEventListener('pointerleave', () => scheduleBadgeClose(entry))
      // A click pins the card, so the user can read (and delete) without
      // balancing the pointer on the marker itself.
      node.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        toggleBadgePin(entry)
      })
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
        card.addEventListener(type, (event) => event.stopPropagation())
      }
      card.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openBadgeCard(entry, true)
      })
      del.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        handlers.onDelete(item.id)
      })
      return entry
    }

    function positionBadge(node, pageRect) {
      const size = viewportSize()
      const scroll = scrollOffset()
      const x = pageRect.x - scroll.x
      const y = pageRect.y - scroll.y
      const half = BADGE_PX / 2
      const margin = BADGE_PX + 4
      const intersects =
        x + pageRect.w >= -margin && x <= size.width + margin && y + pageRect.h >= -margin && y <= size.height + margin
      if (state.hidden || !intersects) {
        setVisible(node, false)
        return
      }
      const left = clamp(x - half, 4, Math.max(4, size.width - margin))
      const top = clamp(y - half, 4, Math.max(4, size.height - margin))
      node.style.left = `${Math.round(left)}px`
      node.style.top = `${Math.round(top)}px`
      node.dataset.flip = left > size.width / 2 ? '1' : '0'
      setVisible(node, true)
    }

    /** Repaint every marker; scroll and resize only change viewport pixels. */
    function positionAll() {
      for (const entry of badgeEntries) positionBadge(entry.node, entry.item.pageRect)
    }

    function setBadges(items) {
      const list = Array.isArray(items) ? items : []
      const signature = list
        .map((item) => `${item.id}:${item.index}:${item.state}:${item.comment}:${item.note}`)
        .join('|')
      state.badgeItems = list
      if (signature !== state.badgeSignature) {
        state.badgeSignature = signature
        // A respawn (agent note, state change) must not tear the open card from
        // under the pointer: remember which id was open and re-open it.
        const previous = { open: badgeHover.openId, pinned: badgeHover.pinnedId }
        cancelBadgeTimer()
        badgeHover.openId = ''
        badgeHover.pinnedId = ''
        ctx.overlay.clearLocked('badge')
        for (const entry of badgeEntries) {
          if (entry.node.parentNode) entry.node.parentNode.removeChild(entry.node)
        }
        badgeEntries = []
        for (const item of list) {
          const entry = buildBadge(item)
          if (!entry.node.parentNode) shadow.insertBefore(entry.node, ctx.hud.node)
          badgeEntries.push(entry)
        }
        const restore = (id, pinned) => {
          if (id === '') return false
          const entry = badgeEntries.find((candidate) => String(candidate.item.id) === id)
          if (!entry) return false
          openBadgeCard(entry, pinned)
          return true
        }
        if (!restore(previous.pinned, true)) restore(previous.open, false)
      }
      ctx.refreshPositions()
    }

    /** Mark one marker as being deleted, so a double click cannot fire twice. */
    function setBadgePending(id, pending) {
      const value = String(id)
      for (const entry of badgeEntries) {
        if (String(entry.item.id) !== value) continue
        if (pending === true) entry.node.dataset.pending = '1'
        else entry.node.removeAttribute('data-pending')
        entry.del.disabled = pending === true
      }
    }

    /** Close a pinned card so Esc can mean "close the card" first. */
    function closeBadgeCard() {
      if (badgeHover.pinnedId === '') return false
      closeAllBadgeCards()
      return true
    }

    function onGlobalPointerDown(event) {
      if (badgeHover.openId === '' && badgeHover.pinnedId === '') return
      // Event targets inside the closed shadow root are retargeted to the host,
      // so anything else is a click on the page: drop a pinned card.
      if (event.target === host) return
      closeAllBadgeCards()
    }

    /** Drop every marker subtree; `destroy` removes the host right after. */
    function resetEntries() {
      badgeEntries = []
    }

    return {
      setBadges,
      setBadgePending,
      positionAll,
      closeBadgeCard,
      closeAllBadgeCards,
      cancelBadgeTimer,
      resetEntries,
      onGlobalPointerDown,
    }
  }

  ui.badges = { install }
})(globalThis)
