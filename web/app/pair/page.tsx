"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAccount, useChainId, useSignMessage } from "wagmi";
import { buildPairingMessage } from "@gamevault/shared/siwe";
import { ConnectButton } from "../components/ConnectButton";

const TICKETD_URL = process.env.NEXT_PUBLIC_TICKETD_URL ?? "http://localhost:8787";

type Status = "idle" | "signing" | "sent" | "ticketd-down" | "error";
type Device = { pubkey: string; pairedAt: number; lastSeen: number };

const shortKey = (k: string): string => `${k.slice(0, 8)}…${k.slice(-6)}`;

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
  const [devices, setDevices] = useState<{ max: number; devices: Device[] } | null>(null);

  // Account device slots — shown BEFORE signing so an eviction is never a surprise
  useEffect(() => {
    if (!address) return;
    fetch(`${TICKETD_URL}/devices/${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setDevices)
      .catch(() => setDevices(null));
  }, [address, status]);

  const thisDeviceKnown = Boolean(devices?.devices.some((d) => d.pubkey === devicePubKey.toLowerCase()));
  const willEvict =
    devices && !thisDeviceKnown && devices.devices.length >= devices.max
      ? [...devices.devices].sort((a, b) => a.lastSeen - b.lastSeen)[0]
      : null;

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

      {isConnected && devices && (
        <p className={willEvict ? "error-box" : "addr"}>
          {thisDeviceKnown
            ? `Cette machine fait déjà partie de vos appareils (${devices.devices.length}/${devices.max}) — renouvellement, aucune place consommée.`
            : willEvict
              ? `Votre compte est déjà actif sur ${devices.max} appareils. En signant, l'appareil le moins utilisé récemment (${shortKey(willEvict.pubkey)}, vu le ${new Date(willEvict.lastSeen).toLocaleString()}) sera déconnecté. Vous pouvez aussi libérer une place depuis votre profil.`
              : `Appareils actifs sur ce compte : ${devices.devices.length}/${devices.max} — cette machine occupera une place.`}
        </p>
      )}

      {isConnected && status !== "sent" && status !== "ticketd-down" && (
        <>
          <h2 className="section">Message à signer (SIWE)</h2>
          <pre className="msg">{message}</pre>
          <button className="btn" disabled={status === "signing"} onClick={() => void sign()}>
            {status === "signing" ? "Signature en cours…" : "Signer l'autorisation"}
          </button>
          {status === "error" && !detail && <p className="error-box">Signature refusée.</p>}
        </>
      )}

      {status === "sent" && (
        <p className="ok-box">
          ✔ Machine autorisée — le ticket scellé arrive sur le launcher.
          {devices ? ` Appareils actifs : ${devices.devices.length}/${devices.max}.` : ""}
        </p>
      )}
      {status === "error" && detail && (
        <p className="error-box">
          {(() => {
            try {
              return (JSON.parse(detail) as { error?: string }).error ?? detail;
            } catch {
              return detail;
            }
          })()}
        </p>
      )}
      {status === "ticketd-down" && (
        <>
          <p className="ok-box">✔ Message signé — la liaison wallet ↔ appareil est prouvée.</p>
          <p className="error-box">
            Le service GameVault est injoignable pour l&apos;instant. Réessayez dans un instant, ou transmettez
            cette signature :
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
