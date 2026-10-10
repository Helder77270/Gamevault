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

const { issueTicket, takePendingTicket } = await import("./service.ts"); // after the env flag
// Backends: in memory by default; GAMEVAULT_TEST_BACKENDS=1 runs the same
// checks against DATABASE_URL (Postgres) and REDIS_URL (Redis).
const { initDb } = await import("./db.ts");
const { openLive, closeLive, live } = await import("./live.ts");
const { closeStore, store } = await import("./sql.ts");
const social = await import("./social.ts");
await initDb();
await openLive(social.deliverLocal);
console.log(`backends: db=${store().kind} live=${live().kind}\n`);

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

check("pending ticket handed to the launcher once", (await takePendingTicket(params.nonce))?.tokenId === ticket.tokenId);
check("pending ticket not handed out twice", (await takePendingTicket(params.nonce)) === undefined);

// --- Social v1: sessions, friends, chat ------------------------------------
const { devices } = await import("./db.ts");
const { secp256k1 } = await import("@noble/curves/secp256k1");
const { sha256 } = await import("@noble/hashes/sha256");
const rnd32 = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");

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
check("web session opened by one wallet signature", (await social.authWallet(`Bearer ${web.token}`)).wallet === owner.address.toLowerCase());
check("session replay refused", await refused(async () => social.openWebSession(sessMsg, await owner.signMessage({ message: sessMsg }))));
check("forged token refused", await refused(() => social.authWallet("Bearer not-a-real-token")));

// Launcher session: the device key signs, the device must be paired
const friend = privateKeyToAccount(generatePrivateKey());
const devPriv = secp256k1.utils.randomPrivateKey();
const devPub = hex(secp256k1.getPublicKey(devPriv, true));
const deviceMsg = (nonce: string) =>
  ["GameVault Device Session", `wallet: ${friend.address}`, `device: ${devPub}`, `at: ${Date.now()}`, `nonce: ${nonce}`].join("\n");
const sigWith = (m: string, priv: Uint8Array) => hex(secp256k1.sign(sha256(new TextEncoder().encode(m)), priv).toCompactRawBytes()).slice(2);
const unpaired = deviceMsg(rnd32());
check("device session refused for an unpaired device", await refused(() => social.openDeviceSession(unpaired, sigWith(unpaired, devPriv))));
await devices.upsert(friend.address, { pubkey: devPub, pairedAt: Date.now(), lastSeen: Date.now() });
const paired = deviceMsg(rnd32());
const dev = await social.openDeviceSession(paired, sigWith(paired, devPriv));
check("device session opened with the device key (no wallet)", (await social.authWallet(`Bearer ${dev.token}`)).wallet === friend.address.toLowerCase());
const forgedDev = deviceMsg(rnd32());
check(
  "device session refused with another key's signature",
  await refused(() => social.openDeviceSession(forgedDev, sigWith(forgedDev, secp256k1.utils.randomPrivateKey()))),
);

// Live stream: an SSE stream of the friend receives the chat message
// (through Redis pub/sub when REDIS_URL is used)
const received: string[] = [];
const fakeStream = {
  write: (chunk: string) => {
    received.push(chunk);
    return true;
  },
  on: () => fakeStream,
  end: () => {},
};
social.subscribe(friend.address, fakeStream as never);

// Friends + chat
check("chat refused between non-friends", await refused(() => social.sendMessage(owner.address, friend.address, { text: "salut" })));
await social.friendAction(owner.address, "request", friend.address);
await social.friendAction(friend.address, "accept", owner.address);
const msg = await social.sendMessage(owner.address, friend.address, { text: "Tu me prêtes Runner ?" });
const thread = await social.chatThread(friend.address, owner.address, 0);
check("message delivered in the friend's thread", thread.length === 1 && thread[0].id === msg.id);
check("unread counter for the recipient", (await social.chatSummary(friend.address))[0]?.unread === 1);
await new Promise((r) => setTimeout(r, 300)); // pub/sub round trip
check("live event pushed to the friend's stream", received.some((c) => c.startsWith("event: message") && c.includes("Tu me prêtes Runner")));
await social.markRead(friend.address, owner.address, msg.id);
check("read receipt clears the counter", (await social.chatSummary(friend.address))[0]?.unread === 0);
await social.setPresence(friend.address, "2");
check("presence: playing edition #2", (await social.presenceOf(friend.address)).state === "playing");
check("activity records the friendship", (await social.getProfile(owner.address)).activity.some((a) => a.kind === "friend"));

// Avatar in the database (shared by every replica)
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 7)]);
await social.saveProfile(owner.address, { name: "Selftest", bio: "", favorites: [], avatar: png.toString("base64") });
const av = await social.getAvatar(owner.address);
check("avatar stored in the database and served back", av?.type === "image/png" && av.bytes.length === png.length);

// Wishlist (private, price drop = cheaper copy than the price last seen)
await social.setWish(owner.address, { editionId: "2", priceWei: "10000000000000000" });
await social.setWish(owner.address, { editionId: "2", priceWei: "10000000000000000" });
check("wishlist: adding twice keeps one entry", (await social.wishlistOf(owner.address)).length === 1);
await social.markWishSeen(owner.address, { editionId: "2", priceWei: "8000000000000000" });
check("wishlist: seen price updated after an alert", (await social.wishlistOf(owner.address))[0]?.seenWei === "8000000000000000");
check("wishlist: invalid price refused", await refused(() => social.setWish(owner.address, { editionId: "3", priceWei: "-1" })));
check("wishlist: private to its owner", (await social.wishlistOf(friend.address)).length === 0);
await social.setWish(owner.address, { editionId: "2", on: false });
check("wishlist: removed", (await social.wishlistOf(owner.address)).length === 0);

// Privacy: sections narrowed to friends / nobody; the owner always sees all
const outsider = privateKeyToAccount(generatePrivateKey()).address;
await social.setPrivacy(owner.address, { profile: "friends", presence: "private", activity: "private" });
const asStranger = await social.getProfile(owner.address, outsider);
const asFriend = await social.getProfile(owner.address, friend.address);
check("privacy: a stranger sees no friends list", asStranger.friends.length === 0 && asStranger.friendsCount === null);
check("privacy: a friend sees the friends-only profile", asFriend.friendsCount === 1);
check("privacy: private activity hidden even from friends", asFriend.activity.length === 0 && asFriend.totalSeconds === null);
await social.setPresence(owner.address, null);
check("privacy: invisible presence shows offline to friends", (await social.friendsOf(friend.address, friend.address)).friends[0]?.presence.state === "offline");
check("privacy: the owner still sees everything", (await social.getProfile(owner.address, owner.address)).activity.length > 0);
check("privacy: a stranger cannot read the friends list", (await social.friendsOf(owner.address, null)).friends.length === 0);
check("privacy: invalid level refused", await refused(() => social.setPrivacy(owner.address, { library: "everyone" })));

// Chat rate limit (shared counter)
const limited = await (async () => {
  for (let i = 0; i < 31; i++) {
    try {
      await social.sendMessage(friend.address, owner.address, { text: `spam ${i}` });
    } catch {
      return i;
    }
  }
  return -1;
})();
check("chat rate limit: the 31st message in a minute is refused", limited === 29 || limited === 30);

await closeLive();
await closeStore();
console.log(failures === 0 ? "\nAll checks passed — ticketd issuance and social layer are sound." : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
