/**
 * The target picker's new-workspace arm (M4.7a).
 *
 * D26: the path is chosen, not typed — anchor rows come from the registered
 * workspaces' own paths and parents, the user writes at most one folder name,
 * and the manual absolute path survives as the demoted fallback for a host
 * that reports no workspace at all. Everything below runs against the same
 * `anno.session.create` body M4.6 already sent: no new wire surface.
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
    this.value = ''
    this.type = ''
    this.disabled = false
    this.spellcheck = false
    this.style = {}
    this.dataset = {}
    this.children = []
    this.attributes = new Map()
    this.listeners = []
  }

  /** Real-DOM semantics: assigning textContent replaces the children. */
  get textContent() {
    let out = ''
    for (const child of this.children) out += typeof child === 'string' ? child : child.textContent
    return out
  }

  set textContent(value) {
    this.children = String(value) === '' ? [] : [String(value)]
  }

  append(...nodes) {
    for (const node of nodes) this.children.push(node)
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

  getAttribute(name) {
    const value = this.attributes.get(name)
    return value === undefined ? null : String(value)
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  hasAttribute(name) {
    return this.attributes.has(name)
  }

  focus() {}

  fire(type) {
    for (const entry of this.listeners) {
      if (entry.type === type) entry.listener({ preventDefault() {}, stopPropagation() {} })
    }
  }
}

/** Round-trip a vm-realm value so strict deep-equality against host objects works. */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Boot `ui/dom.js` + `ui/target.js`, adopt a workspace list, and drive the
 * picker straight into the 新建工作区 mode. The fields area is
 * `[anchorLabel, anchorList, nameLabel, nameInput, titleLabel, titleInput,
 * use, manualToggle, pathLabel, pathInput, noAnchorsHint]`.
 * @param {any[]} workspacesList
 */
async function installTarget(workspacesList) {
  const document = { createElement: (tag) => new FakeNode(tag) }
  const sandbox = { document }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  for (const path of ['src/content/ui/dom.js', 'src/content/ui/target.js']) {
    const code = await readFile(join(extensionRoot, path), 'utf8')
    vm.runInContext(code, context, { filename: path })
  }
  const ui = sandbox.__DSH_ANNO__.ui
  const state = {
    composerOpen: true,
    busy: false,
    targets: [],
    targetNote: '',
    workspaces: [],
    targetOpen: false,
    targetQuery: '',
    targetActive: 0,
    targetMode: 'pick',
    targetId: '',
    newPanelOpen: false,
    newMode: 'default',
    newWorkspaceId: '',
    newPath: '',
    newTitle: '',
    newAnchor: '',
    newManual: false,
    newUnavailable: false,
  }
  const news = []
  const part = ui.target.install({
    t: (key) => key,
    state,
    handlers: {
      onTargetNew: (choice) => news.push(choice),
      onTarget: () => {},
      onTargetRequest: () => {},
    },
    dom: ui.dom,
  })
  part.setTargets([], '', '', workspacesList)
  // The pinned ＋ row opens the workspace sub-panel; its last option is 新建工作区.
  part.panel.children[1].fire('click')
  const newPanel = part.panel.children[3]
  const options = newPanel.children[1]
  options.children[options.children.length - 1].fire('click')
  return { part, state, news, newPanel, fields: newPanel.children[2], error: newPanel.children[3] }
}

test('anchors come from the registered workspaces and their parents', async () => {
  const { fields } = await installTarget([
    { id: 'w1', title: 'app', path: 'D:\\coding\\app' },
    { id: 'w2', title: 'docs', path: 'D:\\docs' },
  ])
  const list = fields.children[1]
  const paths = list.children.map((row) => row.children[1].textContent)
  assert.deepEqual(paths, ['D:\\coding\\app', 'D:\\coding', 'D:\\docs', 'D:\\'])
  assert.equal(list.children[0].getAttribute('aria-pressed'), 'true')
  // The anchor flow is the default; the typed path waits behind the toggle.
  assert.equal(list.hasAttribute('f-hidden'), false)
  assert.equal(fields.children[3].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[7].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[9].hasAttribute('f-hidden'), true)
  assert.equal(fields.children[10].hasAttribute('f-hidden'), true)
})

test('a folder name joins onto the anchor with the separator it already uses', async () => {
  const { news, fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }])
  fields.children[3].value = 'fresh'
  fields.children[6].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'D:\\coding\\app\\fresh', title: '' }])
})

