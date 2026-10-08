"use client";

// ticketd client for the web app. Social actions (friends, profile, chat,
// studio page) use a SESSION: one wallet signature opens it for 24 h, the
// token is kept in this browser per address. What moves value or keys
// (pairing, studio publish, device revoke) stays signed per action.

import { useCallback } from "react";
import { useAccount, useSignMessage } from "wagmi";

export const TICKETD_URL = process.env.NEXT_PUBLIC_TICKETD_URL ?? "http://localhost:8787";

type Stored = { token: string; expiresAt: number };
const key = (addr: string) => `gv-ticketd-session-${addr.toLowerCase()}`;

function load(addr: string): Stored | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(addr)) ?? "null") as Stored | null;
    return v && v.expiresAt > Date.now() + 60_000 ? v : null;
  } catch {
    return null;
  }
}

function store(addr: string, v: Stored | null): void {
  try {
    if (v) localStorage.setItem(key(addr), JSON.stringify(v));
    else localStorage.removeItem(key(addr));
  } catch {
    /* private window: the session lives for this page only */
  }
}

const errorOf = async (res: Response): Promise<string> => {
  try {
    return ((await res.json()) as { error?: string }).error ?? res.statusText;
  } catch {
    return res.statusText;
  }
};

/** Public GET helper (no session). */
export async function ticketdGet<T>(path: string): Promise<T> {
  const res = await fetch(`${TICKETD_URL}${path}`);
  if (!res.ok) throw new Error(await errorOf(res));
  return (await res.json()) as T;
}

export function useTicketd() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();

  /** Returns a valid session token, asking for ONE signature if needed. */
  const ensureSession = useCallback(async (): Promise<string> => {
    if (!address) throw new Error("wallet non connecté");
    const cached = load(address);
    if (cached) return cached.token;
    const message = ["GameVault Session", `me: ${address}`, `at: ${new Date().toISOString()}`, `nonce: ${crypto.randomUUID()}`].join("\n");
    const signature = await signMessageAsync({ message });
    const res = await fetch(`${TICKETD_URL}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, signature }),
    });
    if (!res.ok) throw new Error(await errorOf(res));
    const s = (await res.json()) as Stored;
    store(address, s);
    return s.token;
  }, [address, signMessageAsync]);

  /** Authenticated JSON call; an expired session is reopened once. */
  const authed = useCallback(
    async <T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      const call = async (token: string) =>
        fetch(`${TICKETD_URL}${path}`, {
          method: init.method ?? (init.body === undefined ? "GET" : "POST"),
          headers: { Authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        });
      let res = await call(await ensureSession());
      if (res.status === 401 && address) {
        store(address, null);
        res = await call(await ensureSession());
      }
      if (!res.ok) throw new Error(await errorOf(res));
      return (await res.json()) as T;
    },
    [address, ensureSession],
  );

  const hasSession = Boolean(address && load(address));
  return { ensureSession, authed, hasSession };
}
