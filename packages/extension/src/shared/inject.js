/**
 * Content-script injection, shared between the background and the popup.
 *
 * Both contexts repair a tab that predates the install the same way: read the
 * declared `content_scripts` files from the manifest (in order, deduplicated)
 * and inject them with `browser.scripting.executeScript`. The list used to be
 * generated line-for-line in `background/routing.js` and `popup/popup.js`;
 * this file is the single point that reads the manifest now.
 *
 * Classic script: loaded by the background event page (after
 * `src/shared/protocol.global.js`) and by `popup.html`, in either context.
 */
;(function installInject(global) {
  if (global.__DSH_INJECT__) return

  /**
   * The declared content-script files in manifest order, deduplicated.
   * @param {any} manifest a parsed manifest (`ns.manifest` in the background,
   *   `browser.runtime.getManifest()` in the popup)
   * @returns {string[]}
   */
  function contentScriptFiles(manifest) {
    const groups = Array.isArray(manifest?.content_scripts) ? manifest.content_scripts : []
    const files = []
    for (const group of groups) {
      for (const file of Array.isArray(group.js) ? group.js : []) {
        if (!files.includes(file)) files.push(file)
      }
    }
    return files
  }

  global.__DSH_INJECT__ = { contentScriptFiles }
})(globalThis)
