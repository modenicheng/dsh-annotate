/**
 * dsh-marker — host half.
 *
 * Mounts one websocket endpoint (`/ext/anno`) and one health route on the DSH
 * host webserver, keeps annotations in an append-only log under `$DSH_HOME`,
 * and exposes them to the model as `annotate_*` tools. No daemon, and on the
 * default `3080` deployment no extra port: it lives and dies with `dsh web`. A
 * host whose port the launcher chose also publishes that address — a record
 * file and, when the port is not `3080`, a loopback locator — so a browser can
 * find it without a second data path (see `docs/DISCOVERY.md`).
 *
 * @module dsh-marker
 */

import { randomBytes } from 'node:crypto'

import { ensureToken, annotationsDir } from './src/paths.js'
import { AnnotationStore } from './src/store.js'
import { createBridge, tokenMatches } from './src/bridge.js'
import { createDiscovery, isIpv4Loopback, shouldLocate } from './src/discovery.js'
import { createEventStream, registerEventsRoute } from './src/events.js'
import { createFocusStore, focusedSession, registerFocusRoute } from './src/focus.js'
import { startLocator } from './src/locator.js'
import { createAnnotationMentions } from './src/mentions.js'
import { createProvisioner, registerProvisionRoutes } from './src/provision.js'
import { registerPresentationRoutes } from './src/presentation.js'
import { createMentionQueue, registerQueueRoutes } from './src/queue.js'
import { createSessionCatalog, registerSessionsRoute } from './src/sessions.js'
import { createPageGate } from './src/pagegate.js'
import { createTools } from './src/tools.js'
import { LOCATE_HOST, describeAnchor, formatAnnoMention } from './src/protocol.js'

export const name = 'dsh-marker'
export const inject = ['tools']

