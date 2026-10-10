import type { Metadata } from "next";
import Link from "next/link";
import { Chakra_Petch, Space_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { ConnectButton } from "./components/ConnectButton";

const chakra = Chakra_Petch({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
});
const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "AURA-64 — GameVault marketplace",
  description: "Jeux indés en cartouches USB/SD : jouables hors ligne, prêtables et revendables.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" className={`${chakra.variable} ${spaceMono.variable}`}>
      <body>
        <Providers>
          <header className="topbar">
            <Link href="/" className="brand">
              AURA&#8209;64 <span>GAMEVAULT</span>
            </Link>
            <nav className="nav">
              <Link href="/">Marketplace</Link>
              <Link href="/occasions">Occasions</Link>
              <Link href="/friends">Amis &amp; Prêts</Link>
              <Link href="/chat">Messages</Link>
              <Link href="/profile">Profil</Link>
              <Link href="/studios">Studios</Link>
              <Link href="/studio">Espace studio</Link>
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
