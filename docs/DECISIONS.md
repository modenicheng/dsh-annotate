# Decisions

Short records of choices that shape the repository. Each one lists the force
behind it and the cost we accept.

## D1 — Plain ESM JavaScript, no build step

**Decision.** Both the DSH bundle and the extension are hand-written ESM
JavaScript loaded as-is. Types are expressed in JSDoc where they earn their
keep; there is no TypeScript, bundler, or transpile stage.

**Why.** The two runtime hosts load raw files: DSH pulls the bundle from a
profile directory and Firefox loads the extension from disk in
`about:debugging`. A build step would add a second copy of every source file, a
watch loop during development, and a way for the committed code to drift from
what actually runs. It would also make the extension impossible to debug from
the browser's own source view without source maps.

**Consequences.** No compile-time type checking; the protocol tests and
`node --check` are the safety net. Refactors that a type checker would catch
must be covered by tests. JSDoc `@type`/`@typedef` annotations are used
liberally, and the linter disables `noExplicitAny` (the code interacts with
untyped DSH host APIs) and `noAssignInExpressions` (the content-script
namespace bootstrap intentionally assigns inside an expression).

## D2 — The host plugin depends on `ws` for the websocket server

**Decision.** `packages/plugin` declares `ws` as its only runtime dependency and
mounts `new WebSocketServer({ noServer: true })` on the DSH host webserver. The
earlier hand-written RFC 6455 implementation in `src/ws.js` was deleted.

**Why.** The first version of this decision was "stay dependency-free so a
profile install works without a registry". That premise was wrong: it was based
on a failed `Invoke-WebRequest` probe of the registry, while `pnpm add ws` in the
same session succeeded — the probe measured .NET's TLS stack, not pnpm's. Once
the offline argument fell, the remaining trade-off is one of correctness against
convenience, and protocol parsers are the wrong place to be original. `ws`
handles UTF-8 validation with the mandatory 1007 close, control-frame size
limits, the close handshake, backpressure, and permessage-deflate; the
hand-written version handled none of those properly.

**Consequences.** Installing the bundle now needs the registry reachable once, and
`link:`-based development needs `pnpm install` in the workspace so the linked
package can resolve `ws`. In exchange the bridge stops owning a protocol parser.
`scripts/smoke-ws.mjs` still exercises the live socket end to end, and the bridge
tests drive a real `ws://` connection rather than a stub.

## D3 — The protocol is one file copied by a script

**Decision.** `packages/protocol/src/index.js` is copied verbatim into
`packages/plugin/src/protocol.js` and
`packages/extension/src/shared/protocol.js` by `scripts/sync-protocol.mjs`. The
copies are committed and checked by `scripts/check-sync.mjs` in CI and the
pre-commit hook.

**Why.** A DSH profile is a separate pnpm workspace, and the extension is loaded
by Firefox with no resolver at all. A workspace dependency would have to be
packed, linked, or installed in both places, and any failure would show up as a
runtime import error in the browser. Copying one dependency-free file makes the
protocol available everywhere the code already is, keeps both sides on exactly
the same version, and works from a fresh clone with no install.

**Consequences.** Generated files exist in git and must never be edited
directly. Forgetting `pnpm run sync-protocol` fails CI with a line-numbered
diff instead of shipping skew. The protocol cannot import anything, including
Node built-ins, because the extension also loads it.

## D4 — Timestamps are ISO-8601 strings

**Decision.** Record timestamps that cross the wire (`createdAt`, `updatedAt`)
are ISO-8601 strings in UTC, produced with `Date.prototype.toISOString()`. The
append-only event log additionally carries a monotonic `seq` for delivery
ordering.

**Why.** ISO strings are JSON-native, unambiguous about timezone, sort
lexicographically, and stay readable in the append-only log when a user debugs
it by hand. Epoch milliseconds would save a few bytes but turn every log line
into a number to decode, and numeric timestamps invite comparing clocks across
machines where only ordering within one store matters.