/** Annotation tools are additive: a profile without `webServer` still lists them. */
export async function apply(ctx, config = {}) {
  const log = typeof ctx.logger === 'function' ? ctx.logger('dsh-marker') : console
  const logger = {
    debug: (...args) => log.debug?.(...args),
    info: (...args) => log.info?.(...args),
    warn: (...args) => log.warn?.(...args),
  }

  // One id per process, shared by the three things that must agree on "who is
  // this host": the locator answer, the endpoint record, and `/ext/anno/health`.
  const instanceId = randomBytes(8).toString('hex')
  /** Discovery is on unless a profile turns it off; an unknown value is on. */
  const discoveryMode = config?.discovery === 'off' ? 'off' : 'auto'

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

  // The page's push channel. Created before the bridge because the delivery
  // that follows an accepted create is what it publishes.
  const events = createEventStream({ logger })

  // The overlay's target catalog. Created here rather than at its route so the
  // warm-up below can wait for the Session services it reads.
  const catalog = createSessionCatalog({ get: (service) => ctx.get(service), logger })

  // The picker's other arm: create a Session (in the default, an existing, or a
  // brand-new workspace) so an annotation can start a conversation. Created
  // before its route so the sessions catalog can share the workspace read.
  const provisioner = createProvisioner({
    get: (service) => ctx.get(service),
    logger,
    catalog,
    onCreated: ({ sessionId }) => {
      // Same knock as a queued mention: the page that should show this Session
      // learns to look for it now, and a missed event costs latency, not state.
      events.publish({ t: 'session', sessionId })
    },
  })

  const bridge = createBridge({
    store,
    token,
    instanceId,
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
      // The queue is the truth and this is only the knock: a page whose Session
      // this is reads the queue immediately instead of waiting for its next
      // poll, and a missed nudge costs latency rather than a delivery.
      events.publish({ t: 'mention', sessionId })
      logger.info?.(`annotations: ${patched.id} queued for ${sessionId}`)
    },
    saveImage: async ({ data, mediaType, name }) => {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('no attachment service is mounted')
      return attachments.saveImage({ data, mediaType, name })
    },
  })

  for (const tool of createTools({ store, bridge })) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-marker: ${tool.name}`)
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
    'dsh-marker: annotation mentions',
  )

  ctx.inject(['webServer'], (webCtx) => {
    // The five GUI routes share one gate: the host Connection fence where it
    // exists (Host/Origin checks against rebinding, plus the browser session
    // the page holds), the same-origin header where it does not. Read per
    // request because plugin load order is a deployment fact.
    const pageGate = createPageGate({ get: (service) => ctx.get(service), logger })

    webCtx.effect(() => bridge.attach(webCtx.webServer), 'dsh-marker: /ext/anno bridge')
    webCtx.effect(
      () =>
        registerSessionsRoute(webCtx.webServer, {
          catalog,
          token,
          matchesToken: tokenMatches,
          logger,
          preferred: () => focusedSession(focus),
          workspaces: () => provisioner.listWorkspaces(),
        }),
      'dsh-marker: /ext/anno/sessions catalog',
    )
    webCtx.effect(
      () =>
        registerProvisionRoutes(webCtx.webServer, {
          provisioner,
          token,
          matchesToken: tokenMatches,
        }),
      'dsh-marker: /ext/anno/session-create',
    )
    webCtx.effect(
      () => registerQueueRoutes(webCtx.webServer, { queue, gate: pageGate }),
      'dsh-marker: /ext/anno/queue hand-off',
    )
    webCtx.effect(
      () => registerEventsRoute(webCtx.webServer, { events, gate: pageGate }),
      'dsh-marker: /ext/anno/events push',
    )
    webCtx.effect(
      () => registerFocusRoute(webCtx.webServer, { store: focus, gate: pageGate }),
      'dsh-marker: /ext/anno/focus report',
    )
    webCtx.effect(
      () =>
        registerPresentationRoutes(webCtx.webServer, {
          store,
          gate: pageGate,
          readImage: async (ref) => {
            const attachments = ctx.get('attachments')
            if (attachments === undefined) throw new Error('no attachment service is mounted')
            return attachments.readImage(ref)
          },
        }),
      'dsh-marker: /ext/anno/item and /ext/anno/image',
    )
    logger.info?.(`annotations: listening on ${webCtx.webServer.getOrigin?.() ?? 'the host webserver'}`)

    // ── discovery ───────────────────────────────────────────────────────────
    // Both artifacts answer "where is this host", never "may I talk to it": the
    // token stays in `$DSH_HOME/ext-bridge-token` and nothing here reads it.
    // The record is written on every start, because it is the manual and
    // diagnostic path; the locator only exists for a port that moves.
    const discovery = createDiscovery({
      webServer: webCtx.webServer,
      focus,
      profile: ctx.get('profileContext')?.name ?? null,
      logger,
      instanceId,
    })

    webCtx.effect(() => {
      // The write is tracked so a stop that lands mid-write cannot leave a
      // record behind: the disposer removes the file the write just created.
      const written = discovery.write()
      return async () => {
        await written
        await discovery.dispose()
      }
    }, 'dsh-marker: endpoint record')

    if (shouldLocate({ port: webCtx.webServer.port, host: webCtx.webServer.host, mode: discoveryMode })) {
      webCtx.effect(() => {
        // `startLocator` returns before the bind settles, so this disposer can
        // still close a listener that wins the race a moment later.
        const locator = startLocator({ card: () => discovery.card(), logger })
        void locator.ready.then((port) => {
          if (port !== null) logger.info?.(`annotations: locator on ${LOCATE_HOST}:${port}`)
        })
        return () => locator.dispose()
      }, 'dsh-marker: locator')
    } else if (
      discoveryMode === 'auto' &&
      webCtx.webServer.port !== undefined &&
      !isIpv4Loopback(webCtx.webServer.host)
    ) {
      // The extension has no permission for a non-loopback origin, so there is
      // nothing to publish that it could use. Say so instead of failing later.
      logger.warn?.(
        `annotations: no locator on ${webCtx.webServer.host}: automatic discovery needs an IPv4 loopback bind; use the endpoint record or a manual address`,
      )
    }
  })

  // Pay the picker's first title fold before anyone is looking. The child
  // scope waits for the controller rather than failing once at boot, and a
  // warm-up failure only means a slow first open.
  ctx.inject(['sessionController'], (warmCtx) => {
    warmCtx.effect(() => {
      void catalog.warm()
    }, 'dsh-marker: catalog warm-up')
  })

  ctx.effect(
    () => () => {
      bridge.cancelAllPicks()
      // A page still holding an event stream would wait on a Host that is gone;
      // closing it makes `EventSource` reconnect to the next one instead.
      events.close()
      void store.flush()
    },
    'dsh-marker: shutdown',
  )
}
