# RemoteDSH

English | [中文](README.zh.md)

Remote session bridging for DSH. One machine runs as a **server** and exposes its session records read-only; another runs as a **client**, connects to it, and **mirrors those remote sessions into its own Workspace as ordinary sessions** — no custom UI is written. The sidebar, session list, and conversation view are all the native ones.

## Where to configure

**UI (recommended)**: sidebar **Plugins → Installed → View dsh-remote-bridge → Configure dsh-remote-bridge**.

The page edits the run mode, the server switch / listen address / port / machine name / token / password / visible sessions / working-directory scope, and the client switch plus the remote list (add, edit, remove id, label, address, token). Saving writes to `$DSH_HOME/profiles/web/cordis.patch.yml` and reports that a restart — or toggling the plugin off and on — applies it.

**File**: the `config` of the `remote-bridge` row in `$DSH_HOME/profiles/web/cordis.patch.yml`; its fields mirror the form one-to-one.

> The form projects only the fields a plugin declares `.volatile()`, and this plugin marks all of them, so the `mode`, `server`, and `client` subtrees are all editable.
> If a higher-precedence layer (a `--patch` overlay or a home patch) overrides the same row, saving is refused with `overridden by a home patch or command-line overlay` — edit that layer instead.

| What | Field | Notes |
| --- | --- | --- |
| Listen address | `server.host` | `0.0.0.0` exposes the LAN; `127.0.0.1` keeps it local |
| Listen port | `server.port` | defaults to `4590` |
| Advertised machine name | `server.name` | shown to clients as “on \<name\>”; defaults to the hostname |
| Server authentication | `server.auth.token` / `server.auth.password` | empty disables the check (a warning is logged) |
| Remote to connect | `client.remotes[].url` | `http://<ip>:<port>`, `ws://<ip>:<port>`, or `<host>:<port>` |
| Client credentials | `client.remotes[].token` / `password` | must match the server |
| Client-side label | `client.remotes[].label` | Workspace title prefix, e.g. “Office” |

Reload the plugin (or restart DSH) to apply.

## Connection monitor (server side)

At the top of the same configuration page sits a **Connection monitor** that refreshes every 5 seconds:

- **Inbound peers**: machine name, source IP:port, authenticated identity, client and protocol versions, visible session count, connect time, duration, last activity, history-read count, and a **Disconnect** button.
- **Outbound links**: label, address, status (online / connecting / offline / authentication failed), remote machine name, visible session count, connect time, last activity, and the failure reason when there is one.
- **This machine**: hostname, platform, listening state, and `host:port`.

The data is read through DSH's **owner-only Fetch routes** (`/api/remoteBridge/status`, `/api/remoteBridge/disconnect`) over the page's own cookie: a caller that is not the owner is refused with 403 before the handler runs, so **no** management endpoint is opened on the 4590 bridge port. Disconnecting is a soft drop — a peer configured to reconnect will come back.

## Client-to-client relay

A session one client shares can be read by other clients **through the server**; the two clients never connect to each other.

All three switches are required:

| Where | Field | Effect |
| --- | --- | --- |
| Server | `server.relay.enabled` | whether this hub lets clients relay at all |
| Sharer | `client.share.enabled` | whether this machine offers its sessions |
| Reader | `client.relay.enabled` | whether this machine reads what others share |

**The sharer decides the scope** (under “Session sharing (relayed through the server)”):

- `client.share.sessions` — `*`, or a comma-separated list of session ids
- `client.share.cwdPrefixes` — share only sessions under these directories (one prefix per line)
- `client.share.consumers` — which clients may look (one machine name per line); **empty means any authenticated client**

The sharer filters **locally** first, so the server only ever receives what it agreed to share, and then re-checks the same scope — a mistake on either side cannot leak data. Subagent sessions and already-mirrored sessions (`session-rb-*`) are never relayed: the latter would carry a third machine's records past the grants on the way here.

