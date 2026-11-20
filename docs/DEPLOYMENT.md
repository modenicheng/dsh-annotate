# Deployment notes

How the extension reaches the host in the common cases, and what changes when
the deployment is not the default one. The design rationale for discovery is in
[DISCOVERY.md](DISCOVERY.md); rejected alternatives are D20–D22 in
[DECISIONS.md](DECISIONS.md).

## `ws://` or `wss://`: the host decides

A stock local install is plain HTTP on loopback, so the extension must reach it
with `ws://` and `http://`. Two things keep that working:

- **The extension's page CSP must not upgrade insecure requests.** Firefox's
  MV3 default extension policy is
  `script-src 'self'; upgrade-insecure-requests;`, and that directive rewrites
  the bridge's `ws://` to `wss://` (and its `http://` health probe to `https://`)
  before any of our code can intervene. `manifest.json` therefore declares an
  explicit `content_security_policy.extension_pages` without it, and
  `node scripts/check-manifest.mjs` fails if that declaration ever disappears or
  brings the directive back.
- **The scheme is negotiated, not guessed.** Before connecting, the extension
  reads `/ext/anno/health`, which reports `secure` and a complete `wsUrl` derived
  from how the request reached the host: a TLS socket or a TLS-configured DSH
  webserver yields `wss://`; a request forwarded by a TLS-terminating reverse
  proxy (with `X-Forwarded-Proto: https`) yields `wss://` too; anything else
  yields `ws://`. On a plain host the probe goes to `http://` and the answer is
  `ws://`, so the default path is unchanged. The extension opens the advertised
  URL and only falls back to the address saved in the popup when the probe
  cannot reach the host at all.

The popup accepts a bare host and port (`127.0.0.1` + `3080`, the pre-existing
shape, kept so old settings keep working) or a whole URL
(`wss://anno.example.com`). A typed scheme is an explicit override for setups
where the probe is unavailable; leaving it out is the normal case.

## Desktop, and a port that moves

DSH Desktop composes the same Web bundle, but its launcher chooses the port, so
the default `127.0.0.1:3080` is wrong on every launch. That is handled: a host
whose port moves publishes where it is, and the extension finds it.

The answer splits the two questions the popup used to answer by hand
([DISCOVERY.md](DISCOVERY.md)):

- **Where is it now?** When the port is not `3080`, the host opens a loopback
  *locator* on `30810–30812` that answers one `GET /ext/anno/locate` with its
  origin — no token, no annotation data. On start the host also writes
  `$DSH_HOME/ext-bridge-endpoint.json` with the same address, for manual entry,
  tooling, and the cases the locator cannot cover. A fresh install starts in
  **Automatic** mode: one round probes the three locator ports plus the default
  `3080`, ranks the answers, verifies the chosen one against
  `/ext/anno/health` (the `instanceId` must agree), and connects. A host that
  answered last is remembered for twelve hours, so a restart usually costs one
  health probe. **Manual** mode is exactly the old behaviour, and a typed
  address in Automatic mode is treated as an explicit override. The popup also
  imports the record file and lists the hosts it found, so a wrong pick is
  correctable. The scheme stays the host's decision, as above.
- **Which host may I talk to?** Unchanged: the bridge token, pasted once from
  `$DSH_HOME/ext-bridge-token`. The token is not copied into any other file —
  the extension cannot read files anyway, and a second copy would only add a
  thing to rotate and leak.

Nothing in the bridge changes: the locator publishes an address, the websocket
stays the only data path, and a stock `dsh web` on `3080` behaves exactly as it
does today.

## Behind an HTTPS reverse proxy

TLS terminates at the proxy, so the proxy must **forward upgrades** and tell the
host the original scheme:

```nginx
location /ext/anno {
  proxy_pass http://127.0.0.1:3080;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
}
```

`X-Forwarded-Proto` is what makes health answer `wss://`; without it the host can
only advertise `ws://`. The upgrade route itself is scheme-independent: it reads
no forwarding header and no `Origin`, so a proxy that terminates TLS is invisible
to the handshake, and the bridge token remains the only admission check. The
extension's `host_permissions` cover loopback only (`http(s)://127.0.0.1/*`,
`ws(s)://127.0.0.1/*`, and the `localhost` forms); a host reached through a
public domain needs that origin added to the manifest before the extension may
probe or connect to it.
