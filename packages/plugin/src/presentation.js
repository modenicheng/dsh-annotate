/**
 * What one annotation looks like to a human.
 *
 * The overlay and the model already read annotations; the Web Client's chip
 * hover card is the third reader, and it needs less than the model does — no
 * selectors to re-find anything, no page text to reason about, just what the
 * user marked and the crop they saw. This module owns that projection so the
 * route stays a transport and the shapes stay testable without a webserver.
 *
 * Everything here is the click-time snapshot: the anchor and `snapshot` were
 * frozen when the user clicked, and nothing in this file re-reads a page.
 *
 * @module dsh-marker/presentation
 */

import { IMAGE_PATH, ITEM_PATH, describeAnchor, truncate } from './protocol.js'

/** A card is a glance; every string is bounded by what a card can show. */
const CARD = {
  urlChars: 300,
  quoteChars: 400,
  textChars: 240,
  commentChars: 1_200,
  selectorChars: 120,
  styleChars: 8,
}

/**
 * Project one record for display.
 *
 * @param {any} record stored annotation
 * @param {{ image?: any }} [options] the attachment reference the store holds
 * @returns {Record<string, any>}
 */
export function describeAnnotation(record, options = {}) {
  const anchor = record?.anchor ?? {}
  const image = options.image ?? record?.host?.image
  const snapshot = record?.snapshot
  return {
    id: String(record?.id ?? ''),
    kind: String(anchor.kind ?? 'unknown'),
    state: String(record?.state ?? 'open'),
    ...(typeof record?.intent === 'string' && record.intent !== '' ? { intent: record.intent } : {}),
    comment: truncate(String(record?.comment ?? ''), CARD.commentChars),
    createdAt: String(record?.createdAt ?? ''),
    updatedAt: String(record?.updatedAt ?? ''),
    url: truncate(String(record?.url ?? ''), CARD.urlChars),
    title: truncate(String(record?.title ?? ''), CARD.textChars),
    summary: describeAnchor(record ?? {}),
    anchor: describeAnchorDetail(anchor),
    ...(snapshot === undefined || snapshot === null ? {} : { snapshot: describeSnapshot(snapshot) }),
    ...(image === undefined || image === null
      ? {}
      : {
          image: {
            href: `${IMAGE_PATH}?id=${encodeURIComponent(String(record?.id ?? ''))}`,
            width: numberOr(image.width, 0),
            height: numberOr(image.height, 0),
            bytes: numberOr(image.bytes, 0),
            mediaType: typeof image.mediaType === 'string' ? image.mediaType : 'image/png',
          },
        }),
  }
}

/** @param {any} anchor */
function describeAnchorDetail(anchor) {
  if (anchor.kind === 'selection') {
    return {
      kind: 'selection',
      quote: truncate(String(anchor.quote?.exact ?? ''), CARD.quoteChars),
    }
  }
  if (anchor.kind === 'element') {
    const fingerprint = anchor.fingerprint ?? {}
    const diagnostics = anchor.diagnostics ?? {}
    return {
      kind: 'element',
      tag: String(fingerprint.tag ?? 'element'),
      ...(fingerprint.textExcerpt ? { text: truncate(String(fingerprint.textExcerpt), CARD.textChars) } : {}),
      ...(fingerprint.outerHtmlPreview ? { html: truncate(String(fingerprint.outerHtmlPreview), CARD.textChars) } : {}),
      ...(anchor.selectors?.stable ? { selector: truncate(String(anchor.selectors.stable), CARD.selectorChars) } : {}),
      ...(diagnostics.a11yRole ? { role: String(diagnostics.a11yRole) } : {}),
      ...(diagnostics.a11yName ? { name: truncate(String(diagnostics.a11yName), CARD.textChars) } : {}),
      ...styleEntries(diagnostics.computedStyles),
      rect: rectOf(anchor.rect),
    }
  }
  return {
    kind: 'region',
    rect: rectOf(anchor.pageRect),
    ...(anchor.viewportRect === undefined ? {} : { viewportRect: rectOf(anchor.viewportRect) }),
  }
}

/**
 * A few computed styles, in the order they explain an element rather than the
 * order the page happened to declare them.
 * @param {any} styles
 */
