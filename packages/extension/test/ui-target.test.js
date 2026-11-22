/**
 * The target picker's new-workspace arm (M4.7a + M4.7b).
 *
 * D26: the path is chosen, not typed — anchor rows come from the registered
 * workspaces' own paths and parents, the user writes at most one folder
 * name, and the manual absolute path survives as the demoted fallback for a
 * host that reports no workspace at all. When the host serves
 * `/ext/anno/dirs`, the same panel browses its real directory tree instead,
 * and any browse failure falls back to the anchors without losing the panel.
 * Everything below runs against the same `anno.session.create` body M4.6
 * already sent: no new wire surface on the create path.
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

/** Let the picker's promise chains settle; every link is a microtask. */
async function ticks(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

/**
 * The fields area is `[fsHead, fsList, anchorLabel, anchorList, nameLabel,
 * nameInput, titleLabel, titleInput, use, manualToggle, pathLabel, pathInput,
 * noAnchorsHint]`.
 */
const F = {
  FS_HEAD: 0,
  FS_LIST: 1,
  ANCHOR_LABEL: 2,
  ANCHORS: 3,
  NAME_LABEL: 4,
  NAME: 5,
  TITLE_LABEL: 6,
  TITLE: 7,
  USE: 8,
  MANUAL: 9,
  PATH_LABEL: 10,
  PATH: 11,
  HINT: 12,
}

/**
 * Boot `ui/dom.js` + `ui/target.js`, adopt a workspace list, and drive the
 * picker straight into the 新建工作区 mode.
 * @param {any[]} workspacesList
 * @param {{ onBrowseDirs?: (path: string) => any }} [extraHandlers]
 */
async function installTarget(workspacesList, extraHandlers = {}) {
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
    fsReady: false,
    fsUnsupported: false,
    fsBusy: false,
    fsPath: '',
    fsParent: '',
    fsEntries: [],
    fsRoots: null,
    fsHome: '',
    fsTruncated: false,
    fsError: '',
  }
  const news = []
  const part = ui.target.install({
    t: (key) => key,
    state,
    handlers: {
      onTargetNew: (choice) => news.push(choice),
      onTarget: () => {},
      onTargetRequest: () => {},
      ...extraHandlers,
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
  const list = fields.children[F.ANCHORS]
  const paths = list.children.map((row) => row.children[1].textContent)
  assert.deepEqual(paths, ['D:\\coding\\app', 'D:\\coding', 'D:\\docs', 'D:\\'])
  assert.equal(list.children[0].getAttribute('aria-pressed'), 'true')
  // The anchor flow is the default; the typed path waits behind the toggle.
  assert.equal(list.hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.NAME].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.MANUAL].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.PATH].hasAttribute('f-hidden'), true)
  assert.equal(fields.children[F.HINT].hasAttribute('f-hidden'), true)
})

test('a folder name joins onto the anchor with the separator it already uses', async () => {
  const { news, fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }])
  fields.children[F.NAME].value = 'fresh'
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'D:\\coding\\app\\fresh', title: '' }])
})

test('an empty name targets the anchor directory itself', async () => {
  const { news, fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }])
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'D:\\coding\\app', title: '' }])
})

test('picking another anchor re-targets the join', async () => {
  const { news, fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }])
  fields.children[F.ANCHORS].children[1].fire('click')
  assert.equal(fields.children[F.ANCHORS].children[1].getAttribute('aria-pressed'), 'true')
  assert.equal(fields.children[F.ANCHORS].children[0].getAttribute('aria-pressed'), 'false')
  fields.children[F.NAME].value = 'x'
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'D:\\coding\\x', title: '' }])
})

