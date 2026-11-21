/**
 * The focus report: what the GUI says it is showing, and how long that claim
 * stays believable.
 *
 * The interesting cases are all failures — a report that is too old, one that
 * names nothing, a store that was never loaded — because the routing it feeds
 * must degrade to "the most recently active Session", never to a wrong guess.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { FOCUS_TTL_MS, createFocusStore, focusedSession, registerFocusRoute } from '../src/focus.js'
import { FOCUS_PATH } from '../src/protocol.js'

/** @returns {Promise<{ dir: string, store: ReturnType<typeof createFocusStore> }>} */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-anno-focus-'))
  const store = createFocusStore({ dir })
  await store.load()
  return { dir, store }
}

test('a fresh report names the Session the Client is showing', async (t) => {
  const { dir, store } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))

  assert.equal(focusedSession(store), undefined)
  await store.set('session-a')
  assert.equal(focusedSession(store), 'session-a')
  assert.equal(store.get().sessionId, 'session-a')
})

test('a report older than its promise is discarded, not resurrected', async (t) => {
  const { dir, store } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))

  await store.set('session-a')
  const at = store.get().at
  assert.equal(focusedSession(store, at + FOCUS_TTL_MS - 1), 'session-a')
  assert.equal(focusedSession(store, at + FOCUS_TTL_MS + 1), undefined)
})

test('the report survives a reload, and a torn file reads as no report', async (t) => {
  const { dir, store } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))

  await store.set('session-a')
  const reloaded = createFocusStore({ dir })
  await reloaded.load()
  assert.equal(focusedSession(reloaded), 'session-a')
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'focus.json'), 'utf8')).sessionId, 'session-a')

  const torn = createFocusStore({ dir, file: 'missing.json' })
  await torn.load()
  assert.equal(focusedSession(torn), undefined)
})

test('a failed write rejects its caller and the next report still persists', async (t) => {
  const { dir, store } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))

  // A directory where the temp file should be makes the write fail once.
  await mkdir(join(dir, 'focus.json.tmp'))
  await assert.rejects(store.set('session-a'))

  await rm(join(dir, 'focus.json.tmp'), { recursive: true })
  await store.set('session-b')
  const onDisk = JSON.parse(await readFile(join(dir, 'focus.json'), 'utf8'))
  assert.equal(onDisk.sessionId, 'session-b')
})

test('the focus route accepts the page and refuses everything else', async (t) => {
  const { dir, store } = await fixture()
  t.after(() => rm(dir, { recursive: true, force: true }))

  /** @type {Function | undefined} */
  let handler
  const dispose = registerFocusRoute(
    {
      register: (route) => {
        assert.equal(route.path, FOCUS_PATH)
        handler = route.handler
        return () => {
          handler = undefined
        }
      },
    },
    { store },
  )
  assert.notEqual(handler, undefined)
  const page = { 'sec-fetch-site': 'same-origin' }

  assert.equal(
    (await call(handler, FOCUS_PATH, { headers: page, body: '{"sessionId":"session-b"}', method: 'POST' })).status,
    200,
  )
  assert.equal(focusedSession(store), 'session-b')

  const read = await call(handler, FOCUS_PATH, { headers: page })
  assert.equal(read.status, 200)
  assert.equal(read.body.sessionId, 'session-b')

  assert.equal((await call(handler, FOCUS_PATH, { body: '{"sessionId":"session-c"}', method: 'POST' })).status, 403)
  assert.equal(focusedSession(store), 'session-b')
  assert.equal((await call(handler, FOCUS_PATH, { headers: page, body: '{}', method: 'POST' })).status, 400)
  assert.equal((await call(handler, FOCUS_PATH, { headers: page, method: 'PUT' })).status, 405)

  dispose()
  assert.equal(handler, undefined)
})

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
