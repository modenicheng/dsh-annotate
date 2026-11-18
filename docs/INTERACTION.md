# Interaction model — where an annotation goes

This note fixes the target end state so the pieces (overlay, bridge, host plugin,
DSH client half) can be built against one description instead of drifting.

## The gesture

1. On any page, `Alt+Shift+A` (or the toolbar button) enters annotate mode.
2. The user marks a text selection, an element, or a region, and may write a
   comment. The mark alone is a complete annotation: an empty comment sends the
   pointer by itself.
3. The composer shows a **target**: the Session the annotation will join.
   Default is the Session the user is currently looking at in the DSH window.
4. Submitting stores the annotation and leaves a **reference** in that Session's
   composer — the same atomic chip `@file` and `@session` already use.

The reference is the point. It is visible, it is part of the message the user is
about to send, and deleting it means the annotation never enters that
conversation. Nothing is injected behind the user's back.

## Target picker

- One flat list, every workspace, ordered by last activity. No workspace
  grouping: the workspace is a detail line, not a level of the tree.
- Search filters over title, session id, cwd, and workspace name.
- The row detail (shown on hover/focus) carries the workspace name and relative
  last activity, plus `running` / `blank` state.
- The first entry is **＋ 新建会话**, which creates a Session in the workspace of
  the currently targeted one (or the default workspace).
- Default selection: the Session the DSH window is showing. The Host has no such
  notion, so the Client half reports it; until a Client is connected the picker
  falls back to the most recently active Session.

Host data source: `GET /ext/anno/sessions?token=…` (`packages/plugin/src/sessions.js`).
It returns `{ok, items[], total, truncated, defaultSessionId}` where each item is
`{id, title, updatedAt, running, blank, agentAvailable, cwd, workspace}`.

## What travels in the message

The chip serializes to a hidden mention:

```
@[批注 · 那段话](dsh-anno:an-20261118-ab12cd)
```

On submit, the Host resolves those mentions at `agent/pre-step`, exactly like
`session-reference` does for `@[label](dsh-session:…)`, and appends one
`additionalContext` message per user turn carrying the structured anchor and the
crop image. The visible message keeps only the chip; the annotation body never
enters the transcript as prose.

## Why not a background injection

- A system-prompt section would be invisible: the user could not tell an
  annotation was attached, let alone drop one.
- Sending a message per annotation would start a turn the user did not ask for.
- Session ownership then needs no bookkeeping: a chip belongs to whichever
  conversation its message belongs to. The store stays a flat global pool keyed
  by page URL; it never learns about Sessions.

## Open questions

- **Cross-Session insertion.** The composer renders one Session at a time. For a
  target that is not on screen the chip has to wait for that Session to open.
  Two candidate mechanisms: write the persisted per-Session draft
  (`localStorage['dsh.conversation.<id>']`, read at composer mount), or navigate
  with `ctx.uiWorkspace.openSession` and insert through `uiConversation.input`.
  The second is the supported path; the first is a fallback that touches an
  internal storage shape.
- **Scheme negotiation.** The bridge must know whether it is reached over `ws`
  or `wss`; the Host advertises it in `/ext/anno/health` rather than letting the
  extension guess.
