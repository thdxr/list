# OpenTunnel Design

## Summary

Build `opentunnel.xyz` as a public tunnel service similar to ngrok, but with a strict blind-relay property: the relay can route traffic yet cannot decrypt application traffic. External callers use normal HTTPS in browsers and `curl`. Private apps run an outbound client behind NAT or firewalls. Each app receives a random hostname such as `6hm7q9cw1p4x8kt2vd5r.opentunnel.xyz`.

The relay is an L4 TLS pass-through switch with an HTTP control plane. It does not behave like a normal reverse proxy. It inspects only enough of the TLS ClientHello to read SNI and ALPN, picks the correct connected bridge session, and forwards raw TCP bytes over that session. TLS terminates only on the client or app side.

## Requirements

- Public access from stock browsers and `curl`
- Support `HTTP/1.1`, `HTTP/2`, WebSockets, SSE, and gRPC
- Random hostnames under `*.opentunnel.xyz`
- Anonymous self-serve creation with no account or login
- Client must dial out from behind NAT or firewalls
- Relay must be unable to read HTTP payloads, headers, or decrypted TLS traffic
- A setup handshake between client and service is allowed

## Non-goals

- Hiding the hostname from the relay
- Hiding client IPs, timing, packet sizes, or connection counts
- Serving pretty offline error pages from the relay
- `HTTP/3` in v1
- Custom domains in v1

## Why this architecture

A normal HTTPS reverse proxy terminates TLS, which lets it read the traffic. That violates the main requirement.

TURN is adjacent, but not sufficient. It can relay opaque bytes, but it does not provide browser-friendly public HTTPS hostnames, certificate issuance, hostname assignment, or the control plane needed for a public tunnel service.

A wildcard certificate for `*.opentunnel.xyz` is also not enough. A leaf wildcard certificate cannot mint child certificates. Shipping the wildcard private key to every client would let any compromised client impersonate every hostname and is not acceptable.

## Components

- Control plane
  - Served at `https://opentunnel.xyz/api`
  - Anonymous tunnel creation, rate limits, and abuse controls
  - Bootstrap lease binding and capability token validation
  - ACME orchestration for per-host certificates
- Relay data plane
  - Public TCP listener on port `443`
  - V1 bridge transport listener at `wss://opentunnel.xyz/api/connect`
  - Optional future QUIC listener on `UDP 443`
  - Reads TLS ClientHello to extract SNI and ALPN
  - Maps hostname to an active bridge session
  - Pipes raw bytes in both directions over multiplexed bridge channels
- Client
  - Runs near the target app
  - Opens one long-lived outbound bridge session to the relay
  - Generates and stores the TLS private key locally
  - Terminates public TLS locally, then forwards plain HTTP or TCP to the local app
- DNS
  - Wildcard DNS or dynamic records for `*.opentunnel.xyz`
  - `_acme-challenge` and `_psl` records managed by the service
- Certificate service
  - Issues a unique public certificate per hostname
  - Never stores private keys

## Public request flow

1. A client calls the control plane to create a new tunnel.
2. The control plane creates a short-lived bootstrap lease and returns a random `id`, the corresponding `host`, a bearer capability token, and `time_bind_expires`.
3. The client generates a local keypair and CSR for `{id}.opentunnel.xyz`.
4. The client binds the lease by posting the CSR to the control plane with the bearer token.
5. The control plane validates that the CSR matches exactly `{id}.opentunnel.xyz` and starts ACME `DNS-01`.
6. The tunnel becomes permanent after bind acceptance. There is no user-visible renewal API for tunnel lifetime.
7. The client polls `GET /tunnel/{id}/certificate` until the certificate chain is ready.
8. In v1, the client opens one long-lived authenticated bridge session to `wss://opentunnel.xyz/api/connect`.
9. A browser connects to `{id}.opentunnel.xyz:443`.
10. The relay reads only the TLS ClientHello bytes needed to parse SNI and ALPN.
11. The relay looks up the active session for `{id}.opentunnel.xyz`.
12. The relay binds the public TCP socket to a logical bridge channel.
13. The relay forwards encrypted bytes unchanged.
14. The client completes the TLS handshake with the browser using the hostname's private key and certificate.
15. After TLS is established, the client forwards decrypted HTTP or TCP to the local target process.

