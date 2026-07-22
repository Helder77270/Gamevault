"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { worldchainSepolia } from "wagmi/chains";
import { RainbowKitProvider, darkTheme, getDefaultConfig } from "@rainbow-me/rainbowkit";

// WalletConnect Cloud project id — free at https://cloud.walletconnect.com.
// The placeholder keeps browser-extension wallets working; mobile QR
// connections need a real id.
const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "gamevault-dev-placeholder";

export const config = getDefaultConfig({
  appName: "GameVault",
  projectId,
  chains: [worldchainSepolia],
  ssr: true,
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          locale="fr"
          theme={darkTheme({ accentColor: "#d9a441", accentColorForeground: "#14171c", borderRadius: "small" })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
