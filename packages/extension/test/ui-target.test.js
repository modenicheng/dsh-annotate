/**
 * The target picker's new-session arm: one flat panel (M4.7c).
 *
 * D26: no workspace taxonomy, no nested screens. The registered workspaces
 * are their own always-present group — one click targets that exact record
 * the way DSH itself would (`existing` + id), and the group works on every
 * Host because it is client-side catalog data. Below them the directory
 * browser serves the new locations: the host's tree via `/ext/anno/dirs`,
 * starting from the locations view (home, drives) and reaching any absolute
 * path through the breadcrumb. The result line and the confirm button always
 * name the exact path being acted on; a registered directory confirms as
 * that workspace, any other path registers it (`new`), and a host that
 * cannot browse gets the typed absolute path, checked against the same
 * shared protocol rules the host enforces.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

import { validateDirsPath } from '../src/shared/protocol.js'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.nodeType = 1
    this.className = ''
    this.value = ''
    this.type = ''
    this.title = ''
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

  fire(type, extra = {}) {
    for (const entry of this.listeners) {
      if (entry.type === type) entry.listener({ preventDefault() {}, stopPropagation() {}, ...extra })
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
 * The fields area is `[wsLabel, wsList, fsToolbar, fsList, nameLabel,
 * nameInput, resultRow, titleLabel, titleInput, use, manualToggle, pathLabel,
 * pathInput, hint]`; the toolbar is `[fsUp, fsHomeBtn, fsCrumb]` and the
 * result row is `[label, badge, path]`.
 */
const F = {
  WS_LABEL: 0,
  WS_LIST: 1,
  TOOLBAR: 2,
  FS_LIST: 3,
  NAME_LABEL: 4,
  NAME: 5,
  RESULT: 6,
  TITLE_LABEL: 7,
  TITLE: 8,
  USE: 9,
  MANUAL: 10,
  PATH_LABEL: 11,
  PATH: 12,
  HINT: 13,
}

/**
 * Boot `ui/dom.js` + `ui/target.js`, adopt a workspace list, and drive the
 * picker straight into the new-session panel.
 * @param {any[]} workspacesList
 * @param {{ onBrowseDirs?: (path: string) => any }} [extraHandlers]
 */
async function installTarget(workspacesList, extraHandlers = {}) {
  const document = { createElement: (tag) => new FakeNode(tag) }
  const sandbox = { document }
  sandbox.globalThis = sandbox
  // The shared protocol copy the content realm exposes to the picker.
  sandbox.__DSH_PROTOCOL__ = { validateDirsPath }
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
  // The pinned ＋ row opens the panel directly — no mode screen.
  part.panel.children[1].fire('click')
  const newPanel = part.panel.children[3]
  return {
    part,
    state,
    news,
    newPanel,
    fields: newPanel.children[1],
    error: newPanel.children[2],
    crumb: () => newPanel.children[1].children[F.TOOLBAR].children[2],
    up: () => newPanel.children[1].children[F.TOOLBAR].children[0],
    home: () => newPanel.children[1].children[F.TOOLBAR].children[1],
    result: () => newPanel.children[1].children[F.RESULT].children[2],
    badge: () => newPanel.children[1].children[F.RESULT].children[1],
  }
}

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
  'D:\\coding\\app': { path: 'D:\\coding\\app', parent: 'D:\\coding', entries: [] },
  'D:\\coding\\zeta': { path: 'D:\\coding\\zeta', parent: 'D:\\coding', entries: [] },
  'D:\\': { path: 'D:\\', parent: '', entries: [{ name: 'coding', path: 'D:\\coding' }] },
  '': { roots: ['C:\\', 'D:\\'], home: 'C:\\Users\\u' },
  'C:\\Users\\u': { path: 'C:\\Users\\u', parent: 'C:\\Users', entries: [] },
}

const WORKSPACES = [{ id: 'w1', title: 'app', path: 'D:\\coding\\app' }]

/** Walk the tree into D:\coding: locations → D: → coding. */
async function walkToCoding(fields) {
  fields.children[F.FS_LIST].children[2].fire('click')
  await ticks()
  fields.children[F.FS_LIST].children[0].fire('click')
  await ticks()
}

test('the workspace group is always present and one click targets the record', async () => {
  const host = hostOf(TREE)
  const { news, fields } = await installTarget(
    [
      { id: 'w1', title: 'app', path: 'D:\\coding\\app' },
      { id: 'w2', title: 'docs', path: 'D:\\docs' },
    ],
    host,
  )
  await ticks()

  assert.equal(fields.children[F.WS_LABEL].hasAttribute('f-hidden'), false)
  const rows = fields.children[F.WS_LIST].children
  assert.equal(rows.length, 2)
  assert.equal(rows[0].children[0].textContent, 'app')
  assert.equal(rows[0].children[1].textContent, 'D:\\coding\\app')
  assert.equal(rows[0].title, 'D:\\coding\\app')

  rows[1].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'existing', workspaceId: 'w2', path: '', title: '' }])
})

