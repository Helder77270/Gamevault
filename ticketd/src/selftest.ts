// End-to-end proof of ticket issuance, no HTTP, no chain (dev mode):
// real viem wallet signs the pairing message -> issueTicket -> ticket
// verifies against the platform key AND its envelope opens with the
// device key, yielding the exact key that encrypted the game build.
// Run: npm run selftest -w ticketd

process.env.GAMEVAULT_SKIP_OWNER_CHECK = "1"; // no chain in the selftest

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { verifyTicket, unwrapKey, unhex, hex } from "@gamevault/shared";
import { buildPairingMessage } from "@gamevault/shared/siwe";
import { DEV_PLATFORM_PUB, DEV_DEVICE_PRIV, DEV_DEVICE_PUB, DEV_CONTENT_KEY } from "@gamevault/shared/devkeys";

const { issueTicket } = await import("./service.ts"); // after the env flag

let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) failures++;
};

const owner = privateKeyToAccount(generatePrivateKey());

const params = {
  address: owner.address,
  chainId: 84532, // Base Sepolia
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

// --- Social v1: sessions, friends, chat ------------------------------------
const social = await import("./social.ts");
const { devices } = await import("./db.ts");
const { secp256k1 } = await import("@noble/curves/secp256k1");
const { sha256 } = await import("@noble/hashes/sha256");

const refused = (fn: () => unknown): Promise<boolean> =>
  Promise.resolve()
    .then(fn)
    .then(
      () => false,
      () => true,
    );

// Web session: one wallet signature
const sessMsg = ["GameVault Session", `me: ${owner.address}`, `at: ${new Date().toISOString()}`, `nonce: ${crypto.randomUUID()}`].join("\n");
const web = await social.openWebSession(sessMsg, await owner.signMessage({ message: sessMsg }));
check("web session opened by one wallet signature", social.authWallet(`Bearer ${web.token}`).wallet === owner.address.toLowerCase());
check("session replay refused", await refused(async () => social.openWebSession(sessMsg, await owner.signMessage({ message: sessMsg }))));
check("forged token refused", await refused(() => social.authWallet("Bearer not-a-real-token")));

// Launcher session: the device key signs, the device must be paired
const friend = privateKeyToAccount(generatePrivateKey());
const devPriv = secp256k1.utils.randomPrivateKey();
const devPub = hex(secp256k1.getPublicKey(devPriv, true));
const deviceMsg = (nonce: string) =>
  ["GameVault Device Session", `wallet: ${friend.address}`, `device: ${devPub}`, `at: ${Date.now()}`, `nonce: ${nonce}`].join("\n");
const sigWith = (m: string, priv: Uint8Array) => hex(secp256k1.sign(sha256(new TextEncoder().encode(m)), priv).toCompactRawBytes()).slice(2);
const unpaired = deviceMsg("a".repeat(32));
check("device session refused for an unpaired device", await refused(() => social.openDeviceSession(unpaired, sigWith(unpaired, devPriv))));
devices.upsert(friend.address, { pubkey: devPub, pairedAt: Date.now(), lastSeen: Date.now() });
const paired = deviceMsg("b".repeat(32));
const dev = social.openDeviceSession(paired, sigWith(paired, devPriv));
check("device session opened with the device key (no wallet)", social.authWallet(`Bearer ${dev.token}`).wallet === friend.address.toLowerCase());
const forgedDev = deviceMsg("c".repeat(32));
check(
  "device session refused with another key's signature",
  await refused(() => social.openDeviceSession(forgedDev, sigWith(forgedDev, secp256k1.utils.randomPrivateKey()))),
);

// Friends + chat
check("chat refused between non-friends", await refused(() => social.sendMessage(owner.address, friend.address, { text: "salut" })));
await social.friendAction(owner.address, "request", friend.address);
await social.friendAction(friend.address, "accept", owner.address);
const msg = social.sendMessage(owner.address, friend.address, { text: "Tu me prêtes Runner ?" });
const thread = social.chatThread(friend.address, owner.address, 0);
check("message delivered in the friend's thread", thread.length === 1 && thread[0].id === msg.id);
check("unread counter for the recipient", social.chatSummary(friend.address)[0]?.unread === 1);
social.markRead(friend.address, owner.address, msg.id);
check("read receipt clears the counter", social.chatSummary(friend.address)[0]?.unread === 0);
social.setPresence(friend.address, "2");
check("presence: playing edition #2", social.presenceOf(friend.address).state === "playing");
check("activity records the friendship", social.getProfile(owner.address).activity.some((a) => a.kind === "friend"));

console.log(failures === 0 ? "\nAll checks passed — ticketd issuance and social layer are sound." : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
