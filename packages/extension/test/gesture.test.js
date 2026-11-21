/**
 * The gesture layer's contract, pinned without a browser.
 *
 * The overlay's whole job is to stay out of the way: one subject may be drawn at
 * a time, and the browser's own text selection owns Shift-drag end to end. Three
 * shipped bugs came from that rule being broken — a marquee anchored at a press
 * whose release never arrived (drawn from the bottom of the page), a rubber band
 * painted over a native text selection and left behind after the release, and a
 * hover outline competing with the composer's amber one — and a fourth came from
 * the opposite gap: the composer took the selection highlight away and left the
 * user unable to see which words were marked. Each is cheap to reintroduce, so
 * this harness boots the content script in a `node:vm` context with a fake
 * document and drives the window-level listeners the way the browser would.
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

/** A `Selection` carrying only the members `main.js` touches. */
function createSelection() {
  return {
    isCollapsed: true,
    rangeCount: 0,
    removed: 0,
    collapsed: /** @type {{ node: any, offset: number }[]} */ ([]),
    getRangeAt() {
      return null
    },
    removeAllRanges() {
      this.removed += 1
      this.isCollapsed = true
      this.rangeCount = 0
    },
    collapse(node, offset) {
      this.collapsed.push({ node, offset })
      this.isCollapsed = true
      this.rangeCount = 1
    },
    toString() {
      return ''
    },
  }
}

/** The `ns.ui` surface `main.js` calls, recording what reached the overlay. */
function createUi() {
  const calls = { hover: [], marquee: [], cursor: [], shiftDrop: [], markBands: [], locked: [], composer: [] }
  const ui = {
    calls,
    composerOpen: false,
    STRINGS: { en: {} },
    pickLanguage: () => 'en',
    // `main.js` installs the UI through this factory and talks to what it returns.
    create: (handlers) => {
      ui.handlers = handlers
      return ui
    },
    mount() {},
    setHud() {},
    setHidden() {},
    setHover(value) {
      calls.hover.push(value === null ? null : { rect: value.rect, label: value.label })
    },
    setMarquee(value) {
      calls.marquee.push(value === null ? null : { ...value })
    },
    setCursor(value) {
      calls.cursor.push(value === null ? null : { ...value })
    },
    setShiftDrop(value) {
      calls.shiftDrop.push(value === null ? null : { ...value })
    },
    setMarkBands(items) {
      // `Array.from` because `items` arrives from the sandbox realm, and a
      // foreign-realm array never deep-equals one of ours.
      calls.markBands.push(
        Array.from(items || [], (item) => ({
          id: item.id,
          lines: Array.from(item.lines || [], (line) => ({ ...line })),
        })),
      )
    },
    setLocked(rect, label, holder, pageRect, lines) {
      calls.locked.push({ rect, label, holder, pageRect, lines })
    },
    clearLocked() {},
    isComposerOpen() {
      return ui.composerOpen
    },
    openComposer(options) {
      ui.composerOpen = true
      calls.composer.push(options)
    },
    closeComposer() {
      ui.composerOpen = false
    },
    setComposerBusy() {},
    setComposerError() {},
    setTargets() {},
    setNewSessionAvailable() {},
    setBadges() {},
    setBadgePending() {},
    setClearBusy() {},
    setClearProgress() {},
    setPickBanner() {},
    closeBadgeCard() {
      return false
    },
    toast() {},
    focusComposer() {},
    composerText() {
      return ''
    },
  }
  return ui
}

/**
 * Boot `main.js` with the seam it expects from the other content scripts, and
 * hand back the pieces the tests drive: the window listeners, the fake
 * selection, and the overlay recorder.
 */
