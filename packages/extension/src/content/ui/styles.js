/**
 * dsh-marker content script 3/4 (ui) — the one stylesheet.
 *
 * It is injected as a `<style>` inside the closed shadow root, so every rule is
 * scoped by construction: no `!important`, no page-specific guards, and the
 * page's CSS cannot see or deform any of it. `BADGE_PX` lives here because the
 * stylesheet and the placement math must agree on the marker size.
 *
 * Every colour, radius and shadow is a token on `:host` — a rule below that
 * invents a raw value is a bug. Only one-off geometry tied to the marker's own
 * math (corner radii that read as a pointing tag, `BADGE_PX` offsets, the
 * outline ladder's fixed rings) stays inline, with a comment saying why.
 */
;(function installUiStyles(global) {
  const ns = (global.__DSH_ANNO__ = global.__DSH_ANNO__ || {})
  const ui = (ns.ui = ns.ui || {})
  if (ui.styles) return

  /**
   * Marker size in CSS pixels. The stylesheet and the placement math must agree
   * on it: a badge is centred on its anchor (so half of this value is the
   * offset) and the right/bottom clamp keeps one whole badge on screen.
   */
  const BADGE_PX = 26

  const CSS = `
:host {
  all: initial;
  position: fixed;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  z-index: 2147483000;
  /* ── Design tokens ─────────────────────────────────────────────────────
     Two groups. The type tokens fix the ramp: exactly three sizes, anything
     new must map onto one of them, and each leading is the CJK value (one
     value serves both scripts; Latin gets room, Han gets leading). The chrome
     tokens fix the palette so no rule below invents a colour, radius or
     shadow. px on purpose: this overlay is injected into pages whose root
     font-size we do not control, so rem would inherit a foreign scale. */
  --font-ui: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --text-body: 14px;
  --text-body-lh: 20px;
  --text-label: 13px;
  --text-label-lh: 20px;
  --text-caption: 12px;
  --text-caption-lh: 18px;
  /* Muted text on the dark chrome: #6b7280 measured ~3.7:1 against #111827,
     under the AA 4.5:1 floor at caption sizes. #9ca3af is ~7:1. */
  --text-dim: #9ca3af;
  /* Surfaces, dark chrome. */
  --chrome: rgba(17, 24, 39, 0.95);
  --chrome-solid: #111827;
  --panel: #0b1220;
  --field: rgba(255, 255, 255, 0.05);
  --fill: rgba(255, 255, 255, 0.06);
  --fill-quiet: rgba(255, 255, 255, 0.04);
  --wash: rgba(255, 255, 255, 0.1);
  --wash-strong: rgba(255, 255, 255, 0.12);
  /* Lines, faint to strong. */
  --line-faint: rgba(255, 255, 255, 0.1);
  --line-soft: rgba(255, 255, 255, 0.14);
  --line: rgba(255, 255, 255, 0.16);
  --line-strong: rgba(255, 255, 255, 0.18);
  /* Ink ramp. */
  --ink: #e5e7eb;
  --ink-hi: #f9fafb;
  --ink-soft: #cbd5e1;
  --ink-faint: #94a3b8;
  --ink-sep: #475569;
  --white: #ffffff;
  /* Accent. */
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
  --accent-line: #3b82f6;
  --accent-ink: #93c5fd;
  --accent-wash: rgba(37, 99, 235, 0.28);
  --accent-wash-strong: rgba(37, 99, 235, 0.85);
  --accent-soft-line: rgba(147, 197, 253, 0.4);
  /* Status: ok (green), warn (amber), danger (red), mute (grey). */
  --ok: #22c55e;
  --ok-marker: #16a34a;
  --ok-ink: #86efac;
  --warn: #f59e0b;
  --warn-ink: #fcd34d;
  --warn-bg: rgba(245, 158, 11, 0.12);
  --warn-line: rgba(245, 158, 11, 0.45);
  --warn-band: rgba(245, 158, 11, 0.22);
  --warn-band-edge: rgba(245, 158, 11, 0.65);
  --pick-bg: rgba(69, 26, 3, 0.96);
  --pick-line: rgba(251, 191, 36, 0.5);
  --pick-ink: #fef3c7;
  --danger: #ef4444;
  --danger-ink: #fca5a5;
  --danger-soft-ink: #fecaca;
  --danger-bg: rgba(185, 28, 28, 0.9);
  --danger-wash: rgba(239, 68, 68, 0.2);
  --mute: #6b7280;
  /* Radii and shadows. */
  --radius-s: 4px;
  --radius-m: 6px;
  --radius-l: 8px;
  --radius-xl: 10px;
  --radius-pill: 999px;
  --shadow-hud: 0 6px 20px rgba(0, 0, 0, 0.35);
  --shadow-panel: 0 12px 28px rgba(0, 0, 0, 0.5);
  --shadow-pop: 0 6px 18px rgba(0, 0, 0, 0.45);
  --shadow-card: 0 10px 24px rgba(0, 0, 0, 0.45);
  --shadow-toast: 0 8px 22px rgba(0, 0, 0, 0.4);
  --shadow-marker: 0 1px 4px rgba(0, 0, 0, 0.4);
  /* Whites that face the page (markers on arbitrary backgrounds). */
  --halo: rgba(255, 255, 255, 0.35);
  --halo-soft: rgba(255, 255, 255, 0.4);
  --halo-strong: rgba(255, 255, 255, 0.55);
}
*, *::before, *::after { box-sizing: border-box; }
[f-hidden] { display: none !important; }
/* Icons are the extension's own SVG files (assets/icons/) painted through a
   CSS mask, so the shape follows currentColor like a glyph. Size comes from
   the context; the mask url is set inline by dom.createIcon. */
.icon {
  display: inline-block;
  width: 14px;
  height: 14px;
  background-color: currentColor;
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
  -webkit-mask-position: center;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  flex: none;
}
.hud {
  position: fixed;
  z-index: 10;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(760px, calc(100vw - 24px));
  padding: 6px 8px;
  border-radius: var(--radius-l);
  background: var(--chrome);
  color: var(--ink);
  box-shadow: var(--shadow-hud);
  border: 1px solid var(--wash-strong);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  pointer-events: auto;
}
.hud-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--mute);
  flex: none;
}
.hud-dot[data-state="ok"] { background: var(--ok); }
.hud-dot[data-state="warn"] { background: var(--warn); }
.hud-dot[data-state="off"] { background: var(--mute); }
.hud-mode { font-weight: 600; white-space: nowrap; flex: none; }
.hud-hint {
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1 1 auto;
  min-width: 0;
}
.hud-btn {
  flex: none;
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  padding: 4px 7px;
  border-radius: 5px; /* one step under --radius-m: the HUD bar is denser */
  border: 1px solid var(--line-strong);
  background: transparent;
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.hud-btn:hover:not(:disabled) { background: var(--wash-strong); }
.hud-btn:disabled { opacity: 0.45; cursor: default; }
.hud-btn[aria-pressed="true"] { background: var(--accent-wash-strong); border-color: var(--accent-line); }
.hud-btn[data-armed="1"] {
  background: var(--danger-bg);
  border-color: var(--danger);
  color: var(--white);
}
.pick {
  position: fixed;
  z-index: 10;
  top: 58px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: min(680px, calc(100vw - 32px));
  padding: 10px 12px;
  border-radius: var(--radius-xl);
  background: var(--pick-bg);
  border: 1px solid var(--pick-line);
  color: var(--pick-ink);
  box-shadow: var(--shadow-card);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  pointer-events: auto;
}
.pick-text { flex: 1 1 auto; white-space: pre-wrap; word-break: break-word; }
.pick-meta {
  flex: none;
  color: var(--warn-ink);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
  text-align: right;
}
/* Layer ladder inside the overlay: outlines (1) sit under markers (3) and their
   cards, labels ride above both (4), and the chrome the user is operating
   (composer 9, HUD and pick banner 10, toasts 11) stays on top of everything.
   Without it, painting order is DOM order — which is why an annotation card
   used to disappear behind the outline of the very thing it describes. */
.hover-box, .marquee {
  position: fixed;
  z-index: 1;
  border: 2px solid var(--accent-line);
  border-radius: 3px; /* hairline rounding on 2px outlines reads as crisp, not soft */
  background: rgba(59, 130, 246, 0.08);
  box-shadow: inset 0 0 0 1px var(--halo);
  pointer-events: none;
}
.marquee { border-style: dashed; background: rgba(59, 130, 246, 0.15); }
/* The locked outline marks what the open composer (or a hovered badge) refers
   to. It is a separate element from the transient hover box so a pointer move
   cannot erase the thing the user is currently describing. */
.locked-box {
  position: fixed;
  z-index: 1;
  border: 2px solid var(--warn);
  border-radius: 3px;
  background: var(--warn-bg);
  box-shadow: inset 0 0 0 1px var(--halo);
  pointer-events: none;
}
.hover-chip[data-locked="1"] { background: #b45309; }
/* A marked text is drawn as one band per line box, in the amber the rest of the
   annotation chrome uses, so the words stay identifiable while the composer
   owns the selection highlight. The underline is the band's own edge: a text
   mark never gets an outline around its paragraph. The alpha is low enough that
   the text under it is still readable. */
.mark-band-layer {
  position: fixed;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  z-index: 1;
  pointer-events: none;
}
.mark-band {
  position: absolute;
  background: var(--warn-band);
  box-shadow: inset 0 -2px 0 var(--warn-band-edge);
  pointer-events: none;
}
.hover-chip {
  position: fixed;
  z-index: 4;
  max-width: min(360px, calc(100vw - 16px));
  padding: 3px 6px;
  border-radius: var(--radius-s);
  background: var(--accent-hover);
  color: var(--white);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.cursor-ring {
  position: fixed;
  z-index: 2;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border-radius: 50%;
  border: 2px solid var(--accent-line);
  background: var(--halo-soft);
  pointer-events: none;
}
/* While Shift arms a text selection there is no element to outline, so the
   pointer carries a teardrop instead: the sharp corner points back at the
   cursor and the body hangs off its bottom-right. */
.shift-drop {
  position: fixed;
  z-index: 2;
  width: 14px;
  height: 14px;
  /* Clear of the OS cursor's own body, which the browser paints over us. */
  margin: 11px 0 0 11px;
  border-radius: 0 50% 50% 50%;
  background: var(--accent);
  box-shadow:
    0 0 0 1.5px rgba(255, 255, 255, 0.92),
    0 2px 6px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
.composer {
  position: fixed;
  z-index: 9;
  padding: 10px;
  border-radius: var(--radius-xl);
  background: var(--chrome-solid);
  color: var(--ink);
  border: 1px solid var(--line-soft);
  box-shadow: var(--shadow-pop);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  pointer-events: auto;
}
.composer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.composer-kind { color: var(--accent-ink); font-weight: 600; white-space: nowrap; }
.composer-summary {
  color: var(--text-dim);
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
  border-radius: var(--radius-m);
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink-hi);
  font: var(--text-body) / var(--text-body-lh) var(--font-ui);
  outline: none;
}
.composer textarea:focus { border-color: var(--accent-line); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0 0; }
.chip {
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--line-soft);
  background: var(--fill);
  color: var(--ink-soft);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  cursor: pointer;
}
.chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent-line); color: var(--white); }
.composer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
}
/* nowrap keeps the foot one line; ellipsis keeps a longer locale inside the card
   instead of painting past its edge at the 240px minimum width. */
.composer-hint {
  color: var(--text-dim);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.composer-actions { display: flex; flex: 0 0 auto; gap: 6px; }
.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: var(--radius-m);
  border: 1px solid var(--line-strong);
  background: transparent;
  color: var(--ink);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  cursor: pointer;
}
.btn:hover:not(:disabled) { background: var(--wash); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-primary { background: var(--accent); border-color: var(--accent-line); color: var(--white); }
.btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn .icon { width: 14px; height: 14px; }
/* Offline alert under the textarea: paired with the disabled send button. */
.composer-alert {
  margin-top: 6px;
  padding: 5px 8px;
  border-radius: var(--radius-m);
  border: 1px solid var(--warn-line);
  background: var(--warn-bg);
  color: var(--warn-ink);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
}
.composer-error {
  margin-top: 6px;
  color: var(--danger-ink);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
  white-space: pre-wrap;
}
/* Target row: one line when collapsed, a flat searchable list when open. The
   row detail (workspace + last activity) only exists on the active row, so the
   list stays one line per session until the user actually inspects one. */
.target { position: relative; margin-top: 8px; }
.target-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 3px 6px;
  border-radius: var(--radius-m);
  border: 1px solid var(--line-soft);
  background: var(--fill-quiet);
  color: var(--ink);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.target-btn:hover { background: var(--wash); }
.target-key { flex: none; color: var(--text-dim); }
.target-value { flex: 1 1 auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.target-caret { flex: none; color: var(--text-dim); }
.target-panel {
  position: absolute;
  z-index: 2;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  padding: 6px;
  border-radius: var(--radius-l);
  border: 1px solid var(--line);
  background: var(--panel);
  box-shadow: var(--shadow-panel);
  overflow: hidden;
}
/* Both panels — the session picker and the workspace sub-panel — share this
   one layout: 6px gutters, 4px rhythm, rows full width. */
.target-search {
  margin: 0;
  padding: 4px 6px;
  border-radius: var(--radius-m);
  border: 1px solid var(--line-soft);
  background: var(--field);
  color: var(--ink);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  outline: none;
}
.target-list { overflow-y: auto; padding: 0; }
/* One line per row: a height that depends on the pointer makes the list jump
   under the cursor. The workspace lives in .target-tip instead. */
.target-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: var(--radius-m);
  background: transparent;
  color: var(--ink);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.target-row[data-active="1"] { background: var(--accent-wash); }
.target-row-title { flex: 1 1 auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.target-row-time {
  flex: none;
  color: var(--ink-faint);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
  font-variant-numeric: tabular-nums;
}
.target-tip {
  position: absolute;
  z-index: 3;
  max-width: 220px;
  padding: 3px 6px;
  border-radius: var(--radius-m);
  border: 1px solid var(--line-strong);
  background: var(--panel);
  color: var(--ink-soft);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  box-shadow: var(--shadow-pop);
}
.target-empty { padding: 8px 6px; color: var(--text-dim); font-size: var(--text-caption); line-height: var(--text-caption-lh); }
/* The "new session" arm: one pinned action row above the list, and a workspace
   sub-panel that replaces the list while it is open. Same skin as the picker so
   the two read as one control. */
.target-new { margin: 0; color: var(--accent-ink); }
.target-new:disabled { color: var(--text-dim); cursor: not-allowed; }
.target-new-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  overflow-y: auto;
}
.target-new-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* One skin for the compact chip buttons of the sub-panel: the back button and
   the browser toolbar's Up / Home. The toolbar pair is a square icon box — its
   label rides in the title/aria-label, not the box. */
.target-back, .target-fs-btn {
  flex: none;
  border: 0;
  border-radius: var(--radius-m);
  background: var(--fill);
  color: var(--ink-soft);
  cursor: pointer;
}
.target-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
}
.target-fs-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
}
.target-back:hover, .target-fs-btn:hover { background: var(--wash-strong); }
.target-fs-btn:disabled { color: var(--text-dim); cursor: not-allowed; }
.target-back .icon { width: 14px; height: 14px; }
.target-fs-btn .icon { width: 15px; height: 15px; }
/* The head breadcrumb, right aligned: ancestor segments navigate, the
   current one is plain text. */
.target-new-crumb {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  color: var(--text-dim);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
}
.target-new-crumb .icon { width: 12px; height: 12px; color: var(--ink-sep); }
/* One skin for the two breadcrumb-ish link rows: the head's ancestor segments
   and the directory breadcrumb's jumps. */
.target-new-crumb-seg, .target-fs-seg {
  flex: none;
  padding: 1px 2px;
  border: 0;
  border-radius: var(--radius-s);
  background: none;
  color: var(--accent-ink);
  font: inherit;
  cursor: pointer;
}
.target-new-crumb-seg:hover, .target-fs-seg:hover { background: var(--wash); }
.target-new-crumb-here {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ink-soft);
}
/* Level one of the sub-panel: the ＋ row first, then the workspaces. */
.target-new-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.target-new-fields {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--line-faint);
}
.target-new-label {
  color: var(--text-dim);
  font-size: var(--text-label);
  line-height: var(--text-label-lh);
}
/* One skin for every text input in the sub-panel; the path input swaps the
   family, not the box. */
.target-new-path, .target-new-name, .target-new-title-input {
  padding: 4px 6px;
  border-radius: var(--radius-m);
  border: 1px solid var(--line-soft);
  background: var(--field);
  color: var(--ink);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  outline: none;
}
.target-new-path { font-family: var(--font-mono); }
/* A row whose label is a path (locations, drives) gets the mono face,
   because it is one. */
.target-row-path {
  font-family: var(--font-mono);
  font-size: var(--text-caption);
}
/* The registered-workspace rows: one row, one click, 'existing' semantics.
   The path rides beside the title — a directory's identity, truncated. */
.target-ws:hover { background: var(--accent-wash); }
.target-row-meta {
  flex: none;
  max-width: 55%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink-faint);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-mono);
}
/* The directory browser rides on the picker's row skin. */
.target-fs-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 132px;
  overflow-y: auto;
}
/* The browser toolbar: two compact buttons, then the breadcrumb. */
.target-fs-head {
  display: flex;
  align-items: center;
  gap: 4px;
}
.target-fs-crumb {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  color: var(--ink-faint);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-mono);
  /* Long paths shrink from the front: flex-end keeps the tail — the directory
     the user is standing in — and the fade marks where the head was cut. */
  -webkit-mask-image: linear-gradient(to right, transparent, #000 14px);
  mask-image: linear-gradient(to right, transparent, #000 14px);
}
.target-fs-crumb .icon { width: 11px; height: 11px; color: var(--ink-sep); }
.target-fs-sep { flex: none; color: var(--ink-sep); }
.target-fs-here {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ink);
}
/* The result line: label, the registered badge, then the exact path. */
.target-new-result {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.target-new-result-label {
  flex: none;
  color: var(--text-dim);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
}
.target-new-result-badge {
  flex: none;
  padding: 0 5px;
  border: 1px solid var(--accent-soft-line);
  border-radius: var(--radius-pill);
  color: var(--accent-ink);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
}
.target-new-result-path {
  flex: 1 1 auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-mono);
}
.target-new-result-path.is-empty { color: var(--text-dim); }
.target-new-result-path.is-invalid { color: var(--danger-ink); }
.target-new-manual-toggle {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent-ink);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  cursor: pointer;
}
.target-new-manual-toggle:hover { text-decoration: underline; }
.target-new-hint {
  color: var(--text-dim);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
}
/* The confirm button carries the whole action in its label — the exact path
   it will act on — full width so long paths stay honest. */
.target-new-use {
  align-self: stretch;
  padding: 4px 10px;
  border: 0;
  border-radius: var(--radius-m);
  background: var(--accent);
  color: var(--white);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.target-new-use:hover { background: var(--accent-hover); }
.target-new-use:disabled {
  background: var(--wash-strong);
  color: var(--text-dim);
  cursor: not-allowed;
}
.target-new-error {
  color: var(--danger-ink);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
}
.badge {
  position: fixed;
  width: ${BADGE_PX}px;
  height: ${BADGE_PX}px;
  /* Three rounded corners and one square one: the marker reads as a tag that
     points at the thing it belongs to, instead of a floating dot. */
  border-radius: 9px 9px 0 9px;
  /* Markers and their cards sit above the outlines they annotate (see the
     layer ladder on .hover-box / .locked-box below). */
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent);
  color: var(--white);
  border: 1px solid var(--halo-strong);
  box-shadow: var(--shadow-marker);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  font-variant-numeric: tabular-nums;
  pointer-events: auto;
  cursor: pointer;
}
.badge:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 1px; }
.badge[data-state="resolved"] { background: var(--ok-marker); }
.badge[data-state="wont_fix"] { background: var(--mute); }
.badge-card {
  display: none;
  position: absolute;
  top: -2px;
  left: ${BADGE_PX + 6}px;
  width: 250px;
  padding: 8px;
  border-radius: var(--radius-l);
  background: var(--chrome-solid);
  color: var(--ink);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-card);
  font: var(--text-body) / var(--text-body-lh) var(--font-ui);
  cursor: auto;
}
/* The 6 px between the marker and its card used to be a dead zone: leaving the
   marker killed :hover before the pointer reached the card. This invisible strip
   belongs to the card, so crossing the gap never leaves the badge's subtree. */
.badge-card::before {
  content: "";
  position: absolute;
  top: -10px;
  bottom: -10px;
  left: -16px;
  width: 16px;
}
.badge[data-flip="1"] .badge-card { left: auto; right: ${BADGE_PX + 6}px; }
.badge[data-flip="1"] .badge-card::before { left: auto; right: -16px; }
.badge[data-open="1"] .badge-card { display: block; }
.badge[data-open="1"] {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85), 0 1px 4px rgba(0, 0, 0, 0.4);
}
.badge-card-head { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 6px; }
.badge-card-meta {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-dim);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
  font-variant-numeric: tabular-nums;
  /* Localized state and kind labels: no uppercase tracking, or Han glyphs
     would be letter-spaced. */
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.badge-card-del {
  flex: none;
  width: 18px;
  height: 18px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-s);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-dim);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  cursor: pointer;
}
.badge-card-del:hover:not(:disabled) {
  background: var(--danger-wash);
  border-color: var(--danger);
  color: var(--danger-soft-ink);
}
.badge-card-del:disabled { opacity: 0.5; cursor: default; }
.badge[data-pending="1"] { opacity: 0.6; }
.badge-card-text { white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; }
.badge-card-note { margin-top: 6px; color: var(--ok-ink); white-space: pre-wrap; word-break: break-word; }
.badge-card-target {
  margin-top: 6px;
  color: var(--accent-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.toast {
  position: fixed;
  z-index: 11;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(520px, calc(100vw - 24px));
  padding: 7px 12px;
  border-radius: var(--radius-l);
  background: var(--chrome);
  color: var(--ink-hi);
  border: 1px solid var(--line-soft);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  box-shadow: var(--shadow-toast);
  pointer-events: none;
}
.toast[data-tone="error"] { border-color: var(--danger); color: var(--danger-soft-ink); }
.toast[data-tone="ok"] { border-color: var(--ok); }
`

  ui.styles = { BADGE_PX, CSS }
})(globalThis)