A reader sees a read-only mirror in its own Workspace, titled “peer · via label” (the peer's machine name and the remote's label). History requests and live events for a relayed session both travel through the server, which only routes them — it persists and caches no event content.

### How a permission change takes effect

Editing the share scope (sessions / directories / allowed peers / the share switch) makes the sharer **re-announce its catalogue immediately**, without waiting for the next 5-second poll:

1. The sharer sends `publish` with a `full` flag and the new `share` scope;
2. The server replaces that peer's grant and catalogue, then diffs its bookkeeping per subscriber — **a consumer that lost access receives `relay/sessions` with `gone: true`**, drops the mirror at once, and gets `forbidden` on later history requests;
3. A consumer that just gained access receives the new catalogue;
4. Turning sharing off (`client.share.enabled: false`) broadcasts an empty catalogue, which withdraws it from every reader.

When the configuration page saves and any share field changed, it also calls “Re-broadcast share” so the edit applies on the spot instead of after a restart. Restarting later reads the same values from the file.

Two manual buttons sit at the top right of the monitor:

- **Re-broadcast share** — push this machine's catalogue to every connected server now (the same action a permission edit triggers).
- **Re-pull shared** — send `relay/sync`; the server first asks each sharer to re-announce (sending `relay/pull` to peers that negotiated `relay.refresh`), then answers with the current catalogue.

## Protocol and capability negotiation

The handshake reports what each side supports, and the server enables only the **intersection**:

```json
{ "t": "hello", "v": 3, "client": { "name": "laptop", "version": "0.6.0" },
  "features": ["sessions.read", "history.read", "relay.publish", "relay.refresh", "relay.subscribe"],
  "share": { "enabled": true, "sessions": "*", "cwdPrefixes": [], "consumers": ["desktop"] } }
```

