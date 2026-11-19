# Discovery — finding a host whose port moves

**Status: M4.5a implemented, M4.5b–c planned.** The host publishes: it writes
the endpoint record on every start and, when its bound port is not `3080`,
serves the locator. The extension does not read either yet, so the popup still
needs `host:port` and a pasted token, and still assumes `127.0.0.1:3080` when
nothing is typed.

## 1. The problem is two questions

`dsh web` serves the bridge on `127.0.0.1:3080` by default, which is also the
address the popup assumes. DSH Desktop composes the same Web bundle
(`@deepseek-ai/dsh-web-app`, as the `desktop` profile's `package.json` shows),
but its launcher chooses the port, so the bridge moves on every launch. Two
different questions follow, and they should not be answered by one channel:

- **Where is the host now?** Changes per launch. Needs a rendezvous.
- **Which host may I talk to?** The bridge token. Stable, handed over once.

The address is effectively public on a machine — any local process can list
listening ports — while the token is the only admission check. So the address
may be published anonymously; the token may not.

## 2. What the browser can actually do

A WebExtension cannot read files, listen on a port, enumerate processes, or use
local IPC. It has exactly three ways to reach a local host:

1. HTTP/WS to an address it already knows (host permissions are already in place
   for every port on `127.0.0.1` and `localhost`);
2. read a file **the user picks** in a file input or drops on the popup;
3. talk to a **native-messaging host** installed separately on the machine.

Everything below uses (1) for discovery and (2) only to let the user read an
address from a record they pick. (3) is deliberately out of scope: it is the
only way to automate the token handover, and that is not a cost this project
takes on (§15).

## 3. Direction 1, narrowed: a locator, not a proxy

"Start a proxy when the port is dynamic" is right about the shape (a fixed
address that never changes) and wrong about the payload. What the extension
needs is an address, not a second data path.

### Why not a websocket proxy

A fixed-port proxy would accept the extension's upgrade, dial the real bridge,
inject the token into a synthesized `hello`, and shuttle frames both ways. That
is a second implementation of the same wire protocol — close codes, ping/pong,
the 32 MiB cap, backpressure, the attachment size limits — sitting on the
critical path, with its own failure modes and its own debugging surface. The
token would also have to live in the proxy process, and the proxy would need a
client check of its own (`Origin` sniffing) because it cannot be authenticated
by the token it is holding.

### Why not a second bridge listener

Mounting the same bridge on a second `node:http` server avoids the relay but
duplicates the routes: `/ext/anno/health`, the upgrade, and every future route
under `/ext/anno/*` would exist twice, and the "one listener, one route table"
property in D2/M1 would be gone. The locator costs about sixty lines and none
of that duplication.

### What a locator is

One tiny HTTP listener on loopback, owned by the plugin, answering exactly one
GET with the host's current origin. It carries no annotation data, no token, and
no websocket. If it is down, discovery degrades to manual; nothing else breaks.

## 4. Direction 2, completed: a record with a reader

Writing the current port to a file is right, but a file alone does not drive
the browser: nothing in the extension can open it. The record needs a reader,
and the cheapest reader that requires no installation is **the user**, through
the popup's file picker — or the scripts that already run against a booted host.

The record answers **where**, never **whether**: the token is not in it. It is
the address-only counterpart to the locator, useful exactly when the locator is
unavailable (all three ports taken, a non-loopback bind) and for tooling, tests,
and support sessions. Pairing stays what it is today: the token is pasted once
from `$DSH_HOME/ext-bridge-token`, the one file on the host that holds it.

The record is a snapshot, never authority: whatever it says is verified against
`/ext/anno/health` and the `hello` handshake before it is trusted.

So the split is:

| Artifact | Answers | Written | Consumed by |
|---|---|---|---|
| `ext-bridge-endpoint.json` | where the host is (origin only) | every start, atomically | popup file import, scripts, humans |
| `ext-bridge-token` | whether the browser may connect (token) | once, on first run | the user, once, pasted into the popup |
| locator | where the host is now | while the plugin is loaded | extension background, on every cold connect |

The token keeps exactly one home on the host. That is a deliberate limit: the
extension cannot read files, so every automatic handover would need a
native-messaging host installed per browser and per OS, and a second copy of
the secret in a JSON file would buy nothing without one while adding a thing to
rotate, audit, and accidentally share.

## 5. The locator

### Constants (protocol, copied to both halves)

| Name | Value | Notes |
|---|---|---|
| `LOCATE_PATH` | `/ext/anno/locate` | exact path; `GET` only |
| `LOCATE_PORTS` | `[30810, 30811, 30812]` | tried in order; first free wins |
| `LOCATE_HOST` | `127.0.0.1` | IPv4 loopback only |
| `ENDPOINT_FILE` | `ext-bridge-endpoint.json` | beside `TOKEN_FILE` in `$DSH_HOME` |

The ports sit just above the project's default `3080` and below every OS
ephemeral range (Linux `32768+`, Windows and macOS `49152+`), so the OS is
unlikely to hand one of them to some other service. Three ports exist because a
port can be taken by an unrelated process, an excluded range, or another DSH
instance; with three, two live instances still both get one.

### Response

`GET /ext/anno/locate` → `200 application/json`:

```json
{
  "app": "dsh-annotate",
  "version": 1,
  "instanceId": "9f1c0b7a5e2d4c31",
  "origin": "http://127.0.0.1:51234",
  "wsUrl": "ws://127.0.0.1:51234/ext/anno",
  "startedAt": "2026-11-19T13:59:00.000Z",
  "focusAt": "2026-11-19T14:03:11.000Z",
  "profile": "desktop"
}
```

- `version` is `PROTOCOL_VERSION`; a client ignores an unknown version.
- `instanceId` is 16 lowercase hex characters, fresh per process. It is what
  ties a locator answer to a health answer (§7).
- `focusAt` is the time of the latest Client focus report, or `null`. It is the
  ranking signal for multi-instance hosts (§8); it never carries a Session id.
- `profile` is a display hint derived from `profileContext.dir` when the host
  exposes one, otherwise `null`.
- `app` is the discriminator. A port that answers something else is ignored.

### Rules the handler must enforce

- **Loopback only.** Bind `127.0.0.1`; never the webserver's configured host.
- **`GET` only.** `405` with `Allow: GET` for anything else, including `HEAD`.
- **Host allowlist.** `Host` must be `127.0.0.1[:port]` or `localhost[:port]`;
  anything else is refused with `403`. This is the DNS-rebinding fence: a page
  that rebinds its name to loopback sends its own host in `Host` and is refused.
- **No CORS.** Do not send `access-control-allow-origin`. An extension with
  host permission reads the body anyway; a web page cannot.
- **No state.** No side effects, no counters, no query-string handling.
- **`cache-control: no-store`, `x-content-type-options: nosniff`.**
- Everything else is `404`. No directory listing, no health mirror.

### Lifecycle

Started from the plugin's `ctx.inject(['webServer'], …)` callback once
`webServer.port` is a number and the bind address is IPv4 loopback. On the
shipped loader the callback runs after the providing fiber is active, which is
after `listen` resolved; the plugin still asserts `typeof port === 'number'` and
logs rather than throwing if a future loader changes that. It is closed and
unregistered by the same effect's disposer, before the webserver closes. A
failed bind on every port logs one warning and leaves the host discoverable only
through the record and the default port; it never fails the plugin.

## 6. The endpoint record

Path: `$DSH_HOME/ext-bridge-endpoint.json` (next to `ext-bridge-token`).

```json
{
  "version": 1,
  "app": "dsh-annotate",
  "instanceId": "9f1c0b7a5e2d4c31",
  "pid": 23144,
  "profile": "desktop",
  "origin": "http://127.0.0.1:51234",
  "wsUrl": "ws://127.0.0.1:51234/ext/anno",
  "startedAt": "2026-11-19T13:59:00.000Z"
}
```

- **No secret.** The record never contains the token; it is no more sensitive
  than the origin, which `netstat` already shows. The token stays in
  `ext-bridge-token`, and `hello` is the only thing that reads it.
- **Written** on every start, after the listener is bound. **Removed** on clean
  shutdown, but only if the file still carries this process's `instanceId` (two
  profiles share `$DSH_HOME`; the last writer wins and must not be deleted by an
  older instance shutting down).
