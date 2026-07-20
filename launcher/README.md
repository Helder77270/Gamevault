# launcher — Tauri v2 (Rust shell, TS logic, web UI)

Launch flow:
1. Scan mounted removable volumes for `/gamevault/ticket.json` (`sysinfo`)
2. Verify ticket platform signature (platform pubkey embedded in binary)
3. Nonce challenge signed by paired wallet; signer must equal ticket owner
4. Hybrid owner check: if network reachable (2s timeout) → live `ownerOf()` (instant revocation); else → signature + expiry (30-day offline window)
5. Unwrap AES content key, decrypt build IN MEMORY, serve Phaser bundle via custom protocol handler — never write plaintext to disk

Pairing: first launch shows QR → web SIWE page → cache owner pubkey + signed session. Subsequent launches are fully offline. On renewal, rewrite `ticket.json` on the media (why USB/SD beats CD-R).
