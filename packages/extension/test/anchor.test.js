/**
 * The anchor builders' contract, pinned without a browser.
 *
 * `anchor.js` turns what the user pointed at into the wire shapes the
 * validator checks: a selection becomes quote + domRange + a document-coords
 * rect, an element becomes a selector ladder plus a fingerprint, a region
 * becomes the box in both coordinate systems. These tests boot the real script
 * (after the real generated protocol) in a `node:vm` context over a minimal
 * fake DOM — the same approach `gesture.test.js` takes with `main.js` — and
 * drive only the pure logic: paths, selectors, offsets and rect maths.
 */

import assert from 'node:assert/strict'
import { bootContent, createDocument, FakeElement, FakeText, plain } from './content-harness.js'
import { test } from 'node:test'

/** A `<p id="story">` with three text nodes, the shape a one-paragraph mark uses. */
function storyDocument() {
  const { document, body } = createDocument()
  const p = new FakeElement('p', { id: 'story' })
  p.rect = { left: 0, top: 600, width: 300, height: 40 }
  p.append(new FakeText('The quick '), new FakeText('brown fox'), new FakeText(' jumps over'))
  body.append(p)
  return { document, p }
}

/** A selection over `brown` (node 1, offsets 0–5), measured at 100,40 120×20. */
function brownSelection(document) {
  const p = document.querySelector('#story')
  const range = document.createRange()
  range.setStart(p.childNodes[1], 0)
  range.setEnd(p.childNodes[1], 5)
  range.rects = [{ left: 100, top: 40, width: 120, height: 20 }]
  return { range, selection: { rangeCount: 1, isCollapsed: false, getRangeAt: () => range } }
}

test('a selection becomes quote, domRange and a document-coordinates rect', async () => {
  const { document } = storyDocument()
  const { ns } = await bootContent({ document, scrollY: 500 })
  const { selection } = brownSelection(document)

  const state = ns.anchor.selection(selection)
  assert.ok(state, 'a live selection with text is captured')
  const { anchor, viewportRect, lineRects, live } = state
  assert.equal(anchor.kind, 'selection')
  assert.equal(anchor.quote.exact, 'brown', 'the quote is read from the block, not the range alone')
  assert.equal(anchor.quote.prefix, 'The quick ', 'the prefix is the block text before the mark')
  assert.equal(anchor.quote.suffix, ' fox jumps over')
  assert.deepEqual(plain(anchor.domRange), {
    blockSelector: '#story',
    startPath: '1',
    startOffset: 0,
    endPath: '1',
    endOffset: 5,
  })
  assert.deepEqual(plain(anchor.textPosition), { start: 10, end: 15 })
  // The stored rect is in document coordinates: scroll is baked in.
  assert.deepEqual(plain(anchor.rect), { x: 100, y: 540, w: 120, h: 20 })
  assert.deepEqual(plain(viewportRect), { x: 100, y: 40, w: 120, h: 20 }, 'the crop rect stays in viewport pixels')
  assert.deepEqual(plain(lineRects), [{ x: 100, y: 540, w: 120, h: 20 }], 'line boxes follow the same conversion')
  assert.equal(live.kind, 'range')
  assert.ok(state.live.range, 'the live range rides along for same-tick re-measurement')
})

test('a selection without a usable range degrades to null at each gate', async () => {
  const { document } = storyDocument()
  const { ns } = await bootContent({ document })
  const { range } = brownSelection(document)

  assert.equal(ns.anchor.selection(null), null, 'no selection at all')
  assert.equal(
    ns.anchor.selection({ rangeCount: 0, isCollapsed: false, getRangeAt: () => range }),
    null,
    'no range held',
  )
  assert.equal(
    ns.anchor.selection({ rangeCount: 1, isCollapsed: true, getRangeAt: () => range }),
    null,
    'a caret is not a mark',
  )
  assert.equal(
    ns.anchor.selection({ rangeCount: 1, isCollapsed: false, getRangeAt: () => null }),
    null,
    'getRangeAt can refuse',
  )

  const blank = document.createRange()
  const text = new FakeText('   ')
  document.body.append(text)
  blank.setStart(text, 0)
  blank.setEnd(text, 3)
  assert.equal(
    ns.anchor.selection({ rangeCount: 1, isCollapsed: false, getRangeAt: () => blank }),
    null,
    'whitespace-only text is not quotable',
  )
})

