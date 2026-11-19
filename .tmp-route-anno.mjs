/** Throwaway: create one annotation routed to a Session. Deleted after use. */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { formatAnnoMention, newAnnotationId } from './packages/plugin/src/protocol.js'

const url = process.argv[2] ?? 'ws://127.0.0.1:3097/ext/anno'
const sessionId = process.argv[3]
const token = (await readFile(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'ext-bridge-token'), 'utf8')).trim()
const id = newAnnotationId()
const label = '批注 · “Enterprise”'
const record = {
  id,
  url: 'https://example.com/pricing',
  title: 'Pricing — example',
  anchor: {
    kind: 'selection',
    quote: { exact: 'Enterprise', prefix: 'Plan: ', suffix: ' tier' },
    domRange: { blockSelector: 'main h2', startPath: '0', startOffset: 0, endPath: '0', endOffset: 10 },
    textPosition: { start: 120, end: 130 },
    rect: { x: 10, y: 20, w: 100, h: 24 },
  },
  comment: '路由到指定会话的批注',
  intent: 'bug',
  crops: {},
  routing: { source: 'user', sessionId, label },
  state: 'open',
  createdAt: new Date().toISOString(),
}

const socket = new WebSocket(url)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true })
})
socket.send(JSON.stringify({ t: 'hello', token, version: 1, clientId: 'queue-probe' }))
await new Promise((resolve) => {
  socket.addEventListener('message', (event) => {
    if (JSON.parse(event.data).t === 'hello.ok') resolve()
  })
})
socket.send(JSON.stringify({ t: 'anno.create', reqId: 'create', record }))
const ack = await new Promise((resolve) => {
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data)
    if (frame.t === 'anno.ack' && frame.reqId === 'create') resolve(frame)
  })
})
socket.close()
console.log(JSON.stringify({ id, ack, mention: formatAnnoMention({ id, label }) }, null, 2))
