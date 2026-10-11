// Prints the PUBLIC key of TICKET_SIGNER_PRIVKEY (from .env or the
// environment) — the value a launcher build profile lists in
// ticketSignerPubKeys (launcher/profiles/*.json). Never prints the secret.
//   npm run signer-pubkey -w @gamevault/ticketd
import { ticketSignerPublicKey } from "./service.ts";

const pub = ticketSignerPublicKey();
if (!pub) {
  console.error("TICKET_SIGNER_PRIVKEY absent : rien à dériver");
  process.exit(1);
}
console.log(pub);