test('a range the page unmeasured falls back to its block box', async () => {
  const { document } = storyDocument()
  const { ns } = await bootContent({ document })
  const { range, selection } = brownSelection(document)
  // The page re-rendered between drag and read: the range reports no geometry.
  range.rects = []

  const state = ns.anchor.selection(selection)
  assert.ok(state)
  assert.deepEqual(plain(state.anchor.rect), { x: 0, y: 600, w: 300, h: 40 }, 'the owning block stands in')
  assert.equal(state.lineRects.length, 0, 'no line boxes survive an unmeasured range')
})

/** Boot with one element alone in a document, so uniqueness checks are honest. */
async function anchorFor(tag, attributes) {
  const { document, body } = createDocument()
  const { ns } = await bootContent({ document })
  const element = new FakeElement(tag, attributes)
  body.append(element)
  return { ns, state: ns.anchor.element(element) }
}

test('an element anchor prefers the id, then a test-id, then an href', async () => {
  const withId = await anchorFor('button', { id: 'go', 'data-testid': 'deploy' })
  assert.equal(withId.state.anchor.selectors.stable, '#go', 'a unique id wins over attribute candidates')
  assert.equal(withId.state.anchor.selectors.cssPath, '#go', 'the css path also stops at the unique id')
  assert.equal(withId.state.anchor.selectors.xpath, '//*[@id="go"]')

  const withTestId = await anchorFor('button', { 'data-testid': 'deploy' })
  assert.equal(
    withTestId.state.anchor.selectors.stable,
    'button[data-testid="deploy"]',
    'without an id, a unique data-testid speaks',
  )

  const link = await anchorFor('a', { href: '/docs' })
  assert.equal(link.state.anchor.selectors.stable, 'a[href="/docs"]', 'a link falls back to its href')
})

test('a duplicated id is not stable, and a bare element still gets a path', async () => {
  const { document, body } = createDocument()
  const { ns } = await bootContent({ document })
  body.append(new FakeElement('button', { id: 'go' }), new FakeElement('button', { id: 'go' }))

  const state = ns.anchor.element(body.children[0])
  assert.ok(state, 'a cssPath is still a usable selector')
  assert.equal(state.anchor.selectors.stable, undefined, 'a selector two nodes answer is not stable')
  assert.equal(state.anchor.selectors.cssPath, 'body:nth-of-type(1) > button:nth-of-type(1)')
})

test('an element fingerprint drops code and secrets and keeps identity', async () => {
  const { document, body } = createDocument()
  const { ns } = await bootContent({ document })
  const button = new FakeElement('button', {
    id: 'go',
    'data-testid': 'deploy',
    onclick: 'launch()',
    value: 'hunter2',
    style: 'color: red',
  })
  button.append(new FakeText('Deploy now'))
  body.append(button)

  const { anchor } = ns.anchor.element(button)
  assert.equal(anchor.fingerprint.tag, 'button')
  assert.equal(anchor.fingerprint.textExcerpt, 'Deploy now')
  assert.equal(anchor.fingerprint.attrs.onclick, undefined, 'inline handlers are code, not identity')
  assert.equal(anchor.fingerprint.attrs.value, undefined, 'a form value may hold what the user typed')
  assert.equal(anchor.fingerprint.attrs.style, undefined)
  assert.equal(anchor.fingerprint.attrs['data-testid'], 'deploy')
  assert.equal(anchor.diagnostics.a11yRole, 'button', 'the role is derived when not explicit')
  assert.equal(anchor.diagnostics.computedStyles.display, 'block')
  assert.ok(anchor.fingerprint.outerHtmlPreview.startsWith('<button'), 'the preview opens with the tag')
  assert.ok(!anchor.fingerprint.outerHtmlPreview.includes('hunter2'), 'dropped attributes stay out of the preview')
  assert.equal(ns.anchor.chipLabel(button, { w: 120.4, h: 20.2 }), 'button · 120×20')
})

