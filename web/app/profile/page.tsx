"use client";

// Mon profil (édition) — pseudo, bio, avatar, favoris, via la session
// ticketd (une signature par 24 h, zéro gas). La vue publique est /u/<adresse>.
// L'avatar est redimensionné CÔTÉ CLIENT (256 px, webp) avant envoi. Les
// pseudos ne sont pas uniques : l'adresse tranche.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount, useSignMessage } from "wagmi";
import { fetchOnchainCatalog, hueOf, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { Avatar, shortAddr } from "../components/Avatar";
import { ConnectButton } from "../components/ConnectButton";
import { PendingPayout } from "../components/PendingPayout";
import { TICKETD_URL, useTicketd } from "../lib/ticketd";


type ProfileData = {
  name: string | null;
  hasAvatar: boolean;
  bio: string;
  favorites: string[];
  topPlayed: { editionId: string; seconds: number }[];
};

/** Redimensionne l'image au canvas : carré 256 px, webp q0.85 → ~10-40 Ko. */
async function shrinkAvatar(file: File): Promise<{ b64: string }> {
  const img = await createImageBitmap(file);
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const side = Math.min(img.width, img.height);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  const blob: Blob = await new Promise((r) => canvas.toBlob((b) => r(b!), "image/webp", 0.85));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return { b64: btoa(bin) };
}

export default function ProfilePage() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { authed } = useTicketd();
  const fileRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [catalog, setCatalog] = useState<OnchainEdition[]>([]);
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [pendingAvatar, setPendingAvatar] = useState<{ b64: string } | "none" | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [avatarBust, setAvatarBust] = useState(0);
  const [devices, setDevices] = useState<{ max: number; devices: { pubkey: string; pairedAt: number; lastSeen: number }[] } | null>(null);
  const [revoking, setRevoking] = useState("");
  const [copied, setCopied] = useState(false);
  const addrRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(`${TICKETD_URL}/profile/${address}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as ProfileData;
      setProfile(data);
      setName(data.name ?? "");
      setBio(data.bio ?? "");
      setFavorites(data.favorites);
      const dev = await fetch(`${TICKETD_URL}/devices/${address}`);
      if (dev.ok) setDevices(await dev.json());
    } catch (e) {
      setError(`ticketd: ${e instanceof Error ? e.message : e}`);
    }
  }, [address]);

  /** Free a device slot — wallet signature, zero gas. That machine is
   *  revoked at its next online check. */
  const revoke = async (pubkey: string) => {
    if (!address) return;
    setError("");
    setRevoking(pubkey);
    try {
      const message = [
        "GameVault Appareils",
        "action: revoke",
        `me: ${address}`,
        `device: ${pubkey}`,
        `at: ${new Date().toISOString()}`,
        `nonce: ${crypto.randomUUID()}`,
      ].join("\n");
      const signature = await signMessageAsync({ message });
      const res = await fetch(`${TICKETD_URL}/devices/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? ((e as Error & { shortMessage?: string }).shortMessage ?? e.message) : e));
    }
    setRevoking("");
  };

  useEffect(() => {
    fetchOnchainCatalog().then(setCatalog).catch(() => {});
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pickAvatar = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try {
      const shrunk = await shrinkAvatar(file);
      setPendingAvatar(shrunk);
      setPreview(`data:image/webp;base64,${shrunk.b64}`);
    } catch {
      setError("Impossible de lire cette image — essayez un jpeg/png/webp.");
    }
  };

  const save = async () => {
    if (!address) return;
    setError("");
    setSaved(false);
    setBusy(true);
    try {
      const avatar = pendingAvatar === "none" ? "none" : pendingAvatar ? pendingAvatar.b64 : "keep";
      await authed("/profile", { body: { name: name.trim(), bio, favorites, avatar } });
      setPendingAvatar(null);
      setPreview(null);
      setAvatarBust(Date.now());
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? ((e as Error & { shortMessage?: string }).shortMessage ?? e.message) : e));
    }
    setBusy(false);
  };

  const toggleFav = (id: string) =>
    setFavorites((f) => (f.includes(id) ? f.filter((x) => x !== id) : f.length < 12 ? [...f, id] : f));

  const editionOf = (id: string): OnchainEdition | undefined => catalog.find((e) => e.editionId === id);
  const avatarUrl = preview ?? (profile?.hasAvatar && pendingAvatar !== "none" ? `${TICKETD_URL}/profile/avatar/${address}?t=${avatarBust}` : null);
  const trimmed = name.trim();
  const nameOk = trimmed.length >= 2 && trimmed.length <= 24;
  const changes = [
    trimmed !== (profile?.name ?? "") && "pseudo",
    bio !== (profile?.bio ?? "") && "bio",
    pendingAvatar !== null && "image",
    favorites.join(",") !== (profile?.favorites ?? []).join(",") && "vitrine",
  ].filter(Boolean) as string[];
  const dirty = changes.length > 0;

  const cancel = () => {
    setName(profile?.name ?? "");
    setBio(profile?.bio ?? "");
    setFavorites(profile?.favorites ?? []);
    setPendingAvatar(null);
    setPreview(null);
    setError("");
  };

  const copyAddr = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      addrRef.current?.select();
    }
  };

  const artOf = (id: string) => ({
    background: `linear-gradient(140deg, oklch(0.58 0.12 ${hueOf(id)}), oklch(0.3 0.08 ${hueOf(id) + 40}))`,
  });

  if (!isConnected || !address) {
    return (
      <div className="pe">
        <header className="pe-head">
          <div>
            <div className="pe-eyebrow">PROFIL · ÉDITION</div>
            <h1>Modifier mon profil</h1>
            <p>Connectez votre wallet pour modifier votre pseudo, votre bio, votre image et votre vitrine.</p>
          </div>
        </header>
        <section className="pe-card">
          <ConnectButton />
        </section>
      </div>
    );
  }

  const devCount = devices?.devices.length ?? 0;
  const devMax = devices?.max ?? 2;

  return (
    <div className="pe">
      <header className="pe-head">
        <div>
          <div className="pe-eyebrow">PROFIL · ÉDITION</div>
          <h1>Modifier mon profil</h1>
          <p>Votre profil est public. Tout se modifie sans transaction : la plateforme l&apos;enregistre, lié à votre adresse.</p>
        </div>
        <Link className="pe-public" href={`/u/${address}`}>
          Voir mon profil public ↗
        </Link>
      </header>

      <div className="pe-grid">
        <nav className="pe-nav" aria-label="Sections du profil">
          <a href="#identite">
            Identité <span className={nameOk ? "ok" : "warn"}>{nameOk ? "✓" : "!"}</span>
          </a>
          <a href="#apropos">
            À propos <span>{bio.length}/500</span>
          </a>
          <a href="#vitrine">
            Vitrine <span>{favorites.length}/12</span>
          </a>
          <a href="#appareils">
            Appareils <span className={devCount >= devMax ? "warn" : ""}>{devCount}/{devMax}</span>
          </a>
          <a href="#gains">Gains en attente</a>
        </nav>

        <div className="pe-form">
          {/* 1 · identity */}
          <section className="pe-card" id="identite">
            <h2>Identité</h2>
            <p className="pe-help">Ce que les autres joueurs voient en premier.</p>
            <div className="pe-avatar-row">
              {avatarUrl ? (
                <span className="av-ring" style={{ borderRadius: 26, padding: 3 }}>
                  <span className="av" style={{ width: 98, height: 98, borderRadius: 22 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={avatarUrl} alt="Votre image de profil" />
                  </span>
                </span>
              ) : (
                <Avatar addr={address} name={trimmed || null} size={98} ring />
              )}
              <div className="pe-avatar-actions">
                <div className="pe-row">
                  <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void pickAvatar(e.target.files?.[0])} />
                  <button className="btn ghost" onClick={() => fileRef.current?.click()}>
                    Changer l&apos;image
                  </button>
                  {(profile?.hasAvatar || preview) && pendingAvatar !== "none" && (
                    <button
                      className="pe-text-btn"
                      onClick={() => {
                        setPendingAvatar("none");
                        setPreview(null);
                      }}
                    >
                      Retirer
                    </button>
                  )}
                </div>
                <span className="pe-help">JPG, PNG ou WebP. Recadrée en carré 256 × 256.</span>
              </div>
            </div>

            <div className="pe-fields">
              <div>
                <label htmlFor="pf-name">Pseudo</label>
                <div className="pe-input-wrap">
                  <input
                    id="pf-name"
                    className={`pe-input ${!nameOk && trimmed !== (profile?.name ?? "") ? "invalid" : ""}`}
                    maxLength={24}
                    placeholder="ex. Picsou"
                    value={name}
                    aria-describedby="pf-name-help"
                    onChange={(e) => setName(e.target.value)}
                  />
                  <span className="pe-count">{trimmed.length}/24</span>
                </div>
                <p className="pe-help" id="pf-name-help">
                  {!nameOk && trimmed !== (profile?.name ?? "")
                    ? "Le pseudo doit faire entre 2 et 24 caractères."
                    : "2 à 24 caractères. Deux joueurs peuvent porter le même pseudo : l'adresse les départage."}
                </p>
              </div>
              <div>
                <label htmlFor="pf-addr">Adresse du wallet</label>
                <div className="pe-row">
                  <input id="pf-addr" ref={addrRef} className="pe-input mono" readOnly value={address} />
                  <button className="pe-icon-btn" aria-label="Copier l'adresse" onClick={() => void copyAddr()}>
                    {copied ? (
                      "✓"
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <rect x="9" y="9" width="12" height="12" rx="2" />
                        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                      </svg>
                    )}
                  </button>
                </div>
                <p className="pe-help">Votre identité sur GameVault. Elle ne se modifie pas.</p>
              </div>
            </div>
          </section>

          {/* 2 · about */}
          <section className="pe-card" id="apropos">
            <h2>À propos</h2>
            <p className="pe-help">Ce que vous aimez jouer, quand vous êtes disponible pour un prêt.</p>
            <label htmlFor="pf-bio" style={{ marginTop: "1.1rem" }}>
              Bio
            </label>
            <textarea
              id="pf-bio"
              className="pe-input"
              value={bio}
              maxLength={500}
              rows={4}
              placeholder="Ce que vous aimez jouer, vos disponibilités pour les prêts…"
              onChange={(e) => setBio(e.target.value)}
            />
            <div className="pe-foot">
              <span className="pe-help">Texte simple, sans mise en forme.</span>
              <span className="pe-count static">{bio.length}/500</span>
            </div>
          </section>

          {/* 3 · showcase */}
          <section className="pe-card" id="vitrine">
            <div className="pe-title-row">
              <h2>Vitrine</h2>
              <span className="pe-eyebrow">{favorites.length} ÉPINGLÉ{favorites.length > 1 ? "S" : ""} SUR 12</span>
            </div>
            <p className="pe-help">Les jeux mis en avant sur votre profil, dans l&apos;ordre où vous les épinglez.</p>
            {catalog.length ? (
              <div className="pe-tiles">
                {catalog.map((e) => {
                  const rank = favorites.indexOf(e.editionId);
                  const on = rank >= 0;
                  const full = !on && favorites.length >= 12;
                  return (
                    <button key={e.editionId} className={`pe-tile ${on ? "on" : ""}`} aria-pressed={on} disabled={full} onClick={() => toggleFav(e.editionId)}>
                      <span className="pe-tile-art" style={artOf(e.editionId)} />
                      {on && <span className="pe-rank">{rank + 1}</span>}
                      <span className="pe-tile-body">
                        <span className="pe-tile-title">{e.title}</span>
                        <span className="pe-tile-sub">{on ? "★ ÉPINGLÉ" : full ? "VITRINE PLEINE" : "＋ ÉPINGLER"} · {e.studio.toUpperCase()}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="pe-help">Lecture du catalogue on-chain…</p>
            )}
          </section>

          {/* 4 · devices */}
          <section className="pe-card" id="appareils">
            <div className="pe-title-row">
              <h2>Appareils</h2>
              <span className={`pe-eyebrow ${devCount >= devMax ? "warn" : ""}`}>
                {devCount} SUR {devMax}
                {devCount >= devMax ? " · COMPLET" : ""}
              </span>
            </div>
            <p className="pe-help">
              Votre compte peut être actif sur {devMax} machines. En appairer une de plus déconnecte la moins utilisée. Libérer une place demande une signature, sans transaction.
            </p>
            {devices?.devices.length ? (
              <div className="pe-list">
                {devices.devices.map((d) => (
                  <div className="pe-device" key={d.pubkey}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                      <rect x="3" y="4" width="18" height="12" rx="2" />
                      <path d="M8 20h8M12 16v4" />
                    </svg>
                    <div className="pe-device-body">
                      <code>
                        {d.pubkey.slice(0, 6)}…{d.pubkey.slice(-4)}
                      </code>
                      <span className="pe-help">
                        Appairée le {new Date(d.pairedAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} · vue le{" "}
                        {new Date(d.lastSeen).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <button className="pe-danger" disabled={!!revoking} onClick={() => void revoke(d.pubkey)}>
                      {revoking === d.pubkey ? "Signature…" : "Déconnecter"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="pe-help pe-empty">Aucun appareil actif. Appairez une machine depuis le launcher.</p>
            )}
          </section>

          {/* 5 · pending payouts */}
          <section className="pe-card" id="gains">
            <PendingPayout address={address} variant="card" />
          </section>

          {error && <p className="error-box">{error}</p>}
        </div>

        <aside className="pe-preview" aria-label="Aperçu du profil public">
          <div className="pe-eyebrow">APERÇU PUBLIC · EN DIRECT</div>
          <div className="pe-pcard">
            <div className="pe-pbanner" />
            <div className="pe-pbody">
              <div className="pe-pavatar">
                {avatarUrl ? (
                  <span className="av-ring" style={{ borderRadius: 18, padding: 3 }}>
                    <span className="av" style={{ width: 62, height: 62, borderRadius: 15 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={avatarUrl} alt="" />
                    </span>
                  </span>
                ) : (
                  <Avatar addr={address} name={trimmed || null} size={62} ring />
                )}
              </div>
              <div className="pe-pname">{trimmed || "Sans pseudo"}</div>
              <div className="pe-paddr">{shortAddr(address).toUpperCase()}</div>
              {bio.trim() && <p className="pe-pbio">{bio.trim().length > 170 ? `${bio.trim().slice(0, 170)}…` : bio.trim()}</p>}
              {favorites.length > 0 && (
                <div className="pe-pfavs">
                  {favorites.slice(0, 4).map((id) => (
                    <span key={id} className="pe-pfav" style={artOf(id)} title={editionOf(id)?.title ?? `Édition #${id}`} />
                  ))}
                </div>
              )}
            </div>
          </div>
          <p className="pe-help">L&apos;aperçu suit vos modifications avant l&apos;enregistrement.</p>
        </aside>
      </div>

      {(dirty || saved) && (
        <div className={`pe-savebar ${dirty ? "" : "done"}`} role="status">
          {dirty ? (
            <>
              <span className="pe-savebar-msg">
                <span className="pe-dot" />
                {changes.length} modification{changes.length > 1 ? "s" : ""} non enregistrée{changes.length > 1 ? "s" : ""} · {changes.join(", ")}
              </span>
              <span className="pe-row">
                <button className="btn ghost" disabled={busy} onClick={cancel}>
                  Annuler
                </button>
                <button className="btn" disabled={busy || !nameOk} onClick={() => void save()}>
                  {busy ? "Enregistrement…" : "Enregistrer"}
                </button>
              </span>
            </>
          ) : (
            <span className="pe-savebar-msg">✓ Profil enregistré</span>
          )}
        </div>
      )}
    </div>
  );
}
