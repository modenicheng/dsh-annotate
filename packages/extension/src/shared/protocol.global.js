// GENERATED FILE — do not edit. Source: packages/protocol/src/index.js
// Regenerate with: pnpm run sync-protocol
(function () {
'use strict'
/**
 * `@dsh-marker/protocol` — the single source of truth for the wire format
 * shared by the DSH host plugin and the Firefox/Zen extension.
 *
 * Deliberately one dependency-free file: `scripts/sync-protocol.mjs` copies it
 * verbatim into the plugin and the extension, so nothing has to bundle, build,
 * or resolve a workspace package at runtime.
 */

// ── constants ───────────────────────────────────────────────────────────────

/** Bumped whenever a frame or record shape changes incompatibly. */
const PROTOCOL_VERSION = 1

/** Exact websocket path registered on the DSH host webserver. */
const WS_PATH = '/ext/anno'

/** Health/discovery endpoint served next to the socket. */
const HEALTH_PATH = '/ext/anno/health'

/**
 * Flat, newest-first Session catalog backing the overlay's target picker.
 *
 * The picker answers "which conversation does this annotation belong to?", so
 * the list is ordered by activity and never grouped by workspace.
 */
const SESSIONS_PATH = '/ext/anno/sessions'

/**
 * Durable hand-off from the extension to the Web Client: mentions waiting to be
 * appended to one Session's composer. Same-origin only — the GUI is the page
 * this Host serves, and it never sees the extension's bridge token.
 */
const QUEUE_PATH = '/ext/anno/queue'

/** Acknowledged queue entries are removed here; POST `{ids}`. */
const QUEUE_ACK_PATH = '/ext/anno/queue/ack'

/**
 * The page's push channel: one server-sent event stream per Web Client, telling
 * a mounted Session that something it may own just changed. Same-origin only.
 *
 * It carries a *nudge*, never the data — the queue above stays the authority,
 * so a missed event costs a slower delivery rather than a lost one.
 */
const EVENTS_PATH = '/ext/anno/events'

/**
 * The Session the Web Client is showing, reported by that Client so the Host
 * can answer "where does an annotation go by default?". Same-origin only, for
 * the same reason the queue is: the GUI is this Host's own page.
 */
const FOCUS_PATH = '/ext/anno/focus'

/**
 * One annotation read back for display, by id — the Web Client's chip hover
 * card. Same-origin only; a cross-site page has no business reading what the
 * user marked.
 */
const ITEM_PATH = '/ext/anno/item'

/** The screenshot that belongs to one annotation; `?id=` names it. Same-origin only. */
const IMAGE_PATH = '/ext/anno/image'

/** Bridge token file name, relative to `$DSH_HOME`. */
const TOKEN_FILE = 'ext-bridge-token'

// ── discovery ───────────────────────────────────────────────────────────────
//
// A host whose port the launcher chose (`--port 0`, DSH Desktop) has to say
// where it is. Two addresses-only artifacts do that, and neither may ever
// carry the token: the token answers "whether", these answer "where".

/**
 * The name a host publishes so a client can tell a DSH bridge from whatever
 * else happens to answer on the same port.
 */
const DISCOVERY_APP = 'dsh-marker'

/**
 * Where a host publishes its current origin on a fixed loopback port. `GET`
 * only and anonymous by design: it returns an address, never the token.
 */
const LOCATE_PATH = '/ext/anno/locate'

/**
 * Locator ports, tried in order. They sit above the default webserver port and
 * below every OS ephemeral range, so the OS is unlikely to hand one out; three
 * of them survive one being taken by an unrelated process or a second host.
 */
const LOCATE_PORTS = [30810, 30811, 30812]

/** The locator binds IPv4 loopback only, never the host's configured address. */
const LOCATE_HOST = '127.0.0.1'

/**
 * Endpoint record: the address a host last bound to, written on every start so
 * a human, a script, or a popup file import can read it. Address only — the
 * token has exactly one home, {@link TOKEN_FILE}.
 */
const ENDPOINT_FILE = 'ext-bridge-endpoint.json'

/** A per-process host id, 16 lowercase hex characters. */
const INSTANCE_ID = /^[0-9a-f]{16}$/

/**
 * Whether a value could be a host's `instanceId`.
 *
 * It ties a locator answer to the health answer for the same host, so a stale
 * answer — or a different process reusing an origin — is dropped rather than
 * connected to.
 * @param {unknown} value
 */
function isInstanceId(value) {
  return typeof value === 'string' && INSTANCE_ID.test(value)
}

/** The extension must say hello within this window or the socket is closed. */
const HELLO_TIMEOUT_MS = 5_000

/** Server-side ping cadence; the client answers with `pong`. */
const PING_INTERVAL_MS = 25_000

/** Default budget for an agent-initiated pick. */
const PICK_TIMEOUT_MS = 120_000

/** Movement below this many CSS pixels still counts as a click, not a drag. */
const MAX_CLICK_MOVEMENT_PX = 6

/** Anchor modalities, in the order the UI cycles through them. */
const ANCHOR_KINDS = ['selection', 'element', 'region']

/** Annotation lifecycle states. */
const STATES = ['open', 'resolved', 'wont_fix']

/** Who produced the annotation. */
const SOURCES = ['user', 'agent']

/** Optional intent tags offered by the composer. */
const INTENTS = ['bug', 'change', 'question', 'reference']

/** Upper bounds enforced on both sides. */
const LIMITS = {
  commentChars: 20_000,
  noteChars: 8_000,
  urlChars: 8_192,
  titleChars: 1_024,
  selectorChars: 4_096,
  excerptChars: 2_000,
  outerHtmlChars: 4_096,
  quoteChars: 4_000,
  imageBase64Chars: 32 * 1024 * 1024,
  listLimit: 200,
  sessionsLimit: 100,
  /** Chip label carried by a routed mention; presentation only, never identity. */
  labelChars: 200,
}

/** Every frame a client may send to the host. */
const CLIENT_FRAMES = ['hello', 'ping', 'anno.create', 'anno.query', 'anno.mutate', 'pick.result']

/** Every frame the host may send to a client. */
const SERVER_FRAMES = [
  'hello.ok',
  'pong',
  'anno.ack',
  'anno.query.ok',
  'anno.event',
  'pick.request',
  'pick.cancel',
  'error',
]

// ── model ───────────────────────────────────────────────────────────────────

const ID_PATTERN = /^an-\d{8}-[0-9a-f]{6}$/
const HEX = '0123456789abcdef'

/** @param {number} n */
function pad(n) {
  return String(n).padStart(2, '0')
}

/**
 * Allocate an annotation id: `an-<yyyymmdd>-<6 hex>`.
 * @param {Date} [now]
 * @param {(max: number) => number} [random] injected for deterministic tests
 */
function newAnnotationId(now = new Date(), random = Math.random) {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  let tail = ''
  for (let index = 0; index < 6; index += 1) tail += HEX[Math.floor(random() * 16) % 16]
  return `an-${stamp}-${tail}`
}

/** Allocate a pick id (`pk-<6 hex>`). */
function newPickId(random = Math.random) {
  let tail = ''
  for (let index = 0; index < 6; index += 1) tail += HEX[Math.floor(random() * 16) % 16]
  return `pk-${tail}`
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value */
function isRect(value) {
  if (!isPlainObject(value)) return false
  return ['x', 'y', 'w', 'h'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
}

/** @param {unknown} value */
function isString(value) {
  return typeof value === 'string'
}

/**
 * Validate one anchor and return human-readable violations.
 * @param {unknown} anchor
 * @param {string} [path]
 * @returns {string[]}
 */
function validateAnchor(anchor, path = 'anchor') {
  /** @type {string[]} */
  const errors = []
  if (!isPlainObject(anchor)) return [`${path} must be an object`]
  if (!ANCHOR_KINDS.includes(anchor.kind)) {
    return [`${path}.kind must be one of ${ANCHOR_KINDS.join('|')}`]
  }
  if (anchor.kind !== 'region' && !isRect(anchor.rect)) {
    errors.push(`${path}.rect must be {x,y,w,h} numbers`)
  }
  if (anchor.kind === 'selection') {
    const quote = anchor.quote
    if (!isPlainObject(quote)) errors.push(`${path}.quote must be an object`)
    else {
      if (!isString(quote.exact) || quote.exact.length === 0)
        errors.push(`${path}.quote.exact must be a non-empty string`)
      if (!isString(quote.prefix)) errors.push(`${path}.quote.prefix must be a string`)
      if (!isString(quote.suffix)) errors.push(`${path}.quote.suffix must be a string`)
    }
  } else if (anchor.kind === 'element') {
    const selectors = anchor.selectors
    if (!isPlainObject(selectors)) errors.push(`${path}.selectors must be an object`)
    else if (!isString(selectors.cssPath) && !isString(selectors.xpath) && !isString(selectors.stable)) {
      errors.push(`${path}.selectors needs at least one of stable|cssPath|xpath`)
    }
    if (!isPlainObject(anchor.fingerprint)) errors.push(`${path}.fingerprint must be an object`)
  } else {
    if (!isRect(anchor.pageRect)) errors.push(`${path}.pageRect must be {x,y,w,h} numbers`)
    if (!isRect(anchor.viewportRect)) errors.push(`${path}.viewportRect must be {x,y,w,h} numbers`)
    if (anchor.intersectingElements !== undefined && !Array.isArray(anchor.intersectingElements)) {
      errors.push(`${path}.intersectingElements must be an array when present`)
    }
  }
  return errors
}

/**
 * Validate the click-time snapshot: what the page looked like at the instant
 * the user marked it, which is the only thing a later reader may rely on.
 * @param {unknown} snapshot
 * @param {string} [path]
 * @returns {string[]}
 */
function validateSnapshot(snapshot, path = 'snapshot') {
  if (!isPlainObject(snapshot)) return [`${path} must be an object`]
  const errors = []
  if (!isString(snapshot.at) || Number.isNaN(Date.parse(snapshot.at))) {
    errors.push(`${path}.at must be an ISO timestamp`)
  }
  if (!isRect(snapshot.rect)) errors.push(`${path}.rect must be {x,y,w,h} numbers`)
  const viewport = snapshot.viewport
  if (!isPlainObject(viewport)) errors.push(`${path}.viewport must be an object`)
  else {
    for (const key of ['width', 'height']) {
      if (typeof viewport[key] !== 'number' || !Number.isFinite(viewport[key])) {
        errors.push(`${path}.viewport.${key} must be a number`)
      }
    }
  }
  return errors
}

/**
 * Validate a whole record as it crosses the wire.
 * @param {unknown} record
 * @returns {string[]}
 */
function validateRecord(record) {
  /** @type {string[]} */
  const errors = []
  if (!isPlainObject(record)) return ['record must be an object']
  if (!isString(record.id) || !ID_PATTERN.test(record.id)) errors.push('record.id must match an-<yyyymmdd>-<6 hex>')
  if (!isString(record.url) || record.url.length === 0) errors.push('record.url must be a non-empty string')
  else if (record.url.length > LIMITS.urlChars) errors.push(`record.url exceeds ${LIMITS.urlChars} characters`)
  if (!isString(record.comment)) errors.push('record.comment must be a string')
  else if (record.comment.length > LIMITS.commentChars) {
    errors.push(`record.comment exceeds ${LIMITS.commentChars} characters`)
  }
  if (record.intent !== undefined && !INTENTS.includes(record.intent)) {
    errors.push(`record.intent must be one of ${INTENTS.join('|')}`)
  }
  if (!STATES.includes(record.state)) errors.push(`record.state must be one of ${STATES.join('|')}`)
  errors.push(...validateAnchor(record.anchor))
  if (record.snapshot !== undefined) errors.push(...validateSnapshot(record.snapshot))
  const routing = record.routing
  if (!isPlainObject(routing)) errors.push('record.routing must be an object')
  else if (!SOURCES.includes(routing.source)) errors.push(`record.routing.source must be one of ${SOURCES.join('|')}`)
  if (isPlainObject(routing) && routing.label !== undefined) {
    if (!isString(routing.label) || routing.label.length > LIMITS.labelChars) {
      errors.push(`record.routing.label must be a string of at most ${LIMITS.labelChars} characters`)
    }
  }
  if (!isString(record.createdAt) || Number.isNaN(Date.parse(record.createdAt))) {
    errors.push('record.createdAt must be an ISO timestamp')
  }
  return errors
}

/**
 * Fill the fields a client may omit. Never mutates the input.
 * @param {Record<string, any>} input
 * @param {{ now?: () => Date }} [clock]
 */
function normalizeRecord(input, clock = { now: () => new Date() }) {
  const now = (clock.now ?? (() => new Date()))().toISOString()
  const url = String(input.url ?? '')
  let origin = ''
  let pathname = ''
  try {
    const parsed = new URL(url)
    // Only http(s) documents carry a routable origin; opaque schemes
    // (`about:`, `file:`, `data:`) keep their raw URL and nothing else.
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      origin = parsed.origin
      pathname = parsed.pathname
    }
  } catch {
    // A restricted page has no parseable URL; the raw value still routes it.
  }
  const crops = isPlainObject(input.crops) ? input.crops : {}
  const routing = isPlainObject(input.routing) ? input.routing : {}
  const snapshot = normalizeSnapshot(input.snapshot)
  return {
    id: input.id,
    url,
    origin,
    pathname,
    title: String(input.title ?? '').slice(0, LIMITS.titleChars),
    anchor: input.anchor,
    comment: String(input.comment ?? '').slice(0, LIMITS.commentChars),
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(snapshot === undefined ? {} : { snapshot }),
    crops: {
      ...(isString(crops.target) ? { target: crops.target } : {}),
      ...(isString(crops.viewport) ? { viewport: crops.viewport } : {}),
    },
    ...(isPlainObject(input.pageContext) ? { pageContext: input.pageContext } : {}),
    routing: {
      source: SOURCES.includes(routing.source) ? routing.source : 'user',
      ...(isString(routing.sessionId) ? { sessionId: routing.sessionId } : {}),
      ...(isString(routing.workspaceHint) ? { workspaceHint: routing.workspaceHint } : {}),
      ...(isString(routing.label) ? { label: routing.label.slice(0, LIMITS.labelChars) } : {}),
    },
    state: STATES.includes(input.state) ? input.state : 'open',
    createdAt: isString(input.createdAt) ? input.createdAt : now,
    updatedAt: now,
  }
}

/**
 * Keep the click-time snapshot that arrived on the wire, minus anything the
 * reader could not render: it is a frozen fact, never recomputed, so a field it
 * does not carry cannot be filled in later.
 * @param {unknown} value
 */
function normalizeSnapshot(value) {
  if (!isPlainObject(value) || !isRect(value.rect)) return undefined
  if (!isString(value.at) || Number.isNaN(Date.parse(value.at))) return undefined
  const viewport = isPlainObject(value.viewport) ? value.viewport : {}
  const number = (key) => (typeof viewport[key] === 'number' && Number.isFinite(viewport[key]) ? viewport[key] : 0)
  const scrollX = number('scrollX')
  const scrollY = number('scrollY')
  return {
    at: value.at,
    rect: value.rect,
    viewport: {
      width: number('width'),
      height: number('height'),
      dpr: number('dpr'),
      scrollX,
      scrollY,
    },
  }
}

/** @param {string} text @param {number} max */
function truncate(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/**
 * Compact one-line preview used by `annotate_list` and the popup.
 * @param {Record<string, any>} record
 */
function describeAnchor(record) {
  const anchor = record.anchor
  if (!anchor || typeof anchor !== 'object') return 'unknown anchor'
  if (anchor.kind === 'selection') return `selection "${truncate(anchor.quote?.exact ?? '', 60)}"`
  if (anchor.kind === 'element') {
    const tag = anchor.fingerprint?.tag ?? 'element'
    const text = truncate(anchor.fingerprint?.textExcerpt ?? '', 40)
    return `element <${tag}>${text ? ` ${JSON.stringify(text)}` : ''}`
  }
  const page = anchor.pageRect ?? { x: 0, y: 0, w: 0, h: 0 }
  return `region ${Math.round(page.w)}x${Math.round(page.h)} at ${Math.round(page.x)},${Math.round(page.y)}`
}

// ── mentions ────────────────────────────────────────────────────────────────

/**
 * URI scheme of an annotation mention. The Web Client renders the Markdown
 * mention as one atomic chip, and the Host resolves it at `agent/pre-step`;
 * neither side ever trusts the label to carry identity.
 */
const ANNO_SCHEME = 'dsh-anno:'

/** Annotation ids are already URL-safe; anything else cannot be a mention. */
const ANNO_ID = /^[A-Za-z0-9_-]+$/

/** @param {string} label */
function escapeMentionLabel(label) {
  return String(label).replace(/[\\[\]]/gu, (match) => `\\${match}`)
}

/** @param {string} label */
function unescapeMentionLabel(label) {
  return label.replace(/\\(.)/gu, '$1')
}

/**
 * Render the canonical mention for one annotation.
 *
 * The label is presentation only: it is what the chip shows and what the model
 * reads in place of the token, so it may be localized and may repeat.
 * @param {{ id: string, label: string }} reference
 * @returns escaped `@[label](dsh-anno:id)` mention, or `''` for an unusable id.
 */
function formatAnnoMention(reference) {
  const id = String(reference && reference.id)
  if (!ANNO_ID.test(id)) return ''
  const label = escapeMentionLabel(reference.label == null ? id : reference.label)
  return `@[${label}](${ANNO_SCHEME}${id})`
}

/**
 * Extract annotation mentions from one text value.
 *
 * Malformed mentions are left exactly as written: a user discussing the syntax
 * must not lose their text, and a broken token is not a reference. Bare URIs
 * are recognized too, because pasted text drops the Markdown brackets.
 * @param {string} text
 * @returns {{ text: string, references: { id: string, label: string }[] }} readable
 * text with `@label` in place of each token, plus the references in appearance order.
 */
function parseAnnoText(text) {
  const references = []
  const source = String(text ?? '')
  const pattern = /@\[((?:\\.|[^\\\]\n])*)\]\((dsh-anno:([A-Za-z0-9_-]+))\)|(?<![(\w])(dsh-anno:([A-Za-z0-9_-]+))/gu
  const rendered = source.replace(pattern, (match, rawLabel, _markdownUri, markdownId, _bareUri, bareId) => {
    const id = markdownId ?? bareId
    /* istanbul ignore next -- the two-alternative regex always captures exactly one id. */
    if (id === undefined) return match
    const label = rawLabel === undefined ? id : unescapeMentionLabel(rawLabel)
    references.push({ id, label })
    return `@${label}`
  })
  return { text: rendered, references }
}

// ── frames ──────────────────────────────────────────────────────────────────

/** @param {unknown} value @param {number} [max] */
function optionalString(value, max = 200) {
  if (value === undefined) return true
  return typeof value === 'string' && value.length <= max
}

/** @param {unknown} value */
function optionalBase64(value) {
  if (value === undefined) return true
  return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.imageBase64Chars
}

/**
 * Parse text (or an already-decoded value) into a client frame.
 * @param {string | Uint8Array | unknown} raw
 * @returns {{ ok: true, frame: Record<string, any> } | { ok: false, reason: string }}
 */
function parseClientFrame(raw) {
  let value = raw
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    if (text.length > LIMITS.imageBase64Chars * 2) return { ok: false, reason: 'frame exceeds the size budget' }
    try {
      value = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'frame is not valid JSON' }
    }
  }
  if (!isPlainObject(value)) return { ok: false, reason: 'frame must be a JSON object' }
  const type = value.t
  if (typeof type !== 'string' || !CLIENT_FRAMES.includes(type)) {
    return { ok: false, reason: `unknown client frame type ${JSON.stringify(type)}` }
  }
  if (!optionalString(value.reqId, 120)) return { ok: false, reason: 'reqId must be a short string' }

  switch (type) {
    case 'hello':
      if (typeof value.token !== 'string' || value.token.length === 0) {
        return { ok: false, reason: 'hello.token is required' }
      }
      if (typeof value.version !== 'number') return { ok: false, reason: 'hello.version must be a number' }
      return { ok: true, frame: value }
    case 'ping':
      return { ok: true, frame: value }
    case 'anno.create': {
      const errors = validateRecord(value.record)
      if (errors.length > 0) return { ok: false, reason: errors.join('; ') }
      if (!optionalBase64(value.targetImageB64))
        return { ok: false, reason: 'targetImageB64 is not a bounded base64 string' }
      if (!optionalBase64(value.viewportImageB64)) {
        return { ok: false, reason: 'viewportImageB64 is not a bounded base64 string' }
      }
      return { ok: true, frame: value }
    }
    case 'anno.query':
      if (!optionalString(value.url, LIMITS.urlChars)) return { ok: false, reason: 'url filter must be a string' }
      if (value.state !== undefined && value.state !== 'all' && !STATES.includes(value.state)) {
        return { ok: false, reason: `state must be one of ${STATES.join('|')}|all` }
      }
      return { ok: true, frame: value }
    case 'anno.mutate': {
      if (typeof value.id !== 'string') return { ok: false, reason: 'anno.mutate.id is required' }
      const actions = ['resolve', 'wont_fix', 'reopen', 'delete', 'edit']
      if (!actions.includes(value.action))
        return { ok: false, reason: `anno.mutate.action must be one of ${actions.join('|')}` }
      if (!optionalString(value.note, LIMITS.noteChars)) return { ok: false, reason: 'note must be a bounded string' }
      if (value.action === 'edit' && typeof value.comment !== 'string') {
        return { ok: false, reason: 'edit requires comment' }
      }
      return { ok: true, frame: value }
    }
    case 'pick.result': {
      if (typeof value.pickId !== 'string') return { ok: false, reason: 'pick.result.pickId is required' }
      if (typeof value.ok !== 'boolean') return { ok: false, reason: 'pick.result.ok must be a boolean' }
      if (value.ok) {
        const errors = validateRecord(value.record)
        if (errors.length > 0) return { ok: false, reason: errors.join('; ') }
      } else if (!optionalString(value.reason, 400)) {
        return { ok: false, reason: 'pick.result.reason must be a short string' }
      }
      return { ok: true, frame: value }
    }
    default:
      return { ok: false, reason: `unhandled client frame ${type}` }
  }
}

/**
 * Parse a host frame. The extension uses this to reject a compromised or
 * stale host instead of trusting whatever arrives on the socket.
 * @param {string | Uint8Array | unknown} raw
 * @returns {{ ok: true, frame: Record<string, any> } | { ok: false, reason: string }}
 */
function parseServerFrame(raw) {
  let value = raw
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    try {
      value = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'frame is not valid JSON' }
    }
  }
  if (!isPlainObject(value)) return { ok: false, reason: 'frame must be a JSON object' }
  if (typeof value.t !== 'string' || !SERVER_FRAMES.includes(value.t)) {
    return { ok: false, reason: `unknown server frame type ${JSON.stringify(value.t)}` }
  }
  return { ok: true, frame: value }
}

