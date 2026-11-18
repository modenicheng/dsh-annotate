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
import { createBridge } from './src/bridge.js'
import { createTools } from './src/tools.js'

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

  const bridge = createBridge({
    store,
    token,
    logger,
    saveImage: async ({ data, mediaType, name }) => {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) throw new Error('no attachment service is mounted')
      return attachments.saveImage({ data, mediaType, name })
    },
  })

  for (const tool of createTools({ store, bridge, logger })) {
    ctx.effect(() => ctx.tools.register(tool), `dsh-annotate: ${tool.name}`)
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => bridge.attach(webCtx.webServer), 'dsh-annotate: /ext/anno bridge')
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
