/**
 * The shared admission gate for the five Web-Client routes (queue, queue/ack,
 * focus, events, item, image).
 *
 * Their page is the Host's own GUI, and the Host already owns a fence for
 * exactly that trust: `ctx.connection.requestRejection` applies the Host/
 * Origin checks that stop DNS rebinding (a rebound page carries the attacker's
 * Host header while the socket reaches this server, so `sec-fetch-site` alone
 * cannot tell it from the page) plus the browser-session authentication the
 * GUI page already holds. Hosts that predate the Connection service keep the
 * `sec-fetch-site` check the routes default to.
 */

/**
 * Build the gate the page routes consult before anything else.
 *
 * The service is read per request, not once at boot: plugin load order is a
 * deployment fact, and a fence that appears or disappears later must apply to
 * the next request, not the next start.
 *
 * @param {object} options
 * @param {(service: string) => any} options.get the host's service reader
 * @param {{ debug?: (...args: any[]) => void }} [options.logger]
 * @returns {(request: any) => 401 | 403 | undefined} rejection status, or undefined when the request may proceed
 */
export function createPageGate({ get, logger }) {
  let said = false
  return (request) => {
    const connection = get('connection')
    if (typeof connection?.requestRejection === 'function') {
      return connection.requestRejection(request)
    }
    // No Connection service: a host that serves no authenticated GUI has no
    // page these routes belong to, so the header check the routes shipped with
    // stays the fence. Say so once instead of per request.
    if (!said) {
      said = true
      logger?.debug?.('annotations: no connection service mounted; the page routes keep the sec-fetch-site gate')
    }
    return request.headers?.['sec-fetch-site'] === 'same-origin' ? undefined : 403
  }
}
