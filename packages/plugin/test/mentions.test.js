import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAnnotationMentions } from '../src/mentions.js'
import { formatAnnoMention } from '../src/protocol.js'

/** @param {string} id */
function record(id) {
  return {
    id,
    state: 'open',
    url: 'https://example.com/pricing',
    title: 'Pricing',
    anchor: {
      kind: 'selection',
      quote: { exact: 'Enterprise' },
      rect: { x: 10, y: 20, w: 100, h: 24 },
    },
    comment: '这个价格和文档不一致',
    crops: {},
    createdAt: '2026-11-18T12:00:00.000Z',
  }
}

/** @param {Record<string, any>} records @param {Record<string, any>} [images] */
function store(records, images = {}) {
  return {
    get: (id) => records[id],
    image: (id) => images[id],
  }
}

/** @param {string} text */
function userMessage(text) {
  return { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

test('a cited annotation adds one context message and leaves the text alone', async () => {
  const mention = formatAnnoMention({ id: 'an-1', label: '批注 · “Enterprise”' })
  const mentions = createAnnotationMentions({
    store: store({ 'an-1': record('an-1') }, { 'an-1': { id: 'attachment-1' } }),
  })
  const original = userMessage(`看这里 ${mention}`)
  const messages = await mentions.prepare([original])

  assert.equal(messages.length, 2)
  // The mention is the spelling the Client renders as a chip: pre-step output is
  // durable here, so rewriting it would delete the chip.
  assert.equal(messages[0], original)
  assert.equal(messages[0].content[0].text, `看这里 ${mention}`)

  const context = messages[1]
  assert.equal(context.role, 'user')
  assert.equal(context.source.kind, 'annotations')
  assert.deepEqual(context.source.ids, ['an-1'])
  assert.match(context.content[0].text, /^## Browser annotations/)
  assert.match(context.content[0].text, /annotation an-1 \[open\] selection "Enterprise"/)
  assert.match(context.content[0].text, /这个价格和文档不一致/)
  assert.deepEqual(context.content[1], { type: 'image', attachment: { id: 'attachment-1' } })
})

test('messages without mentions pass through by identity', async () => {
  const mentions = createAnnotationMentions({ store: store({}) })
  const message = userMessage('just talking about @[x](dsh-session:abc)')
  assert.deepEqual(await mentions.prepare([message]), [message])
  assert.deepEqual(await mentions.prepare([{ id: 'a', role: 'assistant', content: [] }]), [
    { id: 'a', role: 'assistant', content: [] },
  ])
})

test('a message that loses its annotation still gets an answer, not an error', async () => {
  const mentions = createAnnotationMentions({ store: store({}) })
  const messages = await mentions.prepare([userMessage(formatAnnoMention({ id: 'an-gone', label: 'x' }))])

  assert.equal(messages.length, 2)
  assert.match(messages[1].content[0].text, /annotation an-gone \[missing\] x/)
  assert.match(messages[1].content[0].text, /no longer exists/)
  assert.equal(messages[1].content.length, 1)
})

test('one id cited twice is described once', async () => {
  const mention = formatAnnoMention({ id: 'an-1', label: 'a' })
  const mentions = createAnnotationMentions({ store: store({ 'an-1': record('an-1') }) })
  const messages = await mentions.prepare([userMessage(`${mention} and again ${mention}`)])

  assert.deepEqual(messages[1].source.ids, ['an-1'])
  assert.equal(messages[1].content[0].text.split('annotation an-1').length - 1, 1)
})
