# TODO — GameVault (refonte 2026-10-06)

L'ancien TODO (2026-07-23) est soldé : contrats déployés sur Base Sepolia,
publish studio → IPFS → on-chain, re-download vérifié, revente + révocation
live, catalogue on-chain, runtime natif .exe (spawn/track/kill-on-resale),
nouvelle UI home/shelf/store. Ci-dessous : ce qui reste, par priorité.

## P1 — Amis & prêt de jeux — ✅ LIVRÉ 2026-10-07 (reste : UX de fête)

FAIT : FriendRegistry + GameLicense ERC-4907 (lend/endLoan gardés : amitié
mutuelle ≥ 3 j, ≤ 14 j, cooldown 24 h, 16 amis max, revente tue le prêt),
28 tests forge verts, déployés (full reset, bloc 47799215). ticketd sert
l'EMPRUNTEUR et refuse le propriétaire pendant le prêt ; le launcher
accepte userOf au check hybride + écran AMIS (navbar) ; web /friends
(demandes, prêts, retours). RESTE :
- [ ] L'animation « au revoir Pokéball » + son du prêt (moment signature)
- [ ] Bannière « PRÊTÉE À 0x… · J-x » sur la fiche d'une licence prêtée
- [ ] Événements FriendRegistry/UpdateUser dans le subgraph (P3)

Le pitch : « prête ta cartouche » mais en numérique — un ami emprunte ta
licence, TU perds l'accès pendant le prêt (comme une vraie cartouche, comme
Steam Family). C'est la règle anti-abus n°1 : un prêt n'est jamais une
duplication.

### Contrats
- [ ] `FriendRegistry.sol` : `request(addr)` / `accept(addr)` →
      `friendsSince[a][b] = block.timestamp` (mutuel), `remove(addr)`.
      Événements pour le subgraph : FriendRequested, FriendsSince, Unfriended.
- [ ] `GameLicense.sol` : adopter **ERC-4907** (`setUser(tokenId, user,
      expires)`, `userOf`, `userExpires`) — le stretch prévu depuis le début.
- [ ] Garde anti-abus dans `setUser` (ou un `LendingManager`) :
      - amitié **mutuelle depuis ≥ 3 jours** (`friendsSince + 3 days <= now`)
      - **1 emprunt actif max par token** (natif ERC-4907 : un seul user)
      - durée de prêt bornée (ex. 14 j max), **cooldown 24 h** entre deux
        prêts d'un même token (anti « location commerciale » en rotation)
      - plafond d'amis éligibles au prêt (ex. 8, façon Steam Family)

### Règle « 3 jours » — avis
Bon instinct, mais insuffisante seule : on peut créer 50 « amis » jetables
aujourd'hui et tous les servir dans 3 jours. Elle devient solide combinée au
reste : délai (anti-impulsion Sybil) + plafond d'amis (anti-ferme) +
cooldown (anti-rotation) + perte d'accès du prêteur (anti-duplication).
Les quatre ensemble rendent le prêt commercial non rentable sans gêner
l'usage réel entre amis.

### Ticketd + launcher
- [ ] ticketd : autoriser le ticket si signer == `ownerOf` **ou**
      (`userOf` && `userExpires > now`) ; `expiresAt` du ticket =
      min(TTL 30 j, fin du prêt).
- [ ] ticketd : REFUSER le ticket au propriétaire pendant un prêt actif
      (le prêteur perd l'accès — la règle cartouche).
- [ ] launcher : check hybride élargi (`ownerOf`/`userOf`), bannière
      « PRÊTÉ À 0x… · J-x » sur la fiche, et fin de prêt = même traitement
      que la revente (kill du process natif, ERR 0x52 réutilisable).
- [ ] web : page /friends (demandes, compteur J-3, bouton PRÊTER depuis la
      fiche d'une licence possédée).

## P2 — Full reset — ✅ FAIT 2026-10-07 (avec P1)
Nouvelles adresses dans deployments.ts (+friendRegistry) ; éditions
republiées : 1 Snake, 2 Runner, 3 Native Runtime Test (Witcheur cassée
disparue) ; tokens #1 (runner) et #2 (native) mintés au wallet dev. RESTE :
- [ ] Régénérer la Pinata JWT et la clé dev (ont transité en clair) —
      avant toute démo publique
- [ ] Réécrire la carte SD physique via le launcher (install + pair)
- [ ] BLURBS/GENRES de registryCatalog à reclaver sur les nouvelles éditions

## P2bis — Sécurité : chantiers structurels de l'audit (docs/audit-2026-10-07.md)
Les correctifs rapides sont faits ; restent les décisions/chantiers :
- [x] `/publish` signé par le wallet du studio + clé liée au studio (2026-10-07)
- [x] Séparer les clés (tickets / attestations rotatable / admin + frais),
      ancienne clé sans rôle (2026-10-07, bloc 47811332)
- [ ] Régénérer le JWT Pinata (dashboard Pinata — a transité en clair) ;
      déplacer ADMIN_PRIVKEY (contracts/.env) vers un wallet matériel/multisig
- [ ] Registre d'appareils par licence (1-2 actifs) + TTL ticket réduit
- [ ] Vérification du ticket EN RUST avant déchiffrement / spawn
- [ ] Persistance sérieuse (SQLite) : nonces, écritures atomiques, clés de
      contenu chiffrées au repos + sauvegarde
- [ ] Runtime natif : Authenticode + studios vérifiés
- [ ] Dépendances : monter `next`, `npm audit fix`, lockfile sur le registre
      officiel ; `tsc` strict + CI pour ticketd/shared/station
- [ ] Contrats (prochain redéploiement) : pull payments (K4) — K3, K5, K6 faits

## P3 — Subgraph : déployer pour de vrai
- [ ] Subgraph Studio base-sepolia : adresses + startBlock → deploy
- [ ] NEXT_PUBLIC_SUBGRAPH_URL → /provenance/[tokenId] passe au réel
- [ ] Bibliothèque complète dans le launcher via subgraph (licences
      possédées sans cartouche insérée)

## P4 — Achat in-launcher (WalletConnect)
- [ ] BUY dans le launcher → approbation sur téléphone (style Steam Guard),
      plus de détour navigateur

## P5 — Runtime natif v2
- [ ] Multi-fichiers : archive zip (hash sur l'archive, extraction dans le
      run dir, spawn du binaire déclaré)
- [ ] Signature de code studio vérifiée au lancement (répond aussi à
      SmartScreen/Defender)
- [ ] Cache d'exe entre sessions avec manifeste local signé (si le besoin
      de vitesse apparaît)

## P6 — Finitions UI / hygiène
- [ ] Mode développeur (réglage) : masquer complètement CID/hash/ticket —
      aujourd'hui repliés dans l'accordéon DONNÉES TECHNIQUES
- [ ] Store web : onglets À LA UNE / OCCASIONS / STUDIOS de la maquette
      (la home a déjà hero + rangées + occasions)
- [ ] Écran natif pendant le jeu : artwork plein écran + stats live
      (actuel : fonctionnel mais spartiate)
- [ ] Masquer l'édition #3 cassée du catalogue en attendant le full reset

## Idées plus tard
0G storage swap (1 fichier : shared/storage.ts) · World ID gating si besoin
réel · pochettes SD imprimées · provenance embarquée dans le launcher ·
wishlist + notifs de baisse de prix sur le store
