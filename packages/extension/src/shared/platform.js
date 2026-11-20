/**
 * The platform seam: the `browser` namespace, engine detection, and the
 * `runtime.onMessage` adapter.
 *
 * Every context loads this file before anything else (the Chromium service
 * worker imports it first, the manifest lists it first where the manifest owns
 * the script list). It exists because two engine differences reach every other
 * file:
 *
 *   1. Chrome exposes `browser` only from version 148; until then only `chrome`
 *      exists, while every other script here calls `browser.*`.
 *   2. Below version 148, a `runtime.onMessage` listener that returns a promise
 *      gets its channel closed and the caller receives `undefined`. Gecko
 *      documents exactly that promise as the reply, so the two engines want
 *      different listener shapes for one handler.
 *
 * Both are absorbed here so no other file needs an engine branch. Gecko sees a
 * no-op: `browser` is already there and the handler is registered unchanged.
 *
 * Classic script (`importScripts`, `<script src>`, `background.scripts`): it
 * publishes `globalThis.__DSH_PLATFORM__` and returns. Loading it twice is a
 * no-op, and loading it in a context with no extension API at all (a test
 * global) must not throw.
 */
;(() => {
  const NAMESPACE_KEY = '__DSH_PLATFORM__'
  // A second load (a re-injected content script, a duplicated `<script>` tag)
  // must not replace the shim the first load published.
  if (globalThis[NAMESPACE_KEY] !== undefined) return

  // Alias before reading, so the rest of this file has one name to use. On
  // Gecko this assigns `browser` to itself; on Chromium it is the only reason
  // the unchanged `browser.*` calls elsewhere keep working below Chrome 148.
  if (globalThis.browser === undefined && globalThis.chrome !== undefined) globalThis.browser = globalThis.chrome
  const api = globalThis.browser ?? globalThis.chrome

  /**
   * Is this Gecko?
   *
   * The runtime URL prefix is the only synchronous discriminator the two
   * engines disagree on: `moz-extension:` versus `chrome-extension:`. A user
   * agent string is wrong on forks (Zen, LibreWolf, Opera), and the namespace
   * check is wrong everywhere `browser` is polyfilled, so neither is used.
   * An unresolvable URL counts as Gecko: the raw listener is the form every
   * engine accepts, while the wrapper exists only for pre-148 Chromium.
   * @returns {boolean}
   */
  function detectGecko() {
    let url = ''
    try {
      url = typeof api?.runtime?.getURL === 'function' ? String(api.runtime.getURL('')) : ''
    } catch {
      // A namespace without a usable getURL tells us nothing: stay with Gecko.
      url = ''
    }
    return url === '' || url.startsWith('moz-extension:')
  }

  const isGecko = detectGecko()
  const isChromium = !isGecko

  /**
   * Register one async `runtime.onMessage` handler on either engine.
   *
   * Gecko: the documented form is to return a promise from the listener, so
   * the handler is registered as-is. Chromium (below 148): that promise is
   * ignored and the channel closes, so the listener must answer through
   * `sendResponse` and return `true` to hold the channel open until it does.
   * The handler itself is written once, producing the same reply on both.
   *
   * An answer of `undefined` is sent, not skipped: it is what the sender sees
   * on Gecko for an unknown message type, and sending it keeps `sendMessage`
   * from rejecting with "the message port closed before a response was
   * received" instead of resolving.
   *
   * A rejected handler still answers — in the `{ ok: false, error }` envelope
   * the rest of the extension uses — because a silent channel is exactly the
   * failure this wrapper exists to prevent.
   * @param {(message: any, sender: any) => Promise<any> | any} handler
   * @returns {boolean} whether a listener could be registered at all
   */
  function onMessage(handler) {
    const event = api?.runtime?.onMessage
    if (event === undefined || event === null || typeof event.addListener !== 'function') return false
    if (isGecko) {
      event.addListener(handler)
      return true
    }
    event.addListener((message, sender, sendResponse) => {
      /** @param {any} value */
      const reply = (value) => {
        try {
          sendResponse(value)
        } catch {
          // The sender navigated away or the page closed: nothing to report to.
        }
      }
      Promise.resolve(handler(message, sender)).then(reply, (error) => {
        // `instanceof Error` is false for an error from another realm (a test's,
        // a frame's), so the message is read structurally as well.
        const text = error instanceof Error ? error.message : String(error?.message ?? error)
        console.error(`dsh-marker: message handler failed: ${text}`)
        reply({ ok: false, error: text })
      })
      // Chromium's contract: `true` says "an answer follows", and only that
      // keeps the channel open across the promise above.
      return true
    })
    return true
  }

  globalThis[NAMESPACE_KEY] = { isGecko, isChromium, onMessage }
})()
