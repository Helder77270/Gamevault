# TODO — GameVault (refonte 2026-10-06)

L'ancien TODO (2026-07-23) est soldé : contrats déployés sur Base Sepolia,
publish studio → IPFS → on-chain, re-download vérifié, revente + révocation
live, catalogue on-chain, runtime natif .exe (spawn/track/kill-on-resale),
nouvelle UI home/shelf/store. Ci-dessous : ce qui reste, par priorité.

## P1 — Amis & prêt de jeux (le prochain gros morceau)

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

## P2 — Full reset (voulu : état propre de bout en bout)
- [ ] Redéployer GameRegistry/GameLicense/Marketplace (+ ERC-4907 +
      FriendRegistry si P1 prêt) → nouvelles adresses dans
      shared/src/deployments.ts
- [ ] Purger ticketd/data, régénérer les clés (la Pinata JWT et la clé dev
      ont transité en clair pendant le dev — à régénérer de toute façon)
- [ ] Republier les éditions saines (runner, snake, native-test) — l'édition
      « The Witcheur » #3 cassée (0 octet) disparaît avec le reset
- [ ] Réécrire dev-media + la carte SD physique (son ticket est expiré
      depuis le 2026-08-23)
- [ ] Redéployer le subgraph sur les nouvelles adresses

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
