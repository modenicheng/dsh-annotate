import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createMentionQueue, registerQueueRoutes } from '../src/queue.js'
import { QUEUE_ACK_PATH, QUEUE_PATH } from '../src/protocol.js'

/** @returns {Promise<{ dir: string, queue: ReturnType<typeof createMentionQueue> }>} */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-anno-queue-'))
  const queue = createMentionQueue({ dir })
  await queue.load()
  return { dir, queue }
}

test('a queued mention waits for its own session and leaves on ack', async (t) => {
  const { dir, queue } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))

  await queue.enqueue({ id: 'an-1', sessionId: 's-1', mention: '@[a](dsh-anno:an-1)', label: 'a' })
  await queue.enqueue({ id: 'an-2', sessionId: 's-2', mention: '@[b](dsh-anno:an-2)', label: 'b' })

  assert.deepEqual(
    queue.list('s-1').map((entry) => entry.id),
    ['an-1'],
  )
  assert.deepEqual(
    queue.list('s-2').map((entry) => entry.id),
    ['an-2'],
  )
  assert.deepEqual(queue.list('s-3'), [])

  assert.equal(await queue.ack(['an-1']), 1)
  assert.deepEqual(queue.list('s-1'), [])
  assert.equal((await queue.ack(['an-1'])).valueOf(), 0)
})

test('the queue survives a reload, and a replay replaces instead of piling up', async (t) => {
  const { dir, queue } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))

  await queue.enqueue({ id: 'an-1', sessionId: 's-1', mention: '@[a](dsh-anno:an-1)', label: 'a' })
  await queue.enqueue({ id: 'an-1', sessionId: 's-1', mention: '@[b](dsh-anno:an-1)', label: 'b' })
  await queue.flush()

  const reloaded = createMentionQueue({ dir })
  assert.equal(await reloaded.load(), 1)
  assert.equal(reloaded.list('s-1')[0].label, 'b')
  assert.equal(queue.all().length, 1)
})

test('an unusable entry is dropped on load, not repaired into a wrong delivery', async (t) => {
  const { dir } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(
    join(dir, 'pending-mentions.json'),
    JSON.stringify([
      { id: 'an-1', sessionId: 's-1', mention: '@[a](dsh-anno:an-1)', label: 'a', createdAt: 1 },
      { id: 'an-2', sessionId: '', mention: '@[b](dsh-anno:an-2)', label: 'b', createdAt: 2 },
      { nope: true },
    ]),
    'utf8',
  )

  const queue = createMentionQueue({ dir })
  assert.equal(await queue.load(), 1)
  assert.deepEqual(
    queue.all().map((entry) => entry.id),
    ['an-1'],
  )
})

test('prune drops entries whose annotation no longer exists', async (t) => {
  const { dir, queue } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))

  await queue.enqueue({ id: 'an-1', sessionId: 's-1', mention: '@[a](dsh-anno:an-1)' })
  await queue.enqueue({ id: 'an-2', sessionId: 's-1', mention: '@[b](dsh-anno:an-2)' })

  assert.equal(await queue.prune((id) => id === 'an-1'), 1)
  assert.deepEqual(
    queue.all().map((entry) => entry.id),
    ['an-1'],
  )
  const onDisk = JSON.parse(await readFile(join(dir, 'pending-mentions.json'), 'utf8'))
  assert.equal(onDisk.length, 1)
})

test('a failed save rejects its caller and the next save still reaches disk', async (t) => {
  const { dir, queue } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))

  // A directory where the temp file should be makes the write fail once.
  await mkdir(join(dir, 'pending-mentions.json.tmp'))
  await assert.rejects(queue.enqueue({ id: 'an-1', sessionId: 's-1', mention: '@[a](dsh-anno:an-1)' }))

  await rm(join(dir, 'pending-mentions.json.tmp'), { recursive: true })
  await queue.enqueue({ id: 'an-2', sessionId: 's-1', mention: '@[b](dsh-anno:an-2)' })
  // The failed first entry is still queued in memory, so the recovered write
  // persists both: a poisoned chain would have written neither.
  const onDisk = JSON.parse(await readFile(join(dir, 'pending-mentions.json'), 'utf8'))
  assert.deepEqual(
    onDisk.map((entry) => entry.id),
    ['an-1', 'an-2'],
  )
})

