/**
 * dsh-marker popup — the i18n logic.
 *
 * The strings live in `src/shared/popup-strings.js` (data only, one object per
 * locale); this file is the behavior around them: which locale to speak, how
 * placeholders are substituted, and how a half-translated table degrades. The
 * content overlay has its own two-locale table in `content/ui/strings.js`;
 * the popup is a separate surface with its own vocabulary (connection state,
 * records, feedback), so the two tables never share keys.
 *
 * `pickLanguage` collapses every `zh*` tag onto `zh` and everything else onto
 * `en`, which is exactly the set of shipped locales.
 */
;(function installI18n(global) {
  const ns = (global.__DSH_I18N__ = global.__DSH_I18N__ || {})
  if (ns.ready) return

  /** The tables from `popup-strings.js`. An absent file degrades to key names. */
  const POPUP = global.__DSH_POPUP_STRINGS__ || {}

  /**
   * The browser UI language, which is what the extension should speak even when
   * the page itself is in another one. `browser.i18n` is available in the popup
   * (the Chromium shim aliases `browser` before this file).
   * @param {any} [scope]
   */
  function browserLanguage(scope) {
    const api = scope && (scope.browser || scope.chrome)
    try {
      if (api && api.i18n && typeof api.i18n.getUILanguage === 'function') {
        const language = api.i18n.getUILanguage()
        if (typeof language === 'string' && language !== '') return language
      }
    } catch {
      // A context without i18n falls back to the page/navigator language.
    }
    const navigator = scope && scope.navigator
    return navigator && typeof navigator.language === 'string' ? navigator.language : 'en'
  }

  /**
   * Browser locale → shipped table.
   * @param {string} [language]
   * @returns {'en' | 'zh'}
   */
  function pickLanguage(language) {
    return String(language || '')
      .trim()
      .toLowerCase()
      .startsWith('zh')
      ? 'zh'
      : 'en'
  }

  /**
   * Replace `{name}` placeholders. Values are inserted verbatim: callers pass
   * numbers, origins, and already-localized fragments, never markup.
   * @param {string} template
   * @param {Record<string, string | number>} [vars]
   */
  function format(template, vars) {
    const values = vars && typeof vars === 'object' ? vars : {}
    return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
      Object.hasOwn(values, name) ? String(values[name]) : match,
    )
  }

  /**
   * Build a translator. A missing key falls back to English and then to the key
   * itself, so a half-translated table never throws or blanks a label.
   * @param {string} [language]
   */
  function make(language) {
    const languageKey = pickLanguage(language)
    const selected = POPUP[languageKey] || POPUP.en || {}
    const fallback = POPUP.en || {}
    /** @param {string} key @param {Record<string, string | number>} [vars] */
    return function translate(key, vars) {
      const value = Object.hasOwn(selected, key) ? selected[key] : fallback[key]
      return format(value === undefined ? key : value, vars)
    }
  }

  ns.POPUP = POPUP
  ns.pickLanguage = pickLanguage
  ns.browserLanguage = browserLanguage
  ns.format = format
  ns.make = make
  ns.ready = true
})(globalThis)
