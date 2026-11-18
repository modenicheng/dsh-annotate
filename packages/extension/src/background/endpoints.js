/**
 * Which endpoint should the extension talk to, and what does a failure mean?
 *
 * The host owns this decision. `/ext/anno/health` reports `secure` and a
 * complete `wsUrl`, so the extension asks instead of guessing: a plain local
 * host, a host with TLS configured on the DSH webserver, and a host behind a
 * TLS-terminating reverse proxy need different schemes, and nothing in the
 * browser can tell them apart by looking at the port. The default local host is
 * the plain case, and it must resolve to `ws://` over an `http://` probe.
 *
 * That plain path only works while the extension page CSP does not rewrite
 * insecure requests: MV3's default policy contains `upgrade-insecure-requests`,
 * which rewrites the probe to `https://` and the socket to `wss://` before this
 * module ever runs. The manifest therefore declares an explicit
 * `content_security_policy.extension_pages` without that directive
 * (see `scripts/check-manifest.mjs`); the negotiation below is for real TLS
 * deployments, not a workaround for that policy.
 *
 * The popup keeps accepting `host` + `port` (the pre-existing shape) and
 * additionally accepts a full URL whose scheme, when present, is an explicit
 * user override of the probe.
 *
 * Everything here is pure and synchronous: given a typed address, the health
 * body, and a close code it returns values. `socket.js` performs the one
 * network call (the health probe) and owns the retry policy.
 *
 * Classic script: the background event page and the popup are loaded without a
 * module loader, so this publishes `ns.endpoints` on the shared namespace. It
 * must load after `src/shared/protocol.global.js` and works in either context.
 */