- **Atomic**: write `ext-bridge-endpoint.json.<pid>.tmp` in the same directory
  with mode `0600`, then `rename` over the target. On Windows a rename over an
  open file can fail with `EPERM`; retry once, then write in place and log.
- **Permissions**: `0600` on POSIX (asserted by a test), inherited ACL under the
  user profile on Windows — the same treatment as the token file, for
  consistency rather than because the content needs it.
- **Failure is non-fatal**: a read-only home logs a warning; discovery by
  locator still works.

## 7. The extension's resolution chain

New background module `src/background/discovery.js` (classic script, added to
`background.scripts` after `endpoints.js` and before `socket.js`), plus a call in
`socket.js`'s `attempt()` where the configured address is normalized today.

A new preference, `connection: 'auto' | 'manual'`, with the popup showing it:

- `manual` — exactly today's behaviour; the typed host/port always wins. This is
  the stored default for installs that predate the feature.
- `auto` — the default for fresh installs. Empty address fields mean "find it";
  a typed address is still treated as a manual override.

`auto` resolves in this order, stopping at the first host that completes the
health probe:

| # | Step | Cost | Notes |
|---|---|---|---|
| 1 | stored last-good address (`anno.address`, TTL 12 h; separate from `anno.endpoint`, which caches the scheme answer) | one health probe | used when health answers and its `instanceId` matches the stored one, or none was stored |
| 2 | one discovery round: the three locator ports in parallel **plus** `127.0.0.1:3080` | ≤ 500 ms | a locator answer must be `app: dsh-annotate`, name a loopback origin, and its `instanceId` must equal the health answer at that origin; the 3080 host qualifies on health alone |
| 3 | nothing answered | — | `no-host` status, the address hint, and a retry in the existing backoff |

