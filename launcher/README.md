# launcher — Tauri v2 (Rust shell, TS logic, web UI)

## Split of responsibilities
- **Rust**: removable-volume scan (`sysinfo`), read/write `/gamevault/` files, device keypair in OS keystore, AES decryption, custom protocol handler serving the decrypted bundle FROM MEMORY. Plaintext never reaches the webview or disk.
- **TypeScript (webview)**: ticket/session verification logic (@noble/curves), viem `ownerOf()` calls (allow the RPC endpoint in Tauri CSP `connect-src`), UI. viem + @noble are browser-compatible — no Node APIs.

## Launch flow
1. Scan mounted removable volumes for `/gamevault/ticket.json`
2. Verify ticket platform signature (platform pubkey embedded in binary)
3. Verify cached pairing session: SIWE signed by the ticket owner, message binds THIS device's pubkey
4. Nonce self-check with the device key (proves keystore possession)
5. Hybrid owner check: network reachable (2s timeout, AbortController) → live `ownerOf()` → instant revocation; offline → signature + expiry (30-day window)
6. ECIES-unwrap content key with device privkey; decrypt build in Rust memory; serve Phaser bundle via custom protocol

## Pairing (first launch, online once)
Launcher generates device keypair (OS keystore) → QR embeds device pubkey + nonce → owner signs SIWE on web page (message binds device pubkey) → ticketd issues ticket wrapped to device pubkey → launcher caches pairing session + writes `ticket.json` to media. All later launches are fully offline. On renewal, rewrite `ticket.json` in place (why USB/SD beats CD-R).
