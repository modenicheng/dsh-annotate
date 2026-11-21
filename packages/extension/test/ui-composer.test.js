/**
 * Composer placement and IME guards.
 *
 * E4: the card's rect arrives in viewport pixels but must follow the page:
 * scrolling while the card is open has to move it with the outlined target,
 * the same way badges re-project a stored page rect against the live scroll
 * offset. E5: an Enter that the browser reports with `isComposing === false`
 * while a composition is still ending (old Safari, some Linux IMEs) must not
 * send.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeType = 1
    this.className = ''
    this.textContent = ''
    this.title = ''
    this.type = ''
    this.disabled = false
    this.rows = 0
    this.spellcheck = false
    this.value = ''
    this.style = {}
    this.dataset = {}
    this.children = []
    this.attributes = new Map()
    this.listeners = []
    this.classList = { add() {} }
  }

  append(...values) {
    for (const value of values) this.children.push(value instanceof FakeNode ? value : String(value))
  }

  appendChild(node) {
    this.children.push(node)
    return node
  }

  addEventListener(type, listener) {
    this.listeners.push({ type, listener })
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  focus() {}

  fire(type, event) {
    for (const entry of this.listeners) {
      if (entry.type === type) entry.listener(event)
    }
  }
}

/** Load `ui/dom.js` + `ui/composer.js` in manifest order and install the part. */
async function installComposer() {
  const raf = []
  const document = {
    createElement: (tag) => new FakeNode(tag),
    createElementNS: () => new FakeNode('svg'),
  }
  const sandbox = {
    document,
    navigator: { language: 'en' },
    innerWidth: 1000,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    setTimeout() {
      return 0
    },
    clearTimeout() {},
    requestAnimationFrame: (fn) => {
      raf.push(fn)
      return raf.length
    },
  }
  sandbox.globalThis = sandbox
  sandbox.__DSH_PROTOCOL__ = { INTENTS: [] }
  const context = vm.createContext(sandbox)

  for (const path of ['src/content/ui/dom.js', 'src/content/ui/composer.js']) {
    const code = await readFile(join(extensionRoot, path), 'utf8')
    vm.runInContext(code, context, { filename: path })
  }

  const ui = sandbox.__DSH_ANNO__.ui
  const state = { composerOpen: false, intent: '', connected: 'ok', busy: false }
  const sent = []
  const cancelled = []
  const ctx = {
    global: sandbox,
    t: (key) => key,
    dom: ui.dom,
    state,
    handlers: {
      onSend: (payload) => sent.push(payload),
      onCancel: (reason) => cancelled.push(reason),
    },
    target: {
      row: new FakeNode('div'),
      resetForOpen() {},
      resetForClose() {},
    },
    overlay: {
      clearLocked() {},
    },
  }
  const part = ui.composer.install(ctx)
  return { part, sandbox, state, sent, cancelled, raf, textarea: null }
}

/** Open the card with a known rect and settle the first paint. */
function open(part, raf, rect) {
  part.openComposer({ kind: 'selection', summary: 's', rect })
  for (const fn of raf.splice(0)) fn()
}

test('the composer follows the page when scrolled after opening', async () => {
  const { part, sandbox, raf } = await installComposer()
  const rect = { x: 100, y: 400, w: 200, h: 30 }
  open(part, raf, rect)
  // Below the subject: y + h + 8 = 438, and 438 + 190 fits an 800px viewport.
  assert.equal(part.node.style.top, '438px', 'placed under the subject at scroll 0')

  sandbox.scrollY = 200
  part.position({ width: 1000, height: 800 })
  assert.equal(part.node.style.top, '238px', 'the stored page rect is re-projected, not clamped in place')

  sandbox.scrollY = 600
  part.position({ width: 1000, height: 800 })
  // y would be 400 - 600 = -200, above the subject at -178; the flip would
  // land at -378, so both clamp to the top margin.
  assert.equal(part.node.style.top, '10px', 'a subject scrolled off-screen clamps, never goes negative')

  sandbox.scrollY = 0
  sandbox.scrollX = 40
  part.position({ width: 1000, height: 800 })
  assert.equal(part.node.style.left, '60px', 'horizontal scroll shifts the card too')
})

test('closing clears the stored page rect', async () => {
  const { part, sandbox, raf } = await installComposer()
  open(part, raf, { x: 8, y: 8, w: 0, h: 0 })
  const before = part.node.style.top
  part.closeComposer()
  sandbox.scrollY = 300
  part.position({ width: 1000, height: 800 })
  assert.equal(part.node.style.top, before, 'no card, no placement')
})

function keyEvent(overrides) {
  return {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    preventDefaultCalled: false,
    stopPropagationCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true
    },
    stopPropagation() {
      this.stopPropagationCalled = true
    },
    ...overrides,
  }
}

test('Enter does not send while a composition is in progress', async () => {
  const { part, raf, sent } = await installComposer()
  open(part, raf, { x: 8, y: 8, w: 0, h: 0 })
  const textarea = part.node.children.find((child) => child && child.tagName === 'TEXTAREA')
  textarea.value = '你好'

  textarea.fire('compositionstart', {})
  textarea.fire('keydown', keyEvent({ isComposing: true }))
  textarea.fire('keydown', keyEvent({ isComposing: false }))
  assert.equal(sent.length, 0, 'Enter stays the IME\u2019s while composing, even with isComposing=false')

  textarea.fire('compositionend', {})
  textarea.fire('keydown', keyEvent({}))
  assert.equal(sent.length, 1, 'Enter sends once the composition has ended')
  assert.equal(sent[0].text, '你好')
})

test('plain Enter sends without any composition events', async () => {
  const { part, raf, sent } = await installComposer()
  open(part, raf, { x: 8, y: 8, w: 0, h: 0 })
  const textarea = part.node.children.find((child) => child && child.tagName === 'TEXTAREA')
  textarea.value = 'plain'
  textarea.fire('keydown', keyEvent({}))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, 'plain')
})