Because the relay never terminates TLS, it can carry `HTTP/1.1`, `HTTP/2`, WebSockets, SSE, and gRPC without protocol awareness.

## Client attach flow

The local app is not exposed directly. The bridge client runs next to it and connects out to the relay.

1. The target app listens only on a local address such as `127.0.0.1:3000`.
2. The client starts with an upstream target such as `http://127.0.0.1:3000`.
3. The client calls `POST /tunnel` and receives a short-lived bootstrap lease with `id`, `host`, `token`, and `time_bind_expires`.
4. The client generates a local keypair and CSR for `{id}.opentunnel.xyz`.
5. The client calls `POST /tunnel/{id}/bind` with `Authorization: Bearer {token}` and the CSR.
6. The control plane validates the CSR and starts ACME `DNS-01`.
7. The client polls `GET /tunnel/{id}/certificate` until the certificate chain is ready.
8. The client stores the certificate chain next to the private key and opens one long-lived bridge session to the relay.
9. Immediately after session setup, the client sends an attach message containing the tunnel `id` and bearer `token`.
10. The relay validates the attach message, marks that hostname as online, and binds future public connections for that hostname to this bridge session.

## Bridge session model

The bridge maintains one long-lived session to the relay. V1 uses the WebSocket binding on the apex domain. The QUIC binding is specified for a later transport upgrade.

Transport bindings:

- V1 WebSocket: `wss://opentunnel.xyz/api/connect`
- Future QUIC: `opentunnel.xyz` on `UDP 443`

Each inbound public TCP connection becomes one logical bridge channel on that session.

Core rules:

- The relay is the only side that opens new public channels
- `conn` is a relay-assigned unsigned 32-bit integer unique within a session
- The first bytes delivered from relay to bridge for a new channel are the buffered ClientHello bytes already read from the public socket
- After channel open, both sides forward opaque bytes in both directions until half-close or reset
- The latest successful `attach` replaces any older live session for the same tunnel

For each inbound public connection:

1. A browser opens a TCP connection to `{id}.opentunnel.xyz:443`.
2. The relay reads the TLS ClientHello and extracts `SNI` and `ALPN`.
3. The relay resolves the hostname to the active bridge session.
4. The relay opens a new logical bridge channel for that public TCP connection.
5. The relay forwards the buffered ClientHello bytes and all later bytes to the bridge.
6. The bridge performs the TLS handshake locally using its certificate and private key and proxies decrypted traffic to the configured local upstream.
7. Upstream response bytes flow back through the same bridge channel to the relay and then back to the public TCP socket.

This gives the relay a simple mental model:

- one bridge session per connected tunnel
- one logical bridge channel per public TCP connection
- raw byte forwarding in both directions after SNI-based routing

## Bridge protocol

The bridge protocol is transport-neutral. It defines shared session semantics and message names, then maps them onto QUIC and WebSocket separately.

### Common message vocabulary

Control messages use UTF-8 JSON objects containing at least `type`.

General rules:

- Unknown fields should be ignored
- Unknown message types are protocol errors

Versioning rules:

- The bridge session negotiates a single protocol identifier once at connection setup
- Compatible changes add fields and require receivers to ignore unknown fields
- Breaking changes require a new negotiated protocol identifier
- Message `type` names stay stable within a negotiated protocol

Authentication rules:

- Transport setup itself is unauthenticated beyond protocol negotiation
- Authentication happens in the first `attach` message after the session is established
- The `attach` message carries the tunnel `id` and bearer `token`
- The relay must not accept channels for a session until `attach` succeeds
- This rule is the same for WebSocket and QUIC so browser and native clients follow the same model

Attach request:

```json
{
  "type": "attach",
  "id": "6hm7q9cw1p4x8kt2vd5r",
  "token": "rly_...",
  "transport": "ws",
  "client": { "version": "0.1.0", "max_conns": 256 }
}
```

Attach success:

```json
{
  "type": "attached",
  "session": "qs_01JV...",
  "heartbeat_ms": 15000,
  "idle_timeout_ms": 45000
}
```

