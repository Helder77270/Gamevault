"use client";

// Profil — pseudo + avatar + favoris, modifiables à volonté par simple
// signature (zéro gas, BDD ticketd). L'avatar est redimensionné CÔTÉ
// CLIENT (256 px max, webp) avant envoi — jamais trop lourd, jamais trop
// petit. Les pseudos ne sont pas uniques : l'adresse tranche.

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { fetchOnchainCatalog, type OnchainEdition } from "@gamevault/shared/registryCatalog";
import { ConnectButton } from "../components/ConnectButton";

const TICKETD_URL = process.env.NEXT_PUBLIC_TICKETD_URL ?? "http://localhost:8787";

type ProfileData = {
  name: string | null;
  hasAvatar: boolean;
  favorites: string[];
  topPlayed: { editionId: string; seconds: number }[];
};

const fmtDur = (s: number): string => (s < 60 ? "< 1 min" : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`);

/** Redimensionne l'image au canvas : carré 256 px, webp q0.85 → ~10-40 Ko. */
async function shrinkAvatar(file: File): Promise<{ b64: string; hashHex: string }> {
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
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return { b64: btoa(bin), hashHex: Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("") };
}

export default function ProfilePage() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const fileRef = useRef<HTMLInputElement>(null);

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [catalog, setCatalog] = useState<OnchainEdition[]>([]);
  const [name, setName] = useState("");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [pendingAvatar, setPendingAvatar] = useState<{ b64: string; hashHex: string } | "none" | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [avatarBust, setAvatarBust] = useState(0);
  const [devices, setDevices] = useState<{ max: number; devices: { pubkey: string; pairedAt: number; lastSeen: number }[] } | null>(null);
  const [revoking, setRevoking] = useState("");

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(`${TICKETD_URL}/profile/${address}`);
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as ProfileData;
      setProfile(data);
      setName(data.name ?? "");
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
      const avatarField = pendingAvatar === "none" ? "none" : pendingAvatar ? pendingAvatar.hashHex : "keep";
      const message = [
        "GameVault Profil",
        `me: ${address}`,
        `name: ${name.trim()}`,
        `avatar: ${avatarField}`,
        `favorites: ${favorites.join(",")}`,
        `at: ${new Date().toISOString()}`,
        `nonce: ${crypto.randomUUID()}`,
      ].join("\n");
      const signature = await signMessageAsync({ message });
      const res = await fetch(`${TICKETD_URL}/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, signature, avatarB64: pendingAvatar && pendingAvatar !== "none" ? pendingAvatar.b64 : undefined }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      setPendingAvatar(null);
      setPreview(null);
      setAvatarBust(Date.now());
      setSaved(true);
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? ((e as Error & { shortMessage?: string }).shortMessage ?? e.message) : e));
    }
    setBusy(false);
  };

  const toggleFav = (id: string) =>
    setFavorites((f) => (f.includes(id) ? f.filter((x) => x !== id) : f.length < 12 ? [...f, id] : f));

  const titleOf = (id: string): string => catalog.find((e) => e.editionId === id)?.title ?? `Édition #${id}`;
  const avatarUrl = preview ?? (profile?.hasAvatar && pendingAvatar !== "none" ? `${TICKETD_URL}/profile/avatar/${address}?t=${avatarBust}` : null);
  const dirty = name.trim() !== (profile?.name ?? "") || pendingAvatar !== null || favorites.join(",") !== (profile?.favorites ?? []).join(",");

  return (
    <div className="pane" style={{ maxWidth: "44rem" }}>
      <h1>Mon profil</h1>
      <p>
        Pseudo et avatar, modifiables quand vous voulez — une signature, <b>zéro transaction</b>. Vos amis vous
        trouvent par pseudo <em>ou</em> par adresse (les pseudos ne sont pas uniques : l&apos;adresse départage).
      </p>
      {!isConnected && <ConnectButton />}

      {isConnected && address && (
        <>
          <div style={{ display: "flex", gap: "1.4rem", alignItems: "center", margin: "1.2rem 0" }}>
            <div
              style={{
                width: 96,
                height: 96,
                borderRadius: 20,
                flex: "none",
                overflow: "hidden",
                border: "1px solid var(--line)",
                background: "linear-gradient(150deg, oklch(0.5 0.1 250), oklch(0.3 0.08 290))",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="avatar" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <span className="addr" style={{ fontSize: "1.6rem" }}>?</span>
              )}
            </div>
            <div>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => void pickAvatar(e.target.files?.[0])} />
              <button className="btn ghost" onClick={() => fileRef.current?.click()}>Changer l&apos;image</button>{" "}
              {(profile?.hasAvatar || preview) && (
                <button className="btn ghost" onClick={() => { setPendingAvatar("none"); setPreview(null); }}>Retirer</button>
              )}
              <p className="addr" style={{ margin: "0.5rem 0 0" }}>Recadrée en 256×256 automatiquement.</p>
            </div>
          </div>

          <p>
            Pseudo{" "}
            <input style={{ width: "16rem" }} maxLength={24} placeholder="ex. Picsou" value={name} onChange={(e) => setName(e.target.value)} />
            <span className="addr"> ({address.slice(0, 6)}…{address.slice(-4)})</span>
          </p>

          <h2 className="section">Favoris ({favorites.length}/12)</h2>
          <p className="addr">Cliquez pour épingler vos jeux préférés sur votre profil.</p>
          <p>
            {catalog.map((e) => (
              <button
                key={e.editionId}
                className={`btn ${favorites.includes(e.editionId) ? "" : "ghost"}`}
                style={{ marginRight: "0.5rem", marginBottom: "0.5rem" }}
                onClick={() => toggleFav(e.editionId)}
              >
                {favorites.includes(e.editionId) ? "★ " : "☆ "}
                {e.title}
              </button>
            ))}
          </p>

          <p>
            <button className="btn" disabled={busy || !dirty || name.trim().length < 2 || name.trim().length > 24} onClick={() => void save()}>
              {busy ? "Signature…" : "Enregistrer le profil"}
            </button>{" "}
            {saved && <span style={{ color: "var(--ok)" }}>✔ enregistré</span>}
          </p>

          <h2 className="section">Les plus joués</h2>
          {profile?.topPlayed.length ? (
            profile.topPlayed.map((t) => (
              <p key={t.editionId} style={{ margin: "0.25rem 0" }}>
                <b>{titleOf(t.editionId)}</b> <span className="addr">· {fmtDur(t.seconds)}</span>
              </p>
            ))
          ) : (
            <p className="addr">Rien encore — le launcher remplit cette liste à chaque session de jeu.</p>
          )}

          <h2 className="section">
            Mes appareils ({devices?.devices.length ?? 0}/{devices?.max ?? 2})
          </h2>
          <p className="addr">
            Votre compte peut être actif sur {devices?.max ?? 2} machines en même temps (chez vous + chez un ami par
            exemple). Appairer une machine de plus déconnecte la moins utilisée ; vous pouvez aussi libérer une place
            ici — une signature, zéro transaction.
          </p>
          {devices?.devices.length ? (
            devices.devices.map((d) => (
              <p key={d.pubkey} style={{ margin: "0.3rem 0" }}>
                <code>
                  {d.pubkey.slice(0, 10)}…{d.pubkey.slice(-6)}
                </code>{" "}
                <span className="addr">
                  · appairé le {new Date(d.pairedAt).toLocaleDateString()} · vu le {new Date(d.lastSeen).toLocaleString()}
                </span>{" "}
                <button className="btn ghost" disabled={!!revoking} onClick={() => void revoke(d.pubkey)}>
                  {revoking === d.pubkey ? "Signature…" : "Déconnecter"}
                </button>
              </p>
            ))
          ) : (
            <p className="addr">Aucun appareil actif — appairez une machine depuis le launcher.</p>
          )}

          <h2 className="section">Succès</h2>
          <p className="addr">Bientôt — les hauts faits de vos licences (premier prêt, revente, collection complète…).</p>

          {error && <p className="error-box">{error}</p>}
        </>
      )}
    </div>
  );
}
