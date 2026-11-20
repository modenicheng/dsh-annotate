/**
 * Where to connect: the resolution chain between pure knowledge and the socket
 * lifecycle.
 *
 * The bridge answers two different questions with two different lifecycles, and
 * three layers keep them apart:
 *
 *   - `discovery.js` is knowledge only: it validates locator answers, ranks the
 *     hosts a round found, and reads back a remembered address. No network, no
 *     storage, no `browser.*`.
 *   - this file is network resolution: one discovery round, the health probes,
 *     the `instanceId` cross-check, and the 12 h remembered host. It runs once
 *     per connection attempt, and it owns the only two records that make that
 *     cheap (`anno.endpoint`, `anno.address`).
 *   - `socket.js` is the resident lifecycle: handshake, heartbeat, backoff,
 *     close codes, and the pick queue. It asks this file where to go, then goes.
 *
 * Nothing here holds socket state: no timers, no listeners, and no writes to
 * the socket fields of `ns.netState`. That is what lets the popup's "Scan again"
 * call `scan()` while a socket is connected without disturbing it.
 *
 * Classic script: `background.scripts` loads this after `discovery.js` and, by
 * design, before `core.js`. So `ns.msg`, `ns.log`, `ns.storageGet`,
 * `ns.setNetState` and `ns.prefs` exist only at call time; no function below
 * reads them while this file loads.
 */
