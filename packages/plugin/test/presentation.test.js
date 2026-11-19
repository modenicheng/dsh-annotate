/**
 * The presentation projection and the two routes that carry it to the chip's
 * hover card.
 *
 * The projection is where a record becomes something a person reads, so the
 * cases that matter are the shapes of the three anchors and the promise that
 * nothing is recomputed: whatever the record holds at click time is what the
 * card shows, and a missing crop degrades to text rather than an empty frame.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeAnnotation, registerPresentationRoutes } from '../src/presentation.js'
import { IMAGE_PATH, ITEM_PATH } from '../src/protocol.js'

/** One stored record, in the shape the extension and the Host agree on. */
function record(overrides = {}) {
  return {
    id: 'an-20261119-abcdef',
    url: 'http://127.0.0.1:3099/?token=x',
    title: 'Greeting — DeepSeek Harness',
    state: 'open',
    intent: 'bug',
    comment: '这条批注要说明白',
    createdAt: '2026-11-19T11:51:07.943Z',
    updatedAt: '2026-11-19T11:51:08.018Z',
    anchor: {
      kind: 'element',
      selectors: { cssPath: '#root > div:nth-of-type(1) > div' },
      fingerprint: {
        tag: 'div',
        textExcerpt: '我看到了你引用的批注',
        outerHtmlPreview: '<div class="markdown">…</div>',
      },
      diagnostics: {
        computedStyles: { display: 'block', color: 'rgb(249, 250, 251)' },
        a11yRole: 'button',
        a11yName: '发送',
      },
      rect: { x: 695, y: 691.2, w: 920, h: 336.8 },
    },
    snapshot: {
      at: '2026-11-19T11:51:07.943Z',
      rect: { x: 556, y: 553, w: 920, h: 337 },
      viewport: { width: 2032, height: 1216, dpr: 1.25, scrollX: 0, scrollY: 0 },
    },
    host: { image: { attachmentId: 'sha256:1fe2', mediaType: 'image/png', width: 1150, height: 421, bytes: 58157 } },
    ...overrides,
  }
}

test('an element annotation reads as tag, text, and role', () => {
  const item = describeAnnotation(record())
  assert.equal(item.kind, 'element')
  assert.equal(item.state, 'open')
  assert.equal(item.intent, 'bug')
  assert.equal(item.comment, '这条批注要说明白')
  assert.equal(item.anchor.tag, 'div')
  assert.equal(item.anchor.text, '我看到了你引用的批注')
  assert.equal(item.anchor.role, 'button')
  assert.equal(item.anchor.name, '发送')
  assert.equal(item.anchor.styles.display, 'block')
  assert.equal(item.anchor.html, '<div class="markdown">…</div>')
  assert.deepEqual(item.anchor.rect, { x: 695, y: 691.2, w: 920, h: 336.8 })
})

test('the crop is addressed by id, and its size travels with it', () => {
  const item = describeAnnotation(record())
  assert.equal(item.image.href, `${IMAGE_PATH}?id=an-20261119-abcdef`)
  assert.equal(item.image.width, 1150)
  assert.equal(item.image.height, 421)
  assert.equal(item.image.bytes, 58157)
})

test('an annotation without a crop still describes itself', () => {
  const item = describeAnnotation(record({ host: undefined }))
  assert.equal(item.image, undefined)
  assert.equal(item.anchor.tag, 'div')
})

test('the snapshot is carried through untouched, so the card can date the click', () => {
  const item = describeAnnotation(record())
  assert.equal(item.snapshot.at, '2026-11-19T11:51:07.943Z')
  assert.deepEqual(item.snapshot.rect, { x: 556, y: 553, w: 920, h: 337 })
  assert.equal(item.snapshot.viewport.dpr, 1.25)
  assert.equal(describeAnnotation(record({ snapshot: undefined })).snapshot, undefined)
})

test('a selection shows the quote, a region shows the box', () => {
  const selection = describeAnnotation(
    record({
      anchor: {
        kind: 'selection',
        quote: { exact: 'hover card probe', prefix: '', suffix: '' },
        rect: { x: 1, y: 2, w: 3, h: 4 },
      },
    }),
  )
  assert.equal(selection.anchor.kind, 'selection')
  assert.equal(selection.anchor.quote, 'hover card probe')

  const region = describeAnnotation(record({ anchor: { kind: 'region', pageRect: { x: 10, y: 20, w: 300, h: 120 } } }))
  assert.equal(region.anchor.kind, 'region')
  assert.deepEqual(region.anchor.rect, { x: 10, y: 20, w: 300, h: 120 })
  assert.match(region.summary, /region 300x120/u)
})