Attach failure:

```json
{ "type": "attach_error", "code": "bad_token" }
```

Heartbeat:

```json
{"type":"ping","time_sent":1774741200000}
{"type":"pong","time_sent":1774741200000}
```

Graceful drain:

```json
{ "type": "drain", "reason": "shutdown" }
```

Open channel metadata:

```json
{
  "type": "open",
  "conn": 17,
  "peer": "203.0.113.7:49822",
  "sni": "6hm7q9cw1p4x8kt2vd5r.opentunnel.xyz",
  "alpn": "h2"
}
```

Half-close:

```json
{ "type": "end", "conn": 17 }
```

Abortive close:

```json
{ "type": "reset", "conn": 17, "code": "upstream_connect_failed" }
```

Common error codes:

- `bad_attach`
- `bad_token`
- `tunnel_not_bound`
- `cert_not_ready`
- `replaced`
- `upstream_connect_failed`
- `upstream_io_error`
- `client_io_error`
- `idle_timeout`

Channel semantics:

- `open` must be observed before the first payload bytes for a channel
- `end` means the sender will send no more bytes on that channel direction
- `reset` aborts the channel immediately in both directions
- Existing channels are not migrated across bridge sessions in v1

Drain semantics:

- If the bridge sends `drain`, the relay stops assigning new public channels to that session
- If the relay sends `drain`, the bridge should prepare to reconnect elsewhere or shut down cleanly
- Existing channels may continue until they complete or hit a timeout

Reconnect semantics:

- If the underlying transport drops, the relay marks the session offline immediately
- New public connections fail until the bridge reconnects
- Existing public connections on that session are closed
- The bridge reconnects with the same tunnel `id` and bearer `token`
- The latest successful attach always wins

### QUIC binding

Transport rules:

- QUIC v1 on `UDP 443`
- ALPN: `opentunnel`
- The bridge is always the QUIC client and the relay is always the QUIC server
- Disable `0-RTT` in v1 so attach messages cannot be replayed
- Do not use QUIC datagrams in v1
- Do not layer HTTP/3 on this transport

Stream roles:

- The first client-initiated bidirectional stream is the control stream
- The relay opens one server-initiated bidirectional stream per public TCP connection
- No other stream types are used in v1

Control stream framing:

- The control stream uses newline-delimited UTF-8 JSON
- It carries `attach`, `attached`, `attach_error`, `ping`, `pong`, and `drain`
- `open`, `end`, and `reset` are represented by stream-level mechanics rather than JSON on the control stream

Data stream format:

- Each relay-opened data stream begins with a single UTF-8 JSON `open` header line terminated by `\n`
- After that newline, the stream carries raw TCP bytes with no additional framing
- Immediately after the `open` header, the relay writes the buffered ClientHello bytes already read from the public socket

QUIC `open` header example:

```json
{
  "type": "open",
  "conn": 17,
  "peer": "203.0.113.7:49822",
  "sni": "6hm7q9cw1p4x8kt2vd5r.opentunnel.xyz",
  "alpn": "h2"
}
```

Close mapping:

- QUIC stream `FIN` maps to `end`
- `RESET_STREAM` or `STOP_SENDING` maps to `reset`

Recommended QUIC application error codes:

- `0x00` `normal`
- `0x01` `bad_attach`
- `0x02` `bad_token`
- `0x03` `tunnel_not_bound`
- `0x04` `cert_not_ready`
- `0x05` `replaced`
- `0x10` `upstream_connect_failed`
- `0x11` `upstream_io_error`
- `0x12` `client_io_error`
- `0x13` `idle_timeout`

QUIC notes:

- QUIC provides native per-channel multiplexing and per-stream close semantics
- Packet loss on one channel does not block every other channel at the transport layer

### WebSocket binding

Transport rules:

- Connect to `wss://opentunnel.xyz/api/connect`
- Require WebSocket subprotocol `opentunnel`
- The bridge is always the WebSocket client and the relay is always the WebSocket server
- One WebSocket connection carries the full bridge session

Frame rules:

