"use client";

// Provenance page — the studio pitch made visible: every owner, every
// resale, every royalty payment for one license, straight from the
// subgraph. Data-only page (no wallet needed).

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { SUBGRAPH_URL as DEFAULT_SUBGRAPH_URL } from "@gamevault/shared/deployments";

// NEXT_PUBLIC_SUBGRAPH_URL overrides the deployed default (e.g. a local graph-node).
const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL || DEFAULT_SUBGRAPH_URL;

const QUERY = `query License($id: ID!) {
  license(id: $id) {
    id
    owner
    mintedAt
    listed
    listPrice
    edition { id buildCid buildHash royaltyBps game { title studio { name } } }
    transfers(orderBy: timestamp, orderDirection: asc) { from to timestamp txHash }
    royaltyPayments(orderBy: timestamp, orderDirection: asc) {
      seller buyer salePrice royaltyAmount platformFee timestamp txHash
    }
  }
}`;

interface LicenseData {
  id: string;
  owner: string;
  mintedAt: string;
  listed: boolean;
  listPrice: string | null;
  edition: {
    id: string;
    buildCid: string;
    buildHash: string;
    royaltyBps: string;
    game: { title: string; studio: { name: string } };
  } | null;
  transfers: { from: string; to: string; timestamp: string; txHash: string }[];
  royaltyPayments: {
    seller: string;
    buyer: string;
    salePrice: string;
    royaltyAmount: string;
    platformFee: string;
    timestamp: string;
    txHash: string;
  }[];
}

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const when = (ts: string) => new Date(Number(ts) * 1000).toLocaleString();
const eth = (wei: string) => `${Number(wei) / 1e18} ETH`;
const ZERO = "0x0000000000000000000000000000000000000000";

export default function ProvenancePage() {
  const { tokenId } = useParams<{ tokenId: string }>();
  const [license, setLicense] = useState<LicenseData | null>(null);
  const [status, setStatus] = useState<"loading" | "no-subgraph" | "not-found" | "error" | "ok">("loading");

  useEffect(() => {
    if (!SUBGRAPH_URL) {
      setStatus("no-subgraph");
      return;
    }
    fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { id: tokenId } }),
    })
      .then((r) => r.json())
      .then((r) => {
        if (r.data?.license) {
          setLicense(r.data.license as LicenseData);
          setStatus("ok");
        } else {
          setStatus("not-found");
        }
      })
      .catch(() => setStatus("error"));
  }, [tokenId]);

  if (status === "no-subgraph") {
    return (
      <div className="pane">
        <h1>Provenance de la licence #{tokenId}</h1>
        <p>
          Le subgraph n&apos;est pas encore déployé (il attend les adresses des contrats — P1). Une fois en
          ligne, cette page montrera la chaîne complète des propriétaires, chaque revente et chaque royalty
          versée au studio — la transparence que le marché de l&apos;occasion classique n&apos;a jamais eue.
        </p>
        <p>
          Configuration : <code>NEXT_PUBLIC_SUBGRAPH_URL</code> dans <code>web/.env.local</code>.
        </p>
      </div>
    );
  }
  if (status === "loading") return <div className="pane"><p>Chargement…</p></div>;
  if (status === "error") return <div className="pane"><p className="error-box">Subgraph injoignable.</p></div>;
  if (status === "not-found" || !license)
    return <div className="pane"><p>Licence #{tokenId} inconnue du subgraph.</p></div>;

  return (
    <div className="pane" style={{ maxWidth: "52rem" }}>
      <h1>
        {license.edition?.game.title ?? "Licence"} — #{license.id}
      </h1>
      <dl className="kv">
        <dt>Studio</dt>
        <dd>{license.edition?.game.studio.name ?? "?"}</dd>
        <dt>Propriétaire actuel</dt>
        <dd>{short(license.owner)}</dd>
        <dt>Mintée le</dt>
        <dd>{when(license.mintedAt)}</dd>
        <dt>Royalties studio</dt>
        <dd>{license.edition ? `${Number(license.edition.royaltyBps) / 100} %` : "?"}</dd>
        <dt>Build (IPFS)</dt>
        <dd>{license.edition?.buildCid ?? "?"}</dd>
        <dt>Statut</dt>
        <dd>{license.listed ? `en vente — ${eth(license.listPrice ?? "0")}` : "pas en vente"}</dd>
      </dl>

      <h2 className="section">Chaîne des propriétaires</h2>
      <ol className="steps">
        {license.transfers.map((t, i) => (
          <li key={i}>
            {t.from.toLowerCase() === ZERO ? (
              <>🌱 Mint → <code>{short(t.to)}</code></>
            ) : (
              <><code>{short(t.from)}</code> → <code>{short(t.to)}</code></>
            )}{" "}
            · {when(t.timestamp)}
          </li>
        ))}
      </ol>

      <h2 className="section">Royalties versées</h2>
      {license.royaltyPayments.length === 0 ? (
        <p>Aucune revente pour l&apos;instant.</p>
      ) : (
        <ol className="steps">
          {license.royaltyPayments.map((p, i) => (
            <li key={i}>
              vente {eth(p.salePrice)} · studio +{eth(p.royaltyAmount)} · plateforme +{eth(p.platformFee)} ·{" "}
              {when(p.timestamp)}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
