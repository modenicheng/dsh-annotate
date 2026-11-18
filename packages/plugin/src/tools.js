/**
 * Model-facing tools.
 *
 * Definitions are plain objects with raw JSON Schema: the plugin deliberately
 * imports nothing from `@deepseek-ai/*` so it can be installed into any profile
 * without bundling, and keeps working across harness releases that reshape
 * their TypeScript-only helpers.
 */

import { LIMITS, STATES, describeAnchor, truncate } from './protocol.js'

/** @param {unknown} value */
function iso(value) {
  return typeof value === 'string' ? value : new Date(/** @type {any} */ (value) ?? Date.now()).toISOString()
}

/**
 * Build the text envelope for one record. The structured half is JSON so a
 * model can read exact anchors; the prose half says what the thing is.
 * @param {any} record
 * @param {{ includeRecord?: boolean }} [options]
 */
export function summarize(record, options = {}) {
  const lines = [
    `annotation ${record.id} [${record.state}] ${describeAnchor(record)}`,
    `url: ${record.url}`,
    ...(record.title ? [`title: ${record.title}`] : []),
    ...(record.intent ? [`intent: ${record.intent}`] : []),
    `comment: ${record.comment === '' ? '(empty)' : record.comment}`,
    `created: ${iso(record.createdAt)}`,
    ...(record.resolution?.note ? [`resolution: ${record.resolution.note}`] : []),
  ]
  if (options.includeRecord !== false) {
    lines.push('', 'structured:', JSON.stringify(record, null, 2))
  }
  return lines.join('\n')
}

/**
 * @param {object} options
 * @param {import('./store.js').AnnotationStore} options.store
 * @param {ReturnType<import('./bridge.js').createBridge>} options.bridge
 * @param {{ info: Function, warn: Function, debug: Function }} [options.logger]
 */
