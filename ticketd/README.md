# ticketd — platform service (Node 22, zero framework)

Issues launch tickets after an on-chain ownership check, encrypts and stores
studio builds, and runs the off-chain social layer (friends, profiles,
devices). Listens on loopback only (127.0.0.1 + ::1), CORS restricted to the
web app and the launcher, every request body size-capped.

## Routes

| Route | Caller | Auth | Purpose |
|---|---|---|---|
| `GET /health` | launcher | – | liveness |
| `POST /ticket` | web `/pair` | SIWE pairing message (embeds the device pubkey) | issue a ticket sealed to that device |
| `GET /pending/:nonce` | launcher | nonce | hand the ticket over once (10 min, memory) |
| `POST /publish` | web `/studio` | studio-signed message in `X-GameVault-Message` / `X-GameVault-Signature` | encrypt with a fresh key, pin to IPFS, store the key |
| `GET /build/:cid` | launcher | – | build mirror: builds cached at publish, otherwise on-chain CIDs fetched from IPFS and sha256-checked |
| `POST /session` · `POST /session/device` · `GET`/`DELETE /session` | web · launcher | one wallet signature · device-key proof built by the Rust core | 24 h social session (Bearer token, only its hash is stored) |
| `GET /devices/:wallet`, `GET /devices/:wallet/:pubkey/status`, `POST /devices/revoke` | web, launcher | revoke is signed | 2 active devices per account (revoke also closes that device's sessions) |
| `GET /friends/:addr`, `POST /friends/action`, `POST /friends/attest` | web, launcher | session (attest: owner only) | friends (DB, zero gas) + EIP-712 attestation for `lend()` |
| `POST /friends/backdate` | dev only | `GAMEVAULT_DEV=1` | simulate a 3-day-old friendship |
| `GET /profile/:addr`, `GET /profile/avatar/:addr`, `GET /profile/search?q=`, `GET /profiles/names?a=` | web, launcher | – | public profile (bio, presence, friends, activity, play time) |
| `POST /profile` | web | session | pseudo, bio, avatar, favorites |
| `POST /profile/playstat`, `POST /presence` | launcher | device session | play time + activity; online / playing presence |
| `GET`/`POST /studio/:id/page` | web | write: session of the studio's on-chain owner | studio public page (description, links, team) |
| `GET /chat`, `GET`/`POST /chat/:addr`, `POST /chat/:addr/read` | web, launcher | session, friends only | chat (text + loan cards), unread counters |
| `GET /events?token=` | web, launcher | session token | live stream (SSE): message, read, presence, friends |

Signed messages (pairing, publish, device revoke, session opening): exact
canonical format, ≤ 10 min old, single-use nonce persisted in SQLite (no
replay after a restart). Social actions then use the session token.

## Ticket issuance (`POST /ticket`)
1. Parse and byte-compare the SIWE pairing message; chain + contract must match.
2. Freshness, nonce, signature.
3. Play right on-chain: the active borrower (`userOf`) during a loan — the
   owner is refused then — otherwise the owner (`ownerOf`).
4. Content key: edition → CID → encrypted key, bound to the publishing studio
   and to the first edition using that CID.
5. ECIES-wrap the key to the DEVICE pubkey, expiry = min(30 days, loan end),
   sign with `TICKET_SIGNER_PRIVKEY`, register the device (LRU eviction past 2).

## Storage
`data/ticketd.db` (SQLite, WAL): `content_keys` (encrypted with
`KEYSTORE_MASTER_KEY`, CID as AAD), `nonces`, `friend_requests`,
`friendships`, `profiles` (+ bio, member since), `playstats`, `devices`,
`sessions`, `activity`, `studio_pages`, `messages`. Avatars and cached builds
are files under `data/`. Backup: `npm run backup -w @gamevault/ticketd`
(the master key is deliberately not in the backup).

## Run
```
npm run dev -w @gamevault/ticketd        # http://localhost:8787, --watch, loads .env + .env.dev
npm run selftest -w @gamevault/ticketd   # issuance proof: in-memory DB, no chain
```
Configuration: see `.env.example` (variable names and roles).