Rules:

- **Health stays the authority for the scheme** (D8). The locator only supplies
  a candidate origin; the `ws://` vs `wss://` decision is unchanged.
- **The default port is a candidate, not a fallback.** A stock `dsh web` on
  `3080` and a Desktop host are discovered in the same round and ranked by the
  same rules (§8), so having both open does not depend on probe order.
- **`instanceId` must match between locator and health.** A stale locator answer
  or a different process reusing the origin is dropped instead of connected to.
- **A typed address is an explicit override.** When `host`/`port` differ from the
  default pair, auto is skipped and the popup's fields are used exactly as today.
- **A rejected token (close 4403) stops discovery**; it is a token problem, not
  an address problem, and trying other instances only hides it. The hint names
  `$DSH_HOME/ext-bridge-token`, which is still the only place it lives.
- **Retries re-run the chain** unless the stored address answers; the existing
  backoff (1 s → 30 s) already covers "DSH is still starting".
- **Nothing new in the manifest.** `http://127.0.0.1/*` already covers every
  port; no `nativeMessaging` permission is added by this phase.

New `netState` fields so the popup and the status line can explain themselves:

```
discoveryMode:     'auto' | 'manual'
discoverySource:   'manual' | 'cached' | 'locator' | 'default'
discovered:        [{ origin, instanceId, profile, startedAt, focusAt }]
discoveryFailures: [{ port, error }]
```

### Popup

- A **Connection** control: `Automatic (recommended)` / `Manual`.
- **Import endpoint file…** — a file input (and drop target) that reads
  `ext-bridge-endpoint.json`, validates it, and seeds the last-good address with
  the file's origin and `instanceId` so the next attempt tries it first. The
  host and port fields are filled for manual use; the connection mode is left as
  it was. It never touches the token field: the record has no token, and the
  token is still pasted once from `$DSH_HOME/ext-bridge-token`.
- A **Discovered hosts** list, only when more than one instance answers: profile,
  origin, relative `focusAt`, and a **Use this host** action that stores the
  choice as `preferredInstanceId`.
