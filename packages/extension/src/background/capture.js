/**
 * Screenshot capture and cropping for annotations.
 *
 * `browser.tabs.captureVisibleTab` returns the *whole visible viewport* at
 * device pixels, while an annotation's rect is measured in CSS pixels. The
 * crop therefore maps CSS pixels onto image pixels with one factor per axis:
 * `scaleX = image.width / viewport.width` (normally the device pixel ratio),
 * `scaleY = image.height / viewport.height`. Measuring it from the decoded
 * image - rather than trusting `devicePixelRatio` - keeps the crop correct at
 * any browser zoom level and if the platform pads the capture.
 *
 * The capture reads the *composited* tab, so the annotation layer itself would
 * ship in the image: the composer card, the HUD pill, the locked outline, the
 * numbered badges and the toasts are all painted over the page when the user
 * is mid-gesture. Before every capture the page is asked to step its own layer
 * out of the frame (`anno.capture.hide`), the ack comes back after the browser
 * presented the now-clean frame, and the layer is restored afterwards
 * (`anno.capture.restore`). The same dance covers the outbox's late crop
 * retries, because both paths funnel through `captureRequest`.
 *
 * Capture can legitimately fail: `captureVisibleTab` requires the `activeTab`
 * grant (the user must have invoked the extension for *this* tab) and the tab
 * must be the visible one. A failure is reported to the caller so the outbox
 * can retry the crop later and, in the end, send the comment without an image.
 */
