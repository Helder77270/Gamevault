"use client";

// Profile privacy (P7 B) — who sees each social section of /u/<address>.
// Licence ownership stays public on-chain whatever is chosen: only the
// social layer (ticketd) hides.

import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useTicketd } from "../lib/ticketd";

type Level = "public" | "friends" | "private";
type Section = "profile" | "presence" | "activity" | "library";
type Privacy = Record<Section, Level>;

const SECTIONS: { key: Section; label: string; help: string }[] = [
  { key: "profile", label: "Profil", help: "Bio, vitrine, amis, date d'arrivée" },
  { key: "presence", label: "Présence", help: "En ligne, en jeu — sinon vous apparaissez hors ligne" },
  { key: "activity", label: "Activité", help: "Parties récentes, temps de jeu" },
  { key: "library", label: "Bibliothèque", help: "Vos licences sur votre page (elles restent lisibles on-chain)" },
];
const LEVELS: { key: Level; label: string }[] = [
  { key: "public", label: "Public" },
  { key: "friends", label: "Amis" },
  { key: "private", label: "Privé" },
];

export function PrivacyCard() {
  const { address } = useAccount();
  const { authed, hasSession } = useTicketd();
  const [privacy, setPrivacy] = useState<Privacy | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setPrivacy(await authed<Privacy>("/profile/privacy"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [authed]);

  useEffect(() => {
    if (address && hasSession) void load();
  }, [address, hasSession, load]);

  const choose = async (section: Section, level: Level) => {
    setBusy(section);
    setError("");
    try {
      setPrivacy(await authed<Privacy>("/profile/privacy", { body: { [section]: level } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy("");
  };

  return (
    <>
      <div className="pe-title-row">
        <h2>Confidentialité</h2>
        <span className="pe-eyebrow">QUI VOIT QUOI</span>
      </div>
      <p className="pe-help">
        Votre pseudo et votre avatar restent visibles pour qu&apos;on vous reconnaisse. La propriété de vos licences, elle, reste publique sur la
        blockchain quoi que vous choisissiez : seule la couche sociale se masque.
      </p>
      {privacy === null ? (
        <button className="btn ghost" style={{ marginTop: "1rem" }} onClick={() => void load()}>
          Gérer (1 signature, sans gas)
        </button>
      ) : (
        <div className="pe-list">
          {SECTIONS.map((s) => (
            <div className="pv-row" key={s.key}>
              <div className="pe-device-body">
                <span className="pv-label">{s.label}</span>
                <span className="pe-help">{s.help}</span>
              </div>
              <div className="pv-seg" role="radiogroup" aria-label={s.label}>
                {LEVELS.map((l) => (
                  <button
                    key={l.key}
                    role="radio"
                    aria-checked={privacy[s.key] === l.key}
                    className={privacy[s.key] === l.key ? "on" : ""}
                    disabled={busy === s.key}
                    onClick={() => void choose(s.key, l.key)}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <p className="error-box">{error}</p>}
    </>
  );
}
