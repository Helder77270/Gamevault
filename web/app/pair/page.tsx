"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAccount, useChainId, useSignMessage } from "wagmi";
import { buildPairingMessage } from "@gamevault/shared/siwe";
import { ConnectButton } from "../components/ConnectButton";

const TICKETD_URL = process.env.NEXT_PUBLIC_TICKETD_URL ?? "http://localhost:8787";

type Status = "idle" | "signing" | "sent" | "ticketd-down" | "error";

function PairInner() {
  const params = useSearchParams();
  const devicePubKey = params.get("device") ?? "";
  const nonce = params.get("nonce") ?? "";
  const tokenId = params.get("token") ?? "";
  const contract = params.get("contract") ?? "";

  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();

  const [status, setStatus] = useState<Status>("idle");
  const [signature, setSignature] = useState("");
  const [detail, setDetail] = useState("");

  // Frozen at first render so the previewed message and the signed message
  // are byte-identical.
  const issuedAt = useMemo(() => new Date().toISOString(), []);

  const fromLauncher = Boolean(devicePubKey && nonce && tokenId && contract);

  const message = useMemo(
    () =>
      address && fromLauncher
        ? buildPairingMessage({ address, chainId, devicePubKey, nonce, tokenId, contract, issuedAt })
        : "",
    [address, chainId, devicePubKey, nonce, tokenId, contract, issuedAt, fromLauncher],
  );

  const sign = async () => {
    setStatus("signing");
    try {
      const sig = await signMessageAsync({ message });
      setSignature(sig);
      try {
        const res = await fetch(`${TICKETD_URL}/ticket`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, signature: sig }),
        });
        setDetail(await res.text());
        setStatus(res.ok ? "sent" : "error");
      } catch {
        // ticketd not up yet (P2) — the signature itself is still proof the flow works
        setStatus("ticketd-down");
      }
    } catch (e) {
      setDetail(String(e));
      setStatus("error");
    }
  };

  if (!fromLauncher) {
    return (
      <div className="pane">
        <h1>Appairage d&apos;un appareil</h1>
        <p>
          Cette page est la cible du QR code affiché par le launcher GameVault. Ouverte directement, il lui
          manque les paramètres de l&apos;appareil (<code>device</code>, <code>nonce</code>, <code>token</code>,{" "}
          <code>contract</code>).
        </p>
        <ol className="steps">
          <li>Insérez votre cartouche et ouvrez le launcher sur votre PC.</li>
          <li>Scannez le QR code affiché — il encode la clé publique de VOTRE machine.</li>
          <li>Vous arrivez ici : connectez votre wallet et signez l&apos;autorisation.</li>
          <li>Le launcher reçoit un ticket scellé pour cette machine. Ensuite, tout est hors ligne.</li>
        </ol>
      </div>
    );
  }

  return (
    <div className="pane">
      <h1>Autoriser cet appareil</h1>
      <p>
        Votre signature lie <strong>votre wallet</strong> (preuve de propriété de la licence) à{" "}
        <strong>une machine précise</strong> (la clé d&apos;appareil ci-dessous). La clé du jeu sera scellée
        pour cette machine uniquement.
      </p>
      <dl className="kv">
        <dt>Licence</dt>
        <dd>
          #{tokenId} · {contract}
        </dd>
        <dt>Appareil à autoriser</dt>
        <dd>{devicePubKey}</dd>
        <dt>Nonce</dt>
        <dd>{nonce}</dd>
      </dl>

      {!isConnected && (
        <>
          <p>Connectez le wallet propriétaire de la licence :</p>
          <ConnectButton />
        </>
      )}

      {isConnected && status !== "sent" && status !== "ticketd-down" && (
        <>
          <h2 className="section">Message à signer (SIWE)</h2>
          <pre className="msg">{message}</pre>
          <button className="btn" disabled={status === "signing"} onClick={() => void sign()}>
            {status === "signing" ? "Signature en cours…" : "Signer l'autorisation"}
          </button>
          {status === "error" && <p className="error-box">{detail || "Signature refusée."}</p>}
        </>
      )}

      {status === "sent" && (
        <p className="ok-box">
          ✔ Signature envoyée à ticketd — le ticket scellé arrive sur le launcher. Réponse : {detail}
        </p>
      )}
      {status === "ticketd-down" && (
        <>
          <p className="ok-box">✔ Message signé — la liaison wallet ↔ appareil est prouvée.</p>
          <p className="error-box">
            ticketd ({TICKETD_URL}) est injoignable (service P2 en cours de construction). Signature à
            transmettre :
          </p>
          <pre className="msg">{signature}</pre>
        </>
      )}
    </div>
  );
}

export default function PairPage() {
  return (
    <Suspense>
      <PairInner />
    </Suspense>
  );
}
