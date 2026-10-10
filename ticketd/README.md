# ticketd — platform service (Node 22, zero framework)

Issues launch tickets after an on-chain ownership check, encrypts and stores
studio builds, and runs the off-chain social layer (friends, profiles,
devices). Listens on loopback only (127.0.0.1 + ::1), CORS restricted to the
web app and the launcher, every request body size-capped.

## Routes

| Route | Caller | Auth | Purpose |
|---|---|---|---|
| `GET /health` | launcher, Kubernetes | – | liveness (the process answers; never checks dependencies) |
| `GET /ready` | Kubernetes | – | readiness: database reachable and not draining (503 otherwise); Redis reported as `liveOk` |
| `GET /metrics` | Prometheus | – | responses by status class, open SSE streams, backends, heap |
| `POST /ticket` | web `/pair` | SIWE pairing message (embeds the device pubkey) | issue a ticket sealed to that device |
| `GET /pending/:nonce` | launcher | nonce | hand the ticket over once (10 min; memory or Redis) |
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
canonical format, ≤ 10 min old, single-use nonce persisted in the database
(no replay after a restart, nor on another replica). Social actions then use
the session token.

## Ticket issuance (`POST /ticket`)
1. Parse and byte-compare the SIWE pairing message; chain + contract must match.
2. Freshness, nonce, signature.
3. Play right on-chain: the active borrower (`userOf`) during a loan — the
   owner is refused then — otherwise the owner (`ownerOf`).
4. Content key: edition → CID → encrypted key, bound to the publishing studio
   and to the first edition using that CID.
5. ECIES-wrap the key to the DEVICE pubkey, expiry = min(30 days, loan end),
   sign with `TICKET_SIGNER_PRIVKEY`, register the device (LRU eviction past 2).

## Storage (2026-10-11: SQLite or Postgres, memory or Redis)
Durable data — `src/sql.ts` + `src/db.ts`:
- **SQLite** `data/ticketd.db` (WAL) by default: local dev, the POC, the
  selftest (in memory).
- **Postgres** when `DATABASE_URL` is set: several replicas share it.
Tables: `content_keys` (encrypted with `KEYSTORE_MASTER_KEY`, CID as AAD),
`nonces`, `friend_requests`, `friendships`, `profiles`, `avatars`,
`playstats`, `devices`, `sessions`, `activity`, `studio_pages`, `messages`,
`wishlist`, `privacy`. Schema = versioned migrations (`MIGRATIONS` in
`sql.ts`, table `schema_migrations`), applied at start-up under an advisory
lock — add one, never edit an applied one.

Live state — `src/live.ts`: presence, pending pairing tickets, the SSE fan-out
and the chat rate limit, in memory by default or in **Redis** (`REDIS_URL`).
Nothing there needs to survive a restart.

Builds: a local cache in `data/builds` (refilled from IPFS on a miss, checked
against the on-chain hash). Backup: `npm run backup -w @gamevault/ticketd`
(SQLite file, or `pg_dump` with `DATABASE_URL`); the master key is
deliberately not in the backup. Operations: `docs/runbook.md`.

## Run
```
npm run dev -w @gamevault/ticketd        # http://localhost:8787, --watch, loads .env + .env.dev
npm run selftest -w @gamevault/ticketd   # issuance + social proof: in-memory DB, no chain
GAMEVAULT_TEST_BACKENDS=1 DATABASE_URL=postgres://… REDIS_URL=redis://… npm run selftest -w @gamevault/ticketd
npm run migrate -w @gamevault/ticketd    # Postgres migrations (-- --status, -- --from-sqlite [file] [--force])
npm run demo -w @gamevault/ticketd       # demo state: read-only report + plan
npm run demo -w @gamevault/ticketd -- --apply --buyer 0x…   # prepare it (testnet, dev only)
```
`demo` puts the reference demo back in a known state (a blockchain can't be
rewound, so it PREPARES instead): wallet A (`--seller`, default the project
owner) gets an unlent, unlisted licence of the demo edition (`--edition`,
default 2 = Runner, bought and transferred by `DEV_WALLET_PRIVKEY`), the
market keeps one listing, A and B (`--buyer`) become friends since 4 days,
and it prints the step-by-step demo. Idempotent: run it before every demo.
Configuration: see `.env.example` (variable names and roles). Scale-out
settings: `DATABASE_URL`, `REDIS_URL`, `PG_POOL_MAX` (10), `PG_STATEMENT_TIMEOUT_MS`
(10000), `DB_CONNECT_RETRIES` (30 × 2 s at start-up), `SHUTDOWN_DELAY_MS` (0;
5000 in Kubernetes), `SHUTDOWN_GRACE_MS` (10000).