;(() => {
  const ns = globalThis.__DSH_ANNO_BG__
  if (ns === undefined) {
    console.error('dsh-marker: core.js must load before capture.js')
    return
  }

  /** PNG payload budget before a crop or whole capture is downscaled. */
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024
  /** Below this the anchor rect is not worth cropping (a sliver, not context). */
  const MIN_CROP_CSS_PX = 4
  /** A source rectangle smaller than this cannot be drawn meaningfully. */
  const MIN_SOURCE_PX = 2
  /** Downscaling rounds before an over-budget image is sent anyway. */
  const MAX_DOWNSCALE_ROUNDS = 5
  /** Never downscale below this edge; a 16 px crop tells the agent nothing. */
  const MIN_DOWNSCALE_EDGE = 16
  /**
   * How long the page may take to confirm its layer is out of the frame. The
   * content script acks after two presented frames (~33 ms at 60 Hz); the
   * remainder absorbs a busy main thread. Past the deadline the capture
   * proceeds as before the fix - a shot that may carry the layer beats no
   * shot, and the layer still comes back.
   */
  const HIDE_ACK_TIMEOUT_MS = 500

  /** @param {number} value @param {number} min @param {number} max */
  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, value))
  }

  /**
   * Normalize a rect from a message. Negative widths/heights (a drag that
   * starts bottom-right) are corrected instead of rejected.
   * @param {unknown} value
   * @returns {{ x: number, y: number, w: number, h: number } | null}
   */
  function normalizeRect(value) {
    if (!ns.isPlainObject(value)) return null
    let { x, y, w, h } = /** @type {any} */ (value)
    if (![x, y, w, h].every((item) => typeof item === 'number' && Number.isFinite(item))) return null
    if (w < 0) {
      x += w
      w = -w
    }
    if (h < 0) {
      y += h
      h = -h
    }
    return { x, y, w, h }
  }

  /**
   * Normalize the page viewport as reported by the content script.
   * @param {unknown} value
   * @returns {{ width: number, height: number, devicePixelRatio: number } | null}
   */
  function normalizeViewport(value) {
    if (!ns.isPlainObject(value)) return null
    const typed = /** @type {any} */ (value)
    const width = Number(typed.width ?? typed.w)
    const height = Number(typed.height ?? typed.h)
    if (!(Number.isFinite(width) && width > 0) || !(Number.isFinite(height) && height > 0)) return null
    const ratio = Number(typed.devicePixelRatio ?? typed.dpr)
    return {
      width,
      height,
      devicePixelRatio: Number.isFinite(ratio) && ratio > 0 ? ratio : 0,
    }
  }

  /**
   * Map a viewport-CSS-pixel rect onto the captured bitmap.
   *
   * The rect is first clipped to the viewport (an element half scrolled out of
   * view yields the visible half, not the off-screen part), then scaled:
   *
   *   scaleX = bitmapWidth  / viewport.width
   *   scaleY = bitmapHeight / viewport.height
   *
   * The result is what `drawImage` needs: source x/y/width/height in image
   * pixels. `clamped` reports that the visible part was smaller than the
   * requested rect, and `empty` that nothing usable is left.
   *
   * @param {{ x: number, y: number, w: number, h: number }} rect viewport CSS px
   * @param {{ width: number, height: number }} viewport CSS px
   * @param {number} bitmapWidth device px
   * @param {number} bitmapHeight device px
   */
  function cropGeometry(rect, viewport, bitmapWidth, bitmapHeight) {
    const scaleX = bitmapWidth / viewport.width
    const scaleY = bitmapHeight / viewport.height
    const left = Math.max(0, rect.x)
    const top = Math.max(0, rect.y)
    const right = Math.min(viewport.width, rect.x + rect.w)
    const bottom = Math.min(viewport.height, rect.y + rect.h)
    const visibleWidth = Math.max(0, right - left)
    const visibleHeight = Math.max(0, bottom - top)
    const sx = clamp(left * scaleX, 0, Math.max(0, bitmapWidth - MIN_SOURCE_PX))
    const sy = clamp(top * scaleY, 0, Math.max(0, bitmapHeight - MIN_SOURCE_PX))
    const sw = clamp(visibleWidth * scaleX, 0, bitmapWidth - sx)
    const sh = clamp(visibleHeight * scaleY, 0, bitmapHeight - sy)
    const empty = !(sw >= MIN_SOURCE_PX && sh >= MIN_SOURCE_PX)
    const clamped = visibleWidth < rect.w - 0.5 || visibleHeight < rect.h - 0.5
    return { sx, sy, sw, sh, scaleX, scaleY, empty, clamped }
  }

  /**
   * Return a copy of `record` with capture diagnostics on `pageContext`.
   * `pageContext` is the one free-form part of a record, so it carries the
   * "why is there no image" answer to the agent without changing the protocol.
   * @param {any} record
   * @param {Record<string, unknown>} note
   */
  function withNote(record, note) {
    if (!ns.isPlainObject(record)) return record
    const pageContext = ns.isPlainObject(record.pageContext) ? record.pageContext : {}
    return { ...record, pageContext: { ...pageContext, capture: { ...note } } }
  }

  /** @param {string} dataUrl */
  function splitDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') return null
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return null
    const header = dataUrl.slice(0, comma)
    const match = /^data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?$/i.exec(header)
    if (match === null) return null
    const base64 = dataUrl.slice(comma + 1)
    if (base64 === '') return null
    return { base64, mime: match[1] }
  }

  /** @param {{ base64: string, mime: string }} source */
  function base64ToBlob(source) {
    const binary = atob(source.base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return new Blob([bytes], { type: source.mime })
  }

  /** @param {string} base64 */
  function base64ByteLength(base64) {
    if (typeof base64 !== 'string' || base64 === '') return 0
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    return Math.floor((base64.length * 3) / 4) - padding
  }

  /** @param {Uint8Array} bytes */
  function bytesToBase64(bytes) {
    let binary = ''
    // `String.fromCharCode.apply` has an argument limit; chunk the input.
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(index, index + chunkSize)))
    }
    return btoa(binary)
  }

  /** @param {Blob} blob */
  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(new Error('the captured image could not be read'))
      reader.readAsDataURL(blob)
    })
  }

  /**
   * Decode the capture into something `drawImage` accepts. `createImageBitmap`
   * is the fast path; an `Image` element is the fallback on the rare build
   * where `createImageBitmap` is unavailable.
   * @param {Blob} blob
   * @returns {Promise<{ source: any, width: number, height: number, close: () => void }>}
   */
  async function decodeBitmap(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob)
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close() {
            try {
              bitmap.close()
            } catch (error) {
              ns.log.debug(`closing the bitmap failed: ${ns.describeError(error)}`)
            }
          },
        }
      } catch (error) {
        ns.log.debug(`createImageBitmap failed (${ns.describeError(error)}); using an <img> decoder`)
      }
    }
    if (typeof document !== 'undefined' && typeof Image === 'function') {
      const dataUrl = await blobToDataUrl(blob)
      const image = new Image()
      image.src = dataUrl
      if (typeof image.decode === 'function') await image.decode()
      else {
        await new Promise((resolve, reject) => {
          image.onload = () => resolve(undefined)
          image.onerror = () => reject(new Error('the captured image could not be decoded'))
        })
      }
      return { source: image, width: image.naturalWidth, height: image.naturalHeight, close() {} }
    }
    throw new Error('no image decoder is available in this context')
  }

  /**
   * Encode a source rectangle at a target size as PNG. OffscreenCanvas is
   * preferred (no DOM); a detached canvas in the event-page document is the
   * fallback.
   * @param {{ source: any }} decoded
   * @param {{ sx: number, sy: number, sw: number, sh: number }} source
   * @param {number} width
   * @param {number} height
   */
  async function render(decoded, source, width, height) {
    if (typeof OffscreenCanvas === 'function') {
      try {
        const canvas = new OffscreenCanvas(width, height)
        const context = canvas.getContext('2d')
        if (context === null) throw new Error('OffscreenCanvas has no 2d context')
        context.drawImage(decoded.source, source.sx, source.sy, source.sw, source.sh, 0, 0, width, height)
        const blob = await canvas.convertToBlob({ type: 'image/png' })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        return { base64: bytesToBase64(bytes), bytes: bytes.byteLength, width, height, renderer: 'offscreen' }
      } catch (error) {
        ns.log.debug(`OffscreenCanvas crop failed (${ns.describeError(error)}); using a DOM canvas`)
      }
    }
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error('no canvas implementation is available')
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('a 2d canvas context is unavailable')
    context.drawImage(decoded.source, source.sx, source.sy, source.sw, source.sh, 0, 0, width, height)
    const dataUrl = canvas.toDataURL('image/png')
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    // toDataURL only returns synchronously encoded base64; the byte length is
    // exact apart from padding, which is what the budget check needs.
    return { base64, bytes: base64ByteLength(base64), width, height, renderer: 'canvas' }
  }

  /**
   * Crop the capture and keep it under the PNG budget, downscaling from the
   * original bitmap so quality never compounds across rounds.
   * @param {{ base64: string, mime: string }} capture
   * @param {{ x: number, y: number, w: number, h: number }} rect
   * @param {{ width: number, height: number }} viewport
   */
  async function cropCapture(capture, rect, viewport) {
    const blob = base64ToBlob(capture)
    const decoded = await decodeBitmap(blob)
    try {
      const geometry = cropGeometry(rect, viewport, decoded.width, decoded.height)
      if (geometry.empty) throw new Error('the anchor rectangle is empty in image pixels')
      let width = Math.max(1, Math.round(geometry.sw))
      let height = Math.max(1, Math.round(geometry.sh))
      let rendered = await render(decoded, geometry, width, height)
      let downscaled = false
      let rounds = 0
      while (
        rendered.bytes > MAX_IMAGE_BYTES &&
        rounds < MAX_DOWNSCALE_ROUNDS &&
        width > MIN_DOWNSCALE_EDGE &&
        height > MIN_DOWNSCALE_EDGE
      ) {
        const ratio = Math.min(0.9, Math.sqrt(MAX_IMAGE_BYTES / rendered.bytes) * 0.95)
        width = Math.max(MIN_DOWNSCALE_EDGE, Math.round(width * ratio))
        height = Math.max(MIN_DOWNSCALE_EDGE, Math.round(height * ratio))
        rendered = await render(decoded, geometry, width, height)
        downscaled = true
        rounds += 1
      }
      return {
        base64: rendered.base64,
        bytes: rendered.bytes,
        width: rendered.width,
        height: rendered.height,
        downscaled,
        renderer: rendered.renderer,
        geometry,
      }
    } finally {
      decoded.close()
    }
  }

  /**
   * Whole-viewport fallback: keep the image if it fits, otherwise downscale it,
   * and if even that is not possible send the original and say it was too big.
   * @param {{ base64: string, mime: string }} capture
   */
  async function limitUncropped(capture) {
    const bytes = base64ByteLength(capture.base64)
    if (bytes <= MAX_IMAGE_BYTES) return { base64: capture.base64, mime: capture.mime, bytes, downscaled: false }
    try {
      const decoded = await decodeBitmap(base64ToBlob(capture))
      try {
        let scale = Math.min(1, Math.sqrt(MAX_IMAGE_BYTES / bytes) * 0.95)
        for (let round = 0; round < MAX_DOWNSCALE_ROUNDS; round += 1) {
          const width = Math.max(MIN_DOWNSCALE_EDGE, Math.round(decoded.width * scale))
          const height = Math.max(MIN_DOWNSCALE_EDGE, Math.round(decoded.height * scale))
          const rendered = await render(decoded, { sx: 0, sy: 0, sw: decoded.width, sh: decoded.height }, width, height)
          if (rendered.bytes <= MAX_IMAGE_BYTES) {
            return { base64: rendered.base64, mime: 'image/png', bytes: rendered.bytes, downscaled: true }
          }
          scale *= 0.7
        }
      } finally {
        decoded.close()
      }
    } catch (error) {
      ns.log.warn(`could not shrink the uncropped capture: ${ns.describeError(error)}`)
    }
    return { base64: capture.base64, mime: capture.mime, bytes, downscaled: false, oversized: true }
  }

  /**
   * Ask the page to move the extension's own layer out of the frame. Best
   * effort by design: a tab with no receiver (restricted page, a document that
   * predates the install) simply captures as it always did.
   * @param {number} tabId
   * @returns {Promise<boolean>} whether the page confirmed the hide
   */
  async function suppressOwnLayer(tabId) {
    try {
      const acked = await ns.withTimeout(
        ns.notifyTab(tabId, ns.msg.TO_CONTENT.captureHide),
        HIDE_ACK_TIMEOUT_MS,
        'the capture-hide acknowledgement',
      )
      return acked === true
    } catch (error) {
      ns.log.debug(`the page did not confirm hiding its layer: ${ns.describeError(error)}`)
      return false
    }
  }

  /**
   * Give the layer back. Sent unconditionally after the capture - also when
   * the hide timed out, in case the ack was merely late - and the content
   * script tolerates a restore with no matching hide (its watchdog covers the
   * converse, a hide whose restore never lands).
   * @param {number} tabId
   */
  function restoreOwnLayer(tabId) {
    void ns.notifyTab(tabId, ns.msg.TO_CONTENT.captureRestore)
  }

  /**
   * Capture the visible tab and crop it.
   *
   * Resolves with one of:
   *   { ok: true,  image: { b64, mime }, meta: { cropped, scale?, reason? } }
   *   { ok: false, code, error }   // retryable: no image was produced
   *
   * A crop that fails technically is not a failed capture: the whole viewport
   * still carries useful context, so such errors resolve with `cropped: false`
   * and a reason. Only "no image at all" is reported as a failure.
   *
   * @param {{ tabId?: unknown, windowId?: unknown, cropRect?: unknown, viewport?: unknown }} request
   */
  async function captureRequest(request) {
    const tabId = Number(request?.tabId)
    if (!Number.isInteger(tabId)) return { ok: false, code: 'bad-request', error: 'the capture request has no tab id' }

    let tab
    try {
      tab = await browser.tabs.get(tabId)
    } catch (error) {
      return {
        ok: false,
        code: 'tab-closed',
        error: `the tab is gone, so the crop cannot be taken (${ns.describeError(error)})`,
      }
    }
    if (tab.active !== true) {
      return {
        ok: false,
        code: 'tab-not-active',
        error: 'the tab is not the visible tab in its window; the crop is retried the next time it is',
      }
    }

    await suppressOwnLayer(tabId)
    try {
      return await captureAndCrop(tab, request)
    } finally {
      restoreOwnLayer(tabId)
    }
  }

  /**
   * The capture itself, run with the page's layer already out of the frame.
   * Split from `captureRequest` so the hide/restore bracket has one `finally`
   * around every outcome, including the error returns below.
   * @param {{ windowId?: unknown }} tab
   * @param {{ windowId?: unknown, cropRect?: unknown, viewport?: unknown }} request
   */
  async function captureAndCrop(tab, request) {
    const windowId = Number(request?.windowId)

    let dataUrl
    try {
      dataUrl = await browser.tabs.captureVisibleTab(Number.isInteger(windowId) ? windowId : tab.windowId, {
        format: 'png',
      })
    } catch (error) {
      // The usual causes are a missing activeTab grant (the user did not
      // invoke the extension for this tab) and a closed window.
      return { ok: false, code: 'capture-failed', error: ns.describeError(error) }
    }
    const capture = splitDataUrl(dataUrl)
    if (capture === null) {
      return { ok: false, code: 'capture-failed', error: 'captureVisibleTab returned an unexpected payload' }
    }

    const rect = normalizeRect(request?.cropRect)
    const viewport = normalizeViewport(request?.viewport)
    if (rect === null || viewport === null) {
      const reason =
        rect === null
          ? 'no crop rectangle was supplied'
          : 'the page viewport size is unknown, so CSS pixels cannot be mapped onto the capture'
      const limited = await limitUncropped(capture)
      return {
        ok: true,
        image: { b64: limited.base64, mime: limited.mime },
        meta: {
          cropped: false,
          reason: `${reason}; sent the uncropped capture`,
          bytes: limited.bytes,
          downscaled: limited.downscaled === true,
        },
      }
    }

    if (rect.w < MIN_CROP_CSS_PX || rect.h < MIN_CROP_CSS_PX) {
      // The content script clips the rect to the viewport, so a near-empty rect
      // means the anchor scrolled out of view; a few pixels of it would mislead
      // the agent more than a full screenshot.
      const limited = await limitUncropped(capture)
      return {
        ok: true,
        image: { b64: limited.base64, mime: limited.mime },
        meta: {
          cropped: false,
          reason: `the anchor rectangle is smaller than ${MIN_CROP_CSS_PX} CSS px; sent the uncropped capture`,
          bytes: limited.bytes,
          downscaled: limited.downscaled === true,
        },
      }
    }

    try {
      const cropped = await cropCapture(capture, rect, viewport)
      return {
        ok: true,
        image: { b64: cropped.base64, mime: 'image/png' },
        meta: {
          cropped: true,
          scale: cropped.geometry.scaleX,
          scaleY: cropped.geometry.scaleY,
          clamped: cropped.geometry.clamped,
          sourceRect: {
            x: Math.round(cropped.geometry.sx),
            y: Math.round(cropped.geometry.sy),
            w: Math.round(cropped.geometry.sw),
            h: Math.round(cropped.geometry.sh),
          },
          outputWidth: cropped.width,
          outputHeight: cropped.height,
          bytes: cropped.bytes,
          downscaled: cropped.downscaled,
          renderer: cropped.renderer,
        },
      }
    } catch (error) {
      ns.log.warn(`cropping the capture failed (${ns.describeError(error)}); sending the uncropped capture`)
      const limited = await limitUncropped(capture)
      return {
        ok: true,
        image: { b64: limited.base64, mime: limited.mime },
        meta: {
          cropped: false,
          reason: `cropping failed (${ns.describeError(error)}); sent the uncropped capture`,
          bytes: limited.bytes,
          downscaled: limited.downscaled === true,
        },
      }
    }
  }

  ns.capture = {
    MAX_IMAGE_BYTES,
    MIN_CROP_CSS_PX,
    normalizeRect,
    normalizeViewport,
    cropGeometry,
    withNote,
    captureRequest,
  }
})()
