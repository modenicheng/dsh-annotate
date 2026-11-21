/**
 * The re-anchor fallback chains, pinned without a browser.
 *
 * Every modality resolves through an ordered ladder and the last rung is always
 * a floating pin, so a re-render may degrade a highlight but never lose the
 * annotation. These tests drive `resolve` one rung at a time — each success
 * short-circuits the rungs below it, each failure drops to the next — over the
 * same fake-DOM harness `anchor.test.js` uses.
 */

import assert from 'node:assert/strict'
import { bootContent, createDocument, FakeElement, FakeText, plain } from './content-harness.js'
import { test } from 'node:test'

/** `<p id="story">The quick brown fox jumps over</p>` as three text nodes. */
function storyDocument() {
  const { document, body } = createDocument()
  const p = new FakeElement('p', { id: 'story' })
  p.append(new FakeText('The quick '), new FakeText('brown fox'), new FakeText(' jumps over'))
  body.append(p)
  return { document, p }
}

/** A stored selection anchor over `brown`, with the domRange the capture wrote. */
function selectionAnchor(overrides = {}) {
  return {
    kind: 'selection',
    quote: { exact: 'brown', prefix: 'The quick ', suffix: ' fox jumps over' },
    domRange: { blockSelector: '#story', startPath: '1', startOffset: 0, endPath: '1', endOffset: 5 },
    rect: { x: 100, y: 40, w: 120, h: 20 },
    ...overrides,
  }
}

function resolveAnchor(ns, anchor, document) {
  return ns.hydrate.resolve({ id: 'an-20261121-aa0001', anchor }, document, {})
}

test('a selection whose block and child paths survive re-anchors by dom-range', async () => {
  const { document } = storyDocument()
  const { ns } = await bootContent({ document })

  const placement = resolveAnchor(ns, selectionAnchor(), document)
  assert.equal(placement.method, 'dom-range', 'the cheapest rung wins when it verifies')
  assert.equal(placement.range.toString(), 'brown', 'the rebuilt range holds the quote')
  assert.ok(placement.target, 'the placement carries the node freshness is checked against')
  assert.equal(ns.hydrate.isFresh(placement), true)
})

test('a rebuilt block falls back to the quote inside it', async () => {
  const { document } = storyDocument()
  const { ns } = await bootContent({ document })
  // The block survived but its children were rebuilt: the recorded child path
  // now points past the end of the paragraph.
  const anchor = selectionAnchor({
    domRange: { blockSelector: '#story', startPath: '9', startOffset: 0, endPath: '9', endOffset: 6 },
  })

  const placement = resolveAnchor(ns, anchor, document)
  assert.equal(placement.method, 'quote-block', 'the block is searched before the whole document')
  assert.equal(placement.range.toString(), 'brown')
})

test('a vanished block searches the whole document for the quote', async () => {
  const { document, body } = createDocument()
  const elsewhere = new FakeElement('q', { id: 'elsewhere' })
  elsewhere.append(new FakeText('The quick brown fox jumps over'))
  body.append(elsewhere)
  const { ns } = await bootContent({ document })
  const anchor = selectionAnchor({
    domRange: { blockSelector: '#gone', startPath: '0', startOffset: 0, endPath: '0', endOffset: 5 },
  })

  const placement = resolveAnchor(ns, anchor, document)
  assert.equal(placement.method, 'quote-document', 'the quote is exact, only the block moved')
  assert.equal(placement.range.toString(), 'brown')
})

test('a reflowed quote is found through its whitespace-normalised form', async () => {
  const { document, body } = createDocument()
  const p = new FakeElement('p', { id: 'story' })
  // The page re-flowed the line breaks; the stored quote kept single spaces.
  p.append(new FakeText('The quick\tbrown\nfox jumps over'))
  body.append(p)
  const { ns } = await bootContent({ document })

  const anchor = selectionAnchor({
    domRange: null,
    quote: { exact: 'quick brown', prefix: 'The ', suffix: ' fox' },
  })
  const placement = resolveAnchor(ns, anchor, document)
  assert.equal(placement.method, 'quote-fuzzy', 'normalisation is the rung before the pin')
  assert.equal(placement.range.toString(), 'quick\tbrown', 'the range spans the reflowed original')
})

test('a selection whose text is gone lands on a pin at the stored rect', async () => {
  const { document, body } = createDocument()
  const replaced = new FakeElement('p', { id: 'story' })
  replaced.append(new FakeText('the text moved on'))
  body.append(replaced)
  const { ns } = await bootContent({ document })
  const anchor = selectionAnchor({ domRange: null })

  const placement = resolveAnchor(ns, anchor, document)
  assert.equal(placement.method, 'pin')
  assert.deepEqual(
    plain(placement.pageRect),
    { x: 100, y: 40, w: 120, h: 20 },
    'the pin floats where the mark was stored',
  )
  assert.equal(placement.target, null)
  assert.equal(placement.range, null)
  assert.equal(ns.hydrate.isFresh(placement), false, 'a pin is always re-checked, never trusted')
})

