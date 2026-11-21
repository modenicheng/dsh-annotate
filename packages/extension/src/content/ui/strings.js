/**
 * dsh-marker content script 3/4 (ui) — the overlay's view of the language
 * tables.
 *
 * The tables themselves live in `src/shared/i18n.js`, which the popup reads
 * too; this file only resolves the browser UI language once and publishes the
 * surface the other `ui/` parts consume. Loaded after `src/shared/i18n.js` and
 * before the rest of `ui/`.
 */
;(function installUiStrings(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  const ui = (ns.ui = ns.ui || {})

  // `scripting.executeScript` may inject these files a second time when the
  // manifest-declared content script has not answered yet, so installing twice
  // must be a no-op rather than a second set of nodes and listeners.
  if (ui.strings) return

  const i18n = global.__DSH_I18N__
  if (!i18n) return

  const language = i18n.pickLanguage(i18n.browserLanguage(global))

  ui.strings = {
    STRINGS: i18n.UI,
    pickLanguage: i18n.pickLanguage,
    format: i18n.format,
    make: (scopeLanguage) => i18n.make('ui', scopeLanguage || language),
    /** Resolved once at load; every overlay label speaks this language. */
    language,
    browserLanguage: i18n.browserLanguage,
  }
})(globalThis)
