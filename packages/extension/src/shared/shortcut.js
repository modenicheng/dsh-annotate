/**
 * dsh-marker — one shortcut spec shared by the popup recorder and the page.
 *
 * A shortcut is stored as a canonical string such as `Alt+Shift+A`. The popup
 * turns a recorded `KeyboardEvent` into that string and hands it to
 * `commands.update`; the content script parses the same string and matches
 * keydowns, which is the fallback on browsers that cannot change an extension
 * command (Chromium) and the safety net when Firefox rejects a combination.
 *
 * `event.code` is the input, never `event.key`: on a non-Latin layout `key` is
 * the character produced (e.g. `ф`), while the physical key is still KeyA and
 * that is what the browser command format names.
 */
;(function installShortcut(global) {
  const ns = (global.__DSH_SHORTCUT__ = global.__DSH_SHORTCUT__ || {})
  if (ns.ready) return

  const DEFAULT = 'Alt+Shift+A'
  /** Modifier tokens in the order every rendered spec uses. */
  const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta']
  /** Lower-case spellings accepted on input, mapped to the canonical token. */
  const MODIFIER_ALIASES = {
    ctrl: 'Ctrl',
    control: 'Ctrl',
    macctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Meta',
    command: 'Meta',
  }
  /** `event.code` → the key token the browser command format accepts. */
  const CODES = {
    KeyA: 'A',
    KeyB: 'B',
    KeyC: 'C',
    KeyD: 'D',
    KeyE: 'E',
    KeyF: 'F',
    KeyG: 'G',
    KeyH: 'H',
    KeyI: 'I',
    KeyJ: 'J',
    KeyK: 'K',
    KeyL: 'L',
    KeyM: 'M',
    KeyN: 'N',
    KeyO: 'O',
    KeyP: 'P',
    KeyQ: 'Q',
    KeyR: 'R',
    KeyS: 'S',
    KeyT: 'T',
    KeyU: 'U',
    KeyV: 'V',
    KeyW: 'W',
    KeyX: 'X',
    KeyY: 'Y',
    KeyZ: 'Z',
    Digit0: '0',
    Digit1: '1',
    Digit2: '2',
    Digit3: '3',
    Digit4: '4',
    Digit5: '5',
    Digit6: '6',
    Digit7: '7',
    Digit8: '8',
    Digit9: '9',
    F1: 'F1',
    F2: 'F2',
    F3: 'F3',
    F4: 'F4',
    F5: 'F5',
    F6: 'F6',
    F7: 'F7',
    F8: 'F8',
    F9: 'F9',
    F10: 'F10',
    F11: 'F11',
    F12: 'F12',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Space: 'Space',
    Comma: 'Comma',
    Period: 'Period',
  }
  /** One key token → the `event.code` that produces it. */
  const REVERSE = new Map(Object.entries(CODES).map(([code, token]) => [token, code]))

  /** @param {string} value */
  function isFunctionKey(value) {
    return /^F([1-9]|1[0-2])$/.test(value)
  }

  /**
   * Canonicalize a shortcut string, or return null when it is not a shortcut
   * this extension can match and the browser can receive. At least one of
   * Ctrl/Alt/Meta is required except for function keys, which are safe alone.
   * @param {string} value
   * @returns {string | null}
   */
  function normalize(value) {
    if (typeof value !== 'string') return null
    const parts = value
      .split('+')
      .map((part) => part.trim())
      .filter((part) => part !== '')
    if (parts.length < 2) {
      // "F5" alone is legitimate; a bare letter is not.
      if (parts.length !== 1) return null
      const raw = parts[0].toLowerCase()
      const canonical = [...REVERSE.keys()].find((token) => token.toLowerCase() === raw)
      return canonical !== undefined && isFunctionKey(canonical) ? canonical : null
    }
    const modifiers = new Set()
    let key = null
    for (const part of parts) {
      const raw = part.toLowerCase()
      const modifier = MODIFIER_ALIASES[raw]
      if (modifier !== undefined) {
        if (modifiers.has(modifier)) return null
        modifiers.add(modifier)
        continue
      }
      if (key !== null) return null
      // Key names are canonical upper-case in the table; accept any casing on
      // input so a hand-edited preference still resolves.
      const canonical = [...REVERSE.keys()].find((token) => token.toLowerCase() === raw)
      if (canonical === undefined) return null
      key = canonical
    }
    if (key === null) return null
    if (!isFunctionKey(key) && !modifiers.has('Ctrl') && !modifiers.has('Alt') && !modifiers.has('Meta')) {
      return null
    }
    return [...MODIFIERS.filter((modifier) => modifiers.has(modifier)), key].join('+')
  }

  /**
   * Turn a recorded keydown into a canonical shortcut, or null while the user
   * is still holding modifiers or pressed a key this format cannot name.
   * @param {{ code?: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean }} event
   * @returns {string | null}
   */
  function fromEvent(event) {
    if (event === null || typeof event !== 'object') return null
    const key = CODES[event.code]
    if (key === undefined) return null
    const modifiers = []
    if (event.ctrlKey === true) modifiers.push('Ctrl')
    if (event.altKey === true) modifiers.push('Alt')
    if (event.shiftKey === true) modifiers.push('Shift')
    if (event.metaKey === true) modifiers.push('Meta')
    if (!isFunctionKey(key) && !modifiers.some((modifier) => modifier !== 'Shift')) return null
    return [...modifiers, key].join('+')
  }

  /**
   * The display form. The canonical string already reads well; this only keeps
   * a single implementation so the popup and the page tooltip cannot drift.
   * @param {string} value
   */
  function label(value) {
    return normalize(value) || DEFAULT
  }

  /**
   * Does this keydown fire `spec`? Modifiers must match exactly, because
   * `Alt+Shift+A` should not fire on `Ctrl+Alt+Shift+A`.
   * @param {{ code?: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean, repeat?: boolean }} event
   * @param {string} spec
   */
  function matches(event, spec) {
    const wanted = normalize(spec) || DEFAULT
    const recorded = fromEvent(event)
    return recorded !== null && recorded === wanted
  }

  ns.DEFAULT = DEFAULT
  ns.normalize = normalize
  ns.fromEvent = fromEvent
  ns.label = label
  ns.matches = matches
  ns.ready = true
})(globalThis)
