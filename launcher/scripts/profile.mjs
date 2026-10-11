// Launcher build profiles (2026-10-11) — where a launcher build talks to.
//
// One JSON file per target in launcher/profiles/ (local, compose,
// production…). The profile is chosen at BUILD time with GAMEVAULT_PROFILE
// (a name or a path; default "local") and baked into the binary: the
// webview gets it through Vite (`__GV_PROFILE__`), the Rust core through
// build.rs (same file, same rules), the CSP and the "open in browser"
// allow-list through a generated Tauri config (src-tauri/profile.conf.json).
// Nothing is read at run time: an installed launcher cannot be pointed at
// another server by editing a file.
//
//   node scripts/profile.mjs show [profile]          normalized profile + CSP
//   node scripts/profile.mjs dev [profile]           tauri dev with that profile
//   node scripts/profile.mjs build [profile] [args]  tauri build (release checks)
//
// The base src-tauri/tauri.conf.json stays the "local" profile, so a plain
// `npx tauri dev` keeps working exactly as before.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LAUNCHER = resolve(HERE, "..");
const REPO = resolve(LAUNCHER, "..");

const DEFAULT_GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Base RPC of shared/src/deployments.ts (the default when a profile has none). */
function chainRpc() {
  const src = readFileSync(join(REPO, "shared", "src", "deployments.ts"), "utf8");
  const m = src.match(/rpcUrl:\s*"([^"]+)"/);
  if (!m) throw new Error("rpcUrl introuvable dans shared/src/deployments.ts");
  return m[1];
}

function profilePath(nameOrPath) {
  const n = nameOrPath || process.env.GAMEVAULT_PROFILE || "local";
  if (n.endsWith(".json")) return isAbsolute(n) ? n : resolve(process.cwd(), n);
  if (!/^[a-z0-9-]+$/.test(n)) throw new Error(`profil invalide : ${n}`);
  return join(LAUNCHER, "profiles", `${n}.json`);
}

function url(v, field, { slash = false } = {}) {
  let u;
  try {
    u = new URL(String(v));
  } catch {
    throw new Error(`${field} : URL invalide (${v})`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) {
    throw new Error(`${field} : https obligatoire hors de cette machine (${v})`);
  }
  if (u.search || u.hash) throw new Error(`${field} : pas de ?query ni de #fragment (${v})`);
  const s = u.toString();
  return slash ? (s.endsWith("/") ? s : `${s}/`) : s.replace(/\/+$/, "");
}

/**
 * Reads, completes and checks a profile. `release` adds the checks a
 * shipped binary must pass (real hosts, a ticket key, no POC services).
 */
export function loadProfile(nameOrPath, { release = false } = {}) {
  const file = profilePath(nameOrPath);
  if (!existsSync(file)) throw new Error(`profil introuvable : ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const p = {
    name: String(raw.name ?? ""),
    ticketdUrl: url(raw.ticketdUrl, "ticketdUrl"),
    webUrl: url(raw.webUrl, "webUrl"),
    buildsUrl: "",
    rpcUrl: url(raw.rpcUrl ?? chainRpc(), "rpcUrl"),
    ipfsGateways: (raw.ipfsGateways ?? DEFAULT_GATEWAYS).map((g, i) => url(g, `ipfsGateways[${i}]`, { slash: true })),
    ticketSignerPubKeys: (raw.ticketSignerPubKeys ?? []).map((k) => String(k).toLowerCase().replace(/^0x/, "")),
    localServices: raw.localServices === true,
  };
  p.buildsUrl = url(raw.buildsUrl ?? `${p.ticketdUrl}/build/`, "buildsUrl", { slash: true });
  if (!/^[a-z0-9-]+$/.test(p.name)) throw new Error(`name : [a-z0-9-] attendu (${raw.name})`);
  for (const k of p.ticketSignerPubKeys) {
    if (!/^0[23][0-9a-f]{64}$/.test(k)) throw new Error(`ticketSignerPubKeys : clé secp256k1 compressée attendue (${k})`);
  }
  if (release) {
    const problems = [];
    for (const [f, v] of [["ticketdUrl", p.ticketdUrl], ["webUrl", p.webUrl], ["buildsUrl", p.buildsUrl]]) {
      const h = new URL(v).hostname;
      if (/\.(example|invalid|test)$/.test(h) || h === "example.com") problems.push(`${f} vise encore un hôte d'exemple (${h})`);
    }
    if (!p.ticketSignerPubKeys.length) problems.push("ticketSignerPubKeys vide : aucun ticket ne serait accepté");
    if (p.name === "production" && p.localServices) problems.push("localServices doit être false en production");
    if (problems.length) throw new Error(`profil « ${p.name} » refusé pour une release :\n  - ${problems.join("\n  - ")}`);
  }
  return p;
}

