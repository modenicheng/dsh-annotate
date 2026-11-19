# Release and distribution

Status: evaluation, 2026-11-19. Nothing described here is implemented yet.
[M5 in PLAN.md](PLAN.md) is the short acceptance list; this document is the
design behind it and the ground truth it has to satisfy.

Scope: the extension half across browser engines, the host half as a DSH bundle,
and the CI that turns a tag into artifacts. It does not cover DSH releases.

## 1. What "all mainstream engines" means

There is no single "browser" to support. There are three extension platforms
with three different packaging units, and two mobile platforms with their own
rules:

| Engine | Browsers | Extension unit | Store | Account fee | Review |
|---|---|---|---|---|---|
| Chromium | Chrome, Edge, Brave, Vivaldi, Opera, Arc, Yandex | `.zip` / `.crx` | Chrome Web Store (CWS); Edge Add-ons optional | US$5 once (Google), free (Microsoft) | days; longer for `<all_urls>` |
| Gecko | Firefox, Zen, LibreWolf, Waterfox, Floorp | `.zip` / signed `.xpi` | addons.mozilla.org (AMO) or self-hosted signed XPI | free | hours (unlisted) to days (listed) |
| WebKit | Safari (macOS, iOS, iPadOS) | an app containing the extension | Mac App Store / iOS App Store | US$99/year | days, every release |

Mobile is a different product, not a smaller desktop:

- **Firefox for Android** runs MV3 extensions but has no keyboard shortcuts
  (`commands` is unavailable on Android) and a different popup surface, so the
  primary `Alt+Shift+A` gesture disappears.
- **Safari on iOS** requires a Mac to build, prompts for Local Network access,
  suspends background work, and — decisively — the bridge is loopback-only, so
  a phone cannot reach a `dsh web` bound to the Mac's `127.0.0.1` at all.
- **Chromium on Android** has no extension support in any mainstream browser.

**Verdict.** "Chromium + Firefox" covers the large majority of desktop users and
is a two-package problem. WebKit is not a third manifest variant: it is an
Apple-gated delivery channel with a yearly fee, a macOS build host, and a review
loop on every release. "All mainstream engines" is reachable, but only as two
tiers with different cost profiles — not as one release pipeline that happens to
emit three files.

## 2. What the current extension assumes

All of the following is accurate for Firefox and wrong or unsupported elsewhere:

1. `packages/extension/manifest.json` declares `background.scripts`
   (lines 26-37). Chromium MV3 requires `background.service_worker` and rejects
   the `scripts` form. Firefox still has no service-worker background
   (`background.service_worker`: Firefox = not supported, Chrome 88+, Safari
   15.4+, per MDN compatibility data). There must be at least two background
   shapes, so at least two manifests.
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
5. The event page is kept awake by a 20-second alarm (`main.js:64-75`). Chrome
   clamps alarm periods to 30 s minimum, so this cannot be the keepalive there.
6. The manifest has no `icons`, no `_locales`, no `homepage_url`, and a
   description that names Firefox/Zen only. Stores require those; the listing
   is part of the release, not an afterthought.

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
| Permissions | `tabs` is probably redundant: `<all_urls>` content scripts already grant URL access, and tab events do not need the permission | audit each `tabs.*` call, drop `tabs` if nothing breaks → removes the "read your browsing history" warning and shortens review | S |
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
- Firefox for Android is a separate decision (§5).

### 3.3 WebKit (Safari)

Safari supports `background.scripts` (14+) and `content_security_policy`, so the
Firefox target is a reasonable starting point, but the delivery pipeline is
Apple's:

- The extension must live inside a native container app built with Xcode, either
  converted from the WebExtension with `safari-web-extension-converter` or
  hand-maintained. There is no buildless install path and no store that accepts
  a zip.
