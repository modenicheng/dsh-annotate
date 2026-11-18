import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  describeAnchor,
  encodeFrame,
  newAnnotationId,
  normalizeRecord,
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