- Status line shows the source, e.g.
  `Automatic · 127.0.0.1:51234 (desktop) · 2 hosts found`.
- When nothing answers: an actionable sentence plus **Scan again**, and a hint
  that a default-port host is tried first and that the address can be imported
  from `ext-bridge-endpoint.json`.

## 8. Multi-instance

Two hosts can be live at once: Desktop plus a CLI `dsh web`, or two `--port 0`
profiles. The extension picks one, in this order:

1. `preferredInstanceId` — an explicit choice made with **Use this host**;
2. `lastInstanceId` — the instance that was connected last, for continuity;
3. the most recent `focusAt` within the six-hour focus TTL (`FOCUS_TTL_MS`);
4. the most recent `startedAt`;
5. locator port order (30810 before 30811 before 30812), then the default 3080.

A preference is scoped to one process: a host restart produces a new
`instanceId`, so the choice is made again by the rules above. A dead preference
is ignored rather than remembered, which is why a Desktop restart does not need
the user to touch the popup. The connected profile is always visible in the
status line, which is what makes a wrong pick correctable.

Two *users* on one Linux machine see each other's locators, because loopback is
machine-wide. That is the same information `ss -ltn` already exposes. Their
tokens differ (separate `$DSH_HOME`), so the handshake closes the connection and
nothing crosses.

## 9. The trigger is the port, not the product

The plan does **not** detect "is this the Desktop app". Desktop is only one way
to end up on an unusual port; `--port 0`, `--port 8123`, and a profile
whose `webserver.port` was edited are the same problem, and a Desktop marker
would be an undocumented dependency that breaks silently when it changes.

The locator starts when all of these hold:

1. `webServer.port` is defined (the listener bound);
2. the bind address is IPv4 loopback;
3. the port is not `3080`;
4. the plugin config `discovery` is not `off` (default `auto`).

A profile turns the listener off without losing the record:

```yaml
- id: dsh-annotate
  config:
    discovery: off
```

The record is written in **every** case, including `3080` and non-loopback
binds, because it is the manual and diagnostic path, not the discovery path.
Non-loopback binds log that automatic discovery is unavailable (the extension
has no permission for those origins) and rely on the record/manual route.

`dsh --profile <name> --port 0` is also the test harness for the whole feature
on any OS: it reproduces Desktop's moving port without installing Desktop.

## 10. Cross-platform

| Concern | Windows | Linux | macOS |
|---|---|---|---|
| `$DSH_HOME` | `%USERPROFILE%\.dsh` | `~/.dsh` | `~/.dsh` |
| Record permissions | inherited ACL under the profile; `mode` is ignored | `0600`, asserted in a test | as Linux |
| Atomic rename | `MoveFileEx`; may fail `EPERM` under an open handle or AV — retry once | `rename(2)` | as Linux |
| Locator bind | `127.0.0.1:30810-12`; no firewall prompt for loopback; Hyper-V/WSL may exclude ranges | loopback; visible to `ss -ltnp`; shared across users | as Linux |
| `localhost` vs `::1` | 127.0.0.1 | `localhost` may resolve to `::1`; discovery always uses `127.0.0.1` | as Linux |
| File import in the popup | file dialog / drop | file dialog / drop | file dialog / drop |

IPv6 loopback (a host bound to `::1`) is **not** auto-discovered: the locator
binds IPv4 and the extension's permissions cover `127.0.0.1`/`localhost`. Such a
host uses the record or a manual address. This is a documented limitation, not a
silent failure: the popup's failure text names the address it tried.

macOS shares the Linux code paths but has no test environment here; it stays
"expected to work, unverified" until someone runs the checklist.

## 11. Failure modes

| Symptom | Cause | Behaviour |
|---|---|---|
| `locate` answers 404 | something else owns 30810 | next port; the extension ignores a non-DSH answer |
| no locator at all | all three ports taken, or `discovery: off`, or non-loopback bind | log warning; the record and manual entry still work |
| stale record | process killed | health probe fails; discovery resolves the live origin; the file is a hint |
| record from another profile | two instances, last writer wins | the imported address may be wrong; health rejects it and discovery resolves the live origin |
| two instances live | ranking | both are candidates; the popup lists both; the choice is fixable |
| token rejected (4403) | re-pasted from another home, or the profile's token changed | stop, show the token-file hint |
| host started after the browser | race | the existing backoff retry re-runs the round |
| host on 3080 plus a Desktop host | both live | both are candidates in one round; ranking decides; the popup shows both |

