// Thin HTTP wrapper around service.ts. Zero framework — one endpoint.
//   POST /ticket  { message, signature } -> SignedTicket
//   GET  /health

import { createServer } from "node:http";
import { issueTicket, takePendingTicket } from "./service.ts";

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
