// `npm run backup -w ticketd` — consistent online snapshot of the SQLite DB
// (VACUUM INTO works while ticketd runs). The snapshot holds the game keys
// ENCRYPTED: it is useless without KEYSTORE_MASTER_KEY, which must be kept
// elsewhere (password manager) — never next to the backup.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, db } from "./db.ts";

const dir = join(DATA_DIR, "backups");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = join(dir, `ticketd-${stamp}.db`);
db().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
const counts = db()
  .prepare(
    "SELECT (SELECT COUNT(*) FROM content_keys) AS keys, (SELECT COUNT(*) FROM friendships) AS friends, (SELECT COUNT(*) FROM profiles) AS profiles, (SELECT COUNT(*) FROM devices) AS devices",
  )
  .get();
console.log(`✔ sauvegarde : ${target}`);
console.log("  contenu :", { ...(counts as Record<string, number>) });
console.log("  ⚠ la clé KEYSTORE_MASTER_KEY n'est PAS dans la sauvegarde — gardez-la ailleurs.");