## 12. Security

The locator is a new unauthenticated surface and is designed to be worthless to
an attacker:

- it reveals an origin, a random per-process id, two timestamps, and a profile
  label — all of which are already visible to any local process;
- it serves no token, no annotation, no session id, and no image;
- it is `GET`-only and stateless, so a blind cross-site request achieves nothing;
- no CORS header means a web page cannot read the answer; the `Host` allowlist
  defeats DNS rebinding, which is the one way a page could otherwise read it;
- it binds IPv4 loopback only.

The endpoint record is not secret either: it carries the origin and timestamps,
which is what `netstat` already shows. The token has exactly one home,
`$DSH_HOME/ext-bridge-token`; nothing in this phase copies it, serves it, logs
it, or asks the user to move it. The practical trust boundary is therefore
unchanged: anyone who can read that file can already act as the user locally,
and the plugin's only use of it remains the constant-time `hello` comparison.

## 13. Testing

**Unit — plugin** (`packages/plugin/test/discovery.test.js` for the record and
the trigger matrix, `packages/plugin/test/locator.test.js` for the listener):

- record written atomically, `0600` on POSIX, removed on dispose, left alone
  when another `instanceId` wrote it, non-fatal on a read-only directory;
- locator: `GET` shape, `405` on `POST`, `404` elsewhere, foreign `Host`
  refused, no `access-control-allow-origin`, `no-store`, origin/instanceId
  correct, port fallback when the first port is occupied, closed on dispose;
- trigger matrix: 3080 → no locator; 3081 → locator; `--port 0` → locator;
  non-loopback → no locator; `discovery: off` → no locator.

**Unit — extension** (`packages/extension/test/discovery.test.js`, `node:vm`
like `endpoints.test.js`, everything pure):

- `parseLocate` rejects a non-DSH body, a non-loopback origin, a wrong version;
- `rankCandidates` covers preferred id, focus TTL, start time, port order;
- `parseEndpointRecord` accepts the documented shape, ignores unknown fields
  (including a stray `token`, which is never surfaced to the importer), and
  rejects a non-loopback origin;
- `planResolution` returns the expected order and short-circuits on manual.

**Integration** (`scripts/smoke-discovery.mjs`, manual like `smoke-ws.mjs`):

1. read `$DSH_HOME/ext-bridge-endpoint.json`, assert `0600` on POSIX and that no
   field matches a 64-hex token;
2. probe all three locator ports, assert one answers with the record's
   `instanceId` and that no field contains the token;
3. probe `/ext/anno/health` at the record's origin; assert the two ids match;
4. assert the locator refuses a foreign `Host` header, a `POST`, and a `HEAD`.

**Manual matrix** (the two platforms that can be run here):

| # | Scenario | Windows | Linux |
|---|---|---|---|
| 1 | `dsh --profile anno --port 0`, fresh extension, paste the token once, connect | | |
| 2 | restart the host twice; reconnect within 10 s with no user action | | |
| 3 | two `--port 0` hosts; popup lists both; focus decides; **Use this host** sticks | | |
| 4 | occupy 30810 before start; locator moves to 30811 | | |
| 5 | `kill -9` the host; stale record; next start repairs it | | |
| 6 | `dsh --profile anno` on 3080: no locator, default path unchanged | | |
| 7 | `--port 8123`: locator starts, discovery works | | |
| 8 | record permissions and content (no token, correct origin) | ACL | `0600` |
| 9 | Desktop app: enable the bundle through the app's Plugins page (the CLI refuses the `desktop` profile), restart the app, auto-connect after the one-time token paste | | n/a |

## 14. Phases and acceptance criteria

**M4.5a — Host publishes.**
Record + locator + `instanceId` in health + protocol constants + tests.

