/**
 * dsh-marker content script 3/4 (ui) — the small, dependency-free helpers.
 *
 * `createElement` is the only node factory the UI uses: it always assigns text
 * through `textContent`, never `innerHTML`, so no page-derived string is ever
 * parsed as HTML. `setVisible` toggles the `[f-hidden]` attribute the
 * stylesheet keys on, which keeps visibility a single CSS decision instead of a
 * `style.display` written from JS.
 */
;(function installUiDom(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  const ui = (ns.ui = ns.ui || {})
  if (ui.dom) return

  function createElement(tag, className, text) {
    const element = global.document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = String(text)
    return element
  }

  /**
   * Build one icon from the extension's own asset files (`assets/icons/`).
   *
   * The SVG ships as a real file, not inline path data, and reaches the page
   * through `runtime.getURL` — the manifest lists the directory in
   * `web_accessible_resources`. Rather than an `<img>` (whose fill cannot
   * follow the text colour), the file becomes a CSS mask over a span, so the
   * icon paints with `currentColor` like any glyph. Without an extension
   * runtime — a plain test harness — the span simply stays empty.
   * @param {string} name asset file name without extension
   */
  function createIcon(name) {
    const span = global.document.createElement('span')
    span.className = `icon icon-${name}`
    const runtime = (global.browser && global.browser.runtime) || (global.chrome && global.chrome.runtime)
    if (runtime && typeof runtime.getURL === 'function') {
      const url = runtime.getURL(`assets/icons/${name}.svg`)
      const masked = `url("${url}")`
      span.style.maskImage = masked
      span.style.webkitMaskImage = masked
    }
    return span
  }

  function setVisible(element, visible) {
    if (!element) return
    if (visible) element.removeAttribute('f-hidden')
    else element.setAttribute('f-hidden', '')
  }

  function clamp(value, minimum, maximum) {
    if (maximum < minimum) return minimum
    return Math.max(minimum, Math.min(value, maximum))
  }

  /** Replace `{name}` placeholders in a translated template. */
  function fill(template, values) {
    return String(template).replace(/\{(\w+)\}/g, (match, key) =>
      values && Object.hasOwn(values, key) ? String(values[key]) : match,
    )
  }

  function badgeLabel(index) {
    return String(Math.max(1, Math.trunc(Number(index) || 1)))
  }

  function viewportSize() {
    return {
      width: Math.max(0, Number(global.innerWidth) || 0),
      height: Math.max(0, Number(global.innerHeight) || 0),
    }
  }

  function scrollOffset() {
    return { x: Number(global.scrollX) || 0, y: Number(global.scrollY) || 0 }
  }

  ui.dom = { createElement, createIcon, setVisible, clamp, fill, badgeLabel, viewportSize, scrollOffset }
})(globalThis)
