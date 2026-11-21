/**
 * Screenshot cropping in a service-worker global, without a document.
 *
 * Chromium runs the background in a service worker, where `document`,
 * `Image`, and `FileReader` do not exist, and `OffscreenCanvas` /
 * `createImageBitmap` do. `capture.js` claims to prefer exactly that path, but
 * nothing in the Firefox test setup can prove it: the event page has a document,
 * so an accidental dependency on one would only surface on Chromium, as a
 * screenshot that silently never arrives.
 *
 * These tests load the real files into a `node:vm` context whose `document` is
 * undefined and whose only canvas is an `OffscreenCanvas` stub, then drive
 * `captureRequest` end to end - including the hide/restore dance that keeps
 * the annotation layer itself out of the frame while the capture reads it.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const extensionRoot = dirname(here)

/** Everything `capture.js` needs: the protocol global, the parser, core, itself. */
const SCRIPTS = [
  'src/shared/protocol.global.js',
  'src/background/endpoints.js',
  'src/background/core.js',
  'src/background/capture.js',
]

/** The PNG payload a fake `captureVisibleTab` hands back. */
const CAPTURE_DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

/**
 * Load the capture half into a worker-shaped global.
 * @param {{ offscreen?: boolean, bitmap?: boolean, sendMessage?: 'ack' | 'reject' }} [capabilities]
 */
async function loadCapture({ offscreen = true, bitmap = true, sendMessage = 'ack' } = {}) {
  /** @type {string[]} */
  const warnings = []
  /** @type {any[]} */
  const canvases = []
  /** Every tabs.sendMessage envelope, in order, with the capture marked. */
  const frames = []

  /** Stands in for the browser's offscreen canvas; `convertToBlob` is the only
   * method the crop uses that a normal element canvas would not offer. */
  class FakeOffscreenCanvas {
    constructor(width, height) {
      this.width = width
      this.height = height
      this.drawn = null
      canvases.push(this)
    }

    // capture.js asks for a `2d` context; the stub only records the draw call.
    getContext() {
      return {
        drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh) {
          this.last = { source, sx, sy, sw, sh, dx, dy, dw, dh }
        },
      }
    }

    async convertToBlob({ type }) {
      return new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type })
    }
  }

  const browser = {
    runtime: {
      getManifest: () => ({ version: '0.1.0', manifest_version: 3 }),
      getURL: (path) => `chrome-extension://test/${path}`,
      id: 'dsh-marker@test',
    },
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: 1, active: true, url: 'https://example.com/' }),
      captureVisibleTab: async () => {
        frames.push('capture')
        return CAPTURE_DATA_URL
      },
      sendMessage:
        sendMessage === 'reject'
          ? async () => {
              throw new Error('Could not establish connection. Receiving end does not exist.')
            }
          : async (_tabId, message) => {
              frames.push(message.type)
              return { ok: true }
            },
    },
  }

  const sandbox = {
    browser,
    console: {
      debug() {},
      info() {},
      warn: (...args) => warnings.push(args.join(' ')),
      error: (...args) => warnings.push(args.join(' ')),
    },
    URL,
    Blob,
    setTimeout,
    clearTimeout,
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    // The service worker's decoders: no document, no Image, no FileReader.
    document: undefined,
    createImageBitmap: bitmap ? async () => ({ width: 1000, height: 800, close() {} }) : undefined,
  }
  if (offscreen) sandbox.OffscreenCanvas = FakeOffscreenCanvas
  sandbox.globalThis = sandbox

  const context = vm.createContext(sandbox)
  for (const path of SCRIPTS) {
    const code = await readFile(join(extensionRoot, path), 'utf8')
    vm.runInContext(code, context, { filename: path })
  }
  const ns = sandbox.__DSH_ANNO_BG__
  assert.ok(ns?.capture !== undefined, 'capture.js published ns.capture')
  return { ns, sandbox, warnings, canvases, frames }
}