**Consequences.** Parsing is explicit (`Date.parse`) and validation rejects
unparseable values. Listing sorts the ISO strings lexicographically, which works
because `normalizeRecord` generates UTC strings with fixed precision; a
client-supplied timestamp is only checked for parseability, so sorting imported
records is best-effort. The one legacy exception is `resolution.resolvedAt`,
which still stores epoch milliseconds; it is display metadata, not the record's
canonical timestamp, and moves to ISO when the resolution shape is revised.

## D5 — Development runs in an isolated `anno` DSH profile

**Decision.** Development and manual testing use a dedicated DSH profile named
`anno`, created from the shipped Web template, rather than the user's daily
`web` profile.

**Why.** The plugin mounts a websocket on the host webserver, writes to
`$DSH_HOME/annotations`, and can be toggled many times an hour. Doing that in
the daily profile risks interrupting real sessions, polluting the annotation
queue with test data, and making "is this a plugin bug or my profile?" hard to
answer. A disposable profile can be reset from the template at any time.

**Consequences.** Contributors need one extra profile on disk. The bridge token
and annotation log live under `$DSH_HOME`, not the profile directory, so they
are shared between profiles; only one profile should run the bridge at a time.
A fresh profile is initialised with `dsh --profile anno
--from-default-profile web`.

## D6 — Local hooks instead of Husky and commitlint

**Decision.** Conventional Commits are enforced by `.githooks/commit-msg` and
checked by `.githooks/pre-commit`, enabled with
`git config core.hooksPath .githooks`. No hook framework is installed.

**Why.** The repository has no third-party dependencies by design. Husky and
commitlint would require an install before a contributor can make a first
commit, which contradicts the offline-first goal and adds a toolchain for
twenty lines of shell. `core.hooksPath` is built into Git and works the same in
Git Bash on Windows.

**Consequences.** Each clone runs one documented command to enable the hooks;
Git never enables them automatically. The scripts are POSIX `sh` and keep LF
endings via `.gitattributes`. Contributors who skip the setup still get the
same checks in CI.

## D7 — Biome is pinned and fetched with `npx`

**Decision.** Formatting and linting use Biome at one exact version
(`2.4.14`), invoked as `npx --yes @biomejs/biome@2.4.14` from the root
scripts and CI. No devDependency and no lockfile are added.

**Why.** The workspace has no dependency graph to install or audit, and adding
one solely for a formatter would re-create the registry dependency this project
avoids. Pinning the exact version keeps the formatter's output stable across
machines and prevents a silent style churn from a floating `latest`.

**Consequences.** Format and lint commands need network access the first time
the pinned package is not cached; tests, hooks, and the plugin never do. Bump
the pin in both `package.json` and `.github/workflows/ci.yml` together.

## D8 — The host advertises its scheme; the extension does not guess

**Decision.** `/ext/anno/health` reports `secure` (boolean) and a complete
`wsUrl` (`ws://…` or `wss://…`), computed from the serving socket
(`request.socket.encrypted`), the DSH webserver listener (`protocol` /
`getOrigin()`), or a TLS-terminating reverse proxy (`x-forwarded-proto`, first
value, with `x-forwarded-host` / `Host` for the authority). The extension probes
that endpoint before opening a socket, connects to the advertised URL when it
names the configured host, and falls back to the address saved in the popup when
the probe fails. A scheme typed into the popup (`wss://anno.example.com`) is an
explicit override of the probe, not the normal path.

**Why.** This serves deployments where the bridge is genuinely behind TLS: `dsh
web` with `tls` configured, or a TLS-terminating proxy in front of a plain
listener. Those need `wss://`, while the default local install — `dsh web` on
`127.0.0.1`, no TLS anywhere — must stay on `ws://`. Nothing in the browser can
tell the two apart from a port number: `wss://` against a plain listener and
`ws://` against a TLS one fail the same way, and the console gives no clue which
side is wrong. The host is the only party that knows, so it says it once.

This decision is deliberately *not* the fix for the reported "everything works
except the socket" bug: that was the MV3 default extension CSP upgrading our
`ws://` to `wss://` (D9), which no backend change can repair. Keeping the
negotiation means a real HTTPS deployment works as well.

