/**
 * dsh-annotate — Web Client half.
 *
 * Turns the canonical `@[批注 · 那段话](dsh-anno:an-20261118-ab12cd)` mention into
 * one atomic chip inside a user message, the same way `@session` renders. The
 * chip is display only: it never invents navigation, and the annotation body
 * stays out of the transcript — the Host attaches that at `agent/pre-step`.
 *
 * This file is a classic script, not a module: it registers a lazy factory with
 * the page's module table, which is the only supported shape for a Client half.
 */

window.__ModuleLoader__.load({
  id: 'dsh-annotate',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Sticky matcher for one canonical mention; shared shape with the Host parser. */
    const WIRE = /@\[((?:\\.|[^\\\]\n])*)\]\(dsh-anno:([A-Za-z0-9_-]+)\)/uy

    /** How often the page checks for mentions waiting on an open Session. */
    const QUEUE_POLL_MS = 4_000

    /**
     * The reference chip's own declarations, copied from the product's
     * `ReferenceChip` stylesheet (`refChip` / `refIcon`): an inline run in the
     * business colour with a one-em glyph. Kept as literal declarations rather
     * than `var()` aliases because those class names are hashed per build.
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
`

    /** @param {string} label */
    function unescapeLabel(label) {
      return label.replace(/\\(.)/gu, '$1')
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
     * One annotation citation, marked up exactly like the product's
     * `ReferenceChip` in its non-interactive form: an inline `span` whose
     * `title` is the whole mention, a leading decorative glyph, then the label.
     * There is no activation action to supply, so it is not a button — the same
     * shape a folder reference takes.
     */
    function AnnoReference({ node, raw }) {
      const { id, label } = node.data
      return h(
        'span',
        {
          class: 'dsh-anno-chip',
          'data-ref-chip': 'anno',
          'data-anno-id': id,
          title: raw,
        },
        h(RegionGlyph, null),
        label === '' ? id : label,
      )
    }

    /** Queue routes the Host serves to the page it serves (same-origin only). */
    const QUEUE_PATH = '/ext/anno/queue'
    const QUEUE_ACK_PATH = '/ext/anno/queue/ack'

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
     * Record the last delivery decision on the document element.
     *
     * This module's realm has no console of its own (its output never reaches
     * the page), so the only place a diagnostic can land where a human — or an
     * automation — can read it is the page's own DOM.
     * @param {string} reason
     */
    function trace(reason) {
      try {
        document.documentElement.setAttribute('data-dsh-anno-trace', reason)
      } catch {}
    }

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
     * The dock seat that delivers queued mentions into its own Session.
     *
     * It is the only place holding both halves of the problem: the Session id
     * and that Session's live input actions. Being mounted is what "the user is
     * looking at this Session" means, so that is exactly when a delivery
     * happens — a chip appears in the composer, visible and removable before it
     * counts, and nothing is sent. A Session the user is not looking at is never
     * touched, and its entries simply wait in the queue.
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
        void pull()
        const timer = setInterval(() => void pull(), QUEUE_POLL_MS)
        // A hidden tab has its timers frozen, so the moment the user comes back
        // is also the moment to look.
        const onVisible = () => {
          if (document.visibilityState === 'visible') void pull()
        }
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', onVisible)
        return () => {
          cancelled = true
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
        // One stylesheet for the whole page, removed when the plugin disposes.
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.dshAnno = 'chip'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'dsh-annotate: chip styles')

        ctx.effect(() => ctx.uiConversation.userText.register(annoRule), 'dsh-annotate: user-text rule')
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
