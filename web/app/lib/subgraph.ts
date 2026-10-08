// Read-only GraphQL client for the GameVault subgraph (Goldsky). Holds the
// on-chain side of profiles: licences owned, loans, listings, royalties.

import { SUBGRAPH_URL as DEFAULT_SUBGRAPH_URL } from "@gamevault/shared/deployments";

export const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL || DEFAULT_SUBGRAPH_URL;

export async function subgraph<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`subgraph HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}
