# ticketd — ticket issuance service (Node/TS)

Promoted from stretch: the demo climax (resale → revocation) depends on this. Everything downstream consumes it.

`POST /ticket`:
1. Verify SIWE signature. The SIWE message EMBEDS the device pubkey (from the launcher's pairing QR) — this binds wallet ↔ device and prevents device substitution.
2. Check `ownerOf(tokenId)` on-chain matches the SIWE signer
3. ECIES-wrap the AES-256-GCM content key to the DEVICE pubkey (@noble/curves, @noble/ciphers). Not the wallet pubkey — wallets have no secp256k1 decryption API, a key wrapped to the wallet could never be unwrapped.
4. Sign ticket `{ tokenId, contract, chainId, ownerAddress, devicePubKey, wrappedContentKey, issuedAt, expiresAt }` with the platform key
5. Return ticket

Same endpoint serves renewal and re-wrap-on-resale (buyer pairs their own device after purchase, which triggers issuance).

## Run
```
npm run dev -w ticketd        # http://localhost:8787, --watch
npm run selftest -w ticketd   # end-to-end issuance proof, no HTTP/chain
```
Config via env (see .env.example). Until P1 contracts are deployed,
GAMELICENSE_ADDRESS is unset → ownerOf() check is SKIPPED (loud warning).
Guards implemented: signature-vs-address, canonical message format (rebuild
and byte-compare), 10-min freshness window, nonce replay set.
