/**
 * Offline outbox: the durable queue of submitted annotations.
 *
 * A submission is persisted here *before* it is sent, then removed when the
 * host acknowledges it. That write-ahead order costs one storage write per
 * annotation and buys the promise the extension makes to the user: a closed
 * tab, a suspended event page, a dropped socket, or a failed screen capture
 * never discards a comment. Replays are safe because the host acks a duplicate
 * annotation id instead of storing it twice.
 *
 * Entries are stored in `storage.local['anno.outbox']`:
 *
 *   {
 *     record,          // full normalized protocol record
 *     image,           // { b64, mime } | null  (crop, or null while deferred)
 *     captureRequest,  // { tabId, windowId, cropRect, viewport } | null
 *     captureAttempts, // crops already attempted
 *     nextCaptureAt,   // epoch ms before which no new crop attempt is made
 *     enqueuedAt,      // epoch ms, keeps FIFO order across restarts
 *     sendAttempts,    // anno.create frames already sent
 *     blocked,         // automatic delivery gave up; a manual flush retries
 *     lastError,       // last transport/capture error, for the popup tooltip
 *   }
 */
;(() => {
  const ns = globalThis.__DSH_ANNO_BG__
  if (ns === undefined) {
    console.error('dsh-annotate: core.js must load before outbox.js')
    return
  }

  /** Hard cap on queued annotations; the oldest is dropped past this. */
  const MAX_ENTRIES = 40
  /**
   * Soft cap on the total base64 of queued crops. Firefox backs
   * `storage.local` with its own quota; shedding the oldest crops first keeps
   * the comments (the part the user typed) while images are the cheapest thing
   * to lose, because the host keeps whatever crop arrives with the first send.
   */
  const MAX_IMAGE_BASE64_CHARS = 6 * 1024 * 1024
  /** Delay before each deferred-crop retry, in order; the last one repeats. */
  const CAPTURE_RETRY_DELAYS_MS = [1_500, 5_000, 15_000]
  /** After this many failed crop attempts the annotation ships without one. */
  const MAX_CAPTURE_ATTEMPTS = CAPTURE_RETRY_DELAYS_MS.length + 1
  /** How long to wait for `anno.ack` before treating a send as unconfirmed. */
  const ACK_TIMEOUT_MS = 10_000
  /** A frame the host never acks is retried; after this many, require a human. */
  const MAX_SEND_ATTEMPTS = 6
  /** Backoff after an unconfirmed send. */
  const UNCONFIRMED_RETRY_MS = 15_000

  /** @type {any[]} */
  let items = []
  let loaded = false
  /** @type {Promise<any[]> | null} */
  let loadPromise = null
  let persistChain = Promise.resolve()
  /** @type {Promise<any> | null} */
  let flushing = null
  let flushAgain = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let flushTimer = null
  let flushTimerDue = 0

  function key() {
    return ns.msg.STORAGE_KEYS.outbox
  }

  /** @param {unknown} raw */
  function coerceEntry(raw) {
    if (!ns.isPlainObject(raw)) return null
    // An earlier build stored bare records; wrap them instead of losing them.
    const record = ns.isPlainObject(raw.record)
      ? raw.record
      : ns.isPlainObject(raw) && typeof raw.id === 'string' && ns.isPlainObject(raw.anchor)
        ? raw
        : null
    if (!ns.isPlainObject(record) || typeof record.id !== 'string' || record.id === '') return null
    const image =
      ns.isPlainObject(raw.image) && typeof raw.image.b64 === 'string'
        ? { b64: raw.image.b64, mime: typeof raw.image.mime === 'string' ? raw.image.mime : 'image/png' }
        : null
    return {
      record,
      image,
      captureRequest: ns.isPlainObject(raw.captureRequest) ? raw.captureRequest : null,
      captureAttempts: Number.isInteger(raw.captureAttempts) ? raw.captureAttempts : 0,
      nextCaptureAt: typeof raw.nextCaptureAt === 'number' ? raw.nextCaptureAt : 0,
      enqueuedAt: typeof raw.enqueuedAt === 'number' ? raw.enqueuedAt : Date.now(),
      sendAttempts: Number.isInteger(raw.sendAttempts) ? raw.sendAttempts : 0,
      blocked: raw.blocked === true,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    }
  }

  async function load() {
    if (loaded) return items
    if (loadPromise !== null) return loadPromise
    loadPromise = (async () => {
      const raw = await ns.storageGet(key(), [])
      const stored = Array.isArray(raw) ? raw : []
      const restored = []
      for (const candidate of stored) {
        const entry = coerceEntry(candidate)
        if (entry === null) {
          ns.log.warn('outbox: dropping an entry that is not a valid queued annotation')
          continue
        }
        if (restored.some((other) => other.record.id === entry.record.id)) continue
        restored.push(entry)
      }
      items = restored.sort((left, right) => left.enqueuedAt - right.enqueuedAt)
      loaded = true
      if (items.length > 0) ns.log.info(`outbox: restored ${items.length} unsent annotation(s)`)
      return items
    })()
    return loadPromise
  }

  /**
   * Persist the queue, shedding data on quota errors instead of throwing:
   * first the oldest crops, then the oldest annotations. A failed write here
   * would mean silently losing a comment, so it is retried in reduced form and
   * only logged when even that fails.
   */
  function persist() {
    persistChain = persistChain
      .then(() => writeWithShrink())
      .catch((error) => ns.log.error(`outbox: could not persist the queue: ${ns.describeError(error)}`))
    return persistChain
  }

  async function writeWithShrink() {
    for (let round = 0; round < 5; round += 1) {
      try {
        await browser.storage.local.set({ [key()]: items })
        return
      } catch (error) {
        if (round === 4) throw error
        if (shedOldestImage()) {
          ns.log.warn(`outbox: dropped an old crop to fit the storage quota (${ns.describeError(error)})`)
          continue
        }
        if (shedOldestEntry()) {
          ns.log.warn(`outbox: dropped the oldest annotation to fit the storage quota (${ns.describeError(error)})`)
          continue
        }
        throw error
      }
    }
  }

  function shedOldestImage() {
    for (const entry of items) {
      if (!entry.image) continue
      entry.image = null
      entry.captureRequest = null
      entry.captureAttempts = MAX_CAPTURE_ATTEMPTS
      entry.record = ns.capture.withNote(entry.record, {
        status: 'dropped',
        reason: 'the crop was discarded to keep the local outbox within the storage quota',
      })
      return true
    }
    return false
  }

  function shedOldestEntry() {
    if (items.length === 0) return false
    const dropped = items.shift()
    ns.log.warn(`outbox: dropped annotation ${dropped.record.id}`)
    return true
  }

  /** Keep FIFO order and the image budget; the oldest crops go first. */
  function enforceLimits() {
    while (items.length > MAX_ENTRIES) {
      const dropped = items.shift()
      ns.log.warn(`outbox: dropping ${dropped.record.id}; the queue holds at most ${MAX_ENTRIES} annotations`)
    }
    let imageChars = 0
    for (const entry of items) if (entry.image) imageChars += entry.image.b64.length
    for (const entry of items) {
      if (imageChars <= MAX_IMAGE_BASE64_CHARS) break
      if (!entry.image) continue
      imageChars -= entry.image.b64.length
      entry.image = null
      entry.captureRequest = null
      entry.captureAttempts = MAX_CAPTURE_ATTEMPTS
      entry.record = ns.capture.withNote(entry.record, {
        status: 'dropped',
        reason: 'the crop was discarded to keep the local outbox within its image budget',
      })
      ns.log.warn(`outbox: dropped the crop of ${entry.record.id} to stay within the image budget`)
    }
  }

  /**
   * Queue one annotation. Idempotent by record id, so a duplicated message
   * (or a retried submit) cannot create two entries.
   * @param {any} entry
   */
  async function add(entry) {
    await load()
    const id = entry?.record?.id
    if (typeof id !== 'string' || id === '') throw new Error('outbox.add needs an entry with a record id')
    const existing = items.find((item) => item.record.id === id)
    if (existing !== undefined) {
      ns.log.debug(`outbox: ${id} is already queued`)
      return existing
    }
    items.push(entry)
    enforceLimits()
    await persist()
    void ns.publishStatus('outbox-add')
    return entry
  }

  /** @param {string} id */
  async function remove(id) {
    await load()
    const before = items.length
    items = items.filter((entry) => entry.record.id !== id)
    if (items.length === before) return false
    await persist()
    void ns.publishStatus('outbox-remove')
    return true
  }

  function summary() {
    let pendingImages = 0
    for (const entry of items) if (entry.image) pendingImages += 1
    return { count: items.length, pendingImages }
  }

  /** @param {Record<string, any>} frame an `anno.ack` host frame */
  function onAck(frame) {
    const id = typeof frame?.id === 'string' ? frame.id : ''
    if (id === '') return
    if (!items.some((entry) => entry.record.id === id)) return
    ns.log.debug(`outbox: host acknowledged ${id}`)
    void remove(id)
  }

  /**
   * Let the next automatic flush try blocked entries again; a fresh
   * connection (or a human) is a different situation than the one that failed.
   */
  function clearBlocked() {
    let changed = false
    for (const entry of items) {
      if (entry.blocked !== true) continue
      entry.blocked = false
      entry.sendAttempts = 0
      changed = true
    }
    if (changed) void persist()
  }

  /** @param {number} ms */
  function scheduleFlushLater(ms) {
    const delay = Math.max(250, Math.min(Number(ms) || 1_000, 60_000))
    const due = Date.now() + delay
    if (flushTimer !== null && flushTimerDue <= due) return
    if (flushTimer !== null) clearTimeout(flushTimer)
    flushTimerDue = due
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushTimerDue = 0
      void flush({ reason: 'timer' })
    }, delay)
  }

  /**
   * Flush the queue in order. Concurrent callers share one run; a queue that
   * grew during the run is drained before the promise settles.
   * @param {{ reason?: string }} [options]
   */
  function flush(options = {}) {
    if (flushing !== null) {
      flushAgain = true
      return flushing
    }
    flushing = (async () => {
      let result
      do {
        flushAgain = false
        result = await runFlush(options)
      } while (flushAgain === true && ns.net.isAuthed())
      return result
    })().finally(() => {
      flushing = null
    })
    return flushing
  }

  /** @param {{ reason?: string }} [options] */
  async function runFlush(options = {}) {
    await load()
    const reason = typeof options.reason === 'string' ? options.reason : 'auto'
    if (ns.capture === undefined || typeof ns.routing?.waitForAck !== 'function') {
      // Boot order is guaranteed by the manifest; this only protects a partial
      // reload during development.
      return { sent: 0, remaining: items.length, offline: !ns.net.isAuthed() }
    }
    if (!ns.net.isAuthed()) return { sent: 0, remaining: items.length, offline: true }

    let sent = 0
    const queue = items.slice()
    for (const entry of queue) {
      if (!items.includes(entry)) continue // acknowledged and removed meanwhile
      if (entry.blocked === true) continue

      const id = entry.record.id

      // 1. A deferred crop gets another chance before the comment is sent: the
      //    host keeps only the image of the first successful create, so this
      //    is the last moment the crop can be added.
      if (!entry.image && entry.captureRequest && entry.captureAttempts < MAX_CAPTURE_ATTEMPTS) {
        const wait = Math.max(0, entry.nextCaptureAt - Date.now())
        if (wait > 0) {
          scheduleFlushLater(wait)
          break // keep FIFO order
        }
        const captured = await ns.capture.captureRequest(entry.captureRequest)
        if (captured.ok === true) {
          entry.image = { b64: captured.image.b64, mime: captured.image.mime }
          entry.record = ns.capture.withNote(entry.record, {
            status: captured.meta.cropped ? 'captured' : 'uncropped',
            late: true,
            ...(captured.meta.reason === undefined ? {} : { reason: captured.meta.reason }),
            ...(typeof captured.meta.scale === 'number' ? { scale: captured.meta.scale } : {}),
          })
          entry.lastError = null
          ns.log.info(`outbox: late crop captured for ${id}`)
          await persist()
        } else {
          entry.captureAttempts += 1
          entry.lastError = captured.error
          if (entry.captureAttempts < MAX_CAPTURE_ATTEMPTS) {
            const delay =
              CAPTURE_RETRY_DELAYS_MS[Math.min(entry.captureAttempts - 1, CAPTURE_RETRY_DELAYS_MS.length - 1)]
            entry.nextCaptureAt = Date.now() + delay
            await persist()
            ns.log.info(`outbox: crop for ${id} failed (${captured.error}); retrying in ${delay} ms`)
            scheduleFlushLater(delay)
            break
          }
          entry.record = ns.capture.withNote(entry.record, { status: 'unavailable', reason: captured.error })
          ns.log.warn(`outbox: sending ${id} without a crop: ${captured.error}`)
          await persist()
        }
      }

      // 2. Send the annotation.
      const reqId = `outbox:${id}`
      const frame = { t: 'anno.create', reqId, record: entry.record }
      if (entry.image) {
        frame.targetImageB64 = entry.image.b64
        frame.targetImageMime = entry.image.mime
      }
      if (!ns.net.send(frame)) {
        scheduleFlushLater(1_000)
        break
      }
      entry.sendAttempts += 1
      sent += 1
      ns.log.debug(`outbox: sent ${id} (${reason})`)

      // 3. Wait for the ack before the next entry, so the host sees the queue
      //    in submission order.
      try {
        await ns.routing.waitForAck(reqId, ACK_TIMEOUT_MS)
      } catch (error) {
        entry.lastError = ns.describeError(error)
        if (entry.sendAttempts >= MAX_SEND_ATTEMPTS) {
          entry.blocked = true
          ns.log.warn(
            `outbox: ${id} was not acknowledged after ${entry.sendAttempts} sends; keeping it queued for a manual flush`,
          )
        } else {
          ns.log.warn(`outbox: no ack for ${id}: ${entry.lastError}`)
        }
        await persist()
        void ns.publishStatus('outbox-unconfirmed')
        scheduleFlushLater(UNCONFIRMED_RETRY_MS)
        break
      }
      await remove(id)
    }
    if (sent > 0) void ns.publishStatus('outbox-flushed')
    return { sent, remaining: items.length, offline: false }
  }

  /** Manual flush used by the popup: blocked entries get a fresh chance. */
  async function flushNow() {
    await load()
    clearBlocked()
    const result = await flush({ reason: 'manual' })
    return { ...result, outbox: summary() }
  }

  ns.outbox = {
    CAPTURE_RETRY_DELAYS_MS,
    MAX_ENTRIES,
    load,
    add,
    remove,
    summary,
    flush,
    flushNow,
    onAck,
    clearBlocked,
    /** @returns {any[]} */
    entries() {
      return items.slice()
    },
  }
})()
