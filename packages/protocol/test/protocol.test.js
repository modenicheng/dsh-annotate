import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SESSION_CREATE_MODES,
  describeAnchor,
  encodeFrame,
  formatAnnoMention,
  newAnnotationId,
  normalizeRecord,
  parseAnnoText,
  parseClientFrame,
  parseServerFrame,
  protocolCompatibleWith,
  protocolInRange,
  sameDocument,
  validateRecord,
  validateSessionCreateRequest,
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

test('the protocol window is checked from both sides', () => {
  assert.equal(MIN_PROTOCOL_VERSION <= PROTOCOL_VERSION, true, 'the window is well-formed')
  // The host-side check on a client's `hello.version`, against this build's window.
  assert.equal(protocolInRange(MIN_PROTOCOL_VERSION), true)
  assert.equal(protocolInRange(PROTOCOL_VERSION), true)
  assert.equal(protocolInRange(PROTOCOL_VERSION + 1), false, 'above the window')
  assert.equal(protocolInRange(MIN_PROTOCOL_VERSION - 1), false, 'below the window')
  assert.equal(protocolInRange(1.5), false, 'a version is an integer')
  assert.equal(protocolInRange('1'), false)
  assert.equal(protocolInRange(1, 2, 3), false, 'an explicit foreign window is honored')
  assert.equal(protocolInRange(2, 1, 3), true)
  // The client-side check on the window a host advertised.
  assert.equal(protocolCompatibleWith(PROTOCOL_VERSION), true, 'an equal peer')
  assert.equal(
    protocolCompatibleWith(PROTOCOL_VERSION + 1, MIN_PROTOCOL_VERSION),
    true,
    'a newer host whose floor reaches back to this build — the rollout case D15 exists for',
  )
  assert.equal(
    protocolCompatibleWith(PROTOCOL_VERSION + 1, PROTOCOL_VERSION + 1),
    false,
    'a floor above this build: this extension is the older half',
  )
  assert.equal(
    protocolCompatibleWith(MIN_PROTOCOL_VERSION - 1),
    false,
    'a host that cannot receive this build: the host is the older half',
  )
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

test('the click-time snapshot survives normalization field for field', () => {
  // The snapshot is what the reader is allowed to trust, so nothing may be
  // recomputed from the current page: it is carried through or dropped whole.
  const snapshot = {
    at: '2026-11-18T12:00:00.000Z',
    rect: { x: 556, y: 448, w: 920, h: 337 },
    viewport: { width: 2032, height: 1216, dpr: 1.25, scrollX: 0, scrollY: 120 },
  }
  const normalized = normalizeRecord(record({ snapshot }))
  assert.deepEqual(normalized.snapshot, snapshot)
  assert.deepEqual(validateRecord(record({ snapshot })), [])

  // A viewport that only names its size still normalizes; the rest reads as 0
  // rather than as an invented value.
  const partial = normalizeRecord(
    record({ snapshot: { at: snapshot.at, rect: snapshot.rect, viewport: { width: 800, height: 600 } } }),
  )
  assert.equal(partial.snapshot.viewport.dpr, 0)
  assert.equal(partial.snapshot.viewport.scrollY, 0)

  // A snapshot without a rect or a date is not a frame anything can be read
  // against, and is dropped instead of half-kept.
  assert.equal(normalizeRecord(record({ snapshot: { at: snapshot.at } })).snapshot, undefined)
  assert.equal(normalizeRecord(record({ snapshot: { rect: snapshot.rect } })).snapshot, undefined)
  assert.ok(
    validateRecord(record({ snapshot: { at: 'not a date', rect: snapshot.rect, viewport: { width: 1, height: 1 } } }))
      .length > 0,
  )
  assert.ok(
    validateRecord(
      record({ snapshot: { at: snapshot.at, rect: { x: 0, y: 0, w: 1 }, viewport: { width: 1, height: 1 } } }),
    ).length > 0,
  )
})

test('a record without a snapshot stays valid, because older overlays exist', () => {
  assert.equal(normalizeRecord(record()).snapshot, undefined)
  assert.deepEqual(validateRecord(record()), [])
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

// ── session-create requests ─────────────────────────────────────────────────

test('session-create bodies accept each workspace mode', () => {
  assert.deepEqual(validateSessionCreateRequest({ mode: 'default' }), [])
  assert.deepEqual(validateSessionCreateRequest({ mode: 'existing', workspaceId: 'w-1' }), [])
  assert.deepEqual(validateSessionCreateRequest({ mode: 'new', path: 'D:\\projects\\my-app', title: 'My App' }), [])
  assert.deepEqual(validateSessionCreateRequest({ mode: 'new', path: '/home/me/my-app' }), [])
})

test('session-create bodies reject unknown modes and bad payloads', () => {
  assert.deepEqual(validateSessionCreateRequest(null), ['body must be a JSON object'])
  assert.deepEqual(validateSessionCreateRequest({}), [`mode must be one of ${SESSION_CREATE_MODES.join('|')}`])
  // `existing` names a workspace; anything else is not a choice.
  for (const body of [{ mode: 'existing' }, { mode: 'existing', workspaceId: '' }]) {
    assert.match(validateSessionCreateRequest(body).join(), /workspaceId is required/)
  }
})

test('session-create paths are absolute, bounded and null-free', () => {
  for (const path of ['projects/app', '', 'a\0b']) {
    const errors = validateSessionCreateRequest({ mode: 'new', path })
    assert.notEqual(errors.length, 0, path)
  }
  const long = `D:\\${'x'.repeat(2_000)}`
  assert.match(validateSessionCreateRequest({ mode: 'new', path: long }).join(), /exceeds/)
})

test('session-create titles are optional but bounded and non-blank', () => {
  assert.deepEqual(validateSessionCreateRequest({ mode: 'default', title: undefined }), [])
  assert.match(validateSessionCreateRequest({ mode: 'default', title: '  ' }).join(), /blank/)
  assert.match(validateSessionCreateRequest({ mode: 'default', title: 3 }).join(), /string/)
  assert.match(validateSessionCreateRequest({ mode: 'default', title: 'x'.repeat(300) }).join(), /exceeds/)
})
