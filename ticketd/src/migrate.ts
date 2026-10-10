// Database operations (2026-10-11):
//
//   npm run migrate -w @gamevault/ticketd
//       apply pending Postgres migrations (DATABASE_URL). ticketd does it
//       at start-up anyway; this is for CI/CD or a manual check.
//   npm run migrate -w @gamevault/ticketd -- --status
//       list applied / pending migrations.
//   npm run migrate -w @gamevault/ticketd -- --from-sqlite [file] [--force]
//       copy a SQLite database (default data/ticketd.db, opened READ-ONLY)
//       into Postgres, in one transaction. Refuses a non-empty target unless
//       --force. Content keys are copied still encrypted: the target ticketd
//       must use the SAME KEYSTORE_MASTER_KEY (checked on one key).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { gcm } from "@noble/ciphers/aes";
import { DATA_DIR } from "./db.ts";
import { MIGRATIONS, migratePostgres } from "./sql.ts";

const argv = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("❌ DATABASE_URL manquant (postgres://user:pass@host:5432/db)");
  process.exit(1);
}

// Tables in dependency-free order; `keepIds` = identity columns whose values
// matter (chat read markers point at message ids).
const TABLES: { name: string; cols: string[]; keepIds?: boolean; where?: string }[] = [
  { name: "content_keys", cols: ["cid", "key_enc", "publisher", "studio_id", "created_at"] },
  { name: "nonces", cols: ["nonce", "expires_at"], where: `expires_at > ${Date.now()}` },
  { name: "friend_requests", cols: ["from_addr", "to_addr", "at"] },
  { name: "friendships", cols: ["lo", "hi", "since"] },
  { name: "profiles", cols: ["addr", "name", "avatar_type", "favorites", "updated_at", "bio", "created_at"] },
  { name: "playstats", cols: ["addr", "edition_id", "seconds"] },
  { name: "devices", cols: ["wallet", "pubkey", "paired_at", "last_seen"] },
  { name: "sessions", cols: ["token_hash", "wallet", "device", "expires_at"], where: `expires_at > ${Date.now()}` },
  { name: "activity", cols: ["id", "wallet", "kind", "data", "at"], keepIds: true },
  { name: "studio_pages", cols: ["studio_id", "description", "links", "team", "updated_at", "updated_by"] },
  { name: "messages", cols: ["id", "conv", "from_addr", "to_addr", "kind", "body", "at", "read_at"], keepIds: true },
  { name: "wishlist", cols: ["addr", "edition_id", "seen_wei", "at"] },
  { name: "privacy", cols: ["addr", "data", "updated_at"] },
  { name: "avatars", cols: ["addr", "type", "bytes", "updated_at"] },
];

async function status(): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const rows = await c
    .query("SELECT version, name, applied_at FROM schema_migrations ORDER BY version")
    .then((r) => r.rows as { version: number; name: string; applied_at: string }[])
    .catch(() => []);
  await c.end();
  const done = new Map(rows.map((r) => [r.version, r]));
  for (const m of MIGRATIONS) {
    const d = done.get(m.version);
    console.log(`${d ? "✔" : "·"} v${m.version} ${m.name}${d ? ` — ${new Date(Number(d.applied_at)).toISOString()}` : " — EN ATTENTE"}`);
  }
}

function sqliteHasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/** The target must decrypt the source's keys: same master key. */
function checkMasterKey(db: DatabaseSync): void {
  const row = db.prepare("SELECT cid, key_enc FROM content_keys LIMIT 1").get() as { cid: string; key_enc: Uint8Array } | undefined;
  if (!row) return;
  const hex = process.env.KEYSTORE_MASTER_KEY?.replace(/^0x/, "") ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("KEYSTORE_MASTER_KEY absent : impossible de vérifier que la cible pourra lire les clés de jeux");
  try {
    const sealed = new Uint8Array(row.key_enc);
    gcm(Uint8Array.from(Buffer.from(hex, "hex")), sealed.slice(0, 12), new TextEncoder().encode(row.cid)).decrypt(sealed.slice(12));
  } catch {
    throw new Error("KEYSTORE_MASTER_KEY ne déchiffre pas les clés de la source — mauvaise clé, copie annulée");
  }
}

