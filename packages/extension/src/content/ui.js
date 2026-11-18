/**
 * dsh-annotate content script 3/4 — the annotation UI.
 *
 * Everything the user can see or touch lives in one closed shadow root on
 * `#dsh-anno-root`, with `:host { all: initial }`, so page CSS cannot deform it
 * and page scripts cannot reach the internals. The host itself is `position:
 * fixed` with `pointer-events: none`: children opt back into pointer events,
 * which keeps the page fully usable while annotation mode is idle.
 *
 * All nodes are built with `createElement`/`textContent`; no page-derived
 * string is ever parsed as HTML.
 */
;(function installUi(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  if (ns.ui) return
  if (!global.__DSH_PROTOCOL__) return

  const HOST_ID = ns.HOST_ID || 'dsh-anno-root'

  // ── strings ────────────────────────────────────────────────────────────────

  const STRINGS = {
    en: {
      modeAuto: 'Annotation mode',
      modeSelection: 'Pick: text',
      modeElement: 'Pick: element',
      modeRegion: 'Pick: region',
      hintAuto: 'click element · drag region · Shift+drag text',
      hintSelection: 'select text',
      hintElement: 'click an element',
      hintRegion: 'drag a region',
      hideLayers: 'Hide layers',
      showLayers: 'Show layers',
      exit: 'Exit (Esc)',
      composerSelection: 'Selected text',
      composerElement: 'Element',
      composerRegion: 'Region',
      placeholder: 'What about this?  Enter sends · Shift+Enter adds a line',
      send: 'Send',
      sending: 'Sending…',
      cancel: 'Cancel',
      saved: 'Annotation sent',
      sendFailed: 'Send failed — is the DeepSeek Harness host running?',
      anchorFailed: 'Could not build an anchor for that',
      anchorInvalid: 'Anchor failed protocol validation',
      pickTitle: 'The agent asks',
      pickCancelHint: 'Esc cancels',
      pickCancelled: 'Pick cancelled',
      noComment: '(no comment)',
      agentNote: 'Agent',
      stateOpen: 'open',
      stateResolved: 'resolved',
      stateWontFix: "won't fix",
      kindSelection: 'selection',
      kindElement: 'element',
      kindRegion: 'region',
      offscreen: 'Anchor is outside the viewport',
    },
    zh: {
      modeAuto: '批注模式',
      modeSelection: '选择：文本',
      modeElement: '选择：元素',
      modeRegion: '选择：区域',
      hintAuto: '点元素 · 拖框 · Shift+划词',
      hintSelection: '划词选择',
      hintElement: '点击元素',
      hintRegion: '拖框选区域',
      hideLayers: '隐藏标注',
      showLayers: '显示标注',
      exit: '退出（Esc）',
      composerSelection: '选中文本',
      composerElement: '元素',
      composerRegion: '区域',
      placeholder: '想说点什么？Enter 发送 · Shift+Enter 换行',
      send: '发送',
      sending: '发送中…',
      cancel: '取消',
      saved: '已发送批注',
      sendFailed: '发送失败——DeepSeek Harness 宿主在运行吗？',
      anchorFailed: '无法为该目标生成锚点',
      anchorInvalid: '锚点未通过协议校验',
      pickTitle: '智能体在问',
      pickCancelHint: 'Esc 取消',
      pickCancelled: '已取消这次选择',
      noComment: '（没有评论）',
      agentNote: '智能体',
      stateOpen: '待处理',
      stateResolved: '已解决',
      stateWontFix: '不修',
      kindSelection: '文本',
      kindElement: '元素',
      kindRegion: '区域',
      offscreen: '锚点已不在视口内',
    },
  }

  function pickLanguage(language) {
    return String(language || '')
      .toLowerCase()
      .startsWith('zh')
      ? 'zh'
      : 'en'
  }

  // ── styles ─────────────────────────────────────────────────────────────────

  const CSS = `
:host {
  all: initial;
  position: fixed;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  z-index: 2147483000;
}
*, *::before, *::after { box-sizing: border-box; }
[f-hidden] { display: none !important; }
.hud {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(760px, calc(100vw - 24px));
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.95);
  color: #e5e7eb;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.12);
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  pointer-events: auto;
}
.hud-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6b7280;
  flex: none;
}
.hud-dot[data-state="ok"] { background: #22c55e; }
.hud-dot[data-state="warn"] { background: #f59e0b; }
.hud-dot[data-state="off"] { background: #6b7280; }
.hud-mode { font-weight: 600; white-space: nowrap; }
.hud-hint { color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hud-btn {
  flex: none;
  font: 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  padding: 4px 7px;
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.hud-btn:hover { background: rgba(255, 255, 255, 0.12); }
.hud-btn[aria-pressed="true"] { background: rgba(37, 99, 235, 0.85); border-color: #3b82f6; }
.pick {
  position: fixed;
  top: 58px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: min(680px, calc(100vw - 32px));
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(69, 26, 3, 0.96);
  border: 1px solid rgba(251, 191, 36, 0.5);
  color: #fef3c7;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  pointer-events: auto;
}
.pick-text { flex: 1 1 auto; white-space: pre-wrap; word-break: break-word; }
.pick-meta { flex: none; color: #fcd34d; font-size: 11px; text-align: right; }
.hover-box, .marquee {
  position: fixed;
  border: 2px solid #3b82f6;
  border-radius: 3px;
  background: rgba(59, 130, 246, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
  pointer-events: none;
}
.marquee { border-style: dashed; background: rgba(59, 130, 246, 0.15); }
/* The locked outline marks what the open composer (or a hovered badge) refers
   to. It is a separate element from the transient hover box so a pointer move
   cannot erase the thing the user is currently describing. */
.locked-box {
  position: fixed;
  border: 2px solid #f59e0b;
  border-radius: 3px;
  background: rgba(245, 158, 11, 0.1);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
  pointer-events: none;
}
.hover-chip[data-locked="1"] { background: #b45309; }
.hover-chip {
  position: fixed;
  max-width: min(360px, calc(100vw - 16px));
  padding: 3px 6px;
  border-radius: 4px;
  background: #1d4ed8;
  color: #ffffff;
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.cursor-ring {
  position: fixed;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border-radius: 50%;
  border: 2px solid #3b82f6;
  background: rgba(255, 255, 255, 0.4);
  pointer-events: none;
}
.composer {
  position: fixed;
  padding: 10px;
  border-radius: 10px;
  background: #111827;
  color: #e5e7eb;
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  pointer-events: auto;
}
.composer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.composer-kind { color: #93c5fd; font-weight: 600; white-space: nowrap; }
.composer-summary {
  color: #9ca3af;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 210px;
  direction: ltr;
}
.composer textarea {
  width: 100%;
  min-height: 64px;
  max-height: 220px;
  resize: vertical;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: #0b1220;
  color: #f3f4f6;
  font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  outline: none;
}
.composer textarea:focus { border-color: #3b82f6; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 0; }
.chip {
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.06);
  color: #cbd5e1;
  font: 11px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  cursor: pointer;
}
.chip[aria-pressed="true"] { background: #2563eb; border-color: #3b82f6; color: #ffffff; }
.composer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
}
.composer-hint { color: #6b7280; font-size: 10px; white-space: nowrap; }
.composer-actions { display: flex; gap: 6px; }
.btn {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: transparent;
  color: #e5e7eb;
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  cursor: pointer;
}
.btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-primary { background: #2563eb; border-color: #3b82f6; color: #ffffff; }
.btn-primary:hover:not(:disabled) { background: #1d4ed8; }
.composer-error { margin-top: 6px; color: #fca5a5; font-size: 11px; white-space: pre-wrap; }
.badge {
  position: fixed;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #2563eb;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.55);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  font: 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
  pointer-events: auto;
  cursor: default;
}
.badge[data-state="resolved"] { background: #16a34a; }
.badge[data-state="wont_fix"] { background: #6b7280; }
.badge-card {
  display: none;
  position: absolute;
  top: -2px;
  left: 26px;
  width: 250px;
  padding: 8px;
  border-radius: 8px;
  background: #111827;
  color: #e5e7eb;
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
  font: 11px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.badge[data-flip="1"] .badge-card { left: auto; right: 26px; }
.badge:hover .badge-card { display: block; }
.badge-card-text { white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; }
.badge-card-note { margin-top: 6px; color: #86efac; white-space: pre-wrap; word-break: break-word; }
.badge-card-meta { margin-top: 6px; color: #9ca3af; font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; }
.toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(520px, calc(100vw - 24px));
  padding: 7px 12px;
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.96);
  color: #f9fafb;
  border: 1px solid rgba(255, 255, 255, 0.14);
  font: 12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.4);
  pointer-events: none;
}
.toast[data-tone="error"] { border-color: #ef4444; color: #fecaca; }
.toast[data-tone="ok"] { border-color: #22c55e; }
`

  // ── DOM helpers ────────────────────────────────────────────────────────────

  function createElement(tag, className, text) {
    const element = global.document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = String(text)
    return element
  }

  function setVisible(element, visible) {
    if (!element) return
    if (visible) element.removeAttribute('f-hidden')
    else element.setAttribute('f-hidden', '')
  }

  function clamp(value, minimum, maximum) {
    if (maximum < minimum) return minimum
    return Math.max(minimum, Math.min(value, maximum))
  }

  function badgeLabel(index) {
    const circled = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
    const safe = Math.max(1, Math.trunc(Number(index) || 1))
    return safe <= circled.length ? circled[safe - 1] : String(safe)
  }

  function viewportSize() {
    return {
      width: Math.max(0, Number(global.innerWidth) || 0),
      height: Math.max(0, Number(global.innerHeight) || 0),
    }
  }

  function scrollOffset() {
    return { x: Number(global.scrollX) || 0, y: Number(global.scrollY) || 0 }
  }

  // ── the component ──────────────────────────────────────────────────────────

  /**
   * @param {{ onSend?: Function, onCancel?: Function, onToggleHidden?: Function, onExit?: Function }} handlers
   */
  function create(handlers) {
    const document = global.document
    const language = pickLanguage(global.navigator && global.navigator.language)
    const t = (key) => {
      const table = STRINGS[language] || STRINGS.en
      return Object.hasOwn(table, key) ? table[key] : STRINGS.en[key] || key
    }

    const host = document.getElementById(HOST_ID) || document.createElement('div')
    host.id = HOST_ID
    const shadow = host.shadowRoot || host.attachShadow({ mode: 'closed' })
    // A previous instance (hot reload, double injection) may have left nodes.
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild)

    const style = createElement('style')
    style.textContent = CSS
    shadow.appendChild(style)

    const hud = createElement('div', 'hud')
    const hudDot = createElement('span', 'hud-dot')
    const hudMode = createElement('span', 'hud-mode')
    const hudHint = createElement('span', 'hud-hint')
    const hudToggle = createElement('button', 'hud-btn')
    hudToggle.type = 'button'
    const hudExit = createElement('button', 'hud-btn', 'Esc')
    hudExit.type = 'button'
    hudExit.title = t('exit')
    hud.append(hudDot, hudMode, hudHint, hudToggle, hudExit)

    const pick = createElement('div', 'pick')
    const pickText = createElement('div', 'pick-text')
    const pickMeta = createElement('div', 'pick-meta')
    pick.append(pickText, pickMeta)

    const hoverBox = createElement('div', 'hover-box')
    const hoverChip = createElement('div', 'hover-chip')
    const marquee = createElement('div', 'marquee')
    const cursorRing = createElement('div', 'cursor-ring')

    const composer = createElement('div', 'composer')
    const composerHead = createElement('div', 'composer-head')
    const composerKind = createElement('span', 'composer-kind')
    const composerSummary = createElement('span', 'composer-summary')
    composerHead.append(composerKind, composerSummary)
    const textarea = createElement('textarea')
    textarea.rows = 3
    textarea.spellcheck = false
    const chips = createElement('div', 'chips')
    const composerFoot = createElement('div', 'composer-foot')
    const composerHint = createElement('span', 'composer-hint')
    const composerActions = createElement('div', 'composer-actions')
    const cancelButton = createElement('button', 'btn', t('cancel'))
    cancelButton.type = 'button'
    const sendButton = createElement('button', 'btn btn-primary', t('send'))
    sendButton.type = 'button'
    sendButton.disabled = true
    composerActions.append(cancelButton, sendButton)
    composerFoot.append(composerHint, composerActions)
    const composerError = createElement('div', 'composer-error')
    composer.append(composerHead, textarea, chips, composerFoot, composerError)

    const toastNode = createElement('div', 'toast')

    const lockedBox = createElement('div', 'locked-box')
    const lockedChip = createElement('div', 'hover-chip')
    lockedChip.dataset.locked = '1'

    shadow.append(hud, pick, hoverBox, hoverChip, marquee, lockedBox, lockedChip, cursorRing, composer, toastNode)
    if (!host.isConnected) document.documentElement.appendChild(host)

    const state = {
      hidden: false,
      hudVisible: false,
      mode: 'auto',
      connected: '',
      composerOpen: false,
      allowEmpty: false,
      intent: '',
      busy: false,
      toastTimer: 0,
      hoverVisible: false,
      marqueeVisible: false,
      /** 'composer' | 'badge' | null: who owns the locked outline. */
      lockHolder: null,
      lockedRect: null,
      lockedPageRect: null,
      lockedLabel: '',
      badgeItems: [],
      badgeSignature: '',
    }

    /** @type {Array<{ item: any, node: HTMLElement, card: HTMLElement }>} */
    let badgeEntries = []
    let composerRect = null

    // ── HUD ──────────────────────────────────────────────────────────────────

    function modeLabel() {
      if (state.mode === 'selection') return t('modeSelection')
      if (state.mode === 'element') return t('modeElement')
      if (state.mode === 'region') return t('modeRegion')
      return t('modeAuto')
    }

    function hintLabel() {
      if (state.mode === 'selection') return t('hintSelection')
      if (state.mode === 'element') return t('hintElement')
      if (state.mode === 'region') return t('hintRegion')
      return t('hintAuto')
    }

    function syncHud() {
      setVisible(hud, state.hudVisible)
      hudMode.textContent = modeLabel()
      hudHint.textContent = hintLabel()
      hudDot.dataset.state = state.connected === 'ok' || state.connected === 'warn' ? state.connected : 'off'
      hudToggle.textContent = state.hidden ? t('showLayers') : t('hideLayers')
      hudToggle.setAttribute('aria-pressed', state.hidden ? 'true' : 'false')
      hudToggle.title = hudToggle.textContent
      hudExit.title = t('exit')
    }

    function setHud(options) {
      const next = options || {}
      if (next.visible !== undefined) state.hudVisible = next.visible === true
      if (next.mode !== undefined) state.mode = next.mode || 'auto'
      if (next.connected !== undefined) state.connected = next.connected || ''
      syncHud()
    }

    // ── hover / marquee / cursor ─────────────────────────────────────────────

    function setHover(info) {
      if (!info || state.hidden) {
        state.hoverVisible = false
        setVisible(hoverBox, false)
        setVisible(hoverChip, false)
        return
      }
      const rect = info.rect || { x: 0, y: 0, w: 0, h: 0 }
      const size = viewportSize()
      hoverBox.style.left = `${Math.round(rect.x)}px`
      hoverBox.style.top = `${Math.round(rect.y)}px`
      hoverBox.style.width = `${Math.max(0, Math.round(rect.w))}px`
      hoverBox.style.height = `${Math.max(0, Math.round(rect.h))}px`
      setVisible(hoverBox, true)
      state.hoverVisible = true

      hoverChip.textContent = String(info.label || '')
      // Measure the chip after layout so it never leaves the viewport.
      const chipWidth = Math.min(hoverChip.scrollWidth || 120, size.width - 16)
      let left = rect.x
      left = clamp(left, 8, Math.max(8, size.width - chipWidth - 8))
      let top = rect.y - 22
      if (top < 8) top = rect.y + rect.h + 4
      hoverChip.style.left = `${Math.round(left)}px`
      hoverChip.style.top = `${Math.round(Math.max(4, top))}px`
      setVisible(hoverChip, true)
    }

    /**
     * Paint the persistent outline that says "this is the thing you are
     * talking about". Unlike the hover box it survives pointer movement, and it
     * is owned by whoever set it, so a badge hover cannot steal the outline the
     * open composer is using.
     * @param {{x:number,y:number,w:number,h:number}|null} rect viewport rect
     * @param {string} [label]
     * @param {'composer'|'badge'} [holder]
     * @param {{x:number,y:number,w:number,h:number}} [pageRect] document rect, re-projected on scroll
     */
    function setLocked(rect, label, holder, pageRect) {
      if (!rect) {
        clearLocked(holder)
        return
      }
      state.lockHolder = holder || 'composer'
      state.lockedRect = { ...rect }
      state.lockedPageRect = pageRect ? { ...pageRect } : null
      state.lockedLabel = String(label || '')
      positionLocked()
    }

    /** @param {'composer'|'badge'} [holder] omit to clear whoever holds it */
    function clearLocked(holder) {
      if (state.lockHolder === null) return
      if (holder !== undefined && holder !== state.lockHolder) return
      state.lockHolder = null
      state.lockedRect = null
      state.lockedPageRect = null
      state.lockedLabel = ''
      setVisible(lockedBox, false)
      setVisible(lockedChip, false)
    }

    function positionLocked() {
      if (state.lockHolder === null || state.hidden) {
        setVisible(lockedBox, false)
        setVisible(lockedChip, false)
        return
      }
      const size = viewportSize()
      let rect = state.lockedRect || { x: 0, y: 0, w: 0, h: 0 }
      if (state.lockedPageRect !== null) {
        const scroll = scrollOffset()
        rect = {
          x: state.lockedPageRect.x - scroll.x,
          y: state.lockedPageRect.y - scroll.y,
          w: state.lockedPageRect.w,
          h: state.lockedPageRect.h,
        }
      }
      lockedBox.style.left = `${Math.round(rect.x)}px`
      lockedBox.style.top = `${Math.round(rect.y)}px`
      lockedBox.style.width = `${Math.max(0, Math.round(rect.w))}px`
      lockedBox.style.height = `${Math.max(0, Math.round(rect.h))}px`
      setVisible(lockedBox, true)

      lockedChip.textContent = state.lockedLabel
      setVisible(lockedChip, state.lockedLabel !== '')
      if (state.lockedLabel === '') return
      const chipWidth = Math.min(lockedChip.scrollWidth || 120, size.width - 16)
      const left = clamp(rect.x, 8, Math.max(8, size.width - chipWidth - 8))
      let top = rect.y - 22
      if (top < 8) top = rect.y + rect.h + 4
      lockedChip.style.left = `${Math.round(left)}px`
      lockedChip.style.top = `${Math.round(Math.max(4, top))}px`
    }

    function setMarquee(rect) {
      if (!rect || state.hidden) {
        state.marqueeVisible = false
        setVisible(marquee, false)
        return
      }
      marquee.style.left = `${Math.round(rect.x)}px`
      marquee.style.top = `${Math.round(rect.y)}px`
      marquee.style.width = `${Math.max(0, Math.round(rect.w))}px`
      marquee.style.height = `${Math.max(0, Math.round(rect.h))}px`
      setVisible(marquee, true)
      state.marqueeVisible = true
    }

    function setCursor(point) {
      if (!point || state.hidden || !state.hudVisible) {
        setVisible(cursorRing, false)
        return
      }
      cursorRing.style.left = `${Math.round(point.x)}px`
      cursorRing.style.top = `${Math.round(point.y)}px`
      setVisible(cursorRing, true)
    }

    // ── badges ───────────────────────────────────────────────────────────────

    function stateLabel(value) {
      if (value === 'resolved') return t('stateResolved')
      if (value === 'wont_fix') return t('stateWontFix')
      return t('stateOpen')
    }

    function kindLabel(value) {
      if (value === 'selection') return t('kindSelection')
      if (value === 'element') return t('kindElement')
      if (value === 'region') return t('kindRegion')
      return ''
    }

    function buildBadge(item) {
      const node = createElement('div', 'badge', badgeLabel(item.index))
      node.dataset.state = item.state || 'open'
      node.dataset.id = item.id
      node.setAttribute('role', 'img')
      node.setAttribute('aria-label', `${badgeLabel(item.index)} ${stateLabel(item.state)}`)
      const card = createElement('div', 'badge-card')
      card.appendChild(createElement('div', 'badge-card-text', item.comment || t('noComment')))
      if (item.note) card.appendChild(createElement('div', 'badge-card-note', `${t('agentNote')}: ${item.note}`))
      const meta = createElement(
        'div',
        'badge-card-meta',
        [stateLabel(item.state), kindLabel(item.kind)].filter(Boolean).join(' · '),
      )
      card.appendChild(meta)
      node.appendChild(card)
      positionBadge(node, item.pageRect)
      // Reading a note is easier when the thing the note is about stays
      // outlined, so hovering the badge paints the same locked outline the
      // composer uses — with the badge (not the composer) as its owner.
      node.addEventListener('pointerenter', () => {
        if (state.lockHolder === 'composer' || state.hidden) return
        const pageRect = item.pageRect || { x: 0, y: 0, w: 0, h: 0 }
        const scroll = scrollOffset()
        setLocked(
          { x: pageRect.x - scroll.x, y: pageRect.y - scroll.y, w: pageRect.w, h: pageRect.h },
          kindLabel(item.kind),
          'badge',
          pageRect,
        )
      })
      node.addEventListener('pointerleave', () => clearLocked('badge'))
      return { item, node, card }
    }

    function positionBadge(node, pageRect) {
      const size = viewportSize()
      const scroll = scrollOffset()
      const x = pageRect.x - scroll.x
      const y = pageRect.y - scroll.y
      const margin = 24
      const intersects =
        x + pageRect.w >= -margin && x <= size.width + margin && y + pageRect.h >= -margin && y <= size.height + margin
      if (state.hidden || !intersects) {
        setVisible(node, false)
        return
      }
      const left = clamp(x - 10, 4, Math.max(4, size.width - 24))
      const top = clamp(y - 10, 4, Math.max(4, size.height - 24))
      node.style.left = `${Math.round(left)}px`
      node.style.top = `${Math.round(top)}px`
      node.dataset.flip = left > size.width / 2 ? '1' : '0'
      setVisible(node, true)
    }

    function refreshPositions() {
      const size = viewportSize()
      const scroll = scrollOffset()
      for (const entry of badgeEntries) positionBadge(entry.node, entry.item.pageRect)
      if (state.composerOpen && composerRect) positionComposer(size)
      positionLocked()
      void scroll
    }

    function setBadges(items) {
      const list = Array.isArray(items) ? items : []
      const signature = list
        .map((item) => `${item.id}:${item.index}:${item.state}:${item.comment}:${item.note}`)
        .join('|')
      state.badgeItems = list
      if (signature !== state.badgeSignature) {
        state.badgeSignature = signature
        for (const entry of badgeEntries) {
          if (entry.node.parentNode) entry.node.parentNode.removeChild(entry.node)
        }
        badgeEntries = []
        for (const item of list) {
          const entry = buildBadge(item)
          if (!entry.node.parentNode) shadow.insertBefore(entry.node, hud)
          badgeEntries.push(entry)
        }
      }
      refreshPositions()
    }

    // ── composer ─────────────────────────────────────────────────────────────

    function composerTitle(kind) {
      if (kind === 'selection') return t('composerSelection')
      if (kind === 'region') return t('composerRegion')
      return t('composerElement')
    }

    function positionComposer(size) {
      const measured = composer.offsetHeight || 190
      const width = Math.min(340, Math.max(240, size.width - 24))
      composer.style.width = `${width}px`
      const margin = 10
      const rect = composerRect
      const left = clamp(rect.x, margin, Math.max(margin, size.width - width - margin))
      let top = rect.y + rect.h + 8
      if (top + measured > size.height - margin) top = rect.y - measured - 8
      top = clamp(top, margin, Math.max(margin, size.height - measured - margin))
      composer.style.left = `${Math.round(left)}px`
      composer.style.top = `${Math.round(top)}px`
    }

    function syncSendState() {
      const text = textarea.value.trim()
      sendButton.disabled = state.busy || (!state.allowEmpty && text === '')
      cancelButton.disabled = state.busy
      textarea.disabled = state.busy
      sendButton.textContent = state.busy ? t('sending') : t('send')
    }

    function selectIntent(intent) {
      state.intent = state.intent === intent ? '' : intent
      for (const chip of chips.children) {
        const pressed = chip.dataset.intent === state.intent && state.intent !== ''
        chip.setAttribute('aria-pressed', pressed ? 'true' : 'false')
      }
    }

    function buildChips() {
      for (const intent of global.__DSH_PROTOCOL__.INTENTS) {
        const chip = createElement('button', 'chip', intent)
        chip.type = 'button'
        chip.dataset.intent = intent
        chip.setAttribute('aria-pressed', 'false')
        chip.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          selectIntent(intent)
        })
        chips.appendChild(chip)
      }
    }
    buildChips()

    function submitComposer() {
      if (state.busy) return
      const value = textarea.value
      const text = value.replace(/\s+$/, '').replace(/^\s+/, '')
      if (!state.allowEmpty && text === '') {
        textarea.focus()
        return
      }
      handlers.onSend({ text, intent: state.intent })
    }

    function openComposer(options) {
      const config = options || {}
      state.composerOpen = true
      state.allowEmpty = config.allowEmpty === true
      state.intent = ''
      for (const chip of chips.children) chip.setAttribute('aria-pressed', 'false')
      composerKind.textContent = composerTitle(config.kind)
      composerSummary.textContent = String(config.summary || '')
      composerError.textContent = ''
      setVisible(composerError, false)
      textarea.value = ''
      composerRect = config.rect || { x: 8, y: 8, w: 0, h: 0 }
      setVisible(composer, true)
      syncSendState()
      positionComposer(viewportSize())
      // Fonts/scrollbars settle one frame later; measuring again avoids a card
      // that hangs off the bottom on first paint.
      global.requestAnimationFrame(() => {
        if (state.composerOpen) positionComposer(viewportSize())
      })
      textarea.focus()
      composerHint.textContent = t('placeholder').split('·')[0].trim()
    }

    function closeComposer() {
      state.composerOpen = false
      state.busy = false
      state.intent = ''
      state.allowEmpty = false
      composerRect = null
      setVisible(composer, false)
      composerError.textContent = ''
      setVisible(composerError, false)
      textarea.value = ''
      syncSendState()
      clearLocked('composer')
    }

    function setComposerBusy(busy) {
      state.busy = busy === true
      syncSendState()
    }

    function setComposerError(message) {
      const text = String(message || '')
      composerError.textContent = text
      setVisible(composerError, text !== '')
    }

    // ── pick banner / toast ──────────────────────────────────────────────────

    function setPickBanner(info) {
      if (!info) {
        setVisible(pick, false)
        return
      }
      pickText.textContent = String(info.prompt || '')
      const parts = [t('pickTitle')]
      if (info.mode && info.mode !== 'auto') parts.push(modeLabelFor(info.mode))
      parts.push(t('pickCancelHint'))
      pickMeta.textContent = parts.join(' · ')
      setVisible(pick, true)
    }

    function modeLabelFor(mode) {
      if (mode === 'selection') return t('modeSelection')
      if (mode === 'element') return t('modeElement')
      if (mode === 'region') return t('modeRegion')
      return t('modeAuto')
    }

    function toast(message, tone) {
      const text = String(message || '')
      if (text === '') return
      toastNode.textContent = text
      toastNode.dataset.tone = tone === 'error' ? 'error' : tone === 'ok' ? 'ok' : 'info'
      setVisible(toastNode, true)
      if (state.toastTimer) global.clearTimeout(state.toastTimer)
      state.toastTimer = global.setTimeout(() => {
        state.toastTimer = 0
        setVisible(toastNode, false)
      }, 2800)
    }

    // ── interaction wiring ───────────────────────────────────────────────────

    textarea.addEventListener('input', () => {
      syncSendState()
      if (composerError.textContent) {
        composerError.textContent = ''
        setVisible(composerError, false)
      }
    })

    textarea.addEventListener('keydown', (event) => {
      // Enter sends, Shift+Enter is a newline, and an in-progress IME
      // composition (Chinese/Japanese input) owns Enter until it commits.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        event.stopPropagation()
        submitComposer()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!state.busy) handlers.onCancel('escape')
      }
    })

    // Keep clicks/keys inside the card from reaching the page or the gesture
    // layer; the host is pointer-events:none but children are not.
    composer.addEventListener('pointerdown', (event) => event.stopPropagation())
    composer.addEventListener('click', (event) => event.stopPropagation())
    hud.addEventListener('click', (event) => event.stopPropagation())
    pick.addEventListener('click', (event) => event.stopPropagation())

    hudToggle.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      handlers.onToggleHidden()
    })
    hudExit.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      handlers.onExit()
    })
    sendButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      submitComposer()
    })
    cancelButton.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!state.busy) handlers.onCancel('button')
    })

    syncHud()
    closeComposer()
    setVisible(hud, false)
    setVisible(pick, false)
    setVisible(hoverBox, false)
    setVisible(hoverChip, false)
    setVisible(marquee, false)
    setVisible(cursorRing, false)
    setVisible(toastNode, false)

    const onResize = () => refreshPositions()
    global.addEventListener('resize', onResize, true)
    global.addEventListener('scroll', onResize, true)

    return {
      mount() {
        syncHud()
      },
      setHud,
      setHover,
      setLocked,
      clearLocked,
      setMarquee,
      setCursor,
      setBadges,
      setPickBanner,
      toast,
      openComposer,
      closeComposer,
      setComposerBusy,
      setComposerError,
      refreshPositions,
      setHidden(hidden) {
        state.hidden = hidden === true
        syncHud()
        if (state.hidden) {
          setHover(null)
          setMarquee(null)
          clearLocked()
          setCursor(null)
        }
        for (const entry of badgeEntries) positionBadge(entry.node, entry.item.pageRect)
      },
      isComposerOpen() {
        return state.composerOpen
      },
      composerText() {
        return textarea.value
      },
      focusComposer() {
        if (state.composerOpen) textarea.focus()
      },
      destroy() {
        global.removeEventListener('resize', onResize, true)
        global.removeEventListener('scroll', onResize, true)
        if (state.toastTimer) global.clearTimeout(state.toastTimer)
        badgeEntries = []
        if (host.parentNode) host.parentNode.removeChild(host)
      },
    }
  }

  ns.ui = { create, badgeLabel, STRINGS, pickLanguage }
})(globalThis)
