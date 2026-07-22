// Cartridge writer: copies the /gamevault/ payload onto a mounted USB/SD
// volume. Plain file copy — no burning, no OS device APIs (why USB/SD
// replaced CDs). The wallet private key never touches this tool.
//
//   npm run write -w station              -> list removable volumes
//   npm run write -w station -- E:        -> write cartridge to E:
//
// Payload source: launcher/dev-media/gamevault (canonical dev payload).
// Regenerate it first: npm run build -w game && npm run make-dev-ticket -w shared

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../../launcher/dev-media/gamevault");

function listRemovableWindows(): string[] {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", "Get-Volume | Where-Object DriveType -eq 'Removable' | Select-Object -ExpandProperty DriveLetter"],
      { encoding: "utf8" },
    );
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((letter) => `${letter}:`);
  } catch {
    return [];
  }
}

function listRemovable(): string[] {
  if (process.platform === "win32") return listRemovableWindows();
  // macOS/Linux: removable media shows up under these roots
  for (const root of ["/Volumes", `/media/${process.env.USER ?? ""}`, "/run/media"]) {
    if (existsSync(root)) return readdirSync(root).map((n) => join(root, n));
  }
  return [];
}

const target = process.argv[2];

if (!target) {
  const found = listRemovable();
  console.log("Volumes amovibles détectés :");
  console.log(found.length ? found.map((v) => `  ${v}`).join("\n") : "  (aucun — insérez une clé USB / carte SD)");
  console.log("\nÉcrire une cartouche : npm run write -w station -- <volume>   (ex. E:)");
  process.exit(0);
}

// Sanity checks — fail loud, never write blind
for (const f of ["ticket.json", "build.enc", "meta.json"]) {
  if (!existsSync(join(SOURCE, f))) {
    console.error(`❌ ${f} manquant dans ${SOURCE}`);
    console.error("   Regénérez : npm run build -w game && npm run make-dev-ticket -w shared");
    process.exit(1);
  }
}
const targetRoot = process.platform === "win32" && /^[A-Za-z]:$/.test(target) ? `${target}\\` : target;
if (!existsSync(targetRoot)) {
  console.error(`❌ volume introuvable : ${targetRoot}`);
  process.exit(1);
}

const dest = join(targetRoot, "gamevault");
mkdirSync(dest, { recursive: true });

let total = 0;
for (const f of readdirSync(SOURCE)) {
  copyFileSync(join(SOURCE, f), join(dest, f));
  total += statSync(join(dest, f)).size;
  console.log(`  ✔ ${f}`);
}

console.log(`\n💾 Cartouche écrite : ${dest} (${(total / 1024 / 1024).toFixed(2)} Mo)`);
console.log("Le ticket embarqué est scellé pour l'appareil qui l'a appairé —");
console.log("sur une autre machine, le launcher proposera l'appairage (flux de revente).");
