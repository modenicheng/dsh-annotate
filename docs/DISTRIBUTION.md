# Release and distribution

Status: plan, revised 2026-11-19; store metadata and the per-target build landed
2026-11-20. [M5 in PLAN.md](PLAN.md) is the short acceptance list; this document is the
design behind it and the ground truth it has to satisfy. Decisions D14–D16 in
[DECISIONS.md](DECISIONS.md) fix the scope and the compatibility rule this plan
follows.

Implemented on 2026-11-20, ahead of the store submissions: the icon set and its
generator (§3.1 item 6), `_locales/en` + `_locales/zh_CN`, `homepage_url`, the
version alignment to 0.1.2 (§4.1), `scripts/build-extension.mjs` with the two
targets (§4.4), the Chromium runtime seam (§3.1), and the store jobs in
`.github/workflows/release.yml` (§4.6). Reworked on 2026-11-21 into parallel
per-store lanes after v0.1.4's release: one `stores` job that ran every store
serially hid an AMO failure behind `continue-on-error` and reported it only in
a final verdict step (§4.7). What is still manual is everything that requires
an account: the US$5 CWS registration and the Edge product.

Scope: the extension half across browser engines, the host half as a DSH bundle,
and the CI that turns a tag into artifacts. It does not cover DSH releases.

## 1. What "all mainstream engines" means

There is no single "browser" to support, but only two extension platforms are
in scope: Chromium and Gecko. WebKit was evaluated and excluded (D14, §3.3) — it
is an Apple-gated delivery channel that costs US$99/year and a review cycle per
release.

| Engine | Browsers | Extension unit | Store | Account fee | Review |
|---|---|---|---|---|---|
| Chromium | Chrome, Edge, Brave, Vivaldi, Opera, Arc, Yandex | `.zip` | Chrome Web Store (CWS); Edge Add-ons optional | US$5 once (Google), free (Microsoft) | days; longer for `<all_urls>` |
| Gecko | Firefox, Zen, LibreWolf, Waterfox, Floorp | `.zip` / signed `.xpi` | addons.mozilla.org (AMO) or a self-hosted signed XPI | free | hours (unlisted) to days (listed) |

Mobile is a different product, not a smaller desktop:

- **Firefox for Android** runs MV3 extensions but has no keyboard shortcuts
  (`commands` is unavailable on Android) and a different popup surface, so the
  primary `Alt+Shift+A` gesture disappears.
- **Chromium on Android** has no extension support in any mainstream browser.
- **Safari on iOS** is moot twice over: the bridge is loopback-only, so a phone
  cannot reach a `dsh web` bound to the Mac's `127.0.0.1`, and iOS suspends the
  background worker that owns the socket.

**Verdict.** Two packages, two stores, one pipeline. Chromium and Gecko cover the
large majority of desktop users; what remains is the platform seam in §3.1, not
a second product.

## 2. What the current extension assumes

All of the following is accurate for Firefox and wrong or unsupported elsewhere:

1. `packages/extension/manifest.json` declares `background.scripts`
   (lines 26-37). Chromium MV3 requires `background.service_worker` and rejects
   the `scripts` form. Firefox still has no service-worker background
   (`background.service_worker`: Firefox = not supported, Chrome 88+, per MDN
   compatibility data). There must be at least two background shapes, so at
   least two manifests.
2. `host_permissions` lists `ws://127.0.0.1/*` and `wss://…` (lines 21-24).
   Chromium match patterns accept only `http`, `https`, `*`, and `file`
   ([Chrome docs](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)),
   so Chrome rejects that manifest outright. Firefox tolerates the `ws`/`wss`
   entries, which is why this has not surfaced yet.
3. Every context calls `browser.*` directly. Chrome exposes `browser` only from
   Chrome 148 ([Chrome docs](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace));
   until then only `chrome` exists.
4. `background/main.js:29` registers `ns.routing.handleMessage` — an `async`
   function — directly as the `runtime.onMessage` listener. Promise-returning
   listeners only work natively from Chrome 148 (same page). Older Chromium
   closes the channel and the caller sees `undefined`, so every routing reply
   would silently vanish.