async function fromSqlite(file: string, force: boolean): Promise<void> {
  if (!existsSync(file)) throw new Error(`fichier introuvable : ${file}`);
  const src = new DatabaseSync(file, { readOnly: true });
  checkMasterKey(src);
  await migratePostgres(url!);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    if (!force) {
      for (const t of TABLES) {
        const n = Number((await c.query(`SELECT COUNT(*) AS n FROM ${t.name}`)).rows[0].n);
        if (n > 0) throw new Error(`la table ${t.name} de la cible contient déjà ${n} ligne(s) — relancer avec --force pour écraser`);
      }
    }
    await c.query("BEGIN");
    const report: Record<string, number> = {};
    for (const t of TABLES) {
      if (force) await c.query(`DELETE FROM ${t.name}`);
      if (!sqliteHasTable(src, t.name)) {
        report[t.name] = 0;
        continue;
      }
      const have = new Set((src.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((x) => x.name));
      const cols = t.cols.filter((col) => have.has(col));
      const rows = src.prepare(`SELECT ${cols.join(", ")} FROM ${t.name}${t.where ? ` WHERE ${t.where}` : ""}`).all() as Record<string, unknown>[];
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const sql = `INSERT INTO ${t.name} (${cols.join(", ")}) ${t.keepIds ? "OVERRIDING SYSTEM VALUE " : ""}VALUES (${placeholders})`;
      for (const r of rows) {
        await c.query(
          sql,
          cols.map((col) => {
            const v = r[col];
            return v instanceof Uint8Array ? Buffer.from(v) : typeof v === "bigint" ? v.toString() : v;
          }),
        );
      }
      if (t.keepIds && rows.length) {
        // the identity sequence continues after the copied ids
        await c.query(`SELECT setval(pg_get_serial_sequence('${t.name}', 'id'), (SELECT MAX(id) FROM ${t.name}))`);
      }
      report[t.name] = rows.length;
    }
    // avatars that were still files (pre-2026-10-11 layout)
    const avDir = join(DATA_DIR, "avatars");
    if (existsSync(avDir)) {
      for (const name of readdirSync(avDir)) {
        if (!/^0x[0-9a-f]{40}$/.test(name)) continue;
        const p = (await c.query("SELECT avatar_type FROM profiles WHERE addr = $1", [name])).rows[0] as { avatar_type: string | null } | undefined;
        if (!p?.avatar_type) continue;
        const r = await c.query("INSERT INTO avatars (addr, type, bytes, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (addr) DO NOTHING", [
          name,
          p.avatar_type,
          readFileSync(join(avDir, name)),
          Date.now(),
        ]);
        report.avatars += r.rowCount ?? 0;
      }
    }
    await c.query("COMMIT");
    console.log("✔ copie SQLite → Postgres terminée");
    for (const [k, v] of Object.entries(report)) console.log(`   ${k.padEnd(16)} ${v}`);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await c.end();
    src.close();
  }
}

try {
  if (argv.includes("--status")) {
    await status();
  } else if (argv.includes("--from-sqlite")) {
    const i = argv.indexOf("--from-sqlite");
    const next = argv[i + 1];
    const file = next && !next.startsWith("--") ? next : join(DATA_DIR, "ticketd.db");
    await fromSqlite(file, argv.includes("--force"));
  } else {
    const applied = await migratePostgres(url);
    console.log(applied.length ? `✔ migrations appliquées : ${applied.join(", ")}` : "✔ schéma à jour, rien à appliquer");
  }
} catch (e) {
  console.error(`❌ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
