/**
 * A minimal fake DOM for exercising the anchor and hydrator content scripts in
 * `node:test`, the same way `gesture.test.js` boots `main.js`: the classic
 * scripts run in a `node:vm` context and are driven through the
 * `__DSH_ANNO__` namespace they publish. Only the members those scripts touch
 * exist — a full DOM emulation would be a second engine to keep honest.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

export const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Round-trip a value out of the vm realm so strict deep-equality against host
 * objects works: a foreign-realm object never deep-equals one of ours.
 */
export function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

/** The manifest order the content scripts depend on: protocol, then anchor, then hydrator. */
const SCRIPTS = ['src/shared/protocol.global.js', 'src/content/anchor.js', 'src/content/hydrator.js']

export class FakeText {
  constructor(value) {
    this.nodeType = 3
    this.nodeValue = String(value)
    this.childNodes = []
    this.parentNode = null
    this.ownerDocument = null
    this.isConnected = true
  }

  get parentElement() {
    const parent = this.parentNode
    return parent && parent.nodeType === 1 ? parent : null
  }
}

/** Undo the escaping `cssString` applies before comparing attribute values. */
function unquote(value) {
  return value.replace(/\\(.)/g, '$1')
}

/** One simple-segment matcher: `tag`, `#id`, `[a="v"]`, `tag[a="v"]`, plus `:nth-of-type(n)`. */
export function segmentMatches(element, segment) {
  let rest = segment
  if (/^#/.test(rest)) {
    return element.id === rest.slice(1)
  }
  let nth = null
  const nthMatch = rest.match(/^(.*):nth-of-type\((\d+)\)$/)
  if (nthMatch) {
    rest = nthMatch[1]
    nth = Number(nthMatch[2])
  }
  const attrMatch = rest.match(/^([a-zA-Z][\w-]*)?\[([^=\]]+)="((?:[^"\\]|\\.)*)"\]$/)
  const presenceMatch = rest.match(/^([a-zA-Z][\w-]*)?\[([^=\]]+)\]$/)
  let tag = null
  if (attrMatch) {
    tag = attrMatch[1] || null
    if (tag && element.tagName !== tag.toUpperCase()) return false
    if (element.getAttribute(attrMatch[2]) !== unquote(attrMatch[3])) return false
  } else if (presenceMatch) {
    tag = presenceMatch[1] || null
    if (tag && element.tagName !== tag.toUpperCase()) return false
    if (!element.hasAttribute(presenceMatch[2])) return false
  } else if (/^[a-zA-Z][\w-]*$/.test(rest)) {
    tag = rest
    if (element.tagName !== tag.toUpperCase()) return false
  } else if (rest !== '*') {
    return false
  }
  if (nth !== null) {
    const parent = element.parentElement
    if (!parent) return false
    const sameTag = parent.children.filter((child) => child.tagName === element.tagName)
    if (sameTag[nth - 1] !== element) return false
  }
  return true
}

export class FakeElement {
  constructor(tag, attributes = {}) {
    this.nodeType = 1
    this.tagName = String(tag).toUpperCase()
    this.id = attributes.id || ''
    this.attrs = new Map(Object.entries(attributes))
    this.childNodes = []
    this.parentNode = null
    this.ownerDocument = null
    this.isConnected = true
    this.rect = { left: 0, top: 0, width: 0, height: 0 }
    this.display = 'block'
  }

  get nodeName() {
    return this.tagName
  }