5. The event page is kept awake by a 20-second alarm. Chrome clamps alarm
   periods to 30 s minimum, so this cannot be the keepalive there.
6. ~~The manifest has no `icons`, no `_locales`, no `homepage_url`, and a
   description that names Firefox/Zen only.~~ Done 2026-11-20: five PNG sizes
   plus an SVG from one geometry (`scripts/build-icons.mjs`, checked in CI), two
   locales through `__MSG_`, `homepage_url`, and an engine-neutral description.
   The prompt also surfaced a real defect worth recording: the description and
   the store copy must not promise "all browsers" (§5).

None of this is a redesign. It is a platform seam: one adapter, one generated
manifest per target, and a service-worker entry point.

## 3. Engine by engine

### 3.1 Chromium desktop (Chrome, Edge, Brave, Vivaldi, Opera, Arc)

| Item | Finding | Fix | Size |
|---|---|---|---|
| Manifest | `background.scripts` rejected; `ws://` host permissions invalid | generated `manifest.chromium.json` + `sw.js` using `importScripts`; drop the four ws/wss entries | S |
| Namespace | `browser` only on ≥148 | `globalThis.browser ??= chrome` as the first file in every context | XS |
| Messaging | async listener needs `sendResponse` + `return true` below 148 | one `onMessage` adapter used by all three contexts; keep the handler shape | S |
| SW lifetime | 30 s idle termination; WebSocket messages within the window keep it alive since Chrome 116 ([docs](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)) | send `{t:'ping'}` from a 20 s interval while authenticated. The host already answers `pong` (`bridge.js:191`), so no protocol change | S |
| Alarms | 30 s minimum | keep the alarm for reconnect/refresh only, never as the keepalive | XS |
| Capture | `captureVisibleTab` (Chrome 5+) and `OffscreenCanvas`/`createImageBitmap` exist in workers; the `new Image()` fallback is already guarded by `typeof document` | verify the OffscreenCanvas path in a real SW | S |
| Permissions | Correction (2026-11-20): the assumption that "`<all_urls>` content scripts already grant URL access" is false in MV3 — `content_scripts.matches` grants no host permission, and `host_permissions` is loopback-only, so reading `tab.url`/`tab.title` needs `tabs` | keep `tabs`, justify it as "route marks to their page" in the listing; the warning stays and the justification must be specific | S |
| Store | CWS, US$5 one-time, review days; `<all_urls>` explicitly slows review | privacy policy, permission justifications, `minimum_chrome_version` | S |

The service-worker lifetime is the only item that touches runtime design, and it
is smaller than it first appears: the client already speaks `ping`/`pong`
(`protocol/src/index.js:84-89`), so an interval that sends the frame that
already exists is enough. `setInterval` inside a service worker is the pattern
Chrome's own guide uses; a 20 s loop is the sanctioned keepalive, not a hack.

Consequence to accept: with a persistent bridge the worker never idles, so the
extension costs a wake-up every 20 s while connected. That is acceptable for a
developer tool connected to a local host, but it should become a preference
("keep the bridge connected") rather than an unconditional behaviour.

### 3.2 Gecko (Firefox, Zen and forks)

Already works and is verified in a real browser (D9, Firefox 159.0). Changes
needed for release, not for porting:

- AMO listed signing, or `browser_specific_settings.gecko.update_url` for a
  self-distributed signed XPI. A store build and a self-hosted build differ by
  one manifest key and one update manifest file.
- Keep `strict_min_version` at the version actually tested; raising it silently
  drops users on ESR.
- The `data_collection_permissions` key (declared 2026-11-20, `"required":
  ["none"]` — the extension collects nothing) is only honoured from Firefox 142,
  so addons-linter warns that our 128 floor predates it. Accepted on purpose:
  128–141 ignore the key, 142+ get the built-in consent prompt, and raising the
  floor to 142 would cut off the current ESR. The warning stays until ESR
  reaches 142.
- Firefox for Android is a separate decision (§5).

### 3.3 WebKit (Safari) — out of scope

