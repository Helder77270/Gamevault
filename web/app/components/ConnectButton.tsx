"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
        <span className="addr">{short(address)}</span>
        <button className="btn ghost" onClick={() => disconnect()}>
          Quitter
        </button>
      </div>
    );
  }
  return (
    <button className="btn" disabled={isPending} onClick={() => connect({ connector: connectors[0] })}>
      {isPending ? "Connexion…" : "Connecter le wallet"}
    </button>
  );
}