test('the workspace group survives a host that cannot browse at all', async () => {
  // No onBrowseDirs handler at all — the released-Host shape: the group is
  // still there and still clickable, next to the typed-path flow.
  const { news, fields } = await installTarget(WORKSPACES, {})
  await ticks()

  assert.equal(fields.children[F.WS_LIST].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.WS_LIST].children.length, 1)
  assert.equal(fields.children[F.PATH].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.HINT].hasAttribute('f-hidden'), false)

  fields.children[F.WS_LIST].children[0].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'existing', workspaceId: 'w1', path: '', title: '' }])
})

test('the browser opens into the locations view', async () => {
  const host = hostOf(TREE)
  const { fields, result, badge, up, crumb } = await installTarget(WORKSPACES, host)
  await ticks()

  assert.deepEqual(host.seen, [''])
  const rows = fields.children[F.FS_LIST].children.map((row) => row.children[0].textContent)
  assert.deepEqual(rows, ['fsHome', 'C:\\', 'D:\\'])
  assert.equal(up().disabled, true)
  assert.deepEqual(
    crumb().children.map((child) => child.textContent),
    ['fsLocations'],
  )
  // Nothing is chosen yet: the result is an explicit placeholder, not a guess.
  assert.equal(result().className.includes('is-empty'), true)
  assert.equal(result().textContent, 'fsPickLocation')
  assert.equal(badge().hasAttribute('f-hidden'), true)
  assert.equal(fields.children[F.USE].disabled, true)
  assert.equal(fields.children[F.USE].textContent, 'workspaceChooseLocation')
})

test('rows jump into the tree and the breadcrumb climbs back', async () => {
  const host = hostOf(TREE)
  const { fields, home, crumb } = await installTarget(WORKSPACES, host)
  await ticks()

  await walkToCoding(fields)
  assert.deepEqual(host.seen, ['', 'D:\\', 'D:\\coding'])
  assert.equal(fields.children[F.FS_LIST].children[0].textContent, 'app')

  // D: › coding: every ancestor is one click, and the leading chip is the
  // locations view itself.
  assert.deepEqual(
    crumb().children.map((child) => child.textContent),
    ['fsLocations', '›', 'D:', '›', 'coding'],
  )
  crumb().children[2].fire('click')
  await ticks()
  assert.deepEqual(host.seen, ['', 'D:\\', 'D:\\coding', 'D:\\'])
  crumb().children[0].fire('click')
  await ticks()
  assert.deepEqual(host.seen, ['', 'D:\\', 'D:\\coding', 'D:\\', ''])

  // Home is one button away at any depth.
  fields.children[F.FS_LIST].children[2].fire('click')
  await ticks()
  home().fire('click')
  await ticks()
  assert.deepEqual(host.seen.slice(-1), ['C:\\Users\\u'])
})

test('the result line and the confirm button track the folder and name live', async () => {
  const host = hostOf(TREE)
  const { news, fields, result } = await installTarget(WORKSPACES, host)
  await ticks()
  await walkToCoding(fields)

  // Standing in D:\coding with no name: the button adopts that directory.
  assert.equal(result().textContent, 'D:\\coding')
  assert.equal(fields.children[F.USE].disabled, false)
  assert.equal(fields.children[F.USE].textContent, 'workspaceUseAt')

  fields.children[F.NAME].value = 'fresh'
  fields.children[F.NAME].fire('input')
  assert.equal(result().textContent, 'D:\\coding\\fresh')
  assert.equal(fields.children[F.USE].textContent, 'workspaceCreateAt')

  fields.children[F.NAME].value = ''
  fields.children[F.NAME].fire('input')
  assert.equal(result().textContent, 'D:\\coding')
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'D:\\coding', title: '' }])

  // Enter commits from the name field itself.
  fields.children[F.NAME].value = 'fresh'
  fields.children[F.NAME].fire('input')
  fields.children[F.NAME].fire('keydown', { key: 'Enter' })
  assert.deepEqual(plain(news[1]), { mode: 'new', workspaceId: '', path: 'D:\\coding\\fresh', title: '' })
})

test('a registered directory confirms as that workspace, the way DSH does', async () => {
  const host = hostOf(TREE)
  const { news, fields, result, badge } = await installTarget(WORKSPACES, host)
  await ticks()
  await walkToCoding(fields)
  fields.children[F.FS_LIST].children[0].fire('click')
  await ticks()

  // Standing on the registered directory itself.
  assert.equal(badge().hasAttribute('f-hidden'), false)
  assert.equal(badge().textContent, 'workspaceRegistered')
  assert.equal(fields.children[F.USE].textContent, 'workspaceUseAt')
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'existing', workspaceId: 'w1', path: '', title: '' }])

  // A name inside it creates a child instead: a different directory, a
  // different outcome, visible before the click.
  fields.children[F.NAME].value = 'sub'
  fields.children[F.NAME].fire('input')
  assert.equal(badge().hasAttribute('f-hidden'), true)
  assert.equal(fields.children[F.USE].textContent, 'workspaceCreateAt')
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news[1]), { mode: 'new', workspaceId: '', path: 'D:\\coding\\app\\sub', title: '' })
})