export function createTools({ store, bridge, logger = console }) {
  /** @param {any} record */
  function imageBlock(record) {
    const ref = record?.host?.image ?? store.image(record?.id)
    if (ref === undefined) return []
    return [{ type: 'image', attachment: ref }]
  }

  /** @type {any[]} */
  const tools = [
    {
      name: 'annotate_list',
      description:
        'List visual annotations the user left in their browser (text selections, DOM elements, or screen regions) ' +
        'via the dsh-annotate extension. Defaults to open annotations. Use this to discover what the user marked ' +
        'before asking them to explain a page again.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: [...STATES, 'all'], description: 'Filter by state; default open.' },
          url_filter: { type: 'string', description: 'Substring or full URL to narrow by page.' },
          kind: { type: 'string', enum: ['selection', 'element', 'region'], description: 'Filter by anchor modality.' },
          limit: { type: 'integer', minimum: 1, maximum: LIMITS.listLimit, description: 'Maximum rows; default 20.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['count', 'items'],
          additionalProperties: false,
          properties: {
            count: { type: 'integer' },
            openCount: { type: 'integer' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'kind', 'state', 'url', 'preview'],
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  kind: { type: 'string' },
                  state: { type: 'string' },
                  url: { type: 'string' },
                  preview: { type: 'string' },
                  comment: { type: 'string' },
                  intent: { type: 'string' },
                  createdAt: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const items = /** @type {any} */ (value).items
          if (items.length === 0) return [{ type: 'text', text: 'No annotations match.' }]
          const text = items
            .map((item, index) => `${index + 1}. ${item.id} [${item.state}/${item.kind}] ${item.preview} — ${item.url}`)
            .join('\n')
          return [{ type: 'text', text: `${items.length} annotation(s):\n${text}` }]
        },
      },
      execute(args) {
        const query = /** @type {any} */ (args)
        const records = store.list({
          status: query.status ?? 'open',
          url: query.url_filter,
          kind: query.kind,
          limit: query.limit ?? 20,
        })
        return Promise.resolve({
          count: records.length,
          openCount: store.count((record) => record.state === 'open'),
          items: records.map((record) => ({
            id: record.id,
            kind: record.anchor?.kind ?? 'unknown',
            state: record.state,
            url: record.url,
            preview: describeAnchor(record),
            ...(record.comment ? { comment: truncate(record.comment, 400) } : {}),
            ...(record.intent ? { intent: record.intent } : {}),
            createdAt: iso(record.createdAt),
          })),
        })
      },
    },

    {
      name: 'annotate_get',
      description:
        'Read one annotation in full, including the cropped screenshot the user marked. Prefer this over annotate_list ' +
        'when you are about to change or explain that specific spot: the image shows what the user saw, and the ' +
        'structured anchor carries selectors, computed styles, and page facts.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Annotation id (an-yyyymmdd-xxxxxx).' },
          latest: { type: 'boolean', description: 'Use the most recently updated annotation instead of id.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['found'],
          additionalProperties: false,
          properties: {
            found: { type: 'boolean' },
            record: { type: 'object', additionalProperties: true },
            hasImage: { type: 'boolean' },
          },
        },
        render: (_args, value) => {
          const typed = /** @type {any} */ (value)
          if (typed.found !== true) return [{ type: 'text', text: 'No matching annotation.' }]
          return [...imageBlock(typed.record), { type: 'text', text: summarize(typed.record) }]
        },
      },
      execute(args) {
        const query = /** @type {any} */ (args)
        const record =
          query.latest === true || typeof query.id !== 'string'
            ? store.list({ status: 'all', limit: 1 })[0]
            : store.get(query.id)
        if (record === undefined) return Promise.resolve({ found: false })
        return Promise.resolve({
          found: true,
          record: { ...record, host: { imageId: record.host?.image?.attachmentId ?? null } },
          hasImage: (record.host?.image ?? store.image(record.id)) !== undefined,
        })
      },
    },

    {
      name: 'annotate_resolve',
      description:
        "Close the loop on an annotation: mark it resolved (or won't-fix), with a note the user sees on the page. " +
        'The browser badge turns green immediately. Always include what you changed, so the note is useful later.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Annotation id.' },
          status: { type: 'string', enum: [...STATES], description: 'New state; default resolved.' },
          note: { type: 'string', description: 'Short note shown on the page badge.' },
          files_touched: {
            type: 'array',
            items: { type: 'string' },
            description: 'Workspace files changed for this annotation.',
          },
        },
        required: ['id', 'note'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['ok', 'id', 'state'],
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, id: { type: 'string' }, state: { type: 'string' } },
        },
        render: (_args, value) => {
          const typed = /** @type {any} */ (value)
          return [
            { type: 'text', text: typed.ok ? `${typed.id} → ${typed.state}` : `${typed.id} could not be updated` },
          ]
        },
      },
      async execute(args) {
        const query = /** @type {any} */ (args)
        const state = STATES.includes(query.status) ? query.status : 'resolved'
        const record = await store.patch(query.id, {
          state,
          updatedAt: new Date().toISOString(),
          resolution: {
            by: 'agent',
            note: String(query.note ?? ''),
            ...(Array.isArray(query.files_touched) ? { filesTouched: query.files_touched } : {}),
            resolvedAt: Date.now(),
          },
        })
        if (record === undefined) return { ok: false, id: query.id, state: 'missing' }
        bridge.broadcast({ t: 'anno.event', type: 'updated', record, seq: store.seq })
        return { ok: true, id: record.id, state: record.state }
      },
    },

    {
      name: 'annotate_pick',
      description:
        'Ask the user to point at something in their browser, then continue with the result. The page shows a banner ' +
        'with your prompt; the user picks text, an element, or a region, and you receive the annotation with its crop ' +
        'screenshot. Use this when a request is ambiguous about location ("this button", "that chart").',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to ask the user, shown in the browser banner.' },
          mode: {
            type: 'string',
            enum: ['auto', 'selection', 'element', 'region'],
            description: 'Restrict the gesture; default auto picks whichever the user performs.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 5000,
            maximum: 900000,
            description: 'How long to wait; default 120000.',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['ok'],
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            reason: { type: 'string' },
            record: { type: 'object', additionalProperties: true },
          },
        },
        timeoutMs: 900_000,
        render: (_args, value) => {
          const typed = /** @type {any} */ (value)
          if (typed.ok !== true)
            return [{ type: 'text', text: `The user did not pick a target: ${typed.reason ?? 'cancelled'}.` }]
          return [...imageBlock(typed.record), { type: 'text', text: summarize(typed.record) }]
        },
      },
      async execute(args, exec) {
        const query = /** @type {any} */ (args)
        const sessionId = exec?.agent?.session?.id
        const result = await bridge.requestPick({
          mode: query.mode,
          prompt: String(query.prompt ?? 'Point at the relevant element'),
          timeoutMs: query.timeout_ms,
          sessionId: typeof sessionId === 'string' ? sessionId : undefined,
          signal: exec?.signal,
        })
        if (result.ok !== true) return { ok: false, reason: result.reason }
        const record = store.get(result.record.id) ?? result.record
        return { ok: true, record: { ...record, host: { imageId: record.host?.image?.attachmentId ?? null } } }
      },
    },

    {
      name: 'annotate_clear',
      description: 'Delete annotations in bulk, for example every resolved one after a cleanup pass.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: [...STATES, 'all'],
            description: 'Which states to remove; default resolved.',
          },
          before_iso: { type: 'string', description: 'Only remove annotations created before this ISO timestamp.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          required: ['removed'],
          additionalProperties: false,
          properties: { removed: { type: 'integer' } },
        },
        render: (_args, value) => [
          { type: 'text', text: `Removed ${/** @type {any} */ (value).removed} annotation(s).` },
        ],
      },
      async execute(args) {
        const query = /** @type {any} */ (args)
        const status = query.status ?? 'resolved'
        const before = typeof query.before_iso === 'string' ? Date.parse(query.before_iso) : Number.NaN
        const doomed = store.list({ status: 'all', limit: LIMITS.listLimit }).filter((record) => {
          if (status !== 'all' && record.state !== status) return false
          if (!Number.isNaN(before) && Date.parse(record.createdAt) >= before) return false
          return true
        })
        for (const record of doomed) {
          await store.delete(record.id)
          bridge.broadcast({ t: 'anno.event', type: 'deleted', record, seq: store.seq })
        }
        return { removed: doomed.length }
      },
    },
  ]

  return tools
}
