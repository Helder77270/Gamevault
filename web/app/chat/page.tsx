"use client";

// Chat between friends — stored by ticketd (not end-to-end encrypted),
// friends only, live through Server-Sent Events. The session (one
// signature, 24 h) is opened explicitly, never as a surprise popup.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";
import { fetchOnchainCatalog, hueOf, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { CHAT_EMOJIS } from "@gamevault/shared/emoji";
import { ConnectButton } from "../components/ConnectButton";
import { Avatar, shortAddr } from "../components/Avatar";
import { TICKETD_URL, ticketdGet, useTicketd } from "../lib/ticketd";

type Presence = { state: "offline" | "online" | "playing"; editionId: string | null };
type Friend = { addr: string; name: string | null; hasAvatar: boolean; since: number; presence: Presence };
type Msg = { id: number; from: string; to: string; kind: string; body: string; at: number; readAt: number | null };
type Summary = { other: string; last: Msg; unread: number };

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dayOf = (ms: number) => new Date(ms).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

function ChatInner() {
  const params = useSearchParams();
  const { address, isConnected } = useAccount();
  const me = address?.toLowerCase() ?? "";
  const { authed, ensureSession, hasSession } = useTicketd();

  const [token, setToken] = useState<string | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [summary, setSummary] = useState<Record<string, Summary>>({});
  const [active, setActive] = useState<string | null>(params.get("with")?.toLowerCase() ?? null);
  const [thread, setThread] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Emoji at the caret (or over the selection), then back to typing. */
  const addEmoji = (emoji: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    setText((cur) => (cur.slice(0, start) + emoji + cur.slice(end)).slice(0, 1000));
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };
  const [catalog, setCatalog] = useState<OnchainEdition[]>([]);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    fetchOnchainCatalog().then(setCatalog).catch(() => {});
  }, []);
  const titleOf = useCallback((id: string) => catalog.find((e) => e.editionId === id)?.title ?? `Édition #${id}`, [catalog]);

  const open = useCallback(async () => {
    setError("");
    setOpening(true);
    try {
      setToken(await ensureSession());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setOpening(false);
  }, [ensureSession]);

  // A cached session opens silently; otherwise the visitor clicks once.
  useEffect(() => {
    if (address && hasSession && !token) void open();
  }, [address, hasSession, token, open]);

  const loadLists = useCallback(async () => {
    if (!me) return;
    const f = await ticketdGet<{ friends: Friend[] }>(`/friends/${me}`, me).catch(() => ({ friends: [] as Friend[] }));
    setFriends(f.friends);
    const s = await authed<Summary[]>("/chat").catch(() => []);
    setSummary(Object.fromEntries(s.map((x) => [x.other, x])));
  }, [me, authed]);

  useEffect(() => {
    if (token) void loadLists();
  }, [token, loadLists]);

  const markRead = useCallback(
    (other: string, upTo: number) => {
      void authed(`/chat/${other}/read`, { body: { upTo } }).catch(() => {});
      setSummary((s) => (s[other] ? { ...s, [other]: { ...s[other], unread: 0 } } : s));
    },
    [authed],
  );

  // Open a conversation
  useEffect(() => {
    if (!token || !active) return;
    authed<Msg[]>(`/chat/${active}`)
      .then((list) => {
        setThread(list);
        if (list.length) markRead(active, list[list.length - 1].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [token, active, authed, markRead]);

  // Live stream: messages, presence
  useEffect(() => {
    if (!token) return;
    const es = new EventSource(`${TICKETD_URL}/events?token=${encodeURIComponent(token)}`);
    es.addEventListener("message", (ev) => {
      const m = JSON.parse((ev as MessageEvent).data) as Msg;
      const other = m.from === me ? m.to : m.from;
      if (other === activeRef.current) {
        setThread((t) => (t.some((x) => x.id === m.id) ? t : [...t, m]));
        if (m.from !== me) markRead(other, m.id);
      }
      setSummary((s) => ({
        ...s,
        [other]: { other, last: m, unread: other === activeRef.current || m.from === me ? 0 : (s[other]?.unread ?? 0) + 1 },
      }));
    });
    es.addEventListener("presence", (ev) => {
      const p = JSON.parse((ev as MessageEvent).data) as Presence & { addr: string };
      setFriends((list) => list.map((f) => (f.addr === p.addr ? { ...f, presence: { state: p.state, editionId: p.editionId } } : f)));
    });
    es.addEventListener("friends", () => void loadLists());
    return () => es.close();
  }, [token, me, markRead, loadLists]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [thread]);

  const send = async () => {
    if (!active || !text.trim()) return;
    const body = text.trim();
    setText("");
    try {
      const m = await authed<Msg>(`/chat/${active}`, { body: { text: body } });
      setThread((t) => (t.some((x) => x.id === m.id) ? t : [...t, m]));
    } catch (e) {
      setText(body);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const ordered = useMemo(() => {
    const rank = (f: Friend) => (f.presence.state === "playing" ? 0 : f.presence.state === "online" ? 1 : 2);
    return [...friends].sort((a, b) => rank(a) - rank(b) || (summary[b.addr]?.last.at ?? 0) - (summary[a.addr]?.last.at ?? 0));
  }, [friends, summary]);
  const current = friends.find((f) => f.addr === active) ?? null;
  const label = (f: { addr: string; name: string | null }) => f.name ?? shortAddr(f.addr);
  const presenceText = (p: Presence) =>
    p.state === "playing" ? `En jeu · ${titleOf(p.editionId ?? "")}` : p.state === "online" ? "En ligne" : "Hors ligne";

  if (!isConnected) {
    return (
      <div className="pane">
        <h1>Messages</h1>
        <p>Discutez avec vos amis, sur le site comme dans le launcher.</p>
        <ConnectButton />
      </div>
    );
  }
  if (!token) {
    return (
      <div className="pane">
        <h1>Messages</h1>
        <p>Une signature ouvre le chat pour 24 h, sans transaction.</p>
        <button className="btn" disabled={opening} onClick={() => void open()}>{opening ? "Signature…" : "Ouvrir le chat"}</button>
        {error && <p className="error-box">{error}</p>}
      </div>
    );
  }

  return (
    <div className="chat">
      <aside className="chat-list">
        <div className="pf-label">Amis · {friends.length} <Link href="/friends" style={{ color: "var(--cyan)" }}>+ ajouter</Link></div>
        {ordered.length === 0 && <p className="addr">Ajoutez des amis depuis « Amis &amp; Prêts » pour discuter.</p>}
        {ordered.map((f) => (
          <button key={f.addr} className={`chat-friend${f.addr === active ? " on" : ""}`} onClick={() => setActive(f.addr)}>
            <span className={`chat-dot ${f.presence.state}`}>
              <Avatar addr={f.addr} name={f.name} hasAvatar={f.hasAvatar} size={36} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="chat-name">{label(f)}</span>
              <span className={`chat-sub ${f.presence.state}`}>{presenceText(f.presence)}</span>
            </span>
            {(summary[f.addr]?.unread ?? 0) > 0 && <span className="chat-unread">{summary[f.addr].unread}</span>}
          </button>
        ))}
      </aside>

      <section className="chat-panel">
        {!current ? (
          <div className="chat-empty">Choisissez un ami pour discuter.</div>
        ) : (
          <>
            <header className="chat-head">
              <Avatar addr={current.addr} name={current.name} hasAvatar={current.hasAvatar} size={42} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: "1.05rem" }}>{label(current)}</div>
                <div className={`chat-sub ${current.presence.state}`}>
                  {presenceText(current.presence)} · amis depuis le {new Date(current.since * 1000).toLocaleDateString("fr-FR")}
                </div>
              </div>
              <Link className="btn ghost" href={`/u/${current.addr}`}>Profil</Link>
              <Link className="btn ghost" href="/friends">Prêter</Link>
              <button className="btn ghost soon" disabled title="Bientôt : rejoindre une partie en ligne">Inviter à jouer · bientôt</button>
            </header>

            <div className="chat-thread">
              {thread.map((m, i) => {
                const newDay = i === 0 || dayOf(thread[i - 1].at) !== dayOf(m.at);
                const mine = m.from === me;
                let loan: { tokenId: string; editionId: string; expires: number } | null = null;
                if (m.kind === "loan") {
                  try {
                    loan = JSON.parse(m.body);
                  } catch {
                    loan = null;
                  }
                }
                return (
                  <div key={m.id} style={{ display: "contents" }}>
                    {newDay && <div className="chat-day">{dayOf(m.at)}</div>}
                    {loan ? (
                      <div className="chat-loan">
                        <span className="chat-loan-art" style={{ background: `linear-gradient(140deg, oklch(0.6 0.12 ${hueOf(loan.editionId)}), oklch(0.3 0.08 ${hueOf(loan.editionId) + 40}))` }} />
                        <span>
                          <b>{titleOf(loan.editionId)} · licence #{loan.tokenId}</b> prêtée à {mine ? label(current) : "vous"}
                          <span className="chat-loan-sub">À DANS {Math.max(0, Math.ceil((loan.expires - Date.now() / 1000) / 86400))} J · ÉVÉNEMENT ON-CHAIN</span>
                        </span>
                      </div>
                    ) : (
                      <div className={`chat-bubble${mine ? " mine" : ""}`} title={hhmm(m.at)}>
                        {m.body}
                        <span className="chat-time">{hhmm(m.at)}{mine && m.readAt ? " · lu" : ""}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={bottom} />
            </div>

            <form
              className="chat-compose"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <label htmlFor="chat-input" className="sr-only">Message à {label(current)}</label>
              {emojiOpen && (
                <div className="chat-emoji-pop" role="dialog" aria-label="Emojis">
                  {CHAT_EMOJIS.map((e) => (
                    <button key={e} type="button" className="chat-emoji" aria-label={e} onClick={() => addEmoji(e)}>
                      {e}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                className={`chat-emoji-btn ${emojiOpen ? "on" : ""}`}
                aria-label="Emojis"
                aria-expanded={emojiOpen}
                title="Emojis"
                onClick={() => setEmojiOpen((o) => !o)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M8.5 14.5c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2" />
                  <path d="M9 9.5h.01M15 9.5h.01" />
                </svg>
              </button>
              <input
                id="chat-input"
                ref={inputRef}
                value={text}
                maxLength={1000}
                placeholder={`Écrire à ${label(current)}…`}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setEmojiOpen(false)}
                autoComplete="off"
              />
              <button className="btn" type="submit" disabled={!text.trim()}>Envoyer</button>
            </form>
          </>
        )}
        {error && <p className="error-box" style={{ margin: "0.6rem 1rem" }}>{error}</p>}
      </section>
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense>
      <ChatInner />
    </Suspense>
  );
}