- Control messages are individual WebSocket text frames containing UTF-8 JSON
- Payload data is carried in WebSocket binary frames
- A binary frame begins with a 4-byte big-endian `conn` followed by raw payload bytes
- Senders may fragment payload into any number of frames; `32 KiB` is a reasonable default maximum payload per frame

WebSocket control messages:

- `attach`, `attached`, `attach_error`, `ping`, `pong`, `drain`, `open`, `end`, and `reset` are all sent as text frames
- The relay must send `open` before the first binary frame for a channel

WebSocket data frame layout:

```text
u32_be conn
payload bytes...
```

WebSocket notes:

- The first binary frame after an `open` message should contain the buffered ClientHello bytes
- A WebSocket close closes the entire bridge session and therefore all active channels
- Because WebSocket rides a single TCP connection, packet loss can stall all logical channels behind it

### Why two bindings

The two bindings serve different goals:

- WebSocket is the v1 transport because it keeps both relay and bridge purely in JavaScript and has the simplest deployment model
- QUIC remains the better future transport for high concurrency, loss tolerance, and long-lived streaming traffic

The higher-level bridge protocol stays stable across both bindings.

## Control plane model

The control plane is intentionally anonymous. There are no user accounts, no login, no chosen subdomains, and no list/search API. The server generates an opaque random ID and that ID becomes the public hostname.

Tunnel lifecycle:

- `bootstrap lease`
  - Created by `POST /tunnel`
  - Short-lived
  - Holds a random `id`, `host`, bearer capability token, and `time_bind_expires`
  - Expires automatically if the client never binds a CSR
- `tunnel`
  - Created when the client successfully binds a CSR
  - Permanent until explicitly deleted
  - All later admin actions use the bearer capability token returned at create time

This keeps the public API simple while still preventing anonymous callers from hijacking or deleting other tunnels.

## Control plane API

All control-plane paths in this section are relative to `https://opentunnel.xyz/api`.

`POST /tunnel`

Creates a short-lived bootstrap lease and assigns a random hostname.

Request:

```json
{}
```

Response:

```json
{
  "id": "6hm7q9cw1p4x8kt2vd5r",
  "host": "6hm7q9cw1p4x8kt2vd5r.opentunnel.xyz",
  "token": "rly_...",
  "state": "pending",
  "time_bind_expires": "2026-03-28T23:00:00Z"
}
```

`POST /tunnel/{id}/bind`

Header:

```text
Authorization: Bearer rly_...
```

Request:

```json
{
  "csr": "-----BEGIN CERTIFICATE REQUEST-----\n...\n-----END CERTIFICATE REQUEST-----"
}
```

Behavior:

- Verifies the tunnel exists and is still in `pending`
- Verifies the CSR hostname is exactly `{id}.opentunnel.xyz`
- Stores the CSR public key fingerprint as the bound tunnel identity
- Starts ACME `DNS-01` for that hostname
- Makes the tunnel permanent once the bind request is accepted

Response:

```json
{
  "id": "6hm7q9cw1p4x8kt2vd5r",
  "host": "6hm7q9cw1p4x8kt2vd5r.opentunnel.xyz",
  "state": "provisioning"
}
```

`GET /tunnel/{id}`

Header:

```text
Authorization: Bearer rly_...
```

Response:

```json
{
  "id": "6hm7q9cw1p4x8kt2vd5r",
  "host": "6hm7q9cw1p4x8kt2vd5r.opentunnel.xyz",
  "state": "online"
}
```

`GET /tunnel/{id}/certificate`

Header:

```text
Authorization: Bearer rly_...
```

Response while issuing:

```json
{
  "state": "issuing"
}
```

Response when ready:

```json
{
  "state": "ready",
  "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
  "chain": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
  "time_not_after": "2026-06-26T00:00:00Z"
}
```

`DELETE /tunnel/{id}`

Header:

```text
Authorization: Bearer rly_...
```

Behavior:

- Deletes the tunnel
- Invalidates the bearer token
- Revokes routing for the hostname

Response: `204 No Content`

## Control plane semantics

The HTTP API should be strict enough that independent implementations behave the same way.

Authorization rules:

- `POST /tunnel` is anonymous
- All other tunnel-specific endpoints require `Authorization: Bearer {token}`
- Tokens are bearer capabilities, not user accounts
- The control plane stores only a hash of the bearer token
- Tokens are accepted only in the `Authorization` header, never in query parameters

Response rules:

- `POST /tunnel` returns `201 Created`
- `POST /tunnel/{id}/bind` returns `202 Accepted` when ACME work begins
- `GET` endpoints return `200 OK`
- `DELETE /tunnel/{id}` returns `204 No Content`

Error rules:

- `401` if the `Authorization` header is missing or malformed
- `403` if the token is wrong for the specified tunnel
- `404` if the tunnel does not exist or has already been deleted
- `409` for state conflicts such as `already_bound`
- `410` for an expired bootstrap lease
- `429` for rate limits
- `503` for temporary CA or infrastructure unavailability

Recommended error codes:

- `bad_token`
- `bind_expired`
- `already_bound`
- `bind_in_progress`
- `csr_invalid`
- `csr_host_mismatch`
- `cert_not_ready`
- `rate_limited`
- `ca_unavailable`

Bind rules:

- A bootstrap lease is valid for `5` minutes by default
- `bind` is idempotent only if the tunnel is already bound to the same CSR public key fingerprint
- A second `bind` with a different CSR after success returns `409 already_bound`
- A `bind` after bootstrap expiration returns `410 bind_expired`
- The tunnel becomes permanent as soon as `bind` is accepted, even if certificate issuance is still in progress

Certificate rules:

- A certificate is issued only for the exact hostname `{id}.opentunnel.xyz`
- A CSR with any additional SANs must be rejected
- The control plane may store the certificate chain, but never the private key
- The data plane must reject `attach` if the tunnel is not bound or if `cert_state != ready`

Delete rules:

- `DELETE` invalidates the token immediately
- Routing is removed before the delete operation is considered complete
- Certificate revocation is best-effort and asynchronous in v1
- A deleted tunnel ID is never reused

## State machines

The implementation should model tunnel, certificate, and session state separately.

### Tunnel state

Primary tunnel states:

- `pending`
  - Bootstrap lease exists
  - Token is valid
  - Tunnel is not yet permanent
- `provisioning`
  - Tunnel is permanently bound
  - Certificate issuance is in progress or recovery is needed before it can accept traffic
- `offline`
  - Tunnel is ready to serve but no active attached bridge session exists
- `online`
  - Tunnel is ready to serve and one bridge session is attached
- `deleting`
  - Delete has been accepted
  - New attaches and public routing are blocked
- `deleted`
  - Terminal state

Tunnel transitions:

```text
POST /tunnel              -> pending
bind accepted             -> provisioning
acme success              -> offline
bridge attached           -> online
session lost              -> offline
certificate recovery      -> provisioning
DELETE                    -> deleting -> deleted
bootstrap expired         -> deleted
```

### Certificate state

Certificate states:

- `none`
- `issuing`
- `ready`
- `failed`
- `expired`

Certificate transitions:

```text
new tunnel                -> none
bind accepted             -> issuing
acme success              -> ready
acme failure              -> failed
renewal retry             -> issuing
time_not_after passed     -> expired
```

Rules:

- `attach` is accepted only when `cert_state = ready`
- `failed` is retryable by the control plane worker
- `expired` forces the tunnel to behave as `offline` for new public traffic

### Session state

Session states:

- `detached`
- `attaching`
- `attached`
- `draining`
- `closed`

Session transitions:

```text
no connection             -> detached
transport connected       -> attaching
attach accepted           -> attached
drain initiated           -> draining
connection lost           -> closed -> detached
```

Rules:

- At most one session may be `attached` per tunnel
- The latest successful attach replaces any existing session
- `draining` sessions receive no new public connections

### Public API state

`GET /tunnel/{id}` should expose at least:

- `state`: `pending`, `provisioning`, `offline`, `online`, or `deleting`
- `time_last_seen` when a successful bridge session has recently been attached

Mapping rules:

- `pending`: created but not yet bound with a CSR
- `provisioning`: certificate issuance or recovery is still in progress
- `offline`: certificate is ready but no active bridge session is attached
- `online`: certificate is ready and a bridge session is attached
- `deleting`: deletion has been accepted and routing is being removed

