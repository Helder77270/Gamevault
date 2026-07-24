// The catalog IS the chain: enumerate GameRegistry editions with their
// game/studio names. No mock data — what you see exists on-chain.
// Consumed by web/ (marketplace) and launcher/ (store).

import { createPublicClient, http, type PublicClient } from "viem";
import { REGISTRY_ABI } from "./abi.ts";
import { CHAIN, DEPLOYMENTS } from "./deployments.ts";

export interface OnchainEdition {
  editionId: string;
  gameId: string;
  studioId: string;
  title: string;
  studio: string;
  priceWei: bigint;
  royaltyBps: number;
  supply: number;
  minted: number;
  buildCid: string;
  buildSha256: string;
}

/** Display blurbs keyed by editionId — cosmetic only, everything else is on-chain. */
export const BLURBS: Record<string, string> = {
  "2": "Ramassez 10 pièces, évitez les rouges. L'édition de développement.",
};

export async function fetchOnchainCatalog(existingClient?: PublicClient): Promise<OnchainEdition[]> {
  if (!DEPLOYMENTS.gameRegistry) return [];
  const client =
    existingClient ?? createPublicClient({ transport: http(CHAIN.rpcUrl, { timeout: 8000, retryCount: 1 }) });
  const registry = DEPLOYMENTS.gameRegistry as `0x${string}`;
  const read = <T,>(functionName: string, args: unknown[]): Promise<T> =>
    client.readContract({ address: registry, abi: REGISTRY_ABI, functionName, args } as never) as Promise<T>;

  const count = Number(await read<bigint>("editionCount", []));
  const games = new Map<string, { studioId: string; title: string }>();
  const studios = new Map<string, string>();
  const out: OnchainEdition[] = [];

  for (let i = 1; i <= count; i++) {
    const ed = await read<[bigint, bigint, bigint, bigint, string, string, bigint]>("editions", [BigInt(i)]);
    const gameId = ed[0].toString();
    if (!games.has(gameId)) {
      const g = await read<[bigint, string]>("games", [BigInt(gameId)]);
      games.set(gameId, { studioId: g[0].toString(), title: g[1] });
    }
    const game = games.get(gameId)!;
    if (!studios.has(game.studioId)) {
      const s = await read<[string, string]>("studios", [BigInt(game.studioId)]);
      studios.set(game.studioId, s[1]);
    }
    out.push({
      editionId: i.toString(),
      gameId,
      studioId: game.studioId,
      title: game.title,
      studio: studios.get(game.studioId)!,
      priceWei: ed[2],
      royaltyBps: Number(ed[3]),
      supply: Number(ed[1]),
      minted: Number(ed[6]),
      buildCid: ed[4],
      buildSha256: ed[5],
    });
  }
  return out;
}
