// `npm run backup -w ticketd` — consistent online snapshot of the database.
//   • SQLite (default): VACUUM INTO data/backups/ticketd-<date>.db (works
//     while ticketd runs).
//   • Postgres (DATABASE_URL): pg_dump --format=custom into data/backups/
//     (needs the pg_dump client on PATH; in Kubernetes the backup CronJob
//     does the same — k8s/base/postgres.yaml). Restore: docs/runbook.md.
//
// A backup holds the game keys ENCRYPTED: it is useless without
// KEYSTORE_MASTER_KEY, which must be kept elsewhere (password manager) —
// never next to the backup.

import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./db.ts";

const dir = join(DATA_DIR, "backups");
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const url = process.env.DATABASE_URL;

if (url) {
  const target = join(dir, `ticketd-${stamp}.dump`);
  const r = spawnSync("pg_dump", ["--format=custom", "--no-owner", "--file", target, url], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.error || r.status !== 0) {
    console.error(`❌ pg_dump a échoué${r.error ? ` (${r.error.message} — installez le client PostgreSQL)` : ""}`);
    process.exit(1);
  }
  console.log(`✔ sauvegarde Postgres : ${target} (${statSync(target).size} o)`);
  console.log("  restauration : pg_restore --clean --if-exists --no-owner -d <DATABASE_URL> " + target);
} else {
  const target = join(dir, `ticketd-${stamp}.db`);
  const db = new DatabaseSync(join(DATA_DIR, "ticketd.db"));
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const counts = db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM content_keys) AS keys, (SELECT COUNT(*) FROM friendships) AS friends, (SELECT COUNT(*) FROM profiles) AS profiles, (SELECT COUNT(*) FROM devices) AS devices",
    )
    .get();
  db.close();
  console.log(`✔ sauvegarde SQLite : ${target}`);
  console.log("  contenu :", { ...(counts as Record<string, number>) });
}
console.log("  ⚠ la clé KEYSTORE_MASTER_KEY n'est PAS dans la sauvegarde — gardez-la ailleurs.");
