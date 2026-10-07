"use client";

// Amis & Prêts — the social surface of the cartridge rule. Everything here
// is a WALLET action (the launcher shows the read-only mirror):
//   - request/accept/remove friendships (FriendRegistry)
//   - lend an owned licence to a matured friend (>= 3 days), 1-14 days
//   - end a loan early (owner reclaims / borrower returns)
// Guards live ON-CHAIN; this page just surfaces them honestly.

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { FRIEND_ABI, LICENSE_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";
import { fetchOnchainCatalog, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { ConnectButton } from "../components/ConnectButton";

const FRIENDS = DEPLOYMENTS.friendRegistry as `0x${string}`;
const LICENSE = DEPLOYMENTS.gameLicense as `0x${string}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const DAY = 86400;
const FRIEND_AGE = 3 * DAY;

type Friend = { addr: string; since: number };
type Owned = { tokenId: string; editionId: string; user: string; expires: number; lastEnd: number };
type Incoming = { from: string };

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function FriendsPage() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [friends, setFriends] = useState<Friend[]>([]);
  const [incoming, setIncoming] = useState<Incoming[]>([]);
  const [owned, setOwned] = useState<Owned[]>([]);
  const [borrowed, setBorrowed] = useState<Owned[]>([]);
  const [catalog, setCatalog] = useState<OnchainEdition[]>([]);
  const [target, setTarget] = useState("");
  const [days, setDays] = useState("7");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [nowSec, setNowSec] = useState(Math.floor(Date.now() / 1000));

  const refresh = useCallback(async () => {
    if (!client || !address || !FRIENDS || !LICENSE) return;
    setNowSec(Math.floor(Date.now() / 1000));
    const problems: string[] = [];

    // Friends + incoming inbox (on-chain enumeration — no log scanning,
    // public RPCs cap eth_getLogs)
    try {
      const [list, pend] = await Promise.all([
        client.readContract({ address: FRIENDS, abi: FRIEND_ABI, functionName: "friendsOf", args: [address] }),
        client.readContract({ address: FRIENDS, abi: FRIEND_ABI, functionName: "pendingFor", args: [address] }),
      ]);
      const fs = await Promise.all(
        list.map(async (f) => ({
          addr: f,
          since: Number(await client.readContract({ address: FRIENDS, abi: FRIEND_ABI, functionName: "friendsSince", args: [address, f] })),
        })),
      );
      setFriends(fs);
      setIncoming(pend.map((from) => ({ from })));
    } catch (e) {
      problems.push(`amis: ${e instanceof Error ? e.message : e}`);
    }

    // Owned + borrowed licences with their loan state — independent of the
    // friends read: one failing never blanks the other.
    try {
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

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setError("");
    setBusy(label);
    try {
      await fn();
      await new Promise((r) => setTimeout(r, 4000)); // RPC propagation
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : e));
    }
    setBusy("");
  };

  const titleOf = (editionId: string): string => catalog.find((e) => e.editionId === editionId)?.title ?? `Édition #${editionId}`;

  if (!FRIENDS || !LICENSE) return <p className="notice">Contrats non déployés.</p>;

  return (
    <div className="pane" style={{ maxWidth: "52rem" }}>
      <h1>Amis &amp; Prêts</h1>
      <p>
        Prêter un jeu, c&apos;est tendre la cartouche : <em>vous perdez l&apos;accès pendant le prêt</em>. Les
        garde-fous sont on-chain — amis mutuels depuis <b>3 jours</b>, <b>14 jours</b> de prêt max, <b>24 h</b> de
        repos entre deux prêts, 16 amis max.
      </p>
      {!isConnected && <ConnectButton />}

      {isConnected && address && (
        <>
          <h2 className="section">1 · Demander un ami</h2>
          <p>
            <input placeholder="0x… adresse du futur ami" style={{ width: "26rem" }} value={target} onChange={(e) => setTarget(e.target.value.trim())} />
            <button
              className="btn"
              disabled={!/^0x[0-9a-fA-F]{40}$/.test(target) || !!busy}
              onClick={() => void act("request", () => writeContractAsync({ address: FRIENDS, abi: FRIEND_ABI, functionName: "request", args: [target as `0x${string}`] }))}
            >
              {busy === "request" ? "Signature…" : "Envoyer la demande"}
            </button>
          </p>

          {incoming.length > 0 && (
            <>
              <h2 className="section">2 · Demandes reçues</h2>
              {incoming.map((r) => (
                <p key={r.from}>
                  <code>{short(r.from)}</code>{" "}
                  <button className="btn" disabled={!!busy} onClick={() => void act(`accept-${r.from}`, () => writeContractAsync({ address: FRIENDS, abi: FRIEND_ABI, functionName: "accept", args: [r.from as `0x${string}`] }))}>
                    {busy === `accept-${r.from}` ? "Signature…" : "Accepter"}
                  </button>
                </p>
              ))}
            </>
          )}

          <h2 className="section">Mes amis ({friends.length}/16)</h2>
          {friends.length === 0 && <p className="addr">Aucun ami on-chain pour l&apos;instant.</p>}
          {friends.map((f) => {
            const matured = nowSec >= f.since + FRIEND_AGE;
            const left = Math.max(1, Math.ceil((f.since + FRIEND_AGE - nowSec) / DAY));
            return (
              <p key={f.addr}>
                <code>{short(f.addr)}</code>{" "}
                <span className="addr">{matured ? "· prêt possible ✔" : `· prêt possible dans ${left} j`}</span>{" "}
                <button className="btn ghost" disabled={!!busy} onClick={() => void act(`rm-${f.addr}`, () => writeContractAsync({ address: FRIENDS, abi: FRIEND_ABI, functionName: "remove", args: [f.addr as `0x${string}`] }))}>
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
                    <button className="btn ghost" disabled={!!busy} onClick={() => void act(`end-${t.tokenId}`, () => writeContractAsync({ address: LICENSE, abi: LICENSE_ABI, functionName: "endLoan", args: [BigInt(t.tokenId)] }))}>
                      {busy === `end-${t.tokenId}` ? "Signature…" : "Récupérer maintenant"}
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
                          {short(f.addr)}
                        </option>
                      ))}
                    </select>{" "}
                    pour{" "}
                    <input style={{ width: "3.2rem" }} value={days} onChange={(e) => setDays(e.target.value)} /> jours{" "}
                    <button
                      className="btn"
                      disabled={!!busy || !/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 14}
                      onClick={() => {
                        const to = (document.getElementById(`lend-to-${t.tokenId}`) as HTMLSelectElement).value as `0x${string}`;
                        const expires = BigInt(nowSec + Number(days) * DAY);
                        void act(`lend-${t.tokenId}`, () => writeContractAsync({ address: LICENSE, abi: LICENSE_ABI, functionName: "lend", args: [BigInt(t.tokenId), to, expires] }));
                      }}
                    >
                      {busy === `lend-${t.tokenId}` ? "Signature…" : "Prêter ✈"}
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
                  <b>{titleOf(t.editionId)}</b> <span className="addr">#{t.tokenId} · jusqu&apos;au {new Date(t.expires * 1000).toLocaleDateString()}</span>{" "}
                  <button className="btn ghost" disabled={!!busy} onClick={() => void act(`ret-${t.tokenId}`, () => writeContractAsync({ address: LICENSE, abi: LICENSE_ABI, functionName: "endLoan", args: [BigInt(t.tokenId)] }))}>
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