`welcome` answers in the same shape: `features` (negotiated), `featuresSupported` (the server's full set), and `relays` (readable sharers with their session lists).

| Capability | Meaning |
| --- | --- |
| `sessions.read` / `history.read` | baseline reads (always present; declared so a future build can drop one) |
| `relay.publish` | this side may publish sessions as a sharer |
| `relay.refresh` | re-announce on a permission change, and re-announce on request (`relay/pull`) |
| `relay.subscribe` | this side may read what others share, and may ask for a re-pull (`relay/sync`) |

Version check: the server accepts v1–v3. A mismatch answers `protocol-mismatch` with the server's own capability list, and a client also recognises a server that is too old. A v1 client has no `features` field, so negotiation yields the empty set — it simply never receives relay capabilities, while baseline reading keeps working. A peer without `relay.refresh` still works; a permission change just takes up to one poll cycle to spread.

`GET /` reports `protocol`, `minProtocol`, `features`, and `relay` as well.

## Full configuration example

```yaml
- id: remote-bridge
  name: dsh-remote-bridge
  config:
    mode: both            # both | server | client | off
    server:
      enabled: true
      host: 0.0.0.0
      port: 4590
      name: office-pc
      auth:
        token: 'shared-secret'
        password: ''      # optional; when both are set, both must match
      allow:
        sessions: '*'     # or 'id1,id2'
        cwdPrefixes: []   # e.g. ['D:\\work'] — expose only sessions here
      clients: []         # optional per-client grants; when present they win
      relay:
        enabled: false    # let clients relay sessions to each other
    client:
      enabled: true
      remotes:
        - id: office
          label: Office
          url: http://192.168.1.20:4590
          token: 'shared-secret'
      share:              # offer this machine's sessions to other clients
        enabled: false
        sessions: '*'
        cwdPrefixes: []
        consumers: []     # allowed client machine names; empty = any authenticated client
      relay:
        enabled: false    # read sessions other clients share
```

Per-client grants:

```yaml
      clients:
        - name: laptop
          token: laptop-token
          allow:
            sessions: '*'
            cwdPrefixes: ['D:\\work']
```

With no token or password configured, the server logs a warning: anyone who can reach the port can read the session records.

## How it works

1. A client opens `/ws` on the remote and sends `hello` (protocol version, token/password, capability set, share intent).
2. The server validates it and answers `welcome` (machine name, negotiated capabilities, readable sharers, session summaries), then pushes `sessions` and `event` frames.
3. The client creates `$DSH_HOME/remote-bridge/<id>` per machine and registers it as a Workspace, titled e.g. `Office (on PC-01)`.
4. Each remote session materialises as a local session (id `session-rb-<hash>`, cwd pointing at that directory); its full log is written locally and attached to the Workspace.
5. The mirror rides a **live Session**: events enter the in-memory session, the native `session/follow` pushes them to open pages, and projections (title, metadata) are folded by the native registry — so neither the sidebar title nor live updates are implemented by this plugin.
6. The plugin also holds the persistence write handle for that session, so this machine **cannot resume it** — `session/prompt`, `session/rename` and friends return `session/writer-held`. The mirror is read-only by construction.
7. New remote events are appended to the local log and the in-memory session; after a reconnect the client catches up by cursor.
8. With relay on: a sharer pushes `publish` (the catalogue it filtered itself), the server re-checks the scope and broadcasts `relay/sessions`; when a reader issues `history` with `peer`, the server forwards it to the sharer, which answers `history` with `events`, and the server returns it to the reader. Live events travel `publish/event` → `relay/event`.

## Known limitations

- **Read-only**: the plugin holds the write handle, so this machine cannot resume or rename a mirror (`session/writer-held`).
- **Empty sessions are hidden**: a remote session that has not started yet is hidden by the native list, matching local behaviour.
- **fork/seed sessions degrade**: a log that cannot be replayed live falls back to a pure persistence mirror, with its title restored from the projection cache.
- **Both ends must be compatible**: the protocol is tied to the local session format; relay requires both ends to be ≥ 0.5.0.
- **Mirrors take disk space**: mirrored sessions are written into the local session store.
- **One writer per session**: a given remote session should be mirrored by one client only; two mirrors of the same id fail on the write lock.
- **Relay needs the sharer online**: when a sharer disconnects its sessions vanish from readers immediately (the server pushes `gone`), and history requests answer `relay-offline`.
- **Relay is read-only**: a reader holds a mirror, cannot resume it, and never sends events back to the sharer.

## Troubleshooting

- **Configuration saved before 0.4.0 never took effect**: a `.volatile()` field parses into a cosmokit volatile reference, and the old code read it without unwrapping, so it always saw the defaults (`4590`, `0.0.0.0`, hostname). 0.4.0 unwraps in `normalizeConfig` first, so configuration finally lands — after upgrading, restart DSH and confirm the monitor's listening `host:port` and machine name.
- The monitor reports “status read failed: management API unavailable”: the plugin row has not been reloaded yet; restart DSH, or toggle the plugin off and on.
- Server self-check: `curl http://<host>:4590/` returns `{ok, name, protocol, features, relay, sessions, diag}`.
- Relay not working — check in this order: `server.relay.enabled` on the hub → `client.share.enabled` on the sharer, and that both handshakes negotiated the relay capabilities (the monitor's capability line lists them) → whether the sharer's `consumers` contains the reader's machine name → whether the session falls inside `share.sessions` / `share.cwdPrefixes`.
- Tests: `node test/relay-e2e.mjs` (one hub, one real publisher, an allowed and a refused subscriber; covers negotiation, permissions, live events, and version checks).
- Client log: the `已连接远程 DSH` line (“connected to remote DSH”) in `dsh` output, or warnings prefixed `远程桥接`.
- If the whole sidebar is empty, a mirror's session header disagreed with the persisted one and the whole `session/list` call failed (fixed); deleting `$DSH_HOME/sessions/*remote-bridge*` and `$DSH_HOME/storages/session_projcache/sessions/session-rb-*` and restarting recovers.