;(() => {
  const ns = globalThis.__DSH_ANNO_BG__ ?? (globalThis.__DSH_ANNO_BG__ = {})
  const PROTOCOL = globalThis.__DSH_PROTOCOL__
  if (PROTOCOL === undefined) {
    console.error('dsh-annotate: src/shared/protocol.global.js must load before src/background/endpoints.js')
    return
  }

  /** `dsh web` serves the bridge here unless the popup says otherwise. */
  const DEFAULT_HOST = '127.0.0.1'
  const DEFAULT_PORT = 3080
  const DEFAULT_ADDRESS = Object.freeze({ host: DEFAULT_HOST, port: DEFAULT_PORT })

  /** A scheme prefix the popup accepts in place of a bare host. */
  const SCHEME_PREFIX = /^(wss?|https?):\/\//i
  /** Printable host name or IPv4 literal; IPv6 is handled separately. */
  const HOST_NAME = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/
  const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/

  /** @param {string} scheme lowercase scheme without the colon */
  function isSecureScheme(scheme) {
    return scheme === 'wss' || scheme === 'https'
  }

  /**
   * A port number from a stored value, or `undefined` when it is unusable.
   * Stored preferences come from older versions of the popup and are not
   * trusted to be integers.
   * @param {unknown} value
   * @returns {number | undefined}
   */
  function portNumber(value) {
    if (typeof value === 'number') return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined
    if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) {
      const parsed = Number(value.trim())
      return parsed >= 1 && parsed <= 65535 ? parsed : undefined
    }
    return undefined
  }

  /**
   * @param {string} reason
   * @returns {{ ok: false, reason: string }}
   */
  function rejection(reason) {
    return { ok: false, reason }
  }

  /**
   * Normalize one typed bridge address.
   *
   * Accepted, in the shapes a user actually pastes:
   *   `127.0.0.1`, `127.0.0.1:3080`, `localhost:3080/`,
   *   `http://127.0.0.1:3080/`, `wss://anno.example.com/ext/anno`
   *
   * A scheme is the explicit override: `https`/`wss` select `wss://`, `http`/`ws`
   * select `ws://`, and the absence of a scheme means "ask the host" (`secure`
   * is `null`). A URL without a port uses that scheme's default port and
   * ignores the separate port field, because the typed URL is more specific.
   *
   * @param {unknown} rawHost the host field, which may be a whole URL
   * @param {unknown} [rawPort] the port field, used only without a typed port
   * @param {boolean | null} [fallbackSecure] stored override when no scheme is typed
   * @returns {({ ok: true, host: string, port: number, secure: boolean | null, explicitScheme: boolean }) | { ok: false, reason: string }}
   */
  function parseAddress(rawHost, rawPort, fallbackSecure = null) {
    let text = typeof rawHost === 'string' ? rawHost.trim() : ''
    /** @type {boolean | null} */
    let secure = null
    /** @type {number | undefined} */
    let schemePort
    const scheme = SCHEME_PREFIX.exec(text)
    if (scheme !== null) {
      secure = isSecureScheme(scheme[1].toLowerCase())
      schemePort = secure ? 443 : 80
      text = text.slice(scheme[0].length)
    }
    // Only the authority matters: both endpoint paths are fixed by the
    // protocol, so a pasted path, query, or trailing slash is dropped.
    text = text.replace(/[/?#].*$/, '')

    let host = text
    let typedPort = ''
    if (text.startsWith('[')) {
      const close = text.indexOf(']')
      if (close === -1) return rejection('Close the IPv6 address with "]" (for example [::1]:3080).')
      host = text.slice(0, close + 1)
      const rest = text.slice(close + 1)
      if (rest !== '') {
        if (!/^:\d+$/.test(rest)) return rejection('Use host:port, for example [::1]:3080.')
        typedPort = rest.slice(1)
      }
    } else {
      const colon = text.lastIndexOf(':')
      if (colon !== -1) {
        host = text.slice(0, colon)
        typedPort = text.slice(colon + 1)
        if (typedPort !== '' && !/^\d+$/.test(typedPort)) {
          return rejection('Use host:port, for example 127.0.0.1:3080.')
        }
      }
    }

    host = host.trim().toLowerCase()
    if (host === '') return rejection('Enter the host running "dsh web", for example 127.0.0.1.')
    if (!HOST_NAME.test(host) && !IPV6_LITERAL.test(host)) {
      return rejection(`"${host}" is not a host name or IP address.`)
    }

    let port
    if (typedPort !== '') {
      port = Number(typedPort)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return rejection('The port must be a whole number between 1 and 65535.')
      }
    } else if (schemePort !== undefined) {
      port = schemePort
    } else {
      // An unusable port field is treated as absent, which is what the old
      // normalizer did; only an explicitly typed authority is rejected.
      port = portNumber(rawPort) ?? DEFAULT_PORT
    }

    const stored = typeof fallbackSecure === 'boolean' ? fallbackSecure : null
    return { ok: true, host, port, secure: secure ?? stored, explicitScheme: scheme !== null }
  }

  /**
   * `host:port`, with an IPv6 literal already bracketed by {@link parseAddress}.
   * @param {{ host: string, port: number }} address
   */
  function formatAuthority(address) {
    return `${address.host}:${address.port}`
  }

  /**
   * The address to use when nothing was typed into the popup.
   * @param {{ host: string, port: number }} address
   */
  function fallbackWsUrl(address) {
    const scheme = address.secure === true ? 'wss' : 'ws'
    return `${scheme}://${formatAuthority(address)}${PROTOCOL.WS_PATH}`
  }

  /**
   * Health URLs to try, in order. Two candidates only when the popup has no
   * scheme: the plain one is tried first (the default local host is HTTP), and
   * the TLS one only if that does not answer.
   * @param {{ host: string, port: number, secure: boolean | null }} address
   * @returns {{ url: string, secure: boolean }[]}
   */
  function healthCandidates(address) {
    const schemes = address.secure === true ? ['https'] : address.secure === false ? ['http'] : ['http', 'https']
    return schemes.map((scheme) => ({
      url: `${scheme}://${formatAuthority(address)}${PROTOCOL.HEALTH_PATH}`,
      secure: scheme === 'https',
    }))
  }

  /**
   * Validate the body of `/ext/anno/health`.
   * @param {unknown} body
   * @returns {{ secure: boolean, wsUrl: string } | null}
   */
  function parseHealth(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
    const record = /** @type {Record<string, unknown>} */ (body)
    const wsUrl = typeof record.wsUrl === 'string' ? record.wsUrl.trim() : ''
    const secure = typeof record.secure === 'boolean' ? record.secure : undefined
    if (wsUrl === '' && secure === undefined) return null
    if (wsUrl !== '' && !/^wss?:\/\//i.test(wsUrl)) return null
    return { secure: secure ?? /^wss:/i.test(wsUrl), wsUrl }
  }

  /**
   * Parse an advertised websocket URL into the parts this module compares.
   * @param {string} text
   * @returns {{ secure: boolean, hostname: string, port: number, path: string, url: string } | null}
   */
  function parseWsUrl(text) {
    let parsed
    try {
      parsed = new URL(text)
    } catch {
      return null
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null
    if (parsed.hostname === '') return null
    const secure = parsed.protocol === 'wss:'
    return {
      secure,
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port === '' ? (secure ? 443 : 80) : Number(parsed.port),
      path: parsed.pathname === '' || parsed.pathname === '/' ? PROTOCOL.WS_PATH : parsed.pathname,
      url: parsed.href,
    }
  }

  /** @param {string} host */
  function bareHost(host) {
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  }

  /**
   * @param {{ hostname: string, port: number }} advertised
   * @param {{ host: string, port: number }} address
   */
  function sameAuthority(advertised, address) {
    return bareHost(advertised.hostname) === bareHost(address.host) && advertised.port === address.port
  }

  /**
   * Choose the URL to open.
   *
   * The advertised `wsUrl` wins only when it names the host the user configured
   * (the reverse-proxy case, where the public host is the configured one). When
   * it names a different authority the health response is still authoritative
   * about the *scheme*, but the extension keeps talking to the address the user
   * typed instead of silently following a redirect.
   *
   * @param {{ address: { host: string, port: number, secure: boolean | null }, health?: { secure: boolean, wsUrl: string } | null }} input
   * @returns {{ wsUrl: string, secure: boolean, source: 'health' | 'configured' }}
   */
  function selectWsUrl({ address, health }) {
    if (health === null || health === undefined) {
      return { wsUrl: fallbackWsUrl(address), secure: address.secure === true, source: 'configured' }
    }
    const advertised = health.wsUrl === '' ? null : parseWsUrl(health.wsUrl)
    const secure = advertised === null ? health.secure : advertised.secure
    if (advertised !== null && sameAuthority(advertised, address)) {
      return { wsUrl: advertised.url, secure, source: 'health' }
    }
    return {
      wsUrl: `${secure ? 'wss' : 'ws'}://${formatAuthority(address)}${PROTOCOL.WS_PATH}`,
      secure,
      source: 'health',
    }
  }

  /**
   * The authority of a websocket URL, for error text.
   * @param {unknown} url
   */
  function authorityOf(url) {
    try {
      const parsed = new URL(String(url ?? ''))
      return parsed.host
    } catch {
      return ''
    }
  }

  /**
   * Explain why a websocket closed, separating the three failure modes that all
   * look alike from the background console:
   *
   *   - the port speaks HTTP but has no bridge endpoint (code 1015);
   *   - a plaintext `ws://` met a TLS-only port, or the extension page policy
   *     rewrote it to `wss://` (code 1006 on a `ws://` URL);
   *   - TLS was attempted on a port that does not speak it (code 1006 on a
   *     `wss://` URL).
   *
   * @param {object} input
   * @param {number} input.code
   * @param {string} [input.url] the URL that was attempted
   * @param {'health' | 'configured'} [input.source] where that URL came from
   * @param {string} [input.healthUrl] the health URL that was probed
   * @param {string} [input.reason]
   * @returns {string}
   */
  function describeClose({ code, url = '', source = 'configured', healthUrl = '', reason = '' }) {
    const detail = typeof reason === 'string' && reason !== '' ? ` (${reason})` : ''
    const secure = /^wss:/i.test(url)
    const authority = authorityOf(url) || 'the configured address'
    const probeAnswered = source === 'health'
    const probe = healthUrl === '' ? 'the health probe' : `the health probe at ${healthUrl}`
    switch (code) {
      case 1000:
        return 'the host closed the connection'
      case 1006:
        if (secure) {
          return `could not open a secure websocket at ${url}${detail}: nothing accepted TLS on ${authority}. Either that port serves plain "dsh web" (use ws:// in the popup), or its certificate is not trusted by this browser. ${probeAnswered ? 'The host asked for wss, so a reverse proxy in front of it is the likely place to look.' : ''}`.trim()
        }
        return `could not open a websocket at ${url}${detail}: nothing accepted a plaintext ws:// upgrade on ${authority}. Either nothing is listening there, the port only speaks TLS (wss://), or the extension page policy rewrote this request to wss:// (Firefox MV3 does that by default through upgrade-insecure-requests; the manifest must declare a content_security_policy without it). ${probeAnswered ? `${probe} answered, so the port is reachable: switch the popup address to wss:// if the host is behind TLS.` : `${probe} failed too, so the extension used the address saved in the popup.`}`
      case 1015:
        return `the port answered HTTP but refused the websocket upgrade at ${url}${detail}: there is no bridge endpoint there. Either that DSH profile does not have the dsh-annotate bundle enabled, or a reverse proxy forwards HTTP but not the Upgrade header. A plaintext ws:// sent to a TLS-only port fails earlier with code 1006, so this is not a scheme mismatch.`
      case 4400:
        return `the host rejected the handshake${detail}`
      case 4401:
        return `the host requires the bridge token${detail}`
      case 4403:
        return `the token was rejected; paste the current $DSH_HOME/ext-bridge-token in the popup${detail}`
      default:
        return code === 0 ? `connection failed${detail}` : `connection closed with code ${code}${detail}`
    }
  }

  ns.endpoints = {
    DEFAULT_HOST,
    DEFAULT_PORT,
    DEFAULT_ADDRESS,
    parseAddress,
    formatAuthority,
    fallbackWsUrl,
    healthCandidates,
    parseHealth,
    parseWsUrl,
    selectWsUrl,
    describeClose,
    authorityOf,
  }
})()
