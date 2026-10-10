"use client";

// Every studio on GameVault (subgraph), each linking to its public page.

import { useEffect, useState } from "react";
import Link from "next/link";
import { shortAddr } from "../components/Avatar";
import { subgraph } from "../lib/subgraph";

type Row = { id: string; name: string; owner: string; games: { id: string; editions: { id: string; minted: string }[] }[] };

export default function StudiosPage() {
  const [studios, setStudios] = useState<Row[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    subgraph<{ studios: Row[] }>(`{ studios(first: 200, orderBy: id) { id name owner games { id editions { id minted } } } }`)
      .then((d) => setStudios(d.studios))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <div className="pane" style={{ maxWidth: "60rem" }}>
      <h1>Studios</h1>
      <p>Les studios indépendants qui publient sur GameVault. Chaque revente de leurs jeux leur reverse automatiquement leurs royalties.</p>
      {error && <p className="error-box">{error}</p>}
      {studios === null && !error && <p className="addr">Chargement…</p>}
      <div className="pf-cards" style={{ marginTop: "1rem" }}>
        {(studios ?? []).map((s) => {
          const editions = s.games.flatMap((g) => g.editions);
          const minted = editions.reduce((n, e) => n + Number(e.minted), 0);
          return (
            <Link key={s.id} href={`/studio/${s.id}`} className="pf-box" style={{ display: "block" }}>
              <div style={{ fontWeight: 700, fontSize: "1.1rem" }}>{s.name}</div>
              <div className="addr">
                #{s.id} · {s.games.length} jeu{s.games.length > 1 ? "x" : ""} · {minted} licence{minted > 1 ? "s" : ""} · {shortAddr(s.owner)}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
