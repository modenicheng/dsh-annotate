/**
 * dsh-marker content script 3/4 — the annotation UI.
 *
 * Everything the user can see or touch lives in one closed shadow root on
 * `#dsh-anno-root`, with `:host { all: initial }`, so page CSS cannot deform it
 * and page scripts cannot reach the internals. The host itself is `position:
 * fixed` with `pointer-events: none`: children opt back into pointer events,
 * which keeps the page fully usable while annotation mode is idle.
 *
 * All nodes are built with `createElement`/`textContent`; no page-derived
 * string is ever parsed as HTML.
 *
 * The UI is assembled from the parts under `ui/` (manifest order is load order:
 * strings → styles → dom → overlay → hud → target → composer → badges → this
 * file). Each part publishes on the shared `ns.ui` namespace and receives the
 * one `ctx` built here, so the split keeps the single shadow root, the single
 * `state`, and the exact public object `create()` returned when the whole UI
 * was one file.
 */
;(function installUi(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  const ui = (ns.ui = ns.ui || {})
  if (ui.create) return
  if (!global.__DSH_PROTOCOL__) return

  const { strings, styles, dom, overlay, hud, target, composer, badges } = ui
  // A missing part means the manifest lost a file. Stay out of the page instead
  // of mounting half a UI.
  if (!strings || !styles || !dom || !overlay || !hud || !target || !composer || !badges) return

  const HOST_ID = ns.HOST_ID || 'dsh-anno-root'

  /**
   * @param {{
   *   onSend?: Function,
   *   onCancel?: Function,
   *   onToggleHidden?: Function,
   *   onExit?: Function,
   *   onDelete?: (id: string) => void,
   *   onClear?: (kind: 'all' | 'resolved') => void,
   * }} handlers
   */
  function create(handlers) {
    const document = global.document
    const language = strings.pickLanguage(global.navigator && global.navigator.language)
    const t = (key) => {
      const table = strings.STRINGS[language] || strings.STRINGS.en
      return Object.hasOwn(table, key) ? table[key] : strings.STRINGS.en[key] || key
    }

    const host = document.getElementById(HOST_ID) || document.createElement('div')
    host.id = HOST_ID
    const shadow = host.shadowRoot || host.attachShadow({ mode: 'closed' })
    // A previous instance (hot reload, double injection) may have left nodes.
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild)

    const style = dom.createElement('style')
    style.textContent = styles.CSS
    shadow.appendChild(style)

    const state = {
      hidden: false,
      hudVisible: false,
      mode: 'auto',
      connected: '',
      composerOpen: false,
      intent: '',
      targets: [],
      targetId: '',
      targetOpen: false,
      targetQuery: '',
      targetActive: 0,
      targetNote: '',
      /** 'pick' lists Sessions; 'new' targets a session the host will create. */
      targetMode: 'pick',
      /** The workspace sub-panel inside the picker. */
      newPanelOpen: false,
      /** Draft workspace choice while the sub-panel is open. */
      newMode: 'default',
      newWorkspaceId: '',
      newPath: '',
      newTitle: '',
      /** True when the host is too far away to create a session. */
      newUnavailable: false,
      workspaces: [],
      busy: false,
      toastTimer: 0,
      hoverVisible: false,
      marqueeVisible: false,
      /** 'composer' | 'badge' | null: who owns the locked outline. */
      lockHolder: null,
      lockedRect: null,
      lockedPageRect: null,
      /** Line boxes of the marked text, in document coordinates; null for a box. */
      lockedLines: null,
      lockedLabel: '',
      badgeItems: [],
      badgeSignature: '',
      counts: { total: 0, resolved: 0 },
      /** '' | 'all' | 'resolved': which bulk clear is running. */
      clearing: '',
      clearArmed: '',
      clearTimer: 0,
      clearProgress: 0,
      clearTotal: 0,
    }

    /**
     * What every part is installed with: one shadow root, one `state`, one set
     * of translated strings, the handlers `main.js` passed in, and the parts
     * themselves. A part only reads what exists when it is installed (its own
     * nodes, `hud.node`, `target.row`); behaviour is always resolved through
     * this object at call time, never captured during install.
     */
    const ctx = {
      global,
      host,
      shadow,
      handlers,
      t,
      state,
      styles,
      dom,
      hud: null,
      overlay: null,
      target: null,
      composer: null,
      badges: null,
      /** Set below; `setBadges` repaints through the composition root. */
      refreshPositions: null,
    }

    // Install order is the DOM order the parts need: the markers are inserted
    // before the HUD, and the composer contains the picker's row.
    ctx.hud = hud.install(ctx)
    ctx.overlay = overlay.install(ctx)
    ctx.target = target.install(ctx)
    ctx.composer = composer.install(ctx)
    ctx.badges = badges.install(ctx)
    ctx.refreshPositions = refreshPositions

    // Every argument here is an element, never a part's behaviour: `append()`
    // would otherwise stringify it into the page as text.
    shadow.append(
      ctx.hud.node,
      ctx.hud.pick,
      ctx.overlay.hoverBox,
      ctx.overlay.hoverChip,
      ctx.overlay.marquee,
      ctx.overlay.markBands,
      ctx.overlay.lockedBox,
      ctx.overlay.lockedChip,
      ctx.overlay.cursorRing,
      ctx.composer.node,
      ctx.hud.toast,
    )
    if (!host.isConnected) document.documentElement.appendChild(host)

    function refreshPositions() {
      const size = dom.viewportSize()
      const scroll = dom.scrollOffset()
      ctx.badges.positionAll()
      if (state.composerOpen) ctx.composer.position(size)
      ctx.overlay.positionLocked()
      void scroll
    }

    const onResize = () => refreshPositions()
    global.addEventListener('resize', onResize, true)
    global.addEventListener('scroll', onResize, true)
    global.addEventListener('pointerdown', ctx.badges.onGlobalPointerDown, true)

    ctx.hud.syncHud()
    ctx.composer.closeComposer()
    // Initial paint: only the HUD, the pick banner and the toast are ever shown
    // by an explicit call; the transient guides start hidden here.
    ctx.hud.hide()
    ctx.overlay.hideTransient()

    return {
      mount() {
        ctx.hud.syncHud()
      },
      setHud: ctx.hud.setHud,
      setHover: ctx.overlay.setHover,
      setLocked: ctx.overlay.setLocked,
      clearLocked: ctx.overlay.clearLocked,
      setMarquee: ctx.overlay.setMarquee,
      setCursor: ctx.overlay.setCursor,
      setBadges: ctx.badges.setBadges,
      setBadgePending: ctx.badges.setBadgePending,
      setClearBusy: ctx.hud.setClearBusy,
      setClearProgress: ctx.hud.setClearProgress,
      setPickBanner: ctx.hud.setPickBanner,
      toast: ctx.hud.showToast,
      openComposer: ctx.composer.openComposer,
      closeComposer: ctx.composer.closeComposer,
      setComposerBusy: ctx.composer.setComposerBusy,
      setComposerError: ctx.composer.setComposerError,
      setTargets: ctx.target.setTargets,
      setNewSessionAvailable: ctx.target.setNewSessionAvailable,
      newSessionChoice: ctx.target.newChoice,
      refreshPositions,
      closeBadgeCard: ctx.badges.closeBadgeCard,
      setHidden(hidden) {
        state.hidden = hidden === true
        ctx.hud.syncHud()
        if (state.hidden) {
          ctx.overlay.setHover(null)
          ctx.overlay.setMarquee(null)
          ctx.overlay.clearLocked()
          ctx.overlay.setCursor(null)
          ctx.badges.closeAllBadgeCards()
          ctx.hud.disarmClear()
        }
        ctx.badges.positionAll()
      },
      isComposerOpen: ctx.composer.isComposerOpen,
      composerText: ctx.composer.composerText,
      focusComposer: ctx.composer.focusComposer,
      destroy() {
        global.removeEventListener('resize', onResize, true)
        global.removeEventListener('scroll', onResize, true)
        global.removeEventListener('pointerdown', ctx.badges.onGlobalPointerDown, true)
        if (state.toastTimer) global.clearTimeout(state.toastTimer)
        if (state.clearTimer) global.clearTimeout(state.clearTimer)
        ctx.badges.cancelBadgeTimer()
        ctx.badges.resetEntries()
        if (host.parentNode) host.parentNode.removeChild(host)
      },
    }
  }

  ui.create = create
  ui.badgeLabel = dom.badgeLabel
  ui.STRINGS = strings.STRINGS
  ui.pickLanguage = strings.pickLanguage
})(globalThis)