**Consequences.** Health is now a small public contract: it must stay readable
cross-origin (`access-control-allow-origin: *`), and it reveals the advertised
scheme and URL but still no annotation content. The extension probes `http`
first and only tries `https` when that does not answer, so the default local path
costs one request and never sends a TLS ClientHello to a plain listener. The
answer is cached for ten minutes and invalidated on a failed upgrade, so a host
that switches from plain HTTP to TLS is noticed on the next retry instead of
after the TTL. A reverse proxy must forward the `Upgrade`/`Connection` headers
for `/ext/anno` and set `X-Forwarded-Proto`; without the header the host can only
advertise `ws://`. The manifest needs both schemes and both loopback origins over
HTTPS (so the probe itself is allowed), and reading `x-forwarded-host` means the
health URL follows the client's `Host` header — the extension refuses an
advertised authority that differs from the configured one instead of following
it.

## D9 — The extension declares its own CSP, without `upgrade-insecure-requests`

**Decision.** `packages/extension/manifest.json` declares
`content_security_policy.extension_pages` as
`script-src 'self'; object-src 'self'` instead of inheriting Firefox's MV3
default (`script-src 'self'; upgrade-insecure-requests;`).
`scripts/check-manifest.mjs` fails when the policy is absent or contains
`upgrade-insecure-requests`.

**Why.** This is the root cause of the reported bug. The MV3 default
`upgrade-insecure-requests` rewrites every insecure request the extension makes —
including the bridge's `ws://` and its `http://` health probe — into `wss://` and
`https://`. A plain local host cannot answer either, so the socket never opens
and Firefox prints a CSP message saying the request was upgraded. The failure
looks like a backend/TLS problem, which is what made earlier hypotheses
(HTTPS-Only mode, a missing TLS listener, page CSP) plausible; the actual defect
is one manifest directive. Extensions that "just work" locally either declare
their own policy or are still MV2, whose default does not upgrade requests.

**Consequences.** The extension page CSP is now an explicit, tested part of the
manifest instead of an implicit Firefox default. `script-src 'self'` is kept (and
must not be loosened to `unsafe-eval`/remote code: MV3 rejects it and it would be
its own security bug); only the upgrade directive is dropped, because it is the
one that breaks loopback plaintext. Any future need for `upgrade-insecure-requests`
would have to explain why the bridge no longer talks to a plain local host. The
regression check lives in the manifest job, and the extension boot test pins the
resulting behaviour: with a plain address the health probe goes to `http://` and
the socket URL is `ws://`.

**Verified.** Confirmed in a real browser on 2026-11-18 — Firefox 159.0, the
extension loaded as a temporary add-on from `about:debugging`. With the explicit
policy in place the bridge reaches a plain `dsh web` over `ws://127.0.0.1:…/ext/anno`,
the token handshake completes, and the console no longer prints the "Upgrading
insecure request … to use wss" message. Both gate branches were also exercised by
hand: removing the policy and injecting `upgrade-insecure-requests` each fail
`check-manifest`, and restoring the policy passes it.

## D10 — The mark is the annotation; the comment is optional

**Decision.** An annotation may be sent with an empty comment. The composer's
send button is always enabled; while the textarea is empty it reads **只发标记**
(`Send mark`) so the action describes itself, and it reverts to **发送** as soon
as the user types. An empty submit produces a normal record with `comment: ''` —
the same shape the protocol already validates, with the anchor, page context, and
crop carrying the payload.

**Why.** Half the value of this bridge is "look at this, right here": a selection,
element, or region is already a complete, self-contained pointer, and a user who
has to invent a sentence before sending one will often send nothing. The comment
adds a request on top of the pointer; it is not a precondition for it. Gating
submit on text also turned the pick flow — where words are irrelevant — into a
special case inside the UI, which is a hint that the gate sat in the wrong place.

