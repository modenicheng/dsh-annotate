/**
 * dsh-marker content script 2/4 — re-anchoring ("hydrator").
 *
 * Given a stored anchor, find where it is on the page *now*. Every modality has
 * an ordered fallback chain; the last resort is always a floating pin at the
 * stored rect so a re-render can degrade the highlight but never lose the
 * annotation.
 *
 *   selection → exact domRange → quote inside the block → whole-document quote
 *               (exact, then whitespace-normalised) → pin
 *   element   → stable selector → cssPath → xpath → tag+text/attrs similarity
 *               → pin
 *   region    → anchorElement + offsets → stored pageRect
 *
 * Also owns the `<mark data-dsh-anno>` highlights. `Range.surroundContents` is
 * deliberately not used: it throws whenever a range splits an element, and it
 * would wreck pages mid-render. Text nodes are split and wrapped individually.
 */
;(function installHydrator(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  if (ns.hydrate) return

  const P = global.__DSH_PROTOCOL__
  if (!P || !ns.text || !ns.geom || !ns.dom) return

  const text = ns.text
  const geom = ns.geom
  const MIN_ELEMENT_SCORE = 0.45
  const MAX_CANDIDATES = 1500
  const MAX_QUOTE_OCCURRENCES = 40

  // ── placements ─────────────────────────────────────────────────────────────

  /**
   * A placement is `{ method, pageRect, target, range }`. `pageRect` is always
   * document coordinates so scrolling never invalidates it; the UI converts to
   * viewport pixels at paint time.
   */
  function pinPlacement(pageRect, method) {
    const rect = geom.normalizeRect(pageRect)
    if (!rect) return null
    return { method, pageRect: geom.roundRect(rect), target: null, range: null }
  }

  function placementFromElement(element, method) {
    const viewportRect = geom.rectOf(element.getBoundingClientRect())
    return {
      method,
      pageRect: geom.roundRect(geom.viewportToPage(viewportRect)),
      target: element,
      range: null,
    }
  }

  function placementFromRange(range, method) {
    let viewportRect = geom.rectOfRange(range)
    if (viewportRect.w === 0 && viewportRect.h === 0) {
      const common = range.commonAncestorContainer
      const element = common && (common.nodeType === 1 ? common : common.parentElement)
      if (element && element.getBoundingClientRect) viewportRect = geom.rectOf(element.getBoundingClientRect())
    }
    return {
      method,
      pageRect: geom.roundRect(geom.viewportToPage(viewportRect)),
      target: range.commonAncestorContainer || null,
      range,
    }
  }

  /**
   * A placement is stale when its node left the document. Pin placements carry
   * no node, so they are always re-checked: that is how a quote whose text only
   * appears after an SPA route change gets upgraded to a real highlight.
   */
  function isFresh(placement) {
    if (!placement || !placement.target) return false
    try {
      return placement.target.isConnected !== false
    } catch {
      return false
    }
  }

  // ── selection ──────────────────────────────────────────────────────────────

  // `clampOffset` and the whitespace normalizer live on `ns.text` (anchor.js,
  // the script this one loads after); they were local byte-identical copies
  // here until the duplication drifted once too often.

  function rangeFromPaths(document, first, last, domRange) {
    try {
      const range = document.createRange()
      range.setStart(first, text.clampOffset(domRange.startOffset, first))
      range.setEnd(last, text.clampOffset(domRange.endOffset, last))
      return range
    } catch {
      return null
    }
  }

  /** Cheap sanity check that a reconstructed range really holds the quote. */
  function matchesQuote(range, quote) {
    const exact = quote && typeof quote.exact === 'string' ? quote.exact : ''
    if (exact === '') return false
    let actual = ''
    try {
      actual = String(range.toString() || '')
    } catch {
      return false
    }
    if (actual === '') return false
    if (actual === exact) return true
    // Formatting inside the selection (`<b>`, `<a>`) is invisible to
    // `toString()` but survives as characters, so compare normalised prefixes.
    const expected = text.normalizeWs(exact)
    const got = text.normalizeWs(actual)
    if (expected === '') return false
    const probe = expected.slice(0, Math.min(40, expected.length))
    return got.slice(0, probe.length) === probe
  }

  /**
   * Whitespace-insensitive view of an indexed text, plus a position map back to
   * the original offsets. Built lazily: most pages never need it.
   */
  function normalizedIndexOf(index) {
    if (index.__normalized) return index.__normalized
    const source = index.text
    const characters = []
    const map = []
    let pendingSpace = false
    for (let position = 0; position < source.length; position += 1) {
      const character = source[position]
      if (/\s/.test(character)) {
        pendingSpace = true
        continue
      }
      if (pendingSpace && characters.length > 0) {
        characters.push(' ')
        map.push(position)
      }
      pendingSpace = false
      characters.push(character)
      map.push(position)
    }
    index.__normalized = { text: characters.join(''), map }
    return index.__normalized
  }

  function commonPrefixLength(left, right) {
    let index = 0
    while (index < left.length && index < right.length && left[index] === right[index]) index += 1
    return index
  }

  function commonSuffixLength(left, right) {
    let leftIndex = left.length - 1
    let rightIndex = right.length - 1
    let found = 0
    while (leftIndex >= 0 && rightIndex >= 0 && left[leftIndex] === right[rightIndex]) {
      leftIndex -= 1
      rightIndex -= 1
      found += 1
    }
    return found
  }

  /** How much of the stored prefix/suffix surrounds this occurrence. */
  function contextScore(source, at, length, prefix, suffix) {
    let score = 0
    if (prefix) {
      const before = source.slice(Math.max(0, at - prefix.length), at)
      score += commonSuffixLength(before, prefix) / prefix.length
    }
    if (suffix) {
      const after = source.slice(at + length, at + length + suffix.length)
      score += commonPrefixLength(after, suffix) / suffix.length
    }
    return score
  }

  /**
   * Locate the quote in an indexed text. Exact occurrences are ranked by how
   * much stored context they reproduce, so a repeated sentence lands on the
   * right one. If the raw text is gone (reflowed whitespace) the normalised
   * index is tried before giving up.
   */
  function findByQuote(index, quote) {
    if (!index || !quote || typeof quote.exact !== 'string') return null
    const exact = quote.exact
    if (exact === '') return null
    const prefix = typeof quote.prefix === 'string' ? quote.prefix : ''
    const suffix = typeof quote.suffix === 'string' ? quote.suffix : ''

    let best = null
    let from = 0
    let occurrences = 0
    while (occurrences < MAX_QUOTE_OCCURRENCES) {
      const at = index.text.indexOf(exact, from)
      if (at < 0) break
      occurrences += 1
      const score = contextScore(index.text, at, exact.length, prefix, suffix)
      if (!best || score > best.score) {
        best = { start: at, end: at + exact.length, score, approach: 'exact' }
      }
      from = at + 1
    }
    if (best) return best

    const needle = text.normalizeWs(exact)
    if (needle === '') return null
    const normalized = normalizedIndexOf(index)
    const at = normalized.text.indexOf(needle)
    if (at < 0) return null
    const start = normalized.map[at]
    const lastCharacter = normalized.map[at + needle.length - 1]
    if (!Number.isFinite(start) || !Number.isFinite(lastCharacter)) return null
    return {
      start,
      end: lastCharacter + 1,
      score: contextScore(normalized.text, at, needle.length, prefix, suffix),
      approach: 'normalized',
    }
  }

  function getDocumentIndex(context) {
    if (!context || !context.document) return null
    if (!context.cache.documentIndex) {
      const document = context.document
      context.cache.documentIndex = text.indexOf(document.body || document.documentElement)
    }
    return context.cache.documentIndex
  }

  function resolveSelection(anchor, context) {
    const document = context.document
    const domRange = anchor.domRange

    if (domRange && domRange.blockSelector) {
      const block = ns.dom.safeQuery(document, domRange.blockSelector)
      if (block) {
        // 1. the recorded block + child-index paths, verified against the quote
        const first = text.nodeAtPath(block, domRange.startPath)
        const last = text.nodeAtPath(block, domRange.endPath)
        if (first && last && first.nodeType === 3 && last.nodeType === 3) {
          const range = rangeFromPaths(document, first, last, domRange)
          if (range && matchesQuote(range, anchor.quote)) return placementFromRange(range, 'dom-range')
        }

        // 2. the same block still exists but its children were rebuilt: search
        //    the block's text, which is much cheaper than the whole document.
        const blockIndex = text.indexOf(block)
        const insideBlock = findByQuote(blockIndex, anchor.quote)
        if (insideBlock) {
          const range = text.rangeFromOffsets(document, blockIndex, insideBlock.start, insideBlock.end)
          if (range) return placementFromRange(range, 'quote-block')
        }
      }
    }

    // 3. whole-document fuzzy
    const documentIndex = getDocumentIndex(context)
    if (documentIndex) {
      const found = findByQuote(documentIndex, anchor.quote)
      if (found) {
        const range = text.rangeFromOffsets(document, documentIndex, found.start, found.end)
        if (range) return placementFromRange(range, found.approach === 'exact' ? 'quote-document' : 'quote-fuzzy')
      }
    }
    return null
  }

  // ── element ────────────────────────────────────────────────────────────────

  function diceCoefficient(left, right) {
    if (!left || !right) return 0
    if (left === right) return 1
    if (left.length < 2 || right.length < 2) return 0
    const bigrams = new Map()
    for (let index = 0; index < left.length - 1; index += 1) {
      const pair = left.slice(index, index + 2)
      bigrams.set(pair, (bigrams.get(pair) || 0) + 1)
    }
    let hits = 0
    for (let index = 0; index < right.length - 1; index += 1) {
      const pair = right.slice(index, index + 2)
      const count = bigrams.get(pair)
      if (count) {
        hits += 1
        bigrams.set(pair, count - 1)
      }
    }
    return (2 * hits) / (left.length - 1 + right.length - 1)
  }

  function attributeOf(element, name) {
    try {
      return typeof element.getAttribute === 'function' ? element.getAttribute(name) : null
    } catch {
      return null
    }
  }

  /** Weighted similarity between a stored fingerprint and a live element. */
  function similarity(anchor, element) {
    const fingerprint = anchor.fingerprint || {}
    const attributes = fingerprint.attrs || {}
    const tag = String(element.tagName || '').toLowerCase()
    let score = 0
    if (fingerprint.tag && tag === fingerprint.tag) score += 0.25
    if (attributes.id && element.id && element.id === attributes.id) score += 0.35
    const probes = ['name', 'role', 'aria-label', 'type', 'placeholder', 'href']
    for (const probe of probes) {
      const expected = attributes[probe]
      if (!expected) continue
      const actual = attributeOf(element, probe)
      if (actual && actual === expected) score += probe === 'href' ? 0.2 : 0.1
    }
    const expectedClasses = String(attributes.class || '')
      .split(/\s+/)
      .filter((name) => name !== '')
    if (expectedClasses.length > 0) {
      const actualClasses = new Set(ns.dom.classList(element))
      let shared = 0
      for (const name of expectedClasses) if (actualClasses.has(name)) shared += 1
      score += 0.2 * (shared / expectedClasses.length)
    }
    const expectedText = text.normalizeWs(fingerprint.textExcerpt || '')
    if (expectedText !== '') {
      const actualText = ns.dom.cheapText(element).slice(0, 400)
      score += 0.3 * diceCoefficient(expectedText.slice(0, 200), actualText)
    }
    return Math.min(1, score)
  }

  /**
   * A selector that still resolves to the same node is trusted even if the tag
   * changed; if the tag changed *and* the content does not match, keep falling
   * through so similarity can find the real twin.
   */
  function plausible(anchor, element) {
    const fingerprint = anchor.fingerprint || {}
    if (!fingerprint.tag) return true
    if (String(element.tagName || '').toLowerCase() === fingerprint.tag) return true
    return similarity(anchor, element) >= 0.3
  }

  function bestBySimilarity(anchor, document) {
    const fingerprint = anchor.fingerprint || {}
    const tag = typeof fingerprint.tag === 'string' ? fingerprint.tag.toLowerCase() : ''
    if (!tag) return null
    let candidates
    try {
      candidates = document.getElementsByTagName(tag)
    } catch {
      return null
    }
    if (!candidates || candidates.length === 0) return null
    const limit = Math.min(candidates.length, MAX_CANDIDATES)
    let best = null
    for (let index = 0; index < limit; index += 1) {
      const element = candidates[index]
      if (!element || element.nodeType !== 1) continue
      if (element.id === ns.HOST_ID) continue
      const score = similarity(anchor, element)
      if (score > (best ? best.score : MIN_ELEMENT_SCORE)) best = { element, score }
    }
    return best
  }

  function resolveElement(anchor, context) {
    const document = context.document
    const selectors = anchor.selectors || {}
    const attempts = [
      ['stable', selectors.stable],
      ['css-path', selectors.cssPath],
      ['xpath', selectors.xpath],
    ]
    for (const [method, selector] of attempts) {
      if (!selector) continue
      const element = method === 'xpath' ? ns.dom.byXpath(document, selector) : ns.dom.safeQuery(document, selector)
      if (!element || element.nodeType !== 1) continue
      if (plausible(anchor, element)) return placementFromElement(element, method)
    }
    const best = bestBySimilarity(anchor, document)
    if (best) return placementFromElement(best.element, 'similarity')
    return null
  }

  // ── region ─────────────────────────────────────────────────────────────────

  function resolveRegion(anchor, context) {
    const document = context.document
    const stored = geom.normalizeRect(anchor.pageRect)
    const anchorElement = anchor.anchorElement
    if (anchorElement && anchorElement.selector) {
      const element = ns.dom.safeQuery(document, anchorElement.selector)
      if (element) {
        const elementPageRect = geom.viewportToPage(geom.rectOf(element.getBoundingClientRect()))
        const fallbackWidth = stored ? stored.w : 0
        const fallbackHeight = stored ? stored.h : 0
        const pageRect = geom.roundRect({
          x: elementPageRect.x + (Number(anchorElement.offsetX) || 0),
          y: elementPageRect.y + (Number(anchorElement.offsetY) || 0),
          w: fallbackWidth,
          h: fallbackHeight,
        })
        return { method: 'anchor-element', pageRect, target: element, range: null }
      }
    }
    if (stored) return { method: 'page-rect', pageRect: geom.roundRect(stored), target: null, range: null }
    return null
  }

  // ── entry points ───────────────────────────────────────────────────────────

  /**
   * `record` is only read for its anchor; pass a `cache` across many records so
   * the document text index is built once per pass.
   */
  function resolve(record, document, cache) {
    if (!record || !record.anchor) return null
    const context = { document: document || global.document, cache: cache || {} }
    if (!context.document) return null
    const anchor = record.anchor
    if (anchor.kind === 'selection') return resolveSelection(anchor, context) || pinPlacement(anchor.rect, 'pin')
    if (anchor.kind === 'element') return resolveElement(anchor, context) || pinPlacement(anchor.rect, 'pin')
    if (anchor.kind === 'region') return resolveRegion(anchor, context) || pinPlacement(anchor.pageRect, 'page-rect')
    return null
  }

  function resolveAll(records, document) {
    const context = { document: document || global.document, cache: {} }
    const out = []
    for (const record of records || []) {
      const placement = resolve(record, context.document, context.cache)
      if (placement) out.push({ record, placement })
    }
    return out
  }

  // ── highlights ─────────────────────────────────────────────────────────────

  /** Unwraps everything this script has marked, so a re-anchor starts clean. */
  function clearMarks() {
    for (const nodes of markNodes.values()) {
      for (const node of nodes) unwrapMark(node)
    }
    markNodes.clear()
  }

  const markNodes = new Map()

  function unwrapMark(mark) {
    const parent = mark.parentNode
    if (!parent) return
    const first = mark.firstChild
    if (first && first.nodeType === 3) {
      try {
        parent.replaceChild(first, mark)
        // Merge the split text node back so page code that walks text siblings
        // sees the same structure it rendered.
        if (typeof parent.normalize === 'function') parent.normalize()
        return
      } catch {
        // Fall through to a plain removal.
      }
    }
    try {
      parent.removeChild(mark)
    } catch {
      // The page replaced the subtree already.
    }
  }

  const MARK_STYLE = {
    // The resting highlight: a faint tint behind the words and nothing else, so
    // a marked page still reads as a page. While it is being annotated the same
    // mark is drawn by the overlay instead, at full strength and underlined.
    background: 'rgba(245, 158, 11, 0.1)',
    color: 'inherit',
    padding: '0',
    margin: '0',
    font: 'inherit',
    'text-decoration': 'inherit',
  }

  function applyMarkStyle(mark) {
    // The mark has to live in the page's text flow to read as a highlight, so
    // it cannot be inside our shadow root. `!important` keeps page rules (and
    // any `mark { background: yellow }`) from deforming it.
    for (const key of Object.keys(MARK_STYLE)) {
      try {
        mark.style.setProperty(key, MARK_STYLE[key], 'important')
      } catch {
        // A style property the page's engine rejected: skip it.
      }
    }
  }

  function wrapSegment(document, node, start, end, id) {
    const parent = node.parentNode
    if (!parent || node.nodeType !== 3) return null
    const length = (node.nodeValue || '').length
    const from = Math.max(0, Math.min(start, length))
    const to = Math.max(0, Math.min(end, length))
    if (!(to > from)) return null
    try {
      let middle = node
      if (to < length) node.splitText(to)
      if (from > 0) middle = node.splitText(from)
      const mark = document.createElement('mark')
      mark.setAttribute('data-dsh-anno', id)
      applyMarkStyle(mark)
      parent.replaceChild(mark, middle)
      mark.appendChild(middle)
      return mark
    } catch {
      return null
    }
  }

  /**
   * Wrap every text node the range covers in its own `<mark>`. Doing it per
   * node is the whole point: a range that crosses element boundaries cannot be
   * wrapped by one element without restructuring the page.
   */
  function markRange(range, id) {
    const created = []
    if (!range || !range.startContainer) return created
    const document = range.startContainer.ownerDocument
    if (!document) return created
    let scope = range.commonAncestorContainer
    if (scope && scope.nodeType === 3) scope = scope.parentElement
    if (!scope) return created
    const nodes = text.nodesInRange(range, scope)
    for (const node of nodes) {
      const start = node === range.startContainer ? range.startOffset : 0
      const end = node === range.endContainer ? range.endOffset : (node.nodeValue || '').length
      if (!(end > start)) continue
      const mark = wrapSegment(document, node, start, end, id)
      if (mark) created.push(mark)
    }
    return created
  }

  /**
   * Rebuild highlights for a whole placement pass. Callers pause their
   * MutationObserver around this: wrapping text is a page mutation by design.
   */
  function applyMarks(placements) {
    clearMarks()
    for (const item of placements || []) {
      if (!item || !item.record || !item.placement) continue
      if (!item.record.anchor || item.record.anchor.kind !== 'selection') continue
      if (!item.placement.range) continue
      const created = markRange(item.placement.range, item.record.id)
      if (created.length > 0) markNodes.set(item.record.id, created)
    }
    return markNodes.size
  }

  /**
   * Line boxes of the highlight currently painted for one record, in document
   * coordinates. The `<mark>` elements are the truth at rest: the `Range` a
   * placement carries dies the moment the text it points at is wrapped (a live
   * Range whose node is reparented into the mark is reset), so geometry read
   * back from that Range after painting is empty. Returns `[]` when the record
   * is not painted right now — during annotation mode the marks are removed on
   * purpose and callers fall back to the placement's range.
   * @param {string} id
   * @param {number} [limit] cap on returned line boxes, 240 by default
   */
  function markLineBoxes(id, limit) {
    const nodes = markNodes.get(String(id))
    if (!nodes || nodes.length === 0) return []
    const max = Number(limit) > 0 ? Math.trunc(Number(limit)) : 240
    const lines = []
    for (const node of nodes) {
      if (!node || typeof node.getClientRects !== 'function') continue
      let rects
      try {
        rects = node.getClientRects()
      } catch {
        continue
      }
      for (const rect of rects) {
        if (!rect || !(rect.width > 0 || rect.height > 0)) continue
        // `rectOf` first: a DOMRect says `width`/`height`, the geometry helpers
        // below speak `w`/`h`.
        lines.push(geom.roundRect(geom.viewportToPage(geom.rectOf(rect))))
        if (lines.length >= max) return lines
      }
    }
    return lines
  }

  // ── throttle ───────────────────────────────────────────────────────────────

  /**
   * At most one run per `intervalMs` (250 ms ≈ 4 Hz): SPA re-renders fire
   * MutationObserver in bursts, and a full re-anchor per record is not cheap.
   * Requests that arrive while a run is queued are coalesced.
   */
  function createScheduler(run, intervalMs) {
    const budget = Math.max(50, Number(intervalMs) || 250)
    let timer = 0
    let lastRun = 0
    let stopped = false
    function fire() {
      timer = 0
      if (stopped) return
      lastRun = Date.now()
      try {
        run()
      } catch {
        // A page that throws mid-walk must not kill the loop; the next
        // mutation retries.
      }
    }
    return {
      request() {
        if (stopped || timer) return
        const wait = Math.max(0, budget - (Date.now() - lastRun))
        timer = global.setTimeout(fire, wait)
      },
      stop() {
        stopped = true
        if (timer) {
          global.clearTimeout(timer)
          timer = 0
        }
      },
      get pending() {
        return timer !== 0
      },
    }
  }

  ns.hydrate = {
    resolve,
    resolveAll,
    isFresh,
    applyMarks,
    clearMarks,
    markLineBoxes,
    createScheduler,
    MIN_ELEMENT_SCORE,
  }
})(globalThis)