test('an empty name targets the anchor directory itself', async () => {
  const { news, fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }])
  fields.children[6].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'D:\\coding\\app', title: '' }])
})

test('picking another anchor re-targets the join', async () => {
  const { news, fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }])
  fields.children[1].children[1].fire('click')
  assert.equal(fields.children[1].children[1].getAttribute('aria-pressed'), 'true')
  assert.equal(fields.children[1].children[0].getAttribute('aria-pressed'), 'false')
  fields.children[3].value = 'x'
  fields.children[6].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'D:\\coding\\x', title: '' }])
})

test('posix paths anchor and join with slashes, root included', async () => {
  const first = await installTarget([{ id: 'w1', title: 'app', path: '/home/u/app' }])
  assert.deepEqual(
    first.fields.children[1].children.map((row) => row.children[1].textContent),
    ['/home/u/app', '/home/u'],
  )
  first.fields.children[1].children[1].fire('click')
  first.fields.children[3].value = 'x'
  first.fields.children[6].fire('click')
  assert.equal(first.news[0].path, '/home/u/x')

  const root = await installTarget([{ id: 'w1', title: 'root', path: '/' }])
  assert.deepEqual(
    root.fields.children[1].children.map((row) => row.children[1].textContent),
    ['/'],
  )
  root.fields.children[3].value = 'x'
  root.fields.children[6].fire('click')
  assert.equal(root.news[0].path, '/x')
})

test('a folder name that is really a path is refused', async () => {
  const { news, fields, error } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }])
  for (const bad of ['a/b', 'a\\b', '..', '.']) {
    fields.children[3].value = bad
    fields.children[6].fire('click')
    assert.equal(error.textContent, 'workspaceNameInvalid')
  }
  assert.equal(news.length, 0)
})

test('the manual toggle swaps the typed path in, and back out', async () => {
  const { news, fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }])
  fields.children[7].fire('click')
  assert.equal(fields.children[9].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[1].hasAttribute('f-hidden'), true)
  fields.children[9].value = 'E:\\ws'
  fields.children[6].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'E:\\ws', title: '' }])

  fields.children[7].fire('click')
  assert.equal(fields.children[1].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[9].hasAttribute('f-hidden'), true)
})

test('a host without workspaces keeps the typed path as the whole flow', async () => {
  const { news, fields, error } = await installTarget([])
  assert.equal(fields.children[9].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[1].children.length, 0)
  assert.equal(fields.children[7].hasAttribute('f-hidden'), true)
  assert.equal(fields.children[10].hasAttribute('f-hidden'), false)

  fields.children[6].fire('click')
  assert.equal(error.textContent, 'workspacePathRequired')
  assert.equal(news.length, 0)

  fields.children[9].value = 'E:\\first'
  fields.children[6].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'E:\\first', title: '' }])
})

test('windows-style duplicates fold case-insensitively', async () => {
  const { fields } = await installTarget([
    { id: 'w1', title: 'app', path: 'D:\\Coding\\App' },
    { id: 'w2', title: 'app again', path: 'd:\\coding\\app' },
  ])
  assert.deepEqual(
    fields.children[1].children.map((row) => row.children[1].textContent),
    ['D:\\Coding\\App', 'D:\\Coding'],
  )
})

test('reopening the composer resets the anchor choice', async () => {
  const { part, state } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }])
  state.newAnchor = 'D:\\coding'
  state.newManual = true
  part.resetForOpen()
  assert.equal(state.newAnchor, '')
  assert.equal(state.newManual, false)
})
