# Roadmap

Phases are intentionally small and each one ends in something observable. A
phase is only "done" when its acceptance criteria hold on the stated
environment. Current status is in [README.md](../README.md#status-and-roadmap).

## M0 — Protocol and repository base

**Goal:** freeze a wire format both sides can evolve against, and make the
repository safe to publish.

**Deliverables**

- `packages/protocol/src/index.js`: frame parsers, record validation, anchor
  normalisation, deterministic ids, limits, protocol version.
- `scripts/sync-protocol.mjs` plus committed copies in the plugin and the
  extension, with a `GENERATED FILE` banner.
- Protocol unit tests (`node:test`, no dependencies).
- MIT license, README, CONTRIBUTING, `.gitignore`, `.gitattributes`,
  `.editorconfig`.
- Biome config and pinned formatter/linter; local hooks for Conventional
  Commits and pre-commit checks.
- CI: Node 22 and 24 on `ubuntu-latest`, sync check, syntax check, tests,
  Biome check, and a manifest validation job.

**Acceptance criteria**

- `node scripts/check-sync.mjs` passes and fails on a deliberately drifted
  copy.
- `node --test "packages/*/test/*.test.js"` passes on Node 22 and Node 24 on
  Windows and Linux.
- A commit with an invalid subject is rejected by the `commit-msg` hook; a
  valid one passes.
- CI is green on a trivial commit. The `manifest` job stays red until M2 adds
  `packages/extension/manifest.json`; that is expected, not a skipped check.

## M1 — Host plugin and storage loop

**Goal:** a DSH profile can receive annotations and hand them to the model,
even with no browser connected yet.

**Deliverables**

- Installable `dsh-marker` bundle: `package.json` metadata, patch, locale
  resources, icon, detail document.
- Token file under `$DSH_HOME` with owner-only permissions, constant-time
  comparison, hello deadline, protocol version check.
- RFC 6455 websocket server (`ws`, `noServer`) mounted on the DSH host webserver at
  `/ext/anno`, plus `/ext/anno/health`; ping/pong heartbeat and clean shutdown.
- Append-only JSONL store with in-memory fold, torn-line tolerance, idempotent
  creates, and compaction; screenshots stored through DSH's attachment service.
- Tools `annotate_list`, `annotate_get`, `annotate_resolve`, `annotate_delete`,
  `annotate_clear` with JSON Schema output and renderers. The host-side `annotate_pick` core
  exists too, but it only becomes usable once the browser side lands in M2/M3.
- Unit tests for store and bridge.

**Acceptance criteria**

- Mounting the bundle in a DSH profile registers the tools and both HTTP routes
  without a second listener or port.
- A scripted websocket client can connect, authenticate, create an annotation,
  receive the ack, and see it in `annotate_list`.
- Creating the same annotation id twice is idempotent (offline replay).
- Records survive a profile restart; a torn final log line loses only that
  line; compaction preserves the live projection and image references.
- The plugin declares one runtime dependency (`ws`) and installs from a local directory
  once the workspace dependencies are installed.
- `packages/plugin/test/*.test.js` passes.

## M2 — Extension capture

**Goal:** capture a real annotation in Firefox or Zen and see it in DSH.

**Deliverables**

- MV3 manifest, buildless package layout, and minimal permissions.
- Background: websocket owner, token storage, hello/reconnect with backoff,
  offline outbox with stable ids, badge counts.
- Content script: annotation mode (`Alt+Shift+A`), overlay for text
  selection, element pick, and region drag; composer for an optional comment
  (an empty one sends the mark alone) and intent.
- Screenshot crops: target element/region and viewport context, downscaled and
  bounded before sending.
- Popup: connection state, token entry, queue, flush, resolve/reopen/delete.
- Shared runtime-message contract between background, content, and popup.

**Acceptance criteria**

- The unpacked extension loads in `about:debugging` without errors in Firefox
  128+ and Zen.
- One annotation of each kind (selection, element, region) reaches the host,
  appears in `annotate_list`, and `annotate_get` returns the crop.
- Submitting while the host is down queues the annotation; after reconnect it
  is delivered exactly once.
- The badge count and popup state follow host events; resolve/delete from the
  popup is reflected in the page.
- No uncaught console errors during connect, reconnect, capture, and cancel.

## M3 — Re-anchoring and agent pick

**Goal:** annotations stay attached to their target across reloads, and the
model can ask the user where something is.

**Deliverables**

- Re-anchoring: exact quote with prefix/suffix, selector strategies
  (`stable`, `cssPath`, `xpath`), element fingerprint scoring, graceful
  "anchor lost" state.
- Page overlay markers with hover cards, plus re-hydration after navigation.
- `annotate_pick`: banner with the agent's prompt, gesture restricted by mode,
  timeout/abort/cancel, one pending pick per client, stale answers ignored.
- `pick.result` round trip and the existing host-side `annotate_pick` tool
  wired to the browser.

**Acceptance criteria**

- After reloading a page, markers return at the same text/element; when the
  target is gone, the annotation is shown as anchor-lost instead of crashing.
- A changed document (inserted paragraphs, renamed classes) still re-anchors
  by quote or fingerprint in the covered cases.
- `annotate_pick` resolves once with a record, returns
  `{ ok: false, reason: 'timeout' }` on timeout, and cancels on abort.
- Calling `annotate_pick` with no browser connected fails with an actionable
  error rather than waiting.
- Two tabs of the same URL both show markers; a pick answer from one tab
  settles the request for all of them.

## M3.8 — Push delivery and a snapshot catalog

**Goal:** a local hand-off that feels local. The two waits measured on a live
host were 0–4 s for the composer (a 4 s poll) and 1.3–2.9 s for the target
picker (a full title fold per request over a 38 MB corpus); neither was network.

**Deliverables**

- Host: `GET /ext/anno/events`, one server-sent stream per page (same-origin, no
  token), publishing `{ t: 'mention', sessionId }` after a mention is queued.
- Client half: an `EventSource` opened on the first mounted dock, delivery on
  `mention` for its own Session, a catch-up pull on every `open` (including
  reconnects), and the 4 s poll demoted to a 30 s repair interval.
- Catalog: titles from `SessionSummary.projections.values.title`, then a memo,
  then a bounded fold for the rows being drawn; a 1 s summary cache and a
  warm-up at mount.
- Focus: `focus.json` is written on change, and at most every 10 minutes when
  the same Session keeps reporting itself.
- Tests for the stream (frame shape, same-origin gate, client removal, close)
  and for the catalog's three title tiers; D24 records the reasoning.

**Acceptance criteria**

- Submitting an annotation for the Session on screen puts the chip in its
  composer within 250 ms, with the same acknowledgement and the same durable
  queue entry as before.
- The catalog answers a warm request (39 Sessions) in under 100 ms; the first
  request after a host start is covered by the warm-up rather than by the
  picker.
- Stopping the host and starting it again leaves the page working without a
  reload: the stream reconnects, the focus is re-reported, and a mention queued
  during the outage arrives on the first catch-up pull.
- A page without `EventSource` still delivers, on the repair interval, and says
  so through `data-dsh-anno-trace="no-eventsource"`.
- `PROTOCOL_VERSION` does not move: no frame or record shape changed.

## M4 — Developer depth and session routing

**Goal:** give the model implementation-grade context and route annotations to
the session that should act on them.

**Deliverables**

- Rich element context: tag, id/classes, accessible name/role, bounding rects,
  computed-style whitelist, box model, text excerpt.
- Page context: viewport size, DPR, scroll offsets, title, language, and
  visibility.
- Routing: persistent `routing.sessionId` / `routing.workspaceHint`, filters in
  `annotate_list`, and delivery only to matching sessions.
- Popup management at scale: filters, bulk actions, JSON export.
- Configurable keyboard shortcuts, multi-window awareness, edit and reopen.

**Acceptance criteria**

- Selection anchors carry exact/prefix/suffix; element anchors carry all
  selector strategies and the style whitelist within the documented limits.
- A routed annotation is visible to its target session and hidden from
  unrelated ones, with an explicit fallback when the session is gone.
- `annotate_list` filters by state, URL, kind, session, and workspace without
  scanning unbounded data.
- The popup stays responsive with 500+ stored annotations.

## M4.5 — Discovery and Desktop

**Goal:** the extension finds a host whose port is not `3080`, and the token
paste stays a one-time step rather than one per launch. Desktop is the case that
forces this — its launcher picks the port — but the same work covers
`dsh --profile <name> --port 0` and every custom port.

Design and rationale: [DISCOVERY.md](DISCOVERY.md) (decisions D20–D22).

### M4.5a — Host publishes

**Status:** implemented.

- Protocol: `LOCATE_PATH`, `LOCATE_PORTS`, `LOCATE_HOST`, `ENDPOINT_FILE`,
  `DISCOVERY_APP`, `isInstanceId()`, and `instanceId` in `/ext/anno/health`;
  copied to both consumers like every other constant.
- Host: an endpoint record at `$DSH_HOME/ext-bridge-endpoint.json` (address
  only, atomic, `0600` on POSIX, removed on clean shutdown) and a loopback
  locator on `30810–30812` that answers one GET with the origin — neither
  carries the token. The locator starts when the bound port is not `3080`, the
  bind address is IPv4 loopback, and config `discovery` is not `off`; the record
  is written in every case.
- `scripts/smoke-discovery.mjs`: record shape and permissions, absence of any
  token in the record or the locator, locator answer, `instanceId` agreement
  with health, and refusal of a foreign `Host`.
- Unit tests: `packages/plugin/test/discovery.test.js` (record, atomic write,
  permissions, removal, trigger matrix) and
  `packages/plugin/test/locator.test.js` (response rules, port fallback,
  disposal).

**Acceptance criteria (a):**

- A host on `--port 0` writes a record containing the bound port and starts a
  locator on `30810`; a default host on `3080` starts no locator and still
  writes the record.
- The locator answers only `GET /ext/anno/locate`, refuses a foreign `Host`
  with `403`, sends no `access-control-allow-origin`, and returns no field that
  contains the token.
- Neither the record nor the locator answer contains a 64-hex token; the token
  file remains the only host-side copy.
- `pnpm run check` and `smoke-ws.mjs` stay green.

### M4.5b — Extension discovers

**Status:** implemented; the browser-side acceptance below still needs a real
Firefox session (M4.5c).

- Extension: a `connection` preference (`auto` for fresh installs, `manual` for
  existing ones), the resolution chain (stored address → one round of locator
  ports plus the default port → nothing), candidate ranking by preferred
  instance, last instance, focus time, and start time, an `instanceId` check
  against health, and popup support: the mode switch, the address-only
  endpoint-file import, the discovered-hosts list, and the discovery status
  line. The token field and its single-source handling are untouched.
- `packages/extension/src/background/discovery.js` (pure: parsing, ranking,
  one round over an injected `request`) and `test/discovery.test.js`;
  `boot.test.js` boots the whole background with a stubbed locator, health, and
  socket and covers the chain, the cached fast path, the no-host message, the
  id-mismatch drop, the fresh-install default, and the popup's scan message.

**Acceptance criteria (b):**

- With a token already pasted, restarting the host twice on new ports reconnects
  the extension within 10 s with no user action.
- Two live hosts: the popup lists both, the most recently focused one wins when
  nothing is preferred, and **Use this host** survives an extension reload.
- Manual mode is unchanged (the existing `endpoints` tests pass without edits,
  and the manual-mode boot case still probes only the configured address); an
  unreachable host shows the token-file hint instead of a bare timeout.

### M4.5c — Verification and documentation

**Status:** planned.

- README (`Desktop` section, security model, data table), `DETAIL.md`, and the
  roadmap row; the Windows and Linux checklist in
  [DISCOVERY.md](DISCOVERY.md#13-testing); a real Desktop run on at least one
  platform.

## M4.6 — Send an annotation into a new session

**Goal:** the target picker's second arm — "this annotation starts a new
conversation" — with the workspace chosen at send time: the default workspace,
an existing one, or a brand-new directory. Design: [INTERACTION.md](INTERACTION.md)
(decision D25).

**Deliverables**

- Protocol: `SESSION_CREATE_PATH`, `SESSION_CREATE_MODES`,
  `validateSessionCreateRequest`, and workspace body limits; synced copies, no
  frame or record shape change (`PROTOCOL_VERSION` stays).
- Host: `packages/plugin/src/provision.js` — a provisioner over
  `sessionController.create` and `workspaceRegistry` (list, idempotent create),
  plus the token-gated POST route; `/ext/anno/sessions` gains a `workspaces`
  array; `{t:'session', sessionId}` on the event stream after a create.
- Client: the page follows a created session when the build exposes a
  selection hook; otherwise the queued chip waits for the user to open it.
- Extension: `anno.session.create` message; the picker's pinned
  **＋ 新建会话** row (disabled offline) with the workspace sub-panel; the
  composer creates the session at send time, before submitting the annotation.
- Tests: `packages/plugin/test/provision.test.js` (modes, token gate, body
  validation, failure reporting), protocol validator cases, and the message
  contract test.

**Acceptance criteria**

- Choosing 新建会话 → an existing workspace and sending: the Host creates the
  Session (or reuses the blank one), the annotation routes to it, the chip
  lands in that Session's composer, and the GUI switches to it when the
  navigation hook is available.
- 新建工作区 with an absolute path creates the directories, registers the
  workspace, and the new Session joins it; repeating the same path resolves to
  the same workspace.
- Offline, the ＋ row is disabled with an explanation; creation failures show
  the Host's message in the composer and never lose the written comment.
- `pnpm run check` stays green.

## M4.7 — The new workspace's path is chosen, not typed

**Goal:** the 新建工作区 arm of the target picker stops asking for a
hand-typed absolute path — the picker offers locations to click, and the only
typed part is the new folder's name. A browser-side file picker cannot
provide the path (Chromium exposes no absolute path from any picker; Firefox's
`mozFullPath` is a non-standard privileged leftover; and a deployment can put
the Host on another machine, where the browser's filesystem is the wrong
namespace), so the choice is assembled from paths the picker already holds
and, later, from a Host-served directory listing. Design:
[DECISIONS.md](DECISIONS.md) (decision D26). Two stages, each independently
shippable: (a) changes the extension alone and works against every Host ever
released — a pre-M4.6 Host simply keeps the manual input; (b) is additive on
the Host and degrades to (a) exactly.

### M4.7a — Anchors from what the picker already holds

**Status:** implemented; browser QA pending.

**Deliverables**

- Extension only — no protocol file, no background message, no Host route.
  In the workspace sub-panel, the absolute-path input is demoted to an
  "advanced" fallback; the primary flow picks one anchor row — each
  registered workspace's path and its parent directory, deduplicated, in the
  registry's order — then optionally names the new folder. An empty name
  targets the anchor directory itself, so promoting an existing directory to
  a workspace needs no typing at all.
- The absolute path is joined in the content script using the anchor's own
  separator (drive roots included), so the `anno.session.create` message is
  byte-for-byte what M4.6 already sends; registration and idempotence on the
  Host are untouched.
- Anchors come from the `workspaces[]` array `/ext/anno/sessions` already
  returns. A fresh install is not stranded: DSH registers the default
  workspace on first run. The manual input stays for remote hosts and the
  pre-first-run corner.
- Strings (both locales), styles, and tests: anchor rendering, dedupe,
  separator join, the demoted manual path, i18n parity.

**Acceptance criteria (a):**

- Choosing 新建工作区 lists anchor rows; picking one and naming a folder
  sends an absolute path the Host registers or creates exactly as M4.6 did,
  with no new wire traffic of any kind.
- A Host old enough to predate M4.6 (no `workspaces[]`) still offers the
  manual path input; no other picker behaviour changes.
- `pnpm run check` stays green.

### M4.7b — Host-served directory browsing

**Status:** planned.

**Deliverables**

- Protocol: `DIRS_PATH = '/ext/anno/dirs'`, `LIMITS.fsEntries`, and the
  absolute-path rule extracted out of `validateSessionCreateRequest` and
  shared, not duplicated; synced copies; no frame or record shape change
  (`PROTOCOL_VERSION` stays 1 — the D25 argument).
- Host: `packages/plugin/src/dirs.js` — one directory level per request:
  `readdir` with `withFileTypes`, directories only, symlinks skipped,
  case-insensitive sort, bounded by `LIMITS.fsEntries` with a `truncated`
  flag. An empty `path` answers the roots view: the Host's home plus drive
  roots on win32 (or `/`). Filesystem access and `homedir` are injected so
  tests stay deterministic and cross-platform. Route: GET/HEAD/OPTIONS,
  token-gated exactly like the catalog, same CORS posture.
- Extension: one `anno.fs.dirs` background message (token in the header, path
  in the query — never the reverse); the M4.7a widget upgrades to real
  browsing — landing at the newest workspace's parent or the home answer,
  rows descend, one Up affordance climbs to the roots view. Any non-OK
  answer (404 from an older Host included) falls back to the M4.7a anchors;
  capability never drops below stage (a) in the same build.
- Documentation: INTERACTION.md's target-picker section, README security
  model and architecture route list, `DETAIL.md`, and this roadmap row.
- Tests: route token gate, roots answer, directories-only filtering,
  truncation, unreadable-directory error mapping (plugin); validator cases
  (protocol); message mirror (extension); browse render and fallback branch
  (content harness).

**Acceptance criteria (b):**

- With both halves current, 新建工作区 browses the Host's real directories
  from home or a drive root down, needs no typed path, and an unreadable
  folder shows the Host's message inline without losing the comment.
- The route refuses anonymous requests, never lists files, and bounds every
  answer; against an older Host the same extension build keeps the anchor
  flow working end to end.
- `pnpm run check` stays green.

## M5 — Signing and distribution

**Goal:** a normal user can install both halves and upgrade them safely.

**Deliverables**

- Signed Firefox extension (`.xpi`) via Mozilla Add-ons and a Chrome Web Store
  listing; unsigned `web-ext`/zip artifacts rebuilt from the tag with checksums.
- Release workflow: tag, test, package, draft release, changelog, and publishing
  to npm, AMO, and CWS; prereleases stay off the stores (D16).
- Install and upgrade documentation, compatibility matrix (Firefox/Zen,
  Chromium, and DSH versions), and a privacy note (no data leaves the machine).
- Protocol migration: version bump policy, compatibility window, and data
  migration for `queue.jsonl` if the record shape changes.

**Acceptance criteria**

- A signed extension installs permanently in Firefox and Zen without
  developer mode.
- A fresh machine can follow the README from clone to first annotation in
  under ten minutes.
- Unsigned release artifacts are reproducible from a tag with published
  checksums, and CI verifies the tag's tests before publishing; the signed XPI
  is identified by its AMO version and signing hash.
- Install and upgrade paths need no registry access beyond the published
  package sources, and the plugin remains installable offline from a checkout.

The distribution design behind these criteria — target matrix, CI shape, store
APIs, and the decisions D14–D16 — is in [DISTRIBUTION.md](DISTRIBUTION.md).