test('registration matches windows paths case-insensitively', async () => {
  const host = hostOf(TREE)
  const { news, fields, result } = await installTarget([{ id: 'w1', title: 'app', path: 'd:\\CODING\\APP' }], host)
  await ticks()
  await walkToCoding(fields)
  fields.children[F.FS_LIST].children[0].fire('click')
  await ticks()
  assert.equal(result().textContent, 'D:\\coding\\app')
  fields.children[F.USE].fire('click')
  assert.equal(news[0].mode, 'existing')
  assert.equal(news[0].workspaceId, 'w1')
})

test('a folder name that is really a path is refused live', async () => {
  const host = hostOf(TREE)
  const { news, fields, result } = await installTarget(WORKSPACES, host)
  await ticks()
  await walkToCoding(fields)

  for (const bad of ['a/b', 'a\\b', '..', '.']) {
    fields.children[F.NAME].value = bad
    fields.children[F.NAME].fire('input')
    assert.equal(result().className.includes('is-invalid'), true)
    assert.equal(result().textContent, 'workspaceNameInvalid')
    assert.equal(fields.children[F.USE].disabled, true)
  }
  assert.equal(news.length, 0)
})

test('a probe failure forces the typed path, and relative paths are refused live', async () => {
  const host = hostOf(TREE, new Set(['']))
  const { news, fields, result } = await installTarget(WORKSPACES, host)
  await ticks()

  assert.equal(fields.children[F.PATH].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.HINT].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.TOOLBAR].hasAttribute('f-hidden'), true)
  // The workspace group stays clickable beside the degraded flow.
  assert.equal(fields.children[F.WS_LIST].hasAttribute('f-hidden'), false)
  // Nothing to browse back to: the toggle is absent, not a dead end.
  assert.equal(fields.children[F.MANUAL].hasAttribute('f-hidden'), true)

  fields.children[F.PATH].value = 'rel\\sub'
  fields.children[F.PATH].fire('input')
  assert.equal(result().className.includes('is-invalid'), true)
  assert.equal(result().textContent, 'workspacePathInvalid')
  assert.equal(fields.children[F.USE].disabled, true)

  fields.children[F.PATH].value = 'E:\\ws'
  fields.children[F.PATH].fire('input')
  assert.equal(result().textContent, 'E:\\ws')
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'E:\\ws', title: '' }])
})

test('a later browse failure keeps the level and stays confirmable', async () => {
  const host = hostOf(TREE, new Set(['D:\\coding\\zeta']))
  const { news, fields, result } = await installTarget(WORKSPACES, host)
  await ticks()
  await walkToCoding(fields)
  fields.children[F.FS_LIST].children[1].fire('click')
  await ticks()

  assert.equal(fields.children[F.FS_LIST].children[0].textContent, 'cannot read D:\\coding\\zeta')
  assert.equal(result().textContent, 'D:\\coding')
  fields.children[F.USE].fire('click')
  assert.deepEqual(plain(news), [{ mode: 'new', workspaceId: '', path: 'D:\\coding', title: '' }])
})

test('manual chosen during the probe keeps manual, and the toggle round-trips', async () => {
  let release
  const reply = new Promise((resolve) => {
    release = resolve
  })
  const seen = []
  const { fields } = await installTarget(WORKSPACES, {
    onBrowseDirs: (path) => {
      seen.push(path)
      return reply
    },
  })
  await ticks()
  fields.children[F.MANUAL].fire('click')
  assert.equal(fields.children[F.PATH].hasAttribute('f-hidden'), false)
  release({ ok: true, roots: ['C:\\', 'D:\\'], home: 'C:\\Users\\u', entries: [], truncated: false })
  await ticks()

  // The browse state was adopted, not thrown away: the view stays manual by
  // the user's choice, and the toggle brings the browser back.
  assert.equal(fields.children[F.PATH].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.MANUAL].textContent, 'manualToBrowse')
  fields.children[F.MANUAL].fire('click')
  assert.equal(fields.children[F.FS_LIST].hasAttribute('f-hidden'), false)
  assert.equal(fields.children[F.PATH].hasAttribute('f-hidden'), true)
  assert.deepEqual(
    fields.children[F.FS_LIST].children.map((row) => row.children[0].textContent),
    ['fsHome', 'C:\\', 'D:\\'],
  )
})

test('Escape closes the panel and reopening the composer resets it', async () => {
  const host = hostOf(TREE)
  const { part, state, fields } = await installTarget(WORKSPACES, host)
  await ticks()
  fields.children[F.FS_LIST].children[2].fire('click')
  await ticks()

  part.row.fire('keydown', { key: 'Escape' })
  assert.equal(state.newPanelOpen, false)

  part.resetForOpen()
  assert.equal(state.fsPath, '')
  assert.equal(state.fsReady, false)
  assert.equal(state.newManual, false)
  assert.equal(state.newPath, '')
})
