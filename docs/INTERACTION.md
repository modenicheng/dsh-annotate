# Interaction model — where an annotation goes

This note fixes the target end state so the pieces (overlay, bridge, host plugin,
DSH client half) can be built against one description instead of drifting.

## The gesture

1. On any page, the shortcut (default `Alt+Shift+A`, configurable in the
   popup) enters annotate mode. The toolbar popup's **Annotate this page** button
   enters it as well, and is the path that also grants `activeTab` on a tab that
   predates the install. On Firefox the popup recording also updates the
   browser command, so the two doors stay in step. On Chromium the extension
   cannot write commands: the browser command must be assigned once by hand in
   `chrome://extensions/shortcuts`, and only that command grants `activeTab`
   (screenshots). The in-page matcher works everywhere but never grants
   `activeTab`, so on Chromium a mark entered through it ships without its
   screenshot unless the tab was granted another way.
2. The user marks a text selection, an element, or a region, and may write a
   comment. The mark alone is a complete annotation: an empty comment sends the
   pointer by itself.
3. While an element is outlined, `Tab` widens the outline one ancestor at a
   time and `Shift+Tab` steps back down (the chip counts the level, `↑2`).
   The walk stops at the outermost wrapper before `body`. The level belongs to
   the chain under the pointer: moving inside the widened element keeps the
   outline on it, moving out restarts at the deepest element, and the click
   locks whatever level is outlined. An open composer keeps `Tab` for its own
   focus cycle, so the keys only act while picking. A right-click on the page
   leaves the mode by default (a preference can turn that off, and the composer
   keeps the browser's text menu); another preference can make a successful send
   leave it as well — that one runs only after the annotation was acknowledged,
   so a failed send never discards a draft.
4. The composer shows a **target**: the Session the annotation will join.
   Default is the Session the user is currently looking at in the DSH window.
5. Submitting stores the annotation and leaves a **reference** in that Session's
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
- The first entry is **＋ 新建会话**, pinned above the list and disabled while
  the host is offline (creation cannot queue, D25). It opens a workspace
  sub-panel with three modes: **默认工作区** (no location — the same default
  the Client's own new-session button resolves), **each registered workspace**
  (the new Session joins it), and **新建工作区** (a location chosen from
  anchor rows — the registered workspaces' own paths and their parents,
  deduplicated — plus an optional folder name, so at most one path segment is
  ever typed; the manual absolute path survives behind a toggle as the
  fallback for a host that reports no workspace at all; the Host creates the
  directories and registers the workspace idempotently, D26). Confirming a
  mode sets the target to `新建 · <workspace>`;
  the Session itself is created at send time, before the annotation names it,
  so a creation failure keeps the composer open with the comment intact. The
  Host publishes `{t:'session', sessionId}` after a create and the Client half
  follows it: the page switches to the new Session when the build exposes a
  selection hook, and otherwise the chip waits in the queue until the user
  opens it.
- Default selection: the Session the DSH window is showing. The Client half
  reports it (`POST /ext/anno/focus`, refreshed on mount and when the window
  regains focus), and the Host answers `defaultSessionId` with it while the
  catalog still lists it; without a report — or with one older than six hours —
  the picker falls back to the most recently active Session. The same report
  routes an annotation that was submitted without touching the picker (D18).

Host data source: `GET /ext/anno/sessions`（token 经 `Authorization: Bearer` / `x-anno-token` header 传入；`packages/plugin/src/sessions.js`）。
It returns `{ok, items[], total, truncated, defaultSessionId, workspaces[]}` where each item is
`{id, title, updatedAt, running, blank, agentAvailable, cwd, workspace}` and each
workspace row is `{id, title, path}`. Creation is
`POST /ext/anno/session-create` (`packages/plugin/src/provision.js`), same
token, body `{mode, workspaceId?, path?, title?}`.

## What travels in the message

The chip serializes to a hidden mention:

```
@[批注 · 那段话](dsh-anno:an-20261118-ab12cd)
```

The label is presentation only — it may be localized, repeated, and stale; the
id is identity. `formatAnnoMention` / `parseAnnoText` in
`packages/protocol/src/index.js` are the only codec, shared by the extension, the
Host, and the Web Client rule.

Rendering: `packages/plugin/client.js` registers a `UserText` rule for the
`dsh-anno:` wire form plus a `conversation.user.text.node` renderer keyed `anno`,
so a cited annotation is one atomic chip in the message bubble (it survives a
reload, because the mention is what the log keeps). The chip copies the product's
own reference chip — inline business-coloured text at weight 500, one `1em` glyph
with a 4px gap — and differs only in the glyph, a selection frame in place of the
file or session icon. Like a folder reference it has no activation action, so it
is a `span`, not a button.

Hovering the chip opens the product's `HoverCard` with what the user marked: the
crop the browser took, the page title and URL, the quote or the element, the
comment, and intent/state/time (D19). The card reads the annotation back from
`GET /ext/anno/item?id=…` and the PNG from `GET /ext/anno/image?id=…`, both
same-origin. Everything it shows was frozen at click time — the record carries
`snapshot: {at, rect, viewport}` — so a page that re-renders or scrolls afterwards
cannot change what the card claims was marked. The composer's chip is the
product's own component with its label as `title`; it has no hover seam.

Context: the Host matches the same mention at `agent/pre-step`
(`packages/plugin/src/mentions.js`) and places one `source.kind = 'annotations'`
message right after the message that cited it, carrying the anchor, page
context, comment, and the crop as an image block. A deleted annotation is
reported in that context instead of failing the turn. The mention text is **not**
rewritten — see D11.

## Why not a background injection

- A system-prompt section would be invisible: the user could not tell an
  annotation was attached, let alone drop one.
- Sending a message per annotation would start a turn the user did not ask for.
- Session ownership then needs no bookkeeping: a chip belongs to whichever
  conversation its message belongs to. The store stays a flat global pool keyed
  by page URL; it never learns about Sessions.

## Open questions

- **Cross-Session insertion.** Resolved: the Host keeps a durable queue
  (`$DSH_HOME/annotations/pending-mentions.json`) of mentions waiting for one
  Session, and the Web Client appends them to that Session's composer the next
  time the user opens it. The write is a *structured* draft — the mention joins
  the document's `references`, so the composer shows a real chip the user can
  read and remove, not raw mention text (D17). Nothing is sent and no turn
  starts. The queue is read and acknowledged over two same-origin routes
  (`/ext/anno/queue`, `/ext/anno/queue/ack`), not over the bridge: the page never
  sees the extension's token (D12). "The next time the user opens it" is *now*,
  not on a timer: the Host nudges the page over `GET /ext/anno/events` (a
  server-sent stream naming the Session, never the payload), so a mention queued
  while that Session is on screen lands in its composer immediately, and a slow
  repair poll covers a stream that was down (D24).
- **Scheme negotiation.** The bridge must know whether it is reached over `ws`
  or `wss`; the Host advertises it in `/ext/anno/health` rather than letting the
  extension guess.
