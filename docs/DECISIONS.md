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