async function bootContentScript() {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const timers = []
  /** @type {Function[]} */
  const frames = []
  const selection = createSelection()
  const ui = createUi()
  /** Marks applied to the page itself, counted by the hydrator stub. */
  const marks = { clear: 0, apply: 0 }
  /** The `runtime.onMessage` listener the content script registered. */
  let onContentMessage = null
  const caret = { node: { nodeType: 3, nodeValue: 'caret text' }, offset: 4 }
  const seeked = []
  const viewportRect = { x: 100, y: 40, w: 120, h: 20 }
  const target = { nodeType: 1, nodeName: 'P' }

  const document = {
    title: 'harness',
    contentType: 'text/html',
    documentElement: { nodeType: 1, nodeName: 'HTML' },
    body: { nodeType: 1, nodeName: 'BODY' },
    addEventListener() {},
    removeEventListener() {},
  }

  const element = {
    nodeType: 1,
    nodeName: 'P',
    getBoundingClientRect: () => ({ left: 100, top: 40, width: 120, height: 20 }),
  }
  // Two line boxes, the shape a two-line selection reports. A test can blank
  // them to model a range the page re-rendered before it could be measured.
  const lineRects = [
    { x: 100, y: 40, w: 120, h: 20 },
    { x: 100, y: 64, w: 80, h: 20 },
  ]
  let captureLineRects = null
  const capture = (viewport) => ({
    anchor: {
      kind: 'selection',
      quote: { exact: 'selected words' },
      rect: { x: 100, y: 40, w: 120, h: 20 },
    },
    viewportRect: viewport,
    lineRects: (captureLineRects || lineRects).map((line) => ({ ...line })),
    live: null,
  })

  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    location: { protocol: 'http:', href: 'http://127.0.0.1/harness' },
    navigator: { language: 'en-US' },
    document,
    getSelection: () => selection,
    addEventListener(type, listener) {
      const list = listeners.get(type) || []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener() {},
    // Frames are queued, not run inline: `scheduleHover` keeps its id in state
    // and clears it from the callback, exactly as the browser version does.
    requestAnimationFrame: (fn) => {
      frames.push(fn)
      return frames.length
    },
    setTimeout: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimeout() {},
    innerWidth: 1000,
    innerHeight: 700,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    // Stops `installConsoleHook` from reaching for a real page compartment.
    wrappedJSObject: { eval() {} },
    browser: {
      runtime: {
        sendMessage: () => Promise.resolve(undefined),
        onMessage: {
          addListener(listener) {
            onContentMessage = listener
          },
        },
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
      validateAnchor: () => [],
      validateRecord: () => [],
    },
    __DSH_ANNO__: {
      anchor: {
        caretPosition(x, y) {
          seeked.push({ x, y })
          return caret
        },
        meaningfulAt: () => element,
        element: () => ({ anchor: { kind: 'element' }, viewportRect }),
        region: (rect) => ({ anchor: { kind: 'region', pageRect: rect }, viewportRect: rect }),
        selection: (value) => (value && value.isCollapsed ? null : capture(viewportRect)),
        validate: () => [],
        pageContext: () => ({}),
        chipLabel: () => 'p · 120×20',
        liveViewportRect: () => viewportRect,
      },
      text: { isOurs: () => false },
      geom: {
        normalizeRect: (rect) => ({
          x: Math.min(rect.x, rect.x + rect.w),
          y: Math.min(rect.y, rect.y + rect.h),
          w: Math.abs(rect.w),
          h: Math.abs(rect.h),
        }),
        rectOf: (box) => ({ x: box.left, y: box.top, w: box.width, h: box.height }),
        roundRect: (rect) => ({ ...rect }),
        intersection: (left, right) => {
          const x = Math.max(left.x, right.x)
          const y = Math.max(left.y, right.y)
          return {
            x,
            y,
            w: Math.max(0, Math.min(left.x + left.w, right.x + right.w) - x),
            h: Math.max(0, Math.min(left.y + left.h, right.y + right.h) - y),
          }
        },
        pageToViewport: (rect) => ({ ...rect }),
        viewportToPage: (rect) => ({ ...rect }),
        // One line box per marked placement, already in document coordinates.
        markLineRects: () => [{ x: 100, y: 40, w: 120, h: 20 }],
      },
      hydrate: {
        createScheduler: () => ({ request() {} }),
        clearMarks() {
          marks.clear += 1
        },
        applyMarks() {
          marks.apply += 1
        },
        // No `<mark>` painted in this harness, so the handler falls back to the
        // placement range the way it does while annotating.
        markLineBoxes: () => [],
        isFresh: () => true,
        resolveAll: (pending) =>
          pending.map((record) => ({
            record,
            placement: {
              method: 'dom-range',
              pageRect: { x: 100, y: 40, w: 120, h: 20 },
              target: { isConnected: true },
              range: {},
            },
          })),
      },
      ui,
    },
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)
  const code = await readFile(join(extensionRoot, CONTENT_SCRIPT), 'utf8')
  try {
    vm.runInContext(code, context, { filename: CONTENT_SCRIPT })
  } catch (error) {
    throw new Error(`${CONTENT_SCRIPT} threw while loading: ${error.message}`)
  }

  /** Deliver one event to the window listeners, the way a capture listener sees it. */
  function fire(type, fields) {
    const event = {
      type,
      target,
      button: 0,
      buttons: 1,
      shiftKey: false,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {
        this.propagationStopped = true
      },
      ...fields,
    }
    for (const listener of listeners.get(type) || []) listener(event)
    return event
  }

  /** Run the timers the content script queued (the deferred selection read). */
  function flushTimers() {
    while (timers.length > 0) {
      const fn = timers.shift()
      fn()
    }
  }

  /** Run the animation frames the content script queued (the hover pass). */
  function flushFrames() {
    while (frames.length > 0) {
      const fn = frames.shift()
      fn()
    }
  }

  /** Deliver a `anno.records` message, the way the background would. */
  function records(list) {
    if (!onContentMessage) throw new Error('the content script registered no message listener')
    return onContentMessage({ type: 'anno.records', records: list }, {})
  }

  /** Deliver a `anno.event` message (created | updated | deleted). */
  function event(payload) {
    if (!onContentMessage) throw new Error('the content script registered no message listener')
    return onContentMessage({ type: 'anno.event', ...payload }, {})
  }

  /** Make the next capture report these line boxes; `[]` models a lost range. */
  function captureLines(list) {
    captureLineRects = list
  }

  fire('keydown', { key: 'a', code: 'KeyA', altKey: true, shiftKey: true })

  return {
    fire,
    flushTimers,
    flushFrames,
    records,
    event,
    captureLines,
    marks,
    selection,
    ui,
    caret,
    seeked,
    listeners,
    lineRects,
    /** Scroll the page mid-gesture, the way a wheel event during a drag would. */
    scrollTo(x, y) {
      sandbox.scrollX = x
      sandbox.scrollY = y
    },
  }
}

test('a Shift-drag is left to the browser: no rubber band, no default prevention', async () => {
  const harness = await bootContentScript()
  harness.ui.calls.marquee.length = 0
  harness.ui.calls.hover.length = 0

  const down = harness.fire('pointerdown', { clientX: 120, clientY: 50, shiftKey: true })
  assert.equal(down.defaultPrevented, false, 'the browser needs the press to start a selection')
  assert.equal(down.propagationStopped, false, 'the page gets its own pointerdown')
  // The press is also where the selection starts: the caret moves to the
  // pointer, so a Shift-drag extends from there and not from the last mark.
  assert.deepEqual(harness.seeked.at(-1), { x: 120, y: 50 })
  assert.deepEqual(harness.selection.collapsed.at(-1), harness.caret)

  for (let step = 1; step <= 5; step += 1) {
    const move = harness.fire('pointermove', { clientX: 120 + step * 20, clientY: 50, buttons: 1, shiftKey: true })
    assert.equal(move.defaultPrevented, false, 'preventDefault on pointermove cuts the compat mousemove')
    assert.equal(move.propagationStopped, false)
  }
  assert.deepEqual(
    harness.ui.calls.marquee.filter((value) => value !== null),
    [],
    'a text selection paints no rubber band',
  )
  assert.equal(
    harness.ui.calls.hover.filter((value) => value !== null).length,
    0,
    'and no hover box either: the selection is the feedback',
  )

  // The browser extends the selection during the drag; stand in for it, then
  // release. The release reads the range and opens the composer for it.
  harness.selection.isCollapsed = false
  harness.selection.rangeCount = 1
  harness.fire('pointerup', { clientX: 220, clientY: 50, buttons: 0, shiftKey: true })
  harness.flushTimers()
  assert.equal(harness.ui.calls.marquee.at(-1), null, 'the release clears the band it never drew')
  assert.equal(harness.ui.composerOpen, true, 'the captured selection went to the composer')
  // The words stay identifiable while the composer holds the selection: one
  // band per line box, in document coordinates so scrolling keeps them on text.
  const locked = harness.ui.calls.locked.at(-1)
  assert.equal(locked.holder, 'composer')
  assert.deepEqual(locked.lines, harness.lineRects, 'every line of the marked text is banded')
})

test('a mid-drag scroll shifts the marquee start with the content', async () => {
  const harness = await bootContentScript()
  harness.ui.calls.marquee.length = 0

  // A region drag starts at a page point captured in the scroll-0 viewport.
  harness.fire('pointerdown', { clientX: 100, clientY: 100 })
  harness.fire('pointermove', { clientX: 140, clientY: 140, buttons: 1 })
  assert.deepEqual(
    harness.ui.calls.marquee.at(-1),
    { x: 100, y: 100, w: 40, h: 40 },
    'with no scroll the marquee spans press to pointer',
  )

  // The page scrolls 300px down mid-drag: the pressed content now sits 300px
  // higher in the viewport, and the marquee must follow it, not stay pinned to
  // the stale viewport coordinate of the press.
  harness.scrollTo(0, 300)
  harness.fire('pointermove', { clientX: 140, clientY: 140, buttons: 1 })
  assert.deepEqual(
    harness.ui.calls.marquee.at(-1),
    { x: 100, y: -200, w: 40, h: 340 },
    'the start shifts up with the content after the scroll',
  )

  // The release captures the same compensated rectangle.
  harness.fire('pointerup', { clientX: 160, clientY: 160, buttons: 0 })
  assert.deepEqual(
    harness.ui.calls.composer.at(-1).rect,
    { x: 100, y: -200, w: 60, h: 360 },
    'the region anchor is captured from the compensated rectangle',
  )
})

test('a marked element is outlined as one box, with no bands', async () => {
  const harness = await bootContentScript()
  harness.fire('pointerdown', { clientX: 120, clientY: 50 })
  harness.fire('pointerup', { clientX: 120, clientY: 50, buttons: 0 })
  harness.flushTimers()
  const locked = harness.ui.calls.locked.at(-1)
  assert.equal(locked.holder, 'composer')
  assert.equal(locked.lines, null, 'an element has no text lines to band')
})

test('a text mark is never outlined, even when its range could not be measured', async () => {
  const harness = await bootContentScript()
  // The page re-rendered between the drag and the read: no line boxes.
  harness.captureLines([])
  harness.fire('pointerdown', { clientX: 120, clientY: 50, shiftKey: true })
  harness.selection.isCollapsed = false
  harness.selection.rangeCount = 1
  harness.fire('pointerup', { clientX: 220, clientY: 50, buttons: 0, shiftKey: true })
  harness.flushTimers()

  const locked = harness.ui.calls.locked.at(-1)
  assert.equal(locked.holder, 'composer')
  assert.equal(locked.lines.length, 1, 'the mark falls back to one band, never to a box')
  assert.equal(locked.lines[0].y, 40, 'covering the anchor rect it did capture')
})

test('a press whose release never arrives cannot keep drawing', async () => {
  const harness = await bootContentScript()
  harness.ui.calls.marquee.length = 0

  // A plain press in auto mode arms a region drag...
  harness.fire('pointerdown', { clientX: 100, clientY: 1200 })
  // ...and the button is released outside the window: no pointerup reaches us.
  const stray = harness.fire('pointermove', { clientX: 140, clientY: 60, buttons: 0 })
  assert.equal(harness.ui.calls.marquee.at(-1), null, 'the first buttonless move drops the stale press')
  assert.equal(stray.defaultPrevented, false)

  const moves = harness.ui.calls.marquee.filter((value) => value !== null)
  assert.deepEqual(moves, [], 'no marquee may be anchored at the stale press')
  harness.flushFrames()
  assert.equal(harness.ui.calls.hover.filter((value) => value !== null).length, 1, 'the pointer only hovers')
})

test('an open composer keeps the pointer from painting a second box', async () => {
  const harness = await bootContentScript()
  // A click marks an element and opens the composer, which locks its outline.
  harness.fire('pointerdown', { clientX: 120, clientY: 50 })
  harness.fire('pointerup', { clientX: 120, clientY: 50, buttons: 0 })
  harness.flushTimers()
  assert.equal(harness.ui.composerOpen, true)
  assert.equal(harness.ui.calls.locked.length, 1, 'the amber outline is the one box')

  harness.ui.calls.hover.length = 0
  harness.ui.calls.cursor.length = 0
  harness.ui.calls.shiftDrop.length = 0
  harness.fire('pointermove', { clientX: 300, clientY: 120, buttons: 0, shiftKey: true })
  harness.flushFrames()

  assert.deepEqual(harness.ui.calls.hover, [null], 'the element under the pointer is not outlined')
  assert.deepEqual(harness.ui.calls.cursor, [null], 'and the cursor guide stays away too')
  assert.deepEqual(harness.ui.calls.shiftDrop.at(-1), null, 'Shift in the composer is a capital letter')
})

test('holding Shift swaps the element outline for the text-selection drop', async () => {
  const harness = await bootContentScript()
  harness.ui.calls.hover.length = 0
  harness.ui.calls.shiftDrop.length = 0

  // Hovering in auto mode outlines the element under the pointer...
  harness.fire('pointermove', { clientX: 300, clientY: 120, buttons: 0 })
  harness.flushFrames()
  assert.ok(harness.ui.calls.hover.at(-1), 'the element under the pointer is outlined')

  // ...until Shift says the next drag selects text instead.
  harness.fire('keydown', { key: 'Shift', shiftKey: true })
  assert.equal(harness.ui.calls.hover.at(-1), null, 'the box goes away when Shift is pressed')
  assert.deepEqual(harness.ui.calls.shiftDrop.at(-1), { x: 300, y: 120 }, 'the drop hangs off the pointer')

  // It follows the pointer, and no element is outlined on the way.
  harness.fire('pointermove', { clientX: 340, clientY: 160, buttons: 0, shiftKey: true })
  assert.deepEqual(harness.ui.calls.shiftDrop.at(-1), { x: 340, y: 160 }, 'the drop follows the pointer')
  assert.equal(harness.ui.calls.hover.at(-1), null, 'still no outline while Shift is held')

  // Releasing Shift brings the outline back at the same point.
  harness.fire('keyup', { key: 'Shift' })
  assert.equal(harness.ui.calls.shiftDrop.at(-1), null, 'the drop leaves with the key')
  harness.flushFrames()
  assert.ok(harness.ui.calls.hover.at(-1), 'and the element outline returns')
})

test('the drop carries a text-selection drag from press to release', async () => {
  const harness = await bootContentScript()
  harness.ui.calls.shiftDrop.length = 0

  harness.fire('keydown', { key: 'Shift', shiftKey: true })
  harness.fire('pointerdown', { clientX: 120, clientY: 50, shiftKey: true })
  harness.fire('pointermove', { clientX: 200, clientY: 50, buttons: 1, shiftKey: true })
  assert.deepEqual(harness.ui.calls.shiftDrop.at(-1), { x: 200, y: 50 }, 'the drop tracks the drag')
  // The press itself stays native: no box, and the drop is the only guide.
  assert.deepEqual(
    harness.ui.calls.marquee.filter((value) => value !== null),
    [],
    'a text drag paints no marquee',
  )

  harness.selection.isCollapsed = false
  harness.selection.rangeCount = 1
  harness.fire('pointerup', { clientX: 220, clientY: 50, buttons: 0, shiftKey: true })
  harness.flushTimers()
  assert.equal(harness.ui.composerOpen, true)
  assert.equal(
    harness.ui.calls.shiftDrop.at(-1),
    null,
    'the captured mark takes the drop with it: the bands say what is selected now',
  )
})

test('a marked text is visible in both states: page elements at rest, bands while annotating', async () => {
  const harness = await bootContentScript()
  // The harness boots into annotation mode; a rest state is what this test needs
  // first, and the marks counters restart with it.
  harness.fire('keydown', { key: 'Escape' })
  harness.marks.apply = 0
  harness.marks.clear = 0
  const record = {
    id: 'an-20261120-ab12cd',
    createdAt: '2026-11-20T00:00:00.000Z',
    state: 'open',
    comment: '看看这条',
    anchor: { kind: 'selection', quote: { exact: 'marked words' }, rect: { x: 100, y: 40, w: 120, h: 20 } },
  }

  // At rest the mark is a `<mark>` in the text itself, at its quiet strength.
  harness.records([record])
  assert.deepEqual(harness.ui.calls.markBands.at(-1), [], 'no overlay bands while the page is at rest')
  assert.equal(harness.marks.apply, 1, 'the rest state paints the mark into the page')

  // Annotating: the page may not carry our nodes, so the overlay draws it.
  harness.fire('keydown', { key: 'a', code: 'KeyA', altKey: true, shiftKey: true })
  assert.deepEqual(
    harness.ui.calls.markBands.at(-1),
    [{ id: record.id, lines: [{ x: 100, y: 40, w: 120, h: 20 }] }],
    'annotation mode paints the existing mark in the overlay, line by line',
  )
  assert.equal(harness.marks.apply, 1, 'and the page mark is gone: nothing wrapped in the text')

  // Back to rest: the overlay lets go and the page mark returns.
  harness.fire('keydown', { key: 'Escape' })
  assert.deepEqual(harness.ui.calls.markBands.at(-1), [], 'the overlay bands leave with the mode')
  assert.equal(harness.marks.apply, 2, 'and the page mark comes back')
})

test('a hovered text mark asks for its line boxes, so the card bands instead of boxing', async () => {
  const harness = await bootContentScript()
  const text = {
    id: 'an-20261120-aa11bb',
    state: 'open',
    comment: '看看这条',
    anchor: { kind: 'selection', quote: { exact: 'marked words' }, rect: { x: 100, y: 40, w: 120, h: 20 } },
  }
  const element = {
    id: 'an-20261120-cc22dd',
    state: 'open',
    comment: '这个按钮',
    anchor: { kind: 'element', selector: '#go', rect: { x: 10, y: 10, w: 40, h: 20 } },
  }
  harness.records([text, element])

  // The badge layer asks for line boxes only for the mark it is about to draw.
  assert.deepEqual(
    harness.ui.handlers.onBadgeLines({ id: text.id, kind: 'selection' }),
    [{ x: 100, y: 40, w: 120, h: 20 }],
    'a text mark reports its lines, in document coordinates',
  )
  assert.equal(harness.ui.handlers.onBadgeLines({ id: element.id, kind: 'element' }), null, 'an element has no lines')
  assert.equal(
    harness.ui.handlers.onBadgeLines({ id: 'an-gone', kind: 'selection' }),
    null,
    'an unresolved mark has none either',
  )
})

test('a stale refresh keeps the marks it painted instead of re-wrapping dead ranges', async () => {
  const harness = await bootContentScript()
  harness.fire('keydown', { key: 'Escape' }) // rest state: the page carries the marks
  const record = {
    id: 'an-20261120-ee33ff',
    state: 'open',
    comment: '留着',
    anchor: { kind: 'selection', quote: { exact: 'marked words' }, rect: { x: 100, y: 40, w: 120, h: 20 } },
  }
  harness.records([record])
  const painted = { apply: harness.marks.apply, clear: harness.marks.clear }
  assert.equal(painted.apply, 1, 'the record is painted once')

  // A page mutation re-anchors on the next tick. Wrapping the text destroyed the
  // placement's range, so repainting from it would paint nothing — the refresh
  // has to leave the existing marks alone.
  harness.event({ event: 'updated', record: { ...record, comment: '改过' } })
  assert.equal(harness.marks.apply, painted.apply, 'a record update does not re-wrap the text')
  assert.equal(harness.marks.clear, painted.clear, 'and nothing is unwrapped')

  harness.event({ event: 'updated', record })
  assert.equal(harness.marks.apply, painted.apply, 'repeat refreshes keep the mark on the page')

  // A deleted record is a real change: the remaining marks are rebuilt.
  harness.event({ event: 'deleted', record })
  assert.equal(harness.marks.apply, painted.apply + 1, 'the record set changed, so the marks are rewritten')
})

test('ending a mark drops the selection it left on the page', async () => {
  const harness = await bootContentScript()
  harness.fire('pointerdown', { clientX: 120, clientY: 50 })
  harness.fire('pointerup', { clientX: 120, clientY: 50, buttons: 0 })
  harness.flushTimers()
  assert.equal(harness.ui.composerOpen, true)

  // What a real capture leaves behind: a live selection on the page.
  harness.selection.isCollapsed = false
  harness.selection.rangeCount = 1
  harness.ui.handlers.onCancel('escape')
  assert.equal(harness.selection.removed, 1, 'the cancelled mark takes its selection with it')
  assert.equal(harness.ui.composerOpen, false)

  // Esc from the page leaves annotation mode, and the page as the user found it.
  harness.selection.isCollapsed = false
  harness.selection.rangeCount = 1
  harness.fire('keydown', { key: 'Escape' })
  assert.equal(harness.selection.removed, 2, 'leaving the mode drops any leftover selection')
})