test('posix paths anchor and join with slashes, root included', async () => {
  const first = await installTarget([{ id: 'w1', title: 'app', path: '/home/u/app' }])
  assert.deepEqual(
    first.fields.children[F.ANCHORS].children.map((row) => row.children[1].textContent),
    ['/home/u/app', '/home/u'],
  )
  first.fields.children[F.ANCHORS].children[1].fire('click')
  first.fields.children[F.NAME].value = 'x'
  first.fields.children[F.USE].fire('click')
  assert.equal(first.news[0].path, '/home/u/x')

  const root = await installTarget([{ id: 'w1', title: 'root', path: '/' }])
  assert.deepEqual(
    root.fields.children[F.ANCHORS].children.map((row) => row.children[1].textContent),
    ['/'],
  )
  root.fields.children[F.NAME].value = 'x'
  root.fields.children[F.USE].fire('click')
  assert.equal(root.news[0].path, '/x')
})

test('a folder name that is really a path is refused', async () => {
  const { news, fields, error } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }])
  for (const bad of ['a/b', 'a\\b', '..', '.']) {
    fields.children[F.NAME].value = bad
    fields.children[F.USE].fire('click')
    assert.equal(error.textContent, 'workspaceNameInvalid')
  }
  assert.equal(news.length, 0)
})

test('the manual toggle swaps the typed path in, and back out', async () => {
  const { news, fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }])
  fields.children[F.MANUAL].fire('click')
  assert.equal(fields.children[F.PATH].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.ANCHORS].hasAttribute('f-hidden'), true)
  fields.children[F.PATH].value = 'E:\\ws'
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'E:\\ws', title: '' }])

  fields.children[F.MANUAL].fire('click')
  assert.equal(fields.children[F.ANCHORS].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.PATH].hasAttribute('f-hidden'), true)
})

test('a host without workspaces keeps the typed path as the whole flow', async () => {
  const { news, fields, error } = await installTarget([])
  assert.equal(fields.children[F.PATH].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.ANCHORS].children.length, 0)
  assert.equal(fields.children[F.MANUAL].hasAttribute('f-hidden'), true)
  assert.equal(fields.children[F.HINT].hasAttribute('f-hidden'), false)

  fields.children[F.USE].fire('click')
  assert.equal(error.textContent, 'workspacePathRequired')
  assert.equal(news.length, 0)

  fields.children[F.PATH].value = 'E:\\first'
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'E:\\first', title: '' }])
})

test('windows-style duplicates fold case-insensitively', async () => {
  const { fields } = await installTarget([
    { id: 'w1', title: 'app', path: 'D:\\Coding\\App' },
    { id: 'w2', title: 'app again', path: 'd:\\coding\\app' },
  ])
  assert.deepEqual(
    fields.children[F.ANCHORS].children.map((row) => row.children[1].textContent),
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

// ── host-served browsing (M4.7b) ─────────────────────────────────────────────

/** A host that answers each path from a fixed table, recording every call. */
function hostOf(table, failing = new Set()) {
  const seen = []
  const onBrowseDirs = (path) => {
    seen.push(path)
    if (failing.has(path)) return { ok: false, error: `cannot read ${path}` }
    const answer = table[path]
    if (answer === undefined) throw new Error(`unexpected path ${path}`)
    return { ok: true, entries: [], truncated: false, ...answer }
  }
  return { onBrowseDirs, seen }
}

const TREE = {
  'D:\\coding': {
    path: 'D:\\coding',
    parent: 'D:\\',
    entries: [
      { name: 'app', path: 'D:\\coding\\app' },
      { name: 'zeta', path: 'D:\\coding\\zeta' },
    ],
  },
  'D:\\coding\\zeta': { path: 'D:\\coding\\zeta', parent: 'D:\\coding', entries: [] },
  'D:\\': { path: 'D:\\', parent: '', entries: [{ name: 'coding', path: 'D:\\coding' }] },
  '': { roots: ['C:\\', 'D:\\'], home: 'C:\\Users\\u' },
  'C:\\Users\\u': { path: 'C:\\Users\\u', parent: 'C:\\Users', entries: [] },
}

test('the picker upgrades to host browsing and lands at the newest workspace parent', async () => {
  const host = hostOf(TREE)
  const { news, fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }], host)
  await ticks()

  assert.deepEqual(host.seen, ['D:\\coding'])
  assert.equal(fields.children[F.FS_LIST].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.ANCHORS].hasAttribute('f-hidden'), true)
  assert.equal(fields.children[F.FS_HEAD].children[1].textContent, 'D:\\coding')
  const rows = fields.children[F.FS_LIST].children.map((row) => row.children[0].textContent)
  assert.deepEqual(rows, ['app', 'zeta'])

  fields.children[F.NAME].value = 'fresh'
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'D:\\coding\\fresh', title: '' }])
})

