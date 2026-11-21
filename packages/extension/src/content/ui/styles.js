/**
 * dsh-marker content script 3/4 (ui) — the one stylesheet.
 *
 * It is injected as a `<style>` inside the closed shadow root, so every rule is
 * scoped by construction: no `!important`, no page-specific guards, and the
 * page's CSS cannot see or deform any of it. `BADGE_PX` lives here because the
 * stylesheet and the placement math must agree on the marker size.
 *
 * Visual language: Swiss Modernism 2.0. One paper colour, one ink, one signal
 * red; a 4 px baseline grid, square corners, hairline rules, uppercase micro
 * labels, and monospace for numbers and selectors. Chrome is a thin strip, not
 * a floating dashboard — annotation has to stay out of the page's way.
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
  /* Swiss palette: paper, ink, one signal colour. No second accent, no tints
     beyond the 6–16% reds used as fills under outlines. */
  --paper: #ffffff;
  --ink: #0e0e0e;
  --soft: #f2f2f2;
  --rule: #d6d6d6;
  --muted: #5c5c5c;
  --accent: #e10600;
  --paper-on-ink: #ffffff;
  /* Type: Helvetica is the face of the style; the CJK fallbacks keep the
     Chinese table on the same grid. Three sizes, uppercase only for labels. */
  --font-ui: "Helvetica Neue", Helvetica, Arial, "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, "SFMono-Regular", Menlo, "Cascadia Mono", monospace;
  --text-body: 13px;
  --text-body-lh: 18px;
  --text-label: 12px;
  --text-label-lh: 16px;
  --text-caption: 10px;
  --text-caption-lh: 13px;
  --micro: 9px;
  --tracking: 0.1em;
  --shadow: 4px 4px 0 rgba(14, 14, 14, 0.14);
}
*, *::before, *::after { box-sizing: border-box; }
[f-hidden] { display: none !important; }
button { font-family: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* ── HUD ────────────────────────────────────────────────────────────────── */
.hud {
  position: fixed;
  z-index: 10;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: min(760px, calc(100vw - 20px));
  padding: 4px 5px 4px 7px;
  border: 1px solid var(--ink);
  border-left: 4px solid var(--accent);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  box-shadow: var(--shadow);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  pointer-events: auto;
}
.hud-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 0;
  background: transparent;
  border: 1px solid var(--ink);
}
.hud-dot[data-state="ok"] { background: var(--ink); border-color: var(--ink); }
.hud-dot[data-state="warn"] { background: var(--accent); border-color: var(--accent); }
.hud-dot[data-state="off"] { background: transparent; }
.hud-mode {
  flex: none;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: var(--tracking);
  white-space: nowrap;
}
.hud-hint {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: var(--micro);
  line-height: var(--text-caption-lh);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.hud-btn {
  flex: none;
  padding: 2px 6px;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  font: 600 var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  white-space: nowrap;
  cursor: pointer;
}
.hud-btn:hover:not(:disabled) { background: var(--ink); color: var(--paper-on-ink); }
.hud-btn:disabled { opacity: 0.35; cursor: default; }
.hud-btn[aria-pressed="true"] { background: var(--ink); color: var(--paper-on-ink); }
.hud-btn[data-armed="1"] { background: var(--accent); border-color: var(--accent); color: #fff; }

/* The idle launcher: paper square, ink border, signal-red monogram bar. It is
   the only chrome on screen when annotation mode is off. */
.launcher {
  position: fixed;
  z-index: 10;
  right: 14px;
  bottom: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  padding: 0;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  box-shadow: var(--shadow);
  cursor: pointer;
}
.launcher::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  background: var(--accent);
}
.launcher:hover { background: var(--ink); color: var(--paper-on-ink); }
.launcher-glyph { font: 700 17px / 1 var(--font-ui); letter-spacing: 0.02em; }
/* The shortcut is the tooltip; the visible line would not fit 42 px. */
.launcher-key { display: none; }

/* ── pick banner ─────────────────────────────────────────────────────────── */
.pick {
  position: fixed;
  z-index: 10;
  top: 52px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: min(680px, calc(100vw - 20px));
  padding: 6px 8px;
  border: 1px solid var(--ink);
  border-left: 4px solid var(--accent);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  box-shadow: var(--shadow);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  pointer-events: auto;
}
.pick-text { flex: 1 1 auto; white-space: pre-wrap; word-break: break-word; }
.pick-meta {
  flex: none;
  color: var(--accent);
  font-size: var(--micro);
  line-height: var(--text-caption-lh);
  text-align: right;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

/* ── outlines and marks ──────────────────────────────────────────────────── */
/* Layer ladder: outlines (1) sit under markers (3) and their cards, labels ride
   above both (4), and the chrome being operated (composer 9, HUD and pick 10,
   toasts 11) stays on top. Without it, painting order is DOM order — which is
   why an annotation card used to disappear behind the outline it describes. */
.hover-box, .marquee {
  position: fixed;
  z-index: 1;
  border: 2px solid var(--accent);
  border-radius: 0;
  background: rgba(225, 6, 0, 0.06);
  pointer-events: none;
}
.marquee { border-style: dashed; background: rgba(225, 6, 0, 0.1); }
/* The locked outline marks what the open composer (or a hovered badge) refers
   to. Ink, not red: the live pointer owns the signal colour. */
.locked-box {
  position: fixed;
  z-index: 1;
  border: 2px solid var(--ink);
  border-radius: 0;
  background: rgba(225, 6, 0, 0.08);
  pointer-events: none;
}
.hover-chip[data-locked="1"] { background: var(--accent); }
/* A marked text is one band per line box, underlined rather than boxed: an
   outline around the paragraph would not say which words were picked. */
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
  background: rgba(225, 6, 0, 0.14);
  box-shadow: inset 0 -2px 0 var(--accent);
  pointer-events: none;
}
.hover-chip {
  position: fixed;
  z-index: 4;
  max-width: min(360px, calc(100vw - 16px));
  padding: 2px 5px;
  border-radius: 0;
  background: var(--ink);
  color: var(--paper-on-ink);
  font: var(--micro) / var(--text-caption-lh) var(--font-mono);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.cursor-ring {
  position: fixed;
  z-index: 2;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  border: 2px solid var(--ink);
  background: rgba(255, 255, 255, 0.35);
  pointer-events: none;
}
/* While Shift arms a text selection there is no element to outline, so the
   pointer carries a teardrop instead: the sharp corner points back at the
   cursor and the body hangs off its bottom-right. */
.shift-drop {
  position: fixed;
  z-index: 2;
  width: 12px;
  height: 12px;
  margin: 10px 0 0 10px;
  border-radius: 0 50% 50% 50%;
  background: var(--accent);
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.92);
  pointer-events: none;
}

/* ── composer ───────────────────────────────────────────────────────────── */
.composer {
  position: fixed;
  z-index: 9;
  padding: 8px;
  border: 1px solid var(--ink);
  border-top: 4px solid var(--accent);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  box-shadow: var(--shadow);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  pointer-events: auto;
}
.composer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 5px;
}
.composer-kind {
  color: var(--accent);
  font-weight: 700;
  font-size: var(--micro);
  letter-spacing: var(--tracking);
  text-transform: uppercase;
  white-space: nowrap;
}
.composer-summary {
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  max-width: 210px;
  font: var(--text-caption) / var(--text-caption-lh) var(--font-mono);
  direction: ltr;
}
.composer textarea {
  width: 100%;
  min-height: 56px;
  max-height: 200px;
  resize: vertical;
  padding: 6px;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  font: var(--text-body) / var(--text-body-lh) var(--font-ui);
  outline: none;
}
.composer textarea:focus { outline: 2px solid var(--accent); outline-offset: -2px; }
.chips { display: flex; flex-wrap: wrap; gap: 3px; margin: 6px 0 0; }
.chip {
  padding: 2px 6px;
  border-radius: 0;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  font: 600 var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
}
.chip[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: var(--paper-on-ink); }
.composer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
}
/* nowrap keeps the foot one line; ellipsis keeps a longer locale inside the card
   instead of painting past its edge at the 240px minimum width. */
