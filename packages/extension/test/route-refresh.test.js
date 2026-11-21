/**
 * SPA route changes through the content script's refresh path.
 *
 * `main.js` loads annotations once per document load, which is once per
 * *traditional* load: an SPA router swaps the view through
 * `history.pushState` with no load event at all, and the previous route's
 * marks stay pinned into DOM that may already be gone. This harness boots the
 * content script in a `node:vm` context (the same seam `gesture.test.js`
 * uses), drives `history.pushState` and `popstate` the way a router would, and
 * checks that the refresh follows the store's document identity — query and
 * hash alone never separate annotations, so they must not trigger a refresh.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)
const CONTENT_SCRIPT = 'src/content/main.js'

/** The `sameDocument` predicate, copied from the protocol single source. */
function sameDocument(record, url) {
  if (!record || typeof record.url !== 'string' || typeof url !== 'string') return false
  if (record.url === url) return true
  try {
    const left = new URL(record.url)
    const right = new URL(url)
    return left.origin === right.origin && left.pathname === right.pathname
  } catch {
    return false
  }
}

/**
 * Boot `main.js` against a fake SPA-ish page. Timers are queued, never run
 * inline, so a test controls when the debounced refresh fires.
 */
async function bootContentScript() {
  const listeners = new Map()
  const timers = new Map()
  let timerId = 0
  /** Messages the content script sent to the background, in order. */
  const sent = []
  /** Marks cleared off the page, counted by the hydrator stub. */
  const marks = { clear: 0, apply: 0 }
  const location = { protocol: 'http:', href: 'http://127.0.0.1:5500/app/one' }
  const history = {
    pushState(_state, _title, url) {
      location.href = new URL(String(url), location.href).href
    },
    replaceState(_state, _title, url) {
      location.href = new URL(String(url), location.href).href
    },
  }

  const document = {
    title: 'spa harness',
    contentType: 'text/html',
    documentElement: { nodeType: 1, nodeName: 'HTML' },
    body: { nodeType: 1, nodeName: 'BODY' },
    addEventListener() {},
    removeEventListener() {},
  }

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    location,
    history,
    navigator: { language: 'en-US' },
    document,
    getSelection: () => null,
    addEventListener(type, listener) {
      const list = listeners.get(type) || []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener() {},
    requestAnimationFrame: (fn) => {
      fn()
      return 1
    },
    setTimeout: (fn) => {
      timerId += 1
      timers.set(timerId, fn)
      return timerId
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    innerWidth: 1000,
    innerHeight: 700,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    wrappedJSObject: { eval() {} },
    browser: {
      runtime: {
        sendMessage: (message) => {
          sent.push({ ...message })
          // Boot's ready handshake gets no records (the background may not
          // answer), which is the path that exercises `queryRecords`.
          if (message.type === 'anno.content.ready') return Promise.resolve(undefined)
          return Promise.resolve({ ok: true, records: [] })
        },
        onMessage: { addListener() {} },
      },
      storage: {
        local: { get: () => Promise.resolve({}), set: () => Promise.resolve(undefined) },
        onChanged: { addListener() {} },
      },
    },
    __DSH_PROTOCOL__: {
      MAX_CLICK_MOVEMENT_PX: 6,
      LIMITS: { commentChars: 4000 },
      INTENTS: [],
      truncate: (value, max) => String(value).slice(0, max),
      sameDocument,
      validateAnchor: () => [],
      validateRecord: () => [],
    },
    __DSH_ANNO__: {
      anchor: {},
      text: { isOurs: () => false },
      geom: {
        normalizeRect: (rect) => ({ ...rect }),
        rectOf: (box) => ({ x: box.left, y: box.top, w: box.width, h: box.height }),
        roundRect: (rect) => ({ ...rect }),
        intersection: (left, _right) => ({ ...left }),
        pageToViewport: (rect) => ({ ...rect }),
        viewportToPage: (rect) => ({ ...rect }),
        markLineRects: () => [],
      },
      hydrate: {
        // The same trailing-debounce shape the real scheduler uses: one run
        // per window, requests while queued coalesce.
        createScheduler(run) {
          let timer = 0
          return {
            request() {
              if (timer) return
              const id = sandbox.setTimeout(run)
              timer = id
            },
          }
        },
        clearMarks() {
          marks.clear += 1
        },
        applyMarks() {
          marks.apply += 1
        },
        markLineBoxes: () => [],
        isFresh: () => true,
        resolveAll: (pending) =>
          pending.map((record) => ({
            record,
            placement: { method: 'dom-range', pageRect: { x: 0, y: 0, w: 10, h: 10 }, target: {}, range: {} },
          })),
      },
      ui: {
        STRINGS: { en: {} },
        pickLanguage: () => 'en',
        create: () => ui,
        mount() {},
        setHud() {},
        setHidden() {},
        setHover() {},
        setMarquee() {},
        setCursor() {},
        setShiftDrop() {},
        setMarkBands() {},
        setLocked() {},
        clearLocked() {},
        isComposerOpen: () => false,
        openComposer() {},
        closeComposer() {},
        setComposerBusy() {},
        setComposerError() {},
        setTargets() {},
        setNewSessionAvailable() {},
        setBadges() {},
        setBadgePending() {},
        setClearBusy() {},
        setClearProgress() {},
        setPickBanner() {},
        closeBadgeCard: () => false,
        toast() {},
        focusComposer() {},
        composerText: () => '',
      },
    },
  }
  const ui = sandbox.__DSH_ANNO__.ui
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  const code = await readFile(join(extensionRoot, CONTENT_SCRIPT), 'utf8')
  vm.runInContext(code, context, { filename: CONTENT_SCRIPT })
  // Boot's ready round-trip is a promise chain; let it settle before the
  // test counts queries.
  await new Promise((resolve) => setImmediate(resolve))

  /** Run every queued timer once (the debounced refresh among them). */
  function flushTimers() {
    const pending = [...timers.values()]
    timers.clear()
    for (const fn of pending) fn()
  }

  /** The messages of one type the script sent, by url where present. */
  const queries = () => sent.filter((message) => message.type === 'anno.query').map((message) => message.url)

  function fire(type) {
    for (const listener of listeners.get(type) || []) listener({ type })
  }

  return { sandbox, sent, marks, location, history, flushTimers, queries, fire }
}

test('documentChanged follows sameDocument identity', async () => {
  const { sandbox } = await bootContentScript()
  const documentChanged = sandbox.__DSH_ANNO__.documentChanged
  const base = 'https://a.com/docs/one?tab=meta#section'
  assert.equal(typeof documentChanged, 'function')
  assert.equal(documentChanged(`${base}`, 'https://a.com/docs/one'), false, 'query and hash are ignored')
  assert.equal(documentChanged('https://a.com/docs/one', 'https://a.com/docs/one#top'), false, 'hash alone')
  assert.equal(documentChanged('https://a.com/docs/one', 'https://a.com/docs/two'), true, 'path change')
  assert.equal(documentChanged('https://a.com/one', 'https://b.com/one'), true, 'origin change')
  assert.equal(documentChanged('', 'https://a.com/one'), true, 'empty previous url')
  assert.equal(documentChanged('', ''), false)
})

test('pushState to a new path clears the old marks and re-queries', async () => {
  const harness = await bootContentScript()
  const before = harness.queries()
  assert.equal(before.length, 1, 'boot queries once for the initial url')

  harness.history.pushState({}, '', '/app/two')
  harness.flushTimers()

  const after = harness.queries()
  assert.equal(after.length, 2, 'one refresh query after the route change')
  assert.equal(after[1], 'http://127.0.0.1:5500/app/two')
  assert.ok(harness.marks.clear >= 1, 'the previous route’s marks are cleared')
})

test('query-only and hash-only pushState never refresh', async () => {
  const harness = await bootContentScript()
  const before = harness.queries().length

  harness.history.pushState({}, '', '/app/one?tab=2')
  harness.flushTimers()
  harness.history.pushState({}, '', '/app/one?tab=2#top')
  harness.flushTimers()

  assert.equal(harness.queries().length, before, 'same document, no re-query')
})

test('a replaceState burst coalesces into one refresh', async () => {
  const harness = await bootContentScript()
  const before = harness.queries().length

  harness.history.replaceState({}, '', '/app/three')
  harness.history.pushState({}, '', '/app/three/final')
  // No flush between the two: the debounce window must coalesce them.
  harness.flushTimers()

  assert.equal(harness.queries().length, before + 1, 'one query after the burst')
  assert.equal(harness.queries().at(-1), 'http://127.0.0.1:5500/app/three/final')
})

test('popstate refreshes when the document moved', async () => {
  const harness = await bootContentScript()
  const before = harness.queries().length

  harness.location.href = 'http://127.0.0.1:5500/app/back-here'
  harness.fire('popstate')
  harness.flushTimers()

  assert.equal(harness.queries().length, before + 1)
  assert.equal(harness.queries().at(-1), 'http://127.0.0.1:5500/app/back-here')
})
