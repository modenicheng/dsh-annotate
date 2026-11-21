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
    const shiftDrop = createElement('div', 'shift-drop')

    const lockedBox = createElement('div', 'locked-box')
    const lockedChip = createElement('div', 'hover-chip')
    lockedChip.dataset.locked = '1'

    /**
     * How far outside the viewport a line still paints. The margin absorbs
     * sub-pixel rounding at the edges and keeps a line that is about to scroll
     * in from appearing a frame late; anything further out is skipped, so the
     * number of painted bands is bounded by the viewport, not by the mark's
     * line count.
     */
    const BAND_CLIP_MARGIN = 64

    /**
     * Whether a projected line box is close enough to the viewport to paint.
     * The chip that labels a locked mark uses the same rule, so "the band you
     * see" and "the line the chip points at" can never disagree.
     * @param {{left:number,top:number,width:number,height:number}} box projected line box
     * @param {{width:number,height:number}} size viewport
     */
    function lineIsVisible(box, size) {
      // Touch counts as inside, so a zero-area line still paints its origin.
      return !(
        box.left + box.width < -BAND_CLIP_MARGIN ||
        box.left > size.width + BAND_CLIP_MARGIN ||
        box.top + box.height < -BAND_CLIP_MARGIN ||
        box.top > size.height + BAND_CLIP_MARGIN
      )
    }

    /**
     * The first line of a locked mark that is on screen, in document
     * coordinates; null when the whole mark is out of view.
     * @param {{x:number,y:number,w:number,h:number}[]} lines document coordinates
     * @param {{x:number,y:number}} scroll
     * @param {{width:number,height:number}} size
     */
    function firstVisibleLine(lines, scroll, size) {
      for (const line of lines) {
        const box = {
          left: line.x - scroll.x,
          top: line.y - scroll.y,
          width: Math.max(0, line.w),
          height: Math.max(0, line.h),
        }
        if (lineIsVisible(box, size)) return line
      }
      return null
    }

    /**
     * One band per line box of a marked text, pooled. There are two painters
     * because two marks coexist while a page is being annotated: the one being
     * written (owned by the locked outline) and the ones already on the page.
     * Rects arrive in document coordinates and are projected here, so scrolling
     * keeps every band on the words it belongs to. Lines outside the viewport
     * (plus `BAND_CLIP_MARGIN`) are skipped without taking a pool slot: a long
     * mark only ever allocates as many bands as can be on screen at once, and
     * every slot a previous paint used is retired by the tail loop below.
     */
    function createBandPainter() {
      const layer = createElement('div', 'mark-band-layer')
      const pool = []
      function paint(lines) {
        const scroll = scrollOffset()
        const size = viewportSize()
        let used = 0
        for (const line of lines) {
          const left = line.x - scroll.x
          const top = line.y - scroll.y
          const width = Math.max(0, line.w)
          const height = Math.max(0, line.h)
          // Touch counts as inside, so a zero-area line still paints its origin.
          if (!lineIsVisible({ left, top, width, height }, size)) continue
          let band = pool[used]
          if (!band) {
            band = createElement('div', 'mark-band')
            pool.push(band)
            layer.appendChild(band)
          }
          band.style.left = `${Math.round(left)}px`
          band.style.top = `${Math.round(top)}px`
          band.style.width = `${Math.round(width)}px`
          band.style.height = `${Math.round(height)}px`
          setVisible(band, true)
          used += 1
        }
        for (let index = used; index < pool.length; index += 1) setVisible(pool[index], false)
      }
      function hide() {
        for (const band of pool) setVisible(band, false)
      }
      return { layer, paint, hide }
    }

    const markBands = createBandPainter()
    const pendingBands = createBandPainter()

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
     * @param {{x:number,y:number,w:number,h:number}|null} [pageRect] document rect, re-projected on scroll
     * @param {{x:number,y:number,w:number,h:number}[]|null} [lines] per-line document
     *   rects of a marked text; when present the bands replace the box, because
     *   a single rectangle around a paragraph says nothing about which words
     *   were marked
     */
    function setLocked(rect, label, holder, pageRect, lines) {
      if (!rect) {
        clearLocked(holder)
        return
      }
      state.lockHolder = holder || 'composer'
      state.lockedRect = { ...rect }
      state.lockedPageRect = pageRect ? { ...pageRect } : null
      state.lockedLines = Array.isArray(lines) && lines.length > 0 ? lines.map((line) => ({ ...line })) : null
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
      state.lockedLines = null
      state.lockedLabel = ''
      setVisible(lockedBox, false)
      setVisible(lockedChip, false)
      pendingBands.hide()
    }

    /**
     * The annotations already on the page, as line boxes in document
     * coordinates. While the page is being annotated the page may not carry our
     * `<mark>` elements, so the overlay draws every mark itself; at rest it only
     * draws the one badge that is hovered, on top of the page's own faint mark,
     * which is what makes "active" read as stronger and underlined.
     * @param {{id:string, lines:{x:number,y:number,w:number,h:number}[]}[]|null} items
     */
    function setMarkBands(items) {
      const lines = []
      for (const item of items || []) {
        for (const line of item.lines || []) lines.push({ ...line })
      }
      state.markLines = lines
      positionMarks()
    }

    /** Re-project the painted annotations on scroll or resize. */
    function positionMarks() {
      if (state.hidden || state.markLines.length === 0) {
        markBands.hide()
        return
      }
      markBands.paint(state.markLines)
    }

    function positionLocked() {
      if (state.lockHolder === null || state.hidden) {
        setVisible(lockedBox, false)
        setVisible(lockedChip, false)
        pendingBands.hide()
        return
      }
      const size = viewportSize()
      const scroll = scrollOffset()
      let rect = state.lockedRect || { x: 0, y: 0, w: 0, h: 0 }
      if (state.lockedPageRect !== null) {
        rect = {
          x: state.lockedPageRect.x - scroll.x,
          y: state.lockedPageRect.y - scroll.y,
          w: state.lockedPageRect.w,
          h: state.lockedPageRect.h,
        }
      }
      // A marked text is drawn as its line boxes; anything else as one outline.
      const lines = state.lockedLines
      if (lines !== null) {
        setVisible(lockedBox, false)
        pendingBands.paint(lines)
        // The chip follows the first line the painter could draw, not the
        // mark's first line: after scrolling a long mark half out of the
        // viewport its opening line may be far above, and a chip anchored there
        // would be pinned to the top edge (or below the fold) with no band in
        // sight. No line on screen means nothing to label.
        const first = firstVisibleLine(lines, scroll, size)
        if (first === null) {
          setVisible(lockedChip, false)
          return
        }
        rect = { x: first.x - scroll.x, y: first.y - scroll.y, w: first.w, h: first.h }
      } else {
        pendingBands.hide()
        lockedBox.style.left = `${Math.round(rect.x)}px`
        lockedBox.style.top = `${Math.round(rect.y)}px`
        lockedBox.style.width = `${Math.max(0, Math.round(rect.w))}px`
        lockedBox.style.height = `${Math.max(0, Math.round(rect.h))}px`
        setVisible(lockedBox, true)
      }

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
     * The teardrop that hangs off the pointer while a text selection is armed:
     * nothing on the page is the subject yet, only the gesture is, so the drop
     * replaces the element outline and the cursor ring.
     * @param {{x:number,y:number}|null} point viewport point
     */
    function setShiftDrop(point) {
      if (!point || state.hidden) {
        setVisible(shiftDrop, false)
        return
      }
      shiftDrop.style.left = `${Math.round(point.x)}px`
      shiftDrop.style.top = `${Math.round(point.y)}px`
      setVisible(shiftDrop, true)
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
      setVisible(shiftDrop, false)
    }

    return {
      hoverBox,
      hoverChip,
      marquee,
      cursorRing,
      shiftDrop,
      lockedBox,
      lockedChip,
      markBandLayer: markBands.layer,
      pendingBandLayer: pendingBands.layer,
      setHover,
      setLocked,
      clearLocked,
      positionLocked,
      setMarkBands,
      positionMarks,
      setMarquee,
      setCursor,
      setShiftDrop,
      hideTransient,
    }
  }

  ui.overlay = { install }
})(globalThis)
