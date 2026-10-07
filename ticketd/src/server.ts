// Thin HTTP wrapper around service.ts. Zero framework — one endpoint.
//   POST /ticket  { message, signature } -> SignedTicket
//   GET  /health

import { createServer } from "node:http";
import {
  applyFriendAction,
  attestFriendship,
  backdateFriendship,
  friendsOf,
  getBuild,
  issueTicket,
  takePendingTicket,
  publishBuild,
} from "./service.ts";

const MAX_UPLOAD = 100 * 1024 * 1024; // 100 MB

const PORT = Number(process.env.PORT ?? 8787);

const CORS = {
  "Access-Control-Allow-Origin": "*", // hackathon: web/ runs on :3000
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify(body));
  };

  if (req.method === "OPTIONS") return send(204, {});
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });

  // Launcher polls here after showing the pairing QR
  const pendingMatch = req.method === "GET" && req.url?.match(/^\/pending\/([\w-]+)$/);
  if (pendingMatch) {
    const ticket = takePendingTicket(pendingMatch[1]);
    return ticket ? send(200, ticket) : send(404, { error: "no ticket yet" });
  }

  // ── Friends DB: wallet-signed actions, zero gas ──────────────
  const friendsMatch = req.method === "GET" && req.url?.match(/^\/friends\/(0x[0-9a-fA-F]{40})$/);
  if (friendsMatch) {
    try {
      return send(200, friendsOf(friendsMatch[1]));
    } catch (e) {
      return send(400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (req.method === "POST" && req.url?.startsWith("/friends/")) {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      if (req.url === "/friends/action") {
        return send(200, await applyFriendAction(body.message, body.signature));
      }
      if (req.url === "/friends/attest") {
        return send(200, await attestFriendship(body.owner, body.borrower));
      }
      if (req.url === "/friends/backdate") {
        // DEV helper — ticketd n'écoute qu'en local ; simule les 3 jours
        return send(200, backdateFriendship(body.a, body.b, Number(body.since)));
      }
      return send(404, { error: "not found" });
    } catch (e) {
      console.warn(`⛔ amis: ${e instanceof Error ? e.message : e}`);
      return send(403, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Build distribution: local cache first, IPFS gateways as backup.
  // The client still verifies sha256 against the on-chain hash.
  const buildMatch = req.method === "GET" && req.url?.match(/^\/build\/([A-Za-z0-9]{10,100})$/);
  if (buildMatch) {
    try {
      const bytes = await getBuild(buildMatch[1]);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length, ...CORS });
      return res.end(Buffer.from(bytes));
    } catch (e) {
      console.warn(`⛔ build ${buildMatch[1]} introuvable: ${e instanceof Error ? e.message : e}`);
      return send(404, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Studio publish: raw build bytes in -> encrypted + pinned, key stored
  if (req.method === "POST" && req.url?.startsWith("/publish")) {
    try {
      const name = new URL(req.url, "http://localhost").searchParams.get("name") ?? "build.enc";
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_UPLOAD) return send(413, { error: "build trop volumineux (100 Mo max)" });
        chunks.push(chunk as Buffer);
      }
      const stored = await publishBuild(new Uint8Array(Buffer.concat(chunks)), name);
      return send(200, stored);
    } catch (e) {
      console.warn(`⛔ publish refusé: ${e instanceof Error ? e.message : e}`);
      return send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (req.method === "POST" && req.url === "/ticket") {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { message, signature } = JSON.parse(raw);
      if (typeof message !== "string" || typeof signature !== "string") {
        return send(400, { error: "expected { message, signature }" });
      }
      const ticket = await issueTicket({ message, signature: signature as `0x${string}` });
      console.log(`✔ ticket issued: token ${ticket.tokenId} -> device ${ticket.devicePubKey.slice(0, 12)}…`);
      return send(200, ticket);
    } catch (e) {
      console.warn(`⛔ refused: ${e instanceof Error ? e.message : e}`);
      return send(403, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  send(404, { error: "not found" });
}).listen(PORT, () => {
  console.log(`ticketd listening on http://localhost:${PORT}`);
});