.composer-hint {
  color: var(--muted);
  font-size: var(--micro);
  line-height: var(--text-caption-lh);
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.composer-actions { display: flex; flex: 0 0 auto; gap: 4px; }
.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 0;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  font: 600 var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
}
.btn:hover:not(:disabled) { background: var(--ink); color: var(--paper-on-ink); }
.btn:disabled { opacity: 0.35; cursor: default; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--ink); border-color: var(--ink); }
.btn .icon { width: 12px; height: 12px; fill: currentColor; flex: none; }
/* Offline alert under the textarea: paired with the disabled send button. */
.composer-alert {
  margin-top: 5px;
  padding: 3px 6px;
  border: 1px solid var(--ink);
  border-left: 3px solid var(--accent);
  background: var(--paper);
  color: var(--ink);
  font-size: var(--micro);
  line-height: var(--text-caption-lh);
}
.composer-error {
  margin-top: 5px;
  color: var(--accent);
  font-size: var(--micro);
  line-height: var(--text-caption-lh);
  white-space: pre-wrap;
}

/* ── target picker ──────────────────────────────────────────────────────── */
/* One line per row: a height that depends on the pointer makes the list jump
   under the cursor. The workspace lives in .target-tip instead. */
.target { position: relative; margin-top: 6px; }
.target-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 2px 5px;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.target-btn:hover { background: var(--soft); }
.target-key {
  flex: none;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.target-value { flex: 1 1 auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.target-caret { flex: none; color: var(--muted); }
.target-panel {
  position: absolute;
  z-index: 2;
  left: 0;
  right: 0;
  top: calc(100% + 3px);
  display: flex;
  flex-direction: column;
  max-height: 210px;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.target-search {
  margin: 4px;
  padding: 2px 5px;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  outline: none;
}
.target-search:focus { outline: 2px solid var(--accent); outline-offset: -2px; }
.target-list { overflow-y: auto; padding: 0 3px 3px; }
.target-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 3px 4px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  text-align: left;
  cursor: pointer;
}
.target-row[data-active="1"] { background: var(--ink); color: var(--paper-on-ink); }
.target-row[data-active="1"] .target-row-time,
.target-row[data-active="1"] .target-row-meta { color: #d9d9d9; }
.target-row-title { flex: 1 1 auto; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.target-row-time {
  flex: none;
  color: var(--muted);
  font: var(--micro) / var(--text-caption-lh) var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.target-tip {
  position: absolute;
  z-index: 3;
  max-width: 220px;
  padding: 2px 5px;
  border-radius: 0;
  background: var(--ink);
  color: var(--paper-on-ink);
  font: var(--micro) / var(--text-caption-lh) var(--font-ui);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.target-empty { padding: 6px 4px; color: var(--muted); font-size: var(--micro); line-height: var(--text-caption-lh); }
/* The "new session" arm: one pinned action row above the list, and a workspace
   sub-panel that replaces the list while it is open. */
.target-new { margin: 0 3px; color: var(--accent); font-weight: 700; }
.target-new:disabled { color: var(--muted); cursor: not-allowed; }
.target-new-panel {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px;
  overflow-y: auto;
}
.target-new-head { display: flex; align-items: center; gap: 4px; }
.target-back {
  padding: 1px 5px;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  cursor: pointer;
}
.target-back:hover { background: var(--soft); }
.target-new-title {
  flex: 1 1 auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: var(--micro);
  line-height: var(--text-caption-lh);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.target-new-options { display: flex; flex-direction: column; gap: 1px; }
.target-new-option[aria-pressed="true"] { background: var(--ink); color: var(--paper-on-ink); }
.target-row-meta {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: var(--micro);
  line-height: var(--text-caption-lh);
}
.target-new-fields {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 3px;
  border-top: 1px solid var(--rule);
}
.target-new-label {
  color: var(--muted);
  font-size: var(--micro);
  line-height: var(--text-caption-lh);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.target-new-path {
  padding: 2px 5px;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-mono);
  outline: none;
}
.target-new-title-input {
  padding: 2px 5px;
  border: 1px solid var(--ink);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  outline: none;
}
.target-new-path:focus, .target-new-title-input:focus { outline: 2px solid var(--accent); outline-offset: -2px; }
.target-new-use {
  align-self: flex-end;
  padding: 2px 8px;
  border: 1px solid var(--accent);
  border-radius: 0;
  background: var(--accent);
  color: #fff;
  font: 600 var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  cursor: pointer;
}
.target-new-use:hover { background: var(--ink); border-color: var(--ink); }
.target-new-error {
  color: var(--accent);
  font-size: var(--micro);
  line-height: var(--text-caption-lh);
}

/* ── markers ────────────────────────────────────────────────────────────── */
.badge {
  position: fixed;
  width: ${BADGE_PX}px;
  height: ${BADGE_PX}px;
  border-radius: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--ink);
  color: var(--paper-on-ink);
  border: 1px solid #ffffff;
  box-shadow: 0 0 0 1px rgba(14, 14, 14, 0.65);
  font: 700 var(--text-caption) / 1 var(--font-mono);
  font-variant-numeric: tabular-nums;
  pointer-events: auto;
  cursor: pointer;
}
.badge:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.badge[data-state="resolved"] { background: var(--paper); color: var(--ink); border-color: var(--ink); }
.badge[data-state="wont_fix"] { background: #8a8a8a; color: #ffffff; border-color: #8a8a8a; }
.badge-card {
  display: none;
  position: absolute;
  top: -2px;
  left: ${BADGE_PX + 6}px;
  width: 250px;
  padding: 7px;
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  border: 1px solid var(--ink);
  border-top: 3px solid var(--accent);
  box-shadow: var(--shadow);
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
.badge[data-open="1"] { box-shadow: 0 0 0 2px var(--accent); }
.badge-card-head { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 4px; }
.badge-card-meta {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--muted);
  font: var(--micro) / var(--text-caption-lh) var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.badge-card-del {
  flex: none;
  width: 17px;
  height: 17px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0;
  border: 1px solid var(--ink);
  background: var(--paper);
  color: var(--ink);
  font: var(--text-label) / var(--text-label-lh) var(--font-ui);
  cursor: pointer;
}
.badge-card-del:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: #fff; }
.badge-card-del:disabled { opacity: 0.35; cursor: default; }
.badge[data-pending="1"] { opacity: 0.55; }
.badge-card-text { white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; }
.badge-card-note {
  margin-top: 4px;
  color: var(--ink);
  border-left: 2px solid var(--accent);
  padding-left: 5px;
  white-space: pre-wrap;
  word-break: break-word;
}
.badge-card-target {
  margin-top: 4px;
  color: var(--accent);
  font-size: var(--micro);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── toast ──────────────────────────────────────────────────────────────── */
.toast {
  position: fixed;
  z-index: 11;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(520px, calc(100vw - 24px));
  padding: 5px 9px;
  border: 1px solid var(--ink);
  border-left: 4px solid var(--accent);
  border-radius: 0;
  background: var(--paper);
  color: var(--ink);
  box-shadow: var(--shadow);
  font: var(--text-caption) / var(--text-caption-lh) var(--font-ui);
  pointer-events: none;
}
.toast[data-tone="error"] { border-left-color: var(--accent); background: var(--ink); color: var(--paper-on-ink); }
.toast[data-tone="ok"] { border-left-color: var(--ink); }
`

  ui.styles = { BADGE_PX, CSS }
})(globalThis)
