// Second-hand listings — THE thing Steam doesn't have. Read straight from
// the Marketplace contract: every token with a listing that buy() would
// still accept (shared by the home row and /occasions).

import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { DEPLOYMENTS } from "@gamevault/shared/deployments";
import { LICENSE_ABI, MARKETPLACE_ABI } from "@gamevault/shared/abi";

export type Occasion = { tokenId: string; editionId: string; price: bigint; seller: string };

const ZERO = "0x0000000000000000000000000000000000000000";

export async function fetchOccasions(): Promise<Occasion[]> {
  if (!DEPLOYMENTS.gameLicense || !DEPLOYMENTS.marketplace) return [];
  const c = createPublicClient({ chain: baseSepolia, transport: http() });
  const license = DEPLOYMENTS.gameLicense as `0x${string}`;
  const market = DEPLOYMENTS.marketplace as `0x${string}`;
  const next = await c.readContract({ address: license, abi: LICENSE_ABI, functionName: "nextTokenId" });
  const found: Occasion[] = [];
  for (let i = BigInt(1); i <= next; i++) {
    try {
      const [seller, price, nonce] = await c.readContract({ address: market, abi: MARKETPLACE_ABI, functionName: "listings", args: [i] });
      if (seller.toLowerCase() === ZERO) continue;
      // Same rules as Marketplace.buy(): the seller still owns the token, it
      // has not moved since it was listed, and the Marketplace may still
      // transfer it (approval not revoked).
      const [owner, moves, approved, operator] = await Promise.all([
        c.readContract({ address: license, abi: LICENSE_ABI, functionName: "ownerOf", args: [i] }),
        c.readContract({ address: license, abi: LICENSE_ABI, functionName: "transferCount", args: [i] }),
        c.readContract({ address: license, abi: LICENSE_ABI, functionName: "getApproved", args: [i] }),
        c.readContract({ address: license, abi: LICENSE_ABI, functionName: "isApprovedForAll", args: [seller, market] }),
      ]);
      if (owner.toLowerCase() !== seller.toLowerCase() || moves !== nonce) continue;
      if (approved.toLowerCase() !== market.toLowerCase() && !operator) continue;
      const ed = await c.readContract({ address: license, abi: LICENSE_ABI, functionName: "editionOf", args: [i] });
      found.push({ tokenId: i.toString(), editionId: ed.toString(), price, seller: seller.toLowerCase() });
    } catch {
      /* burned / unknown token */
    }
  }
  return found;
}
