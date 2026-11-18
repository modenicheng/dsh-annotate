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

## D2 — Zero runtime dependencies in the host plugin

**Decision.** `packages/plugin` declares no `dependencies`. The websocket server
is a small RFC 6455 implementation in `src/ws.js` instead of the `ws` package.

**Why.** DSH installs bundles into a profile's own pnpm workspace. That install
must keep working when the npm registry is unreachable — an offline machine, a
locked-down network, or npm itself being down — because the bridge is exactly
the kind of tool a user wants when their usual stack is unavailable. Depending
on `ws` would also mean an audit and upgrade treadmill for a protocol surface we
only need a narrow slice of. The server implements just what the bridge uses:
the handshake, text frames (including fragmentation), ping/pong, close, and
payload limits.

**Consequences.** We own the protocol edge cases (fragmentation, masking,
close codes) and must keep tests around them. No `permessage-deflate`, no
binary application frames — both sides speak JSON text. If the implementation
grows beyond a few hundred lines, revisiting the dependency trade-off is
reasonable, but not before.

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