Detailed certificate state belongs on `GET /tunnel/{id}/certificate`. Session internals are implementation details and should not be exposed in the public API in v1.

## Certificate model

The certificate must be unique per hostname and the private key must live on the client side. The cleanest browser-compatible model is ACME with `DNS-01` driven by the control plane from the client's CSR.

- The client generates the key locally.
- The client sends a CSR for `{id}.opentunnel.xyz` during `bind`.
- The control plane creates the ACME order for that exact hostname.
- The service fulfills the `DNS-01` challenge under the delegated zone.
- The CA returns a certificate chain for that exact hostname.
- The control plane passes the chain back to the client.
- Certificate renewal is automatic and internal. The tunnel does not expose a user-facing renewal endpoint.

This keeps the relay blind to traffic and avoids any shared wildcard private key.

## Scaling certificate issuance

A plain shared domain runs into CA limits if every random tunnel hostname gets its own certificate. The intended fix is to add `opentunnel.xyz` to the `PRIVATE` section of the Public Suffix List.

Effects of a PSL entry:

- `{id}.opentunnel.xyz` is treated as its own site boundary by browsers
- CA "registered domain" calculations can treat each child hostname independently
- Shared cookies across `*.opentunnel.xyz` stop working, which is desirable for tenant isolation

PSL notes:

- Requests must come from the domain owner
- The request must describe a real multi-tenant boundary, not just a rate-limit workaround
- The domain should have at least two years of registration remaining
- Merge and downstream propagation can take time and there is no SLA

If PSL is not accepted or does not propagate fast enough, fallback options are:

- Negotiate higher issuance limits with the CA
- Use an additional CA or paid CA product
- Shard tenants across multiple parent domains
- Postpone fully self-serve certificate issuance until operations capacity exists

## Security properties

What the relay cannot learn:

- HTTP method, path, headers, cookies, bodies, or response data
- Application plaintext
- gRPC payloads
- WebSocket payloads

What the relay still learns:

- Destination hostname from SNI
- ALPN
- Client IP
- Connection timing, sizes, and counts
- Whether a hostname is online
- Certificate issuance metadata in the control plane

Operator trust note:

- Because the control plane owns DNS and drives ACME, the operator can issue another valid certificate for a tunnel hostname. This design prevents passive edge decryption, but it does not prevent a malicious operator from actively impersonating a tunnel without an additional end-to-end cryptographic layer or user-controlled domains.

If hiding SNI is a future goal, that requires a different architecture and is not compatible with simple browser support today.

## Failure behavior

If the client is offline, the relay cannot present a trusted certificate for the hostname without holding its private key. The strict blind-relay design therefore cannot serve a branded HTTPS `502` page. The relay should fail fast by closing the connection during setup or by returning an error only on a separate status endpoint that does not claim to be the tenant hostname.

## Implementation architecture

V1 is pure JavaScript or TypeScript on both server and client.

Scope of the v1 JS implementation:

- Control plane API
- ACME worker
- Relay edge
- Bridge client SDK

Why this works for v1:

- The HTTPS control plane is straightforward in Node.js
- The WebSocket bridge binding removes the need for native QUIC support
- The bridge can still terminate TLS locally using Node's TLS stack
- The same codebase can power both the server and SDK roles

Future native-core note:

- If a native transport core is later needed for QUIC, Rust is the preferred choice
- The bridge protocol in this document stays stable regardless of whether the implementation is JS or a future native core

Design rule:

- `@opentunnel/core` contains the core system logic as Effect v4 services
- `@opentunnel/sdk` is the primary v1 client integration surface
- Keep the public package and process model minimal even if the internal implementation uses a shared core package

Code organization:

- `packages/core` published as `@opentunnel/core`
  - Shared implementation of the tunnel lifecycle, certificate orchestration, session management, routing decisions, and bridge protocol handling
  - Built around Effect v4 services so the same logic can be composed in different runtime roles
  - Owns the main domain workflows while leaving network and process edges to role-specific packages
