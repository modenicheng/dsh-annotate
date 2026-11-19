/**
 * Verify a running bridge from the command line, with no browser involved.
 *
 * Exists because the interesting half of this project cannot be unit-tested
 * against the real host: the token handshake, the attachment service, and the
 * frame exchange only exist inside a booted `dsh web`. Run it after installing
 * the bundle, and after any change to the protocol:
 *
 *   node scripts/smoke-ws.mjs [ws://127.0.0.1:3080/ext/anno]
 *   node scripts/smoke-ws.mjs [wss://anno.example.com/ext/anno]
 *
 * It checks that the health endpoint advertises the same scheme the client is
 * about to use, creates a real annotation (with a 1x1 PNG crop), queries it
 * back, resolves it, and replays it to prove idempotency. One of the records it
 * creates carries no comment, which must survive the round trip unchanged.
 * Every check prints a line; the exit code is non-zero when any check fails.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const url = process.argv[2] ?? 'ws://127.0.0.1:3080/ext/anno'
const tokenPath =
  process.env.DSH_ANNO_TOKEN_FILE ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'ext-bridge-token')

/** A 1x1 transparent PNG: enough to prove the attachment path end to end. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const checks = []
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  checks.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function annotationId() {
  const now = new Date()
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const tail = Math.random().toString(16).slice(2, 8).padEnd(6, '0')
  return `an-${stamp}-${tail}`
}

let token
try {
  token = (await readFile(tokenPath, 'utf8')).trim()
  check('bridge token readable', token.length === 64, tokenPath)
} catch (error) {
  check('bridge token readable', false, `${tokenPath}: ${error.message}`)
  process.exit(1)
}

// Ask the host which scheme it expects, exactly as the extension does. A
// mismatched answer here means the URL under test was assembled by hand.
const healthUrl = (() => {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
  parsed.pathname = '/ext/anno/health'
  parsed.search = ''
  return parsed.href
})()
let health
try {
  const response = await fetch(healthUrl, { cache: 'no-store' })
  health = response.ok ? await response.json() : undefined
  check('health endpoint reachable', response.ok === true, healthUrl)
} catch (error) {
  check('health endpoint reachable', false, `${healthUrl}: ${error.message}`)
}
if (health !== undefined) {
  const advertised = typeof health.wsUrl === 'string' ? health.wsUrl : ''
  check('health advertises a ws or wss URL', /^wss?:\/\//.test(advertised), advertised)
  check(
    'advertised scheme matches the URL under test',
    health.secure === url.startsWith('wss://'),
    `secure=${String(health.secure)} for ${url}`,
  )
}

const id = annotationId()
const record = {
  id,
  url: 'https://example.com/smoke?run=1',
  title: 'dsh-marker smoke test',
  anchor: {
    kind: 'selection',
    quote: { exact: 'smoke', prefix: 'a ', suffix: ' test' },
    domRange: { blockSelector: 'main p', startPath: '0', startOffset: 0, endPath: '0', endOffset: 5 },
    textPosition: { start: 0, end: 5 },
    rect: { x: 8, y: 16, w: 64, h: 20 },
  },
  comment: 'smoke test: this line exists to be resolved',
  intent: 'bug',
  crops: {},
  routing: { source: 'user' },
  state: 'open',
  createdAt: new Date().toISOString(),
}

const socket = new WebSocket(url)
/** @type {any[]} */
const frames = []
/** @type {((frame: any) => boolean)[]} */
const waiters = []

socket.addEventListener('message', (event) => {
  const frame = JSON.parse(event.data)
  frames.push(frame)
  for (const [index, waiter] of [...waiters.entries()].reverse()) {
    if (!waiter(frame)) continue
    waiters.splice(index, 1)
  }
})

