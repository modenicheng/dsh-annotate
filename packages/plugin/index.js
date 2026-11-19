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
import { createFocusStore, focusedSession, registerFocusRoute } from './src/focus.js'
import { createAnnotationMentions } from './src/mentions.js'
import { registerPresentationRoutes } from './src/presentation.js'
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

  // Which Session the Web Client is showing. Its absence is normal: a profile
  // without the Client half never reports one.
  const focus = createFocusStore({ dir: annotationsDir(), logger })
  await focus.load()

  const bridge = createBridge({
    store,
    token,
    logger,
    onCreated: async (record) => {
      const routed = record.routing?.sessionId
      // An annotation with no target still has one the user would have picked:
      // the conversation they were looking at when they marked the page. The
      // overlay defaults to it, and this covers the case where it could not ask
      // (an older overlay, or a catalog that failed to load). An agent-authored
      // annotation is not the user pointing at their own page, so it never
      // adopts that default.
      const adoptable = record.routing?.source !== 'agent'
      const sessionId =
        typeof routed === 'string' && routed !== '' ? routed : adoptable ? focusedSession(focus) : undefined
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (sessionId !== routed) {
        await store.patch(record.id, { routing: { ...record.routing, sessionId } })
        logger.info?.(`annotations: ${record.id} routed to the focused ${sessionId}`)
      }
      const patched = store.get(record.id) ?? record
      const label =
        typeof patched.routing?.label === 'string' && patched.routing.label !== ''
          ? patched.routing.label
          : describeAnchor(patched)
      const mention = formatAnnoMention({ id: patched.id, label })
      if (mention === '') return
      await queue.enqueue({ id: patched.id, sessionId, mention, label })
      logger.info?.(`annotations: ${patched.id} queued for ${sessionId}`)
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
          preferred: () => focusedSession(focus),
        }),
      'dsh-annotate: /ext/anno/sessions catalog',
    )
    webCtx.effect(() => registerQueueRoutes(webCtx.webServer, { queue }), 'dsh-annotate: /ext/anno/queue hand-off')
    webCtx.effect(() => registerFocusRoute(webCtx.webServer, { store: focus }), 'dsh-annotate: /ext/anno/focus report')
    webCtx.effect(
      () =>
        registerPresentationRoutes(webCtx.webServer, {
          store,
          readImage: async (ref) => {
            const attachments = ctx.get('attachments')
            if (attachments === undefined) throw new Error('no attachment service is mounted')
            return attachments.readImage(ref)
          },
        }),
      'dsh-annotate: /ext/anno/item and /ext/anno/image',
    )
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