;(() => {
  const ns = globalThis.__DSH_ANNO_BG__
  if (ns === undefined) {
    console.error('dsh-marker: src/background/endpoints.js must load before src/background/connection.js')
    return
  }

  /**
   * Budget for one health probe. The probe runs before the socket opens, so it
   * must be short enough not to read as connection latency; a loopback answer
   * takes milliseconds and a dead port is refused immediately.
   */
  const HEALTH_PROBE_TIMEOUT_MS = 1_500
  /**
   * How long a health answer is reused. Every reconnect must not re-probe (the
   * event page restarts often), but a host that moves from plain HTTP to TLS
   * has to be noticed, so the answer expires and a failed socket invalidates it
   * immediately.
   */
  const DISCOVERY_TTL_MS = 10 * 60_000
  /**
   * Budget for one locator probe. Three of these run in parallel, so the whole
   * round costs at most this long, and a refused loopback port answers at once.
   */
  const LOCATE_TIMEOUT_MS = 700

  /** Background-private cache of the discovered endpoint (like the client id). */
  function discoveryKey() {
    return ns.msg.STORAGE_KEYS.endpoint
  }

  /** Where the host that answered last is remembered, for the 12 h fast path. */
  function addressKey() {
    return ns.msg.STORAGE_KEYS.address
  }

  /** @type {Record<string, any> | null} */
  let discovered = null

  /**
   * Read the remembered endpoint when it still describes this address.
   * @param {{ host: string, port: number, secure: boolean | null }} address
   */
  async function readCachedDiscovery(address) {
    let record = discovered
    if (record === null) {
      const stored = await ns.storageGet(discoveryKey(), null)
      record = ns.isPlainObject(stored) ? stored : null
      discovered = record
    }
    if (record === null) return null
    if (record.host !== address.host || record.port !== address.port) return null
    if ((record.configuredSecure ?? null) !== (address.secure ?? null)) return null
    if (!Number.isFinite(record.at) || Date.now() - record.at > DISCOVERY_TTL_MS) return null
    if (typeof record.wsUrl !== 'string' || !/^wss?:\/\//i.test(record.wsUrl)) return null
    return record
  }

  /**
   * Persist the host's answer so an event-page restart does not probe again.
   * @param {{ host: string, port: number, secure: boolean | null }} address
   * @param {{ wsUrl: string, secure: boolean, healthUrl: string }} selection
   */
  async function rememberDiscovery(address, selection) {
    const record = {
      host: address.host,
      port: address.port,
      configuredSecure: address.secure ?? null,
      secure: selection.secure,
      wsUrl: selection.wsUrl,
      healthUrl: selection.healthUrl,
      at: Date.now(),
    }
    discovered = record
    try {
      await ns.storageSet(discoveryKey(), record)
    } catch (error) {
      ns.log.debug(`could not remember the discovered endpoint: ${ns.describeError(error)}`)
    }
  }

  /** Forget the remembered scheme answer; the next attempt probes again. */
  async function invalidate() {
    discovered = null
    try {
      await browser.storage.local.remove(discoveryKey())
    } catch (error) {
      ns.log.debug(`could not clear the discovered endpoint: ${ns.describeError(error)}`)
    }
  }

  /**
   * One health request. Rejects on a network error, a non-2xx answer, a body
   * that is not the bridge's health JSON, or the probe budget expiring.
   * @param {string} url
   * @returns {Promise<{ secure: boolean, wsUrl: string, instanceId: string | null }>}
   */
  async function probeHealth(url) {
    if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this context')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
      })
      if (response.ok !== true) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      const health = ns.endpoints.parseHealth(body)
      if (health === null) throw new Error('the response is not the bridge health JSON')
      // Read the id from the raw body rather than widening `parseHealth`: the
      // parser is shared with the popup and its shape is a settled contract.
      return { ...health, instanceId: ns.discovery === undefined ? null : ns.discovery.healthInstanceId(body) }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Probe the candidates in order and stop at the first usable answer.
   *
   * The default local host is plain HTTP, so `http` is tried first and the
   * common path costs exactly one request. `https` is only attempted when the
   * plain probe does not answer (a TLS listener, or a proxy that redirects
   * plaintext away): racing both would send a TLS ClientHello to every plain
   * listener on every probe, and a redirect from http to https cannot be
   * followed usefully by a WebSocket anyway.
   * @param {{ url: string, secure: boolean }[]} candidates
   */
  async function probeFirst(candidates) {
    /** @type {string[]} */
    const failures = []
    for (const candidate of candidates) {
      try {
        return { winner: { url: candidate.url, health: await probeHealth(candidate.url) }, failures }
      } catch (error) {
        failures.push(`${candidate.url}: ${ns.describeError(error)}`)
      }
    }
    return { winner: null, failures }
  }

  /**
   * Read one JSON body for a discovery probe, with a hard deadline.
   *
   * `collectHosts` takes this as an injected `request`, which keeps the round a
   * pure function of the answers it gets. The status is attached to the error so
   * a refused port and an alien 404 read differently in `discoveryFailures`.
   * @param {string} url
   * @returns {Promise<any>}
   */
  async function readJson(url) {
    if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this context')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), LOCATE_TIMEOUT_MS)
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store', credentials: 'omit' })
      const body = await response.json()
      if (response.ok !== true) {
        throw new Error(
          body?.error === undefined ? `HTTP ${response.status}` : `HTTP ${response.status} (${body.error})`,
        )
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * `http(s)://host:port` for a normalized address, with no bridge path.
   * @param {{ host: string, port: number, secure?: boolean | null }} address
   */
  function originOf(address) {
    const scheme = address.secure === true ? 'https' : 'http'
    return `${scheme}://${ns.endpoints.formatAuthority(address)}`
  }

  /**
   * The health-only candidate for the address the popup shows.
   *
   * A stock `dsh web` on 3080 has no locator (it does not need one), so it can
   * only be found by probing the address the user did not change. It carries no
   * `instanceId`, which is what makes ranking put it last.
   * @param {{ host: string, port: number, secure: boolean | null }} address
   * @returns {{ origin: string, instanceId: null, profile: null, startedAt: null, focusAt: null, port: number }}
   */
  function defaultCandidate(address) {
    return {
      origin: originOf(address),
      instanceId: null,
      profile: null,
      startedAt: null,
      focusAt: null,
      port: address.port,
    }
  }

  /**
   * Probe one candidate host and, when it answers, work out where to connect.
   *
   * The identified host must still be served by the process that identified
   * itself: a locator answer is a snapshot, and another host may own that port
   * by the time this probe runs.
   * @param {{ origin: string, instanceId: string | null, profile: string | null, startedAt: string | null, focusAt: string | null, port: number }} host
   */
  async function probeHost(host) {
    const parsed = ns.endpoints.parseAddress(host.origin)
    if (parsed.ok !== true) return null
    const address = { host: parsed.host, port: parsed.port, secure: parsed.secure }
    const { winner } = await probeFirst(ns.endpoints.healthCandidates(address))
    if (winner === null) return null
    const answeredId = winner.health.instanceId
    if (host.instanceId !== null && answeredId !== null && answeredId !== host.instanceId) {
      ns.log.debug(`discovery: ${host.origin} now answers as ${answeredId}, not ${host.instanceId}; ignoring it`)
      return null
    }
    const selection = ns.endpoints.selectWsUrl({ address, health: winner.health })
    return {
      address,
      selection,
      healthUrl: winner.url,
      instanceId: answeredId ?? host.instanceId ?? '',
      host: { ...host, origin: originOf(address) },
    }
  }

  /**
   * Remember a host that answered: the scheme cache for this address, and the
   * fast path for the next event-page start.
   * @param {any} probe
   */
  async function rememberHost(probe) {
    await rememberDiscovery(probe.address, { ...probe.selection, healthUrl: probe.healthUrl })
    try {
      const stored = ns.discovery.makeLastGood(probe.host)
      await ns.storageSet(addressKey(), stored)
    } catch (error) {
      ns.log.debug(`could not remember the host address: ${ns.describeError(error)}`)
    }
  }

  /**
   * The manual path: one address, one health probe, and the pre-negotiation
   * fallback when the probe cannot answer.
   *
   * A fresh cached answer is reused; otherwise `/ext/anno/health` decides.
   * When nothing answers the probe the configured address is used as-is, which
   * keeps a host whose health route is behind an auth proxy usable.
   * @param {{ host: string, port: number, secure: boolean | null }} address
   * @param {{ force?: boolean }} [options]
   */
  async function discoverAt(address, { force = false } = {}) {
    const cached = force ? null : await readCachedDiscovery(address)
    if (cached !== null) {
      ns.log.debug(`reusing ${cached.wsUrl} discovered ${Date.now() - cached.at} ms ago`)
      return {
        wsUrl: cached.wsUrl,
        secure: cached.secure === true,
        source: 'health',
        healthUrl: typeof cached.healthUrl === 'string' ? cached.healthUrl : '',
        error: '',
      }
    }

    const candidates = ns.endpoints.healthCandidates(address)
    const { winner, failures } = await probeFirst(candidates)
    if (winner === null) {
      // The configured address is the fallback: a host that answers the socket
      // but not health (a proxy that swallows GETs, an older host) still works.
      const selection = ns.endpoints.selectWsUrl({ address, health: null })
      ns.log.info(`health probe failed (${failures.join('; ')}); using ${selection.wsUrl}`)
      return {
        ...selection,
        healthUrl: candidates[0] === undefined ? '' : candidates[0].url,
        error: failures.join('; '),
      }
    }

    const selection = ns.endpoints.selectWsUrl({ address, health: winner.health })
    await rememberDiscovery(address, { ...selection, healthUrl: winner.url })
    ns.log.info(
      `host advertises ${winner.health.wsUrl === '' ? '(no url)' : winner.health.wsUrl} (secure ${String(winner.health.secure)}); using ${selection.wsUrl}`,
    )
    return { ...selection, healthUrl: winner.url, error: '' }
  }

  /**
   * Automatic discovery: the host that answered last, then one ranked round.
   *
   * Step one costs one health probe and covers the common restart; step two
   * covers a host that moved or was not up yet, and never runs when step one
   * succeeded. Ranking is `discovery.js`'s job; this only decides which probes
   * to spend.
   * @param {{ address: { host: string, port: number, secure: boolean | null }, force: boolean }} options
   * @returns {Promise<{ wsUrl: string, secure: boolean, source: string, healthUrl: string, error: string, instanceId: string } | null>}
   */
  async function discoverAutomatically({ address, force }) {
    const preferred = typeof ns.prefs.preferredInstanceId === 'string' ? ns.prefs.preferredInstanceId : ''
    const stored = force ? null : ns.discovery.readLastGood(await ns.storageGet(addressKey(), null))
    const lastInstanceId = stored === null || stored.instanceId === null ? '' : stored.instanceId

    if (stored !== null) {
      const probe = await probeHost(stored)
      if (probe !== null) {
        ns.log.info(`discovery: ${probe.host.origin} still answers; not probing the locator`)
        ns.setNetState({ discovered: [probe.host], discoveryFailures: [], discoverySource: 'cached' })
        await rememberHost(probe)
        return {
          ...probe.selection,
          healthUrl: probe.healthUrl,
          error: '',
          instanceId: probe.instanceId,
        }
      }
      ns.log.info(`discovery: ${stored.origin} did not answer; running a round`)
    }

    const round = await ns.discovery.collectHosts({ request: readJson, timeoutMs: LOCATE_TIMEOUT_MS, logger: ns.log })
    const fallback = defaultCandidate(address)
    const ranked = ns.discovery.rankCandidates([...round.hosts, fallback], {
      preferredInstanceId: preferred,
      lastInstanceId,
    })
    ns.setNetState({ discovered: round.hosts, discoveryFailures: round.failures })

    for (const candidate of ranked) {
      const probe = await probeHost(candidate)
      if (probe === null) continue
      const fromLocator = round.hosts.some((host) => host.origin === candidate.origin)
      ns.setNetState({ discoverySource: fromLocator ? 'locator' : 'default' })
      ns.log.info(
        `discovery: ${probe.host.origin}${candidate.profile === null ? '' : ` (${candidate.profile})`} answered`,
      )
      await rememberHost(probe)
      return {
        ...probe.selection,
        healthUrl: probe.healthUrl,
        error: '',
        instanceId: probe.instanceId,
      }
    }
    return null
  }

  /**
   * Resolve the endpoint to connect to. Manual: the typed address exactly as
   * before. Auto: the remembered host (one health probe) or one ranked round.
   *
   * Manual is exactly the pre-discovery behaviour; `auto` is only chosen by the
   * preference and only for an untouched default address, so an address the user
   * typed is never overridden by a discovered one.
   * @param {{ host: string, port: number, secure: boolean | null }} address
   * @param {{ force?: boolean, mode?: 'auto' | 'manual' }} [options]
   * @returns {Promise<{ wsUrl: string, secure: boolean, source: string, healthUrl: string, error: string, instanceId: string } | null>}
   *   null only in automatic mode, when nothing answered.
   */
  async function resolve(address, { mode = 'manual', force = false } = {}) {
    if (ns.discovery === undefined) {
      // A half-loaded extension must still connect the way it did before.
      ns.log.warn('discovery.js did not load; using the configured address')
      ns.setNetState({ discoveryMode: 'manual', discoverySource: 'manual' })
      return { ...(await discoverAt(address, { force })), instanceId: '' }
    }
    const plan = ns.discovery.planResolution({ mode, address })
    if (plan.auto !== true) {
      ns.setNetState({ discoveryMode: 'manual', discoverySource: 'manual', discovered: [], discoveryFailures: [] })
      return { ...(await discoverAt(address, { force })), instanceId: '' }
    }
    ns.setNetState({ discoveryMode: 'auto' })
    return discoverAutomatically({ address, force })
  }

  /**
   * One discovery round without connecting, for the popup's Scan again.
   *
   * It only refreshes the fields that describe the network, so a working socket
   * keeps its own state while the popup explains what answered.
   * @returns {Promise<{ hosts: any[], failures: { port: number, error: string }[] }>}
   */
  async function scan() {
    if (ns.discovery === undefined) return { hosts: [], failures: [] }
    await ns.readPrefs()
    const round = await ns.discovery.collectHosts({
      request: readJson,
      timeoutMs: LOCATE_TIMEOUT_MS,
      logger: ns.log,
    })
    ns.setNetState({
      discovered: round.hosts,
      discoveryFailures: round.failures,
      discoveryMode: ns.discoveryModeOf(ns.prefs),
    })
    void ns.publishStatus('scan')
    return round
  }

  ns.connection = {
    resolve,
    invalidate,
    scan,
  }
})()