**Consequences.** Nothing downstream may assume `comment` is non-empty. The
agent-facing envelope prints `comment: (empty)` instead of a blank line, the badge
card falls back to summarising the anchor, and the popup keeps previewing the
anchor (it already renders a comment only when there is one). The completion
toast differs — **已发送标记（无评论）** versus **已发送批注** — so an empty send
is confirmed rather than silent. The future `dsh-anno:` mention label must also
degrade to `@[批注 · 那段话](…)` with no comment fragment.

## D11 — A `dsh-anno:` mention is resolved, never rewritten

**Decision.** The `agent/pre-step` handler in `packages/plugin/src/mentions.js`
leaves the user's message text untouched and only inserts one extra
`source.kind = 'annotations'` message after it. The mention keeps its canonical
spelling in the transcript.

**Why.** The obvious move is to copy `session-reference`, which rewrites its
mention into readable `@label` text before the model sees it. That is wrong here,
for two reasons found by running it. First, pre-step output is **durable**: the
rewritten text and the context message both appear as `user/message` events in
the session log, so a rewrite does not stay in the model's view — it replaces
what the Client renders. The chip rule matches the wire form `@[…](dsh-anno:…)`,
so rewriting it deletes the chip: the message went back to reading
`测试 @批注 · "Enterprise"`, and the file-reference rule claimed `@批注` instead.
Second, the reason `session-reference` rewrites at all is that its URI is a long
base64 blob; a `dsh-anno:an-20261118-ab12cd` URI is short and readable, so the
model loses nothing by seeing it.