test('an element re-anchors by stable selector, then css path, then xpath', async () => {
  const { document, body } = createDocument()
  const button = new FakeElement('button', { id: 'go' })
  button.append(new FakeText('Go'))
  body.append(button)
  const { ns } = await bootContent({ document })
  const fingerprint = { tag: 'button', textExcerpt: 'Go', attrs: {} }

  const byStable = resolveAnchor(
    ns,
    { kind: 'element', selectors: { stable: '#go', cssPath: 'button' }, fingerprint, rect: { x: 0, y: 0, w: 1, h: 1 } },
    document,
  )
  assert.equal(byStable.method, 'stable', 'the first rung that answers wins')

  const byPath = resolveAnchor(
    ns,
    {
      kind: 'element',
      selectors: { stable: '#gone', cssPath: 'body:nth-of-type(1) > button:nth-of-type(1)' },
      fingerprint,
      rect: { x: 0, y: 0, w: 1, h: 1 },
    },
    document,
  )
  assert.equal(byPath.method, 'css-path', 'a dead stable selector drops to the positional path')

  const byXpath = resolveAnchor(
    ns,
    { kind: 'element', selectors: { xpath: '//*[@id="go"]' }, fingerprint, rect: { x: 0, y: 0, w: 1, h: 1 } },
    document,
  )
  assert.equal(byXpath.method, 'xpath', 'xpath answers when both css rungs miss')
  assert.equal(byXpath.target, button)
})

test('a selector that finds the wrong element keeps falling to similarity', async () => {
  const { document, body } = createDocument()
  // The id moved onto an unrelated div; the real twin is an unmarked button.
  const decoy = new FakeElement('div', { id: 'go' })
  decoy.append(new FakeText('qqq'))
  const twin = new FakeElement('button')
  twin.append(new FakeText('Deploy now'))
  body.append(decoy, twin)
  const { ns } = await bootContent({ document })
  const anchor = {
    kind: 'element',
    selectors: { stable: '#go' },
    fingerprint: { tag: 'button', textExcerpt: 'Deploy now', attrs: {} },
    rect: { x: 0, y: 0, w: 1, h: 1 },
  }

  const placement = resolveAnchor(ns, anchor, document)
  assert.equal(placement.method, 'similarity', 'the tag-and-text fingerprint finds the rebuilt twin')
  assert.equal(placement.target, twin, 'and not the div that stole the id')
})

test('an element nothing resembles lands on a pin', async () => {
  const { document, body } = createDocument()
  body.append(new FakeElement('p').append(new FakeText('unrelated')))
  const { ns } = await bootContent({ document })
  const anchor = {
    kind: 'element',
    selectors: {},
    fingerprint: { tag: 'button', textExcerpt: 'Deploy now', attrs: {} },
    rect: { x: 8, y: 9, w: 10, h: 11 },
  }

  const placement = resolveAnchor(ns, anchor, document)
  assert.equal(placement.method, 'pin')
  assert.deepEqual(plain(placement.pageRect), { x: 8, y: 9, w: 10, h: 11 })
})

test('a region follows its anchor element, or stands on its stored rect', async () => {
  const { document, body } = createDocument()
  const panel = new FakeElement('div', { id: 'panel' })
  panel.rect = { left: 10, top: 50, width: 400, height: 300 }
  body.append(panel)
  const { ns } = await bootContent({ document })

  const following = resolveAnchor(
    ns,
    {
      kind: 'region',
      pageRect: { x: 100, y: 500, w: 80, h: 40 },
      anchorElement: { selector: '#panel', offsetX: 20, offsetY: 30 },
    },
    document,
  )
  assert.equal(following.method, 'anchor-element')
  assert.deepEqual(plain(following.pageRect), { x: 30, y: 80, w: 80, h: 40 }, 'the stored size rides the moved element')
  assert.equal(following.target, panel)
  assert.equal(ns.hydrate.isFresh(following), true)

  const standing = resolveAnchor(
    ns,
    {
      kind: 'region',
      pageRect: { x: 100, y: 500, w: 80, h: 40 },
      anchorElement: { selector: '#gone', offsetX: 20, offsetY: 30 },
    },
    document,
  )
  assert.equal(standing.method, 'page-rect')
  assert.deepEqual(plain(standing.pageRect), { x: 100, y: 500, w: 80, h: 40 })
  assert.equal(ns.hydrate.isFresh(standing), false, 'a rect with no node is re-checked every pass')
})

test('isFresh trusts only a connected node', async () => {
  const { document, body } = createDocument()
  const { ns } = await bootContent({ document })
  const attached = new FakeElement('p')
  const detached = new FakeElement('p')
  body.append(attached)

  assert.equal(ns.hydrate.isFresh({ target: attached }), true)
  detached.isConnected = false
  assert.equal(ns.hydrate.isFresh({ target: detached }), false, 'a node the page removed is stale')
  assert.equal(ns.hydrate.isFresh({ target: null }), false, 'pins carry no node')
  assert.equal(ns.hydrate.isFresh(null), false)
})

test('resolveAll keeps the records it placed and drops the ones it could not', async () => {
  const { document } = storyDocument()
  const { ns } = await bootContent({ document })
  const placeable = { id: 'an-20261121-bb0002', anchor: selectionAnchor() }
  // A region with no page rect at all cannot even be pinned.
  const impossible = { id: 'an-20261121-bb0003', anchor: { kind: 'region' } }

  const out = ns.hydrate.resolveAll([placeable, impossible], document)
  assert.equal(out.length, 1)
  assert.equal(out[0].record, placeable)
  assert.equal(out[0].placement.method, 'dom-range')
})

test('the scheduler coalesces a burst of mutation requests into one run', async () => {
  const { document } = createDocument()
  const { ns, sandbox } = await bootContent({ document })
  const runs = []
  const scheduler = ns.hydrate.createScheduler(() => runs.push(Date.now()), 250)

  scheduler.request()
  scheduler.request()
  scheduler.request()
  assert.equal(scheduler.pending, true, 'a queued run absorbs the extra requests')
  sandbox.flushTimers()
  assert.equal(runs.length, 1, 'the burst ran once')
  assert.equal(scheduler.pending, false)

  scheduler.stop()
  scheduler.request()
  assert.equal(scheduler.pending, false, 'a stopped scheduler stays quiet')
})
