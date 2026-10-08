"use client";

// Public studio page — games (on-chain via the subgraph), description,
// links and team (ticketd, edited in place by the studio's on-chain owner
// through their session). Stats: licences in circulation, resales,
// royalties earned.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAccount } from "wagmi";
import { formatEther } from "viem";
import { hueOf } from "@gamevault/shared/registryCatalog";
import { Avatar, shortAddr } from "../../components/Avatar";
import { ticketdGet, useTicketd } from "../../lib/ticketd";
import { subgraph } from "../../lib/subgraph";

type Member = { name: string; role: string; wallet: string | null };
type Page = { description: string; links: { label: string; url: string }[]; team: Member[]; updatedAt: number };
type Studio = {
  id: string;
  owner: string;
  name: string;
  games: {
    id: string;
    title: string;
    editions: {
      id: string;
      price: string;
      supply: string;
      minted: string;
      royaltyBps: string;
      licenses: { id: string; listed: boolean; royaltyPayments: { royaltyAmount: string }[] }[];
    }[];
  }[];
};

const STUDIO_QUERY = `query Studio($id: ID!) {
  studio(id: $id) {
    id owner name
    games { id title editions { id price supply minted royaltyBps licenses(first: 1000) { id listed royaltyPayments { royaltyAmount } } } }
  }
}`;

const art = (editionId: string): React.CSSProperties => ({
  background: `linear-gradient(140deg, oklch(0.58 0.12 ${hueOf(editionId)}), oklch(0.3 0.08 ${hueOf(editionId) + 40}))`,
});

const EMPTY: Page = { description: "", links: [], team: [], updatedAt: 0 };

