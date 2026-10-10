// End-to-end test of ticketd running as SEVERAL replicas (Postgres + Redis)
// in Kubernetes — 2026-10-11. Each step talks to a SPECIFIC pod, so a pass
// proves the state is shared, not just that one pod works.
//
//   node deploy/e2e-multireplica.mjs            (kubectl context = the cluster)
//   node deploy/e2e-multireplica.mjs --rollout  (+ graceful rolling restart under load)
//
// Uses throwaway random wallets; writes only test rows (sessions, a
// friendship, chat messages, a profile) for those wallets.

import { spawn, execFileSync } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const NS = "gamevault";
const kubectl = (...a) => execFileSync("kubectl", ["-n", NS, ...a], { encoding: "utf8" }).trim();
let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── port-forward one local port per ticketd pod ─────────────────────────
const pods = kubectl("get", "pods", "-l", "app.kubernetes.io/name=ticketd", "--field-selector=status.phase=Running", "-o", "jsonpath={.items[*].metadata.name}").split(/\s+/).filter(Boolean);
if (pods.length < 2) {
  console.error(`❌ il faut au moins 2 pods ticketd (trouvés : ${pods.length})`);
  process.exit(1);
}
const forwards = [];
const base = [];
for (const [i, pod] of pods.slice(0, 2).entries()) {
  const port = 19101 + i;
  const pf = spawn("kubectl", ["-n", NS, "port-forward", `pod/${pod}`, `${port}:8787`], { stdio: "ignore" });
  forwards.push(pf);
  base.push(`http://127.0.0.1:${port}`);
}
const cleanup = () => forwards.forEach((p) => p.kill());
process.on("exit", cleanup);
for (const b of base) {
  for (let i = 0; i < 40; i++) {
    if (await fetch(`${b}/health`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }
}
console.log(`pods : ${pods.slice(0, 2).join(" · ")}\n`);
const [P1, P2] = base;

const call = async (b, path, { token, body, method } = {}) => {
  const res = await fetch(`${b}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
};

// ── 1. sessions: opened on one pod, valid on the other; replay refused ──
const A = privateKeyToAccount(generatePrivateKey());
const B = privateKeyToAccount(generatePrivateKey());
const sessionMsg = (acc) => ["GameVault Session", `me: ${acc.address}`, `at: ${new Date().toISOString()}`, `nonce: ${crypto.randomUUID()}`].join("\n");
const msgA = sessionMsg(A);
const sigA = await A.signMessage({ message: msgA });
const sA = await call(P1, "/session", { body: { message: msgA, signature: sigA } });
check("session A ouverte sur le pod 1", sA.status === 200);
const tokA = sA.json?.token;
check("le jeton de A est valide sur le pod 2 (Postgres partagé)", (await call(P2, "/session", { token: tokA })).json?.wallet === A.address.toLowerCase());
check("rejouer la signature de A sur le pod 2 est refusé (nonce partagé)", (await call(P2, "/session", { body: { message: msgA, signature: sigA } })).status === 403);
const msgB = sessionMsg(B);
const tokB = (await call(P2, "/session", { body: { message: msgB, signature: await B.signMessage({ message: msgB }) } })).json?.token;
check("session B ouverte sur le pod 2", Boolean(tokB));

// ── 2. friendship across pods ───────────────────────────────────────────
check("A demande B en ami (pod 1)", (await call(P1, "/friends/action", { token: tokA, body: { action: "request", other: B.address } })).status === 200);
check("B accepte (pod 2)", (await call(P2, "/friends/action", { token: tokB, body: { action: "accept", other: A.address } })).status === 200);

// ── 3. live event: B's stream on pod 2 receives A's message sent to pod 1
const events = [];
const ctrl = new AbortController();
let streamEnded = false;
(async () => {
  try {
    const res = await fetch(`${P2}/events?token=${encodeURIComponent(tokB)}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      events.push(dec.decode(value));
    }
  } catch {}
  streamEnded = true;
})();
await sleep(800);
const sent = await call(P1, "/chat/" + B.address, { token: tokA, body: { text: "message inter-répliques" } });
check("A envoie un message via le pod 1", sent.status === 200);
let got = false;
for (let i = 0; i < 30 && !got; i++) {
  got = events.join("").includes("message inter-répliques");
  if (!got) await sleep(100);
}
check("le flux SSE de B, tenu par le pod 2, reçoit le message (Redis pub/sub)", got);

