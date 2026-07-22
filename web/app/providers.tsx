"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { worldchainSepolia } from "wagmi/chains";
// note: not "wagmi/connectors" — that barrel pulls the optional `porto`
// connector, which breaks the Next build unless porto is installed
import { injected } from "@wagmi/core";

export const config = createConfig({
  chains: [worldchainSepolia],
  connectors: [injected()],
  transports: {
    [worldchainSepolia.id]: http(),
  },
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
