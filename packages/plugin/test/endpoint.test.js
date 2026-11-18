/**
 * Scheme negotiation, unit-tested away from any socket.
 *
 * `describeEndpoint` is the only place that decides whether the browser should
 * connect with `ws://` or `wss://`, so each branch is pinned here with the
 * request evidence it consumes: the serving socket, the listener configuration,
 * and the forwarding headers of a TLS-terminating proxy. The bridge tests then
 * prove the same function over real HTTP and HTTPS listeners.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeEndpoint, firstForwardedValue, sanitizeAuthority } from '../src/endpoint.js'
import { WS_PATH } from '../src/protocol.js'

/** @param {Record<string, string>} headers */
function requestWith(headers) {
  return { headers, socket: { encrypted: false } }
}

test('a plain request on a plain listener advertises ws://', () => {
  const endpoint = describeEndpoint({
    request: requestWith({ host: '127.0.0.1:3080' }),
    webServer: { protocol: 'http:', getOrigin: () => 'http://127.0.0.1:3080' },
  })
  assert.equal(endpoint.secure, false)
  assert.equal(endpoint.scheme, 'ws')
  assert.equal(endpoint.wsUrl, `ws://127.0.0.1:3080${WS_PATH}`)
  assert.equal(endpoint.source, 'plain')
})

test('a TLS socket makes the endpoint secure even when the listener reports http', () => {
  const endpoint = describeEndpoint({
    // A TLS-terminating listener reports `encrypted` on the socket. The
    // webserver stub here intentionally disagrees, to prove the socket wins.
    request: { headers: { host: '127.0.0.1:3443' }, socket: { encrypted: true } },
    webServer: { protocol: 'http:' },
  })
  assert.equal(endpoint.secure, true)
  assert.equal(endpoint.wsUrl, `wss://127.0.0.1:3443${WS_PATH}`)
  assert.equal(endpoint.source, 'tls-socket')
})

test('a TLS listener is detected from its protocol or its origin', () => {
  const fromProtocol = describeEndpoint({
    request: requestWith({ host: '10.0.0.4:8443' }),
    webServer: { protocol: 'https:' },
  })
  assert.equal(fromProtocol.secure, true)
  assert.equal(fromProtocol.wsUrl, `wss://10.0.0.4:8443${WS_PATH}`)
  assert.equal(fromProtocol.source, 'tls-listener')

  // DSH versions before the `protocol` getter only expose `getOrigin()`.
  const fromOrigin = describeEndpoint({
    request: requestWith({ host: '10.0.0.4:8443' }),
    webServer: { getOrigin: () => 'https://10.0.0.4:8443' },
  })
  assert.equal(fromOrigin.secure, true)
  assert.equal(fromOrigin.source, 'tls-listener')
})

test('x-forwarded-proto says wss:// and x-forwarded-host names the public host', () => {
  const endpoint = describeEndpoint({
    request: requestWith({
      host: '127.0.0.1:3080',
      'x-forwarded-proto': 'https, http',
      'x-forwarded-host': 'anno.example.com',
    }),
  })
  assert.equal(endpoint.secure, true)
  assert.equal(endpoint.wsUrl, `wss://anno.example.com${WS_PATH}`)
  assert.equal(endpoint.source, 'forwarded-proto')
})

test('forwarded headers are read case-insensitively and only their first value', () => {
  const endpoint = describeEndpoint({
    request: requestWith({
      host: '127.0.0.1:3080',
      'x-forwarded-proto': 'HTTPS, http',
      'x-forwarded-host': 'Anno.Example.com:8443, internal.local:3080',
    }),
  })
  assert.equal(endpoint.secure, true)
  assert.equal(endpoint.wsUrl, `wss://anno.example.com:8443${WS_PATH}`)
  assert.equal(firstForwardedValue('http, https'), 'http')
})

test('an explicit forwarded http keeps the endpoint on ws://', () => {
  const endpoint = describeEndpoint({
    request: requestWith({ 'x-forwarded-proto': 'http', 'x-forwarded-host': 'anno.example.com' }),
  })
  assert.equal(endpoint.secure, false)
  assert.equal(endpoint.wsUrl, `ws://anno.example.com${WS_PATH}`)
  assert.equal(endpoint.source, 'forwarded-proto')
})

test('a malformed forwarded host falls back to Host, then to the listener authority', () => {
  const fromHostHeader = describeEndpoint({
    request: requestWith({
      host: '127.0.0.1:3080',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'not a host/with/path',
    }),
  })
  assert.equal(fromHostHeader.wsUrl, `wss://127.0.0.1:3080${WS_PATH}`)

  const fromListener = describeEndpoint({
    request: requestWith({ host: 'also not a host', 'x-forwarded-proto': 'https' }),
    webServer: { protocol: 'https:', getOrigin: () => 'https://10.0.0.4:8443' },
  })
  assert.equal(fromListener.wsUrl, `wss://10.0.0.4:8443${WS_PATH}`)
})

test('the listener fallback brackets IPv6 bind addresses', () => {
  const endpoint = describeEndpoint({
    request: requestWith({}),
    webServer: { protocol: 'http:', host: '::1', port: 3080 },
  })
  assert.equal(endpoint.wsUrl, `ws://[::1]:3080${WS_PATH}`)
})

test('an IPv6 Host header is preserved verbatim', () => {
  const endpoint = describeEndpoint({
    request: requestWith({ host: '[::1]:3080' }),
    webServer: { protocol: 'http:' },
  })
  assert.equal(endpoint.wsUrl, `ws://[::1]:3080${WS_PATH}`)
})

test('with no request evidence at all the loopback default is advertised', () => {
  const endpoint = describeEndpoint()
  assert.equal(endpoint.wsUrl, `ws://127.0.0.1${WS_PATH}`)
  assert.equal(endpoint.secure, false)
})

test('sanitizeAuthority accepts a host, a port, and a bracketed IPv6 literal', () => {
  assert.equal(sanitizeAuthority('127.0.0.1'), '127.0.0.1')
  assert.equal(sanitizeAuthority('ANNO.example.com:8443'), 'anno.example.com:8443')
  assert.equal(sanitizeAuthority('[::1]:3080'), '[::1]:3080')
  assert.equal(sanitizeAuthority('anno.example.com, internal:3080'), 'anno.example.com')
})

test('sanitizeAuthority rejects anything that is not an authority', () => {
  for (const value of [
    undefined,
    null,
    '',
    '   ',
    ':3080',
    'anno.example.com:',
    'anno.example.com:0',
    'anno.example.com:65536',
    'anno.example.com:abc',
    'anno.example.com/path',
    'anno.example.com?a=1',
    'anno example.com',
    'anno.example.com\nx',
    '::1',
    '['.repeat(2),
    'a'.repeat(256),
  ]) {
    assert.equal(sanitizeAuthority(value), undefined, `accepted ${String(value)}`)
  }
})