test('a crop renders on OffscreenCanvas when there is no document', async () => {
  const { ns, sandbox, canvases } = await loadCapture()
  assert.equal(sandbox.document, undefined, 'the worker global has no document')

  const result = await ns.capture.captureRequest({
    tabId: 1,
    windowId: 1,
    cropRect: { x: 10, y: 20, w: 200, h: 100 },
    viewport: { width: 1000, height: 800 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.meta.cropped, true)
  assert.equal(result.meta.renderer, 'offscreen', 'the worker path is the one that ran')
  assert.equal(result.meta.outputWidth, 200)
  assert.equal(result.meta.outputHeight, 100)
  assert.equal(result.meta.sourceRect.x, 10)
  assert.equal(result.meta.sourceRect.y, 20)
  assert.equal(canvases.length, 1, 'exactly one offscreen canvas was created')
  assert.ok(result.image.b64.length > 0, 'the crop is base64 for the host frame')
})

test('a worker without OffscreenCanvas still sends the uncropped capture', async () => {
  // Chrome has OffscreenCanvas in every service worker, but the fallback must
  // degrade to "whole viewport plus a reason" rather than to no screenshot: a
  // comment is worth more than a failure, and the outbox retries the crop.
  const { ns, warnings } = await loadCapture({ offscreen: false })

  const result = await ns.capture.captureRequest({
    tabId: 1,
    windowId: 1,
    cropRect: { x: 10, y: 20, w: 200, h: 100 },
    viewport: { width: 1000, height: 800 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.meta.cropped, false)
  assert.match(result.meta.reason, /cropping failed/)
  assert.match(result.meta.reason, /no canvas implementation/)
  assert.ok(result.image.b64.length > 0)
  assert.ok(warnings.some((line) => line.includes('cropping the capture failed')))
})

test('a worker with no decoder at all still resolves, with the raw capture', async () => {
  // A service worker always has createImageBitmap and OffscreenCanvas, so this
  // is the "some build lacks both" corner: it must resolve with the uncropped
  // image and a reason, never throw into the message handler.
  const { ns } = await loadCapture({ offscreen: false, bitmap: false })
  const result = await ns.capture.captureRequest({
    tabId: 1,
    windowId: 1,
    cropRect: { x: 10, y: 20, w: 200, h: 100 },
    viewport: { width: 1000, height: 800 },
  })
  assert.equal(result.ok, true)
  assert.equal(result.meta.cropped, false)
  assert.match(result.meta.reason, /no image decoder/)
})

test('the page steps its own layer out of the frame for the capture', async () => {
  // captureVisibleTab photographs the composited tab, so a shot taken while the
  // composer card, the HUD and the badges are painted would ship the extension's
  // own chrome to the agent as if the page had drawn it. The hide must land
  // before the capture, and the layer must come back afterwards.
  const { ns, frames } = await loadCapture()
  const result = await ns.capture.captureRequest({
    tabId: 1,
    windowId: 1,
    cropRect: { x: 10, y: 20, w: 200, h: 100 },
    viewport: { width: 1000, height: 800 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.meta.cropped, true)
  assert.deepEqual(frames, [ns.msg.TO_CONTENT.captureHide, 'capture', ns.msg.TO_CONTENT.captureRestore])
})

test('a failed captureVisibleTab still restores the layer', async () => {
  // A missing activeTab grant rejects the capture; the `finally` bracket owns
  // the restore, or the user is left with a page whose HUD never came back.
  const { ns, frames, sandbox } = await loadCapture()
  sandbox.browser.tabs.captureVisibleTab = async () => {
    frames.push('capture')
    throw new Error('Missing host permission for the tab')
  }

  const result = await ns.capture.captureRequest({
    tabId: 1,
    windowId: 1,
    cropRect: { x: 10, y: 20, w: 200, h: 100 },
    viewport: { width: 1000, height: 800 },
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'capture-failed')
  assert.deepEqual(frames, [ns.msg.TO_CONTENT.captureHide, 'capture', ns.msg.TO_CONTENT.captureRestore])
})

test('a page that cannot answer the hide still gets its capture', async () => {
  // Restricted pages and documents that predate the install have no content
  // script to ack; the capture must degrade to the old behaviour, not fail.
  const { ns, frames } = await loadCapture({ sendMessage: 'reject' })
  const result = await ns.capture.captureRequest({
    tabId: 1,
    windowId: 1,
    cropRect: { x: 10, y: 20, w: 200, h: 100 },
    viewport: { width: 1000, height: 800 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.meta.cropped, true)
  // The hide was attempted (and answered by nothing), the capture ran, and the
  // best-effort restore failed the same way without disturbing the result.
  assert.deepEqual(frames, ['capture'])
})
