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

    const CSS = `
.dsh-anno-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  max-width: 100%;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-size: inherit;
  line-height: 1.6;
  vertical-align: baseline;
  white-space: nowrap;
}
.dsh-anno-chip-glyph {
  align-self: center;
  flex: none;
  color: var(--dsw-alias-brand-primary);
}
.dsh-anno-chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

    /** One annotation citation: a region glyph plus the label the Host wrote. */
    function AnnoReference({ node, raw }) {
      const { id, label } = node.data
      return h(
        'span',
        { class: 'dsh-anno-chip', title: raw ?? label, 'data-anno-id': id },
        h(
          'svg',
          {
            class: 'dsh-anno-chip-glyph',
            viewBox: '0 0 16 16',
            width: 12,
            height: 12,
            'aria-hidden': 'true',
          },
          h('rect', {
            x: 2,
            y: 2,
            width: 12,
            height: 12,
            rx: 2,
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': 1.5,
          }),
          h('circle', { cx: 8, cy: 8, r: 2.25, fill: 'currentColor' }),
        ),
        h('span', { class: 'dsh-anno-chip-label' }, label === '' ? id : label),
      )
    }

    return {
      inject: ['slots', 'uiConversation'],
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
      },
    }
  },
})