- `packages/sdk` published as `@opentunnel/sdk`
  - Public client SDK
  - Thin client-facing integration layer over `@opentunnel/core` services plus local bridge concerns
  - Tunnel create/bind flow, cert persistence, bridge attach, reconnect loop, and local upstream proxying
  - The main package application developers should install
- `packages/server` published as `@opentunnel/server`
  - Relay edge role plus control-plane API and ACME worker host
  - Primarily wires HTTP, WebSocket, TCP, persistence, and background worker adapters into `@opentunnel/core` and calls those services
  - Keeps transport and deployment concerns at the edge while domain behavior stays in the core package

Start with these three packages. Keep protocol types and low-level runtime helpers inside `@opentunnel/core` unless a narrower public boundary is justified later.

The goal is one shared JS codebase with a clear internal core and separate role-specific libraries. Do not collapse client and server concerns into one giant public API surface, but do centralize the business logic in `@opentunnel/core` so server entrypoints stay thin.

Transport implementation note:

- WebSocket is the only required binding in v1
- QUIC is deferred and should be treated as a later performance-oriented binding, not a protocol requirement
- If QUIC is implemented later in native code, Rust is the preferred choice for that transport work
- The bridge protocol described in this document stays stable regardless of which transport binding is used underneath

## Persistence model

Persistence is split between durable control-plane state, regional relay session state, and local bridge state.

### Durable control-plane state

The control plane should persist at least:

```text
tunnels(
  id,
  host,
  token_hash,
  state,
  cert_state,
  spki_sha256,
  time_bind_expires,
  time_created,
  time_deleted,
  time_cert_not_after,
  time_last_seen,
  active_region
)

certs(
  tunnel_id,
  cert_pem,
  chain_pem,
  time_not_before,
  time_not_after,
  current,
  acme_order_ref
)
```

Rules:

- `host` is derived from `id` and should still be stored for indexing clarity
- `token_hash` is the only representation of the bearer token stored server-side
- `spki_sha256` is the fingerprint of the bound CSR public key
- The private key is never stored in the control plane

### Regional relay session state

The relay edge should keep an in-memory registry:

```text
hostname -> attached session handle
session id -> transport session handle
```

Rules:

- Session state is ephemeral and should not require durable persistence
- On relay restart, all sessions are lost and bridges reconnect
- In single-region v1, no cross-region session replication is required

### Local bridge state

The local bridge stores:

- `state.json`
- `key.pem`
- `cert.pem`
- `chain.pem`

Recommended `state.json` contents:

```json
{
  "id": "6hm7q9cw1p4x8kt2vd5r",
  "host": "6hm7q9cw1p4x8kt2vd5r.opentunnel.xyz",
  "token": "rly_...",
  "control_base": "https://opentunnel.xyz/api",
  "bridge_url": "wss://opentunnel.xyz/api/connect",
  "upstream": "http://127.0.0.1:3000"
}
```

Rules:

- `state_dir` permissions should be owner-only
- The private key and bearer token are both secrets
- Restarting the bridge from the same `state_dir` should resume the same tunnel

## Retry and timeout policy

The first implementation should use fixed default timings so behavior is predictable.

| Item                            | Value               | Notes                                             |
| ------------------------------- | ------------------- | ------------------------------------------------- |
| Bootstrap bind window           | `5m`                | Unbound leases are garbage-collected after expiry |
| Control-plane HTTP timeout      | `10s`               | Per request                                       |
| Bridge connect timeout          | `10s`               | Initial bridge attach attempt                     |
| Bridge reconnect backoff        | `250ms` to `30s`    | Exponential with jitter                           |
| Control-stream ping interval    | `15s`               | Already returned by `attached`                    |
| Control-stream idle timeout     | `45s`               | No `pong` means session loss                      |
| Public ClientHello read timeout | `10s`               | Before hostname routing decision                  |
| Local upstream connect timeout  | `5s`                | Per new public connection                         |
| Drain timeout                   | `30s`               | After `stop graceful` or `drain`                  |
| ACME poll interval              | `2s` to `30s`       | Exponential backoff                               |
| ACME overall issuance timeout   | `10m`               | Then mark `cert_state=failed`                     |
| Certificate renewal start       | `30d` before expiry | Background worker                                 |
| Certificate renewal retry       | `1h`                | While inside renewal window                       |