- macOS distribution outside the Mac App Store officially requires a
  Developer ID signature plus notarization, but developers report that Safari
  still requires the "allow unsigned extensions" developer toggle for such
  builds ([Apple forum thread](https://developer.apple.com/forums/thread/782005));
  treat the Mac App Store as the only channel a normal user can follow.
- Every release goes through App Store review again. Store review latency is now
  part of the product's upgrade path.
- `tabs.captureVisibleTab` is reported as supported since Safari 14 (MDN), but
  the popup layout, the `commands` suggested key, and the overlay/gesture code
  all need a real Safari pass. Budget for surprises.
- iOS is out of scope for this product: the bridge is loopback-only, so the
  phone cannot reach the host, and iOS suspends the background worker that owns
  the socket.

Cost: roughly 5-10 engineering days plus US$99/year, a macOS CI runner, and a
per-release review loop. That is a different order of magnitude from Chromium,
and it buys the smallest audience of the three engines.

## 4. Release engineering

The shape you described — semver tag on main, CI builds, automated publish,
generated changelog — is right. Five things need to change in the details.

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
`packages/extension/manifest.json`, the tag, the changelog, and (only when the
wire changes) `PROTOCOL_VERSION` plus the two generated copies.

### 4.2 Chrome's version format forbids semver prereleases

Chrome accepts one to four dot-separated integers and nothing else; `0.2.0-rc.1`
is not installable, and `0.2.0.1` sorts *after* `0.2.0`, so an rc numbered that
way would outrank the final release. AMO is looser, Chrome is not.

Therefore: **prereleases never reach the stores.** They go to GitHub
pre-release artifacts, AMO unlisted signing, and CWS trusted testers. Store
versions are `MAJOR.MINOR.PATCH` only. This decision has to exist before the
first tag, not after the first rejection.

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
| `dsh-annotate-firefox-<v>.zip` | `web-ext build` on the gecko target | GitHub Release; AMO upload |
| `dsh-annotate-firefox-<v>.xpi` | `web-ext sign --channel unlisted` | GitHub Release + update manifest (self-hosting only) |
| `dsh-annotate-chromium-<v>.zip` | zip of the chromium target | GitHub Release; CWS upload; Edge upload |
| `dsh-annotate-plugin-<v>.tgz` | `npm pack` | GitHub Release; npm |
| `checksums.txt` | SHA-256 over the above | GitHub Release |

Build both extension targets from one source tree with a small
`scripts/build-extension.mjs` that copies the shared files and writes the
target's `manifest.json` — the same "generated, committed, checked in CI"
pattern as `sync-protocol.mjs` (D3), not a bundler (D1). Each target directory
must exclude `package.json`, `test/`, and `dist/`; `web-ext build` will
otherwise ship them.

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
| AMO | `web-ext sign --channel unlisted` (or `--channel listed`) or the v5 upload API | a listed upload needs an existing listing; the first submission is manual. Signing of a listed upload is not immediate — poll, do not treat the upload response as "published" |
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

## 5. Support tiers and sequencing

| Tier | Targets | Gate |
|---|---|---|
| T1 | Firefox/Zen via AMO listed | today's behaviour, signed |
| T2 | Chromium desktop via CWS (+ Edge) | platform seam in §3.1 |
| T3 | Safari macOS via Mac App Store | only if the product needs WebKit enough to fund US$99/year + review latency |
| T4 | Firefox for Android | needs a non-keyboard entry point; separate UX pass |
| — | Safari iOS, Chromium Android | not applicable to a loopback bridge |

Statement discipline: until T3 ships, the README should say "Firefox and
Chromium", not "all browsers". A support claim that Safari users can disprove in
one minute is worse than a narrow claim.

## 6. Host bundle distribution

- **The npm name is taken.** `dsh-annotate` on the public registry is an
  unrelated project (element annotation for DSH previews, `0.1.15`, different
  repository). `dsh plugin add dsh-annotate` would install that one, and
  `npm publish` from this repository would be rejected. Pick a scoped name
  (`@<owner>/dsh-annotate`) or a different name before wiring CI; the cordis
  patch's `name:` must change with it.
- Add `repository`, `homepage`, `bugs`, and `engines.dsh`; the plugin manager
  reads display metadata and the detail document from the package, and uses the
  registry copy for pre-install detail rendering.
- Declare the DSH peer packages the client half injects
  (`@deepseek-ai/dsh-client-ui-conversation` today) so an incompatible DSH
  refuses the install instead of failing at load.
- Publish with provenance (OIDC) and `saveExact`-friendly versions; the
  manager's `updateBundle` only lists registry packages installed under their
  own name.

## 7. Compatibility policy (release-blocking)

`bridge.js:160` requires an exact protocol version match: a plugin update
therefore disconnects every installed extension until that extension is updated
— and store review can delay the extension by days. The two halves are released
on different clocks (npm is instant, CWS/AMO are not), so exact-match gating
makes every release a potential outage.

Before the first public release:

- `/ext/anno/health` advertises `{ protocol, minProtocol, caps }`.
- The host accepts a window (at minimum the previous protocol version), and
  prefers capability flags (`hello.ok` already carries `caps`) over version
  equality.
- Both sides render an actionable state — "update the extension" / "update the
  plugin" with the required version — instead of a silent reconnect loop.

## 8. Estimated effort

| Work | Estimate |
|---|---|
| Platform seam (manifest targets, SW entry, namespace guard, onMessage adapter, ping interval) | 3-5 d |
| Chromium QA (capture, popup, reconnect, pick, permissions audit) | 3-5 d |
| Store assets and listings (icons, screenshots, privacy policy, EN/ZH copy) | 2-3 d |
| Release automation (build matrix, draft release, changelog, npm, AMO, CWS) | 4-6 d |
| Protocol compatibility window | 1-2 d |
| Safari packaging and App Store (separate track) | 5-10 d + US$99/yr |

T1+T2 lands in roughly two to three working weeks. T3 is its own project.

## 9. Open questions

1. Is the Chromium target allowed to keep a permanent 20 s heartbeat, or should
   it idle and reconnect on demand? The latter is friendlier to laptops and
   needs a host-side pending-pick queue.
2. Does the product want the Edge listing, or is CWS-only (Edge installs CWS
   items) enough for v1?
3. Is the extension's public name settled? It must be available on AMO, CWS, and
   npm, and must not collide with the existing `dsh-annotate` package.
4. Who reviews and publishes the draft release — a single maintainer, or does it
   need a second pair of eyes before a store submission?
