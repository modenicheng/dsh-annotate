/**
 * Endpoint negotiation for the bridge: "which URL should the browser use?"
 *
 * The host answers this question, so `/ext/anno/health` reports `secure` and a
 * complete `wsUrl` instead of leaving the extension to guess. The negotiation
 * exists for deployments where the bridge is *genuinely* served over TLS: `dsh
 * web` configured with `tls`, or a TLS-terminating reverse proxy in front of a
 * plain listener. The default local deployment is neither — a stock `dsh web`
 * binds loopback and speaks plain HTTP, so it must keep advertising `ws://`,
 * and the extension must keep requesting it. (A browser-side upgrade mechanism,
 * such as the MV3 default `upgrade-insecure-requests`, is a policy bug on the
 * extension side and is fixed in the manifest's explicit CSP, not here.)
 *
 * A client cannot infer the answer from the port, and guessing fails in both
 * directions: `wss://` against a plain listener, and `ws://` against a TLS one.
 *
 * The decision has three inputs, in order of authority:
 *
 * 1. the serving socket (`request.socket.encrypted`), which is what node
 *    reports for a connection the listener terminated itself;
 * 2. the listener configuration (`webServer.protocol` / `getOrigin()`), which
 *    covers TLS configured on the DSH webserver;
 * 3. the forwarding headers a TLS-terminating reverse proxy sets
 *    (`x-forwarded-proto`, first value, then `x-forwarded-host`).
 *
 * @module dsh-marker/endpoint
 */

import { WS_PATH } from './protocol.js'

/** Where a TLS-terminating proxy states the scheme the browser used. */
const FORWARDED_PROTO = 'x-forwarded-proto'
/** Where that proxy states the host the browser used. */
const FORWARDED_HOST = 'x-forwarded-host'

/**
 * The first value of a comma-separated forwarding header, lower-cased.
 *
 * Proxies append to these headers as a request travels inward, so the leftmost
 * value is the one the browser (the outermost hop) used. `https, http` therefore
 * means "TLS from the browser to the first proxy"; a plain `Array.isArray`-safe
 * read is not needed because node joins duplicate headers with commas.
 * @param {unknown} value
 * @returns {string}
 */
export function firstForwardedValue(value) {
  if (typeof value !== 'string') return ''
  return value.split(',')[0].trim().toLowerCase()
}

/**
 * Accept a `host[:port]` authority and reject everything else.
 *
 * `Host` and `X-Forwarded-Host` are client-controlled strings that end up inside
 * the advertised URL, so the value is restricted to characters an authority can
 * contain. IPv6 literals must be bracketed; a bare address with several colons
 * is not a valid authority and is refused rather than guessed at.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function sanitizeAuthority(value) {
  if (typeof value !== 'string') return undefined
  const first = value.split(',')[0].trim().toLowerCase()
  if (first === '' || first.length > 255) return undefined
  if (!/^[a-z0-9._:[\]-]+$/.test(first)) return undefined
  if (first.startsWith('[')) {
    const close = first.indexOf(']')
    if (close === -1) return undefined
    const rest = first.slice(close + 1)
    if (rest !== '' && !validPortSuffix(rest)) return undefined
    return first
  }
  if ((first.match(/:/g) ?? []).length > 1) return undefined
  const colon = first.indexOf(':')
  if (colon === -1) return first
  if (colon === 0 || colon === first.length - 1) return undefined
  if (!validPortSuffix(first.slice(colon))) return undefined
  return first
}

/**
 * @param {string} suffix a `:port` string
 * @returns {boolean}
 */
function validPortSuffix(suffix) {
  if (!/^:\d{1,5}$/.test(suffix)) return false
  const port = Number(suffix.slice(1))
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * The protocol the listener itself speaks, from configuration rather than from
 * a request. `getOrigin()` is the fallback for DSH versions that predate the
 * `protocol` getter; it throws before the listener binds, which a health request
 * cannot hit but a unit test can.
 * @param {any} webServer
 * @returns {boolean}
 */
export function listenerUsesTls(webServer) {
  if (webServer === undefined || webServer === null) return false
  if (webServer.protocol === 'https:') return true
  try {
    const origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : ''
    return typeof origin === 'string' && /^https:/i.test(origin)
  } catch {
    return false
  }
}

/**
 * The authority the listener is bound to, for requests without a usable `Host`.
 * @param {any} webServer
 * @returns {string | undefined}
 */
export function listenerAuthority(webServer) {
  try {
    const origin = typeof webServer?.getOrigin === 'function' ? webServer.getOrigin() : ''
    if (typeof origin === 'string' && origin !== '') return sanitizeAuthority(new URL(origin).host)
  } catch {
    // Not bound yet, or no URL form: fall through to the configured pair.
  }
  const host = typeof webServer?.host === 'string' ? webServer.host : ''
  const port = Number(webServer?.port)
  if (host === '' || !Number.isInteger(port) || port <= 0) return undefined
  return sanitizeAuthority(host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`)
}

/**
 * @typedef {object} BridgeEndpoint
 * @property {boolean} secure Whether the browser must use `wss://`.
 * @property {'ws' | 'wss'} scheme The websocket scheme to advertise.
 * @property {string} wsUrl Complete websocket URL for this request.
 * @property {string} authority The advertised `host[:port]`.
 * @property {'tls-socket' | 'tls-listener' | 'forwarded-proto' | 'plain'} source
 *   Which evidence decided the scheme; useful when a proxy in front is
 *   misconfigured and the health response needs to explain itself.
 */

/**
 * Describe the endpoint a client reaching this request should connect to.
 * @param {object} [input]
 * @param {any} [input.request] node `IncomingMessage` of the health request.
 * @param {any} [input.webServer] the DSH webserver service the bridge sits on.
 * @param {string} [input.path] websocket path to append.
 * @returns {BridgeEndpoint}
 */
export function describeEndpoint({ request, webServer, path = WS_PATH } = {}) {
  const tlsSocket = request?.socket?.encrypted === true
  const tlsListener = !tlsSocket && listenerUsesTls(webServer)
  const forwarded = firstForwardedValue(request?.headers?.[FORWARDED_PROTO])
  const forwardedSecure = forwarded === 'https' || forwarded === 'wss'
  const forwardedPlain = forwarded === 'http' || forwarded === 'ws'
  const secure = tlsSocket || tlsListener || forwardedSecure
  const scheme = secure ? 'wss' : 'ws'
  const authority =
    sanitizeAuthority(request?.headers?.[FORWARDED_HOST]) ??
    sanitizeAuthority(request?.headers?.host) ??
    listenerAuthority(webServer) ??
    '127.0.0.1'
  /** @type {BridgeEndpoint['source']} */
  let source = 'plain'
  if (tlsSocket) source = 'tls-socket'
  else if (tlsListener) source = 'tls-listener'
  else if (forwardedSecure || forwardedPlain) source = 'forwarded-proto'
  return { secure, scheme, authority, source, wsUrl: `${scheme}://${authority}${path}` }
}
