/**
 * dsh-annotate — host half.
 *
 * Mounts one websocket endpoint (`/ext/anno`) and one health route on the DSH
 * host webserver, keeps annotations in an append-only log under `$DSH_HOME`,
 * and exposes them to the model as `annotate_*` tools. No daemon, no extra
 * port: it lives and dies with `dsh web`.
 *
 * @module dsh-annotate
 */

import { ensureToken, annotationsDir } from './src/paths.js'
import { AnnotationStore } from './src/store.js'
import { createBridge, tokenMatches } from './src/bridge.js'
import { createAnnotationMentions } from './src/mentions.js'
import { createMentionQueue, registerQueueRoutes } from './src/queue.js'
import { createSessionCatalog, registerSessionsRoute } from './src/sessions.js'
import { createTools } from './src/tools.js'
import { describeAnchor, formatAnnoMention } from './src/protocol.js'

export const name = 'dsh-annotate'
export const inject = ['tools']

/** Annotation tools are additive: a profile without `webServer` still lists them. */
export async function apply(ctx) {
  const log = typeof ctx.logger === 'function' ? ctx.logger('dsh-annotate') : console
  const logger = {
    debug: (...args) => log.debug?.(...args),
    info: (...args) => log.info?.(...args),
    warn: (...args) => log.warn?.(...args),
  }

  const store = new AnnotationStore({ dir: annotationsDir(), logger })
  await store.load()
  const token = await ensureToken()

  // Mentions waiting for a target Session's composer. Loaded before the bridge
  // so a create that arrives first cannot race the queue file.
  const queue = createMentionQueue({ dir: annotationsDir(), logger })
  await queue.load()
  await queue.prune((id) => store.get(id) !== undefined)

  const bridge = createBridge({
    store,
    token,
    logger,
    onCreated: async (record) => {
      const sessionId = record.routing?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') return
      const label =
        typeof record.routing?.label === 'string' && record.routing.label !== ''
          ? record.routing.label
          : describeAnchor(record)
      const mention = formatAnnoMention({ id: record.id, label })
      if (mention === '') return
      await queue.enqueue({ id: record.id, sessionId, mention, label })
      logger.info?.(`annotations: ${record.id} queued for ${sessionId}`)
    },
    saveImage: async ({ data, mediaType, name }) => {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('no attachment service is mounted')
      return attachments.saveImage({ data, mediaType, name })
    },
  })

  for (const tool of createTools({ store, bridge, logger })) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-annotate: ${tool.name}`)
  }

  // A `dsh-anno:` mention in a prompt draft is the user's own citation: resolve
  // it before the model sees the turn, so the annotation arrives as context
  // rather than as a token the model has to ask about.
  const mentions = createAnnotationMentions({ store, logger })
  ctx.effect(
    () =>
      ctx.on(
        'agent/pre-step',
        async (_payload, next) => {
          const decision = await next()
          if (decision.kind === 'reject') return decision
          return { ...decision, messages: await mentions.prepare(decision.messages) }
        },
        { prepend: true },
      ),
    'dsh-annotate: annotation mentions',
  )

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => bridge.attach(webCtx.webServer), 'dsh-annotate: /ext/anno bridge')
    webCtx.effect(
      () =>
        registerSessionsRoute(webCtx.webServer, {
          catalog: createSessionCatalog({ get: (service) => ctx.get(service), logger }),
          token,
          matchesToken: tokenMatches,
        }),
      'dsh-annotate: /ext/anno/sessions catalog',
    )
    webCtx.effect(() => registerQueueRoutes(webCtx.webServer, { queue }), 'dsh-annotate: /ext/anno/queue hand-off')
    logger.info?.(`annotations: listening on ${webCtx.webServer.getOrigin?.() ?? 'the host webserver'}${''}`)
  })

  ctx.effect(
    () => () => {
      bridge.cancelAllPicks()
      void store.flush()
    },
    'dsh-annotate: shutdown',
  )
}