const origin = (u) => new URL(u).origin;

/** CSP of the main window for this profile (devCsp adds Vite's websocket). */
export function cspFor(p, { dev = false } = {}) {
  const api = new Set([origin(p.ticketdUrl)]);
  if (LOOPBACK.has(new URL(p.ticketdUrl).hostname)) {
    const port = new URL(p.ticketdUrl).port;
    for (const h of ["localhost", "127.0.0.1"]) api.add(`http://${h}${port ? `:${port}` : ""}`);
  }
  const connect = new Set(["'self'", "ipc:", "http://ipc.localhost", ...(dev ? ["ws://localhost:1420"] : []), ...api, origin(p.buildsUrl), origin(p.rpcUrl), ...p.ipfsGateways.map(origin)]);
  return {
    "default-src": "'self'",
    "script-src": "'self'",
    "style-src": "'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src": "'self' https://fonts.gstatic.com",
    "img-src": ["'self'", "data:", "blob:", ...api].join(" "),
    "connect-src": [...connect].join(" "),
    "frame-src": "game: http://game.localhost",
    "object-src": "'none'",
    "base-uri": "'self'",
  };
}

/**
 * Tauri config merged over tauri.conf.json (JSON Merge Patch): the CSP,
 * and the capabilities — the base files minus the local "open in browser"
 * list, plus this profile's site as the only URL the launcher may open.
 */
export function tauriOverride(p) {
  return {
    app: {
      security: {
        csp: cspFor(p),
        devCsp: cspFor(p, { dev: true }),
        capabilities: [
          "default",
          "toast",
          {
            identifier: `opener-${p.name}`,
            description: `Pages of the ${p.name} site the launcher may open in the browser`,
            windows: ["main"],
            permissions: [{ identifier: "opener:allow-open-url", allow: [{ url: p.webUrl }, { url: `${p.webUrl}/*` }] }],
          },
        ],
      },
    },
  };
}

// The VS C++ tools are not on PATH on this machine (cl.exe missing):
// run through vcvars64 when needed, found with vswhere.
function vcvars() {
  if (process.platform !== "win32") return null;
  if (spawnSync("where", ["cl.exe"], { stdio: "ignore", shell: true }).status === 0) return null;
  const tail = ["VC", "Auxiliary", "Build", "vcvars64.bat"];
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  if (existsSync(vswhere)) {
    const r = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8" });
    const bat = r.stdout?.trim() ? join(r.stdout.trim(), ...tail) : "";
    if (bat && existsSync(bat)) return bat;
  }
  // vswhere can miss a Build Tools install (seen on this machine): known paths.
  for (const root of ["C:\\Program Files\\Microsoft Visual Studio", "C:\\Program Files (x86)\\Microsoft Visual Studio"]) {
    for (const year of ["2022", "2019"]) {
      for (const ed of ["BuildTools", "Community", "Professional", "Enterprise"]) {
        const bat = join(root, year, ed, ...tail);
        if (existsSync(bat)) return bat;
      }
    }
  }
  return null;
}

function runTauri(mode, name, extra) {
  const p = loadProfile(name, { release: mode === "build" && !extra.includes("--debug") });
  const conf = join(LAUNCHER, "src-tauri", "profile.conf.json");
  writeFileSync(conf, `${JSON.stringify(tauriOverride(p), null, 2)}\n`);
  const env = { ...process.env, GAMEVAULT_PROFILE: name || process.env.GAMEVAULT_PROFILE || "local" };
  const tauri = `npx tauri ${mode} --config src-tauri/profile.conf.json ${extra.join(" ")}`.trim();
  const bat = vcvars();
  const cmd = bat ? `call "${bat}" >nul && ${tauri}` : tauri;
  console.log(`[profile] ${p.name} → ticketd ${p.ticketdUrl} · site ${p.webUrl}${bat ? " (vcvars64)" : ""}`);
  const r = spawnSync(cmd, { cwd: LAUNCHER, env, stdio: "inherit", shell: true });
  process.exit(r.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd = "show", name, ...extra] = process.argv.slice(2);
  try {
    if (cmd === "show") {
      const p = loadProfile(name);
      let release = "OK";
      try {
        loadProfile(name, { release: true });
      } catch (e) {
        release = String(e.message);
      }
      console.log(JSON.stringify({ profile: p, csp: cspFor(p)["connect-src"], release }, null, 2));
    } else if (cmd === "dev" || cmd === "build") {
      runTauri(cmd, name, extra);
    } else {
      throw new Error(`commande inconnue : ${cmd} (show | dev | build)`);
    }
  } catch (e) {
    console.error(`[profile] ${e.message}`);
    process.exit(1);
  }
}
