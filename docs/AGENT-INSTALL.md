# Installing dsh-marker — a runbook for AI agents

You are an AI agent (likely a DSH session, or an assistant with shell access on
the user's machine) asked to set up [dsh-marker](../README.md) for a human.
This runbook tells you what you can do yourself, what only the user can do, and
how to verify each step. Follow it top to bottom; every step names its actor.

## What you are installing

dsh-marker is one product in two halves:

1. **The DSH plugin** (`dsh-marker` on npm). Installs into a DSH profile,
   mounts a local WebSocket bridge on the DSH host's webserver, stores
   annotations under `$DSH_HOME`, and registers the six `annotate_*` tools.
2. **The browser extension** (Firefox / Zen / Chromium). The half the user
   operates: a shortcut enters annotate mode on any page, and the mark —
   text, element, or region, plus a cropped screenshot — travels to the host
   on `127.0.0.1` only.

Both halves must end up on the same machine. You can usually complete the
host half and all verification yourself; the browser half needs the user's
hands (loading an extension into their browser profile is their decision and
their click).

## Ground rules

- **The bridge token is a local password.** It lives in
  `$DSH_HOME/ext-bridge-token` (`~/.dsh` on Linux/macOS,
  `%USERPROFILE%\.dsh` on Windows). Never ask the user to paste it into the
  chat, never echo it into your transcript or logs, never copy it anywhere
  else. The correct handover is: the user opens the file and pastes it into
  the extension popup themselves (Step 4).
- **Do not modify the user's browser profiles** or write into their browser
  configuration. Extension loading happens through the browser's own UI.
- **No local builds as deliverables.** If you need the extension package,
  download the CI-built zip from a GitHub Release — never build one from a
  checkout and hand it over.
- **Store status.** Two listings are live: Mozilla Add-ons (AMO) for Firefox,
  <https://addons.mozilla.org/firefox/addon/dsh-marker/>, and the Edge
  Add-ons listing,
  <https://microsoftedge.microsoft.com/addons/detail/bibpceooggdfoelohhjegicfpilafnec>.
  The Chrome Web Store listing is still under review at the time of writing;
  for Zen and the non-Edge Chromium browsers the manual route below is the
  real one.

## Downloads (release assets, CI-built)

Latest release and assets via the GitHub API:

```
GET https://api.github.com/repos/modenicheng/dsh-annotate/releases/latest
```

Pick from `assets[]` by name pattern (no auth needed for public releases):

| Asset | For |
|---|---|
| `dsh-marker-firefox-<version>.zip` | Firefox / Zen |
| `dsh-marker-chromium-<version>.zip` | Chromium browsers |
| `checksums.txt` | SHA-256 of both |

Direct links for the current release (v1.0.0):

- <https://github.com/modenicheng/dsh-annotate/releases/download/v1.0.0/dsh-marker-firefox-1.0.0.zip>
- <https://github.com/modenicheng/dsh-annotate/releases/download/v1.0.0/dsh-marker-chromium-1.0.0.zip>
- <https://github.com/modenicheng/dsh-annotate/releases/download/v1.0.0/checksums.txt>

Verify the hash before telling the user to install
(`sha256sum -c checksums.txt --ignore-missing`; Windows:
`certutil -hashfile <file> SHA256`).

## Step 0 — Ask, then plan

Ask the user two questions before touching anything:

1. **Which browser** will they annotate in? (Firefox, Zen, Chrome, Edge,
   Brave, … — this decides the Step 3 branch: Firefox and Edge have a
   one-click store install, Zen needs the manual route, the other Chromium
   browsers need the unpacked install plus the shortcut setup.)
2. **Is DSH already installed and running**, and in which profile do they
   normally work (`web`? Desktop app? a named profile)? The plugin must go
   into the profile they actually use, because that is where the bridge and
   the token file appear.

## Step 1 — Install the host plugin (you)

```sh
dsh plugin add dsh-marker
# or, for a specific profile:
dsh plugin --profile <name> add dsh-marker
```

- This needs the npm registry reachable once (the plugin and its single
  dependency `ws` are fetched by pnpm inside the profile).
- DSH checks the plugin's `engines.dsh` requirement (>= 0.2.0) before
  installing; a refusal means the user's DSH is too old — stop and report
  rather than working around it.
- Success looks like: the package resolves and installs without errors, and
  `dsh-marker` appears on the **Plugins** page of the Web UI. If the row is
  there but inactive, ask the user to switch it on (or guide them to it);
  the GUI toggle is not something you can click for them.

If the user prefers no command line at all, the same install works from the
Web UI's **Plugins** page via **Add plugin** (`dsh-marker`); walk them
through it instead.

## Step 2 — Boot the host and verify the bridge (you)

Have the host running on the profile from Step 1 — `dsh web` in a terminal,
or the Desktop app — then verify, without any browser:

1. **The token file exists** (it is written on the first start with the
   plugin active): check `$DSH_HOME/ext-bridge-token` with a plain
   existence test (`Test-Path` / `ls`). Do not print its content.
2. **The bridge answers**: `curl http://127.0.0.1:3080/ext/anno/health`
   returns JSON with the protocol window and counters. This endpoint is
   anonymous and carries no annotation content — safe to call and show.
3. **If port 3080 is not answering**, the host may be on another port
   (Desktop picks a fresh one each launch). Read
   `$DSH_HOME/ext-bridge-endpoint.json` — address only, never a secret —
   and probe `<origin>/ext/anno/health` from it. Do not port-scan.

If the health probe fails on a host that should be running, see
[Troubleshooting](#troubleshooting) before involving the user.

## Step 3 — Install the browser extension (the user; you guide)

You cannot load an extension into the user's browser. For Firefox and Edge
the click-path is the store listing; otherwise give the user the package
link for their browser (table above), have them verify or trust the
checksum, then hand them the exact click-path:

**Firefox** — simplest path: the
[Mozilla Add-ons listing](https://addons.mozilla.org/firefox/addon/dsh-marker/)
is live, so have the user install from there (permanent, auto-updating). No
zip, no checksum step.

**Zen, or anyone on the release zip** — the release zip is unsigned, so it
loads as a temporary add-on (it disappears on browser restart until
reloaded; say so up front):

> Open `about:debugging#/runtime/this-firefox` (Zen: `about:debugging`),
> click **Load Temporary Add-on…**, and pick `manifest.json` from the
> unzipped folder.

Firefox Developer Edition / Nightly / ESR users can install permanently
(`xpinstall.signatures.required` = `false` in `about:config`, rename the zip
to `.xpi`, then `about:addons` → gear → **Install Add-on From File…**).

**Chromium, Edge** — simplest path: the
[Edge Add-ons listing](https://microsoftedge.microsoft.com/addons/detail/bibpceooggdfoelohhjegicfpilafnec)
is live, so have the user install from there (permanent, auto-updating). If
`Alt+Shift+A` does nothing afterwards, one visit to
`edge://extensions/shortcuts` (see the shortcut step below) fixes it.

**Chromium, others (Chrome, Brave, Vivaldi, Opera, Arc)** — permanent, two
steps:

> 1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
>    select the unzipped folder.
> 2. `chrome://extensions/shortcuts` → find **Annotate the current page** →
>    assign `Alt+Shift+A` (or their preference).

Step 2 is not optional cosmetic setup: on Chromium only a browser-registered
shortcut grants `activeTab`, and without it marks are sent without their
screenshot. Make sure the user actually does it, and remind them the
developer-mode notice and manual updates are the known costs of an unpacked
install.

## Step 4 — Token handover (the user; you direct, you do not touch)

Tell the user, in one message:

- Open `$DSH_HOME/ext-bridge-token` (`%USERPROFILE%\.dsh\ext-bridge-token`
  on Windows) in any text editor.
- Click the dsh-marker toolbar icon, paste the content into the **Token**
  field.
- Leave **Connection** on **Automatic** and the address at the defaults
  (`127.0.0.1` / `3080`), press **Save and connect**. Automatic also finds
  hosts on non-default ports (Desktop), so the defaults are right even there.

Then ask them to confirm the popup's status line reads **Connected** with the
host address. If they report an error instead, go to Troubleshooting — the
error text maps to causes.

## Step 5 — Verify end to end (you)

If you are a DSH session on that host, the plugin's tools are now available
to you — use them as the verification:

1. `annotate_list` returning an empty result (not an error) proves the
   plugin is loaded and the store answers.
2. Optionally, `annotate_pick` with a short timeout proves the reverse
   direction: a banner appears in the user's browser, they point at
   something, and you receive the annotation with its screenshot. Announce
   the banner to the user before calling it, and treat a timeout as a skip,
   not a failure.
3. Ask the user to press `Alt+Shift+A` on any page, mark a paragraph, and
   send it; you should see the annotation arrive via `annotate_list`. Then
   `annotate_resolve` it and let them watch the page badge turn resolved.

If you are not inside DSH, verify with the Step 2 health probe and the
user's report of **Connected**.

## Troubleshooting map

| Symptom | Likely cause | You do |
|---|---|---|
| Health probe fails on 3080 | host not running, other profile, or non-default port | check `$DSH_HOME/ext-bridge-endpoint.json`; confirm the profile; retry |
| Plugin row missing | install went to another profile | reinstall with `--profile <name>` |
| Popup: *Cannot reach the host* | host down, or browser started before the host | **Scan again**; import the endpoint file; then Manual as last resort |
| Popup: token rejected | stale token (host regenerated it) | have the user re-copy `$DSH_HOME/ext-bridge-token` |
| Marks arrive without screenshots (Chromium) | browser shortcut not assigned / mismatched | re-point the user to `chrome://extensions/shortcuts`, or **Annotate this page** |
| *The extension did not answer* | popup newer than the loaded extension | user reloads the extension in `about:debugging`, refreshes the page |
| Extension gone after restart (Firefox) | temporary add-on behavior | expected; reload, or move to a permanent route (Step 3) |
| Version mismatch between halves | one side updated, other stale | `dsh plugin update dsh-marker` + newest extension zip; small gaps are tolerated by the protocol window by design |

## Updating later

- Plugin: `dsh plugin update dsh-marker` (the **Plugins** page offers the
  same). Registry-installed packages get update offers.
- Extension: Firefox (AMO) and Edge installs update themselves through the
  store; download the next release zip and replace the unpacked folder
  (other Chromium), or reload the temporary add-on (a manual Firefox/Zen
  install).
- The connection negotiates a protocol window (`MIN_PROTOCOL` ..
  `PROTOCOL_VERSION`), so a small version gap between the halves keeps
  working; when either side reports the other as too old, update both.

## What success looks like

- `dsh-marker` enabled on the DSH **Plugins** page;
- `/ext/anno/health` answering on the host;
- the popup reading **Connected**;
- one test annotation making it into a session, and one `annotate_pick`
  round trip (optional).

Report those four to the user and you are done.
