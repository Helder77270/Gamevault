# station — cartridge writer (Node script)

USB/SD only — no CD burning (no xorriso, no IMAPI2). Detect a mounted removable volume and write the `/gamevault/` payload:

```
/gamevault/
  build.enc     # AES-256-GCM encrypted Phaser bundle (same for every copy)
  ticket.json   # platform-signed, wrapped to current owner
  meta.json     # game metadata, cover art
  launcher/     # launcher binaries
```

The wallet private key NEVER touches the media or the station.