**Consequences.** The durable transcript stays exactly as the user wrote it, and
the Client can render it again after any reload. The model sees both the mention
and the structured annotation, which is redundant on purpose: the mention marks
*where* the citation sits, the context message carries *what* it was. Anything
that later wants the readable form in the transcript would have to change what
the chip rule matches, not what pre-step returns. Recorded after confirming in a
live Web Client that a rewrite silently costs the chip and that the context
message itself does reach the model (D10's `annotations` round trip).

## D12 — A cross-Session mention waits in a durable queue, and never auto-sends

**Decision.** When an annotation carries `routing.sessionId`, the Host stores its
mention in `$DSH_HOME/annotations/pending-mentions.json`. The Web Client polls
`GET /ext/anno/queue?all=1` and appends each entry to the target Session's
composer with `requestDraftInitialization(binding, {whenDraftExists: 'append'})`,
then acknowledges with `POST /ext/anno/queue/ack`. Nothing is sent; the user
decides when the message leaves.

**Why.** Three mechanisms were possible and two are wrong. The Host cannot write
a draft (drafts live in the browser), and sending a message on the user's behalf
would start a turn they did not ask for and could not review — the whole point of
a chip is that it is visible and removable before it counts. Queueing keeps the
browser and the Host in their own lanes: the extension posts an annotation, the
Client adopts it when the Session is in front of the user.

**Consequences.** The queue is durable, capped at 50 entries, idempotent by
annotation id, and pruned of entries whose annotation was deleted. The queue
routes cannot be gated by the bridge token: the page is a different trust anchor,
and handing the GUI the extension's token would be worse than the exposure. They
are gated by `Sec-Fetch-Site: same-origin` instead, which a cross-site request
cannot forge, and both routes are `no-store`. A page that omits the header gets
an honest 403 rather than a guess. The Client poll is a 4 s interval plus
`visibilitychange`; an entry for a Session that is not retained simply waits.

## D13 — The queue's client reader cannot reach a composer through `sessions.binding`/`scope`

**Finding (2026-11-19).** `ctx.sessions.binding(id)` and `ctx.sessions.scope(id)`
both return `undefined` for a Session that is displayed in the Client, so the
first delivery path — `requestDraftInitialization(binding, {whenDraftExists:
'append'})` or `uiConversation.input.for(scope).insertReference(...)` — never
runs. Verified by tracing the reader's own branch into a DOM attribute
(`data-dsh-anno-trace`) after the module realm's console proved invisible to the
page console: the recorded reason is `wait-no-scope` with the target Session open
and its title in the header.

**Consequence.** Delivery is implemented and queued correctly host-side, but does
not land in the composer yet. The remaining seam is a Session-scope Slot
component (`conversation.composer.dock`), whose props carry `sessionId` and whose
input actions are the documented face for programmatic editing — the same
mechanism the built-in QueueDock uses. That is the next step; the polling,
queue, routes, ack, and the picker's data path are all already verified
independently of it.

**Superseded by D17.** The seam is that Slot component, and the write is not the
text append this record assumed.

## D14 — The extension targets Chromium and Gecko; WebKit is out of scope

**Decision.** The browser extension supports Chromium and Gecko. Safari is not a
target: no App Store listing, no Xcode project, no macOS runner, and no
WebKit-specific branch in the release pipeline.

**Why.** WebKit's cost is the delivery model, not the port. The extension must
ship inside a native container app built with Xcode, every release re-enters App
Store review, and outside the Mac App Store the install still requires Safari's
"allow unsigned extensions" developer toggle. That is US$99/year plus a review
calendar per release, for the smallest of the three audiences. iOS is impossible
independently: the bridge is loopback-only, so a phone cannot reach the host, and
iOS suspends the background worker that owns the socket. Porting would be days
rather than weeks (`background.scripts` works in Safari 14+), which is exactly
why the decision has to be about distribution rather than capability.

**Consequences.** "All mainstream browser engines" becomes "Chromium and Gecko"
in the README, the store listings, and the compatibility matrix; Safari becomes
a documented non-goal so nobody waits for it. The release pipeline builds two
extension targets, and the platform seam is designed for two engines instead of
being generalized for three. Revisiting requires someone to fund the Apple
account and the per-release review time, and would be its own track.

## D15 — A connection is negotiated by protocol version only

**Decision.** The bridge accepts or rejects a connection on the protocol version
alone. It never compares product versions — neither the extension's manifest
version nor the plugin's package version — in either direction. `hello` carries
`{ token, protocol }`; the host accepts
`MIN_PROTOCOL ≤ protocol ≤ PROTOCOL_VERSION`; `/ext/anno/health` advertises both
bounds plus `caps`; differences inside the window are negotiated with `caps`.

**Why.** The halves are released on different clocks: the DSH bundle updates
through npm in seconds, while the extension waits for store review, which can
take days. An exact-match check turns that delay into an outage for every
already-installed extension, which is what `bridge.js` did. Product versions
name releases; using them as a compatibility signal tied an install artifact to
a runtime contract that changes on a different schedule.

**Consequences.** `PROTOCOL_VERSION` and the new `MIN_PROTOCOL_VERSION` are
protocol constants, copied into both consumers like everything else and bumped
only when the wire changes. Keeping the previous version accepted is a standing
obligation: dropping it is an announced decision, not a release side effect.
`engines.dsh` stays, but as an install-time admission check in package metadata;
it never reaches the socket.

## D16 — Prereleases are not published to a store

**Decision.** No prerelease version goes to any store. Stores receive finals
only, `MAJOR.MINOR.PATCH` with an integer manifest version. Prereleases are
GitHub pre-releases that users install themselves: an unpacked directory for
Chromium, and for Firefox either a temporary add-on or a signed build under a
separate beta add-on ID.

**Why.** Chrome's version format is one to four dot-separated integers, so
`0.2.0-rc.1` cannot be installed at all — and a prerelease numbered `0.2.0.1`
sorts after `0.2.0`. AMO keeps a monotonic version sequence per add-on ID, so
that same prerelease would permanently outrank the final release for that ID.
Both are properties of the stores rather than of the release tooling, and both
make "just publish the rc" impossible.

**Consequences.** Two channels with two identities: the release ID, a
`…-beta@…` ID whose version sequence is independent, and an unpacked Chromium
build that has no identity at all. Beta artifacts are built from the same tag as
the final, so the difference is publication, never code. The documentation must
state that a prerelease install is manual and, on Firefox, temporary unless the
beta build is signed.

## D17 — A mention reaches the composer as a reference chip, written from that Session's own dock

**Decision.** The Web Client's half becomes one Session-scope Slot component
(`conversation.input.dock`, entry id `dsh-anno-queue`). It is mounted only for
the Session the user is looking at, it pulls `GET /ext/anno/queue?session=<id>`,
and it writes the whole document through `inputActions.setDraft({ text,
references })`. Each queued mention joins `references` as
`{ source: 'reference', ref: <mention>, clipboardText: <mention>, offset, length,
label }`, appended after the last line of whatever the draft already holds. The
`?all=1` fan-out and its `requestDraftInitialization` / `insertReference` paths
are gone.

**Why.** A composer is a Lexical editor, and a chip is a `ReferenceChipNode`
decorator — not text. Appending the mention as text (what D12 described) puts
`@[批注 · "…"](dsh-anno:…)` on screen as raw characters: the user cannot see what
they are about to send, which is the one thing a chip exists to prevent.
`setDraft` is the only plugin-facing write that rebuilds decorators, because it
is the same call the composer uses to restore a persisted draft. Its declared
type is `string`, but its implementation takes `DraftInput` — `resolveDraftInput`
routes a structured snapshot to `restoreDraft`, which constructs the chip nodes.
That is a type-level narrowing of a real capability, so it is recorded here
rather than hidden: if a future release drops it, this is the line to re-verify.

**Why that source name.** Submit serializes every chip through the codec of the
`@` source that owns it and *refuses the message* when no owner registers that
name (`serializeReference` → "no serializer for reference source"). Registering
one of our own would put a second entry in the `@` menu; using the product's
`reference` source costs nothing, because its codec is the identity: the sent
text is exactly the mention, which is what the transcript renders back into a
chip and what the Host parses at `agent/pre-step`. The chip carries no
`appearance`, so the composer draws its `@` marker instead of a file or session
icon — an annotation is neither, and the marker keeps the shipped glyph set
untouched (D9's reasoning about not inventing product chrome).

**Consequences.** Delivery happens when the Session opens, which is the moment
the mention becomes visible and removable — the queue is not a backlog, and a
Session the user is not looking at is never written. A composer that is busy
(`phase !== 'plain'`) or holding a command claim, whose chip is not part of
`references`, is left alone and retried on the next poll; a mention the draft
already carries is acknowledged rather than inserted twice, so a lost
acknowledgement repairs itself instead of duplicating. The write replaces the
document, so the caret lands at the end of it — acceptable because appending is
the only thing being asked for, and because it happens on mount rather than
during typing.

**Verified** on a live `dsh web` (3099): a routed annotation produced
``@ 批注 · “chip delivery”`` in the editor as one atomic chip, sending it put the
canonical mention in the message, the transcript drew it with the region glyph,
and the model answered with the annotation's page, quote, intent, and comment —
so the chip, the wire form, and the Host context all agree.

## D18 — The Host routes an untargeted annotation to the Session the Client says it is showing

**Decision.** The Client half reports the Session it is showing with
`POST /ext/anno/focus` (body `{sessionId}`), which is what mounting
`conversation.input.dock` means: that Session's own dock. The Host keeps the
report durably in `$DSH_HOME/annotations/focus.json` with the moment it was made,
and uses it twice:

1. `GET /ext/anno/sessions` answers `defaultSessionId` with the focused Session
   while that Session is still listed, and only falls back to the most recently
   active one when it is not.
2. An annotation that arrives with no `routing.sessionId` adopts the focused
   Session at `onCreated`, the record is patched so the stored annotation says
   where it went, and the mention is queued for it.

A report older than six hours is discarded, and an annotation with
`routing.source: 'agent'` never adopts it: neither is the user pointing at their
own page.

**Why.** D12 and D17 fixed *how* a mention reaches a composer but not *which*
Session it belongs to, and that gap is what a user hits: the overlay's default
came from the catalog ordered by activity, and the most recently active Session
is frequently not the one on screen (it may belong to another profile entirely).
An annotation submitted without touching the picker was stored with
`routing: {source: 'user'}` and never queued at all — the user marked a page,
sent, and nothing appeared anywhere. Routing the untargeted case is also what
makes an annotation from an older overlay, or one whose catalog request failed,
still arrive: the decision no longer depends on the overlay having succeeded.

**Why the Client owns the fact.** Browser focus is not visible to the Host and
not visible to the extension either. The Client is the only participant that
knows which conversation is on screen, and its dock mounting *is* that knowledge —
so the report costs one `POST` per mount and needs no extra Slot.

**Consequences.** Two tabs of the same Session each hold their own draft, so a
delivery must not be consumed by a background tab: the dock skips its pull (and
its focus report) while `document.visibilityState === 'hidden'`. The report is a
hint rather than authority — a stale one loses to nothing, and a name the catalog
does not list loses to activity — so a deleted or filtered-out Session can never
become the default. `?all=1` on the queue route is gone: a Session-addressed pull
is the only reader, and a fan-out has no composer to write into.

**Verified** on a live `dsh web` (3099): with the window showing `Greeting`, a
create with `routing: {source: 'user'}` and no session id was patched to
`session-0c40e529…`, queued, and delivered into that composer as a chip;
`/ext/anno/sessions` answered `defaultSessionId` with the same id while the most
recently active Session was a different one.

## D19 — The chip's hover card reads one annotation back from the Host, and every field is the click-time snapshot

**Decision.** Hovering a cited annotation opens the product's own `HoverCard`
primitive (`require('@deepseek-ai/dsh-client-ui-primitives')`) around the chip,
in its `inline` layout, and the card's body is read on demand from
`GET /ext/anno/item?id=<id>`; the crop comes from `GET /ext/anno/image?id=<id>`,
which streams the stored attachment bytes. Both routes are same-origin only, like
the queue. The projection they serve is `describeAnnotation` in
`packages/plugin/src/presentation.js`: page title and URL, the quote or the
element (tag, text, role, name, a few styles), the comment, intent, state, time,
and the crop's size. Reads are cached per page, so a card is fetched once.

The annotation also gained `snapshot: {at, rect, viewport}`: the overlay freezes
the viewport, the scroll offset, and the crop rect at the moment of the click, and
the *record* carries them. `cropRectFor` now returns that frozen rect instead of
re-measuring the live element at submit time.

**Why the primitive.** `HoverCard` is the exact interaction an official reference
gets — 500 ms open delay with a shared "warm" group, a bridge so the pointer can
travel into the card, Escape, a `document.body` portal, and viewport-aware
placement with flip — and it is already wrapped around user text by
`UserText`'s `HoverCardGroup`, so our chip joins the same group instead of
inventing a second hover model. The `require` is guarded: a release that renames
the module leaves the chip working with the mention as its `title` tooltip, and
`data-dsh-anno-hovercard` on the document element says which case is live.

**Why a read route rather than the mention text.** A chip only knows its id and
label; the transcript may be months old and the record lives in the Host's log.
Putting the payload in the mention would rewrite what the model reads (D11) and
would still be stale the moment the comment is edited. The queue entry therefore
stays `{id, mention, label}` and the card asks for the record it needs.

**Why the snapshot.** The card, the label, and the crop all describe one instant.
Re-reading the page at submit time — the previous behaviour for the crop — let a
scroll between the click and the send move the screenshot off the anchor, so the
screenshot and the quote silently described two different moments. A frozen frame
also survives the element being replaced, which is the common case on any page
that re-renders.

**Consequences.** The composer's own chip is the product's `ReferenceChipNode`
with `title={label}` and only three accepted `appearance` values; there is no
seam for a custom glyph or a hover hook, so the card exists on the transcript
chip and the composer chip keeps the shipped marker (D17). An annotation from a
build before this one has no `snapshot`; the card then shows the record's
`createdAt` and the crop the Host stored, and nothing is invented to fill the
gap.

**Verified** on a live `dsh web` (3099): hovering the transcript chip opened the
portalled card with the stored crop (`/ext/anno/image?id=…` served the PNG), the
page title, `127.0.0.1:3099/`, the quote, the comment, and
`bug · open · 11/19 19:32 · 截图 57 KB`; the routes answered 403 without
`sec-fetch-site: same-origin`.