  get parentElement() {
    const parent = this.parentNode
    return parent && parent.nodeType === 1 ? parent : null
  }

  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1)
  }

  get attributes() {
    return [...this.attrs.entries()].map(([name, value]) => ({ name, value }))
  }

  get textContent() {
    let out = ''
    for (const child of this.childNodes) {
      out += child.nodeType === 3 ? child.nodeValue : child.textContent || ''
    }
    return out
  }

  get innerText() {
    return this.textContent
  }

  getAttribute(name) {
    const value = this.attrs.get(name)
    return value === undefined ? null : String(value)
  }

  hasAttribute(name) {
    return this.attrs.has(name)
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value))
  }

  getBoundingClientRect() {
    return { ...this.rect }
  }

  closest(selector) {
    const segments = selector.split(/\s*>\s*/)
    if (segments.length !== 1) return null
    for (let node = this; node && node.nodeType === 1; node = node.parentElement) {
      if (segmentMatches(node, segments[0])) return node
    }
    return null
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this
      node.ownerDocument = this.ownerDocument
      this.childNodes.push(node)
    }
    return this
  }
}

/**
 * A `Range` whose geometry and traversal are driven by the fake document's
 * text-node order, which is all the anchor/hydrator maths needs.
 */
export class FakeRange {
  constructor(document) {
    this.document = document
    this.startContainer = null
    this.startOffset = 0
    this.endContainer = null
    this.endOffset = 0
    this.rects = [{ left: 10, top: 20, width: 50, height: 16 }]
  }

  setStart(node, offset) {
    this.startContainer = node
    this.startOffset = offset
  }

  setEnd(node, offset) {
    this.endContainer = node
    this.endOffset = offset
  }

  get commonAncestorContainer() {
    for (let node = this.startContainer; node; node = node.parentNode) {
      let found = false
      for (let other = this.endContainer; other; other = other.parentNode) {
        if (other === node) found = true
      }
      if (found) return node
    }
    return null
  }

  #list() {
    return this.document.textNodes()
  }

  toString() {
    const list = this.#list()
    const first = list.indexOf(this.startContainer)
    const last = list.indexOf(this.endContainer)
    if (first < 0 || last < 0) return ''
    let out = ''
    for (let index = first; index <= last; index += 1) {
      const value = list[index].nodeValue
      if (index === first && index === last) out += value.slice(this.startOffset, this.endOffset)
      else if (index === first) out += value.slice(this.startOffset)
      else if (index === last) out += value.slice(0, this.endOffset)
      else out += value
    }
    return out
  }

  intersectsNode(node) {
    const list = this.#list()
    const first = list.indexOf(this.startContainer)
    const last = list.indexOf(this.endContainer)
    const at = list.indexOf(node)
    if (first < 0 || last < 0 || at < 0) return false
    const flat = (index) => {
      let position = 0
      for (let i = 0; i < index; i += 1) position += list[i].nodeValue.length
      return position
    }
    const start = flat(first) + this.startOffset
    const end = flat(last) + this.endOffset
    const nodeStart = flat(at)
    return nodeStart < end && nodeStart + node.nodeValue.length > start
  }

  getClientRects() {
    return this.rects
  }

  getBoundingClientRect() {
    let left = Number.POSITIVE_INFINITY
    let top = Number.POSITIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    for (const box of this.rects) {
      left = Math.min(left, box.left)
      top = Math.min(top, box.top)
      right = Math.max(right, box.left + box.width)
      bottom = Math.max(bottom, box.top + box.height)
    }
    if (!Number.isFinite(left)) return { left: 0, top: 0, width: 0, height: 0 }
    return { left, top, width: right - left, height: bottom - top }
  }
}

/**
 * A document with `querySelector(All)`, `evaluate`, `createTreeWalker` and
 * `createRange` over the fake tree — enough for every selector strategy the
 * hydrator tries. `pointStack` decides what `elementsFromPoint` answers.
 */
