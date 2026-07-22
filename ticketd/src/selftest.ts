// End-to-end proof of ticket issuance, no HTTP, no chain (dev mode):
// real viem wallet signs the pairing message -> issueTicket -> ticket
// verifies against the platform key AND its envelope opens with the
// device key, yielding the exact key that encrypted the game build.
// Run: npm run selftest -w ticketd

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTicket, unwrapKey, unhex, hex } from "@gamevault/shared";
import { buildPairingMessage } from "@gamevault/shared/siwe";
import { DEV_PLATFORM_PUB, DEV_DEVICE_PRIV, DEV_DEVICE_PUB, DEV_CONTENT_KEY } from "@gamevault/shared/devkeys";
import { issueTicket } from "./service.ts";

let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
};

const owner = privateKeyToAccount(generatePrivateKey());

const params = {
  address: owner.address,
  chainId: 4801,
  devicePubKey: hex(DEV_DEVICE_PUB),
  nonce: `selftest-${Math.random().toString(36).slice(2)}`,
  tokenId: "1",
  contract: "0x0000000000000000000000000000000000000001",
  issuedAt: new Date().toISOString(),
};
const message = buildPairingMessage(params);
const signature = await owner.signMessage({ message });

// Happy path
const ticket = await issueTicket({ message, signature });
check("ticket issued for the signer's address", ticket.ownerAddress === owner.address);
check("ticket verifies against the embedded platform pubkey", verifyTicket(ticket, DEV_PLATFORM_PUB));
const recovered = unwrapKey(unhex(ticket.wrappedContentKey), DEV_DEVICE_PRIV);
check("envelope opens with the device key -> the build's content key", hex(recovered) === hex(DEV_CONTENT_KEY));

// Attacks
const stranger = privateKeyToAccount(generatePrivateKey());
const strangerSig = await stranger.signMessage({ message });
check(
  "signature from another wallet refused",
  await issueTicket({ message, signature: strangerSig }).then(
    () => false,
    () => true,
  ),
);

check(
  "nonce replay refused",
  await issueTicket({ message, signature }).then(
    () => false,
    () => true,
  ),
);

const stale = buildPairingMessage({ ...params, nonce: "stale", issuedAt: new Date(Date.now() - 3600_000).toISOString() });
check(
  "stale pairing message refused",
  await issueTicket({ message: stale, signature: await owner.signMessage({ message: stale }) }).then(
    () => false,
    () => true,
  ),
);

console.log(failures === 0 ? "\nAll checks passed — ticketd issuance is sound." : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
