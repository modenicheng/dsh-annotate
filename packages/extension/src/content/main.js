/**
 * dsh-marker content script 4/4 — gestures, messaging, wiring.
 *
 * The gesture layer is deliberately not an overlay element: the shadow host is
 * `pointer-events: none`, so `document.elementsFromPoint` still sees the real
 * page, and window-level capture listeners decide per gesture whether the page
 * gets the event. That is what makes "hover the deepest meaningful element,
 * click to lock it, drag to draw a region, Shift to let native text selection
 * win" one coherent mode instead of three overlapping overlays.
 *
 * Two rules keep that from turning into a pile of rectangles. Exactly one box is
 * on screen at a time: the transient guides belong to the pointer and go away
 * while the composer's locked outline is the subject, and a press that no live
 * button backs is not a gesture at all. And a text selection is never assisted:
 * a Shift-drag gets no `preventDefault` and no marquee, because the browser's
 * own selection is the thing being made.
 *
 * Message contract: `{ type, ...fields }` to the background, flat fields back.
 * Names come from `src/shared/messages.js`; they are repeated here (classic
 * scripts cannot import that ES module) and must be kept identical.
 */
;(function bootMain(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  if (ns.booted) return

  const P = global.__DSH_PROTOCOL__
  if (!P || !ns.anchor || !ns.hydrate || !ns.ui) return

  // Mirrors `packages/extension/src/shared/messages.js` (TO_BACKGROUND,
  // TO_CONTENT, STORAGE_KEYS). Verified by `node --check` only; a rename there
  // is a rename here.
  const MSG = {
    background: {
      submit: 'anno.submit',
      query: 'anno.query',
      status: 'anno.status',
      pickResult: 'anno.pick.result',
      mutate: 'anno.mutate',
      ready: 'anno.content.ready',
      sessions: 'anno.sessions',
      createSession: 'anno.session.create',
      browseDirs: 'anno.fs.dirs',
    },
    content: {
      records: 'anno.records',
      status: 'anno.status',
      pickRequest: 'anno.pick.request',
      pickCancel: 'anno.pick.cancel',
      event: 'anno.event',
      activate: 'anno.activate',
      captureHide: 'anno.capture.hide',
      captureRestore: 'anno.capture.restore',
    },
    prefs: 'anno.prefs',
  }

  const api = global.browser || global.chrome || null
  /**
   * The engine seam (`src/shared/platform.js`, listed first in the
   * content-script list). This script answers `runtime.onMessage` with a
   * promise, which Chromium below 148 silently discards; the shim's wrapper
   * turns that same handler into `sendResponse` + `return true`. Absent on a
   * build that does not list it, where the raw registration is what Gecko
   * documents.
   */
  const platform = global.__DSH_PLATFORM__
  const SHORTCUT_API = global.__DSH_SHORTCUT__
  /** Used only when `src/shared/shortcut.js` did not load (older inject list). */
  const SHORTCUT_DEFAULT = SHORTCUT_API && SHORTCUT_API.DEFAULT ? SHORTCUT_API.DEFAULT : 'Alt+Shift+A'
  const document = global.document
  const REHYDRATE_INTERVAL_MS = 250 // ≤ 4 re-anchor passes per second
  // Route changes share the hydrator's coalescing budget: an SPA router can
  // push several history entries while settling on a view, and each refresh
  // clears the page's marks before re-querying.
  const ROUTE_REFRESH_DEBOUNCE_MS = 250
  /** Parallel host mutations for a bulk clear; the host acks one id at a time. */
  const DELETE_CONCURRENCY = 3

  /** @type {any} */
  let ui = null

  /** Ids with an in-flight delete, so a double click cannot fire twice. */
  const pendingDeletes = new Set()

  const state = {
    active: false,
    activeSource: '',
    hidden: false,
    connected: '',
    connection: '',
    outbox: 0,
    pick: null,
    records: new Map(),
    placements: new Map(),
    anchorState: null,
    // What the page looked like at the instant the user marked it. Everything
    // the record carries is read from here, never from the live document: the
    // element may be gone by the time the comment is written.
    snapshot: null,
    pointer: { down: false, dragging: false, startX: 0, startY: 0, startScroll: { x: 0, y: 0 } },
    /** Shift is held, so the next drag selects text instead of an element. */
    shiftArmed: false,
    selectionGesture: false,
    /** Leave annotation mode after a successful send (pref, default off). */
    exitAfterSend: false,
    /** Leave annotation mode on a page right-click (pref, default on). */
    exitOnRightClick: true,
    consoleErrors: [],
    observer: null,
    scheduler: null,
    hoverFrame: 0,
    hoverPoint: null,
    /** Deepest meaningful element under the pointer; the chain Tab expands from. */
    hoverBase: null,
    /** How many ancestor steps above `hoverBase` the outline sits (Tab widens). */
    hoverLevel: 0,
    scrollFrame: 0,
    prefs: {},
    restricted: '',
    submitting: false,
    /** Confirmed "new session" target for the composer, or null. */
    newSessionChoice: null,
    /** Session the annotation is queued for; empty until the catalog answers. */
    targetId: '',
    /** sessionId → "workspace · title" for the hover cards; the catalog fills it. */
    targetLabels: new Map(),
    /** True once the catalog was asked for those labels, so boot asks once. */
    targetLabelsRequested: false,
    booted: false,
    counts: { total: 0, resolved: 0 },
    countsSignature: '',
    /** Record ids whose highlights are painted on the page right now; '' when none. */
    markedSignature: '',
    clearing: false,
    /** The URL the currently loaded annotations belong to. */
    routeUrl: '',
    routeScheduler: null,
  }
  ns.booted = true
  // Pure URL→document predicate, exported for the route-refresh tests.
  ns.documentChanged = documentChanged

  // ── messaging ──────────────────────────────────────────────────────────────

  function runtimeAvailable() {
    return !!(api && api.runtime && typeof api.runtime.sendMessage === 'function')
  }

  /**
   * Send one flat message. A missing background (reload in flight, tab opened
   * before the extension reloaded) resolves to `undefined` instead of throwing
   * into the page.
   */
  function send(type, fields) {
    if (!runtimeAvailable()) return Promise.resolve(undefined)
    const message = Object.assign({ type }, fields || {})
    try {
      const result = api.runtime.sendMessage(message)
      if (result && typeof result.then === 'function') return result.catch(() => undefined)
      return Promise.resolve(result)
    } catch {
      return Promise.resolve(undefined)
    }
  }

  function normalizeReply(reply) {
    if (reply === undefined || reply === null) return { ok: false }
    if (reply === true) return { ok: true }
    if (typeof reply !== 'object') return { ok: true }
    return reply
  }

  function replyError(reply) {
    if (!reply) return ''
    if (typeof reply.error === 'string' && reply.error !== '') return reply.error
    if (typeof reply.reason === 'string' && reply.reason !== '') return reply.reason
    return ''
  }

  // ── language helpers (the UI owns the tables) ──────────────────────────────

  function t(key) {
    const tables = (ns.ui && ns.ui.STRINGS) || {}
    const language =
      ns.ui && ns.ui.pickLanguage ? ns.ui.pickLanguage(global.navigator && global.navigator.language) : 'en'
    const table = tables[language] || tables.en || {}
    const english = tables.en || {}
    return Object.hasOwn(table, key) ? table[key] : english[key] || key
  }

  /** Replace `{name}` placeholders in a translated template. */
  function fill(template, values) {
    return String(template).replace(/\{(\w+)\}/g, (match, key) =>
      values && Object.hasOwn(values, key) ? String(values[key]) : match,
    )
  }

  /**
   * The stored shortcut, normalized; the default when the preference is absent.
   * Read lazily from `state.prefs` so a popup write applies on the next keydown
   * without a second mirrored field to keep in step.
   */
  function shortcutSpec() {
    if (!SHORTCUT_API || typeof SHORTCUT_API.normalize !== 'function') return SHORTCUT_DEFAULT
    return SHORTCUT_API.normalize(state.prefs && state.prefs.shortcut) || SHORTCUT_DEFAULT
  }

  /**
   * Firefox consumes a command's key before the page sees it, so this matcher is
   * the fallback that makes a custom shortcut work on engines that cannot update
   * a command (Chromium) and the door that stays open if the browser rejected a
   * combination. With no parser loaded it reproduces the original Alt+Shift+A.
   * @param {KeyboardEvent} event
   */
  function isShortcutEvent(event) {
    if (SHORTCUT_API && typeof SHORTCUT_API.matches === 'function') {
      return SHORTCUT_API.matches(event, shortcutSpec())
    }
    const key = String(event.key || '').toLowerCase()
    return event.altKey === true && event.shiftKey === true && (event.code === 'KeyA' || key === 'a')
  }

  // ── restricted documents ───────────────────────────────────────────────────

  /**
   * `about:`, extension pages, the PDF viewer and friends have no annotatable
   * document (or no capturable surface). Entering them must not throw and must
   * not leave a half-mounted UI behind; the background tells the host why.
   */
  function restrictedReason() {
    if (!document || !document.documentElement) return 'no-document'
    const location = global.location || {}
    const protocol = String(location.protocol || '')
    const href = String(location.href || '')
    if (protocol === 'about:' || href.indexOf('about:') === 0) return 'about-page'
    if (
      protocol === 'moz-extension:' ||
      protocol === 'chrome:' ||
      protocol === 'resource:' ||
      protocol === 'view-source:' ||
      protocol === 'data:' ||
      protocol === 'jar:'
    ) {
      return `scheme:${protocol}`
    }
    const contentType = String(document.contentType || '')
    if (contentType === 'application/pdf') return 'pdf-viewer'
    if (/\.pdf(?:$|[?#])/i.test(href)) return 'pdf-viewer'
    if (!document.body) return 'no-body'
    return ''
  }

  // ── page-world console capture ─────────────────────────────────────────────

  /**
   * Page errors are only visible to listeners in the page compartment. That
   * listener is `src/content/console-hook.js`, declared as a `"world": "MAIN"`
   * content_scripts group in the manifest: the engine injects it directly into
   * the page, which both engines support since Firefox 128 (the minimum here)
   * and which no page CSP can block or complain about. It posts
   * `{ __dshAnno: 'console', item }` messages that `onPageMessage` consumes.
   */

  function onPageMessage(event) {
    if (!event || event.source !== global) return
    const data = event.data
    if (!data || typeof data !== 'object' || data.__dshAnno !== 'console') return
    const item = data.item
    if (!item || typeof item !== 'object') return
    // Page-forged messages are accepted as data (never as instructions) and are
    // bounded here so a noisy page cannot grow the record without limit.
    const message = typeof item.message === 'string' ? P.truncate(item.message, 500) : ''
    if (message === '') return
    const entry = {
      kind: typeof item.kind === 'string' ? item.kind.slice(0, 32) : 'error',
      message,
      at: new Date().toISOString(),
    }
    if (typeof item.source === 'string' && item.source !== '') entry.source = P.truncate(item.source, 300)
    if (typeof item.line === 'number' && Number.isFinite(item.line)) entry.line = Math.trunc(item.line)
    state.consoleErrors.push(entry)
    while (state.consoleErrors.length > 10) state.consoleErrors.shift()
  }

  // ── records + badges ───────────────────────────────────────────────────────

  function byCreatedAt(left, right) {
    const a = Date.parse(String(left.createdAt || '')) || 0
    const b = Date.parse(String(right.createdAt || '')) || 0
    if (a !== b) return a - b
    return String(left.id) < String(right.id) ? -1 : 1
  }

  function orderedRecords() {
    return [...state.records.values()].sort(byCreatedAt)
  }

  function recordCounts() {
    let total = 0
    let resolved = 0
    for (const record of state.records.values()) {
      total += 1
      if (record.state === 'resolved') resolved += 1
    }
    return { total, resolved }
  }

  /**
   * Keep the HUD's bulk-clear affordances in step with the store. The badge
   * refresh runs on a 250 ms re-anchor tick, so the counts are compared before
   * anything touches the DOM.
   */
  function updateCounts() {
    const counts = recordCounts()
    const signature = `${counts.total}:${counts.resolved}`
    if (signature === state.countsSignature) return
    state.countsSignature = signature
    state.counts = counts
    syncHud()
  }

  function withObserverPaused(fn) {
    const observer = state.observer
    if (observer) {
      try {
        observer.disconnect()
      } catch {
        // Already disconnected; nothing to pause.
      }
    }
    try {
      return fn()
    } finally {
      if (observer) observeNow()
    }
  }

  /**
   * Re-resolve anchors and repaint badges. Highlighting is a page mutation, so
   * it runs inside a paused observer and only when annotation mode is off —
   * while the user is annotating, marks are removed so captured paths describe
   * the page's real text structure, and the same highlights are painted by the
   * overlay instead.
   *
   * Painting destroys the ranges it was given: wrapping text reparents the text
   * nodes, and a live Range inside a reparented node is reset by the browser (it
   * measures back empty, see `markLineBoxes`). So a placement is only reusable
   * while its text is *not* wrapped; whenever the marks have to be rewritten the
   * whole set is re-resolved rather than reusing those dead ranges.
   */
  function refreshRecords(options) {
    if (!ui) return
    updateCounts()
    const mode = (options && options.mode) || 'stale'
    if (state.hidden) {
      withObserverPaused(() => ns.hydrate.clearMarks())
      state.placements.clear()
      state.markedSignature = ''
      ui.setBadges([])
      ui.setMarkBands([])
      return
    }
    const records = orderedRecords()
    const signature = records.map((record) => record.id).join('|')
    // Re-resolve when the page or the record set changed, when a placement went
    // stale, or when the marks on the page are not the ones these records want.
    const repaint =
      mode === 'all' ||
      signature !== state.markedSignature ||
      state.placements.size !== records.length ||
      records.some((record) => {
        const placement = state.placements.get(record.id)
        return !placement || !ns.hydrate.isFresh(placement)
      })
    if (repaint) {
      withObserverPaused(() => ns.hydrate.clearMarks())
      state.placements.clear()
      for (const item of ns.hydrate.resolveAll(records, document)) {
        state.placements.set(item.record.id, item.placement)
      }
      for (const id of [...state.placements.keys()]) {
        if (!state.records.has(id)) state.placements.delete(id)
      }
    }
    const items = badgeItems()
    ui.setBadges(items)
    if (state.active) {
      // Annotating: the page may not carry our `<mark>` elements, so the overlay
      // draws the marks it already knows about. Re-measured every pass because a
      // reflow moves the words, and nothing is wrapped while the mode is on.
      state.markedSignature = ''
      ui.setMarkBands(bandItems(placementsOf(items)))
    } else if (repaint) {
      ui.setMarkBands([])
      withObserverPaused(() => ns.hydrate.applyMarks(placementsOf(items)))
      state.markedSignature = signature
    }
    ensureTargetLabels()
  }

  /**
   * The badge layer's view of the current records, in display order. A record
   * whose anchor could not be resolved has no place on the page and no badge.
   */
  function badgeItems() {
    const items = []
    const ordered = orderedRecords()
    for (let index = 0; index < ordered.length; index += 1) {
      const record = ordered[index]
      const placement = state.placements.get(record.id)
      if (!placement) continue
      items.push({
        id: record.id,
        index: index + 1,
        pageRect: placement.pageRect,
        state: record.state || 'open',
        comment: record.comment || '',
        summary: summaryOf(record.anchor),
        note: record.resolution && typeof record.resolution.note === 'string' ? record.resolution.note : '',
        kind: record.anchor && record.anchor.kind ? record.anchor.kind : '',
        target: targetLabelOf(record),
      })
    }
    return items
  }

  /** The placements behind `badgeItems()`, in the same order. */
  function placementsOf(items) {
    const placements = []
    for (const item of items) {
      const placement = state.placements.get(item.id)
      if (placement) placements.push({ record: state.records.get(item.id), placement })
    }
    return placements
  }

  /**
   * Line boxes for the marks already on the page, in document coordinates.
   * Only the marks on screen are measured: a page can carry hundreds of them and
   * this runs on the re-anchor tick.
   */
  function bandItems(placements) {
    const items = []
    const view = viewportSize()
    const scroll = { x: Number(global.scrollX) || 0, y: Number(global.scrollY) || 0 }
    const above = scroll.y - view.height
    const below = scroll.y + view.height * 2
    for (const item of placements) {
      const record = item.record
      const placement = item.placement
      if (!placement || !placement.range) continue
      if (!record.anchor || record.anchor.kind !== 'selection') continue
      const pageRect = placement.pageRect || { x: 0, y: 0, w: 0, h: 0 }
      if (pageRect.y + pageRect.h < above || pageRect.y > below) continue
      const lines = ns.geom.markLineRects(placement.range)
      if (lines.length > 0) items.push({ id: record.id, lines })
    }
    return items
  }

  /**
   * Line boxes of one marked text whose badge is hovered, in document
   * coordinates, so the overlay bands the words instead of boxing the whole
   * paragraph. `null` keeps the box: the record is an element or a region, its
   * placement is gone (a stale anchor), or its range no longer measures. Hover
   * must never throw, so every failure is just "no lines".
   * @param {any} item the badge item `ui.setBadges` was given
   * @returns {{x:number,y:number,w:number,h:number}[]|null}
   */
  function badgeLines(item) {
    try {
      if (!item || item.kind !== 'selection') return null
      // At rest the highlight is a real `<mark>`, and the placement's range died
      // when that mark was painted; read the geometry back from the mark. While
      // annotating there is no mark on purpose, so the placement's range is the
      // live one.
      let lines = ns.hydrate.markLineBoxes(item.id)
      if (lines.length === 0) {
        const placement = state.placements.get(item.id)
        if (placement && placement.range) lines = ns.geom.markLineRects(placement.range)
      }
      return Array.isArray(lines) && lines.length > 0 ? lines : null
    } catch {
      // A range the page replaced under us: the marker falls back to its box.
      return null
    }
  }

  function upsertRecord(record) {
    if (!record || typeof record.id !== 'string') return
    state.records.set(record.id, record)
    refreshRecords({ mode: 'stale' })
  }

  function removeRecord(id) {
    if (!state.records.delete(id)) return
    state.placements.delete(id)
    // A bulk clear repaints once when it finishes; repainting on each host
    // broadcast would re-anchor the page once per deleted annotation.
    if (state.clearing) return
    refreshRecords({ mode: 'stale' })
  }

  function replaceRecords(list) {
    state.records.clear()
    for (const record of Array.isArray(list) ? list : []) {
      if (record && typeof record.id === 'string') state.records.set(record.id, record)
    }
    refreshRecords({ mode: 'all' })
  }

  function queryRecords() {
    return send(MSG.background.query, { url: String((global.location && global.location.href) || '') }).then(
      (reply) => {
        const normalized = normalizeReply(reply)
        if (normalized.ok === false) return
        if (Array.isArray(normalized.records)) replaceRecords(normalized.records)
      },
    )
  }

  // ── SPA route changes ──────────────────────────────────────────────────────

  /**
   * Whether `prev` and `next` point at different *documents*, in the same
   * sense the store uses: query and hash alone never separate annotations, so
   * they must not separate a refresh either. Exposed on `ns` for tests.
   * @param {string} prev
   * @param {string} next
   * @returns {boolean}
   */
  function documentChanged(prev, next) {
    if (typeof prev !== 'string' || prev === '') return typeof next === 'string' && next !== ''
    return !P.sameDocument({ url: prev }, next)
  }

  function currentHref() {
    return String((global.location && global.location.href) || '')
  }

  /**
   * A history event may or may not have moved the document: the scheduler runs
   * later, so the comparison is deferred to the moment of the refresh, where
   * `location.href` is what the page settled on (routers often push and then
   * immediately replace while booting a view).
   */
  function onPossibleRouteChange() {
    if (documentChanged(state.routeUrl, currentHref())) state.routeScheduler.request()
  }

  /**
   * The document moved: the old marks are pinned into DOM the router may have
   * replaced, so they come off first — even if the re-query fails, the page
   * must not keep the previous route's annotations. `queryRecords` →
   * `replaceRecords` then repaints for the new URL.
   */
  function onRouteRefresh() {
    if (!documentChanged(state.routeUrl, currentHref())) return
    state.routeUrl = currentHref()
    withObserverPaused(() => ns.hydrate.clearMarks())
    state.placements.clear()
    state.markedSignature = ''
    void queryRecords()
  }

  /**
   * Routers navigate through `history.pushState/replaceState` with no event we
   * could otherwise see. The wrappers are transparent — same `this`, same
   * arguments, same return value — and only ask whether a refresh is needed;
   * a page whose history object refuses patching simply keeps the
   * `popstate`/`hashchange` fallbacks.
   */
  function patchHistory() {
    const history = global.history
    if (!history || typeof history.pushState !== 'function' || typeof history.replaceState !== 'function') return
    if (history.__dshAnnoRoutes) return
    try {
      for (const name of ['pushState', 'replaceState']) {
        const original = history[name]
        history[name] = function patchedState(...args) {
          const result = original.apply(this, args)
          onPossibleRouteChange()
          return result
        }
      }
      history.__dshAnnoRoutes = true
    } catch {
      // Sealed or frozen history: popstate/hashchange still cover the user.
    }
  }

  // ── deleting annotations ───────────────────────────────────────────────────

  /**
   * Delete one annotation through the host. The record is dropped from the page
   * only after the host acknowledges, so a failed delete leaves the marker (and
   * the user's text) where it was.
   * @param {string} id
   * @param {{ batch?: boolean }} [options] batch skips the per-record repaint
   * @returns {Promise<{ ok: boolean, error?: string, skipped?: boolean }>}
   */
  function deleteOne(id, options) {
    const recordId = String(id || '')
    if (recordId === '' || pendingDeletes.has(recordId)) return Promise.resolve({ ok: false, skipped: true })
    const batch = options !== undefined && options !== null && options.batch === true
    pendingDeletes.add(recordId)
    if (ui) ui.setBadgePending(recordId, true)
    return send(MSG.background.mutate, { id: recordId, action: 'delete' }).then((reply) => {
      const normalized = normalizeReply(reply)
      pendingDeletes.delete(recordId)
      if (normalized.ok === false) {
        if (ui) ui.setBadgePending(recordId, false)
        return { ok: false, error: replyError(normalized) }
      }
      if (batch) {
        // A bulk clear deletes dozens of ids; repainting after each one would
        // re-anchor the whole page N times. Drop the record and repaint once.
        state.records.delete(recordId)
        state.placements.delete(recordId)
      } else {
        removeRecord(recordId)
      }
      return { ok: true }
    })
  }

  /** @param {string} id */
  function handleDelete(id) {
    if (!ui) return
    const recordId = String(id || '')
    if (recordId === '' || !state.records.has(recordId)) return
    void deleteOne(recordId).then((result) => {
      if (result.ok) ui.toast(t('deletedOne'), 'ok')
      else if (!result.skipped) ui.toast(result.error || t('deleteFailed'), 'error')
    })
  }

  /**
   * Delete every id with a small parallel pool. The bridge acknowledges one id
   * per `anno.mutate` frame, so a bulk action is a fan-out of single deletes;
   * the pool keeps a 200-annotation page from opening 200 at once.
   * @param {string[]} ids
   */
  function deleteMany(ids) {
    const total = ids.length
    const failures = []
    let done = 0
    let cursor = 0
    const worker = () => {
      if (cursor >= ids.length) return Promise.resolve()
      const id = ids[cursor]
      cursor += 1
      return deleteOne(id, { batch: true }).then((result) => {
        if (!result.ok && result.skipped !== true) failures.push(result.error || '')
        done += 1
        if (ui && total > 1) ui.setClearProgress(done, total)
        return worker()
      })
    }
    const lanes = []
    for (let index = 0; index < Math.min(DELETE_CONCURRENCY, total); index += 1) lanes.push(worker())
    return Promise.all(lanes).then(() => ({ total, failed: failures.length, error: failures[0] || '' }))
  }

  /** @param {'all'|'resolved'} kind */
  function handleClear(kind) {
    if (!ui || state.clearing) return
    const target = kind === 'resolved' ? 'resolved' : 'all'
    const records =
      target === 'resolved' ? orderedRecords().filter((record) => record.state === 'resolved') : orderedRecords()
    if (records.length === 0) {
      ui.toast(target === 'resolved' ? t('clearNothingResolved') : t('clearNothing'))
      return
    }
    state.clearing = true
    ui.setClearBusy(true, target)
    ui.setClearProgress(0, records.length)
    void deleteMany(records.map((record) => record.id)).then((result) => {
      state.clearing = false
      ui.setClearBusy(false)
      if (result.failed === 0) ui.toast(fill(t('clearedCount'), { n: result.total }), 'ok')
      else if (result.failed === result.total) ui.toast(result.error || t('deleteFailed'), 'error')
      else ui.toast(fill(t('clearedPartial'), { n: result.total - result.failed, failed: result.failed }), 'error')
      refreshRecords({ mode: 'stale' })
    })
  }

  // ── annotation mode ────────────────────────────────────────────────────────

  function activeMode() {
    return state.pick && state.pick.mode ? state.pick.mode : 'auto'
  }

  function syncHud() {
    if (!ui) return
    ui.setHud({ visible: state.active, mode: activeMode(), connected: state.connected, counts: state.counts })
  }

  function enterMode(source, options) {
    const config = options || {}
    if (state.restricted) return
    if (state.hidden) {
      // An explicit activation always reveals the layers: activating while
      // hidden would otherwise look like nothing happened.
      state.hidden = false
      ui.setHidden(false)
      persistPrefs()
    }
    state.activeSource = source || 'user'
    if (!state.active) {
      state.active = true
      ui.setHud({ visible: true, mode: activeMode(), connected: state.connected })
      // A selection made before activation goes straight to the composer. It is
      // read *before* the repaint below: leaving annotation mode is what makes
      // the page carry our `<mark>` elements, and re-resolving here unwraps them
      // (a normalize that merges the text nodes under a live Selection), so a
      // capture taken afterwards would describe a different run of text.
      if (!config.skipSelection) captureExistingSelection()
      // The marks already on the page move from the text itself to the overlay:
      // the page may not carry our nodes while a capture is reading it.
      refreshRecords({ mode: 'all' })
    } else {
      syncHud()
    }
  }

  function captureExistingSelection() {
    const selection = global.getSelection ? global.getSelection() : null
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    const captured = ns.anchor.selection(selection)
    if (captured) openComposerFor(captured)
  }

  function leaveMode(reason) {
    if (!state.active) return
    state.active = false
    state.activeSource = ''
    const pick = state.pick
    state.pick = null
    // The gesture is over before the anchor goes: leaving the mode with the
    // button down must still leave the page without a leftover highlight.
    resetPointer()
    state.shiftArmed = false
    resetHoverChain()
    clearAnchor()
    if (ui) {
      if (ui.isComposerOpen()) ui.closeComposer()
      ui.clearLocked()
      ui.setHover(null)
      ui.setMarquee(null)
      ui.setCursor(null)
      ui.setShiftDrop(null)
      ui.setPickBanner(null)
      ui.setHud({ visible: false })
    }
    // Leaving annotation mode without answering an outstanding pick would hang
    // the agent until its timeout, so answer it now.
    if (pick && reason !== 'pick-done' && reason !== 'pick-cancelled') {
      void send(MSG.background.pickResult, { pickId: pick.pickId, ok: false, reason: 'cancelled' })
    }
    refreshRecords({ mode: 'stale' })
  }

  function toggleMode() {
    if (state.active) leaveMode('toggle')
    else enterMode('user')
  }

  // ── composer ───────────────────────────────────────────────────────────────

  /** The annotation being written, and the frame it was written in. */
  function clearAnchor() {
    state.anchorState = null
    state.snapshot = null
    // The mark and its highlight end together: a selection left on the page is
    // the anchor the browser would extend from on the next Shift-drag, which is
    // how a new selection ended up starting at the previous one. A press in
    // flight owns the selection until it is read on release.
    if (state.selectionGesture || state.pointer.down) return
    const selection = global.getSelection ? global.getSelection() : null
    if (!selection || selection.isCollapsed) return
    try {
      selection.removeAllRanges()
    } catch {
      // A detached or chrome-owned selection: nothing we can drop.
    }
  }

  function summaryOf(anchor) {
    if (!anchor) return ''
    if (anchor.kind === 'selection') {
      const exact = anchor.quote && typeof anchor.quote.exact === 'string' ? anchor.quote.exact : ''
      return `“${P.truncate(exact, 48)}”`
    }
    if (anchor.kind === 'element') {
      const fingerprint = anchor.fingerprint || {}
      const tag = fingerprint.tag ? String(fingerprint.tag) : 'element'
      const text = fingerprint.textExcerpt ? P.truncate(String(fingerprint.textExcerpt), 36) : ''
      return text ? `<${tag}> ${text}` : `<${tag}>`
    }
    const pageRect = anchor.pageRect || { w: 0, h: 0 }
    return `${Math.round(pageRect.w)}×${Math.round(pageRect.h)}`
  }

  /**
   * The bands a text mark is drawn with. `lines` is empty when the range could
   * not be measured (a page that re-rendered between the drag and the read), and
   * then the mark's whole box is banded rather than outlined: a text mark is
   * underlined, never boxed.
   * @param {{x:number,y:number,w:number,h:number}[]|undefined} lines page rects
   * @param {{x:number,y:number,w:number,h:number}} viewportRect fallback, viewport pixels
   */
  function selectionLines(lines, viewportRect) {
    if (Array.isArray(lines) && lines.length > 0) return lines
    return [ns.geom.roundRect(ns.geom.viewportToPage(viewportRect))]
  }

  function openComposerFor(anchorState) {
    if (!anchorState || !anchorState.anchor) {
      if (ui) ui.toast(t('anchorFailed'), 'error')
      return
    }
    const errors = ns.anchor.validate(anchorState.anchor)
    if (errors.length > 0) {
      if (ui) ui.toast(`${t('anchorInvalid')}: ${errors[0]}`, 'error')
      return
    }
    state.anchorState = anchorState
    const rect =
      anchorState.viewportRect ||
      ns.geom.pageToViewport(anchorState.anchor.rect || anchorState.anchor.pageRect || { x: 0, y: 0, w: 0, h: 0 })
    // Freeze the viewport the click happened in, together with the crop it
    // implies. Scrolling or resizing before the comment is sent must not move
    // what the screenshot covers, or the card and the quote would describe two
    // different moments.
    state.snapshot = {
      at: new Date().toISOString(),
      viewport: snapshotViewport(),
      rect: cropRectForViewport(rect, viewportSize()),
    }
    ui.setHover(null)
    ui.setMarquee(null)
    ui.setCursor(null)
    ui.setShiftDrop(null)
    // The gesture is over: the next mark starts from the deepest element
    // again, not from whatever level this one was widened to.
    resetHoverChain()
    // Keep the target outlined while the comment is written: the outline is the
    // subject of the sentence, and losing it forces the user to remember which
    // of five similar buttons they clicked. A marked text is drawn as its line
    // boxes instead — underlined bands, never a box around the paragraph, which
    // says nothing about which words were picked — and the composer's own focus
    // takes the browser's selection highlight away the moment it opens.
    const lines = anchorState.anchor.kind === 'selection' ? selectionLines(anchorState.lineRects, rect) : null
    // An element or a region is outlined by its page rect, so scrolling keeps the
    // outline on the subject; a marked text is outlined by its lines instead.
    const subject = anchorState.anchor.rect || anchorState.anchor.pageRect || null
    ui.setLocked(ns.geom.roundRect(rect), summaryOf(anchorState.anchor), 'composer', subject, lines)
    ui.openComposer({
      kind: anchorState.anchor.kind,
      summary: summaryOf(anchorState.anchor),
      rect: ns.geom.roundRect(rect),
    })
    void loadTargets()
  }

  function handleCancel() {
    if (!ui) return
    const pick = state.pick
    ui.closeComposer()
    clearAnchor()
    if (!pick) return
    state.pick = null
    ui.setPickBanner(null)
    syncHud()
    void send(MSG.background.pickResult, { pickId: pick.pickId, ok: false, reason: 'cancelled' })
    if (state.activeSource === 'pick') leaveMode('pick-cancelled')
  }

  function buildDraft(anchor, comment, intent) {
    const draft = {
      url: String((global.location && global.location.href) || ''),
      title: String((document && document.title) || ''),
      anchor,
      comment: String(comment == null ? '' : comment).slice(0, P.LIMITS.commentChars),
      pageContext: ns.anchor.pageContext(state.consoleErrors),
    }
    // The frozen click-time frame, so the reader can date the annotation and
    // reproduce the crop instead of guessing what the page looked like.
    if (state.snapshot) draft.snapshot = state.snapshot
    if (intent) draft.intent = intent
    // A picked target turns the annotation into a queued mention: the Host
    // stores it, the Web Client appends it to that Session's composer. The label
    // is written even when no target was picked, because the Host routes an
    // untargeted annotation to the Session the user is looking at and would
    // otherwise have to name the chip itself — in a language it does not share
    // with this page.
    draft.routing = {
      source: 'user',
      ...(state.targetId === '' ? {} : { sessionId: state.targetId }),
      label: fill(t('chipLabel'), { summary: summaryOf(anchor) }),
    }
    return draft
  }

  /**
   * The label a hover card names a routed Session with: "workspace · title"
   * when the catalog knows it, the short id when it does not (the Session can
   * be gone or younger than the catalog's cache), and '' for a record that
   * never named a target.
   * @param {any} record
   */
  function targetLabelOf(record) {
    const routing = record && record.routing
    const id = routing && typeof routing.sessionId === 'string' ? routing.sessionId : ''
    if (id === '') return ''
    const known = state.targetLabels.get(id)
    if (known) return known
    const short = id.replace(/^session-/, '').slice(0, 8)
    return `${t('sentToSession')} ${short}`
  }

  /**
   * Rebuild the hover-card labels from the catalog the Host just answered with.
   * @param {any[]} items
   */
  function setTargetLabels(items) {
    const map = new Map()
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item.id !== 'string' || item.id === '') continue
      const workspace = typeof item.workspace === 'object' && item.workspace !== null ? item.workspace : null
      const name = String((workspace && workspace.title) || '').trim()
      const title = String(item.title || '').trim()
      map.set(item.id, name === '' ? title : title === '' ? name : `${name} · ${title}`)
    }
    state.targetLabels = map
  }

  /**
   * Fill the hover-card labels once per page, as soon as there is a record that
   * names a Session: a card opened before the user ever touches the composer
   * would otherwise fall back to a short id. The composer's own refresh will
   * pick up a later catalog change anyway.
   */
  function ensureTargetLabels() {
    if (state.targetLabelsRequested) return
    if (state.records.size === 0) return
    if (state.targetLabels.size > 0) return
    state.targetLabelsRequested = true
    void loadTargets()
  }

  /**
   * Refresh the Session catalog behind the composer's target picker. The Host
   * owns the list; a failure here must not block writing the annotation.
   * @param {boolean} [force]
   */
  function loadTargets(force) {
    if (!ui) return Promise.resolve()
    const failed = (reason) => {
      if (ui) ui.setTargets([], '', reason || t('targetFailed'))
    }
    return Promise.resolve(send(MSG.background.sessions, force === true ? { force: true } : {})).then(
      (reply) => {
        if (!ui) return
        if (!reply || reply.ok !== true) {
          failed(replyError(reply))
          ui.setNewSessionAvailable(state.connection === 'connected' || state.connection === 'open')
          return
        }
        ui.setNewSessionAvailable(true)
        setTargetLabels(reply.items)
        ui.setTargets(
          Array.isArray(reply.items) ? reply.items : [],
          reply.defaultSessionId || '',
          '',
          Array.isArray(reply.workspaces) ? reply.workspaces : [],
        )
        // Cards opened before the catalog answered show short ids; repaint them
        // with the names the catalog just supplied. Only the badges change, so
        // the page's highlights are left alone.
        ui.setBadges(badgeItems())
      },
      (error) => {
        failed(String(error && error.message ? error.message : error))
        if (ui) ui.setNewSessionAvailable(state.connection === 'connected' || state.connection === 'open')
      },
    )
  }

  function viewportSize() {
    return {
      width: Math.round(Number(global.innerWidth) || 0),
      height: Math.round(Number(global.innerHeight) || 0),
      devicePixelRatio: Math.round((Number(global.devicePixelRatio) || 1) * 100) / 100,
    }
  }

  /** The viewport as it is right now, in the shape a snapshot records it. */
  function snapshotViewport() {
    const size = viewportSize()
    return {
      width: size.width,
      height: size.height,
      dpr: size.devicePixelRatio,
      scrollX: Math.round(Number(global.scrollX) || 0),
      scrollY: Math.round(Number(global.scrollY) || 0),
    }
  }

  /** One rect clipped to the viewport that was current when it was measured. */
  function cropRectForViewport(viewportRect, size) {
    const box = size || viewportSize()
    const live = viewportRect || { x: 0, y: 0, w: 0, h: 0 }
    const clipped = ns.geom.intersection(ns.geom.roundRect(live), { x: 0, y: 0, w: box.width, h: box.height })
    return ns.geom.roundRect(clipped)
  }

  /**
   * The crop for the annotation being written: the rect frozen at click time.
   *
   * Re-measuring a live element here was the old behaviour, and it was wrong in
   * a way a reader cannot see — scroll the page while writing the comment and
   * the screenshot covered a different box than the anchor, the label, and the
   * hover card all described. Measurement only falls back to the live element
   * when the click-time rect is missing, which happens for an anchor restored
   * from an older draft.
   */
  function cropRectFor(anchorState) {
    if (state.snapshot) return state.snapshot.rect
    return cropRectForViewport(ns.anchor.liveViewportRect(anchorState))
  }

  function finishPickSuccess(pick) {
    if (!pick) return
    state.pick = null
    if (ui) ui.setPickBanner(null)
    syncHud()
    if (state.activeSource === 'pick') leaveMode('pick-done')
  }

  /**
   * A pick is answered with one `anno.pick.result` carrying the draft plus the
   * crop rect: the background owns id creation and the screenshot, then relays
   * to the host. The submit fallback keeps an older background working.
   */
  function sendPickAnswer(pick, draft, cropRect, viewport) {
    return send(MSG.background.pickResult, { pickId: pick.pickId, ok: true, record: draft, cropRect, viewport }).then(
      (reply) => {
        const normalized = normalizeReply(reply)
        if (normalized.ok !== false) return normalized
        return send(MSG.background.submit, {
          record: draft,
          cropRect,
          viewport,
          pickId: pick.pickId,
        }).then((fallback) => {
          const second = normalizeReply(fallback)
          if (second.ok === false || !second.record || typeof second.record.id !== 'string') return second
          return send(MSG.background.pickResult, { pickId: pick.pickId, ok: true, record: second.record }).then(
            () => second,
          )
        })
      },
    )
  }

  /**
   * Create the session the composer's target asked for, when it did. Runs
   * before the annotation is submitted so the mention routes to the new
   * conversation; a failure keeps the composer open with the comment intact.
   * @returns {Promise<{ ok: boolean, sessionId?: string, error?: string }>}
   */
  function ensureNewSession() {
    const choice = state.newSessionChoice
    if (!choice) return Promise.resolve({ ok: true })
    return Promise.resolve(
      send(MSG.background.createSession, {
        mode: choice.mode,
        ...(choice.workspaceId ? { workspaceId: choice.workspaceId } : {}),
        ...(choice.path ? { path: choice.path } : {}),
        ...(choice.title ? { title: choice.title } : {}),
      }),
    ).then((reply) => {
      const normalized = normalizeReply(reply)
      if (normalized.ok === false) return { ok: false, error: replyError(normalized) || t('createFailed') }
      if (!normalized.sessionId) return { ok: false, error: t('createFailed') }
      return { ok: true, sessionId: normalized.sessionId }
    })
  }

  function handleSend(payload) {
    if (!ui) return
    const anchorState = state.anchorState
    if (!anchorState || state.submitting) return
    const text = payload && typeof payload.text === 'string' ? payload.text : ''
    const intent = payload && typeof payload.intent === 'string' ? payload.intent : ''
    const pick = state.pick
    const draft = buildDraft(anchorState.anchor, text, intent)
    const cropRect = cropRectFor(anchorState)
    const viewport = viewportSize()
    state.submitting = true
    ui.setComposerError('')
    ui.setComposerBusy(true)

    // A "new session" target needs its session to exist before the annotation
    // names it; the two steps are deliberately not queued as one.
    const request = ensureNewSession().then((created) => {
      if (created.ok !== true) return { ok: false, error: created.error || t('createFailed') }
      if (created.sessionId) {
        draft.routing = { ...draft.routing, sessionId: created.sessionId }
        state.targetId = created.sessionId
      }
      return pick
        ? sendPickAnswer(pick, draft, cropRect, viewport)
        : send(MSG.background.submit, { record: draft, cropRect, viewport }).then(normalizeReply)
    })

    request.then((reply) => {
      state.submitting = false
      if (!ui) return
      const normalized = normalizeReply(reply)
      if (normalized.ok === false) {
        ui.setComposerBusy(false)
        const reason = replyError(normalized)
        ui.setComposerError(reason || t('sendFailed'))
        return
      }
      state.newSessionChoice = null
      ui.setComposerBusy(false)
      ui.closeComposer()
      clearAnchor()
      // The optimistic badge needs an id; an older background may omit the
      // record, in which case a query fills the gap.
      if (normalized.record && typeof normalized.record.id === 'string') upsertRecord(normalized.record)
      else void queryRecords()
      finishPickSuccess(pick)
      // An annotation without a comment is the mark alone; say which one was
      // sent instead of implying words the user never wrote.
      ui.toast(draft.comment === '' ? t('savedMark') : t('saved'), 'ok')
      // "Exit after sending" is opt-in: most people mark several things in a
      // row, and leaving the mode after the first one would break that flow.
      // It runs only here, after the host acknowledged the annotation.
      if (state.exitAfterSend) leaveMode('sent')
    })
  }

  // ── pick lifecycle ─────────────────────────────────────────────────────────

  function normalizePickMode(value) {
    return value === 'selection' || value === 'element' || value === 'region' ? value : 'auto'
  }

  function handlePickRequest(message) {
    const pickId = String(message.pickId || '')
    if (!pickId) return
    state.pick = {
      pickId,
      mode: normalizePickMode(message.mode),
      prompt: String(message.prompt || ''),
      timeoutMs: Number(message.timeoutMs) || 0,
    }
    if (ui) ui.setPickBanner({ prompt: state.pick.prompt, mode: state.pick.mode })
    // Never discard an open composer: the draft the user is writing wins and
    // becomes the pick answer on send.
    if (!ui.isComposerOpen()) enterMode('pick')
    else syncHud()
  }

  function handlePickCancel(message) {
    if (!state.pick) return
    if (message.pickId && String(message.pickId) !== state.pick.pickId) return
    state.pick = null
    clearAnchor()
    if (ui) {
      ui.setPickBanner(null)
      if (ui.isComposerOpen()) ui.closeComposer()
      ui.toast(t('pickCancelled'))
    }
    if (state.activeSource === 'pick') leaveMode('pick-cancelled')
    else syncHud()
  }

  // ── gestures ───────────────────────────────────────────────────────────────

  function marqueeRect(x, y) {
    // The press was captured in one viewport, the drag continues in whatever
    // viewport a mid-drag scroll (wheel, autoscroll) has moved to. Shift the
    // recorded start by the scroll delta so the rectangle keeps tracking the
    // content the user started on; the anchor that lands is clamped, so a
    // runaway delta cannot persist a bad rect.
    // Scrolling moves the content, so the recorded start drifts with it: with
    // the page scrolled further down by `delta`, the pressed point now sits
    // `delta` higher in the viewport.
    const deltaX = state.pointer.startScroll.x - (Number(global.scrollX) || 0)
    const deltaY = state.pointer.startScroll.y - (Number(global.scrollY) || 0)
    const startX = state.pointer.startX + deltaX
    const startY = state.pointer.startY + deltaY
    return ns.geom.normalizeRect({
      x: startX,
      y: startY,
      w: x - startX,
      h: y - startY,
    })
  }

  /**
   * Drop a press no live button is backing. A pointerup that never arrives — the
   * button was released outside the window, or the page swallowed the event —
   * otherwise leaves `down` set, and the next plain move paints a marquee
   * anchored at that stale press instead of at the pointer.
   */
  function resetPointer() {
    state.pointer.down = false
    state.pointer.dragging = false
    state.selectionGesture = false
  }

  /**
   * Move the document's selection to the press point before the browser acts on
   * the gesture. Shift-drag *extends* the selection the page already has, so
   * without this a new drag starts wherever the previous mark ended — the bottom
   * of the page as often as not — instead of under the pointer.
   */
  function collapseSelectionTo(x, y) {
    const selection = global.getSelection ? global.getSelection() : null
    if (!selection) return
    try {
      const point = ns.anchor.caretPosition(x, y)
      if (point) selection.collapse(point.node, point.offset)
      else selection.removeAllRanges()
    } catch {
      // A detached or chrome-owned selection: the browser's own anchor will do.
    }
  }

  function scheduleHover(x, y) {
    state.hoverPoint = { x, y }
    if (state.hoverFrame) return
    state.hoverFrame = global.requestAnimationFrame(() => {
      state.hoverFrame = 0
      const point = state.hoverPoint
      if (!point || !state.active || state.hidden) return
      updateHover(point.x, point.y)
    })
  }

  /**
   * The pointer is offering a text selection right now: Shift armed it before
   * the press, or the drag that is running started as one. An open composer
   * owns the scene already, so hovering beside it offers nothing.
   */
  function textSelectionArmed() {
    if (state.selectionGesture) return true
    return state.shiftArmed && !ui.isComposerOpen()
  }

  /**
   * Paint what the pointer means — the drop for a text selection, the element
   * outline otherwise — and never both. A region drag owns the marquee, so it
   * is left alone.
   */
  function syncPointerGuide() {
    if (!ui || state.pointer.dragging) return
    if (!state.active || state.hidden) {
      ui.setShiftDrop(null)
      return
    }
    if (textSelectionArmed()) {
      ui.setHover(null)
      ui.setCursor(null)
      ui.setShiftDrop(state.hoverPoint ? { x: state.hoverPoint.x, y: state.hoverPoint.y } : null)
      return
    }
    ui.setShiftDrop(null)
    if (state.hoverPoint) scheduleHover(state.hoverPoint.x, state.hoverPoint.y)
  }

  function setShiftArmed(armed) {
    const value = armed === true
    if (state.shiftArmed === value) return
    state.shiftArmed = value
    syncPointerGuide()
  }

  /**
   * Drop the Tab-expansion chain. Called wherever the hover outline stops
   * being painted from it, so a stale level can never outlive its subject.
   */
  function resetHoverChain() {
    state.hoverBase = null
    state.hoverLevel = 0
  }

  /**
   * The element the pointer means, with any Tab expansion applied. The chain
   * is anchored to the deepest element under the pointer: moving to a
   * different one keeps the expanded outline while the pointer stays inside
   * it (the level rebases onto the new chain, so the outline itself never
   * flickers to a sibling), and collapses back to level 0 the moment the
   * pointer leaves the subject.
   * @param {Element|null} base deepest meaningful element under the pointer
   * @returns {Element|null}
   */
  function subjectFor(base) {
    if (!base) {
      resetHoverChain()
      return null
    }
    if (state.hoverBase === base) return ns.anchor.ancestorAt(base, state.hoverLevel)
    if (state.hoverBase && state.hoverLevel > 0) {
      const subject = ns.anchor.ancestorAt(state.hoverBase, state.hoverLevel)
      const steps = ns.anchor.stepsTo(base, subject)
      if (steps >= 0) {
        state.hoverBase = base
        state.hoverLevel = steps
        return subject
      }
    }
    state.hoverBase = base
    state.hoverLevel = 0
    return base
  }

  /**
   * The chip text for the current outline. The level marker is a glyph, so it
   * needs no translation and stays short next to the tag chip.
   */
  function hoverLabelOf(subject, rect) {
    const label = ns.anchor.chipLabel(subject, rect)
    return state.hoverLevel > 0 ? `${label} · ↑${state.hoverLevel}` : label
  }

  function updateHover(x, y) {
    if (!ui) return
    // While the composer is open its amber outline already answers "what am I
    // writing about?". A second box under the pointer competes with it, and the
    // user has to work out which of the two the annotation refers to.
    if (ui.isComposerOpen()) {
      resetHoverChain()
      ui.setHover(null)
      ui.setCursor(null)
      return
    }
    if (activeMode() === 'selection') {
      resetHoverChain()
      ui.setHover(null)
      ui.setCursor({ x, y })
      return
    }
    ui.setCursor({ x, y })
    const subject = subjectFor(ns.anchor.meaningfulAt(x, y))
    if (!subject) {
      ui.setHover(null)
      return
    }
    const rect = ns.geom.rectOf(subject.getBoundingClientRect())
    ui.setHover({ rect, label: hoverLabelOf(subject, rect) })
  }

  /**
   * Tab widens the outlined element one ancestor; Shift+Tab narrows it back
   * down. Both only mean this while a hover subject exists and nothing else
   * owns the keyboard: an open composer needs Tab for its own focus cycle, a
   * selection-mode pick has no element subject, and a press in flight owns
   * the gesture. The key is swallowed whenever a subject exists — even where
   * the level cannot move (top of the chain, or already back at the deepest
   * element) — because letting Tab fall through would hand the browser's
   * focus ring to the page mid-pick, and the next Esc or Tab would land
   * somewhere the gesture layer cannot see.
   */
  function handleHierarchyKey(event) {
    if (!state.active || state.hidden) return
    if (ns.text.isOurs(event.target)) return
    if (!ui || ui.isComposerOpen()) return
    if (state.pointer.down || state.pointer.dragging || state.selectionGesture) return
    if (activeMode() === 'selection') return
    if (!state.hoverBase) return
    // Tab means element picking, so a Shift that armed text selection stands
    // down: otherwise the selection drop and the outline would both claim the
    // pointer.
    if (state.shiftArmed) setShiftArmed(false)
    const target = event.shiftKey ? state.hoverLevel - 1 : state.hoverLevel + 1
    // `stepsTo` turns the clamped result back into the level that produced it,
    // so Tabbing past the outermost wrapper just stays there.
    state.hoverLevel = Math.max(0, ns.anchor.stepsTo(state.hoverBase, ns.anchor.ancestorAt(state.hoverBase, target)))
    const point = state.hoverPoint
    if (point) updateHover(point.x, point.y)
    event.preventDefault()
    event.stopPropagation()
  }

  function onPointerDown(event) {
    if (!state.active || event.button !== 0) return
    if (ns.text.isOurs(event.target)) return
    const mode = activeMode()
    state.hoverPoint = { x: event.clientX, y: event.clientY }
    state.pointer.startX = event.clientX
    state.pointer.startY = event.clientY
    // Remember the viewport the press happened in so marqueeRect can shift the
    // start with any mid-drag scroll.
    state.pointer.startScroll = {
      x: Number(global.scrollX) || 0,
      y: Number(global.scrollY) || 0,
    }
    state.pointer.down = true
    state.pointer.dragging = false
    if (event.shiftKey === true || mode === 'selection') {
      // Native text selection owns this drag end to end: no preventDefault, no
      // marquee, no hover. Painting our own rectangle over the browser's
      // selection put two boxes on one gesture, and the guides of the previous
      // hover have no business staying up either. The drop is what says the
      // drag is selecting words.
      state.selectionGesture = true
      state.shiftArmed = state.shiftArmed || event.shiftKey === true
      ui.setHover(null)
      ui.setMarquee(null)
      ui.setCursor(null)
      ui.setShiftDrop({ x: event.clientX, y: event.clientY })
      collapseSelectionTo(event.clientX, event.clientY)
      return
    }
    // Not a text press: whatever armed the drop is stale (a keyup we never
    // saw), and this gesture is an element click or a region drag.
    state.selectionGesture = false
    if (state.shiftArmed) {
      state.shiftArmed = false
      ui.setShiftDrop(null)
    }
    // Suppress text selection, link/image dragging and control activation while
    // the gesture layer is armed.
    event.preventDefault()
    event.stopPropagation()
  }

  function onPointerMove(event) {
    if (!state.active) return
    state.hoverPoint = { x: event.clientX, y: event.clientY }
    // No button held means any press we are still tracking is over; without
    // this check a lost pointerup turns every later move into a drag.
    if (state.pointer.down && event.buttons === 0) {
      resetPointer()
      if (ui) ui.setMarquee(null)
    }
    // Pointer events carry the modifier on every move and arrive even when the
    // keydown went elsewhere (an iframe, a focus change), so they keep the
    // guide honest; only the press itself pins the gesture, and an open
    // composer is typing, not selecting.
    if (!state.pointer.down) setShiftArmed(!ui.isComposerOpen() && event.shiftKey === true)
    if (state.selectionGesture) {
      ui.setShiftDrop({ x: event.clientX, y: event.clientY })
      return
    }
    if (state.pointer.down) {
      const distance = Math.hypot(event.clientX - state.pointer.startX, event.clientY - state.pointer.startY)
      const threshold = Number(P.MAX_CLICK_MOVEMENT_PX) || 6
      const wantsRegion = activeMode() === 'auto' || activeMode() === 'region'
      if (!state.pointer.dragging && wantsRegion && distance >= threshold) {
        state.pointer.dragging = true
        ui.setHover(null)
      }
      if (state.pointer.dragging) {
        event.preventDefault()
        event.stopPropagation()
        const rect = marqueeRect(event.clientX, event.clientY)
        if (rect) ui.setMarquee(rect)
        ui.setCursor({ x: event.clientX, y: event.clientY })
        return
      }
    }
    if (textSelectionArmed()) {
      // Shift is down: no element is the subject, so the drop follows the
      // pointer instead of an outline chasing whatever it passes over.
      ui.setShiftDrop({ x: event.clientX, y: event.clientY })
      return
    }
    ui.setShiftDrop(null)
    scheduleHover(event.clientX, event.clientY)
  }

  function onPointerUp(event) {
    if (!state.active) return
    const wasDown = state.pointer.down
    const dragging = state.pointer.dragging
    state.pointer.down = false
    state.pointer.dragging = false

    if (state.selectionGesture) {
      state.selectionGesture = false
      if (ui) ui.setMarquee(null)
      // The press is over; if Shift is still held the drop stays at the
      // release point, otherwise the pointer goes back to outlining elements.
      syncPointerGuide()
      // The browser commits the native selection after mouseup, so read it on
      // the next turn of the event loop.
      global.setTimeout(() => {
        if (!state.active) return
        const selection = global.getSelection ? global.getSelection() : null
        if (!selection || selection.isCollapsed) return
        const captured = ns.anchor.selection(selection)
        if (captured) openComposerFor(captured)
      }, 0)
      return
    }
    if (!wasDown) return
    if (ns.text.isOurs(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    if (ui) ui.setMarquee(null)

    const mode = activeMode()
    if (dragging && (mode === 'auto' || mode === 'region')) {
      const rect = marqueeRect(event.clientX, event.clientY)
      if (rect && rect.w >= 4 && rect.h >= 4) {
        const captured = ns.anchor.region(rect)
        if (captured) {
          openComposerFor(captured)
          return
        }
      }
      if (mode === 'region') return
    }
    if (mode === 'auto' || mode === 'element') {
      // The click captures what the outline shows: a Tab-widened level locks
      // the expanded element, not the deepest one under the crosshair.
      const subject = subjectFor(ns.anchor.meaningfulAt(event.clientX, event.clientY))
      if (!subject) return
      const captured = ns.anchor.element(subject)
      if (captured) openComposerFor(captured)
    }
  }

  function onPointerCancel() {
    if (!state.active) return
    resetPointer()
    if (!ui) return
    ui.setMarquee(null)
    ui.setHover(null)
    ui.setCursor(null)
    if (state.shiftArmed) syncPointerGuide()
    else ui.setShiftDrop(null)
  }

  function onClickCapture(event) {
    if (!state.active) return
    if (ns.text.isOurs(event.target)) return
    event.preventDefault()
    event.stopPropagation()
  }

  function onMouseDownCapture(event) {
    if (!state.active || state.selectionGesture) return
    if (ns.text.isOurs(event.target)) return
    event.preventDefault()
    event.stopPropagation()
  }

  function onDragStart(event) {
    if (!state.active) return
    if (ns.text.isOurs(event.target)) return
    event.preventDefault()
  }

  /**
   * A right click on the page is a way out of annotation mode. It is disabled
   * while the composer is open, where the context menu belongs to the textarea
   * (paste, spellcheck), and inside our own chrome.
   */
  function onContextMenu(event) {
    if (!state.active || !ui) return
    if (!state.exitOnRightClick) return
    if (ns.text.isOurs(event.target)) return
    if (ui.isComposerOpen()) return
    event.preventDefault()
    event.stopPropagation()
    leaveMode('contextmenu')
  }

  /** Shift means "select text", so it gets a pointer guide of its own. */
  function isShiftKey(event) {
    return event.key === 'Shift' || event.code === 'ShiftLeft' || event.code === 'ShiftRight'
  }

  function onKeyUp(event) {
    if (!state.active || !event) return
    // Disarming never needs to know where the key was released: the composer's
    // own textarea is inside our shadow root, and a Shift typed there must not
    // leave the drop on screen once it is up.
    if (!isShiftKey(event)) return
    setShiftArmed(false)
  }

  function onKeyDown(event) {
    if (!event || event.repeat) return
    if (isShortcutEvent(event)) {
      event.preventDefault()
      event.stopPropagation()
      toggleMode()
      return
    }
    if (isShiftKey(event)) {
      // A capital letter in the composer is not a text-selection gesture, and
      // neither is Shift in our own chrome.
      if (!state.active || ns.text.isOurs(event.target)) return
      if (ui && ui.isComposerOpen()) return
      setShiftArmed(true)
      return
    }
    if (event.key === 'Tab') {
      handleHierarchyKey(event)
      return
    }
    if (event.key !== 'Escape') return
    if (!ui || !state.active) return
    // An open composer handles its own Esc: window capture runs first, so it
    // must not steal the key from the textarea.
    if (ui.isComposerOpen()) return
    // A pinned annotation card closes first; a second Esc leaves annotation mode.
    if (ui.closeBadgeCard()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (state.pick) handleCancel()
    else leaveMode('escape')
  }

  // ── re-anchoring loop ──────────────────────────────────────────────────────

  function onRehydrateTick() {
    if (!state.hidden) refreshRecords({ mode: 'stale' })
  }

  function isOwnNode(node) {
    return ns.text.isOurs(node)
  }

  function onMutations(mutations) {
    for (const mutation of mutations) {
      if (isOwnNode(mutation.target)) continue
      if (mutation.type === 'attributes') continue
      if (state.scheduler) state.scheduler.request()
      return
    }
  }

  function observeNow() {
    if (!state.observer || !document.body) return
    try {
      state.observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    } catch {
      // The body was replaced by the page; the next mutation pass fails too but
      // must not throw into the page.
    }
  }

  function startObserver() {
    if (!global.MutationObserver || !document.body) return
    try {
      state.observer = new global.MutationObserver(onMutations)
      observeNow()
    } catch {
      state.observer = null
    }
  }

  function onViewportChange() {
    if (!state.active || !ui) return
    if (state.scrollFrame) return
    state.scrollFrame = global.requestAnimationFrame(() => {
      state.scrollFrame = 0
      if (state.active && state.hoverPoint) updateHover(state.hoverPoint.x, state.hoverPoint.y)
    })
  }

  // ── prefs (browser.storage.local under `anno.prefs`) ───────────────────────

  function storageAvailable() {
    return !!(api && api.storage && api.storage.local)
  }

  function persistPrefs() {
    state.prefs = Object.assign({}, state.prefs, { hidden: state.hidden })
    if (!storageAvailable()) return
    try {
      const result = api.storage.local.set({ [MSG.prefs]: state.prefs })
      if (result && typeof result.catch === 'function') result.catch(() => undefined)
    } catch {
      // Private windows may refuse storage; the in-memory flag still works.
    }
  }

  function applyHidden(hidden, persist) {
    const value = hidden === true
    if (value === state.hidden) return
    state.hidden = value
    if (ui) ui.setHidden(value)
    if (value) {
      withObserverPaused(() => ns.hydrate.clearMarks())
      state.placements.clear()
      state.markedSignature = ''
      // A composer left open behind a hidden layer would keep floating over the
      // page with no outline to anchor it; the draft is abandoned with the mode.
      clearAnchor()
      if (ui && ui.isComposerOpen()) ui.closeComposer()
      if (ui) {
        ui.setBadges([])
        ui.setMarkBands([])
      }
    } else {
      refreshRecords({ mode: 'all' })
    }
    if (persist) persistPrefs()
  }

  function loadPrefs() {
    if (!storageAvailable()) return Promise.resolve()
    return Promise.resolve()
      .then(() => api.storage.local.get(MSG.prefs))
      .then((stored) => {
        const prefs = stored && stored[MSG.prefs]
        if (!prefs || typeof prefs !== 'object') return
        state.prefs = prefs
        applyPrefs(prefs)
        if (prefs.hidden === true) {
          // The single path that hides the layer also drops the page's marks:
          // setting `state.hidden` here would short-circuit applyHidden and leave
          // highlights painted on a page that now has no HUD to clear them.
          applyHidden(true, false)
        }
      })
      .catch(() => undefined)
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes || !changes[MSG.prefs]) return
    const next = changes[MSG.prefs].newValue
    if (!next || typeof next !== 'object') return
    state.prefs = next
    applyPrefs(next)
    applyHidden(next.hidden === true, false)
  }

  /**
   * Mirror the popup-owned prefs into the gesture layer: the exit choices apply
   * immediately, and the HUD tooltip must not advertise a gesture that is off.
   * @param {any} prefs
   */
  function applyPrefs(prefs) {
    state.exitAfterSend = prefs?.exitAfterSend === true
    state.exitOnRightClick = prefs?.exitOnRightClick !== false
    if (ui && typeof ui.setExitGestures === 'function') {
      ui.setExitGestures({ rightClickExit: state.exitOnRightClick })
    }
  }

  // ── background → content ───────────────────────────────────────────────────

  /**
   * How long the layer stays suppressed without a matching restore. The
   * background answers every hide with a restore, but a killed event page
   * mid-capture would otherwise leave the user staring at a page with no HUD
   * and no composer; the watchdog puts the layer back on its own.
   */
  const CAPTURE_WATCHDOG_MS = 3000

  /** Captures in flight that asked the layer to step out of the frame. */
  let captureDepth = 0
  /** The watchdog above, while a suppression is outstanding. */
  let captureWatchdog = 0

  /**
   * Hide the annotation layer while a screenshot reads the frame, and answer
   * only after the browser has presented two frames of the now-clean page —
   * `captureVisibleTab` photographs the compositor's surface, so acking before
   * a paint would ship the pre-hide frame, layer and all.
   * @returns {Promise<{ ok: boolean }>} the ack the capture waits for
   */
  function suppressOwnLayer() {
    captureDepth += 1
    if (captureDepth === 1) {
      ui.setCaptureSuppressed(true)
      ns.hydrate.setMarksSuppressed(true)
      if (captureWatchdog) global.clearTimeout(captureWatchdog)
      captureWatchdog = global.setTimeout(() => {
        captureWatchdog = 0
        // A restore that arrived first already reset the depth; its clearTimeout
        // cannot reach a timer queued before it, so the fired watchdog no-ops.
        if (captureDepth === 0) return
        captureDepth = 0
        ui.setCaptureSuppressed(false)
        ns.hydrate.setMarksSuppressed(false)
      }, CAPTURE_WATCHDOG_MS)
    }
    return new Promise((resolve) => {
      global.requestAnimationFrame(() => {
        global.requestAnimationFrame(() => resolve({ ok: true }))
      })
    })
  }

  /** Counterpart of `suppressOwnLayer`; unmatched restores are ignored. */
  function restoreOwnLayer() {
    if (captureDepth === 0) return
    captureDepth -= 1
    if (captureDepth > 0) return
    if (captureWatchdog) {
      global.clearTimeout(captureWatchdog)
      captureWatchdog = 0
    }
    ui.setCaptureSuppressed(false)
    ns.hydrate.setMarksSuppressed(false)
  }

  function handleRecordsMessage(message) {
    const list = Array.isArray(message.records) ? message.records : []
    replaceRecords(list)
  }

  function handleEventMessage(message) {
    const kind = String(message.event || '')
    const record = message.record
    if (!record || typeof record.id !== 'string') return
    if (kind === 'deleted') {
      removeRecord(record.id)
      return
    }
    upsertRecord(record)
    if (
      kind === 'updated' &&
      record.resolution &&
      typeof record.resolution.note === 'string' &&
      record.resolution.note !== ''
    ) {
      if (ui) ui.toast(`${t('agentNote')}: ${P.truncate(record.resolution.note, 160)}`)
    }
  }

  function connectionToHud(value) {
    if (value === 'connected' || value === 'open') return 'ok'
    if (value === 'connecting' || value === 'idle') return 'warn'
    if (value === 'offline' || value === 'no-token' || value === 'error') return 'off'
    return ''
  }

  function handleStatusMessage(message) {
    state.connection = String(message.connection || '')
    state.connected = connectionToHud(state.connection)
    if (message.outbox && typeof message.outbox.count === 'number') state.outbox = message.outbox.count
    if (ui && ui.setNewSessionAvailable) {
      ui.setNewSessionAvailable(state.connection === 'connected' || state.connection === 'open')
    }
    syncHud()
  }

  function handleActivate(message) {
    const recordId = message.recordId ? String(message.recordId) : ''
    if (recordId !== '') {
      focusRecord(recordId)
      return
    }
    // The keyboard command toggles; the popup's button enters. A button that
    // reads "Annotate this page" must never leave the mode it names.
    if (message.mode === 'enter') {
      if (!state.active) enterMode('user')
      return
    }
    toggleMode()
  }

  function focusRecord(recordId) {
    const placement = state.placements.get(recordId)
    if (!placement) {
      void queryRecords().then(() => {
        const retry = state.placements.get(recordId)
        if (retry) scrollToPlacement(retry)
      })
      return
    }
    scrollToPlacement(placement)
  }

  function scrollToPlacement(placement) {
    const height = Number(global.innerHeight) || 0
    const top = Math.max(0, placement.pageRect.y - height / 3)
    try {
      global.scrollTo({ top, behavior: 'smooth' })
    } catch {
      try {
        global.scrollTo(0, top)
      } catch {
        // A page that overrides scrollTo: nothing to do.
      }
    }
  }

  /**
   * Firefox delivers the message and an optional `{ ok: true }` reply; unknown
   * types return undefined so nothing else claims them. The returned promise is
   * the reply on Gecko; on Chromium the platform shim forwards it through
   * `sendResponse`, because a promise-returning listener is ignored below 148.
   */
  function onRuntimeMessage(message) {
    if (!message || typeof message !== 'object') return undefined
    // Tolerate `{ type, payload: {...} }` from older builds; flat fields win.
    const flat =
      message.payload && typeof message.payload === 'object' ? Object.assign({}, message.payload, message) : message
    const type = flat.type
    if (type === MSG.content.records) {
      handleRecordsMessage(flat)
      return Promise.resolve({ ok: true })
    }
    if (type === MSG.content.event) {
      handleEventMessage(flat)
      return Promise.resolve({ ok: true })
    }
    if (type === MSG.content.status) {
      handleStatusMessage(flat)
      return Promise.resolve({ ok: true })
    }
    if (type === MSG.content.pickRequest) {
      handlePickRequest(flat)
      return Promise.resolve({ ok: true })
    }
    if (type === MSG.content.pickCancel) {
      handlePickCancel(flat)
      return Promise.resolve({ ok: true })
    }
    if (type === MSG.content.activate) {
      handleActivate(flat)
      return Promise.resolve({ ok: true })
    }
    if (type === MSG.content.captureHide) return suppressOwnLayer()
    if (type === MSG.content.captureRestore) {
      restoreOwnLayer()
      return Promise.resolve({ ok: true })
    }
    return undefined
  }

  // ── boot ───────────────────────────────────────────────────────────────────

  function start() {
    const reason = restrictedReason()
    if (reason) {
      state.restricted = reason
      return
    }
    ui = ns.ui.create({
      onSend: handleSend,
      onCancel: handleCancel,
      onToggleHidden: () => applyHidden(!state.hidden, true),
      onExit: () => leaveMode('hud'),
      onDelete: handleDelete,
      onClear: handleClear,
      onTargetRequest: () => void loadTargets(),
      onTarget: (id) => {
        state.targetId = String(id)
      },
      onTargetNew: (choice) => {
        state.newSessionChoice = choice
        if (choice) state.targetId = ''
      },
      onBrowseDirs: (path) => Promise.resolve(send(MSG.background.browseDirs, { path })),
      onBadgeLines: badgeLines,
    })
    ui.mount()
    ui.setHidden(state.hidden)
    global.addEventListener('message', onPageMessage, false)
    global.addEventListener('keydown', onKeyDown, true)
    global.addEventListener('keyup', onKeyUp, true)
    global.addEventListener('pointerdown', onPointerDown, true)
    global.addEventListener('pointermove', onPointerMove, true)
    global.addEventListener('pointerup', onPointerUp, true)
    global.addEventListener('pointercancel', onPointerCancel, true)
    global.addEventListener('mousedown', onMouseDownCapture, true)
    global.addEventListener('click', onClickCapture, true)
    global.addEventListener('dragstart', onDragStart, true)
    global.addEventListener('contextmenu', onContextMenu, true)
    global.addEventListener('scroll', onViewportChange, true)
    global.addEventListener('resize', onViewportChange, true)
    if (api && api.runtime && api.runtime.onMessage) {
      try {
        if (platform !== undefined && typeof platform.onMessage === 'function') platform.onMessage(onRuntimeMessage)
        else api.runtime.onMessage.addListener(onRuntimeMessage)
      } catch {
        // Another content script instance already registered.
      }
    }
    if (api && api.storage && api.storage.onChanged) {
      try {
        api.storage.onChanged.addListener(onStorageChanged)
      } catch {
        // Storage listener unavailable in this context.
      }
    }
    state.scheduler = ns.hydrate.createScheduler(onRehydrateTick, REHYDRATE_INTERVAL_MS)
    // SPA routers swap documents without a load; see `onRouteRefresh`.
    state.routeUrl = currentHref()
    state.routeScheduler = ns.hydrate.createScheduler(onRouteRefresh, ROUTE_REFRESH_DEBOUNCE_MS)
    global.addEventListener('popstate', onPossibleRouteChange, true)
    global.addEventListener('hashchange', onPossibleRouteChange, true)
    patchHistory()
    startObserver()
    void loadPrefs()
    void send(MSG.background.ready, {
      url: String((global.location && global.location.href) || ''),
      title: String((document && document.title) || ''),
      restricted: false,
    }).then((reply) => {
      const normalized = normalizeReply(reply)
      if (Array.isArray(normalized.records)) replaceRecords(normalized.records)
      else void queryRecords()
      if (normalized.status) handleStatusMessage(normalized.status)
    })
  }

  function boot() {
    const reason = restrictedReason()
    if (reason) {
      // Say so once and stay out of the page's way: the background reports the
      // limitation to the host instead of the user staring at a dead shortcut.
      state.restricted = reason
      void send(MSG.background.ready, {
        url: String((global.location && global.location.href) || ''),
        title: String((document && document.title) || ''),
        restricted: true,
        reason,
      })
      return
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true })
      return
    }
    start()
  }

  boot()
})(globalThis)
