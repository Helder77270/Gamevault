// Thin HTTP wrapper around service.ts. Zero framework. Routes (details in
// ticketd/README.md): /health, /ticket + /pending/:nonce (pairing),
// /publish + /build/:cid (studio builds), /profile*, /devices*, /friends*.
// Binds to 127.0.0.1 by default (HOST overrides), CORS restricted to the
// known front-ends, every request body size-capped.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  addPlaystat,
  applyFriendAction,
  attestFriendship,
  backdateFriendship,
  devicesOf,
  deviceStatus,
  friendsOf,
  getAvatar,
  getBuild,
  getProfile,
  issueTicket,
  revokeDevice,
  searchProfiles,
  setProfile,
  takePendingTicket,
  publishBuild,
} from "./service.ts";

const MAX_UPLOAD = 100 * 1024 * 1024; // 100 MB (studio builds)
const MAX_JSON = 16 * 1024; // signed messages
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
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-GameVault-Message, X-GameVault-Signature",
          Vary: "Origin",
        }
      : {};
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", ...cors });
    res.end(JSON.stringify(body));
  };
  const fail = (status: number, scope: string, e: unknown) => {
    console.warn(`⛔ ${scope}: ${e instanceof Error ? e.message : e}`);
    return send(e instanceof BodyTooLarge ? 413 : status, { error: publicError(e) });
  };

  // Route on the PATH only: a query string (e.g. the avatar's ?t= cache
  // buster) must not make a route miss. Plain string split — `new URL()`
  // throws on targets Node accepts (e.g. "//"), which would kill the process.
  const raw = req.url ?? "/";
  const qi = raw.indexOf("?");
  const path = qi < 0 ? raw : raw.slice(0, qi);
  const query = new URLSearchParams(qi < 0 ? "" : raw.slice(qi + 1));

  if (req.method === "OPTIONS") return send(204, {});
  if (req.method === "GET" && path === "/health") return send(200, { ok: true });

  // Launcher polls here after showing the pairing QR
  const pendingMatch = req.method === "GET" && path.match(/^\/pending\/([\w-]+)$/);
  if (pendingMatch) {
    const ticket = takePendingTicket(pendingMatch[1]);
    return ticket ? send(200, ticket) : send(404, { error: "no ticket yet" });
  }

  // ── Profils : pseudo + avatar + favoris, signés ; recherche ──
  const avatarMatch = req.method === "GET" && path.match(/^\/profile\/avatar\/(0x[0-9a-fA-F]{40})$/);
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
  if (req.method === "GET" && path === "/profile/search") {
    const q = query.get("q") ?? "";
    return send(200, searchProfiles(q));
  }
  const profileMatch = req.method === "GET" && path.match(/^\/profile\/(0x[0-9a-fA-F]{40})$/);
  if (profileMatch) {
    try {
      return send(200, getProfile(profileMatch[1]));
    } catch (e) {
      return fail(400, "profil", e);
    }
  }
  if (req.method === "POST" && path.startsWith("/profile")) {
    try {
      const body = await readJson(req, MAX_PROFILE);
      if (path === "/profile") {
        return send(200, await setProfile(String(body.message ?? ""), String(body.signature ?? "") as `0x${string}`, body.avatarB64 as string | undefined));
      }
      if (path === "/profile/playstat") return send(200, addPlaystat(String(body.addr), String(body.editionId), Number(body.seconds)));
      return send(404, { error: "not found" });
    } catch (e) {
      return fail(403, "profil", e);
    }
  }

  // ── Device registry: 2 active machines per account ───────────
  const devStatus = req.method === "GET" && path.match(/^\/devices\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]{66})\/status$/);
  if (devStatus) {
    try {
      return send(200, deviceStatus(devStatus[1], devStatus[2]));
    } catch (e) {
      return fail(400, "appareils", e);
    }
  }
  const devList = req.method === "GET" && path.match(/^\/devices\/(0x[0-9a-fA-F]{40})$/);
  if (devList) {
    try {
      return send(200, devicesOf(devList[1]));
    } catch (e) {
      return fail(400, "appareils", e);
    }
  }
  if (req.method === "POST" && path === "/devices/revoke") {
    try {
      const body = await readJson(req);
      return send(200, await revokeDevice(String(body.message ?? ""), String(body.signature ?? "") as `0x${string}`));
    } catch (e) {
      return fail(403, "appareils", e);
    }
  }

  // ── Friends DB: wallet-signed actions, zero gas ──────────────
  const friendsMatch = req.method === "GET" && path.match(/^\/friends\/(0x[0-9a-fA-F]{40})$/);
  if (friendsMatch) {
    try {
      return send(200, friendsOf(friendsMatch[1]));
    } catch (e) {
      return fail(400, "amis", e);
    }
  }
  if (req.method === "POST" && path.startsWith("/friends/")) {
    try {
      const body = await readJson(req);
      if (path === "/friends/action") {
        return send(200, await applyFriendAction(String(body.message ?? ""), String(body.signature ?? "") as `0x${string}`));
      }
      if (path === "/friends/attest") {
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

  // Build distribution: local cache first, IPFS gateways as backup.
  // The client still verifies sha256 against the on-chain hash.
  const buildMatch = req.method === "GET" && path.match(/^\/build\/([A-Za-z0-9]{10,100})$/);
  if (buildMatch) {
    try {
      const bytes = await getBuild(buildMatch[1]);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, ...cors });
      res.end(Buffer.from(bytes));
      return;
    } catch (e) {
      return fail(404, `build ${buildMatch[1]}`, e);
    }
  }

  // Studio publish: raw build bytes in, studio-signed request in headers
  // (message base64 — headers cannot carry newlines) -> encrypted + pinned.
  if (req.method === "POST" && path === "/publish") {
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

  if (req.method === "POST" && path === "/ticket") {
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
