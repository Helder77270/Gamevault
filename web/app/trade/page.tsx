"use client";

// Signature surface for launcher-driven marketplace actions. The launcher
// owns the UX (buttons, live state); this page only hosts the wallet
// moment: ?action=list|unlist|buy&token=N[&price=ETH]

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { parseEther, formatEther } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { LICENSE_ABI, MARKETPLACE_ABI } from "@gamevault/shared/abi";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";
import { ConnectButton } from "../components/ConnectButton";

const LICENSE = DEPLOYMENTS.gameLicense as `0x${string}`;
const MARKET = DEPLOYMENTS.marketplace as `0x${string}`;

type Status = "idle" | "working" | "done" | "error";

function TradeInner() {
  const params = useSearchParams();
  const action = params.get("action") ?? "";
  const token = params.get("token") ?? "";
  const priceEth = params.get("price") ?? "";

  const { isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [status, setStatus] = useState<Status>("idle");
  const [detail, setDetail] = useState("");

  const tokenId = BigInt(token || "0");

  const { data: approved } = useReadContract({
    address: LICENSE,
    abi: LICENSE_ABI,
    functionName: "getApproved",
    args: [tokenId],
    query: { enabled: action === "list" && token !== "" },
  });
  const { data: listing } = useReadContract({
    address: MARKET,
    abi: MARKETPLACE_ABI,
    functionName: "listings",
    args: [tokenId],
    query: { enabled: action === "buy" && token !== "" },
  });

  const valid =
    token !== "" &&
    ((action === "list" && priceEth !== "") || action === "unlist" || action === "buy");

  // A transaction only counts once mined: the next step (list after
  // approve) and the "confirmée" box both wait for the receipt.
  const confirm = async (hash: `0x${string}`, label: string) => {
    if (!publicClient) throw new Error("client RPC indisponible");
    setDetail(`${label} — envoyée, en attente de confirmation…`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${label} : transaction annulée on-chain`);
  };

  const run = async () => {
    setStatus("working");
    try {
      if (action === "list") {
        if (approved?.toLowerCase() !== MARKET.toLowerCase()) {
          setDetail("1/2 — autorisation du Marketplace…");
          const approveHash = await writeContractAsync({
            address: LICENSE,
            abi: LICENSE_ABI,
            functionName: "approve",
            args: [MARKET, tokenId],
          });
          await confirm(approveHash, "1/2 — autorisation");
        }
        setDetail("2/2 — mise en vente…");
        const listHash = await writeContractAsync({
          address: MARKET,
          abi: MARKETPLACE_ABI,
          functionName: "list",
          args: [tokenId, parseEther(priceEth)],
        });
        await confirm(listHash, "2/2 — mise en vente");
      } else if (action === "unlist") {
        const hash = await writeContractAsync({
          address: MARKET,
          abi: MARKETPLACE_ABI,
          functionName: "unlist",
          args: [tokenId],
        });
        await confirm(hash, "Retrait de la vente");
      } else if (action === "buy") {
        if (!listing || listing[0] === "0x0000000000000000000000000000000000000000") {
          throw new Error("cette licence n'est pas (ou plus) en vente");
        }
        const hash = await writeContractAsync({
          address: MARKET,
          abi: MARKETPLACE_ABI,
          functionName: "buy",
          args: [tokenId],
          value: listing[1],
        });
        await confirm(hash, "Achat");
      }
      setStatus("done");
    } catch (e) {
      setDetail(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  if (!valid) {
    return (
      <div className="pane">
        <h1>Transaction marketplace</h1>
        <p>
          Cette page est ouverte par le launcher avec les paramètres de l&apos;action (vendre, retirer,
          acheter). Ouvrez-la depuis les boutons de votre bibliothèque.
        </p>
      </div>
    );
  }

  const LABELS: Record<string, string> = {
    list: `Mettre la licence #${token} en vente — ${priceEth} ETH`,
    unlist: `Retirer la licence #${token} de la vente`,
    buy: `Acheter la licence #${token}${listing && listing[1] > BigInt(0) ? ` — ${formatEther(listing[1])} ETH` : ""}`,
  };

  return (
    <div className="pane">
      <h1>{LABELS[action]}</h1>
      {action === "list" && (
        <p>
          À la revente : 85 % pour vous, 10 % pour le studio (EIP-2981), 5 % pour la plateforme. Deux
          signatures la première fois (autorisation puis mise en vente).
        </p>
      )}
      {action === "buy" && (
        <p>
          Le transfert du NFT révoque instantanément le vendeur. Après l&apos;achat, appairez votre machine
          depuis le launcher pour jouer.
        </p>
      )}
      {(action === "buy" || action === "list") && /^\d{1,12}$/.test(token) && (
        <p>
          <Link href={`/provenance/${token}`}>Voir l&apos;historique de la licence #{token}</Link> : propriétaires
          successifs, reventes et royalties versées.
        </p>
      )}

      {!isConnected && <ConnectButton />}
      {isConnected && status !== "done" && (
        <>
          <button className="btn" disabled={status === "working"} onClick={() => void run()}>
            {status === "working" ? (detail || "Transaction…") : "Signer la transaction"}
          </button>
          {status === "error" && <p className="error-box">{detail}</p>}
        </>
      )}
      {status === "done" && (
        <p className="ok-box">
          ✔ Transaction confirmée — retournez au launcher, l&apos;état se met à jour dans les secondes qui
          suivent.
        </p>
      )}
    </div>
  );
}

export default function TradePage() {
  return (
    <Suspense>
      <TradeInner />
    </Suspense>
  );
}