Decided 2026-11-19 (D14). Safari is not a third manifest variant: the extension
must live inside a native container app built with Xcode, every release goes
through App Store review, and the Mac App Store is the only channel a normal user
can follow. Distribution outside the store is officially allowed with a
Developer ID signature plus notarization, but in practice it still requires the
"allow unsigned extensions" developer toggle
([Apple forum thread](https://developer.apple.com/forums/thread/782005)) — which
is developer mode by another name. That is US$99/year and a review loop on every
release, for the smallest audience of the three engines.

The porting cost alone would be manageable: `background.scripts` works (14+), so
the Gecko target is a starting point, and the popup, the `commands` suggested
key, `tabs.captureVisibleTab`, and the overlay would need one real Safari pass.
The delivery model is what disqualifies it.

iOS is ruled out separately: the bridge is loopback-only, so a phone cannot reach
the host, and iOS suspends the background worker that owns the socket.

Revisit only if someone funds the account and the per-release review time — and
then as its own track, not as a third target in this pipeline.

## 4. Release engineering

The shape you described — semver tag on main, CI builds, automated publish,
generated changelog — is right. Several details need to change.

### 4.1 One product version, one protocol version

Today: `packages/plugin/package.json` is 0.1.1, `packages/extension/manifest.json`
is 0.1.0, `PROTOCOL_VERSION` is 1 (`protocol/src/index.js:13`). Three unrelated
numbers guarantee that a release forgets one.

- One **product version** for both halves, bumped by the release tooling. They
  ship together and are useless apart.
- The **protocol version** stays an independent integer. It changes only when
  the wire changes, and it is negotiated, not derived from the product version.
- `engines.dsh` goes into `packages/plugin/package.json`. DSH refuses the
  install before `pnpm` runs when the requirement is unmet, which is the only
  place that check can happen cheaply.
- `minimum_chrome_version` and `gecko.strict_min_version` are release inputs:
  changing them is at least a minor bump, because it changes who can install.

Version sources that must be bumped atomically: `packages/plugin/package.json`,
`packages/extension/manifest.json`, `packages/extension/amo-metadata.json` (the
version's release notes, which become the store "what's new"), the tag, the
changelog, and (only when the wire changes) `PROTOCOL_VERSION` /
`MIN_PROTOCOL_VERSION` plus the two generated copies.

The two manifests carried 0.1.0 and 0.1.2 until 2026-11-20; the extension now
reads 0.1.2 so that the first store version matches the npm half, and the
one-product-version rule above has a single number to start from.

Note the split of duties: the product version names a release and appears in
store listings; the protocol version is the only thing a connection checks
(§7, D15). Neither is ever compared to the other.

### 4.2 Prereleases never go to a store

Chrome accepts one to four dot-separated integers as a version and nothing else;
`0.2.0-rc.1` cannot be installed. AMO keeps a monotonic version sequence per
add-on ID, so a prerelease uploaded as `0.2.0.1` permanently outranks the
eventual `0.2.0` for that ID. Both facts make prereleases hostile to store
channels, independently of review time.

Policy (D16): a store only ever receives finals, `MAJOR.MINOR.PATCH`, with an
integer manifest version. Prereleases are GitHub pre-releases that interested
users install themselves:

- Chromium: an unpacked directory (developer mode). Without a store there is no
  other way to install it.
- Gecko: a temporary add-on from `about:debugging`, or a signed build under a
  **separate beta add-on ID** (`…-beta@…`). One add-on ID cannot host both
  channels; the beta ID has its own version sequence and update manifest.

The beta artifacts are built from the same tag as the final, never from a
different commit, so "prerelease" means "not published", not "different code".
The documentation has to say plainly that a prerelease install is manual and,
on Firefox, temporary unless the beta build is signed.

### 4.3 Two-phase pipeline: tag builds, release publishes

A single tag → publish chain is the wrong shape because store publishing is
irreversible: a CWS version cannot be deleted, an AMO version cannot be
withdrawn silently, and a signed XPI cannot be un-signed. If the changelog is
wrong or an artifact is broken, the tag is already burned.

Recommended:

```
push tag vX.Y.Z
  └─ verify (existing checks + per-target lint + build matrix)
       └─ build artifacts, generate changelog, create DRAFT GitHub Release
            └─ human reviews notes + artifacts, clicks Publish
                 └─ release: published
                      ├─ npm publish (plugin, with provenance)
                      ├─ AMO: sign (unlisted) or upload (listed)
                      ├─ CWS: upload + submit for review
                      └─ Edge: upload + submit (optional)
```

The draft is the human gate. It also decouples "the code is released" from
"the store has reviewed it": a store submission is asynchronous and can sit in
review for days, so the GitHub Release must be publishable before the store
entries are live.

The implemented pipeline has exactly this shape. `.github/workflows/release.yml`
is only the dispatcher; the lane bodies live in `.github/actions/`
(`build-release-artifacts`, `verify-release`, `npm-publish`, `amo-submit`,
`cws-submit`). The tag push runs `draft`. Publishing the release runs two jobs
in parallel — `channels`, which reduces the store credentials and the dry-run
flag to booleans because secrets may not appear in `if:` conditions, and
`verify`, the shared pre-flight (published release, tag gates, the CI gate on
the tag, and the released zips proven against `checksums.txt`) whose outputs
every lane trusts — and then the four lanes `npm ∥ amo ∥ cws ∥ edge`, each
gated on its own credentials, each red on its own failure, with a `summary`
job that fails the run once every lane has had its turn (§4.7). No lane ever
waits on another lane.

Triggers:

- `push: tags: ['v*']` for builds. Verify the tag matches the manifest and
  package versions and is an ancestor of `main`; a mistyped tag must fail before
  anything is built.
- `workflow_dispatch` with an explicit tag for retries, so a failed upload does
  not require re-tagging.
- `concurrency: { group: release, cancel-in-progress: false }`. Never cancel a
  publishing run.
- Protect `v*` tags and require the release environment's reviewers; otherwise
  anyone who can push a tag can publish.

Prefer a release tool that opens a version-bump PR (release-please or
equivalent) over hand-pushed tags: the tag then always follows a reviewed diff
that already bumped every version source. release-please's `extra-files` JSON
updater can carry `packages/extension/manifest.json` alongside the package
manifests.

### 4.4 Artifacts

| Artifact | Produced by | Goes to |
|---|---|---|
| `dsh-marker-firefox-<v>.zip` | zip of the firefox target | GitHub Release; AMO upload |
| `dsh-marker-firefox-<v>.xpi` | `web-ext sign --channel unlisted` | beta channel and self-hosting |
| `dsh-marker-chromium-<v>.zip` | zip of the chromium target | GitHub Release; CWS upload; Edge upload |
| `dsh-marker-plugin-<v>.tgz` | `npm pack` | GitHub Release; npm |
| `checksums.txt` | SHA-256 over the above | GitHub Release |

Prerelease builds reuse the same targets, carry a `-beta` suffix in the artifact
name, and use the beta add-on ID in the gecko manifest. They are never uploaded
to CWS, and AMO sees them only as unlisted signing under that ID.

Build both extension targets from one source tree with a small
`scripts/build-extension.mjs` that copies the shared files and writes the
target's `manifest.json` — the same "generated, committed, checked in CI"
pattern as `sync-protocol.mjs` (D3), not a bundler (D1). Each target directory
must exclude `package.json`, `test/`, and `dist/`; `web-ext build` will
otherwise ship them.

Phase 1 (the tag build) produces both zips and `checksums.txt` and attaches them
to the **draft** release. The store job downloads those files and submits the
same bytes; it never rebuilds them (§4.9). A manual first submission downloads
the same draft asset, so the listing, the release and the store all describe one
build.

### 4.5 Changelog

Conventional Commits are already enforced by the local hooks, so the changelog
is mechanical: `git-cliff` with a config in the repo, run at draft time, with
the commit range from the previous tag. Two rules:

- The generated notes are a draft for a human to edit; they become the store
  "what's new" text, which is user-facing and cannot be regenerated after
  submission.
- Keep a hand-written summary section for anything a commit title cannot say
  (protocol changes, required DSH version, store availability).

### 4.6 Store automation

| Store | API | Notes |
|---|---|---|
| npm | `npm publish --provenance` | OIDC trusted publishing; the plugin manager's `updateBundle` only offers updates for packages installed from the registry under their own name |
| AMO | `web-ext sign --channel unlisted` (or `--channel listed`) or the v5 upload API | a listed upload submits for review through the v5 submission API; an authenticated API key can submit the first listed version, and the anonymous version API answers 401 until a listing is public, so the lane's idempotency probe treats 401/404 as "not visible yet" and lets web-ext decide. `--amo-metadata packages/extension/amo-metadata.json` carries the whole listing and must be in the v5 wire format: `categories` is an object of application slug to valid category slugs (listed by `addons.mozilla.org/api/v5/addons/categories/`), and `homepage`/`support_url` are `{lang-code: value}` objects — v0.1.4's submission failed on exactly those three fields being plain strings. Signing of a listed upload is not immediate — poll, do not treat the upload response as "published" |
| CWS | Chrome Web Store API v2 (`:upload`, `:publish`) with an OAuth refresh token | the item must exist in the dashboard first; `:publish` submits for review, it does not publish |
| Edge | Edge Add-ons submission API with a Partner Center API key | Edge also installs CWS items, so this listing is optional and can follow later |

Everything here is a small Node script against a REST endpoint; none of it
justifies a dependency-heavy release toolchain.

### 4.7 Failure handling and idempotency

The realistic failure is a partial release: npm and AMO succeeded, CWS rejected
the package, the tag is spent. Design for it:

- A pre-flight job runs every check the store will run (manifest lint per
  target, size limits, referenced files, icon dimensions, description length)
  before anything is uploaded.
- Each publish step checks whether that version already exists upstream and
  skips instead of failing the run.
- The workflow resumes from `workflow_dispatch` with the same tag; no step may
  depend on a fresh tag.
- The release notes state which channels are live, and the checklist for a
  failed channel is "upload again for the next patch", never "reuse the
  version".

### 4.8 Secrets and permissions

- AMO JWT issuer/secret, CWS OAuth refresh token + item id, Edge API key, npm
  token (or trusted publishing), all in a protected GitHub Environment with
  required reviewers.
- `permissions: contents: write` only on the job that creates the release; the
  build jobs get `contents: read`.
- Pin third-party actions by commit SHA and pin `web-ext` to an exact version.
  Today `packages/extension/package.json` runs `npx web-ext` unpinned; that is a
  supply-chain hole in the one place that produces signed artifacts.

### 4.9 Reproducibility, stated honestly

PLAN.md M5 asks for "release artifacts reproducible from a tag". That is
achievable for the unsigned zips and the npm tarball and **not** achievable for
the signed XPI, whose signature is produced by AMO and carries its own
timestamp. Rewrite the criterion as: the unsigned artifacts are rebuilt from the
tag in CI with a published checksum, and the signed XPI is identified by the
AMO version and its signing hash. Do not promise byte-identical signed output.

### 4.10 Adjacent infrastructure worth having

Cheap, and directly useful for this repository:

- **Dry run.** `workflow_dispatch` with `dry_run: true` builds, validates, and
  renders the release notes without uploading. Store versions are permanent, so
  the pipeline must be testable without burning one.
- **Validate what ships.** Run `check-manifest` and the store pre-flight against
  the generated target directory and the zip contents, not the source tree. The
  source tree is not the artifact.
- **Dependency updates.** Renovate or Dependabot for `ws`, the pinned action
  SHAs, and `web-ext`. With no devDependencies the noise is minimal and the
  security value is real.
- **Dependency review and audit.** `actions/dependency-review-action` on PRs and
  a production-only `pnpm audit`, which stays cheap with one runtime dependency.
- **CodeQL for JavaScript.** The content script parses untrusted DOM and builds
  selectors from it; static analysis is worth the free minutes.
- **A Windows CI job.** The README documents PowerShell paths and the tests are
  path-sensitive, but CI runs `ubuntu-latest` only today.
- **Build provenance.** `actions/attest-build-provenance` for the zips, so a
  downloaded artifact can be tied to the commit and workflow that produced it.
- **Staged rollout on CWS.** Publish a version to a percentage of users, watch
  it, then go to 100%. With store review in the loop this is the only canary a
  store-distributed extension can have.
- **Rollback procedures.** CWS can roll back to a previous published version,
  AMO has version rollback for listed add-ons, and the npm half rolls back with
  `npm deprecate` plus a patch release. Write the three commands down before the
  first release, not during the first incident.
- **`SECURITY.md`.** A disclosure address; reviewers and users both look for it,
  and an extension that reads every page should have one.

Deliberately not worth it here: SBOM generation for a five-file extension,
signed commits (protected tags are enough), a documentation site, and full
end-to-end browser automation on every push. One Playwright Chromium load of the
built target per release, plus a manual Firefox checklist, is the useful subset.

## 5. Support tiers and sequencing

| Tier | Targets | Gate |
|---|---|---|
| T1 | Firefox/Zen via AMO listed | today's behaviour, signed |
| T2 | Chromium desktop via CWS (+ Edge) | platform seam in §3.1 |
| T3 | Firefox for Android | needs a non-keyboard entry point; separate UX pass |
| — | Safari (all platforms), Chromium Android | out of scope (D14) |

Statement discipline: the README and both store listings say "Firefox and
Chromium". No "all browsers" claim. Safari is a documented non-goal, not a
pending target.

## 6. Host bundle distribution

- **The package is `dsh-marker` (D23).** `dsh-annotate` on the public registry
  belongs to another maintainer's element-annotation plugin for DSH previews, so
  the rename is what makes `npm publish` possible and `dsh plugin add dsh-marker`
  unambiguous.
- **The package carries its own metadata.** `repository`, `homepage`, `bugs`,
  and `engines.dsh: ^0.2.0` are set. An `engines.dsh` range is the install-time
  admission check and decides alone — when it is present, DSH ignores
  `peerDependencies` — and it is evaluated with prereleases included, so a
  `0.2.x-rc` runtime passes while an older one is refused before install.
- **Display metadata ships inside the package.** `meta.title`,
  `meta.description`, `docs/DETAIL.md`, and `icon.svg` are read from the
  installed copy and from the registry copy before installation, so every one of
  them must stay in `files`.
- **Publish with provenance (OIDC) from CI** once the package exists, and keep
  versions `saveExact`-friendly; `updateBundle` only offers updates for registry
  packages installed under their own name. §6.1 has the workflow and the one-time
  bootstrap it cannot perform itself.

### 6.1 The release workflow, and the step that cannot be tokenless

`.github/workflows/release.yml` has two phases. A `v*` tag verifies the tag
(version match, ancestor of `main`, the CI gate), packs the tarball, and opens a
**draft** release. Publishing that draft fires the second phase, which downloads
the tarball from the release, checks its checksum, and publishes those bytes with
`--provenance`. Nothing reaches the registry before a human clicks Publish, and
`workflow_dispatch` replays phase 2 for a tag whose publish failed without
burning a new tag. Phase 2 refuses a prerelease version outright (D16): the tag
pattern accepts `v0.2.0-rc.1`, the version check does not.

Authentication is OIDC trusted publishing; no `NPM_TOKEN` exists in the
repository. Three details decide whether it works:

- npm must be 11.5.1 or newer. The Node 22 runner image ships npm 10, so the job
  installs npm before publishing.
- `actions/setup-node` must not receive `registry-url`. With it, setup-node
  writes an `_authToken` line into `.npmrc`, npm prefers that credential over the
  OIDC exchange, and the failure surfaces as `E404` on `PUT`, not as an auth
  error.
- `package.json` `repository.url` must name this repository, or the provenance
  check rejects the publish with `E422`.

**The first publish is the exception.** A trusted publisher is registered on a
package that already exists, so `0.1.x` needs one credential OIDC cannot supply:
either publish that version once by hand from the packed tarball, or add a
granular token as `NPM_TOKEN`, run the workflow once, then delete the secret and
revoke the token. After that, register the publisher — npmjs.com → `dsh-marker` →
Settings → Trusted publishing → GitHub Actions, repository
`modenicheng/dsh-annotate`, workflow `release.yml`, no environment — and delete
`NPM_TOKEN` for good. Granular tokens that bypass 2FA stop working for direct
publishing in January 2027, so that migration is a deadline rather than an
option.

npm's staged publishing (`npm stage publish`, approved with 2FA on npmjs.com) is
the alternative gate if a review inside npm is preferred over the GitHub draft.
Staging needs an authenticated session but not a 2FA prompt, and staging a
package that does not exist yet publishes a `0.0.0-stage` placeholder — so a
maintainer can stage the first version from a logged-in CLI and approve it with
2FA, instead of publishing a real version by hand.

## 7. Compatibility policy: protocol only (D15)

Decided 2026-11-19. A connection is accepted or rejected on the protocol version
alone. No product version — neither the extension's manifest version nor the
plugin's package version — is compared across the bridge, in either direction.
Product versions name releases; they are not a compatibility signal.

Why: the halves are released on different clocks. npm is instant; CWS and AMO
are not, and review can take days. Any check that couples the two product
versions turns a store review delay into an outage for everyone already
installed — which is exactly what an exact-match protocol check does today
(`bridge.js:160-167`).

The contract:

- `hello` carries `{ token, protocol }` and never a product version. It already
  carries only the protocol version (`bridge.js:155-168`); keep it that way.
- The host accepts a window: `MIN_PROTOCOL ≤ protocol ≤ PROTOCOL_VERSION`. The
  window spans at least the previous protocol version; shrinking it is an
  announced decision, never a side effect of a release.
- `/ext/anno/health` advertises `{ protocol, minProtocol, caps }` so a client can
  explain a mismatch before it connects.
- Differences inside the window are negotiated with `caps` (`hello.ok` already
  carries them), not inferred from a number.
- The UI says "this extension is too old for the installed plugin" or the
  reverse, with both protocol numbers; it never renders a product-version
  comparison.

`PROTOCOL_VERSION` and the new `MIN_PROTOCOL_VERSION` live in
`packages/protocol/src/index.js`, are copied by `sync-protocol.mjs` like
everything else, and change only when the wire changes.

`engines.dsh` is a different check in a different place: it is package metadata
that DSH evaluates at install time, and it never reaches the socket.

## 8. Estimated effort

| Work | Estimate |
|---|---|
| Platform seam (manifest targets, SW entry, namespace guard, onMessage adapter, ping interval) | 3-5 d |
| Chromium QA (capture, popup, reconnect, pick, permissions audit) | 3-5 d |
| Store assets and listings (icons, screenshots, privacy policy, EN/ZH copy) | 2-3 d |
| Release automation (build matrix, draft release, changelog, npm, AMO, CWS) | 4-6 d |
| Protocol window (`MIN_PROTOCOL`, health, UI states) | 1-2 d |
| Beta channel (separate add-on ID, unpacked builds, install docs) | 1 d |

T1+T2 lands in roughly two working weeks, plus the store review calendars, which
run in parallel and cannot be compressed.

## 9. Open questions

1. Is the Chromium target allowed to keep a permanent 20 s heartbeat, or should
   it idle and reconnect on demand? The latter is friendlier to laptops and
   needs a host-side pending-pick queue. **Answered for v1 (2026-11-20): the
   heartbeat ships, Chromium only and unconditionally.** `background/main.js`
   starts a 20 s `setInterval` that sends the `{ t: 'ping' }` frame the protocol
   already carries, and the alarm drops to reconnect plus snapshot refresh at
   Chrome's 1-minute floor; Firefox keeps its 20 s alarm and starts no second
   timer. Turning it into a preference stays open.
2. Does the product want the Edge listing, or is CWS-only (Edge installs CWS
   items) enough for v1?
3. ~~Is the extension's public name settled?~~ Settled by D23: `dsh-marker`
   everywhere a user types it — npm, the plugin row, and both store listings.
   Still open is whether the GitHub repository follows the rename; until it
   does, npm metadata points at `dsh-annotate` and GitHub redirects the old
   URLs.
4. How long does the protocol window stay open — one release cycle, or a fixed
   number of months? The answer becomes `MIN_PROTOCOL_VERSION`'s bump rule.
5. Who reviews and publishes the draft release — a single maintainer, or does it
   need a second pair of eyes before a store submission?
