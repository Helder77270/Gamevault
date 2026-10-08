"use client";

// Marketplace shares that could not be pushed during a sale (audit K4):
// the receiver refused ETH or ran out of the gas stipend, so the amount was
// credited instead. Renders nothing for the usual case (wallets are paid
// directly) — only appears when there is something to claim.

import { useState } from "react";
import { formatEther } from "viem";
import { useReadContract, useWriteContract } from "wagmi";
import { MARKETPLACE_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";

const MARKET = DEPLOYMENTS.marketplace as `0x${string}`;

export function PendingPayout({ address }: { address: `0x${string}` }) {
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

  if (!pending || pending === BigInt(0)) return null;

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

  return (
    <>
      <h2 className="section">Gains en attente</h2>
      <p className="addr">
        Une vente vous a rapporté {formatEther(pending)} ETH que votre adresse n&apos;a pas pu recevoir directement
        (contrat qui refuse l&apos;ETH ou trop gourmand en gaz). Le montant vous attend dans le Marketplace.
      </p>
      <button className="btn" disabled={busy} onClick={() => void withdraw()}>
        {busy ? "Transaction…" : `Retirer ${formatEther(pending)} ETH`}
      </button>
      {error && <p className="error-box">{error}</p>}
    </>
  );
}
