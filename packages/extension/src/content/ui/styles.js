/**
 * dsh-marker content script 3/4 (ui) — the one stylesheet.
 *
 * It is injected as a `<style>` inside the closed shadow root, so every rule is
 * scoped by construction: no `!important`, no page-specific guards, and the
 * page's CSS cannot see or deform any of it. `BADGE_PX` lives here because the
 * stylesheet and the placement math must agree on the marker size.
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
  /* Type ramp — English-first, compact density. Exactly three sizes; anything
     new must map onto one of them. px on purpose: this overlay is injected into
     pages whose root font-size we do not control, so rem would inherit a
     foreign scale. */
  --font-ui: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --text-body: 14px;
  --text-body-lh: 20px;
  --text-label: 13px;
  --text-label-lh: 18px;
  --text-caption: 12px;
  --text-caption-lh: 16px;
  /* Muted text on the dark chrome: #6b7280 measured ~3.7:1 against #111827,
     under the AA 4.5:1 floor at caption sizes. #9ca3af is ~7:1. */
  --text-dim: #9ca3af;
}
*, *::before, *::after { box-sizing: border-box; }
[f-hidden] { display: none !important; }
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
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.95);
  color: #e5e7eb;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.12);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
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
.hud-mode { font-weight: 600; white-space: nowrap; flex: none; }
.hud-hint {
  color: #9ca3af;
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
  border-radius: 5px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: transparent;
  color: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.hud-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
.hud-btn:disabled { opacity: 0.45; cursor: default; }
.hud-btn[aria-pressed="true"] { background: rgba(37, 99, 235, 0.85); border-color: #3b82f6; }
.hud-btn[data-armed="1"] {
  background: rgba(185, 28, 28, 0.9);
  border-color: #ef4444;
  color: #ffffff;
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
  border-radius: 10px;
  background: rgba(69, 26, 3, 0.96);
  border: 1px solid rgba(251, 191, 36, 0.5);
  color: #fef3c7;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  pointer-events: auto;
}
.pick-text { flex: 1 1 auto; white-space: pre-wrap; word-break: break-word; }
.pick-meta { flex: none; color: #fcd34d; font-size: var(--text-caption); line-height: var(--text-caption-lh); text-align: right; }
/* Layer ladder inside the overlay: outlines (1) sit under markers (3) and their
   cards, labels ride above both (4), and the chrome the user is operating
   (composer 9, HUD and pick banner 10, toasts 11) stays on top of everything.
   Without it, painting order is DOM order — which is why an annotation card
   used to disappear behind the outline of the very thing it describes. */
.hover-box, .marquee {
  position: fixed;
  z-index: 1;
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
  z-index: 1;
  border: 2px solid #f59e0b;
  border-radius: 3px;
  background: rgba(245, 158, 11, 0.1);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
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
  background: rgba(245, 158, 11, 0.22);
  box-shadow: inset 0 -2px 0 rgba(245, 158, 11, 0.65);
  pointer-events: none;
}
.hover-chip {
  position: fixed;
  z-index: 4;
  max-width: min(360px, calc(100vw - 16px));
  padding: 3px 6px;
  border-radius: 4px;
  background: #1d4ed8;
  color: #ffffff;
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
  border: 2px solid #3b82f6;
  background: rgba(255, 255, 255, 0.4);
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
  background: #2563eb;
  box-shadow:
    0 0 0 1.5px rgba(255, 255, 255, 0.92),
    0 2px 6px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
.composer {
  position: fixed;
  z-index: 9;
  padding: 10px;
  border-radius: 10px;
  background: #111827;
  color: #e5e7eb;
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
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
  font: var(--text-body) / var(--text-body-lh) var(--font-ui);
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
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
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
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: transparent;
  color: #e5e7eb;
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  cursor: pointer;
}
.btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn-primary { background: #2563eb; border-color: #3b82f6; color: #ffffff; }
.btn-primary:hover:not(:disabled) { background: #1d4ed8; }
.btn .icon { width: 14px; height: 14px; fill: currentColor; flex: none; }
/* Offline alert under the textarea: paired with the disabled send button. */
.composer-alert {
  margin-top: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.12);
  color: #fcd34d;
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
}
.composer-error { margin-top: 6px; color: #fca5a5; font-size: var(--text-caption); line-height: var(--text-caption-lh); white-space: pre-wrap; }
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
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.04);
  color: #e5e7eb;
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.target-btn:hover { background: rgba(255, 255, 255, 0.1); }
.target-key { flex: none; color: var(--text-dim); }
.target-value { flex: 1 1 auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.target-caret { flex: none; color: #9ca3af; }
.target-panel {
  position: absolute;
  z-index: 2;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  display: flex;
  flex-direction: column;
  max-height: 220px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: #0b1220;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}
.target-search {
  margin: 6px;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.05);
  color: #e5e7eb;
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  outline: none;
}
.target-list { overflow-y: auto; padding: 0 4px 4px; }
/* One line per row: a height that depends on the pointer makes the list jump
   under the cursor. The workspace lives in .target-tip instead. */
.target-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #e5e7eb;
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.target-row[data-active="1"] { background: rgba(37, 99, 235, 0.28); }
.target-row-title { flex: 1 1 auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.target-row-time { flex: none; color: #94a3b8; font-size: var(--text-caption); line-height: var(--text-caption-lh); font-variant-numeric: tabular-nums; }
.target-tip {
  position: absolute;
  z-index: 3;
  max-width: 220px;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: #0b1220;
  color: #cbd5e1;
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
}
.target-empty { padding: 8px 6px; color: var(--text-dim); font-size: var(--text-caption); line-height: var(--text-caption-lh); }
/* The "new session" arm: one pinned action row above the list, and a workspace
   sub-panel that replaces the list while it is open. Same skin as the picker so
   the two read as one control. */
.target-new { margin: 0 4px; color: #93c5fd; }
.target-new:disabled { color: var(--text-dim); cursor: not-allowed; }
.target-new-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  overflow-y: auto;
}
.target-new-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.target-back {
  padding: 2px 6px;
  border: 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: #cbd5e1;
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  cursor: pointer;
}
.target-back:hover { background: rgba(255, 255, 255, 0.12); }
.target-new-title {
  flex: 1 1 auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-dim);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.target-new-options { display: flex; flex-direction: column; gap: 2px; }
.target-new-option[aria-pressed="true"] { background: rgba(37, 99, 235, 0.28); }
.target-row-meta {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: #94a3b8;
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
}
.target-new-fields {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}
.target-new-label {
  color: var(--text-dim);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
}
.target-new-path {
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.05);
  color: #e5e7eb;
  font: var(--text-caption) / var(--text-caption-lh) var(--font-mono);
  outline: none;
}
/* M4.7a: the new workspace is chosen from the host's own registered paths;
   the anchor list reuses the picker's row skin so both arms read as one. */
.target-new-name {
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.05);
  color: #e5e7eb;
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  outline: none;
}
.target-anchor-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 132px;
  overflow-y: auto;
}
.target-anchor[aria-pressed="true"] { background: rgba(37, 99, 235, 0.28); }
/* M4.7b: the host-served browser rides on the same list skin; its head is one
   Up affordance plus the current directory, mono because it is a path. */
.target-fs-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.target-fs-up {
  padding: 2px 6px;
  border: 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: #cbd5e1;
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  cursor: pointer;
}
.target-fs-up:hover { background: rgba(255, 255, 255, 0.12); }
.target-fs-up:disabled { color: var(--text-dim); cursor: not-allowed; }
.target-fs-path {
  flex: 1 1 auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: #94a3b8;
  font: var(--text-caption) / var(--text-caption-lh) var(--font-mono);
}
.target-new-manual-toggle {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: #93c5fd;
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  cursor: pointer;
}
.target-new-manual-toggle:hover { text-decoration: underline; }
.target-new-hint {
  color: var(--text-dim);
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
}
.target-new-title-input {
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.05);
  color: #e5e7eb;
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  outline: none;
}
.target-new-use {
  align-self: flex-end;
  padding: 3px 10px;
  border: 0;
  border-radius: 6px;
  background: #2563eb;
  color: #fff;
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  cursor: pointer;
}
.target-new-use:hover { background: #1d4ed8; }
.target-new-error {
  color: #fca5a5;
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
  background: #2563eb;
  color: #ffffff;
  border: 1px solid rgba(255, 255, 255, 0.55);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  font-variant-numeric: tabular-nums;
  pointer-events: auto;
  cursor: pointer;
}
.badge:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
.badge[data-state="resolved"] { background: #16a34a; }
.badge[data-state="wont_fix"] { background: #6b7280; }
.badge-card {
  display: none;
  position: absolute;
  top: -2px;
  left: ${BADGE_PX + 6}px;
  width: 250px;
  padding: 8px;
  border-radius: 8px;
  background: #111827;
  color: #e5e7eb;
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
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
.badge[data-open="1"] { box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85), 0 1px 4px rgba(0, 0, 0, 0.4); }
.badge-card-head { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 6px; }
.badge-card-meta {
  flex: 1 1 auto;
  min-width: 0;
  color: #9ca3af;
  font-size: var(--text-caption);
  line-height: var(--text-caption-lh);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  text-transform: uppercase;
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
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: transparent;
  color: #9ca3af;
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  cursor: pointer;
}
.badge-card-del:hover:not(:disabled) { background: rgba(239, 68, 68, 0.2); border-color: #ef4444; color: #fecaca; }
.badge-card-del:disabled { opacity: 0.5; cursor: default; }
.badge[data-pending="1"] { opacity: 0.6; }
.badge-card-text { white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; }
.badge-card-note { margin-top: 6px; color: #86efac; white-space: pre-wrap; word-break: break-word; }
.badge-card-target {
  margin-top: 6px;
  color: #93c5fd;
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
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.96);
  color: #f9fafb;
  border: 1px solid rgba(255, 255, 255, 0.14);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.4);
  pointer-events: none;
}
.toast[data-tone="error"] { border-color: #ef4444; color: #fecaca; }
.toast[data-tone="ok"] { border-color: #22c55e; }
`

  ui.styles = { BADGE_PX, CSS }
})(globalThis)