/** Capture both registered handlers. */
function mount(queue) {
  /** @type {Record<string, Function>} */
  const handlers = {}
  const webServer = {
    register: (route) => {
      handlers[route.path] = route.handler
      return () => {}
    },
  }
  const dispose = registerQueueRoutes(webServer, { queue })
  assert.deepEqual(Object.keys(handlers).sort(), [QUEUE_ACK_PATH, QUEUE_PATH].sort())
  return { dispose, read: handlers[QUEUE_PATH], ack: handlers[QUEUE_ACK_PATH] }
}

/** @param {Function} handler @param {string} url @param {{ method?: string, headers?: object, body?: string }} [init] */
function call(handler, url, init = {}) {
  return new Promise((resolve) => {
    let status = 0
    const request = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers ?? {},
      on: (event, listener) => {
        if (event === 'data' && init.body !== undefined) listener(Buffer.from(init.body))
        if (event === 'end') listener()
        return request
      },
      destroy: () => {},
    }
    const response = {
      writeHead: (code) => {
        status = code
      },
      end: (body) => resolve({ status, body: body === undefined ? undefined : JSON.parse(body) }),
    }
    handler(request, response)
  })
}

test('the queue route serves one session and refuses anything but the page', async (t) => {
  const { dir, queue } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await queue.enqueue({ id: 'an-1', sessionId: 's-1', mention: '@[a](dsh-anno:an-1)', label: 'a' })
  const { read } = mount(queue)
  const page = { 'sec-fetch-site': 'same-origin' }

  const served = await call(read, `${QUEUE_PATH}?session=s-1`, { headers: page })
  assert.equal(served.status, 200)
  assert.deepEqual(
    served.body.items.map((item) => item.id),
    ['an-1'],
  )

  assert.equal((await call(read, `${QUEUE_PATH}?session=s-1`)).status, 403)
  assert.equal(
    (await call(read, `${QUEUE_PATH}?session=s-1`, { headers: { 'sec-fetch-site': 'cross-site' } })).status,
    403,
  )
  assert.equal((await call(read, QUEUE_PATH, { headers: page })).status, 400)
  assert.equal((await call(read, `${QUEUE_PATH}?session=s-1`, { headers: page, method: 'POST' })).status, 405)
})

test('acknowledging removes exactly the delivered entries', async (t) => {
  const { dir, queue } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))
  await queue.enqueue({ id: 'an-1', sessionId: 's-1', mention: '@[a](dsh-anno:an-1)' })
  await queue.enqueue({ id: 'an-2', sessionId: 's-1', mention: '@[b](dsh-anno:an-2)' })
  const { ack } = mount(queue)
  const page = { 'sec-fetch-site': 'same-origin' }

  const done = await call(ack, QUEUE_ACK_PATH, {
    method: 'POST',
    headers: page,
    body: JSON.stringify({ ids: ['an-1'] }),
  })
  assert.equal(done.status, 200)
  assert.equal(done.body.removed, 1)
  assert.deepEqual(
    queue.all().map((entry) => entry.id),
    ['an-2'],
  )

  assert.equal((await call(ack, QUEUE_ACK_PATH, { method: 'POST', headers: page, body: '{}' })).status, 400)
  assert.equal((await call(ack, QUEUE_ACK_PATH, { method: 'POST', headers: page, body: 'not json' })).status, 400)
  assert.equal((await call(ack, QUEUE_ACK_PATH, { method: 'POST', body: '{"ids":["an-2"]}' })).status, 403)
})
