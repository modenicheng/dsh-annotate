/**
 * dsh-annotate content script 3/4 (ui) — the small, dependency-free helpers.
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

  ui.dom = { createElement, setVisible, clamp, fill, badgeLabel, viewportSize, scrollOffset }
})(globalThis)
