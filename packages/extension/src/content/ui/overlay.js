/**
 * dsh-marker content script 3/4 (ui) — the outlines and guides.
 *
 * Three different things share these nodes: the transient hover box (what is
 * under the pointer right now), the locked outline (what the open composer or a
 * hovered marker is talking about), and the marquee/cursor of a drag. They are
 * separate elements on purpose — the lock must survive pointer movement — and
 * every position is written in viewport pixels, so scrolling only needs a
 * repaint, never a re-measure of the anchor.
 */
;(function installUiOverlay(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  const ui = (ns.ui = ns.ui || {})
  if (ui.overlay) return

  /**
   * @param {any} ctx
   */
  function install(ctx) {
    const { state, dom } = ctx
    const { createElement, setVisible, clamp, viewportSize, scrollOffset } = dom

    const hoverBox = createElement('div', 'hover-box')
    const hoverChip = createElement('div', 'hover-chip')
    const marquee = createElement('div', 'marquee')
    const cursorRing = createElement('div', 'cursor-ring')

    const lockedBox = createElement('div', 'locked-box')
    const lockedChip = createElement('div', 'hover-chip')
    lockedChip.dataset.locked = '1'

    function setHover(info) {
      if (!info || state.hidden) {
        state.hoverVisible = false
        setVisible(hoverBox, false)
        setVisible(hoverChip, false)
        return
      }
      const rect = info.rect || { x: 0, y: 0, w: 0, h: 0 }
      const size = viewportSize()
      hoverBox.style.left = `${Math.round(rect.x)}px`
      hoverBox.style.top = `${Math.round(rect.y)}px`
      hoverBox.style.width = `${Math.max(0, Math.round(rect.w))}px`
      hoverBox.style.height = `${Math.max(0, Math.round(rect.h))}px`
      setVisible(hoverBox, true)
      state.hoverVisible = true

      hoverChip.textContent = String(info.label || '')
      // Measure the chip after layout so it never leaves the viewport.
      const chipWidth = Math.min(hoverChip.scrollWidth || 120, size.width - 16)
      let left = rect.x
      left = clamp(left, 8, Math.max(8, size.width - chipWidth - 8))
      let top = rect.y - 22
      if (top < 8) top = rect.y + rect.h + 4
      hoverChip.style.left = `${Math.round(left)}px`
      hoverChip.style.top = `${Math.round(Math.max(4, top))}px`
      setVisible(hoverChip, true)
    }

    /**
     * Paint the persistent outline that says "this is the thing you are
     * talking about". Unlike the hover box it survives pointer movement, and it
     * is owned by whoever set it, so a badge hover cannot steal the outline the
     * open composer is using.
     * @param {{x:number,y:number,w:number,h:number}|null} rect viewport rect
     * @param {string} [label]
     * @param {'composer'|'badge'} [holder]
     * @param {{x:number,y:number,w:number,h:number}} [pageRect] document rect, re-projected on scroll
     */
    function setLocked(rect, label, holder, pageRect) {
      if (!rect) {
        clearLocked(holder)
        return
      }
      state.lockHolder = holder || 'composer'
      state.lockedRect = { ...rect }
      state.lockedPageRect = pageRect ? { ...pageRect } : null
      state.lockedLabel = String(label || '')
      positionLocked()
    }

    /** @param {'composer'|'badge'} [holder] omit to clear whoever holds it */
    function clearLocked(holder) {
      if (state.lockHolder === null) return
      if (holder !== undefined && holder !== state.lockHolder) return
      state.lockHolder = null
      state.lockedRect = null
      state.lockedPageRect = null
      state.lockedLabel = ''
      setVisible(lockedBox, false)
      setVisible(lockedChip, false)
    }

    function positionLocked() {
      if (state.lockHolder === null || state.hidden) {
        setVisible(lockedBox, false)
        setVisible(lockedChip, false)
        return
      }
      const size = viewportSize()
      let rect = state.lockedRect || { x: 0, y: 0, w: 0, h: 0 }
      if (state.lockedPageRect !== null) {
        const scroll = scrollOffset()
        rect = {
          x: state.lockedPageRect.x - scroll.x,
          y: state.lockedPageRect.y - scroll.y,
          w: state.lockedPageRect.w,
          h: state.lockedPageRect.h,
        }
      }
      lockedBox.style.left = `${Math.round(rect.x)}px`
      lockedBox.style.top = `${Math.round(rect.y)}px`
      lockedBox.style.width = `${Math.max(0, Math.round(rect.w))}px`
      lockedBox.style.height = `${Math.max(0, Math.round(rect.h))}px`
      setVisible(lockedBox, true)

      lockedChip.textContent = state.lockedLabel
      setVisible(lockedChip, state.lockedLabel !== '')
      if (state.lockedLabel === '') return
      const chipWidth = Math.min(lockedChip.scrollWidth || 120, size.width - 16)
      const left = clamp(rect.x, 8, Math.max(8, size.width - chipWidth - 8))
      let top = rect.y - 22
      if (top < 8) top = rect.y + rect.h + 4
      lockedChip.style.left = `${Math.round(left)}px`
      lockedChip.style.top = `${Math.round(Math.max(4, top))}px`
    }

    function setMarquee(rect) {
      if (!rect || state.hidden) {
        state.marqueeVisible = false
        setVisible(marquee, false)
        return
      }
      marquee.style.left = `${Math.round(rect.x)}px`
      marquee.style.top = `${Math.round(rect.y)}px`
      marquee.style.width = `${Math.max(0, Math.round(rect.w))}px`
      marquee.style.height = `${Math.max(0, Math.round(rect.h))}px`
      setVisible(marquee, true)
      state.marqueeVisible = true
    }

    function setCursor(point) {
      if (!point || state.hidden || !state.hudVisible) {
        setVisible(cursorRing, false)
        return
      }
      cursorRing.style.left = `${Math.round(point.x)}px`
      cursorRing.style.top = `${Math.round(point.y)}px`
      setVisible(cursorRing, true)
    }

    /**
     * Initial paint: the hover guide, the marquee and the cursor ring appear
     * only while a gesture is running.
     */
    function hideTransient() {
      setVisible(hoverBox, false)
      setVisible(hoverChip, false)
      setVisible(marquee, false)
      setVisible(cursorRing, false)
    }

    return {
      hoverBox,
      hoverChip,
      marquee,
      cursorRing,
      lockedBox,
      lockedChip,
      setHover,
      setLocked,
      clearLocked,
      positionLocked,
      setMarquee,
      setCursor,
      hideTransient,
    }
  }

  ui.overlay = { install }
})(globalThis)
