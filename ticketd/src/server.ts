// Thin HTTP wrapper around service.ts (tickets, builds, devices) and
// social.ts (sessions, profiles, friends, studio pages, chat). Zero
// framework. Routes: ticketd/README.md. Binds to 127.0.0.1 by default (HOST
// overrides), CORS restricted to the known front-ends, every request body
// size-capped.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import {
  attestFriendship,
  backdateFriendship,
  devicesOf,
  deviceStatus,
  buildFile,
  getBuildManifest,
  issueTicket,
  revokeDevice,
  takePendingTicket,
  publishBuild,
} from "./service.ts";
import {
  Unauthorized,
  addPlaystat,
  authWallet,
  chatSummary,
  chatThread,
  closeSession,
  friendAction,
  friendsOf,
  getAvatar,
  getProfile,
  getStudioPage,
  markRead,
  namesOf,
  openDeviceSession,
  openWebSession,
  saveProfile,
  saveStudioPage,
  searchProfiles,
  sendMessage,
  setPresence,
  studioAccount,
  subscribe,
  markWishSeen,
  privacyOf,
  setPrivacy,
  setWish,
  wishlistOf,
} from "./social.ts";

const MAX_UPLOAD = 100 * 1024 * 1024; // 100 MB (studio builds)
const MAX_JSON = 16 * 1024; // signed messages, chat, studio page
const MAX_PROFILE = 600 * 1024; // profile + base64 avatar

const PORT = Number(process.env.PORT ?? 8787);
/** Unset = loopback only (IPv4 + IPv6, so "localhost" works either way). */
const HOST = process.env.HOST;
const DEV = process.env.GAMEVAULT_DEV === "1";

const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:1420", // launcher webview, vite dev
  "http://tauri.localhost", // launcher webview, Windows release
  "tauri://localhost", // launcher webview, macOS/Linux release
  ...(process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);

const ADDR = "(0x[0-9a-fA-F]{40})";

class BodyTooLarge extends Error {}

/** Accumulates Buffers (never splits a multi-byte UTF-8 char) under a cap. */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const readJson = async (req: IncomingMessage, limit = MAX_JSON): Promise<Record<string, unknown>> => {
  const raw = (await readBody(req, limit)).toString("utf8");
  const v = raw ? JSON.parse(raw) : {};
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
};

/** Client-facing error text: our own messages are fine, but upstream
 *  errors (viem, Pinata) can embed RPC URLs with API keys — strip them. */
