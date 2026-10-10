"use client";

// Wishlist (P7 B) — private to the account, stored by ticketd (session,
// zero gas). The primary price is fixed on-chain, so the interesting price
// is the cheapest second-hand copy: the launcher alerts when one drops
// below the price last shown; here we just show it.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatEther } from "viem";
import { useAccount } from "wagmi";
import { hueOf, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { useTicketd } from "../lib/ticketd";
import type { Occasion } from "../lib/occasions";

type Wish = { editionId: string; seenWei: string; at: number };

const Heart = ({ on }: { on: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" />
  </svg>
);

/** Cheapest live listing of an edition, when it beats the new price. */
export function bestDeal(e: OnchainEdition, occasions: Occasion[]): Occasion | undefined {
  return occasions
    .filter((o) => o.editionId === e.editionId && o.price < e.priceWei)
    .sort((a, b) => (a.price < b.price ? -1 : 1))[0];
}

const offPct = (e: OnchainEdition, price: bigint): number => Math.round(Number(((e.priceWei - price) * BigInt(100)) / (e.priceWei || BigInt(1))));

function useWishlist() {
  const { address } = useAccount();
  const { authed, hasSession } = useTicketd();
  const [wishes, setWishes] = useState<Wish[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setWishes(await authed<Wish[]>("/wishlist"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [authed]);

  // never ask for a signature on page load: only when a session exists
  useEffect(() => {
    if (address && hasSession) void load();
    else setWishes(null);
  }, [address, hasSession, load]);

  const toggle = useCallback(
    async (e: OnchainEdition, on: boolean, priceWei: bigint) => {
      setError("");
      try {
        setWishes(await authed<Wish[]>("/wishlist", { body: { editionId: e.editionId, on, priceWei: priceWei.toString() } }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [authed],
  );
  return { wishes, load, toggle, error, connected: Boolean(address) };
}

/** Heart button for a store page. */
export function WishButton({ edition, deal }: { edition: OnchainEdition; deal?: Occasion }) {
  const { wishes, toggle, error, connected } = useWishlist();
  const [busy, setBusy] = useState(false);
  const on = Boolean(wishes?.some((w) => w.editionId === edition.editionId));
  if (!connected) return null;
  return (
    <>
      <button
        className={`btn ghost wish-btn ${on ? "on" : ""}`}
        aria-pressed={on}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await toggle(edition, !on, deal ? deal.price : edition.priceWei);
          setBusy(false);
        }}
        title={on ? "Retirer de ma liste de souhaits" : "Ajouter à ma liste de souhaits (privée)"}
      >
        <Heart on={on} /> {busy ? "…" : on ? "Dans mes souhaits" : "Souhaiter"}
      </button>
      {error && <p className="error-box">{error}</p>}
    </>
  );
}

/** "Ma liste de souhaits" card for /profile. */
export function WishlistCard({ catalog, occasions }: { catalog: OnchainEdition[]; occasions: Occasion[] }) {
  const { wishes, load, toggle, error } = useWishlist();
  const rows = (wishes ?? []).flatMap((w) => {
    const e = catalog.find((x) => x.editionId === w.editionId);
    return e ? [{ w, e, deal: bestDeal(e, occasions) }] : [];
  });
  return (
    <>
      <div className="pe-title-row">
        <h2>Liste de souhaits</h2>
        <span className="pe-eyebrow">PRIVÉE{wishes ? ` · ${wishes.length}` : ""}</span>
      </div>
      <p className="pe-help">
        Visible par vous seul. Le launcher vous prévient quand une occasion passe sous le dernier prix que vous avez vu.
      </p>
      {wishes === null ? (
        <button className="btn ghost" style={{ marginTop: "1rem" }} onClick={() => void load()}>
          Afficher ma liste (1 signature, sans gas)
        </button>
      ) : rows.length ? (
        <div className="pe-list">
          {rows.map(({ e, deal }) => {
            const hue = hueOf(e.editionId);
            return (
              <div className="pe-device wish-row" key={e.editionId}>
                <span
                  className="wish-art"
                  style={{ background: `linear-gradient(160deg, oklch(0.62 0.13 ${hue}), oklch(0.3 0.09 ${hue + 30}))` }}
                  aria-hidden="true"
                />
                <div className="pe-device-body">
                  <Link href={`/game/${e.editionId}`} className="wish-title">
                    {e.title}
                  </Link>
                  <span className="pe-help">
                    Neuf {formatEther(e.priceWei)} ETH
                    {deal ? (
                      <>
                        {" · "}
                        <Link href={`/occasions?sel=${deal.tokenId}`} className="wish-deal">
                          occasion {formatEther(deal.price)} ETH · −{offPct(e, deal.price)} %
                        </Link>
                      </>
                    ) : (
                      " · pas d'occasion moins chère"
                    )}
                  </span>
                </div>
                <button className="pe-danger" onClick={() => void toggle(e, false, e.priceWei)}>
                  Retirer
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="pe-help pe-empty">Aucun jeu pour l&apos;instant : ajoutez-en depuis leur page (bouton « Souhaiter »).</p>
      )}
      {error && <p className="error-box">{error}</p>}
    </>
  );
}
