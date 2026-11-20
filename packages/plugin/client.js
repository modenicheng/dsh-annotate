/**
 * dsh-marker — Web Client half.
 *
 * Turns the canonical `@[批注 · 那段话](dsh-anno:an-20261118-ab12cd)` mention into
 * one atomic chip inside a user message, the same way `@session` renders. The
 * chip is display only: it never invents navigation, and the annotation body
 * stays out of the transcript — the Host attaches that at `agent/pre-step`.
 * Hovering the chip opens the product's own `HoverCard` with what the user
 * marked and the crop the browser took, read back from the Host on demand.
 *
 * It also answers the reverse question: which Session is this page showing. The
 * Host needs that to default an annotation's target to the conversation the user
 * is actually looking at.
 *
 * This file is a classic script, not a module: it registers a lazy factory with
 * the page's module table, which is the only supported shape for a Client half.
 */

window.__ModuleLoader__.load({
  id: 'dsh-marker',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Sticky matcher for one canonical mention; shared shape with the Host parser. */
    const WIRE = /@\[((?:\\.|[^\\\]\n])*)\]\(dsh-anno:([A-Za-z0-9_-]+)\)/uy

    /** The Host's push channel: one stream per page, however many Sessions it shows. */
    const EVENTS_PATH = '/ext/anno/events'

    /**
     * The repair interval, not the delivery path.
     *
     * A nudge from {@link EVENTS_PATH} is what makes a queued mention arrive
     * immediately; this poll only exists for the case a nudge cannot cover — a
     * stream that was down (or absent) while something was queued. It is slow on
     * purpose: it is a safety net, so a missed event costs a wait instead of a
     * lost delivery.
     */
    const REPAIR_POLL_MS = 30_000

    /** Queue, focus, and annotation reads the Host serves to the page it serves. */
    const QUEUE_PATH = '/ext/anno/queue'
    const QUEUE_ACK_PATH = '/ext/anno/queue/ack'
    const FOCUS_PATH = '/ext/anno/focus'
    const ITEM_PATH = '/ext/anno/item'

    /**
     * The reference chip's own declarations, copied from the product's
     * `ReferenceChip` stylesheet (`refChip` / `refIcon`): an inline run in the
     * business colour with a one-em glyph. Kept as literal declarations rather
     * than `var()` aliases because those class names are hashed per build.
     *
     * The card's frame belongs to the product's `HoverCard`; only what goes
     * inside it is styled here.
     */
    const CSS = `
.dsh-anno-chip {
  display: inline;
  max-width: 100%;
  margin: 0 2px;
  color: var(--dsw-alias-state-business-primary);
  font-weight: 500;
  white-space: inherit;
  overflow-wrap: anywhere;
  text-align: inherit;
}
.dsh-anno-chip-glyph {
  width: 1em;
  height: 1em;
  margin-right: 4px;
  vertical-align: -0.125em;
}
.dsh-anno-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  white-space: normal;
}
.dsh-anno-card-shot {
  display: block;
  width: 100%;
  max-height: 132px;
  object-fit: cover;
  object-position: top left;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
}
.dsh-anno-card-page {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.dsh-anno-card-title {
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-anno-card-url {
  color: var(--dsw-alias-label-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-anno-card-mark {
  margin: 0;
  padding-left: 8px;
  border-left: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.dsh-anno-card-mark[data-kind="element"] {
  font-family: var(--dsw-font-markdown-code-block, ui-monospace, monospace);
  font-size: 11px;
}
.dsh-anno-card-comment {
  color: var(--dsw-alias-label-primary);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.dsh-anno-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dsh-anno-card-tag {
  padding: 0 5px;
  border-radius: 4px;
  background: color-mix(in srgb, currentColor 12%, transparent);
}
`

    /**
     * The product's primitives, when this build exposes them.
     *
     * `HoverCard` is the exact interaction an official reference gets — open
     * delay, hover bridge, Escape, body portal, viewport-aware placement — so the
     * chip uses it rather than a lookalike. A build that renamed the module
     * leaves the chip working, with its mention as the fallback tooltip.
     */
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        return undefined
      }
    })()
    const HoverCard = typeof primitives?.HoverCard === 'function' ? primitives.HoverCard : undefined

    /** @param {string} label */
    function unescapeLabel(label) {
      return label.replace(/\\(.)/gu, '$1')
    }

    /** Record one line of state on the document element, for support and tests. */
    function mark(attribute, value) {
      try {
        document.documentElement.setAttribute(attribute, value)
      } catch {
        // A document without a root element is not a page we can serve.
      }
    }

    /**
     * Record the last delivery decision on the document element.
     *
     * This module's realm has no console of its own (its output never reaches
     * the page), so the only place a diagnostic can land where a human — or an
     * automation — can read it is the page's own DOM.
     * @param {string} reason
     */
    function trace(reason) {
      mark('data-dsh-anno-trace', reason)
    }

    /**
     * One event stream per page, shared by every mounted Session dock.
     *
     * The stream carries an event *name*, never the queue's contents: a `mention`
     * frame says "this Session has something waiting", and the reader still
     * fetches `GET /ext/anno/queue?session=…` and acknowledges it. That keeps one
     * delivery path — the pushed frame only decides *when* it runs — so a lost
     * frame degrades to the repair poll instead of a lost mention.
     *
     * @type {Set<(event: any) => void>}
     */
    const STREAM_LISTENERS = new Set()
    /** @type {any} */
    let stream = null

    /** @param {any} payload */
    function emitStreamEvent(payload) {
      for (const listener of [...STREAM_LISTENERS]) {
        try {
          listener(payload)
        } catch {
          // One listener's failure must not silence the others.
        }
      }
    }

    /** Open the stream if it is not open yet. */
    function openStream() {
      if (stream !== null) return
      const Source = window.EventSource
      if (typeof Source !== 'function') {
        trace('no-eventsource')
        return
      }
      const opened = new Source(EVENTS_PATH)
      stream = opened
      opened.onmessage = (message) => {
        let payload
        try {
          payload = JSON.parse(message.data)
        } catch {
          return
        }
        if (payload === null || typeof payload !== 'object') return
        emitStreamEvent(payload)
      }
      // A reconnection is a first-class moment, not a retry: it is exactly when
      // events may have been missed, so listeners catch up on `open`.
      opened.onopen = () => {
        trace('events-open')
        emitStreamEvent({ t: 'open' })
      }
      // `EventSource` retries on its own; recording it is all this needs to do.
      opened.onerror = () => {
        trace('events-error')
      }
    }

    /**
     * Listen for the Host's nudges, opening the stream on first use.
     * @param {(event: any) => void} listener
     * @returns {() => void} unsubscribe
     */
    function listenForEvents(listener) {
      STREAM_LISTENERS.add(listener)
      openStream()
      return () => {
        STREAM_LISTENERS.delete(listener)
      }
    }

    /** Close the page's stream (plugin disposal). */
    function closeStream() {
      STREAM_LISTENERS.clear()
      const opened = stream
      stream = null
      try {
        opened?.close()
      } catch {
        // A stream that already failed has nothing left to close.
      }
    }

    /**
     * Find the nearest annotation mention at or after `from`. Mentions carry
     * their own label, so no Host read is needed to draw one.
     */
    const annoRule = {
      id: 'anno',
      order: 20,
      match(text, from) {
        for (let start = text.indexOf('@', from); start >= 0; start = text.indexOf('@', start + 1)) {
          WIRE.lastIndex = start
          const found = WIRE.exec(text)
          if (found === null) continue
          return {
            id: 'anno',
            start,
            end: start + found[0].length,
            data: { id: found[2], label: unescapeLabel(found[1]) },
          }
        }
        return undefined
      },
    }

    /**
     * The region glyph: a selection frame with corner handles and a centred
     * bar, drawn at the product's regular one-pixel stroke once scaled to 1em.
     * Decorative, so it inherits the chip's colour and stays out of the tree.
     */
    function RegionGlyph() {
      return h(
        'svg',
        {
          class: 'dsh-anno-chip-glyph',
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
        },
        h(
          'g',
          {
            fill: 'none',
            stroke: 'currentColor',
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            strokeWidth: 1.5,
          },
          h('path', { d: 'M7.5 4.5h9m-9 15h9m-12-12v9m15-9v9' }),
          h('rect', { width: 3.5, height: 3.5, x: 2.75, y: 2.75, rx: 1 }),
          h('rect', { width: 3.5, height: 3.5, x: 17.75, y: 2.75, rx: 1 }),
          h('rect', { width: 3.5, height: 3.5, x: 2.75, y: 17.75, rx: 1 }),
          h('rect', { width: 3.5, height: 3.5, x: 17.75, y: 17.75, rx: 1 }),
          h('rect', { width: 7.5, height: 3.5, x: 8.25, y: 10.25, rx: 1.25 }),
        ),
      )
    }

    /**
     * Annotation reads, cached per page: a card is asked for once and then
     * answered from memory, because the record never changes underneath a
     * transcript.
     *
     * @type {Map<string, { status: 'loading' | 'ready' | 'failed', item?: any, error?: string }>}
     */
    const ITEMS = new Map()
    /** In-flight reads, so a hover and a prefetch share one request. @type {Map<string, Promise<any>>} */
    const READING = new Map()

    /** @param {string} id */
    function readAnnotation(id) {
      const known = ITEMS.get(id)
      if (known !== undefined && known.status !== 'loading') return Promise.resolve(known)
      const pending = READING.get(id)
      if (pending !== undefined) return pending
      const request = fetch(`${window.location.origin}${ITEM_PATH}?id=${encodeURIComponent(id)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          if (body?.ok !== true || body.item === undefined) throw new Error('unreadable')
          const entry = { status: 'ready', item: body.item }
          ITEMS.set(id, entry)
          return entry
        })
        .catch((error) => {
          const entry = { status: 'failed', error: String(error).slice(0, 80) }
          ITEMS.set(id, entry)
          return entry
        })
        .finally(() => READING.delete(id))
      ITEMS.set(id, { status: 'loading' })
      READING.set(id, request)
      return request
    }

    /** @param {number} bytes */
    function readableBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return ''
      if (bytes < 1_024) return `${bytes} B`
      if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`
      return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
    }

    /** @param {string} iso */
    function clockOf(iso) {
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return ''
      return at.toLocaleString(undefined, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    /** @param {string} url */
    function pageLabel(url) {
      try {
        const parsed = new URL(url)
        return `${parsed.host}${parsed.pathname}`
      } catch {
        return url
      }
    }

    /**
     * The line that says what was marked: the quote, the element, or the box.
     * @param {any} item
     */
    function markOf(item) {
      const anchor = item.anchor ?? {}
      if (anchor.kind === 'selection') return { kind: 'selection', text: `“${anchor.quote ?? ''}”` }
      if (anchor.kind === 'element') {
        const head = `<${anchor.tag ?? 'element'}>`
        const body = anchor.name ?? anchor.text ?? anchor.selector ?? ''
        return { kind: 'element', text: body === '' ? head : `${head} ${body}` }
      }
      const rect = anchor.rect ?? {}
      return { kind: 'region', text: `区域 ${Math.round(rect.w ?? 0)}×${Math.round(rect.h ?? 0)}` }
    }

    /**
     * One annotation, as the chip's hover card: the crop the browser took, the
     * page it came from, what was marked, and what the user said about it.
     * @param {{ id: string }} props
     */
    function AnnotationCard({ id }) {
      const [entry, setEntry] = React.useState(() => ITEMS.get(id) ?? { status: 'loading' })
      React.useEffect(() => {
        if (entry.status !== 'loading') return undefined
        let live = true
        void readAnnotation(id).then((next) => {
          if (live) setEntry(next)
        })
        return () => {
          live = false
        }
      }, [id, entry.status])

      if (entry.status === 'loading') return h('div', { class: 'dsh-anno-card' }, '读取批注…')
      if (entry.status === 'failed') return h('div', { class: 'dsh-anno-card' }, `这条批注读不出来了（${entry.error}）`)

      const item = entry.item
      const mark = markOf(item)
      const bytes = readableBytes(item.image?.bytes ?? 0)
      return h(
        'div',
        { class: 'dsh-anno-card' },
        item.image === undefined
          ? null
          : h('img', {
              class: 'dsh-anno-card-shot',
              src: `${window.location.origin}${item.image.href}`,
              alt: `批注 ${id} 的截图`,
              decoding: 'async',
            }),
        h(
          'div',
          { class: 'dsh-anno-card-page' },
          h('div', { class: 'dsh-anno-card-title' }, item.title === '' ? pageLabel(item.url) : item.title),
          h('div', { class: 'dsh-anno-card-url' }, pageLabel(item.url)),
        ),
        h('p', { class: 'dsh-anno-card-mark', 'data-kind': mark.kind }, mark.text),
        item.comment === '' ? null : h('div', { class: 'dsh-anno-card-comment' }, item.comment),
        h(
          'div',
          { class: 'dsh-anno-card-meta' },
          item.intent === undefined ? null : h('span', { class: 'dsh-anno-card-tag' }, item.intent),
          h('span', null, item.state),
          h('span', null, clockOf(item.snapshot?.at ?? item.createdAt)),
          item.image === undefined ? null : h('span', null, `截图 ${bytes}`),
        ),
      )
    }

    /**
     * One annotation citation, marked up exactly like the product's
     * `ReferenceChip` in its non-interactive form: an inline `span` whose
     * `title` is the whole mention, a leading decorative glyph, then the label.
     * With `HoverCard` available it becomes the same hover target an official
     * reference is, showing what the user marked instead of just its name.
     */
    function AnnoReference({ node, raw }) {
      const { id, label } = node.data
      const chip = h(
        'span',
        {
          class: 'dsh-anno-chip',
          'data-ref-chip': 'anno',
          'data-anno-id': id,
          ...(HoverCard === undefined ? { title: raw } : {}),
        },
        h(RegionGlyph, null),
        label === '' ? id : label,
      )
      if (HoverCard === undefined) return chip
      return h(HoverCard, {
        anchor: chip,
        content: h(AnnotationCard, { id }),
        inline: true,
        grouped: true,
        openDelayMs: 200,
      })
    }

    /**
     * The `@` source that owns our chip.
     *
     * A chip is only sendable while some source claims it: submit serializes
     * every occurrence through its owner's codec and refuses the message when
     * that owner is missing. This is the product's own reference source, and its
     * codec is the identity, so the sent text is exactly the mention — which is
     * what the transcript renders and what the Host parses at `agent/pre-step`.
     */
    const REFERENCE_SOURCE = 'reference'

    /**
     * Fold queued mentions into the draft the composer already holds.
     *
     * Everything stays in clipboard coordinates: `draft` is the whole document
     * with chips expanded, and each reference is a span inside it. Mentions go
     * after the last line, so a question the user already drafted survives, and
     * a mention the draft already carries is never added twice.
     *
     * @param {any} state live input snapshot (`draft`, `occurrences`, `phase`, `claim`)
     * @param {readonly any[]} items queue entries for one Session
     * @returns {{ text?: string, references?: readonly any[], ack: readonly string[] } | undefined}
     *   the document to write and the entries it accounts for, or undefined
     *   when the composer cannot take an edit right now
     */
    function composeDraft(state, items) {
      // A busy composer owns the draft: adjudication and submission (and a
      // pending command claim, whose chip is not part of `references`) would be
      // lost by a wholesale write. The next poll retries.
      if (state === undefined || state === null || state.phase !== 'plain' || state.claim !== undefined) {
        return undefined
      }
      const known = new Set(state.occurrences.map((occurrence) => occurrence.ref))
      const ack = []
      const fresh = []
      for (const item of items) {
        if (typeof item?.id !== 'string' || typeof item?.mention !== 'string' || item.mention === '') continue
        // Accounted for either way: an entry whose mention is already in the
        // draft describes a delivery that happened, so acknowledging is the
        // whole repair.
        ack.push(item.id)
        if (known.has(item.mention)) continue
        known.add(item.mention)
        fresh.push(item)
      }
      if (fresh.length === 0) return { ack }
      let text = state.draft
      const references = [...state.occurrences]
      for (const item of fresh) {
        if (text !== '' && !text.endsWith('\n')) text += '\n'
        references.push({
          source: REFERENCE_SOURCE,
          ref: item.mention,
          offset: text.length,
          length: item.mention.length,
          label: typeof item.label === 'string' && item.label !== '' ? item.label : item.mention,
          clipboardText: item.mention,
        })
        text += item.mention
      }
      return { text, references, ack }
    }

    /** Tell the Host that these entries are in a composer now. @param {readonly string[]} ids */
    async function acknowledge(ids) {
      await fetch(`${window.location.origin}${QUEUE_ACK_PATH}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
    }

    /**
     * Tell the Host which Session this page is showing.
     *
     * The overlay's default target is the conversation the user is looking at,
     * and the Host cannot see browser focus — this is the only half that can.
     * @param {string} sessionId
     */
    async function reportFocus(sessionId) {
      const response = await fetch(`${window.location.origin}${FOCUS_PATH}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    }

    /**
     * The dock seat that delivers queued mentions into its own Session.
     *
     * It is the only place holding both halves of the problem: the Session id
     * and that Session's live input actions. Being mounted is what "the user is
     * looking at this Session" means, so that is exactly when a delivery
     * happens — a chip appears in the composer, visible and removable before it
     * counts, and nothing is sent. A Session the user is not looking at is never
     * touched, and its entries simply wait in the queue.
     *
     * Delivery is event-driven: the Host's stream says *when* to read, and the
     * queue says *what*. A slow repair poll plus the mount and visibility pulls
     * cover the case where no event arrives at all.
     *
     * Being mounted is also what the Host needs to know, so the same effect
     * reports the focus.
     */
    function QueuedMentions({ sessionId, input, inputActions }) {
      // The pull is asynchronous but must not restart on every keystroke, so it
      // reads the newest state through a ref instead of a dependency.
      const latest = React.useRef({ input, inputActions })
      React.useEffect(() => {
        latest.current = { input, inputActions }
      })

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        let cancelled = false
        const pull = async () => {
          // A background tab must not take a delivery meant for the one the
          // user is looking at: two tabs of the same Session each hold their own
          // draft, and the queue is a single hand-off.
          if (document.visibilityState === 'hidden') return trace('hidden')
          try {
            const url = `${window.location.origin}${QUEUE_PATH}?session=${encodeURIComponent(sessionId)}`
            const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
            if (!response.ok) return trace(`http-${response.status}`)
            const body = await response.json()
            const items = Array.isArray(body?.items) ? body.items : []
            trace(`queue-${items.length}`)
            if (cancelled || items.length === 0) return
            const plan = composeDraft(latest.current.input, items)
            if (plan === undefined) return trace('busy')
            if (plan.text !== undefined) {
              // A structured document, not text: this is what makes the editor
              // build a chip node instead of a run of mention characters.
              latest.current.inputActions.setDraft({ text: plan.text, references: plan.references })
              trace(`appended-${plan.ack.length}`)
            }
            if (plan.ack.length > 0) await acknowledge(plan.ack)
          } catch (error) {
            trace(`throw-${String(error).slice(0, 48)}`)
          }
        }
        const announce = () => {
          if (document.visibilityState === 'hidden') return
          void reportFocus(sessionId).catch((error) => trace(`focus-${String(error).slice(0, 40)}`))
        }
        const onStreamEvent = (event) => {
          if (event?.t === 'open') {
            // A (re)connected stream is the one moment events may have been
            // missed, so it re-announces the focus and catches up.
            announce()
            void pull()
            return
          }
          if (event?.t === 'mention' && event.sessionId === sessionId) void pull()
        }
        const stopListening = listenForEvents(onStreamEvent)
        announce()
        void pull()
        const timer = setInterval(() => void pull(), REPAIR_POLL_MS)
        // A hidden tab has its timers frozen, so the moment the user comes back
        // is also the moment to look.
        const onVisible = () => {
          if (document.visibilityState !== 'visible') return
          announce()
          void pull()
        }
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', onVisible)
        return () => {
          cancelled = true
          stopListening()
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener('focus', onVisible)
        }
      }, [sessionId])

      return null
    }

    return {
      inject: ['slots', 'uiConversation'],
      /** The draft composition this plugin owns; exported for its unit test. */
      composeDraft,
      apply(ctx) {
        mark('data-dsh-anno-hovercard', HoverCard === undefined ? 'unavailable' : 'primitives')
        // One stylesheet for the whole page, removed when the plugin disposes.
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshAnno = 'chip'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'dsh-marker: chip styles')

        ctx.effect(() => ctx.uiConversation.userText.register(annoRule), 'dsh-marker: user-text rule')
        // The page's stream outlives any one Session: it is opened on the first
        // mounted dock and closed here, with the plugin.
        ctx.effect(
          () => () => {
            closeStream()
          },
          'dsh-marker: event stream',
        )
        ctx.slots.inject('conversation.user.text.node', function* () {
          yield ctx.slots.register({ name: 'conversation.user.text.node', key: 'anno', priority: 100 }, AnnoReference)
        })

        // The composer zone, not the composer dock: it is rendered for the
        // session body's hero and composer alike, and it carries the live input
        // state and actions the delivery needs.
        ctx.slots.inject('conversation.input.dock', function* () {
          yield ctx.slots.register({ name: 'conversation.input.dock', id: 'dsh-anno-queue', order: 90 }, QueuedMentions)
        })
      },
    }
  },
})
