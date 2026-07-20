# ticketd — ticket issuance service (Node/TS)

Promoted from stretch: the demo climax (resale → revocation) depends on this. Everything downstream consumes it.

`POST /ticket`:
1. Verify SIWE signature → recover secp256k1 pubkey (ECIES cannot wrap to an address — the pubkey only comes from a signature)
2. Check `ownerOf(tokenId)` on-chain matches the signer
3. ECIES-wrap the AES-256-GCM content key to that pubkey (@noble/curves, @noble/ciphers)
4. Sign ticket `{ tokenId, contract, chainId, ownerAddress, wrappedContentKey, issuedAt, expiresAt }` with the platform key
5. Return ticket

Same endpoint serves renewal and re-wrap-on-resale (buyer's first SIWE after purchase triggers issuance).
