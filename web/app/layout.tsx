import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { Providers } from "./providers";
import { ConnectButton } from "./components/ConnectButton";

export const metadata: Metadata = {
  title: "GameVault — marketplace",
  description: "Jeux indés en cartouches USB/SD : licences ERC-721, jouables hors ligne, revendables avec royalties.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body>
        <Providers>
          <header className="topbar">
            <div className="brand">
              GAME<span>VAULT</span>
            </div>
            <nav className="nav">
              <Link href="/">Marketplace</Link>
              <Link href="/pair">Appairage</Link>
            </nav>
            <ConnectButton />
          </header>
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
