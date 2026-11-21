/**
 * dsh-marker console hook — runs in the page world (`"world": "MAIN"`).
 *
 * Declared as its own content_scripts group so the engine injects it directly
 * into the page compartment: unlike an inline <script> appended from the
 * isolated world, an extension-declared script is not subject to the page's
 * Content-Security-Policy, so strict-CSP sites (which used to log a CSP
 * violation and silently lose console capture) are covered too.
 *
 * It must stay a plain classic script: no imports and no `browser`/`chrome`
 * APIs, which do not exist in the page world. The message shape is consumed by
 * `onPageMessage` in `src/content/main.js`; `window.__DSH_ANNO_HOOK__` guards
 * against double registration.
 */
;(function () {
  if (window.__DSH_ANNO_HOOK__) return
  window.__DSH_ANNO_HOOK__ = 1
  const post = (item) => {
    try {
      window.postMessage({ __dshAnno: 'console', item: item }, '*')
    } catch {
      // A page that forbids postMessage simply has no console context.
    }
  }
  window.addEventListener(
    'error',
    (event) => {
      try {
        if (event.target && event.target !== window && event.target.nodeType === 1) return
        post({
          kind: 'error',
          message: event.message ? String(event.message) : 'page error',
          source: event.filename ? String(event.filename) : '',
          line: event.lineno || 0,
        })
      } catch {
        // Never let the hook itself become a page error.
      }
    },
    true,
  )
  window.addEventListener('unhandledrejection', (event) => {
    let text = 'unhandled rejection'
    try {
      const reason = event.reason
      if (reason && (reason.stack || reason.message)) text = String(reason.stack || reason.message)
      else if (reason !== undefined) text = String(reason)
    } catch {
      // Fall back to the generic text.
    }
    post({ kind: 'unhandledrejection', message: text })
  })
})()
