/**
 * Keep the shadow-root mount list honest.
 *
 * `index.js` mounts the UI with one `shadow.append(...)` call whose arguments are
 * a part's exported nodes. `append()` accepts anything, though: an argument that
 * is not a node is stringified, so handing it a function does not throw — it
 * paints the function body into the page. That is exactly how the toast turned
 * into a wall of source code at the top-left of every annotated page, so this
 * test boots the HUD part and pins the contract the mount list depends on: the
 * exported `toast` is the element, `showToast` is the behaviour, and appending
 * the exports yields elements only.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)

/**
 * A node that behaves like `Element.append()` in the one way that matters here:
 * a value that is not a node lands in `children` as a string.
 */
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeType = 1
    this.className = ''
    this.textContent = ''
    this.title = ''
    this.type = ''
    this.disabled = false
    this.dataset = {}
    this.children = []
    this.attributes = new Map()
    this.listeners = []
  }

  append(...values) {
    for (const value of values) this.children.push(value instanceof FakeNode ? value : String(value))
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
}

/**
 * Load `ui/dom.js` and `ui/hud.js` in manifest order and install the HUD with a
 * synthetic `ctx`, exactly as `ui/index.js` does with the real one.
 */
async function installHud() {
  const timers = []
  const document = { createElement: (tag) => new FakeNode(tag) }
  const sandbox = {
    document,
    navigator: { language: 'zh-CN' },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimeout() {},
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)

  for (const path of ['src/content/ui/dom.js', 'src/content/ui/hud.js']) {
    const code = await readFile(join(extensionRoot, path), 'utf8')
    try {
      vm.runInContext(code, context, { filename: path })
    } catch (error) {
      throw new Error(`${path} threw while loading: ${error.message}`)
    }
  }

  const ui = sandbox.__DSH_ANNO__.ui
  assert.ok(ui.dom !== undefined, 'the DOM helpers were published')
  assert.ok(ui.hud !== undefined, 'the HUD part was published')

  const ctx = {
    global: sandbox,
    t: (key) => key,
    dom: ui.dom,
    badges: { closeAllBadgeCards() {} },
    handlers: { onClear() {}, onExit() {}, onToggleHidden() {} },
    state: {
      hidden: false,
      hudVisible: false,
      mode: 'auto',
      connected: '',
      counts: { total: 0, resolved: 0 },
      clearing: '',
      clearArmed: '',
      clearTimer: 0,
      clearProgress: 0,
      clearTotal: 0,
      toastTimer: 0,
    },
  }

  return { part: ui.hud.install(ctx), timers }
}

test('the HUD exports its toast as an element, not as its show function', async () => {
  const { part } = await installHud()
  assert.equal(typeof part.showToast, 'function', 'showToast is the behaviour')
  assert.ok(part.toast instanceof FakeNode, 'toast is the element the mount list appends')
  assert.equal(part.toast.className, 'toast')
  assert.equal(part.toast.nodeType, 1)
})

test('appending the HUD exports produces elements only', async () => {
  const { part } = await installHud()
  const shadow = new FakeNode('div')
  shadow.append(part.node, part.pick, part.toast)
  for (const child of shadow.children) {
    assert.ok(child instanceof FakeNode, `a non-node was appended: ${String(child).slice(0, 40)}`)
  }
  assert.equal(shadow.children.length, 3)
})

test('showToast writes into the mounted element and hide() takes it away', async () => {
  const { part, timers } = await installHud()
  part.showToast('已保存', 'ok')
  assert.equal(part.toast.textContent, '已保存')
  assert.equal(part.toast.dataset.tone, 'ok')
  assert.equal(part.toast.hasAttribute('f-hidden'), false)
  assert.deepEqual(
    timers.map((timer) => timer.ms),
    [2800],
  )

  part.showToast('', 'error')
  assert.equal(part.toast.textContent, '已保存', 'an empty message is not a toast')

  part.hide()
  assert.equal(part.toast.hasAttribute('f-hidden'), true)
})
