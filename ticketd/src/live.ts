// Live, short-lived state of ticketd (2026-10-11): presence, pairing
// tickets waiting for their launcher, the real-time event fan-out, and the
// chat rate limit.
//
//   • In memory by default (one process: local dev, the POC, the selftest).
//   • In Redis when REDIS_URL is set — then any number of ticketd replicas
//     share it: a launcher polling replica B gets the ticket replica A
//     issued, a chat message sent through A reaches the SSE stream held by B
//     (pub/sub), presence is the same everywhere.
//
// Nothing here must survive a Redis restart: presence re-appears with the
// next heartbeat (60 s), a lost pending ticket means pairing again. Redis
// can run without persistence.

import { Redis } from "ioredis";

export interface PresenceRecord {
  playing: string | null;
}

/** Delivers an event to the SSE streams THIS process holds for a wallet. */
export type Deliver = (wallet: string, event: string, data: unknown) => void;

export interface Live {
  readonly kind: "memory" | "redis";
  /** Heartbeat. Returns the previous record (undefined = was offline). */
  presenceSet(wallet: string, rec: PresenceRecord, ttlMs: number): Promise<PresenceRecord | undefined>;
  presenceGet(wallets: string[]): Promise<Map<string, PresenceRecord>>;
  pendingPut(nonce: string, value: string, ttlMs: number): Promise<void>;
  /** Read-and-delete: a pending ticket is handed out once. */
  pendingTake(nonce: string): Promise<string | undefined>;
  /** Event for a wallet, delivered by whichever replica holds its streams. */
  publish(wallet: string, event: string, data: unknown): Promise<void>;
  /** Fixed-window counter; false once `max` hits are reached in the window. */
  rateHit(key: string, max: number, windowMs: number): Promise<boolean>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

// ── Memory ──────────────────────────────────────────────────────────────

function memoryLive(deliver: Deliver): Live {
  const presence = new Map<string, { rec: PresenceRecord; until: number }>();
  const pending = new Map<string, { value: string; until: number }>();
  const hits = new Map<string, { n: number; until: number }>();
  const alive = <T extends { until: number }>(m: Map<string, T>, k: string): T | undefined => {
    const v = m.get(k);
    if (v && v.until < Date.now()) {
      m.delete(k);
      return undefined;
    }
    return v;
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const m of [presence, pending, hits] as Map<string, { until: number }>[]) for (const [k, v] of m) if (v.until < now) m.delete(k);
  }, 60_000);
  sweep.unref();
  return {
    kind: "memory",
    async presenceSet(wallet, rec, ttlMs) {
      const prev = alive(presence, wallet)?.rec;
      presence.set(wallet, { rec, until: Date.now() + ttlMs });
      return prev;
    },
    async presenceGet(wallets) {
      const out = new Map<string, PresenceRecord>();
      for (const w of wallets) {
        const v = alive(presence, w);
        if (v) out.set(w, v.rec);
      }
      return out;
    },
    async pendingPut(nonce, value, ttlMs) {
      pending.set(nonce, { value, until: Date.now() + ttlMs });
    },
    async pendingTake(nonce) {
      const v = alive(pending, nonce);
      pending.delete(nonce);
      return v?.value;
    },
    async publish(wallet, event, data) {
      deliver(wallet, event, data);
    },
    async rateHit(key, max, windowMs) {
      const v = alive(hits, key) ?? { n: 0, until: Date.now() + windowMs };
      v.n++;
      hits.set(key, v);
      return v.n <= max;
    },
    async ping() {},
    async close() {
      clearInterval(sweep);
    },
  };
}

// ── Redis ───────────────────────────────────────────────────────────────

const CHANNEL = "gv:events";

async function redisLive(url: string, deliver: Deliver): Promise<Live> {
  const opts = { maxRetriesPerRequest: 2, enableReadyCheck: true, connectionName: `ticketd${process.env.HOSTNAME ? `@${process.env.HOSTNAME}` : ""}` };
  const cmd = new Redis(url, opts);
  const sub = new Redis(url, opts); // a subscribed connection cannot run commands
  for (const [name, c] of [["commandes", cmd], ["abonnement", sub]] as const) {
    c.on("error", (e) => console.error(`⛔ redis (${name}) : ${e.message}`));
  }
  await sub.subscribe(CHANNEL);
  sub.on("message", (_ch, raw) => {
    try {
      const m = JSON.parse(raw) as { wallet: string; event: string; data: unknown };
      deliver(m.wallet, m.event, m.data);
    } catch {
      /* malformed event: ignored */
    }
  });
  const key = { presence: (w: string) => `gv:presence:${w}`, pending: (n: string) => `gv:pending:${n}`, rate: (k: string) => `gv:rate:${k}` };
  return {
    kind: "redis",
    async presenceSet(wallet, rec, ttlMs) {
      // SET … GET: the previous value in the same round trip (Redis ≥ 6.2)
      const prev = await cmd.set(key.presence(wallet), JSON.stringify(rec), "PX", ttlMs, "GET");
      return prev ? (JSON.parse(prev) as PresenceRecord) : undefined;
    },
    async presenceGet(wallets) {
      const out = new Map<string, PresenceRecord>();
      if (!wallets.length) return out;
      const vals = await cmd.mget(wallets.map(key.presence));
      vals.forEach((v, i) => v && out.set(wallets[i], JSON.parse(v) as PresenceRecord));
      return out;
    },
    async pendingPut(nonce, value, ttlMs) {
      await cmd.set(key.pending(nonce), value, "PX", ttlMs);
    },
    async pendingTake(nonce) {
      return (await cmd.getdel(key.pending(nonce))) ?? undefined;
    },
    async publish(wallet, event, data) {
      await cmd.publish(CHANNEL, JSON.stringify({ wallet, event, data }));
    },
    async rateHit(k, max, windowMs) {
      const bucket = `${key.rate(k)}:${Math.floor(Date.now() / windowMs)}`;
      const n = await cmd.incr(bucket);
      if (n === 1) await cmd.pexpire(bucket, windowMs);
      return n <= max;
    },
    async ping() {
      if ((await cmd.ping()) !== "PONG") throw new Error("redis ne répond pas");
    },
    async close() {
      await Promise.allSettled([sub.quit(), cmd.quit()]);
    },
  };
}

// ── Selection ───────────────────────────────────────────────────────────

let current: Live | null = null;

export async function openLive(deliver: Deliver): Promise<Live> {
  if (current) return current;
  const selftestInMemory = process.env.GAMEVAULT_SKIP_OWNER_CHECK === "1" && process.env.GAMEVAULT_TEST_BACKENDS !== "1";
  const url = selftestInMemory ? "" : process.env.REDIS_URL;
  current = url ? await redisLive(url, deliver) : memoryLive(deliver);
  return current;
}

export function live(): Live {
  if (!current) throw new Error("état temps réel non initialisé (openLive)");
  return current;
}

export async function closeLive(): Promise<void> {
  await current?.close();
  current = null;
}
