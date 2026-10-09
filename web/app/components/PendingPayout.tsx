"use client";

// Marketplace shares that could not be pushed during a sale (audit K4):
// the receiver refused ETH or ran out of the gas stipend, so the amount was
// credited instead. Inline variant: renders nothing for the usual case
// (wallets are paid directly). Card variant (profile form): always shows
// the section, with a zero balance when there is nothing to claim.

import { useState } from "react";
import { formatEther } from "viem";
import { useReadContract, useWriteContract } from "wagmi";
import { MARKETPLACE_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";

const MARKET = DEPLOYMENTS.marketplace as `0x${string}`;

export function PendingPayout({ address, variant = "inline" }: { address: `0x${string}`; variant?: "inline" | "card" }) {
  const { data: pending, refetch } = useReadContract({
    address: MARKET,
    abi: MARKETPLACE_ABI,
    functionName: "pendingWithdrawals",
    args: [address],
    query: { enabled: !!MARKET },
  });
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const amount = pending ?? BigInt(0);
  const empty = amount === BigInt(0);
  if (empty && variant === "inline") return null;

  const withdraw = async () => {
    setBusy(true);
    setError("");
    try {
      await writeContractAsync({ address: MARKET, abi: MARKETPLACE_ABI, functionName: "withdraw" });
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (variant === "card") {
    return (
      <div className="pe-payout">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>Gains en attente</h2>
          <p className="pe-help">
            Quand un paiement de revente ne peut pas vous être versé directement (contrat qui refuse l&apos;ETH ou trop
            gourmand en gaz), il vous attend ici.
          </p>
          {error && <p className="error-box">{error}</p>}
        </div>
        <div className="pe-payout-amount">
          <div className="pe-amount">
            {empty ? "0" : formatEther(amount)} <span>ETH</span>
          </div>
          <button className="btn" disabled={empty || busy} onClick={() => void withdraw()}>
            {busy ? "Transaction…" : "Retirer"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <h2 className="section">Gains en attente</h2>
      <p className="addr">
        Une vente vous a rapporté {formatEther(amount)} ETH que votre adresse n&apos;a pas pu recevoir directement
        (contrat qui refuse l&apos;ETH ou trop gourmand en gaz). Le montant vous attend dans le Marketplace.
      </p>
      <button className="btn" disabled={busy} onClick={() => void withdraw()}>
        {busy ? "Transaction…" : `Retirer ${formatEther(amount)} ETH`}
      </button>
      {error && <p className="error-box">{error}</p>}
    </>
  );
}
