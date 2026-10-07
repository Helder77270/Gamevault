"use client";

// Amis & Prêts — l'amitié vit dans la BDD plateforme (ticketd) : chaque
// action est un message SIGNÉ par le wallet, ZÉRO transaction, zéro gas.
// Seul le prêt touche la chaîne : ticketd délivre une attestation
// « amis depuis T » que lend() vérifie on-chain (règle des 3 jours
// comprise). endLoan reste une transaction du propriétaire/emprunteur.

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useSignMessage, useWriteContract } from "wagmi";
import { LICENSE_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";
import { fetchOnchainCatalog, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { ConnectButton } from "../components/ConnectButton";

const LICENSE = DEPLOYMENTS.gameLicense as `0x${string}`;
const TICKETD_URL = process.env.NEXT_PUBLIC_TICKETD_URL ?? "http://localhost:8787";
const ZERO = "0x0000000000000000000000000000000000000000";
const DAY = 86400;
const FRIEND_AGE = 3 * DAY;

type Friend = { addr: string; since: number; name: string | null };
type Contact = { addr: string; name: string | null };
type Owned = { tokenId: string; editionId: string; user: string; expires: number; lastEnd: number };

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** « Picsou (0x1234…abcd) » — le pseudo n'est pas unique, l'adresse tranche. */
const label = (c: { addr: string; name: string | null }): string => (c.name ? `${c.name} (${short(c.addr)})` : short(c.addr));

export default function FriendsPage() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();

  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<Contact[]>([]);
  const [outgoing, setOutgoing] = useState<Contact[]>([]);
  const [results, setResults] = useState<Contact[]>([]);
  const [searched, setSearched] = useState(false);
  const [owned, setOwned] = useState<Owned[]>([]);
  const [borrowed, setBorrowed] = useState<Owned[]>([]);
  const [catalog, setCatalog] = useState<OnchainEdition[]>([]);
  const [target, setTarget] = useState("");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [nowSec, setNowSec] = useState(Math.floor(Date.now() / 1000));

  const refresh = useCallback(async () => {
    if (!address) return;
    setNowSec(Math.floor(Date.now() / 1000));
    const problems: string[] = [];

    // Amis : BDD ticketd (aucun appel chaîne)
    try {
      const res = await fetch(`${TICKETD_URL}/friends/${address}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { friends: Friend[]; incoming: Contact[]; outgoing: Contact[] };
      setFriends(data.friends);
      setIncoming(data.incoming);
      setOutgoing(data.outgoing);
    } catch (e) {
      problems.push(`amis (ticketd): ${e instanceof Error ? e.message : e}`);
    }

    // Licences + état des prêts : la chaîne, indépendamment
    try {
      if (!client || !LICENSE) throw new Error("client/contrat indisponible");
      const next = await client.readContract({ address: LICENSE, abi: LICENSE_ABI, functionName: "nextTokenId" });
      const mine: Owned[] = [];
      const lent2me: Owned[] = [];
      for (let i = BigInt(1); i <= next; i++) {
        try {
          const [owner, ed, user, exp, lastEnd] = await Promise.all([
            client.readContract({ address: LICENSE, abi: LICENSE_ABI, functionName: "ownerOf", args: [i] }),
            client.readContract({ address: LICENSE, abi: LICENSE_ABI, functionName: "editionOf", args: [i] }),
            client.readContract({ address: LICENSE, abi: LICENSE_ABI, functionName: "userOf", args: [i] }),
            client.readContract({ address: LICENSE, abi: LICENSE_ABI, functionName: "userExpires", args: [i] }),
            client.readContract({ address: LICENSE, abi: LICENSE_ABI, functionName: "lastLoanEnd", args: [i] }),
          ]);
          const row: Owned = { tokenId: i.toString(), editionId: ed.toString(), user, expires: Number(exp), lastEnd: Number(lastEnd) };
          if (owner.toLowerCase() === address.toLowerCase()) mine.push(row);
          else if (user.toLowerCase() === address.toLowerCase()) lent2me.push(row);
        } catch {
          /* burned */
        }
      }
      setOwned(mine);
      setBorrowed(lent2me);
    } catch (e) {
      problems.push(`licences: ${e instanceof Error ? e.message : e}`);
    }
    setError(problems.join(" · "));
  }, [client, address]);

  useEffect(() => {
    fetchOnchainCatalog().then(setCatalog).catch(() => {});
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doSearch = async () => {
    setError("");
    try {
      const res = await fetch(`${TICKETD_URL}/profile/search?q=${encodeURIComponent(target.trim())}`);
      if (!res.ok) throw new Error(await res.text());
      setResults((await res.json()) as Contact[]);
      setSearched(true);
    } catch (e) {
      setError(`recherche: ${e instanceof Error ? e.message : e}`);
    }
  };

  /** Action amis = message signé envoyé à ticketd. Gratuit, instantané. */
  const friendAction = async (action: "request" | "accept" | "decline" | "remove", other: string) => {
    if (!address) return;
    setError("");
    setBusy(`${action}-${other}`);
    try {
      const message = [
        "GameVault Amis",
        `action: ${action}`,
        `me: ${address}`,
        `other: ${other}`,
        `at: ${new Date().toISOString()}`,
        `nonce: ${crypto.randomUUID()}`,
      ].join("\n");
      const signature = await signMessageAsync({ message });
      const res = await fetch(`${TICKETD_URL}/friends/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      await refresh();
      if (action === "request") {
        setTarget("");
        setResults([]);
        setSearched(false);
      }
    } catch (e) {
      setError(String(e instanceof Error ? ((e as Error & { shortMessage?: string }).shortMessage ?? e.message) : e));
    }
    setBusy("");
  };

  /** Prêt : attestation gratuite de ticketd, puis UNE transaction lend(). */
  const lendTo = async (tokenId: string, to: string) => {
    if (!address) return;
    setError("");
    setBusy(`lend-${tokenId}`);
    try {
      const res = await fetch(`${TICKETD_URL}/friends/attest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: address, borrower: to }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      const att = (await res.json()) as { since: number; deadline: number; sig: `0x${string}` };
      const expires = BigInt(Math.floor(Date.now() / 1000) + Number(days) * DAY);
      await writeContractAsync({
        address: LICENSE,
        abi: LICENSE_ABI,
        functionName: "lend",
        args: [BigInt(tokenId), to as `0x${string}`, expires, BigInt(att.since), BigInt(att.deadline), att.sig],
      });
      await new Promise((r) => setTimeout(r, 4000));
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? ((e as Error & { shortMessage?: string }).shortMessage ?? e.message) : e));
    }
    setBusy("");
  };

  const endLoan = async (tokenId: string) => {
    setError("");
    setBusy(`end-${tokenId}`);
    try {
      await writeContractAsync({ address: LICENSE, abi: LICENSE_ABI, functionName: "endLoan", args: [BigInt(tokenId)] });
      await new Promise((r) => setTimeout(r, 4000));
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? ((e as Error & { shortMessage?: string }).shortMessage ?? e.message) : e));
    }
    setBusy("");
  };

  const titleOf = (editionId: string): string => catalog.find((e) => e.editionId === editionId)?.title ?? `Édition #${editionId}`;

  if (!LICENSE) return <p className="notice">Contrats non déployés.</p>;

  return (
    <div className="pane" style={{ maxWidth: "52rem" }}>
      <h1>Amis &amp; Prêts</h1>
      <p>
        L&apos;amitié est <b>gratuite</b> : une simple signature, aucune transaction. Prêter un jeu, c&apos;est
        tendre la cartouche — <em>vous perdez l&apos;accès pendant le prêt</em>. Les garde-fous restent on-chain :
        amis depuis <b>3 jours</b> (attesté par la plateforme), <b>14 jours</b> max, <b>24 h</b> de repos entre
        deux prêts.
      </p>
      {!isConnected && <ConnectButton />}

      {isConnected && address && (
        <>
          <h2 className="section">1 · Trouver un ami — pseudo ou adresse, signature, 0 gas</h2>
          <p>
            <input
              placeholder="Picsou… ou 0x1234…"
              style={{ width: "22rem" }}
              value={target}
              onChange={(e) => { setTarget(e.target.value.trim()); setSearched(false); setResults([]); }}
              onKeyDown={(e) => e.key === "Enter" && void doSearch()}
            />
            <button className="btn ghost" disabled={target.trim().length < 2} onClick={() => void doSearch()}>
              Rechercher
            </button>
          </p>
          {/^0x[0-9a-fA-F]{40}$/.test(target) && (
            <p>
              Adresse complète détectée —{" "}
              <button className="btn" disabled={!!busy} onClick={() => void friendAction("request", target)}>
                {busy === `request-${target}` ? "Signature…" : `Demander ${short(target)}`}
              </button>
            </p>
          )}
          {results.map((r) => (
            <p key={r.addr} style={{ margin: "0.3rem 0" }}>
              <b>{r.name}</b> <span className="addr">({short(r.addr)})</span>{" "}
              <button
                className="btn"
                disabled={!!busy || r.addr.toLowerCase() === address.toLowerCase() || friends.some((f) => f.addr.toLowerCase() === r.addr.toLowerCase())}
                onClick={() => void friendAction("request", r.addr)}
              >
                {busy === `request-${r.addr}` ? "Signature…" : "Demander"}
              </button>
            </p>
          ))}
          {searched && results.length === 0 && !/^0x[0-9a-fA-F]{40}$/.test(target) && (
            <p className="addr">Aucun profil trouvé — demandez-lui son adresse, ou qu&apos;il crée son profil.</p>
          )}
          {outgoing.length > 0 && (
            <p className="addr">En attente de leur acceptation : {outgoing.map(label).join(" · ")}</p>
          )}

          {incoming.length > 0 && (
            <>
              <h2 className="section">2 · Demandes reçues</h2>
              {incoming.map((c) => (
                <p key={c.addr}>
                  <b>{label(c)}</b>{" "}
                  <button className="btn" disabled={!!busy} onClick={() => void friendAction("accept", c.addr)}>
                    {busy === `accept-${c.addr}` ? "Signature…" : "Accepter"}
                  </button>{" "}
                  <button className="btn ghost" disabled={!!busy} onClick={() => void friendAction("decline", c.addr)}>
                    Refuser
                  </button>
                </p>
              ))}
            </>
          )}

          <h2 className="section">Mes amis ({friends.length})</h2>
          {friends.length === 0 && <p className="addr">Aucun ami pour l&apos;instant.</p>}
          {friends.map((f) => {
            const matured = nowSec >= f.since + FRIEND_AGE;
            const left = Math.max(1, Math.ceil((f.since + FRIEND_AGE - nowSec) / DAY));
            return (
              <p key={f.addr}>
                <b>{label(f)}</b>{" "}
                <span className="addr">{matured ? "· prêt possible ✔" : `· prêt possible dans ${left} j`}</span>{" "}
                <button className="btn ghost" disabled={!!busy} onClick={() => void friendAction("remove", f.addr)}>
                  Retirer
                </button>
              </p>
            );
          })}

          <h2 className="section">Mes licences — prêter / récupérer</h2>
          {owned.length === 0 && <p className="addr">Aucune licence possédée.</p>}
          {owned.map((t) => {
            const loanLive = t.user.toLowerCase() !== ZERO && t.expires >= nowSec;
            const effEnd = Math.max(t.lastEnd, t.expires < nowSec ? t.expires : 0);
            const cooldownUntil = effEnd > 0 ? effEnd + DAY : 0;
            const cooling = !loanLive && cooldownUntil > nowSec;
            const maturedFriends = friends.filter((f) => nowSec >= f.since + FRIEND_AGE);
            return (
              <div key={t.tokenId} style={{ marginBottom: "0.9rem" }}>
                <b>{titleOf(t.editionId)}</b> <span className="addr">licence #{t.tokenId}</span>
                {loanLive ? (
                  <p style={{ margin: "0.3rem 0 0" }}>
                    Prêtée à <code>{short(t.user)}</code> — retour le {new Date(t.expires * 1000).toLocaleDateString()}{" "}
                    <button className="btn ghost" disabled={!!busy} onClick={() => void endLoan(t.tokenId)}>
                      {busy === `end-${t.tokenId}` ? "Transaction…" : "Récupérer maintenant"}
                    </button>
                  </p>
                ) : cooling ? (
                  <p className="addr" style={{ margin: "0.3rem 0 0" }}>
                    Repos après prêt — reprêtable le {new Date(cooldownUntil * 1000).toLocaleString()}.
                  </p>
                ) : maturedFriends.length === 0 ? (
                  <p className="addr" style={{ margin: "0.3rem 0 0" }}>Aucun ami éligible (3 jours d&apos;amitié requis).</p>
                ) : (
                  <p style={{ margin: "0.3rem 0 0" }}>
                    Prêter à{" "}
                    <select id={`lend-to-${t.tokenId}`} defaultValue={maturedFriends[0].addr}>
                      {maturedFriends.map((f) => (
                        <option key={f.addr} value={f.addr}>
                          {label(f)}
                        </option>
                      ))}
                    </select>{" "}
                    pour <input style={{ width: "3.2rem" }} value={days} onChange={(e) => setDays(e.target.value)} /> jours{" "}
                    <button
                      className="btn"
                      disabled={!!busy || !/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 14}
                      onClick={() => {
                        const to = (document.getElementById(`lend-to-${t.tokenId}`) as HTMLSelectElement).value;
                        void lendTo(t.tokenId, to);
                      }}
                    >
                      {busy === `lend-${t.tokenId}` ? "Transaction…" : "Prêter ✈"}
                    </button>
                  </p>
                )}
              </div>
            );
          })}

          {borrowed.length > 0 && (
            <>
              <h2 className="section">Empruntés — à vous de jouer</h2>
              {borrowed.map((t) => (
                <p key={t.tokenId}>
                  <b>{titleOf(t.editionId)}</b>{" "}
                  <span className="addr">#{t.tokenId} · jusqu&apos;au {new Date(t.expires * 1000).toLocaleDateString()}</span>{" "}
                  <button className="btn ghost" disabled={!!busy} onClick={() => void endLoan(t.tokenId)}>
                    Rendre plus tôt
                  </button>
                  <br />
                  <span className="addr">Appairez votre machine depuis le launcher — ticketd vous sert le ticket tant que le prêt court.</span>
                </p>
              ))}
            </>
          )}

          {error && <p className="error-box">{error}</p>}
        </>
      )}
    </div>
  );
}
