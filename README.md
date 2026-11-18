# dsh-annotate

[![CI](https://github.com/modenicheng/dsh-annotate/actions/workflows/ci.yml/badge.svg)](https://github.com/modenicheng/dsh-annotate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Visual annotations from your everyday browser, as first-class context for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Point at a paragraph, a button, or a region of a page in Firefox or Zen, write
one line of intent, and the annotation lands in the running DSH session with a
cropped screenshot, DOM selectors, and page context. The model can also ask you
to point at something (`annotate_pick`) when a request is ambiguous.

> **Status: early development.** The protocol, the host plugin, and the
> extension are implemented and covered by tests; the host half is verified
> against a live `dsh web` instance, while the browser half still needs a real
> Firefox/Zen session. See [docs/PLAN.md](docs/PLAN.md) for what is proven and
> what is not.

## Architecture

```
Firefox / Zen extension
  content script  ->  background (owns the socket)  ->  popup
  gestures: text selection | DOM element | dragged region
  payload:  anchor + cropped screenshot + page context
        |
        |  ws://127.0.0.1:3080/ext/anno
        |  hello { token, version } -> frames both ways
        v
DSH host (`dsh web`) with the dsh-annotate bundle
  /ext/anno          websocket bridge (RFC 6455, hand-written)
  /ext/anno/health   health check + protocol version
  AnnotationStore    $DSH_HOME/annotations/queue.jsonl
  annotate_* tools   -> model / agent session
```

There is no extra daemon and no extra port. The bridge is mounted on the DSH
host webserver and lives exactly as long as `dsh web` does. Both sides are plain
ESM JavaScript with no build step.

## Install

Requirements: Node.js 22+ and a DSH installation with the Web profile. Firefox
128+ or Zen for the extension.

### Host plugin

The host plugin is an ordinary DSH bundle with no runtime dependencies, so a
profile install works offline. Development uses an isolated `anno` profile so
the daily `web` profile is left untouched; you can pick any profile name.

```sh
# 1. Create the isolated profile from the shipped Web template (once).
#    This initialises the profile before booting it; Ctrl+C if port 3080 is busy.
dsh --profile anno --from-default-profile web

# 2. Install the bundle from this checkout (a local directory, no registry).
dsh plugin --profile anno add /absolute/path/to/dsh-annotate/packages/plugin

# 3. Boot the profile and open the Web UI it prints.
dsh --profile anno
```

On Windows use the same commands in PowerShell, with a Windows path such as
`D:\coding\dsh-annotate\packages\plugin`.

If the bundle is installed but not active, open **Plugins** in the DSH Web UI
and enable `dsh-annotate`. The same page can install a local bundle directly
(**Add plugin**), which is the easier route if you prefer the GUI.

### Extension

> Not available yet: `packages/extension` is still under construction (M2). The
> steps below are the intended flow.

The extension has no build step. Load it as a temporary add-on:

1. Open `about:debugging#/runtime/this-firefox` (Zen: `about:debugging`).
2. Choose **Load Temporary Add-on…** and select
   `packages/extension/manifest.json`.
3. Open the extension popup and paste the bridge token from
   `$DSH_HOME/ext-bridge-token` (`%USERPROFILE%\.dsh\ext-bridge-token` on
   Windows).
4. Press `Alt+Shift+A` on a page to enter annotation mode: select text, click
   an element, or drag a region, then write the comment and press Enter.

Temporary add-ons disappear when the browser closes. M5 covers a signed `.xpi`
for a permanent install.

## Security model

The bridge is local-only by design:

- **No public port.** It attaches to the DSH host webserver, which binds to
  loopback (`127.0.0.1`) by default. Do not expose the DSH Web UI through a
  reverse proxy, tunnel, or `0.0.0.0` binding: the websocket would then be
  reachable from wherever that server is reachable.
- **Token handshake.** The first frame must be
  `hello { token, version }`. The token is 32 random bytes as hex, stored in
  `$DSH_HOME/ext-bridge-token` with owner-only permissions on POSIX. It is
  compared in constant time (`sha256` + `timingSafeEqual`). A client that does
  not authenticate within 5 seconds is disconnected, and the protocol version
  must match exactly.
- **No token, no data.** Without a valid token the host closes the socket; the
  only anonymous endpoint is `/ext/anno/health`, which reports the protocol
  version and open-annotation/client counts, never annotation content.
- **Bounded input.** Frames are capped at 32 MiB, records are validated against
  `packages/protocol/src/index.js`, and the store only keeps references to
  screenshots that DSH's own attachment service accepts.
- **Local storage.** Annotations live under `$DSH_HOME`; nothing leaves the
  machine and there is no telemetry. The model sees annotations exactly like
  any other local tool output in the session.

The practical trust boundary: anyone who can read `$DSH_HOME/ext-bridge-token`
or write to your profile directory can already act as you locally.

## Tools

The host registers five tools. All of them operate on the annotation store and
broadcast changes back to connected browsers.

| Tool | What it does |
|---|---|
| `annotate_list` | List annotations, default `open`, with `status`, `url_filter`, `kind`, and `limit` filters. Returns compact previews. |
| `annotate_get` | Read one annotation by `id` (or `latest`): full anchor JSON plus the cropped screenshot as an image block. |
| `annotate_resolve` | Mark an annotation `resolved` or `wont_fix` with a note the page badge shows, and optionally record `files_touched`. |
| `annotate_pick` | Ask the user to point at something in the browser; the call waits (5 s–15 min, default 2 min) for a selection, element, or region. |
| `annotate_clear` | Bulk-delete annotations by `status` and/or `before_iso`. |

## Where data lives

| Location | Contents |
|---|---|
| `$DSH_HOME/annotations/queue.jsonl` | Append-only event log (`put`, `patch`, `del`, `img`), folded in memory at startup and compacted when it grows stale. |
| DSH attachment service | Cropped screenshots; the log stores only the attachment reference. |
| `$DSH_HOME/ext-bridge-token` | Bridge token, generated on first use with mode `0600`. |
| Browser `storage.local` | Extension token, offline outbox, and UI preferences. |

`$DSH_HOME` defaults to `~/.dsh` (`%USERPROFILE%\.dsh` on Windows). It is shared
by every profile on the machine, so one token works for whichever profile is
running — only one profile should run the bridge at a time.

## Development

```sh
pnpm run sync-protocol                              # copy the protocol into both consumers
node --test "packages/*/test/*.test.js"             # works in PowerShell and cmd
pnpm run check                                      # Biome + sync + syntax + tests
```

The quoted glob is intentional: Node expands it itself, which keeps the command
identical on Windows, macOS, and Linux. `pnpm run check` fetches the pinned
Biome version through `npx`, so it needs network access the first time; the
tests and hooks do not.

Local hooks enforce Conventional Commits and run the checks before each commit:

```sh
git config core.hooksPath .githooks
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the commit format, the hook details,
and the generated-file rule.

## Status and roadmap

| Phase | Scope | State |
|---|---|---|
| M0 | Protocol, repository base, CI, hooks | done (hosted CI has not run yet) |
| M1 | Host plugin, storage loop, tools | implemented and verified against a live `dsh web` instance: health route, token handshake, create → ack → broadcast, query across query-string changes, resolve/delete, idempotent replay, attachment-backed crop |
| M2 | Extension capture: gestures, overlay, crop, outbox | implemented; loads and boots in a headless harness, **not yet exercised in a real Firefox/Zen session** |
| M3 | Re-anchoring and agent-initiated picks | implemented on both sides (hydrator fallback chains, pick banner, timeout and cancel); browser behaviour unverified |
| M4 | Developer context, session routing, multi-window | planned |
| M5 | Signing and distribution | planned |

The detailed deliverables and acceptance criteria are in
[docs/PLAN.md](docs/PLAN.md); implementation decisions and their rationale are
in [docs/DECISIONS.md](docs/DECISIONS.md).

## License

MIT — see [LICENSE](LICENSE).