/** @param {(frame: any) => boolean} predicate @param {number} [timeout] */
function waitFor(predicate, timeout = 5_000) {
  const already = frames.find(predicate)
  if (already !== undefined) return Promise.resolve(already)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), timeout)
    const waiter = (frame) => {
      if (!predicate(frame)) return false
      clearTimeout(timer)
      resolve(frame)
      return true
    }
    waiters.push(waiter)
  })
}

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true })
})
check('socket connected', true, url)

socket.send(JSON.stringify({ t: 'hello', token, version: 1, clientId: 'smoke-script' }))
const hello = await waitFor((frame) => frame.t === 'hello.ok').catch(() => undefined)
check('handshake accepted', hello !== undefined, hello === undefined ? 'no hello.ok' : `protocol ${hello.version}`)
if (hello === undefined) process.exit(1)

socket.send(
  JSON.stringify({ t: 'anno.create', reqId: 'create', record, targetImageB64: PNG, targetImageMime: 'image/png' }),
)
const acknowledged = await waitFor((frame) => frame.t === 'anno.ack' && frame.reqId === 'create').catch(() => undefined)
check(
  'annotation acknowledged',
  acknowledged !== undefined,
  acknowledged === undefined ? 'no ack' : `seq ${acknowledged.seq}`,
)

const created = await waitFor((frame) => frame.t === 'anno.event' && frame.type === 'created').catch(() => undefined)
check('created event broadcast', created !== undefined)

socket.send(JSON.stringify({ t: 'anno.query', reqId: 'query', url: 'https://example.com/smoke?run=2' }))
const queried = await waitFor((frame) => frame.t === 'anno.query.ok' && frame.reqId === 'query').catch(() => undefined)
const found = queried?.records?.find((item) => item.id === id)
check('query returns the record across a query-string change', found !== undefined)
check('host-only fields are stripped from the wire', found !== undefined && found.host === undefined)

socket.send(
  JSON.stringify({ t: 'anno.mutate', reqId: 'resolve', id, action: 'resolve', note: 'resolved by smoke script' }),
)
const resolved = await waitFor((frame) => frame.t === 'anno.ack' && frame.reqId === 'resolve').catch(() => undefined)
check('resolve acknowledged', resolved?.state === 'resolved', String(resolved?.state))

socket.send(JSON.stringify({ t: 'anno.create', reqId: 'replay', record }))
const replay = await waitFor((frame) => frame.t === 'anno.ack' && frame.reqId === 'replay').catch(() => undefined)
check('replayed id is idempotent', replay?.id === id && replay?.seq === resolved?.seq)

// An annotation with no comment is a first-class record (D10): the mark alone is
// the payload, so the host must store it rather than treat it as incomplete.
const bareId = annotationId()
const bare = { ...record, id: bareId, comment: '' }
socket.send(JSON.stringify({ t: 'anno.create', reqId: 'bare', record: bare }))
const bareAck = await waitFor((frame) => frame.t === 'anno.ack' && frame.reqId === 'bare').catch(() => undefined)
check('comment-less annotation acknowledged', bareAck?.id === bareId, String(bareAck?.id))

socket.send(JSON.stringify({ t: 'anno.query', reqId: 'bare-query', url: 'https://example.com/smoke' }))
const bareQuery = await waitFor((frame) => frame.t === 'anno.query.ok' && frame.reqId === 'bare-query').catch(
  () => undefined,
)
const bareRecord = bareQuery?.records?.find((item) => item.id === bareId)
check(
  'comment-less annotation round-trips as an empty comment',
  bareRecord?.comment === '',
  String(bareRecord?.comment),
)

socket.send(JSON.stringify({ t: 'anno.mutate', reqId: 'bare-resolve', id: bareId, action: 'resolve' }))
const bareResolved = await waitFor((frame) => frame.t === 'anno.ack' && frame.reqId === 'bare-resolve').catch(
  () => undefined,
)
check(
  'comment-less annotation resolves like any other',
  bareResolved?.state === 'resolved',
  String(bareResolved?.state),
)

socket.close()
const failed = checks.filter((item) => !item.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