test('long fields are bounded, because a card is a glance', () => {
  const item = describeAnnotation(record({ comment: 'x'.repeat(5_000) }))
  assert.ok(item.comment.length <= 1_200)
})

test('the item route serves one record to the page and refuses anything else', async () => {
  const { handler } = mount({
    store: { get: (id) => (id === 'an-20261119-abcdef' ? record() : undefined), image: () => undefined },
  })
  const page = { 'sec-fetch-site': 'same-origin' }

  const served = await call(handler(ITEM_PATH), `${ITEM_PATH}?id=an-20261119-abcdef`, { headers: page })
  assert.equal(served.status, 200)
  assert.equal(served.body.item.id, 'an-20261119-abcdef')

  assert.equal((await call(handler(ITEM_PATH), `${ITEM_PATH}?id=an-20261119-abcdef`)).status, 403)
  assert.equal((await call(handler(ITEM_PATH), `${ITEM_PATH}?id=an-other`, { headers: page })).status, 404)
  assert.equal((await call(handler(ITEM_PATH), ITEM_PATH, { headers: page })).status, 404)
  assert.equal(
    (await call(handler(ITEM_PATH), `${ITEM_PATH}?id=an-20261119-abcdef`, { headers: page, method: 'POST' })).status,
    405,
  )
})

test('the image route streams the stored bytes, and reports what it cannot read', async () => {
  /** @type {any[]} */
  const asked = []
  const readImage = async (ref) => {
    asked.push(ref)
    if (ref.attachmentId === 'sha256:broken') throw new Error('gone')
    return { data: Buffer.from('png-bytes'), ref }
  }
  const { handler } = mount({
    store: {
      get: (id) => {
        if (id === 'an-broken') return record({ id: 'an-broken', host: { image: { attachmentId: 'sha256:broken' } } })
        return id === 'an-20261119-abcdef' ? record() : undefined
      },
      image: () => undefined,
    },
    readImage,
  })
  const page = { 'sec-fetch-site': 'same-origin' }

  const served = await call(handler(IMAGE_PATH), `${IMAGE_PATH}?id=an-20261119-abcdef`, { headers: page })
  assert.equal(served.status, 200)
  assert.equal(served.contentType, 'image/png')
  assert.deepEqual(
    asked.map((ref) => ref.attachmentId),
    ['sha256:1fe2'],
  )

  assert.equal((await call(handler(IMAGE_PATH), `${IMAGE_PATH}?id=an-broken`, { headers: page })).status, 404)
  assert.equal((await call(handler(IMAGE_PATH), `${IMAGE_PATH}?id=an-other`, { headers: page })).status, 404)
  assert.equal((await call(handler(IMAGE_PATH), `${IMAGE_PATH}?id=an-20261119-abcdef`)).status, 403)
})

/** Capture both registered handlers. */
function mount({ store, readImage }) {
  /** @type {Record<string, Function>} */
  const handlers = {}
  const dispose = registerPresentationRoutes(
    {
      register: (route) => {
        handlers[route.path] = route.handler
        return () => {}
      },
    },
    { store, readImage },
  )
  assert.deepEqual(Object.keys(handlers).sort(), [IMAGE_PATH, ITEM_PATH].sort())
  return {
    dispose,
    handler: (path) => handlers[path],
  }
}

/** @param {Function} handler @param {string} url @param {{ method?: string, headers?: object }} [init] */
function call(handler, url, init = {}) {
  return new Promise((resolve) => {
    let status = 0
    let contentType = ''
    const request = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers ?? {},
      on: () => request,
      destroy: () => {},
    }
    const response = {
      writeHead: (code, headers) => {
        status = code
        contentType = headers?.['content-type'] ?? ''
      },
      end: (body) => resolve({ status, contentType, body: parse(body) }),
    }
    handler(request, response)
  })
}

/** @param {any} body */
function parse(body) {
  if (body === undefined) return undefined
  try {
    return JSON.parse(body.toString())
  } catch {
    return body.toString()
  }
}
