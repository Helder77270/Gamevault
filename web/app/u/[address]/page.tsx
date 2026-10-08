"use client";

// Public profile (Steam-like) — anyone can open it, no wallet needed.
// Off-chain (ticketd): pseudo, bio, avatar, favorites, presence, play time,
// friends, activity. On-chain (subgraph): licences owned, borrowed, lent,
// on sale. Actions for a connected visitor: add friend, message.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import { formatEther } from "viem";
import { fetchOnchainCatalog, hueOf, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { Avatar, shortAddr } from "../../components/Avatar";
import { ticketdGet, useTicketd } from "../../lib/ticketd";
import { subgraph } from "../../lib/subgraph";

type Person = { addr: string; name: string | null; hasAvatar: boolean };
type Profile = {
  addr: string;
  name: string | null;
  hasAvatar: boolean;
  bio: string;
  favorites: string[];
  memberSince: number | null;
  presence: { state: "offline" | "online" | "playing"; editionId: string | null };
  topPlayed: { editionId: string; seconds: number }[];
  totalSeconds: number;
  devicesCount: number;
  friendsCount: number;
  friends: Person[];
  activity: { kind: string; data: Record<string, unknown>; at: number }[];
};
type Chain = {
  owned: { id: string; listed: boolean; listPrice: string | null; borrower: string | null; loanExpires: string | null; edition: { id: string } | null }[];
  borrowed: { id: string; loanExpires: string | null; edition: { id: string } | null }[];
  lent: { id: string }[];
};

const CHAIN_QUERY = `query Profile($a: Bytes!) {
  owned: licenses(where: { owner: $a }, first: 100) { id listed listPrice borrower loanExpires edition { id } }
  borrowed: licenses(where: { borrower: $a }, first: 100) { id loanExpires edition { id } }
  lent: loans(where: { owner: $a, ended: false }, first: 1000) { id }
}`;

const fmtDur = (s: number): string =>
  s < 60 ? "< 1 min" : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`;

const ago = (ms: number): string => {
  const d = Date.now() - ms;
  if (d < 3600_000) return `il y a ${Math.max(1, Math.round(d / 60_000))} min`;
  if (d < 86400_000) return `il y a ${Math.round(d / 3600_000)} h`;
  return `il y a ${Math.round(d / 86400_000)} j`;
};

const art = (editionId: string): React.CSSProperties => ({
  background: `linear-gradient(140deg, oklch(0.58 0.12 ${hueOf(editionId)}), oklch(0.3 0.08 ${hueOf(editionId) + 40}))`,
});

export default function PublicProfilePage() {
  const params = useParams<{ address: string }>();
  const addr = (params.address ?? "").toLowerCase();
  const valid = /^0x[0-9a-f]{40}$/.test(addr);
  const { address: me } = useAccount();
  const { authed } = useTicketd();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [chain, setChain] = useState<Chain | null>(null);
  const [catalog, setCatalog] = useState<OnchainEdition[]>([]);
  const [relation, setRelation] = useState<"self" | "friend" | "pending" | "incoming" | "none">("none");
  // Studio accounts only receive invitations they send themselves
  const [studios, setStudios] = useState<{ id: string; name: string }[]>([]);
  const [viewerIsStudio, setViewerIsStudio] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nowSec = Math.floor(Date.now() / 1000);

  const load = useCallback(async () => {
    if (!valid) return;
    setError("");
    try {
      setProfile(await ticketdGet<Profile>(`/profile/${addr}`));
    } catch (e) {
      setError(`profil : ${e instanceof Error ? e.message : e}`);
    }
    subgraph<Chain>(CHAIN_QUERY, { a: addr }).then(setChain, () => setChain({ owned: [], borrowed: [], lent: [] }));
    ticketdGet<{ id: string; name: string }[]>(`/studios/of/${addr}`).then(setStudios, () => setStudios([]));
    if (me) ticketdGet<{ id: string }[]>(`/studios/of/${me}`).then((l) => setViewerIsStudio(l.length > 0), () => setViewerIsStudio(false));
    if (me) {
      if (me.toLowerCase() === addr) {
        setRelation("self");
      } else {
        const f = await ticketdGet<{ friends: Person[]; incoming: Person[]; outgoing: Person[] }>(`/friends/${me}`).catch(() => null);
        const has = (l?: Person[]) => Boolean(l?.some((p) => p.addr === addr));
        setRelation(has(f?.friends) ? "friend" : has(f?.outgoing) ? "pending" : has(f?.incoming) ? "incoming" : "none");
      }
    }
  }, [addr, valid, me]);

  useEffect(() => {
    void load();
    fetchOnchainCatalog().then(setCatalog).catch(() => {});
  }, [load]);

  const titleOf = useCallback((id: string) => catalog.find((e) => e.editionId === id)?.title ?? `Édition #${id}`, [catalog]);
  const playedOf = useCallback((id: string) => profile?.topPlayed.find((t) => t.editionId === id)?.seconds ?? 0, [profile]);

  const onSale = useMemo(() => (chain?.owned ?? []).filter((l) => l.listed && l.listPrice), [chain]);
  const library = useMemo(() => {
    const rows = [
      ...(chain?.owned ?? []).map((l) => ({ id: l.id, editionId: l.edition?.id ?? "", note: l.borrower ? "PRÊTÉE" : "" })),
      ...(chain?.borrowed ?? [])
        .filter((l) => Number(l.loanExpires ?? 0) >= nowSec)
        .map((l) => ({ id: l.id, editionId: l.edition?.id ?? "", note: `EMPRUNTÉE · J-${Math.max(0, Math.ceil((Number(l.loanExpires) - nowSec) / 86400))}` })),
    ];
    return rows.filter((r) => r.editionId);
  }, [chain, nowSec]);

  const act = async (action: "request" | "accept") => {
    setBusy(true);
    setError("");
    try {
      await authed("/friends/action", { body: { action, other: addr } });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  if (!valid) return <p className="notice">Adresse invalide.</p>;

  const name = profile?.name ?? shortAddr(addr);
  const presence = profile?.presence;
  const showcase = (profile?.favorites ?? []).slice(0, 3);

  return (
    <div className="pf">
      <div className="pf-banner" />
      <div className="pf-head">
        <Avatar addr={addr} name={profile?.name} hasAvatar={profile?.hasAvatar} size={128} ring />
        <div className="pf-id">
          <div className="pf-name">
            {name}
            {presence?.state === "playing" && <span className="pill playing">● En jeu · {titleOf(presence.editionId ?? "")}</span>}
            {presence?.state === "online" && <span className="pill online">● En ligne</span>}
            {studios.length > 0 && <span className="pill studio">Studio</span>}
          </div>
          <div className="pf-meta">
            {shortAddr(addr)}
            {profile?.memberSince ? ` · membre depuis ${new Date(profile.memberSince).toLocaleDateString("fr-FR", { month: "short", year: "numeric" })}` : ""}
            {profile ? ` · ${profile.devicesCount} appareil${profile.devicesCount > 1 ? "s" : ""}` : ""}
          </div>
          {studios.length > 0 && (
            <div className="pf-meta">
              {studios.map((st, i) => (
                <span key={st.id}>
                  {i > 0 && " · "}
                  <Link href={`/studio/${st.id}`} style={{ color: "var(--cyan)" }}>
                    {st.name} ↗
                  </Link>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="pf-actions">
          {relation === "self" ? (
            <Link className="btn" href="/profile">Modifier mon profil</Link>
          ) : (
            <>
              {relation === "friend" && <Link className="btn" href={`/chat?with=${addr}`}>Message</Link>}
              {relation === "friend" && <span className="btn ghost">Amis ✓</span>}
              {relation === "pending" && <span className="btn ghost">Demande envoyée</span>}
              {relation === "incoming" && (
                <button className="btn" disabled={busy} onClick={() => void act("accept")}>Accepter la demande</button>
              )}
              {relation === "none" && me && (studios.length === 0 || viewerIsStudio) && (
                <button className="btn" disabled={busy} onClick={() => void act("request")}>Ajouter en ami</button>
              )}
              {relation === "none" && me && studios.length > 0 && !viewerIsStudio && (
                <span className="btn ghost" title="Les studios ne reçoivent pas de demandes d'amis">C&apos;est le studio qui invite</span>
              )}
              <button className="btn ghost soon" disabled title="Bientôt : rejoindre une partie en ligne">Inviter à jouer · bientôt</button>
            </>
          )}
        </div>
      </div>

      {error && <p className="error-box">{error}</p>}

      <div className="pf-body">
        <div className="pf-main">
          <div className="pf-box">
            <div className="pf-label">À propos</div>
            <p className="pf-bio">{profile?.bio || (relation === "self" ? "Ajoutez une bio depuis « Modifier mon profil »." : "Pas encore de bio.")}</p>
          </div>

          <div>
            <div className="pf-label">Vitrine · favoris <span>personnalisation · bientôt</span></div>
            <div className="pf-cards">
              {showcase.map((id) => (
                <Link key={id} className="pf-card" href={`/game/${id}`}>
                  <div className="art" style={art(id)} />
                  <div className="txt">
                    <div className="t">{titleOf(id)}</div>
                    <div className="s">{playedOf(id) ? fmtDur(playedOf(id)) : "favori"}</div>
                  </div>
                </Link>
              ))}
              {Array.from({ length: Math.max(0, 3 - showcase.length) }, (_, i) => (
                <div key={`slot-${i}`} className="pf-slot">EMPLACEMENT LIBRE</div>
              ))}
            </div>
          </div>

          <div className="pf-box">
            <div className="pf-label">Bibliothèque · {library.length}</div>
            {library.length === 0 ? (
              <p className="addr">{chain ? "Aucune licence pour l'instant." : "Lecture du subgraph…"}</p>
            ) : (
              library.map((l) => (
                <Link key={l.id} className="pf-row" href={`/provenance/${l.id}`} title="Historique de la licence">
                  <div className="art" style={art(l.editionId)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="t">{titleOf(l.editionId)} <span className="addr">· licence #{l.id}</span></div>
                    <div className="addr">{playedOf(l.editionId) ? fmtDur(playedOf(l.editionId)) : "pas encore joué"}</div>
                  </div>
                  {l.note && <span className="pill">{l.note}</span>}
                </Link>
              ))
            )}
          </div>

          <div className="pf-box">
            <div className="pf-label">Activité récente</div>
            <div className="pf-feed">
              {(profile?.activity ?? []).length === 0 && <span className="addr">Rien pour l&apos;instant.</span>}
              {(profile?.activity ?? []).map((a, i) => (
                <div key={i}>
                  <span>
                    {a.kind === "played" && (
                      <>A joué à <b>{titleOf(String(a.data.editionId))}</b> · {fmtDur(Number(a.data.seconds))}</>
                    )}
                    {a.kind === "friend" && (
                      <>
                        Est devenu ami avec{" "}
                        <Link href={`/u/${String(a.data.with)}`}>
                          <b>{(a.data.withName as string | null) ?? shortAddr(String(a.data.with))}</b>
                        </Link>
                      </>
                    )}
                  </span>
                  <small>{ago(a.at)}</small>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="pf-side">
          <div className="pf-stats">
            <div className="pf-stat"><small>Licences</small><b>{chain?.owned.length ?? "…"}</b></div>
            <div className="pf-stat"><small>Temps de jeu</small><b>{profile ? fmtDur(profile.totalSeconds) : "…"}</b></div>
            <div className="pf-stat"><small>Prêts en cours</small><b>{chain?.lent.length ?? "…"}</b></div>
            <div className="pf-stat"><small>Amis</small><b>{profile?.friendsCount ?? "…"}</b></div>
          </div>

          <div className="pf-box">
            <div className="pf-label">Badges &amp; succès <span>bientôt</span></div>
            <div className="pf-badges">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="pf-badge" aria-label="Badge verrouillé">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <rect x="5" y="11" width="14" height="9" rx="2" />
                    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                  </svg>
                </span>
              ))}
            </div>
            <p className="addr" style={{ margin: "0.7rem 0 0" }}>Bronze, argent, or : les succès des jeux apparaîtront ici, prouvés par la licence.</p>
          </div>

          {onSale.length > 0 && (
            <div className="pf-box violet">
              <div className="pf-label violet">En vente par {name}</div>
              {onSale.map((l) => (
                <Link key={l.id} className="pf-row" href={`/trade?action=buy&token=${l.id}`}>
                  <div className="art" style={art(l.edition?.id ?? "0")} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="t">{titleOf(l.edition?.id ?? "")} · #{l.id}</div>
                    <div className="s">{formatEther(BigInt(l.listPrice ?? "0"))} ETH</div>
                  </div>
                </Link>
              ))}
            </div>
          )}

          <div className="pf-box">
            <div className="pf-label">Amis · {profile?.friendsCount ?? 0}</div>
            <div className="pf-friends">
              {(profile?.friends ?? []).map((f) => (
                <Link key={f.addr} href={`/u/${f.addr}`} title={f.name ?? f.addr}>
                  <Avatar addr={f.addr} name={f.name} hasAvatar={f.hasAvatar} size={40} />
                </Link>
              ))}
              {profile && profile.friends.length === 0 && <span className="addr">Aucun ami pour l&apos;instant.</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