export function createDocument() {
  const html = new FakeElement('html')
  const body = new FakeElement('body')
  const document = {
    nodeType: 9,
    documentElement: html,
    body,
    ownerDocument: null,
    pointStack: () => [],
  }
  html.ownerDocument = document
  body.ownerDocument = document
  html.append(body)

  const allElements = () => {
    const out = []
    const walk = (node) => {
      out.push(node)
      for (const child of node.children) walk(child)
    }
    walk(html)
    return out
  }

  document.allElements = allElements
  document.textNodes = () => {
    const out = []
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) out.push(child)
        else walk(child)
      }
    }
    walk(html)
    return out
  }

  document.querySelector = (selector) => document.querySelectorAll(selector)[0] || null
  document.querySelectorAll = (selector) => {
    const parts = String(selector).split(/\s*>\s*/)
    return allElements().filter((element) => {
      const chain = []
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        chain.unshift(node)
      }
      if (chain.length < parts.length) return false
      for (let start = 0; start + parts.length <= chain.length; start += 1) {
        let ok = true
        for (let index = 0; index < parts.length; index += 1) {
          if (!segmentMatches(chain[start + index], parts[index])) {
            ok = false
            break
          }
        }
        if (ok) return true
      }
      return false
    })
  }

  // XPath as `anchor.js#xpath` writes it: an optional `//*[@id="…"]` head,
  // then `tag[n]` child segments.
  document.evaluate = (expression) => {
    let rest = String(expression)
    let node = null
    const byId = rest.match(/^\/\/\*\[@id="([^"]*)"\]\/?(.*)$/)
    if (byId) {
      node = allElements().find((element) => element.id === byId[1]) || null
      rest = byId[2]
    } else {
      node = html
    }
    while (node && rest) {
      const cut = rest.indexOf('/')
      const segment = cut < 0 ? rest : rest.slice(0, cut)
      rest = cut < 0 ? '' : rest.slice(cut + 1)
      const match = segment.match(/^([a-zA-Z][\w-]*)\[(\d+)\]$/)
      if (!match) {
        node = null
        break
      }
      const sameTag = node.childNodes.filter(
        (child) => child.nodeType === 1 && child.tagName === match[1].toUpperCase(),
      )
      node = sameTag[Number(match[2]) - 1] || null
    }
    return { singleNodeValue: node && node.nodeType === 1 ? node : null }
  }

  document.getElementsByTagName = (tag) => {
    const wanted = String(tag).toUpperCase()
    return allElements().filter((element) => element.tagName === wanted)
  }

  document.createTreeWalker = (root, _whatToShow, filter) => {
    const accepted = []
    const walk = (node) => {
      for (const child of node.childNodes || []) {
        if (child.nodeType === 3 && filter(child) === 1) accepted.push(child)
        walk(child)
      }
    }
    walk(root)
    let cursor = 0
    return { nextNode: () => accepted[cursor++] || null }
  }

  document.createRange = () => new FakeRange(document)
  document.elementsFromPoint = (x, y) => document.pointStack(x, y)
  document.elementFromPoint = (x, y) => document.pointStack(x, y)[0] || null

  return { document, html, body }
}

/**
 * Run the content scripts in a fresh context over the given document, and hand
 * back the `__DSH_ANNO__` namespace plus the sandbox for further stubbing.
 */
export async function bootContent({ document, scrollX = 0, scrollY = 0, innerWidth = 1280, innerHeight = 800 } = {}) {
  const timers = new Map()
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    document,
    scrollX,
    scrollY,
    innerWidth,
    innerHeight,
    devicePixelRatio: 1,
    getComputedStyle: (element) => ({
      display: (element && element.display) || 'block',
      getPropertyValue: (key) => (key === 'display' ? (element && element.display) || 'block' : ''),
    }),
    setTimeout: (fn) => {
      const id = timers.size + 1
      timers.set(id, fn)
      return id
    },
    clearTimeout: (id) => {
      timers.delete(id)
    },
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  for (const path of SCRIPTS) {
    const code = await readFile(join(extensionRoot, path), 'utf8')
    try {
      vm.runInContext(code, context, { filename: path })
    } catch (error) {
      throw new Error(`${path} threw while loading: ${error.message}`)
    }
  }
  /** Run every timer the scripts queued (the scheduler's deferred run). */
  sandbox.flushTimers = () => {
    for (const fn of [...timers.values()]) fn()
    timers.clear()
  }
  return { ns: sandbox.__DSH_ANNO__, sandbox }
}
