/**
 * dsh-marker content script 1/4 — anchor extraction.
 *
 * Turns what the user pointed at (a text selection, an element, a marquee
 * region) into the exact anchor shapes `@dsh-marker/protocol` validates, plus
 * the page facts the host attaches to every record.
 *
 * Loaded as a classic script, after `shared/protocol.global.js` (which
 * publishes `globalThis.__DSH_PROTOCOL__`) and before the other content
 * scripts. Everything it exposes lives on the shared isolated-world namespace
 * `globalThis.__DSH_ANNO__`; nothing here touches the page's own JS.
 */
;(function installAnchor(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})

  // `scripting.executeScript` may inject these files a second time when the
  // manifest-declared content script has not answered yet, so installing twice
  // must be a no-op rather than a second set of listeners.
  if (ns.anchor) return

  // The generated classic build of the protocol; never duplicate its numbers.
  const P = global.__DSH_PROTOCOL__
  if (!P) return

  const HOST_ID = 'dsh-anno-root'
  const LIMITS = P.LIMITS
  const NODE_FILTER = global.NodeFilter || { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 }
  const MAX_TEXT_NODES = 20_000
  const MAX_INDEX_CHARS = 400_000
  const MAX_INDEX_NODES = 10_000
  const MAX_ATTRIBUTES = 8
  /** Line boxes one text mark may be painted with; a longer mark keeps the box. */
  const MAX_MARK_LINES = 120

  /** Elements whose text never belongs to an anchor or a highlight. */
  const SKIP_TEXT_PARENTS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'IFRAME',
    'OBJECT',
    'EMBED',
    'CANVAS',
    'TEXTAREA',
    'SELECT',
    'OPTION',
    'HEAD',
    'TITLE',
    'META',
    'LINK',
  ])

  /** Tags that are never an annotation target on their own. */
  const SKIP_TARGET_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE'])

  /** Values of `display` that mean "keep climbing, the real target is outside". */
  const INLINE_DISPLAY = /^(inline|inline-block|inline-flex|inline-grid|contents)$/

  const ns_geom = {}

  // ── small helpers ──────────────────────────────────────────────────────────

  function round1(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return 0
    return Math.round(number * 10) / 10
  }

  function normalizeWs(value) {
    return String(value == null ? '' : value)
      .replace(/\s+/g, ' ')
      .trim()
  }

  /** Drop empty/undefined keys so anchors stay small on the wire. */
  function compact(object) {
    const out = {}
    for (const key of Object.keys(object)) {
      const value = object[key]
      if (value === undefined || value === null) continue
      if (typeof value === 'string' && value === '') continue
      out[key] = value
    }
    return out
  }

  // ── geometry: everything on the wire is a plain {x,y,w,h} ──────────────────

  function rectOf(box) {
    if (!box) return { x: 0, y: 0, w: 0, h: 0 }
    return {
      x: Number(box.left ?? box.x ?? 0),
      y: Number(box.top ?? box.y ?? 0),
      w: Number(box.width ?? box.w ?? 0),
      h: Number(box.height ?? box.h ?? 0),
    }
  }

  function roundRect(rect) {
    return { x: round1(rect.x), y: round1(rect.y), w: round1(rect.w), h: round1(rect.h) }
  }

  function areaOf(rect) {
    return Math.max(0, rect.w) * Math.max(0, rect.h)
  }

  function unionRects(rects) {
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const rect of rects || []) {
      if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) continue
      if (rect.w <= 0 && rect.h <= 0) continue
      minX = Math.min(minX, rect.x)
      minY = Math.min(minY, rect.y)
      maxX = Math.max(maxX, rect.x + rect.w)
      maxY = Math.max(maxY, rect.y + rect.h)
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  function intersection(left, right) {
    const x = Math.max(left.x, right.x)
    const y = Math.max(left.y, right.y)
    const right2 = Math.min(left.x + left.w, right.x + right.w)
    const bottom = Math.min(left.y + left.h, right.y + right.h)
    return { x, y, w: Math.max(0, right2 - x), h: Math.max(0, bottom - y) }
  }

  /** Reject NaNs and negative sizes coming from reversed drags. */
  function normalizeRect(rect) {
    if (!rect) return null
    const x = Number(rect.x)
    const y = Number(rect.y)
    const w = Number(rect.w)
    const h = Number(rect.h)
    if (![x, y, w, h].every((value) => Number.isFinite(value))) return null
    return { x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h) }
  }

  function viewportToPage(rect) {
    return {
      x: rect.x + (Number(global.scrollX) || 0),
      y: rect.y + (Number(global.scrollY) || 0),
      w: rect.w,
      h: rect.h,
    }
  }

  function pageToViewport(rect) {
    return {
      x: rect.x - (Number(global.scrollX) || 0),
      y: rect.y - (Number(global.scrollY) || 0),
      w: rect.w,
      h: rect.h,
    }
  }

  /**
   * Client rects of a range, one per line box. Zero-area rects are collapsed
   * lines and would drag a union to the wrong corner. `limit` bounds the result
   * for callers that paint one node per line.
   */
  function rangeClientRects(range, limit) {
    if (!range) return []
    const rects = []
    const max = Number(limit) > 0 ? Math.trunc(Number(limit)) : Number.POSITIVE_INFINITY
    try {
      const list = typeof range.getClientRects === 'function' ? range.getClientRects() : null
      if (list) {
        for (let index = 0; index < list.length && rects.length < max; index += 1) {
          const box = list[index]
          if (box && (box.width > 0 || box.height > 0)) rects.push(rectOf(box))
        }
      }
    } catch {
      // A range whose endpoints were removed by the page: no lines to report.
    }
    return rects
  }

  function unionRangeRects(range) {
    if (!range) return { x: 0, y: 0, w: 0, h: 0 }
    const rects = rangeClientRects(range)
    if (rects.length === 0 && typeof range.getBoundingClientRect === 'function') {
      try {
        const box = range.getBoundingClientRect()
        if (box) rects.push(rectOf(box))
      } catch {
        // Callers fall back to the stored rect.
      }
    }
    return unionRects(rects)
  }

  ns_geom.rectOf = rectOf
  ns_geom.rectOfRange = unionRangeRects
  ns_geom.roundRect = roundRect
  ns_geom.areaOf = areaOf
  ns_geom.unionRects = unionRects
  ns_geom.intersection = intersection
  ns_geom.normalizeRect = normalizeRect
  ns_geom.viewportToPage = viewportToPage
  ns_geom.pageToViewport = pageToViewport

  // ── text traversal ─────────────────────────────────────────────────────────

  /**
   * Is this node part of our own annotation layer? The host and every
   * `<mark data-dsh-anno>` we insert must be invisible to extraction, or a
   * re-anchor would read its own highlight back as page content.
   */
  function isOurs(node) {
    if (!node) return false
    const element = node.nodeType === 1 ? node : node.parentElement
    if (!element) return false
    if (element.id === HOST_ID) return true
    try {
      return typeof element.closest === 'function' && element.closest('[data-dsh-anno]') !== null
    } catch {
      return false
    }
  }

  function isMark(node) {
    if (!node) return false
    const element = node.nodeType === 1 ? node : node.parentElement
    if (!element) return false
    try {
      return element.hasAttribute('data-dsh-anno')
    } catch {
      return false
    }
  }

  function acceptTextNode(node) {
    if (!node || !node.nodeValue) return NODE_FILTER.FILTER_SKIP
    const parent = node.parentElement
    if (!parent) return NODE_FILTER.FILTER_SKIP
    if (SKIP_TEXT_PARENTS.has(parent.nodeName)) return NODE_FILTER.FILTER_SKIP
    if (isOurs(parent)) return NODE_FILTER.FILTER_SKIP
    return NODE_FILTER.FILTER_ACCEPT
  }

  function walkTextNodes(root, document, visit) {
    if (!root || !document || typeof document.createTreeWalker !== 'function') return
    const walker = document.createTreeWalker(root, NODE_FILTER.SHOW_TEXT, acceptTextNode)
    let node = walker.nextNode()
    let guard = 0
    while (node) {
      guard += 1
      if (guard > MAX_TEXT_NODES) break
      visit(node)
      node = walker.nextNode()
    }
  }

  /** Text nodes the range actually covers, in document order. */
  function nodesInRange(range, scope) {
    const document = (scope && scope.ownerDocument) || global.document
    const root = scope || document.body || document.documentElement
    const result = []
    if (!range || !root) return result
    walkTextNodes(root, document, (node) => {
      let hit = false
      try {
        hit = range.intersectsNode(node)
      } catch {
        hit = false
      }
      if (hit) result.push(node)
    })
    return result
  }

  /**
   * Flatten a subtree into one string plus the offsets of every text node, so
   * quote/offset maths is a substring search instead of a DOM walk per probe.
   */
  function textIndexOf(root) {
    const document = (root && root.ownerDocument) || global.document
    const index = { root: root || null, text: '', entries: [], byNode: new Map(), truncated: false }
    if (!root || !document) return index
    walkTextNodes(root, document, (node) => {
      if (index.entries.length >= MAX_INDEX_NODES || index.text.length >= MAX_INDEX_CHARS) {
        index.truncated = true
        return
      }
      const value = node.nodeValue || ''
      const entry = { node, start: index.text.length, end: index.text.length + value.length }
      index.entries.push(entry)
      index.byNode.set(node, entry)
      index.text += value
    })
    return index
  }

  function offsetOf(index, node) {
    if (!index || !index.byNode) return -1
    const entry = index.byNode.get(node)
    return entry ? entry.start : -1
  }

  /**
   * Binary-search the text node that owns a flattened offset. A boundary offset
   * is ambiguous (it is both the end of one node and the start of the next);
   * both answers describe the same document position, so either is safe.
   */
  function entryForOffset(index, offset, forEnd) {
    const entries = index.entries
    let low = 0
    let high = entries.length - 1
    let position = -1
    while (low <= high) {
      const middle = (low + high) >> 1
      const entry = entries[middle]
      const startsBefore = forEnd ? entry.start < offset : entry.start <= offset
      if (startsBefore) {
        position = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (position < 0) position = 0
    let entry = entries[position]
    if (offset > entry.end && position + 1 < entries.length) entry = entries[position + 1]
    return entry
  }

  function rangeFromOffsets(document, index, start, end) {
    if (!document || !index || !index.entries || index.entries.length === 0) return null
    if (!(end > start)) return null
    const first = entryForOffset(index, start, false)
    const last = entryForOffset(index, end, true)
    if (!first || !last) return null
    const firstLength = (first.node.nodeValue || '').length
    const lastLength = (last.node.nodeValue || '').length
    const startOffset = Math.max(0, Math.min(start - first.start, firstLength))
    const endOffset = Math.max(0, Math.min(end - last.start, lastLength))
    try {
      const range = document.createRange()
      range.setStart(first.node, startOffset)
      if (first === last) {
        if (endOffset <= startOffset) return null
        range.setEnd(first.node, endOffset)
      } else {
        range.setEnd(last.node, endOffset)
      }
      return range
    } catch {
      return null
    }
  }

  /** Child-index path such as `1/0/3`; the inverse of `nodeAtPath`. */
  function pathWithin(node, root) {
    const parts = []
    let current = node
    let guard = 0
    while (current && current !== root) {
      guard += 1
      if (guard > 64) return ''
      const parent = current.parentNode
      if (!parent) return ''
      let index = -1
      for (let child = 0; child < parent.childNodes.length; child += 1) {
        if (parent.childNodes[child] === current) {
          index = child
          break
        }
      }
      if (index < 0) return ''
      parts.unshift(String(index))
      current = parent
    }
    return current === root ? parts.join('/') : ''
  }

  function nodeAtPath(root, path) {
    if (!root) return null
    if (typeof path !== 'string' || path === '') return root
    const parts = path.split('/')
    let current = root
    for (const part of parts) {
      const index = Number(part)
      if (!Number.isInteger(index) || index < 0) return null
      if (!current || !current.childNodes || index >= current.childNodes.length) return null
      current = current.childNodes[index]
      if (!current) return null
    }
    return current
  }

  ns.text = {
    normalizeWs,
    isOurs,
    isMark,
    acceptTextNode,
    nodesInRange,
    indexOf: textIndexOf,
    offsetOf,
    rangeFromOffsets,
    pathWithin,
    nodeAtPath,
    MAX_INDEX_CHARS,
  }

  // ── selectors ──────────────────────────────────────────────────────────────

  function cssEscape(value) {
    const text = String(value)
    if (global.CSS && typeof global.CSS.escape === 'function') return global.CSS.escape(text)
    return text.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`)
  }

  function cssString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  function xpathLiteral(value) {
    const text = String(value)
    if (text.indexOf('"') === -1) return `"${text}"`
    if (text.indexOf("'") === -1) return `'${text}'`
    // XPath 1.0 has no escapes: both quote kinds present needs concat().
    const chunks = text.split('"')
    const pieces = []
    for (let index = 0; index < chunks.length; index += 1) {
      if (index > 0) pieces.push("'\"'")
      if (chunks[index] !== '') pieces.push(`"${chunks[index]}"`)
    }
    return `concat(${pieces.join(', ')})`
  }

  function safeQuery(root, selector) {
    if (!root || typeof selector !== 'string' || selector === '') return null
    try {
      return root.querySelector(selector)
    } catch {
      return null
    }
  }

  function byXpath(document, expression) {
    if (!document || typeof expression !== 'string' || expression === '') return null
    try {
      const result = document.evaluate(
        expression,
        document,
        null,
        (global.XPathResult && global.XPathResult.FIRST_ORDERED_NODE_TYPE) || 9,
        null,
      )
      const node = result && result.singleNodeValue
      return node && node.nodeType === 1 ? node : null
    } catch {
      return null
    }
  }

  /** The selector is only a "stable" one if it resolves to exactly this element. */
  function uniqueSelector(candidate, element) {
    if (!candidate) return false
    try {
      const root = element.ownerDocument
      const found = root.querySelectorAll(candidate)
      return found.length === 1 && found[0] === element
    } catch {
      return false
    }
  }

  function classList(element) {
    const raw = element && typeof element.getAttribute === 'function' ? element.getAttribute('class') : ''
    return normalizeWs(raw)
      .split(' ')
      .filter((name) => name !== '' && name.length <= 40)
  }

  /**
   * A selector that survives a rebuild of the DOM around it: an id, or a
   * test-id/name/aria-label that is unique in the document. Deliberately
   * refuses positional paths — `cssPath` already covers those.
   */
  function stableSelector(element) {
    const tag = String(element.tagName || '').toLowerCase()
    if (element.id && /^[A-Za-z][\w:.-]*$/.test(element.id)) {
      const candidate = `#${cssEscape(element.id)}`
      if (uniqueSelector(candidate, element)) return candidate
    }
    const attributes = ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'role']
    for (const attribute of attributes) {
      const value = typeof element.getAttribute === 'function' ? element.getAttribute(attribute) : null
      if (!value || value.length > 120) continue
      const quoted = `[${attribute}="${cssString(value)}"]`
      const withTag = `${tag}${quoted}`
      if (uniqueSelector(withTag, element)) return withTag
      if (uniqueSelector(quoted, element)) return quoted
    }
    if (tag === 'a') {
      const href = typeof element.getAttribute === 'function' ? element.getAttribute('href') : null
      if (href && href.length <= 200) {
        const candidate = `a[href="${cssString(href)}"]`
        if (uniqueSelector(candidate, element)) return candidate
      }
    }
    return ''
  }

  /**
   * Positional CSS path from the document root, stopping early at a unique id
   * so ordinary pages do not produce 40-segment selectors.
   */
  function cssPath(element) {
    const document = element.ownerDocument
    const root = document.documentElement
    const parts = []
    let node = element
    let guard = 0
    while (node && node.nodeType === 1 && node !== root && guard < 40) {
      guard += 1
      if (node.id && /^[A-Za-z][\w:.-]*$/.test(node.id)) {
        const candidate = `#${cssEscape(node.id)}`
        if (uniqueSelector(candidate, node)) {
          parts.unshift(candidate)
          break
        }
      }
      const tag = String(node.tagName || '').toLowerCase()
      const parent = node.parentElement
      if (!parent) {
        parts.unshift(tag)
        break
      }
      let index = 0
      for (let child = 0; child < parent.children.length; child += 1) {
        const sibling = parent.children[child]
        if (sibling.tagName === node.tagName) {
          index += 1
          if (sibling === node) break
        }
      }
      parts.unshift(index > 0 ? `${tag}:nth-of-type(${index})` : tag)
      node = parent
    }
    return P.truncate(parts.join(' > '), LIMITS.selectorChars)
  }

  function xpath(element) {
    const document = element.ownerDocument
    const parts = []
    let node = element
    let guard = 0
    while (node && node.nodeType === 1 && guard < 40) {
      guard += 1
      if (node.id && node.id.indexOf('"') === -1 && node.id.indexOf("'") === -1) {
        parts.unshift(`//*[@id=${xpathLiteral(node.id)}]`)
        break
      }
      const tag = String(node.tagName || '').toLowerCase()
      let index = 1
      const parent = node.parentNode
      if (parent) {
        for (let child = 0; child < parent.childNodes.length; child += 1) {
          const sibling = parent.childNodes[child]
          if (sibling === node) break
          if (sibling.nodeType === 1 && sibling.tagName === node.tagName) index += 1
        }
      }
      parts.unshift(`${tag}[${index}]`)
      if (node === document.documentElement) break
      node = parent
    }
    return P.truncate(parts.join('/'), LIMITS.selectorChars)
  }

  // ── fingerprint + diagnostics ──────────────────────────────────────────────

  function textExcerptOf(element) {
    let text = ''
    try {
      text = typeof element.innerText === 'string' ? element.innerText : ''
    } catch {
      text = ''
    }
    if (!text) {
      try {
        text = element.textContent || ''
      } catch {
        text = ''
      }
    }
    return normalizeWs(text)
  }

  /** Cheap text for similarity scans: no layout, unlike `innerText`. */
  function cheapText(element) {
    try {
      return normalizeWs(element.textContent || '')
    } catch {
      return ''
    }
  }

  function attributesOf(element) {
    const out = {}
    const source = element.attributes || []
    for (let index = 0; index < source.length; index += 1) {
      const attribute = source[index]
      if (!attribute || !attribute.name) continue
      // Inline handlers are code, not identity. `value` may hold what the user
      // typed into a form (possibly a password), so it never leaves the page.
      if (/^on/i.test(attribute.name)) continue
      if (attribute.name === 'value') continue
      if (attribute.name === 'style' || attribute.name === 'srcset') continue
      const value = normalizeWs(attribute.value)
      if (value === '') continue
      out[attribute.name] = P.truncate(value, 200)
    }
    return out
  }

  /**
   * A shallow stand-in for `outerHTML`: the real subtree can be megabytes, and
   * the consumer only needs "which element was this, and what did it say".
   */
  function outerHtmlPreview(element, limit) {
    const tag = String(element.tagName || '').toLowerCase()
    const attributes = element.attributes || []
    const parts = []
    for (let index = 0; index < attributes.length && parts.length < MAX_ATTRIBUTES; index += 1) {
      const attribute = attributes[index]
      if (!attribute || !attribute.name) continue
      if (/^on/i.test(attribute.name)) continue
      if (attribute.name === 'value') continue
      parts.push(`${attribute.name}="${P.truncate(normalizeWs(attribute.value), 64)}"`)
    }
    const open = `<${tag}${parts.length ? ` ${parts.join(' ')}` : ''}>`
    const text = normalizeWs(cheapText(element))
    const body = text ? `${open}${P.truncate(text, 120)}</${tag}>` : open
    return P.truncate(body, limit)
  }

  const STYLE_KEYS = [
    'display',
    'position',
    'z-index',
    'visibility',
    'opacity',
    'color',
    'background-color',
    'font-size',
    'font-weight',
    'border-radius',
    'overflow',
  ]

  function pickStyles(element) {
    const out = {}
    let style = null
    try {
      style = global.getComputedStyle(element)
    } catch {
      style = null
    }
    if (!style) return out
    for (const key of STYLE_KEYS) {
      let value = ''
      try {
        value = style.getPropertyValue(key)
      } catch {
        value = ''
      }
      if (value) out[key] = P.truncate(normalizeWs(value), 80)
    }
    return out
  }

  function a11yRole(element) {
    const explicit = typeof element.getAttribute === 'function' ? element.getAttribute('role') : null
    if (explicit) return normalizeWs(explicit).split(' ')[0].slice(0, 40)
    const tag = String(element.tagName || '').toLowerCase()
    if (tag === 'a' || tag === 'area') return element.hasAttribute('href') ? 'link' : ''
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'img') return element.hasAttribute('alt') ? 'img' : ''
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'aside') return 'complementary'
    if (tag === 'header') return 'banner'
    if (tag === 'footer') return 'contentinfo'
    if (tag === 'form') return 'form'
    if (tag === 'dialog') return 'dialog'
    if (tag === 'table') return 'table'
    if (tag === 'tr') return 'row'
    if (tag === 'td') return 'cell'
    if (tag === 'th') return 'columnheader'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    if (tag === 'p') return 'paragraph'
    if (tag === 'figure') return 'figure'
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'range') return 'slider'
      if (type === 'search') return 'searchbox'
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
      if (type === 'number') return 'spinbutton'
      return 'textbox'
    }
    return ''
  }

  /**
   * Which framework rendered this node, when it can be told.
   *
   * Firefox content scripts see Xray wrappers: expandos set by page scripts
   * (React's `_reactFiber$…`, Vue's `__vueParentComponent`) are hidden there, so
   * the page's own object is inspected instead. Absence is normal — this is a
   * hint for the agent, never a dependency.
   */
  function frameworkHint(element) {
    const candidates = [element]
    try {
      if (element.wrappedJSObject) candidates.push(element.wrappedJSObject)
    } catch {
      // Cross-compartment access can be refused; the Xray alone may still work.
    }
    for (const target of candidates) {
      let keys = []
      try {
        keys = Object.keys(target)
      } catch {
        keys = []
      }
      for (const key of keys) {
        if (key.startsWith('_reactFiber$') || key.startsWith('__reactFiber$')) return 'react'
        if (key.startsWith('_reactInternalInstance$') || key.startsWith('__reactInternalInstance$')) return 'react'
        if (key === '__vueParentComponent' || key === '__vue__') return 'vue'
        if (key === '__svelte_meta') return 'svelte'
      }
    }
    try {
      if (element.closest('[ng-version]')) return 'angular'
      const page = element.wrappedJSObject
      if (page && typeof page.ngContext === 'number') return 'angular'
    } catch {
      // No ancestor check available; no hint.
    }
    return ''
  }

  // ── element targeting ─────────────────────────────────────────────────────

  function displayOf(element) {
    try {
      const style = global.getComputedStyle(element)
      return style ? String(style.display || '').toLowerCase() : ''
    } catch {
      // Detached or in a display:none subtree: stop climbing rather than guess.
      return 'block'
    }
  }

  /**
   * Inline elements are wrappers around the thing the user means (`<span>`
   * inside `<button>`, `<strong>` inside `<p>`), so the target is the nearest
   * non-inline ancestor.
   */
  function promoteElement(element) {
    let node = element
    let guard = 0
    while (node && guard < 8) {
      guard += 1
      if (!INLINE_DISPLAY.test(displayOf(node))) break
      const parent = node.parentElement
      if (!parent || parent === document.body || parent === document.documentElement) break
      node = parent
    }
    return node
  }

  /** Deepest meaningful element under a viewport point, overlay excluded. */
  function meaningfulAt(x, y) {
    if (!document) return null
    let stack = []
    try {
      stack = document.elementsFromPoint(x, y) || []
    } catch {
      stack = []
    }
    if (stack.length === 0) {
      try {
        const single = document.elementFromPoint ? document.elementFromPoint(x, y) : null
        if (single) stack = [single]
      } catch {
        stack = []
      }
    }
    for (const node of stack) {
      if (!node || node.nodeType !== 1) continue
      if (isOurs(node) || node.id === HOST_ID) continue
      if (SKIP_TARGET_TAGS.has(node.nodeName)) continue
      if (node === document.documentElement) continue
      // The page background is not a target; a click there should do nothing.
      if (node === document.body) return null
      return promoteElement(node)
    }
    return null
  }

  /**
   * Caret position under a viewport point. Gecko has `caretPositionFromPoint`;
   * `caretRangeFromPoint` is the older spelling Chromium still uses. Returns
   * null when neither answers, so the caller can fall back to dropping the
   * selection outright.
   */
  function caretPosition(x, y) {
    if (!document) return null
    try {
      if (typeof document.caretPositionFromPoint === 'function') {
        const position = document.caretPositionFromPoint(x, y)
        if (position && position.offsetNode) {
          return { node: position.offsetNode, offset: Math.max(0, Math.trunc(Number(position.offset) || 0)) }
        }
      }
      if (typeof document.caretRangeFromPoint === 'function') {
        const range = document.caretRangeFromPoint(x, y)
        if (range && range.startContainer) {
          return { node: range.startContainer, offset: Math.max(0, Math.trunc(Number(range.startOffset) || 0)) }
        }
      }
    } catch {
      // A detached document or a native-shadow retarget: no caret to report.
    }
    return null
  }

  /** `<tag.class · W×H>` chip text for the hover highlight. */
  function chipLabel(element, rect) {
    const tag = String(element.tagName || '').toLowerCase()
    const classes = classList(element)
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join('')
    const size = `${Math.max(0, Math.round(rect.w))}×${Math.max(0, Math.round(rect.h))}`
    return P.truncate(`${tag}${classes} · ${size}`, 64)
  }

  // ── the three anchor builders ──────────────────────────────────────────────

  /**
   * Nearest non-inline container around a range endpoint: the block that owns
   * the selected text, used as the scope for domRange and quote matching.
   */
  function blockFor(node) {
    let element = node ? (node.nodeType === 1 ? node : node.parentElement) : null
    if (!element) return document.body || null
    let guard = 0
    while (element && element !== document.body && element !== document.documentElement && guard < 30) {
      guard += 1
      if (!INLINE_DISPLAY.test(displayOf(element))) return element
      element = element.parentElement
    }
    return element || document.body || null
  }

  function clampOffset(offset, node) {
    const length = node && node.nodeValue ? node.nodeValue.length : 0
    const value = Number(offset)
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.min(Math.trunc(value), length))
  }

  /**
   * Selection anchor. `rect` is in document coordinates (the validator requires
   * it), while the composer's crop rect is kept in viewport pixels separately.
   */
  function selectionState(selection) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
    const range = selection.getRangeAt(0)
    if (!range) return null
    let text = ''
    try {
      text = String(range.toString() || '')
    } catch {
      text = ''
    }
    if (text.trim() === '') return null

    const block = blockFor(range.startContainer)
    if (!block) return null
    const nodes = nodesInRange(range, block)
    if (nodes.length === 0) return null
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    // A range endpoint that sits on an element boundary is not inside a text
    // node, so the first/last text node it touches is fully selected.
    const startOffset = first === range.startContainer ? clampOffset(range.startOffset, first) : 0
    const endOffset = last === range.endContainer ? clampOffset(range.endOffset, last) : (last.nodeValue || '').length
    const startPath = pathWithin(first, block)
    const endPath = pathWithin(last, block)
    if (!startPath || !endPath) return null

    const index = textIndexOf(block)
    const blockStart = offsetOf(index, first)
    const blockEnd = offsetOf(index, last)
    if (blockStart < 0 || blockEnd < 0) return null
    const startPosition = blockStart + startOffset
    const endPosition = blockEnd + endOffset
    const quoteText = index.text.slice(startPosition, endPosition) || text
    // No ellipsis: `exact` is what the hydrator searches for.
    const exact = quoteText.slice(0, LIMITS.quoteChars)
    if (exact.trim() === '') return null

    let viewportRect = unionRangeRects(range)
    if (viewportRect.w === 0 && viewportRect.h === 0) viewportRect = rectOf(block.getBoundingClientRect())
    // The line boxes are what the overlay paints over the marked words: the
    // composer takes focus, and with it the browser's own selection highlight,
    // so without them the user could not see what the annotation is about.
    const lineRects = rangeClientRects(range, MAX_MARK_LINES)

    const anchor = {
      kind: 'selection',
      quote: {
        exact,
        prefix: index.text.slice(Math.max(0, startPosition - 32), startPosition),
        suffix: index.text.slice(endPosition, endPosition + 32),
      },
      domRange: {
        blockSelector: cssPath(block),
        startPath,
        startOffset,
        endPath,
        endOffset,
      },
      textPosition: { start: startPosition, end: endPosition },
      rect: roundRect(viewportToPage(viewportRect)),
    }
    return { anchor, viewportRect, lineRects, live: { kind: 'range', range } }
  }

  /** Element anchor: selectors, a fingerprint for re-finding it, diagnostics. */
  function elementState(element) {
    if (!element || element.nodeType !== 1) return null
    const viewportRect = rectOf(element.getBoundingClientRect())
    const selectors = {}
    const stable = stableSelector(element)
    if (stable) selectors.stable = stable
    const path = cssPath(element)
    if (path) selectors.cssPath = path
    const xp = xpath(element)
    if (xp) selectors.xpath = xp
    if (!selectors.stable && !selectors.cssPath && !selectors.xpath) return null

    const hint = frameworkHint(element)
    const anchor = {
      kind: 'element',
      selectors,
      fingerprint: {
        tag: String(element.tagName || '').toLowerCase(),
        textExcerpt: P.truncate(textExcerptOf(element), Math.min(LIMITS.excerptChars, 200)),
        attrs: attributesOf(element),
        outerHtmlPreview: outerHtmlPreview(element, Math.min(LIMITS.outerHtmlChars, 500)),
      },
      diagnostics: compact({
        computedStyles: pickStyles(element),
        a11yRole: a11yRole(element),
        frameworkHint: hint,
      }),
      rect: roundRect(viewportToPage(viewportRect)),
    }
    return { anchor, viewportRect, live: { kind: 'element', element } }
  }

  function gridPoints(rect, steps) {
    const points = []
    for (let row = 0; row < steps; row += 1) {
      for (let column = 0; column < steps; column += 1) {
        points.push({
          x: rect.x + ((column + 0.5) * rect.w) / steps,
          y: rect.y + ((row + 0.5) * rect.h) / steps,
        })
      }
    }
    return points
  }

  /**
   * Sample a 4×4 grid instead of scanning every element on the page: the stack
   * at each point already contains the region's ancestors, and the sampling
   * cost is constant regardless of document size.
   */
  function intersectingElementsOf(viewportRect) {
    const found = new Map()
    const regionArea = areaOf(viewportRect)
    if (regionArea <= 0) return []
    for (const point of gridPoints(viewportRect, 4)) {
      let stack = []
      try {
        stack = document.elementsFromPoint(point.x, point.y) || []
      } catch {
        stack = []
      }
      for (const element of stack) {
        if (!element || element.nodeType !== 1) continue
        if (isOurs(element) || element.id === HOST_ID) continue
        // The document shell always intersects, so it says nothing about what
        // the user boxed.
        if (element === document.documentElement || element === document.body) continue
        if (found.has(element)) continue
        const rect = rectOf(element.getBoundingClientRect())
        const ratio = areaOf(intersection(rect, viewportRect)) / regionArea
        if (ratio <= 0.02) continue
        found.set(element, ratio)
      }
    }
    return (
      [...found.entries()]
        .sort((left, right) => right[1] - left[1])
        // Three is enough to describe a region; a longer list is payload, not context.
        .slice(0, 3)
        .map(([element, ratio]) => {
          const text = cheapText(element)
          return compact({
            tag: String(element.tagName || '').toLowerCase(),
            selector: cssPath(element),
            // Page frameworks inline their state as text; quoting it back to the
            // model is noise the user cannot recognise.
            textExcerpt: text && !looksLikePayload(text) ? P.truncate(text, Math.min(LIMITS.excerptChars, 80)) : '',
            intersectionRatio: Math.round(ratio * 100) / 100,
          })
        })
    )
  }

  /**
   * Whether a text node's content is a serialized payload rather than prose.
   * GitHub (and most SSR frameworks) embed `{"props":…}` blobs in the tree.
   * @param {string} text
   */
  function looksLikePayload(text) {
    const head = text.trimStart().slice(0, 1)
    return head === '{' || head === '['
  }

  function anchorElementFor(viewportRect, pageRect) {
    const point = { x: viewportRect.x + viewportRect.w / 2, y: viewportRect.y + viewportRect.h / 2 }
    const element = meaningfulAt(point.x, point.y)
    if (!element) return null
    const selector = cssPath(element)
    if (!selector) return null
    const elementPageRect = viewportToPage(rectOf(element.getBoundingClientRect()))
    return {
      selector,
      offsetX: round1(pageRect.x - elementPageRect.x),
      offsetY: round1(pageRect.y - elementPageRect.y),
    }
  }

  /** Region anchor: the dragged box, in both coordinate systems. */
  function regionState(viewportRect) {
    const normalized = normalizeRect(viewportRect)
    if (!normalized || normalized.w < 1 || normalized.h < 1) return null
    // A drag that starts past an edge (or runs past one) must not persist a
    // negative or off-screen box: the page rect would point outside the
    // document and the crop would be clipped anyway.
    const inside = intersection(normalized, {
      x: 0,
      y: 0,
      w: Number(global.innerWidth) || 0,
      h: Number(global.innerHeight) || 0,
    })
    if (!inside || inside.w < 1 || inside.h < 1) return null
    const pageRect = roundRect(viewportToPage(inside))
    const anchorElement = anchorElementFor(inside, pageRect)
    const anchor = {
      kind: 'region',
      pageRect,
      viewportRect: roundRect(inside),
      ...(anchorElement ? { anchorElement } : {}),
      intersectingElements: intersectingElementsOf(inside),
    }
    return { anchor, viewportRect: inside, live: null }
  }

  // ── page context ───────────────────────────────────────────────────────────

  function pageContext(consoleErrors) {
    return {
      viewport: {
        width: Math.round(Number(global.innerWidth) || 0),
        height: Math.round(Number(global.innerHeight) || 0),
        dpr: Math.round((Number(global.devicePixelRatio) || 1) * 100) / 100,
        scrollX: Math.round(Number(global.scrollX) || 0),
        scrollY: Math.round(Number(global.scrollY) || 0),
      },
      consoleErrors: Array.isArray(consoleErrors) ? consoleErrors.slice(-10) : [],
    }
  }

  /**
   * Where the anchor is on screen *now*, for the screenshot crop. Elements and
   * ranges are re-measured (the page may have scrolled or re-laid-out since the
   * click); regions follow their stored page rect.
   */
  function liveViewportRect(state) {
    if (!state || !state.anchor) return null
    const anchor = state.anchor
    if (anchor.kind === 'region') return pageToViewport(anchor.pageRect)
    const live = state.live
    if (live) {
      try {
        if (live.kind === 'element' && live.element && live.element.isConnected) {
          return rectOf(live.element.getBoundingClientRect())
        }
        if (live.kind === 'range' && live.range && live.range.startContainer && live.range.startContainer.isConnected) {
          return unionRangeRects(live.range)
        }
      } catch {
        // Removed by the page between click and send: use the captured rect.
      }
    }
    if (state.viewportRect) return { ...state.viewportRect }
    if (anchor.rect) return pageToViewport(anchor.rect)
    return null
  }

  ns.HOST_ID = HOST_ID
  ns.geom = ns_geom
  ns.dom = {
    safeQuery,
    byXpath,
    cssPath,
    stableSelector,
    xpath,
    textExcerptOf,
    cheapText,
    classList,
  }
  ns.anchor = {
    selection: selectionState,
    element: elementState,
    region: regionState,
    meaningfulAt,
    caretPosition,
    chipLabel,
    liveViewportRect,
    pageContext,
    /** Empty when the anchor matches the protocol; used as a last guard. */
    validate(anchor) {
      try {
        return P.validateAnchor(anchor)
      } catch {
        return ['validateAnchor threw']
      }
    },
  }
})(globalThis)