// ── 4. presence set on pod 1, seen through pod 2 ───────────────────────
await call(P1, "/presence", { token: tokA, body: { playing: "2" } });
const fr = await call(P2, `/friends/${B.address}`, { token: tokB });
check("la présence de A (pod 1) est visible depuis le pod 2", fr.json?.friends?.[0]?.presence?.state === "playing");

// ── 5. chat rate limit shared by the replicas ──────────────────────────
let refusedAt = -1;
for (let i = 2; i <= 32; i++) {
  const r = await call(i % 2 ? P1 : P2, "/chat/" + B.address, { token: tokA, body: { text: `rafale ${i}` } });
  if (r.status !== 200) {
    refusedAt = i;
    break;
  }
}
check("la limite du chat (30/min) tient en alternant les pods", refusedAt === 31, `refus au message n°${refusedAt}`);

// ── 6. avatar saved through pod 1, served by pod 2 ─────────────────────
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(600, 9)]);
const saved = await call(P1, "/profile", { token: tokA, body: { name: "E2E A", bio: "test multi-répliques", favorites: [], avatar: png.toString("base64") } });
check("profil + avatar enregistrés via le pod 1", saved.status === 200);
const av = await fetch(`${P2}/profile/avatar/${A.address.toLowerCase()}`);
const avBytes = Buffer.from(await av.arrayBuffer());
check("l'avatar est servi par le pod 2 (stocké en base)", av.status === 200 && avBytes.equals(png));

// ── 7. readiness reports both backends ─────────────────────────────────
const ready = await call(P1, "/ready");
check("/ready : postgres + redis", ready.json?.db === "postgres" && ready.json?.live === "redis" && ready.json?.liveOk === true);

// ── 8. optional: graceful rolling restart under load ───────────────────
// Through the ingress controller (it follows the Service endpoints, like
// production traffic): a graceful shutdown means no failed request.
if (process.argv.includes("--rollout")) {
  const ing = spawn("kubectl", ["-n", "ingress-nginx", "port-forward", "svc/ingress-nginx-controller", "19443:443"], { stdio: "ignore" });
  process.on("exit", () => ing.kill());
  await sleep(2000);
  // fetch() ignores a Host header: plain https.request, SNI + Host set by hand;
  // the controller answers with its self-signed default certificate (local only)
  const hit = () =>
    new Promise((resolve) => {
      const req = httpsRequest(
        { host: "127.0.0.1", port: 19443, path: "/health", servername: "api.gamevault.local", headers: { Host: "api.gamevault.local" }, rejectUnauthorized: false, timeout: 3000 },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(0));
      req.end();
    });
  console.log(`\n… redémarrage progressif de ticketd sous charge (via l'ingress) — premier appel : ${await hit()}`);
  execFileSync("kubectl", ["-n", NS, "rollout", "restart", "deployment/ticketd"]);
  let finished = false;
  const status = spawn("kubectl", ["-n", NS, "rollout", "status", "deployment/ticketd", "--timeout=240s"], { stdio: "ignore" });
  status.on("exit", () => (finished = true));
  const codes = {};
  while (!finished) {
    // ~7 req/s: under the api Ingress limit (10/s per IP), so a refusal
    // can only come from the rollout. /health, not /ready: a draining pod
    // answers 503 on /ready ON PURPOSE (that is how it leaves the Service).
    const c = await hit();
    codes[c] = (codes[c] ?? 0) + 1;
    await sleep(140);
  }
  for (let i = 0; i < 20; i++) {
    const c = await hit();
    codes[c] = (codes[c] ?? 0) + 1;
    await sleep(140);
  }
  const total = Object.values(codes).reduce((x, y) => x + y, 0);
  const failed = total - (codes[200] ?? 0);
  console.log(`   ${total} requêtes : ${JSON.stringify(codes)}`);
  check("aucune requête perdue pendant le redémarrage progressif", failed === 0, `${failed} échec(s)`);
  for (let i = 0; i < 50 && !streamEnded; i++) await sleep(100);
  check("le flux SSE du pod arrêté se ferme (le client peut se reconnecter ailleurs)", streamEnded);
}

ctrl.abort();
console.log(failures === 0 ? "\nTout est vert — ticketd partage bien son état entre répliques." : `\n${failures} contrôle(s) en échec`);
process.exit(failures === 0 ? 0 : 1);