function styleEntries(styles) {
  if (styles === null || typeof styles !== 'object') return {}
  const wanted = ['display', 'position', 'font-size', 'font-weight', 'color', 'background-color']
  /** @type {Record<string, string>} */
  const out = {}
  let taken = 0
  for (const key of wanted) {
    const value = styles[key]
    if (typeof value !== 'string' || value === '') continue
    out[key] = truncate(value, CARD.styleChars * 10)
    taken += 1
    if (taken >= CARD.styleChars) break
  }
  return Object.keys(out).length === 0 ? {} : { styles: out }
}

/** @param {any} snapshot */
function describeSnapshot(snapshot) {
  const viewport = snapshot.viewport ?? {}
  return {
    at: String(snapshot.at ?? ''),
    rect: rectOf(snapshot.rect),
    viewport: {
      width: numberOr(viewport.width, 0),
      height: numberOr(viewport.height, 0),
      dpr: numberOr(viewport.dpr, 0),
      scrollX: numberOr(viewport.scrollX, 0),
      scrollY: numberOr(viewport.scrollY, 0),
    },
  }
}

/** @param {any} value @param {number} fallback */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** @param {any} value */
function rectOf(value) {
  return {
    x: numberOr(value?.x, 0),
    y: numberOr(value?.y, 0),
    w: numberOr(value?.w, 0),
    h: numberOr(value?.h, 0),
  }
}

/**
 * Serve one annotation, and its crop, to the page this Host serves.
 *
 * Same-origin only, like the queue and the focus report: the GUI is the page the
 * Host serves, and what the user marked is not a cross-site resource.
 *
 * @param {any} webServer
 * @param {object} options
 * @param {{ get: (id: string) => any, image: (id: string) => any }} options.store
 * @param {(ref: any) => Promise<{ data: Uint8Array }>} [options.readImage] attachment reader
 * @param {string} [options.path]
 * @param {string} [options.imagePath]
 * @returns {() => void} disposer
 */
export function registerPresentationRoutes(webServer, { store, readImage, path = ITEM_PATH, imagePath = IMAGE_PATH }) {
  const jsonHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'sec-fetch-site',
  }

  const disposeItem = webServer.register({
    kind: 'exact',
    path,
    auth: 'anonymous',
    handler: (request, response) => {
      /** @param {number} status @param {any} payload */
      const send = (status, payload) => {
        response.writeHead(status, jsonHeaders)
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify(payload))
      }
      if (!sameOrigin(request)) {
        send(403, { ok: false, error: 'origin' })
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        send(405, { ok: false, error: 'method' })
        return
      }
      const id = new URL(request.url ?? path, 'http://127.0.0.1').searchParams.get('id') ?? ''
      const record = id === '' ? undefined : store.get(id)
      if (record === undefined) {
        send(404, { ok: false, error: 'missing' })
        return
      }
      send(200, { ok: true, item: describeAnnotation(record, { image: record.host?.image ?? store.image(id) }) })
    },
  })

  const disposeImage = webServer.register({
    kind: 'exact',
    path: imagePath,
    auth: 'anonymous',
    handler: (request, response) => {
      /** @param {number} status @param {any} payload */
      const send = (status, payload) => {
        response.writeHead(status, jsonHeaders)
        response.end(JSON.stringify(payload))
      }
      if (!sameOrigin(request)) {
        send(403, { ok: false, error: 'origin' })
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        send(405, { ok: false, error: 'method' })
        return
      }
      const id = new URL(request.url ?? imagePath, 'http://127.0.0.1').searchParams.get('id') ?? ''
      const record = id === '' ? undefined : store.get(id)
      const ref = record?.host?.image ?? (id === '' ? undefined : store.image(id))
      if (ref === undefined) {
        send(404, { ok: false, error: 'missing' })
        return
      }
      if (readImage === undefined) {
        send(503, { ok: false, error: 'attachments' })
        return
      }
      readImage(ref)
        .then((stored) => {
          response.writeHead(200, {
            'content-type': typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png',
            'content-length': stored.data.byteLength,
            'cache-control': 'private, max-age=300',
            'x-content-type-options': 'nosniff',
          })
          response.end(request.method === 'HEAD' ? undefined : Buffer.from(stored.data))
        })
        .catch(() => {
          send(404, { ok: false, error: 'missing' })
        })
    },
  })

  return () => {
    disposeItem()
    disposeImage()
  }
}

/**
 * The GUI is served by this Host, so the browser marks its own requests
 * `same-origin`. A request without the header is not the page.
 * @param {any} request
 */
function sameOrigin(request) {
  return request.headers?.['sec-fetch-site'] === 'same-origin'
}
