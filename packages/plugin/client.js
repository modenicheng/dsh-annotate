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

    /** Delivered ids stay delivered even if the acknowledgement never lands. */
    const delivered = new Set()

    /**
     * Append queued mentions to the draft of every Session that is open.
     *
     * The extension cannot write a draft and the Host cannot reach one, so the
     * hand-off is a durable queue plus this reader: whatever target the user
     * picked, its mention lands at the end of that Session's composer the next
     * time the Session is open. Nothing is sent, and no turn starts.
     */
    /** TEMP diagnostic: the module realm's console does not reach the page. */
    function trace(reason) {
      try {
        document.documentElement.setAttribute('data-dsh-anno-trace', reason)
      } catch {}
    }

    /**
     * Hand one queued mention to its Session's composer.
     *
     * Two faces, because a Session the user is looking at does not always have a
     * live Agent binding (`binding()` only answers for a retained Agent). With a
     * binding the documented "append" initialization does the work; without one
     * the session-scope input facade still inserts the mention as an atomic
     * reference chip at the caret.
     * @returns whether the mention was taken
     */
    function deliver(ctx, item) {
      try {
        const binding = ctx.sessions.binding(item.sessionId)
        if (binding !== undefined) {
          const result = ctx.uiConversation.input.requestDraftInitialization(binding, {
            prompt: item.mention,
            whenDraftExists: 'append',
          })
          if (result === 'applied') {
            trace('applied-append')
            return true
          }
          trace(`init-${String(result)}`)
        }
        const scope = ctx.sessions.scope(item.sessionId)
        if (scope === undefined) {
          trace('wait-no-scope')
          return false
        }
        const input = ctx.uiConversation.input.for(scope)
        const span = input.captureInsertion()
        const inserted = input.insertReference(
          {
            source: 'anno',
            ref: item.mention,
            // No `appearance`: the draft schema only knows session/file/folder,
            // and an unlabelled reference still renders as an atomic chip.
            label: typeof item.label === 'string' && item.label !== '' ? item.label : item.mention,
            clipboardText: item.mention,
          },
          span,
        )
        trace(inserted ? 'inserted-reference' : 'insert-refused')
        return inserted === true
      } catch (error) {
        trace(`throw-${String(error).slice(0, 60)}`)
        return false
      }
    }

    /**
     * The Session-scope seat. A Session-scope Slot component is handed the
     * Session it belongs to and that Session's input actions — the documented
     * face for programmatic editing — which is the only way to reach a composer
     * whose Agent is not retained (`sessions.binding`/`scope` answer nothing
     * for one, D13).
     */
    function PendingMentions({ sessionId, inputActions }) {
      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '' || inputActions === undefined) return undefined
        let cancelled = false
        const pull = async () => {
          try {
            const response = await fetch(
              `${window.location.origin}/ext/anno/queue?session=${encodeURIComponent(sessionId)}`,
              {
                credentials: 'same-origin',
                cache: 'no-store',
              },
            )
            if (!response.ok) return
            const body = await response.json()
            const items = Array.isArray(body?.items) ? body.items : []
            trace(`slot-items-${items.length}`)
            if (cancelled || items.length === 0) return
            const acked = []
            for (const item of items) {
              if (typeof item?.mention !== 'string') continue
              const span = inputActions.captureInsertion()
              const text = item.mention
              if (inputActions.insertText(text, span) !== true) {
                trace('slot-insert-refused')
                continue
              }
              acked.push(item.id)
            }
            if (cancelled || acked.length === 0) return
            trace('slot-appended')
            await fetch(`${window.location.origin}/ext/anno/queue/ack`, {
              method: 'POST',
              credentials: 'same-origin',
              cache: 'no-store',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ids: acked }),
            })
          } catch (error) {
            trace(`slot-throw-${String(error).slice(0, 50)}`)
          }
        }
        void pull()
        return () => {
          cancelled = true
        }
      }, [sessionId, inputActions])
      return null
    }

    async function appendQueued(ctx) {
      const url = `${window.location.origin}/ext/anno/queue?all=1`
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) return trace(`http-${response.status}`)
      const body = await response.json()
      const items = Array.isArray(body?.items) ? body.items : []
      trace(`items-${items.length}`)
      if (items.length === 0) return

      const acked = []
      for (const item of items) {
        if (typeof item?.id !== 'string' || typeof item?.mention !== 'string') continue
        if (delivered.has(item.id)) continue
        if (deliver(ctx, item)) {
          delivered.add(item.id)
          acked.push(item.id)
        }
      }
      if (acked.length === 0) return
      try {
        await fetch(`${window.location.origin}/ext/anno/queue/ack`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: acked }),
        })
      } catch (error) {
        // The local set already prevents a second insert; the entry dies with its annotation.
        console.warn(`dsh-annotate: queue acknowledgement failed: ${String(error)}`)
      }
    }

    return {
      inject: ['slots', 'sessions', 'uiConversation'],
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

        ctx.slots.inject('conversation.composer.dock', function* () {
          yield ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-anno-pending', order: 90 },
            PendingMentions,
          )
        })

        ctx.effect(() => {
          let last = 0
          const poll = (force) => {
            const now = Date.now()
            // Interaction fires far more often than the queue changes.
            if (force !== true && now - last < QUEUE_POLL_MS) return
            last = now
            void appendQueued(ctx).catch((error) => {
              console.warn(`dsh-annotate: queue poll failed: ${String(error)}`)
            })
          }
          const timer = setInterval(() => poll(false), QUEUE_POLL_MS)
          const onVisible = () => {
            if (document.visibilityState === 'visible') poll(true)
          }
          // A hidden tab has its timers frozen, so the moment the user comes
          // back is also the moment to look: focus and the first interaction.
          const onInteraction = () => poll(false)
          document.addEventListener('visibilitychange', onVisible)
          window.addEventListener('focus', onVisible)
          document.addEventListener('pointerdown', onInteraction, true)
          document.addEventListener('keydown', onInteraction, true)
          poll(true)
          return () => {
            clearInterval(timer)
            document.removeEventListener('visibilitychange', onVisible)
            window.removeEventListener('focus', onVisible)
            document.removeEventListener('pointerdown', onInteraction, true)
            document.removeEventListener('keydown', onInteraction, true)
          }
        }, 'dsh-annotate: queued mentions')
      },
    }
  },
})