test('rows descend and Up climbs, through the roots view', async () => {
  const host = hostOf(TREE)
  const { fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }], host)
  await ticks()

  fields.children[F.FS_LIST].children[1].fire('click')
  await ticks()
  assert.deepEqual(host.seen, ['D:\\coding', 'D:\\coding\\zeta'])
  assert.equal(fields.children[F.FS_LIST].children[0].textContent, 'fsEmpty')

  fields.children[F.FS_HEAD].children[0].fire('click')
  await ticks()
  assert.deepEqual(host.seen, ['D:\\coding', 'D:\\coding\\zeta', 'D:\\coding'])

  // Climbing from a drive root lands in the roots view, where Up rests and
  // the naming row has nothing to join onto yet.
  fields.children[F.FS_HEAD].children[0].fire('click')
  await ticks()
  assert.equal(fields.children[F.FS_HEAD].children[1].textContent, 'D:\\')
  fields.children[F.FS_HEAD].children[0].fire('click')
  await ticks()
  assert.deepEqual(host.seen, ['D:\\coding', 'D:\\coding\\zeta', 'D:\\coding', 'D:\\', ''])
  assert.equal(fields.children[F.FS_HEAD].children[0].disabled, true)
  assert.equal(fields.children[F.NAME].hasAttribute('f-hidden'), true)
  assert.equal(fields.children[F.USE].hasAttribute('f-hidden'), true)
  const roots = fields.children[F.FS_LIST].children.map((row) => row.children[0].textContent)
  assert.deepEqual(roots, ['fsHome', 'C:\\', 'D:\\'])

  fields.children[F.FS_LIST].children[0].fire('click')
  await ticks()
  assert.equal(fields.children[F.FS_HEAD].children[1].textContent, 'C:\\Users\\u')
})

test('a fresh install lands in the host home through the roots view', async () => {
  const host = hostOf(TREE)
  await installTarget([], host)
  await ticks()
  assert.deepEqual(host.seen, ['', 'C:\\Users\\u'])
})

test('a browse failure before the first success falls back to the anchors', async () => {
  const host = hostOf(TREE, new Set(['D:\\coding']))
  const { news, fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }], host)
  await ticks()

  assert.equal(fields.children[F.ANCHORS].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.FS_LIST].hasAttribute('f-hidden'), true)
  fields.children[F.NAME].value = 'fresh'
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'D:\\coding\\app\\fresh', title: '' }])
})

test('a later browse failure keeps the level and shows the message inline', async () => {
  const host = hostOf(TREE, new Set(['D:\\coding\\zeta']))
  const { fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }], host)
  await ticks()
  fields.children[F.FS_LIST].children[1].fire('click')
  await ticks()

  assert.equal(fields.children[F.FS_LIST].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.FS_LIST].children[0].textContent, 'cannot read D:\\coding\\zeta')
  assert.equal(fields.children[F.FS_HEAD].children[1].textContent, 'D:\\coding')
})

test('a user who chose the manual path during the probe keeps it', async () => {
  let release
  const reply = new Promise((resolve) => {
    release = resolve
  })
  const seen = []
  const { fields } = await installTarget([{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }], {
    onBrowseDirs: (path) => {
      seen.push(path)
      return reply
    },
  })
  await ticks()
  fields.children[F.MANUAL].fire('click')
  release({ ok: true, path: 'D:\\coding', parent: 'D:\\', entries: [], truncated: false, roots: null })
  await ticks()

  assert.equal(fields.children[F.PATH].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.FS_LIST].hasAttribute('f-hidden'), true)
  assert.equal(fields.children[F.ANCHORS].hasAttribute('f-hidden'), true)
})
