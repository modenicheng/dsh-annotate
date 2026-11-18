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

- Installable `dsh-annotate` bundle: `package.json` metadata, patch, locale
  resources, icon, detail document.
- Token file under `$DSH_HOME` with owner-only permissions, constant-time
  comparison, hello deadline, protocol version check.
- RFC 6455 websocket server (`ws`, `noServer`) mounted on the DSH host webserver at
  `/ext/anno`, plus `/ext/anno/health`; ping/pong heartbeat and clean shutdown.
- Append-only JSONL store with in-memory fold, torn-line tolerance, idempotent
  creates, and compaction; screenshots stored through DSH's attachment service.
- Tools `annotate_list`, `annotate_get`, `annotate_resolve`, `annotate_clear`
  with JSON Schema output and renderers. The host-side `annotate_pick` core
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

## M5 — Signing and distribution

**Goal:** a normal user can install both halves and upgrade them safely.

**Deliverables**

- Signed extension (`.xpi`) via Mozilla Add-ons; reproducible `web-ext build`
  artifacts and checksums.
- Release workflow: tag, test, package, sign, publish artifacts, changelog.
- Install and upgrade documentation, compatibility matrix (Firefox/Zen/DSH
  versions), and a privacy note (no data leaves the machine).
- Protocol migration: version bump policy, compatibility window, and data
  migration for `queue.jsonl` if the record shape changes.

**Acceptance criteria**

- A signed extension installs permanently in Firefox and Zen without
  developer mode.
- A fresh machine can follow the README from clone to first annotation in
  under ten minutes.
- Release artifacts are reproducible from a tag, and CI verifies the tag's
  tests before publishing.
- Install and upgrade paths need no registry access beyond the published
  package sources, and the plugin remains installable offline from a checkout.
