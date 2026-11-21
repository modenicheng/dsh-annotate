/**
 * The outbox's queue invariants, without a browser.
 *
 * `src/background/outbox.js` is evaluated in a `node:vm` context with fake
 * storage. The user-facing promise is that a comment, once submitted, is never
 * silently lost — these tests pin the three mechanics behind it: `add` is
 * idempotent by record id, a flush sends in FIFO order and waits for each ack,
 * and a quota error sheds the oldest crops (then the oldest annotations)
 * instead of dropping the write.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)

/**
 * Boot the outbox module.
 *
 * @param {{ stored?: any[], quotaFailures?: number }} [options] the persisted
 *   queue to start from, and how many times `browser.storage.local.set` fails
 *   with a quota error before it succeeds (models the shrink path).
 */
async function loadOutbox(options = {}) {
  let stored = options.stored ?? []
  let quotaFailures = options.quotaFailures ?? 0
  const writes = []
  const notes = []
  const sentFrames = []

  const sandbox = {
    console: { debug() {}, info() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    browser: {
      storage: {
        local: {
          get: async (key) => ({ [key]: stored }),
          set: async (bag) => {
            if (quotaFailures > 0) {
              quotaFailures -= 1
              throw new Error('QUOTA_BYTES exceeded')
            }
            for (const [key, value] of Object.entries(bag)) {
              stored = value
              writes.push(JSON.parse(JSON.stringify(value)))
            }
          },
        },
      },
    },
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)

  const ns = {
    msg: { STORAGE_KEYS: { outbox: 'anno.outbox' } },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    describeError: (error) => String(error?.message ?? error),
    isPlainObject: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    // `load()` is the only reader; it wants the stored array, whatever it is.
    storageGet: async () => stored,
    storageSet: async (key, value) => {
      stored = value
    },
    publishStatus() {
      return Promise.resolve()
    },
    capture: {
      withNote: (record, note) => {
        notes.push({ id: record.id, note })
        return { ...record, note }
      },
    },
    net: {
      isAuthed: () => true,
      send: (frame) => {
        sentFrames.push(frame)
        return true
      },
    },
    routing: {
      waitForAck: async () => undefined,
    },
  }
  sandbox.__DSH_ANNO_BG__ = ns
  vm.runInContext(await readFile(join(extensionRoot, 'src/background/outbox.js'), 'utf8'), context, {
    filename: 'src/background/outbox.js',
  })
  return { outbox: ns.outbox, writes, notes, sentFrames, readStored: () => JSON.parse(JSON.stringify(stored)) }
}

/** A minimal but complete entry the way `main.js` queues one. */
function entry(id, overrides = {}) {
  return {
    record: { id, kind: 'selection' },
    image: null,
    captureRequest: null,
    captureAttempts: 0,
    nextCaptureAt: 0,
    enqueuedAt: Number(id.replaceAll(/\D/g, '')) || 0,
    sendAttempts: 0,
    blocked: false,
    lastError: null,
    ...overrides,
  }
}

test('add is idempotent by record id and refuses an entry without one', async () => {
  const { outbox } = await loadOutbox()
  const first = await outbox.add(entry('an-1'))
  const again = await outbox.add({ ...entry('an-1'), lastError: 'not this one' })
  assert.equal(again, first, 'a duplicated id returns the queued entry, unchanged')
  assert.equal(outbox.entries().length, 1)
  await assert.rejects(() => outbox.add(entry('')), /record id/)
  await assert.rejects(() => outbox.add({}), /record id/)
})

test('restore sorts by enqueuedAt, drops garbage, and keeps one entry per id', async () => {
  const { outbox } = await loadOutbox({
    stored: [
      entry('an-3'),
      'not an entry',
      entry('an-1'),
      { ...entry('an-2'), image: { b64: 'aGVsbG8=', mime: 'image/png' } },
      entry('an-2'),
    ],
  })
  await outbox.load()
  const restored = outbox.entries()
  // The entries array crosses the vm realm boundary; copy it out so the
  // deep-equal compares data, not realm prototypes.
  assert.deepEqual(
    Array.from(restored.map((item) => item.record.id)),
    ['an-1', 'an-2', 'an-3'],
    'FIFO order is enqueuedAt order, duplicates and garbage are gone',
  )
  assert.equal(restored[1].image.b64, 'aGVsbG8=', 'a valid image survives the restore')
})

test('a flush sends in FIFO order and removes each acknowledged entry', async () => {
  const { outbox, sentFrames, readStored } = await loadOutbox({
    stored: [entry('an-2'), entry('an-1'), entry('an-3')],
  })
  const result = await outbox.flush({ reason: 'test' })
  assert.equal(result.sent, 3)
  assert.equal(result.remaining, 0)
  assert.deepEqual(
    sentFrames.map((frame) => frame.record.id),
    ['an-1', 'an-2', 'an-3'],
    'the wire order is the queue order',
  )
  assert.equal(outbox.entries().length, 0)
  assert.equal(readStored().length, 0, 'the emptied queue is persisted')
})

test('a quota error sheds the oldest crop first, and only then an entry', async () => {
  const withCrops = [
    entry('an-1', { image: { b64: 'x'.repeat(64), mime: 'image/png' } }),
    entry('an-2', { image: { b64: 'y'.repeat(64), mime: 'image/png' } }),
  ]
  // Two failures: the first sheds an-1's crop, the second sheds an-2's; the
  // third write succeeds with both comments intact.
  const { outbox, notes, readStored } = await loadOutbox({ stored: withCrops, quotaFailures: 2 })
  await outbox.add(entry('an-3'))

  const stored = readStored()
  assert.equal(stored.length, 3, 'every annotation survived the quota errors')
  assert.equal(stored[0].image, null, 'the oldest crop was shed')
  assert.equal(stored[1].image, null, 'the next-oldest crop was shed too')
  assert.equal(stored[2].record.id, 'an-3')
  assert.deepEqual(
    notes.map((note) => note.id),
    ['an-1', 'an-2'],
    'each shed crop is explained on the record the user will read',
  )
  assert.equal(outbox.entries()[0].captureAttempts >= 1, true, 'no more capture retries for a shed crop')
})

test('a quota error with nothing left to shed drops the oldest annotation', async () => {
  const { outbox, readStored } = await loadOutbox({
    stored: [entry('an-1'), entry('an-2')],
    quotaFailures: 1,
  })
  await outbox.add(entry('an-3'))
  assert.deepEqual(
    readStored().map((item) => item.record.id),
    ['an-2', 'an-3'],
    'the oldest entry was the last thing to go',
  )
})

test('the hard cap keeps at most MAX_ENTRIES annotations', async () => {
  const { outbox } = await loadOutbox({ stored: [] })
  for (let index = 1; index <= outbox.MAX_ENTRIES + 1; index += 1) {
    await outbox.add(entry(`an-${String(index).padStart(2, '0')}`))
  }
  assert.equal(outbox.entries().length, outbox.MAX_ENTRIES)
  assert.equal(outbox.entries()[0].record.id, 'an-02', 'the oldest was dropped, not the newest')
})