test('a region is recorded in both coordinate systems and pinned to its element', async () => {
  const { document, body } = createDocument()
  const p = new FakeElement('p', { id: 'story' })
  p.rect = { left: 150, top: 90, width: 300, height: 200 }
  p.append(new FakeText('A story.'))
  body.append(p)
  const { ns } = await bootContent({ document, scrollY: 500 })
  document.pointStack = () => [p, document.body, document.documentElement]

  const state = ns.anchor.region({ x: 100, y: 50, w: 200, h: 100 })
  assert.ok(state)
  const { anchor } = state
  assert.equal(anchor.kind, 'region')
  assert.deepEqual(plain(anchor.pageRect), { x: 100, y: 550, w: 200, h: 100 }, 'the page rect carries the scroll')
  assert.deepEqual(plain(anchor.viewportRect), { x: 100, y: 50, w: 200, h: 100 }, 'the viewport rect does not')
  assert.deepEqual(
    plain(anchor.anchorElement),
    { selector: '#story', offsetX: -50, offsetY: -40 },
    'the offsets place the box relative to the element it rode on',
  )
  assert.equal(anchor.intersectingElements.length, 1)
  assert.equal(anchor.intersectingElements[0].tag, 'p')
  assert.equal(anchor.intersectingElements[0].selector, '#story')
  assert.equal(anchor.intersectingElements[0].textExcerpt, 'A story.')
  assert.equal(anchor.intersectingElements[0].intersectionRatio, 0.45, 'the ratio is the overlap with the region')
})

test('a region dragged past the viewport edge is clipped to it', async () => {
  const { document } = createDocument()
  const { ns } = await bootContent({ document, innerWidth: 1280, innerHeight: 800, scrollY: 0 })
  document.pointStack = () => []

  const state = ns.anchor.region({ x: 1200, y: 700, w: 200, h: 200 })
  assert.ok(state)
  assert.deepEqual(plain(state.viewportRect), { x: 1200, y: 700, w: 80, h: 100 }, 'only the on-screen part persists')
  assert.equal(state.anchor.anchorElement, undefined, 'nothing under the centre means no anchor element')
  assert.equal(state.anchor.intersectingElements.length, 0)
})

test('a degenerate region is refused instead of normalised into existence', async () => {
  const { document } = createDocument()
  const { ns } = await bootContent({ document })
  assert.equal(ns.anchor.region({ x: 10, y: 10, w: 0.5, h: 50 }), null, 'too thin to crop')
  assert.equal(ns.anchor.region({ x: 10, y: 10, w: 50, h: 0 }), null, 'too flat to crop')
  assert.equal(ns.anchor.region({ x: -500, y: -500, w: 100, h: 100 }), null, 'fully off-screen')
  assert.equal(ns.anchor.region(null), null)
})

test('the live rect re-measures elements but follows the stored rect for regions', async () => {
  const { document, body } = createDocument()
  const { ns } = await bootContent({ document, scrollY: 500 })
  const button = new FakeElement('button', { id: 'go' })
  button.rect = { left: 10, top: 20, width: 30, height: 40 }
  body.append(button)

  const elementState = ns.anchor.element(button)
  button.rect = { left: 110, top: 120, width: 30, height: 40 }
  assert.deepEqual(
    plain(ns.anchor.liveViewportRect(elementState)),
    { x: 110, y: 120, w: 30, h: 40 },
    'an element is measured where it is now',
  )

  const regionState = ns.anchor.region({ x: 10, y: 20, w: 30, h: 40 })
  assert.deepEqual(
    plain(ns.anchor.liveViewportRect(regionState)),
    { x: 10, y: 20, w: 30, h: 40 },
    'a region converts its stored page rect back to viewport pixels',
  )

  button.isConnected = false
  assert.deepEqual(
    plain(ns.anchor.liveViewportRect(elementState)),
    { x: 10, y: 20, w: 30, h: 40 },
    'a detached element keeps the rect captured with it',
  )
})

test('whitespace is normalised and our own marks stay invisible to extraction', async () => {
  const { document, body } = createDocument()
  const { ns } = await bootContent({ document })
  assert.equal(ns.text.normalizeWs('  a\n\t b  '), 'a b', 'the quote helpers compare reflowed text')

  const mark = new FakeElement('mark', { 'data-dsh-anno': 'an-1' })
  const inner = new FakeText('highlighted')
  mark.append(inner)
  body.append(mark)
  assert.equal(ns.text.isOurs(inner), true, 'text inside a painted highlight is not page content')
  assert.equal(ns.text.isMark(mark), true)
  assert.equal(ns.text.isOurs(new FakeText('plain')), false)
})