function publicError(e: unknown): string {
  if (e instanceof BodyTooLarge) return "payload trop lourd";
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/https?:\/\/\S+/g, "[url]").split("\n")[0].slice(0, 300);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin;
  const cors: Record<string, string> =
    origin && ALLOWED_ORIGINS.has(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-GameVault-Message, X-GameVault-Signature",
          Vary: "Origin",
        }
      : {};
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", ...cors });
    res.end(JSON.stringify(body));
  };
  const fail = (status: number, scope: string, e: unknown) => {
    console.warn(`⛔ ${scope}: ${e instanceof Error ? e.message : e}`);
    const code = e instanceof BodyTooLarge ? 413 : e instanceof Unauthorized ? 401 : status;
    return send(code, { error: publicError(e) });
  };

  // Route on the PATH only: a query string (e.g. the avatar's ?t= cache
  // buster) must not make a route miss. Plain string split — `new URL()`
  // throws on targets Node accepts (e.g. "//"), which would kill the process.
  const raw = req.url ?? "/";
  const qi = raw.indexOf("?");
  const path = qi < 0 ? raw : raw.slice(0, qi);
  const query = new URLSearchParams(qi < 0 ? "" : raw.slice(qi + 1));
  const GET = req.method === "GET";
  const HEAD = req.method === "HEAD";
  const POST = req.method === "POST";
  const match = (re: string) => path.match(new RegExp(`^${re}$`));
  const session = () => authWallet(req.headers.authorization);
  /** Who is looking, when a session is sent (privacy); null otherwise. */
  const viewer = (): string | null => {
    try {
      return session().wallet;
    } catch {
      return null;
    }
  };

  if (req.method === "OPTIONS") return send(204, {});
  if (GET && path === "/health") return send(200, { ok: true });

  // Launcher polls here after showing the pairing QR
  const pendingMatch = GET && match("/pending/([\\w-]+)");
  if (pendingMatch) {
    const ticket = takePendingTicket(pendingMatch[1]);
    return ticket ? send(200, ticket) : send(404, { error: "no ticket yet" });
  }

  // ── Sessions: one wallet signature (web) or the device key (launcher) ──
  if (path === "/session") {
    try {
      if (POST) {
        const { message, signature } = await readJson(req);
        return send(200, await openWebSession(String(message ?? ""), String(signature ?? "") as `0x${string}`));
      }
      if (GET) return send(200, session());
      if (req.method === "DELETE") return send(200, closeSession(req.headers.authorization));
    } catch (e) {
      return fail(403, "session", e);
    }
  }
  if (POST && path === "/session/device") {
    try {
      const { message, signature } = await readJson(req);
      return send(200, openDeviceSession(String(message ?? ""), String(signature ?? "")));
    } catch (e) {
      return fail(403, "session appareil", e);
    }
  }

  // ── Live events (SSE): token in the query, EventSource can't set headers ──
  if (GET && path === "/events") {
    try {
      const { wallet } = authWallet(query.get("token") ?? undefined);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...cors });
      res.write(": connected\n\n");
      subscribe(wallet, res);
      return;
    } catch (e) {
      return fail(401, "events", e);
    }
  }

  // ── Profiles: public read, session write ─────────────────────────────
  const avatarMatch = GET && match(`/profile/avatar/${ADDR}`);
  if (avatarMatch) {
    const av = getAvatar(avatarMatch[1]);
    if (!av) return send(404, { error: "pas d'avatar" });
    res.writeHead(200, {
      "Content-Type": av.type,
      "Content-Length": av.bytes.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      ...cors,
    });
    res.end(Buffer.from(av.bytes));
    return;
  }
  if (GET && path === "/profile/search") {
    try {
      return send(200, await searchProfiles(query.get("q") ?? ""));
    } catch (e) {
      return fail(400, "recherche", e);
    }
  }
  const studioOf = GET && match(`/studios/of/${ADDR}`);
  if (studioOf) {
    try {
      return send(200, await studioAccount(studioOf[1]));
    } catch (e) {
      return fail(400, "studios", e);
    }
  }
  if (GET && path === "/profiles/names") return send(200, namesOf((query.get("a") ?? "").split(",")));
  const profileMatch = GET && match(`/profile/${ADDR}`);
  if (profileMatch) {
    try {
      return send(200, getProfile(profileMatch[1], viewer()));
    } catch (e) {
      return fail(400, "profil", e);
    }
  }
  if (path === "/profile/privacy" && (GET || POST)) {
    try {
      const me = session().wallet;
      return send(200, GET ? privacyOf(me) : setPrivacy(me, await readJson(req)));
    } catch (e) {
      return fail(403, "confidentialité", e);
    }
  }
  if (POST && path === "/profile") {
    try {
      return send(200, saveProfile(session().wallet, await readJson(req, MAX_PROFILE)));
    } catch (e) {
      return fail(403, "profil", e);
    }
  }
  if (POST && path === "/profile/playstat") {
    try {
      const { editionId, seconds } = await readJson(req);
      return send(200, addPlaystat(session().wallet, String(editionId), Number(seconds)));
    } catch (e) {
      return fail(403, "playstat", e);
    }
  }
  if (POST && path === "/presence") {
    try {
      const { playing } = await readJson(req);
      return send(200, setPresence(session().wallet, playing == null ? null : String(playing)));
    } catch (e) {
      return fail(403, "présence", e);
    }
  }

  // ── Wishlist (session, private to its owner) ─────────────────────────
  if (path === "/wishlist" && (GET || POST)) {
    try {
      const me = session().wallet;
      return send(200, GET ? wishlistOf(me) : setWish(me, await readJson(req)));
    } catch (e) {
      return fail(403, "souhaits", e);
    }
  }
  if (POST && path === "/wishlist/seen") {
    try {
      return send(200, markWishSeen(session().wallet, await readJson(req)));
    } catch (e) {
      return fail(403, "souhaits", e);
    }
  }

  // ── Studio public pages ──────────────────────────────────────────────
  const studioMatch = match("/studio/(\\d{1,9})/page");
  if (studioMatch && GET) {
    try {
      return send(200, getStudioPage(studioMatch[1]));
    } catch (e) {
      return fail(400, "studio", e);
    }
  }
  if (studioMatch && POST) {
    try {
      return send(200, await saveStudioPage(session().wallet, studioMatch[1], await readJson(req)));
    } catch (e) {
      return fail(403, "studio", e);
    }
  }

  // ── Device registry: 2 active machines per account ───────────────────
  const devStatus = GET && match(`/devices/${ADDR}/(0x[0-9a-fA-F]{66})/status`);
  if (devStatus) {
    try {
      return send(200, deviceStatus(devStatus[1], devStatus[2]));
    } catch (e) {
      return fail(400, "appareils", e);
    }
  }
  const devList = GET && match(`/devices/${ADDR}`);
  if (devList) {
    try {
      return send(200, devicesOf(devList[1]));
    } catch (e) {
      return fail(400, "appareils", e);
    }
  }
  if (POST && path === "/devices/revoke") {
    try {
      const body = await readJson(req);
      return send(200, await revokeDevice(String(body.message ?? ""), String(body.signature ?? "") as `0x${string}`));
    } catch (e) {
      return fail(403, "appareils", e);
    }
  }

  // ── Friends (session, zero gas) + lending attestation ────────────────
  const friendsMatch = GET && match(`/friends/${ADDR}`);
  if (friendsMatch) {
    try {
      return send(200, friendsOf(friendsMatch[1], viewer()));
    } catch (e) {
      return fail(400, "amis", e);
    }
  }
  if (POST && path.startsWith("/friends/")) {
    try {
      const body = await readJson(req);
      if (path === "/friends/action") return send(200, await friendAction(session().wallet, String(body.action), String(body.other)));
      if (path === "/friends/attest") {
        const me = session().wallet;
        if (me !== String(body.owner).toLowerCase()) throw new Error("seul le propriétaire peut demander l'attestation de prêt");
        return send(200, await attestFriendship(String(body.owner), String(body.borrower), String(body.tokenId)));
      }
      if (path === "/friends/backdate") {
        // DEV only (GAMEVAULT_DEV=1, set by `npm run dev`): simulates the
        // 3-day friendship age. Absent in prod — it bypasses the lending guard.
        if (!DEV) return send(404, { error: "not found" });
        return send(200, backdateFriendship(String(body.a), String(body.b), Number(body.since)));
      }
      return send(404, { error: "not found" });
    } catch (e) {
      return fail(403, "amis", e);
    }
  }

  // ── Chat (friends only, session) ─────────────────────────────────────
  if (GET && path === "/chat") {
    try {
      return send(200, chatSummary(session().wallet));
    } catch (e) {
      return fail(403, "chat", e);
    }
  }
  const chatRead = POST && match(`/chat/${ADDR}/read`);
  if (chatRead) {
    try {
      const { upTo } = await readJson(req);
      return send(200, markRead(session().wallet, chatRead[1], Number(upTo)));
    } catch (e) {
      return fail(403, "chat", e);
    }
  }
  const chatMatch = match(`/chat/${ADDR}`);
  if (chatMatch && GET) {
    try {
      return send(200, chatThread(session().wallet, chatMatch[1], Number(query.get("after") ?? 0)));
    } catch (e) {
      return fail(403, "chat", e);
    }
  }
  if (chatMatch && POST) {
    try {
      return send(200, sendMessage(session().wallet, chatMatch[1], await readJson(req)));
    } catch (e) {
      return fail(403, "chat", e);
    }
  }

  // Build distribution: local cache first, IPFS gateways as backup.
  // The client still verifies sha256 against the on-chain hash.
  // Chunk list for the launcher's download manager (verified chunks, repair).
  const manifestMatch = GET && match("/build/([A-Za-z0-9]{10,100})/manifest");
  if (manifestMatch) {
    try {
      return send(200, await getBuildManifest(manifestMatch[1]));
    } catch (e) {
      return fail(404, `manifest ${manifestMatch[1]}`, e);
    }
  }
  // HTTP ranges (one "bytes=a-b" range): resumable, parallel chunk downloads.
  const buildMatch = (GET || HEAD) && match("/build/([A-Za-z0-9]{10,100})");
  if (buildMatch) {
    try {
      const { path: file, size: total } = await buildFile(buildMatch[1]);
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(range[2] === "" ? total - 1 : Number(range[2]), total - 1);
        if (start > end || start >= total) {
          res.writeHead(416, { "Content-Range": `bytes */${total}`, ...cors });
          res.end();
          return;
        }
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          ...cors,
        });
        if (HEAD) res.end();
        else createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": total, "Accept-Ranges": "bytes", ...cors });
      if (HEAD) res.end();
      else createReadStream(file).on("error", () => res.destroy()).pipe(res);
      return;
    } catch (e) {
      return fail(404, `build ${buildMatch[1]}`, e);
    }
  }

  // Studio publish: raw build bytes in, studio-signed request in headers
  // (message base64 — headers cannot carry newlines) -> encrypted + pinned.
  if (POST && path === "/publish") {
    try {
      const msgB64 = req.headers["x-gamevault-message"];
      const signature = req.headers["x-gamevault-signature"];
      if (typeof msgB64 !== "string" || typeof signature !== "string") {
        return send(401, { error: "publication non signée par un studio" });
      }
      const message = Buffer.from(msgB64, "base64").toString("utf8");
      const bytes = await readBody(req, MAX_UPLOAD);
      return send(200, await publishBuild(new Uint8Array(bytes), message, signature as `0x${string}`));
    } catch (e) {
      return fail(403, "publish", e);
    }
  }

  if (POST && path === "/ticket") {
    try {
      const { message, signature } = await readJson(req);
      if (typeof message !== "string" || typeof signature !== "string") {
        return send(400, { error: "expected { message, signature }" });
      }
      const ticket = await issueTicket({ message, signature: signature as `0x${string}` });
      console.log(`✔ ticket issued: token ${ticket.tokenId} -> device ${ticket.devicePubKey.slice(0, 12)}…`);
      return send(200, ticket);
    } catch (e) {
      return fail(403, "ticket", e);
    }
  }

  send(404, { error: "not found" });
}

// Last line of defence: an unexpected throw answers 500 instead of an
// unhandled rejection taking the whole service down.
function safeHandle(req: IncomingMessage, res: ServerResponse): void {
  handle(req, res).catch((e: unknown) => {
    console.error(`⛔ requête ${req.method} ${req.url}: ${e instanceof Error ? e.message : e}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "erreur interne" }));
  });
}

const tag = DEV ? " (DEV helpers ON)" : "";
if (HOST) {
  createServer(safeHandle).listen(PORT, HOST, () => console.log(`ticketd listening on http://${HOST}:${PORT}${tag}`));
} else {
  createServer(safeHandle).listen(PORT, "127.0.0.1", () => console.log(`ticketd listening on http://127.0.0.1:${PORT} (+ [::1])${tag}`));
  createServer(safeHandle)
    .listen(PORT, "::1")
    .on("error", () => {
      /* no IPv6 loopback on this machine — IPv4 is enough */
    });
}