export default function StudioPublicPage() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const { address } = useAccount();
  const { authed } = useTicketd();

  const [studio, setStudio] = useState<Studio | null | undefined>(undefined);
  const [page, setPage] = useState<Page>(EMPTY);
  const [names, setNames] = useState<Record<string, { name: string | null; hasAvatar: boolean }>>({});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Page>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!/^\d{1,9}$/.test(id)) return;
    try {
      const data = await subgraph<{ studio: Studio | null }>(STUDIO_QUERY, { id });
      setStudio(data.studio);
    } catch (e) {
      setStudio(null);
      setError(`subgraph : ${e instanceof Error ? e.message : e}`);
    }
    try {
      const p = await ticketdGet<Page>(`/studio/${id}/page`);
      setPage(p);
      const wallets = p.team.flatMap((m) => (m.wallet ? [m.wallet] : []));
      if (wallets.length) setNames(await ticketdGet(`/profiles/names?a=${wallets.join(",")}`));
    } catch {
      /* no page yet */
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isOwner = Boolean(address && studio && address.toLowerCase() === studio.owner.toLowerCase());
  const editions = useMemo(() => (studio?.games ?? []).flatMap((g) => g.editions.map((e) => ({ ...e, title: g.title }))), [studio]);
  const licences = editions.reduce((n, e) => n + e.licenses.length, 0);
  const resales = editions.reduce((n, e) => n + e.licenses.reduce((m, l) => m + l.royaltyPayments.length, 0), 0);
  const royalties = editions.reduce(
    (sum, e) => sum + e.licenses.reduce((s, l) => s + l.royaltyPayments.reduce((r, p) => r + BigInt(p.royaltyAmount), BigInt(0)), BigInt(0)),
    BigInt(0),
  );
  const onSale = editions.reduce((n, e) => n + e.licenses.filter((l) => l.listed).length, 0);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const clean = {
        description: draft.description,
        links: draft.links.filter((l) => l.label.trim() || l.url.trim()),
        team: draft.team.filter((m) => m.name.trim()).map((m) => ({ ...m, wallet: m.wallet?.trim() || null })),
      };
      await authed(`/studio/${id}/page`, { body: clean });
      setEditing(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  if (!/^\d{1,9}$/.test(id)) return <p className="notice">Studio invalide.</p>;
  if (studio === null) return <p className="notice">Studio #{id} introuvable.</p>;

  const initials = (studio?.name ?? "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="pf">
      <div className="pf-banner studio" />
      <div className="pf-head">
        <span className="av" style={{ width: 112, height: 112, borderRadius: 24, fontSize: 34, color: "var(--ink)", border: "1px solid rgba(255,255,255,0.35)", background: "linear-gradient(160deg, rgba(226,240,255,0.22), rgba(226,240,255,0.06))", fontFamily: "var(--mono)" }}>
          {initials}
        </span>
        <div className="pf-id">
          <div className="pf-meta" style={{ marginTop: 0 }}>Studio #{id} · Base Sepolia · non vérifié</div>
          <div className="pf-name">{studio?.name ?? "…"}</div>
          <div className="pf-meta">
            Propriétaire : <Link href={`/u/${studio?.owner ?? ""}`}>{studio ? shortAddr(studio.owner) : "…"}</Link>
          </div>
        </div>
        <div className="pf-actions">
          {isOwner && !editing && (
            <button className="btn" onClick={() => { setDraft(page); setEditing(true); }}>Modifier la page</button>
          )}
          <button className="btn ghost soon" disabled title="Bientôt">Suivre · bientôt</button>
        </div>
      </div>

      {error && <p className="error-box">{error}</p>}

      {editing ? (
        <div className="pf-box" style={{ marginTop: "1.6rem" }}>
          <div className="pf-label">Modifier la page publique <span>propriétaire du studio · session ticketd</span></div>
          <label className="addr" htmlFor="st-desc">Description ({draft.description.length}/1500)</label>
          <textarea id="st-desc" rows={5} maxLength={1500} value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            style={{ width: "100%", font: "inherit", resize: "vertical", margin: "0.3rem 0 1rem" }} />

          <div className="addr">Liens (https://, 5 max)</div>
          {draft.links.map((l, i) => (
            <p key={i} style={{ margin: "0.3rem 0", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <input aria-label="Libellé" placeholder="Site, Discord…" value={l.label} style={{ width: "10rem" }}
                onChange={(e) => setDraft({ ...draft, links: draft.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <input aria-label="Adresse" placeholder="https://…" value={l.url} style={{ flex: 1, minWidth: "14rem" }}
                onChange={(e) => setDraft({ ...draft, links: draft.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
              <button className="btn ghost" onClick={() => setDraft({ ...draft, links: draft.links.filter((_, j) => j !== i) })}>Retirer</button>
            </p>
          ))}
          {draft.links.length < 5 && (
            <button className="btn ghost" onClick={() => setDraft({ ...draft, links: [...draft.links, { label: "", url: "" }] })}>+ Lien</button>
          )}

          <div className="addr" style={{ marginTop: "1rem" }}>Équipe (12 max) — wallet facultatif, il relie au profil</div>
          {draft.team.map((m, i) => (
            <p key={i} style={{ margin: "0.3rem 0", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <input aria-label="Nom" placeholder="Nom" value={m.name} style={{ width: "10rem" }}
                onChange={(e) => setDraft({ ...draft, team: draft.team.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <input aria-label="Rôle" placeholder="Rôle" value={m.role} style={{ width: "10rem" }}
                onChange={(e) => setDraft({ ...draft, team: draft.team.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)) })} />
              <input aria-label="Wallet" placeholder="0x… (facultatif)" value={m.wallet ?? ""} style={{ flex: 1, minWidth: "14rem" }}
                onChange={(e) => setDraft({ ...draft, team: draft.team.map((x, j) => (j === i ? { ...x, wallet: e.target.value } : x)) })} />
              <button className="btn ghost" onClick={() => setDraft({ ...draft, team: draft.team.filter((_, j) => j !== i) })}>Retirer</button>
            </p>
          ))}
          {draft.team.length < 12 && (
            <button className="btn ghost" onClick={() => setDraft({ ...draft, team: [...draft.team, { name: "", role: "", wallet: null }] })}>+ Membre</button>
          )}

          <p style={{ marginTop: "1.2rem", display: "flex", gap: "0.5rem" }}>
            <button className="btn" disabled={busy} onClick={() => void save()}>{busy ? "Enregistrement…" : "Publier la page"}</button>
            <button className="btn ghost" disabled={busy} onClick={() => setEditing(false)}>Annuler</button>
          </p>
        </div>
      ) : (
        <div className="pf-body">
          <div className="pf-main">
            <div className="pf-box">
              <div className="pf-label">Le studio</div>
              <p className="pf-bio">{page.description || (isOwner ? "Présentez votre studio avec « Modifier la page »." : "Pas encore de description.")}</p>
            </div>

            <div>
              <div className="pf-label">Jeux · {editions.length} <span>catalogue lu on-chain</span></div>
              <div className="pf-cards">
                {editions.map((e) => (
                  <Link key={e.id} className="pf-card" href={`/game/${e.id}`}>
                    <div className="art" style={art(e.id)} />
                    <div className="txt">
                      <div className="t">{e.title}</div>
                      <div className="s">{e.minted}/{e.supply} · {formatEther(BigInt(e.price))} ETH · royalties {Number(e.royaltyBps) / 100} %</div>
                    </div>
                  </Link>
                ))}
                {studio && editions.length === 0 && <div className="pf-slot">AUCUNE ÉDITION PUBLIÉE</div>}
              </div>
            </div>

            <div>
              <div className="pf-label">L&apos;équipe</div>
              <div className="pf-cards">
                {page.team.map((m, i) =>
                  m.wallet ? (
                    <Link key={i} href={`/u/${m.wallet}`} className="pf-box" style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
                      <Avatar addr={m.wallet} name={names[m.wallet]?.name ?? m.name} hasAvatar={names[m.wallet]?.hasAvatar} size={46} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{m.name}</div>
                        <div className="addr">{m.role || "membre"} · profil ↗</div>
                      </div>
                    </Link>
                  ) : (
                    <div key={i} className="pf-box" style={{ display: "flex", alignItems: "center", gap: "0.8rem" }}>
                      <span className="av" style={{ width: 46, height: 46, borderRadius: 14, background: "rgba(226,240,255,0.08)", color: "var(--sub)" }}>
                        {m.name[0]?.toUpperCase()}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{m.name}</div>
                        <div className="addr">{m.role || "membre"}</div>
                      </div>
                    </div>
                  ),
                )}
                {page.team.length === 0 && <div className="pf-slot">{isOwner ? "AJOUTEZ VOTRE ÉQUIPE" : "ÉQUIPE NON RENSEIGNÉE"}</div>}
              </div>
            </div>
          </div>

          <div className="pf-side">
            <div className="pf-stats">
              <div className="pf-stat"><small>Licences</small><b>{studio ? licences : "…"}</b></div>
              <div className="pf-stat"><small>Reventes</small><b>{studio ? resales : "…"}</b></div>
              <div className="pf-stat" style={{ gridColumn: "span 2" }}><small>Royalties touchées</small><b>{studio ? `${formatEther(royalties)} ETH` : "…"}</b></div>
            </div>

            {page.links.length > 0 && (
              <div className="pf-box">
                <div className="pf-label">Liens</div>
                {page.links.map((l, i) => (
                  <p key={i} style={{ margin: "0.3rem 0" }}>
                    <a href={l.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--cyan)" }}>{l.label} ↗</a>
                  </p>
                ))}
              </div>
            )}

            <div className="pf-box violet">
              <div className="pf-label violet">Occasions de ce studio</div>
              <p className="pf-bio" style={{ fontSize: "0.86rem" }}>
                {onSale} licence{onSale > 1 ? "s" : ""} en revente · le studio touche ses royalties à chaque vente.
              </p>
              <Link className="addr" href="/occasions" style={{ color: "var(--cyan)" }}>VOIR LES OCCASIONS →</Link>
            </div>

            <div className="pf-box" style={{ borderStyle: "dashed" }}>
              <div className="pf-label">Annonces <span>bientôt</span></div>
              <p className="addr" style={{ margin: 0 }}>Mises à jour, sorties, patchs signés par le studio.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
