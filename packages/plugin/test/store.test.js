import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { AnnotationStore, matchesUrl } from '../src/store.js'

const silent = { debug() {}, warn() {} }

/** @type {string} */
let root

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-anno-store-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** @param {string} name @param {Partial<any>} [overrides] */
function record(name, overrides = {}) {
  return {
    id: `an-20261118-${name}`,
    url: `https://example.com/${name}`,
    origin: 'https://example.com',
    pathname: `/${name}`,
    title: name,
    anchor: {
      kind: 'element',
      selectors: { cssPath: `#${name}`, xpath: `//*[@id="${name}"]` },
      fingerprint: { tag: 'div' },
      diagnostics: {},
      rect: { x: 1, y: 2, w: 3, h: 4 },
    },
    comment: `comment ${name}`,
    crops: {},
    routing: { source: 'user' },
    state: 'open',
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  }
}

test('put, patch, delete round-trip through the log', async () => {
  const dir = join(root, 'basic')
  const store = await new AnnotationStore({ dir, logger: silent }).load()
  await store.put(record('aaaaaa'))
  assert.equal(store.size, 1)
  assert.equal(store.get('an-20261118-aaaaaa')?.state, 'open')

  const patched = await store.patch('an-20261118-aaaaaa', { state: 'resolved' })
  assert.equal(patched?.state, 'resolved')

  const reopened = await new AnnotationStore({ dir, logger: silent }).load()
  assert.equal(reopened.get('an-20261118-aaaaaa')?.state, 'resolved', 'the fold survives a restart')

  assert.equal(await store.delete('an-20261118-aaaaaa'), true)
  const afterDelete = await new AnnotationStore({ dir, logger: silent }).load()
  assert.equal(afterDelete.size, 0)
})

test('a torn trailing line does not lose earlier events', async () => {
  const dir = join(root, 'torn')
  const store = await new AnnotationStore({ dir, logger: silent }).load()
  await store.put(record('bbbbbb'))
  await writeFile(
    join(dir, 'queue.jsonl'),
    `${await readFile(join(dir, 'queue.jsonl'), 'utf8')}{"op":"put","id":`,
    'utf8',
  )
  const reloaded = await new AnnotationStore({ dir, logger: silent }).load()
  assert.equal(reloaded.size, 1)
})

test('list filters by state, url and kind', async () => {
  const store = await new AnnotationStore({ dir: join(root, 'filters'), logger: silent }).load()
  await store.put(record('cccccc'))
  await store.put(record('dddddd', { state: 'resolved', url: 'https://other.test/x' }))
  assert.deepEqual(
    store.list({ status: 'open' }).map((item) => item.id),
    ['an-20261118-cccccc'],
  )
  assert.equal(store.list({ status: 'all' }).length, 2)
  assert.equal(store.list({ status: 'all', url: 'https://other.test/x' }).length, 1)
  assert.equal(store.list({ status: 'all', kind: 'region' }).length, 0)
})

test('compaction keeps the live projection and drops dead lines', async () => {
  const dir = join(root, 'compact')
  const store = await new AnnotationStore({ dir, logger: silent }).load()
  await store.put(record('eeeeee'))
  for (let index = 0; index < 2_500; index += 1) {
    await store.patch('an-20261118-eeeeee', { comment: `edit ${index}` })
  }
  const before = (await readFile(join(dir, 'queue.jsonl'), 'utf8')).split('\n').filter(Boolean).length
  assert.ok(before > 2_000)
  assert.equal(await store.maybeCompact(), true)
  const after = (await readFile(join(dir, 'queue.jsonl'), 'utf8')).split('\n').filter(Boolean).length
  assert.ok(after < 10, `expected a compacted log, got ${after} lines`)
  const reloaded = await new AnnotationStore({ dir, logger: silent }).load()
  assert.equal(reloaded.get('an-20261118-eeeeee')?.comment, 'edit 2499')
})

test('image references survive a reload', async () => {
  const dir = join(root, 'images')
  const store = await new AnnotationStore({ dir, logger: silent }).load()
  await store.put(record('ffffff'))
  await store.setImage('an-20261118-ffffff', { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 12 })
  const reloaded = await new AnnotationStore({ dir, logger: silent }).load()
  assert.equal(reloaded.image('an-20261118-ffffff')?.attachmentId, 'sha256:abc')
})

test('url matching is forgiving about query strings but not paths', () => {
  assert.equal(matchesUrl('https://a.test/docs?x=1#h', 'https://a.test/docs?x=2'), true)
  assert.equal(matchesUrl('https://a.test/docs', 'https://a.test/other'), false)
  assert.equal(matchesUrl('https://a.test/docs', 'https://a.test/'), true)
  assert.equal(matchesUrl('https://a.test/docs', 'a.test'), true)
})