Retry rules:

- Bridge reconnect is indefinite until the process is stopped
- ACME issuance retries are finite per attempt and then surface `cert_state=failed`
- Public TCP connections are never queued waiting for a reconnect; they fail immediately if no session is attached
- `POST /bind` should not block on ACME completion; issuance is asynchronous after acceptance

## Deployment topology

To keep v1 implementable, deploy the first version in a single region.

V1 topology:

- One control-plane API service
- One ACME worker service
- One relay edge service handling public `TCP 443`, `https://opentunnel.xyz/api/*`, and `wss://opentunnel.xyz/api/connect`
- One durable database for tunnel and certificate metadata
- One apex `opentunnel.xyz` DNS entry pointing at that region
- One wildcard DNS entry for `*.opentunnel.xyz` pointing at that region
- All of the above may be implemented in pure JS in v1

Single-region rules:

- All tunnels attach to the same relay region
- All public traffic for all tunnel hostnames lands in the same region
- `active_region` may exist in the schema but is informational only in v1

Multi-region note:

- Do not run active/active multi-region edges for the same hostname space until there is a real global `hostname -> region` routing layer
- When multi-region is introduced later, the control plane must publish the currently attached region for each live tunnel

## Verification

The implementation is not done until these cases are automated.

Required test categories:

- Control plane
  - create tunnel
  - bind valid CSR
  - reject wrong-host CSR
  - delete tunnel
- Certificate flow
  - issue cert from CSR
  - renew cert before expiry
  - survive temporary ACME failure
- Data plane
  - attach bridge
  - route public TCP connection by SNI
  - forward opaque TLS bytes without termination at the relay
- Protocol behavior
  - replace older session on second attach
  - reconnect after transport drop
  - drain without taking new connections
- End-to-end traffic
  - browser HTTPS request
  - `curl` request
  - WebSocket upgrade
  - HTTP/2 / gRPC request

If the QUIC binding is added later, run the data-plane tests against both bindings.

The minimum manual demo is:

1. Start a local HTTP app on `127.0.0.1:3000`
2. Start a bridge client configured to forward to `http://127.0.0.1:3000`
3. Observe the assigned hostname become online
4. Fetch `https://{id}.opentunnel.xyz` from a browser and from `curl`
5. Kill the bridge, confirm new requests fail, restart it, and confirm the same tunnel returns

## Operational notes

- Start with public `TCP 443` plus bridge HTTPS on `443`
- Route `https://opentunnel.xyz/api/*` to the control plane
- Route `wss://opentunnel.xyz/api/connect` to the bridge transport handler
- Do not run bridge QUIC in v1
- Do not support `HTTP/3` in v1 on the public edge
- Start with one relay region in v1
- Keep relay state minimal: `hostname -> session`
- Encrypt and authenticate the bridge tunnel separately from the end-to-end TLS
- Expire unbound bootstrap leases quickly
- Rate limit tunnel creation, bind attempts, and certificate issuance aggressively
- Make bound tunnels permanent until explicit deletion
- Renew certificates automatically while a tunnel remains active
- Log metadata only; never capture tunnel payload bytes

## Recommended v1

- Public side: TCP `443` passthrough
- Data-plane tunnel: transport-neutral bridge protocol
- Bridge bindings: WebSocket only in v1
- Control plane: HTTPS API with anonymous create and bearer capability token
- Implementation: pure JavaScript or TypeScript for both relay and bridge
- Node integration: direct in-process `@opentunnel/sdk`
- Routing key: SNI hostname
- Certificates: per-host ACME `DNS-01`, key generated on client
- Namespace: random IDs under `*.opentunnel.xyz`
- Browser support: yes
- Relay plaintext visibility: no

## Open questions

- Whether raw TCP should be exposed in v1, and on what public interface
- When, if ever, the QUIC binding should be added after v1
- Whether bridge mode terminates TLS itself or hands off to a local sidecar
- Which CA or CA mix to use alongside PSL
- How much issuance volume to plan for at launch
- Whether custom domains should use the same blind-relay model later
