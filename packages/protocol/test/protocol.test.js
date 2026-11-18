import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  describeAnchor,
  encodeFrame,
  formatAnnoMention,
  newAnnotationId,
  normalizeRecord,
  parseAnnoText,
  parseClientFrame,
  parseServerFrame,
  sameDocument,
  validateRecord,
  validateAnchor,
} from '../src/index.js'

/** @returns {any} a record that passes validation */
function record(overrides = {}) {
  return {
    id: 'an-20261118-abcdef',
    url: 'https://example.com/pricing?ref=docs#plans',
    title: 'Pricing',
    anchor: {
      kind: 'selection',
      quote: { exact: 'Enterprise', prefix: 'Plan: ', suffix: ' tier' },
      domRange: { blockSelector: 'main > h2', startPath: '0', startOffset: 0, endPath: '0', endOffset: 10 },
      textPosition: { start: 120, end: 130 },
      rect: { x: 10, y: 20, w: 100, h: 24 },
    },
    comment: '这个价格和文档不一致',
    intent: 'bug',
    crops: {},
    routing: { source: 'user' },
    state: 'open',
    createdAt: '2026-11-18T12:00:00.000Z',
    updatedAt: '2026-11-18T12:00:00.000Z',
    ...overrides,
  }
}

test('ids are formatted and time-scoped', () => {
  const id = newAnnotationId(new Date(2026, 10, 18), () => 0.5)
  assert.equal(id, 'an-20261118-888888')
  assert.match(id, /^an-\d{8}-[0-9a-f]{6}$/)
})

test('a well-formed record validates', () => {
  assert.deepEqual(validateRecord(record()), [])
})

test('element anchors need at least one selector', () => {
  const errors = validateAnchor({
    kind: 'element',
    selectors: {},
    fingerprint: { tag: 'div' },
    rect: { x: 0, y: 0, w: 1, h: 1 },
  })
  assert.match(errors.join(), /at least one of/)
})

test('region anchors carry page and viewport rects', () => {
  const errors = validateAnchor({
    kind: 'region',
    pageRect: { x: 0, y: 0, w: 10, h: 10 },
    viewportRect: { x: 0, y: 0, w: 10, h: 10 },
  })
  assert.deepEqual(errors, [])
})

test('a mark with no comment is still a whole annotation', () => {
  // The anchor is the payload; the comment is optional metadata (D10). Nothing
  // in the wire format may treat an empty comment as an incomplete record.
  const bare = record({ comment: '' })
  assert.deepEqual(validateRecord(bare), [])
  const normalized = normalizeRecord({ ...bare, comment: undefined })
  assert.equal(normalized.comment, '')
  assert.equal(describeAnchor(normalized), 'selection "Enterprise"')
})

test('normalize fills derived fields without mutating input', () => {
  const input = record()
  delete input.createdAt
  delete input.state
  const normalized = normalizeRecord(input, { now: () => new Date('2026-11-18T13:00:00.000Z') })
  assert.equal(normalized.state, 'open')
  assert.equal(normalized.createdAt, '2026-11-18T13:00:00.000Z')
  assert.equal(normalized.origin, 'https://example.com')
  assert.equal(normalized.pathname, '/pricing')
  assert.equal(input.state, undefined)
})

test('restricted pages normalize without an origin', () => {
  const normalized = normalizeRecord({ ...record(), url: 'about:blank' })
  assert.equal(normalized.origin, '')
  assert.equal(normalized.pathname, '')
  assert.equal(normalized.url, 'about:blank')
})

test('client frames reject unknown types and bad payloads', () => {
  assert.equal(parseClientFrame('not json').ok, false)
  assert.equal(parseClientFrame({ t: 'nope' }).ok, false)
  assert.equal(parseClientFrame({ t: 'hello', token: '', version: 1 }).ok, false)
  assert.equal(parseClientFrame({ t: 'hello', token: 't', version: 1 }).ok, true)
  assert.equal(parseClientFrame({ t: 'anno.create', record: {} }).ok, false)
  assert.equal(parseClientFrame({ t: 'anno.create', record: record() }).ok, true)
  assert.equal(parseClientFrame({ t: 'anno.mutate', id: 'x', action: 'delete' }).ok, true)
  assert.equal(parseClientFrame({ t: 'anno.mutate', id: 'x', action: 'edit' }).ok, false)
})

test('server frames are parsed symmetrically', () => {
  const ok = parseServerFrame(encodeFrame({ t: 'hello.ok', version: 1, openCount: 2 }))
  assert.equal(ok.ok, true)
  assert.equal(parseServerFrame({ t: 'anno.create' }).ok, false)
})

test('sameCommand identity ignores query and hash', () => {
  assert.equal(sameDocument({ url: 'https://a.com/x?1#h' }, 'https://a.com/x?2'), true)
  assert.equal(sameDocument({ url: 'https://a.com/x' }, 'https://a.com/y'), false)
  assert.equal(sameDocument({ url: 'about:blank' }, 'about:blank'), true)
})

test('describeAnchor stays short', () => {
  assert.match(describeAnchor(record()), /^selection "Enterprise"$/)
  assert.match(
    describeAnchor({ ...record(), anchor: { kind: 'element', fingerprint: { tag: 'button', textExcerpt: 'Buy' } } }),
    /^element <button> "Buy"$/,
  )
})

test('an annotation mention round-trips through its canonical form', () => {
  const mention = formatAnnoMention({ id: 'an-20261118-ab12cd', label: '批注 · “Enterprise”' })
  assert.equal(mention, '@[批注 · “Enterprise”](dsh-anno:an-20261118-ab12cd)')
  const parsed = parseAnnoText(`看这里 ${mention} 谢谢`)
  assert.equal(parsed.text, '看这里 @批注 · “Enterprise” 谢谢')
  assert.deepEqual(parsed.references, [{ id: 'an-20261118-ab12cd', label: '批注 · “Enterprise”' }])
})

test('mention labels escape brackets and backslashes', () => {
  const label = 'see [this] \\ that'
  const mention = formatAnnoMention({ id: 'an-1', label })
  assert.equal(mention, '@[see \\[this\\] \\\\ that](dsh-anno:an-1)')
  assert.equal(parseAnnoText(mention).references[0].label, label)
})

test('only URL-safe ids form mentions', () => {
  assert.equal(formatAnnoMention({ id: 'an 1/x', label: 'x' }), '')
  assert.equal(formatAnnoMention({ id: 'an-20261118-ab12cd' }), '@[an-20261118-ab12cd](dsh-anno:an-20261118-ab12cd)')
})

test('broken or unrelated mentions stay literal text', () => {
  for (const text of ['@[x](dsh-anno:)', '@[x](dsh-anno:has space)', 'no mentions here', '@[x](dsh-session:abc)']) {
    const parsed = parseAnnoText(text)
    assert.equal(parsed.text, text)
    assert.deepEqual(parsed.references, [])
  }
})

test('mentions parse in order, and a bare URI counts too', () => {
  const text = '@[a](dsh-anno:an-1) and dsh-anno:an-2 plus @[a](dsh-anno:an-1)'
  const parsed = parseAnnoText(text)
  assert.equal(parsed.text, '@a and @an-2 plus @a')
  assert.deepEqual(
    parsed.references.map((reference) => reference.id),
    ['an-1', 'an-2', 'an-1'],
  )
})