- `dsh --profile anno --port 0` writes the record with the bound port and starts
  a locator on 30810; `curl -H 'Host: 127.0.0.1:30810'
  http://127.0.0.1:30810/ext/anno/locate` answers the documented body; the same
  request with `Host: evil.example` is refused with `403`.
- Neither the locator body nor the record contains a 64-hex token.
- A default `dsh --profile anno` on 3080 starts no locator and still writes the
  record.
- Shutdown removes the listener and the record; `pnpm run check` stays green;
  `smoke-ws.mjs` still passes.

Delivered on Windows against `dsh --profile anno --port 0 --no-open`: the
record carried the OS-assigned port (`http://127.0.0.1:15195`), the locator
answered on `30810` with the same `instanceId` as `/ext/anno/health`, and
`scripts/smoke-discovery.mjs` reported all 29 checks — including the `403` for a
foreign `Host` and a rebinding name, the `405` for `POST` and `HEAD`, the `404`
for any other path, the absence of a CORS header, and the absence of anything
token-shaped in either answer. The unit tests carry the rest: atomic write,
`0600` on POSIX, `EPERM` retry, removal on dispose only for the owning
`instanceId`, the trigger matrix, and the locator's disposal. A host killed with
`SIGKILL` leaves its record behind, which is the documented stale-record case
(§11) rather than a bug; only a clean shutdown removes it. With
`discovery: off` in the profile patch, a booted host still wrote its record and
answered on none of the three ports.

**M4.5b — Extension discovers.**
Auto mode, chain, ranking, cache, popup import + list + status, error copy,
unit tests.

- With the token pasted once and the host restarted twice on new ports, the
  extension reconnects within 10 s without user action.
- With two live hosts, the most recently focused one is chosen; the popup lists
  both, and **Use this host** sticks across an extension reload.
- Manual mode is byte-for-byte today's behaviour (`endpoints.test.js` and
  `boot.test.js` unchanged).
- A missing token shows the token-file hint; importing a record fills the
  address and never the token field.

**M4.5c — Verification and documentation.**
Windows and Linux matrix above, plus a real Desktop run on Windows; README,
`DECISIONS.md`, `docs/PLAN.md`, and `DETAIL.md` updated; `smoke-discovery.mjs`
in the developer section.

## 15. Out of scope, deferred, and rejected

**Designed out — native messaging.** It is the only way to hand the token over
with no paste, and it is deliberately not pursued: the token has one home and
stays a one-time manual step. The cost that would come with it is real — a host
manifest per browser and per OS (Firefox registry key on Windows,
`~/.mozilla/native-messaging-hosts` on Linux, Application Support on macOS), a
runner spawnable as an executable, and store-review justification. A future
decision could revisit it; it would not need anything from this phase except the
record (an origin), because the token file is already readable by a local host
process.

**Deferred — a GUI-page beacon.** The Web bundle could inject
`<meta name="dsh-annotate-host" content="<origin>">` into the index and a
content script could report it, giving free discovery whenever the DSH UI is
open in the same browser. It is cheap and self-authenticating (only accept the
beacon when `location.origin` equals the advertised origin), but it does nothing
for Desktop, where the UI is an Electron window. Low priority.

**Deferred — IPv6 loopback discovery.** §10.

**Rejected — scanning a port range.** A bounded sweep of plausible ports is the
only fully generic answer, but the OS assigns from a range of roughly 16k to 28k
ports, so the sweep is either huge or useless; it also looks exactly like the
behaviour store reviewers flag. Hard no.

**Rejected — `file://` fetch.** Extensions cannot read local files without a
user pick (and the grant that would allow it is broad, origin-opaque, and
unavailable on Firefox). Not a path.

**Rejected — a token-bearing record or import.** A second copy of the token in
a JSON file would only help if the extension could read it; it cannot, so the
copy would be pure liability. The single source is the point.

**Rejected — asking Desktop to publish the port.** The launcher is outside this
repository, and depending on it would make CLI `dsh web` a second-class case
forever. The plugin can publish what the launcher already bound.

**Rejected — proxy / second bridge.** §3.
