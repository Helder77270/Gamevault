// Where this launcher build talks to — baked in at build time from
// launcher/profiles/<GAMEVAULT_PROFILE>.json (scripts/profile.mjs, already
// validated there). The Rust core reads the same file through build.rs.

interface BuildProfile {
  name: string;
  ticketdUrl: string; // no trailing slash
  webUrl: string; // no trailing slash
  buildsUrl: string; // ends with "/" — build.enc and its manifest live under it
  rpcUrl: string;
  ipfsGateways: string[];
  ticketSignerPubKeys: string[]; // compressed secp256k1, hex without 0x
  localServices: boolean; // POC: the launcher may start ticketd + the site from the repo
}

declare const __GV_PROFILE__: BuildProfile;

export const PROFILE: BuildProfile = __GV_PROFILE__;