/** Encode a frame for the wire. */
function encodeFrame(frame) {
  return JSON.stringify(frame)
}

/**
 * Two URLs point at the same document when only query and hash differ.
 * @param {{ url?: string }} record
 * @param {string} url
 */
function sameDocument(record, url) {
  if (!record || typeof record.url !== 'string' || typeof url !== 'string') return false
  if (record.url === url) return true
  try {
    const left = new URL(record.url)
    const right = new URL(url)
    return left.origin === right.origin && left.pathname === right.pathname
  } catch {
    return false
  }
}

globalThis.__DSH_PROTOCOL__ = { PROTOCOL_VERSION, WS_PATH, HEALTH_PATH, SESSIONS_PATH, QUEUE_PATH, QUEUE_ACK_PATH, EVENTS_PATH, FOCUS_PATH, ITEM_PATH, IMAGE_PATH, TOKEN_FILE, DISCOVERY_APP, LOCATE_PATH, LOCATE_PORTS, LOCATE_HOST, ENDPOINT_FILE, isInstanceId, HELLO_TIMEOUT_MS, PING_INTERVAL_MS, PICK_TIMEOUT_MS, MAX_CLICK_MOVEMENT_PX, ANCHOR_KINDS, STATES, SOURCES, INTENTS, LIMITS, CLIENT_FRAMES, SERVER_FRAMES, newAnnotationId, newPickId, isPlainObject, isRect, validateAnchor, validateSnapshot, validateRecord, normalizeRecord, truncate, describeAnchor, ANNO_SCHEME, formatAnnoMention, parseAnnoText, parseClientFrame, parseServerFrame, encodeFrame, sameDocument }
})()
