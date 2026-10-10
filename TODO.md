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
- [x] UpdateUser (prêts) indexé dans le subgraph (2026-10-08) — l'amitié est off-chain

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
- [x] Pinata JWT régénérée, droits minimaux (2026-10-08). La clé dev (0xAD5B,
      transitée en clair) ne paie plus que le gaz testnet
- [x] Carte SD réappairée (licence #2 transférée au wallet 0xbDdE, 2026-10-08)
- [ ] BLURBS/GENRES de registryCatalog à reclaver sur les nouvelles éditions

## P2bis — Sécurité : chantiers structurels de l'audit (docs/audit-2026-10-07.md)
Les correctifs rapides sont faits ; restent les décisions/chantiers :
- [x] `/publish` signé par le wallet du studio + clé liée au studio (2026-10-07)
- [x] Séparer les clés (tickets / attestations rotatable / admin + frais),
      ancienne clé sans rôle (2026-10-07, bloc 47811332)
- [x] JWT Pinata régénéré (2026-10-08)
- [ ] Déplacer ADMIN_PRIVKEY (contracts/.env) vers un wallet matériel/multisig
- [x] Registre d'appareils : 2 actifs max par compte (2026-10-07)
- [ ] Décider : raccourcir la fenêtre hors ligne (30 j) ? limite le temps de jeu
      d'un appareil déconnecté qui reste hors ligne
- [x] Vérification du ticket EN RUST avant déchiffrement / spawn (2026-10-07)
- [x] Persistance SQLite : nonces, transactions, clés de jeux chiffrées au
      repos, sauvegarde (2026-10-07)
- [x] KEYSTORE_MASTER_KEY sauvegardée (gestionnaire de mots de passe), copies
      EN CLAIR des clés supprimées après vérification 5/5 (2026-10-08)
- [ ] Runtime natif : Authenticode + studios vérifiés
- [x] Dépendances : Next 15.5 + React 19, lockfile registre officiel (2026-10-08)
- [x] `tsc` strict (shared/ticketd/station) + CI GitHub Actions (2026-10-08)
- [ ] wagmi 3 : NON nécessaire pour l'instant (RainbowKit 2.2.11 ne le supporte
      pas) ; uuid réglé par override. Reste decode-uri-component (DoS client
      sur URI WalletConnect forgée, modérée) → à revoir quand RainbowKit suit
- [x] Pull payments Marketplace (K4) — Marketplace seul redéployé (2026-10-08)
- [ ] Prochain full reset : même repli pull pour la vente primaire (GameLicense.buy)
- [x] FULL RESET v1.1 — ✅ FAIT 2026-10-08 (bloc 47862131, subgraph 0.3.0).
      Catalogue republié avec les MÊMES CID (clés ticketd inchangées),
      licences #1 (dev), #2 et #3 (0xbDdE) re-mintées ; carte SD à réappairer :
      - COMMISSION 8 % sur la vente neuve (GameLicense.PRIMARY_FEE_BPS,
        studio 92 %). Repères : Steam 30 %, Epic 12 % (0 % sous 1 M$/an),
        itch.io 10 % par défaut.
      - REVENTE FACULTATIVE par édition (choix du studio, gravé à la
        création) : createEdition(..., royaltyBps, resellable, ...). Sans
        revente : transferts refusés, Marketplace.list refusé, prêt OK,
        royalty forcée à 0. Avec revente : royalty libre de 0 à 20 %.
        Formulaire /studio, /trade, fiche jeu, launcher (SELL masqué) et
        subgraph (Edition.resellable) suivent.
      NON inclus, repoussés au reset suivant : le repli pull de la vente
      neuve (ligne au-dessus) et le PRÊT STUDIO (ligne en dessous).
- [ ] Prochain full reset : PRÊT STUDIO — le propriétaire d'un studio prête les
      licences de SES éditions sans l'âge d'amitié de 3 jours (GameLicense.lend :
      exemption si msg.sender == owner du studio de l'édition). Durée max et
      repos conservés. Plafond d'amis studio déjà à 500 (ticketd, 2026-10-08).
      Alternative sans contrat : édition gratuite (prix 0) pour démos/presse.
- [x] Subgraph sur les adresses actuelles (2026-10-08)

## P2ter — Ménage 2026-10-08 ✅ (inventaire complet → docs/reference.html)
Bugs corrigés (avatar 404, confirmations trop tôt, annonces périmées,
crash ticketd sur URL malformée), code mort retiré (station/, fixtures,
HANDOFF.md). Restent des DÉCISIONS de conception :
- [x] Révocation en cours de partie pour les jeux web ET natifs, toutes les
      20 s (v1 #1, 2026-10-08)
- [x] Session SIWE non revérifiée au lancement : ACCEPTÉE comme limite v1
      (preuve de propriété à l'appairage, clé d'appareil ensuite)
- [x] Script de remise à zéro de la démo : npm run demo -w @gamevault/ticketd
      (v1 #2, 2026-10-08)
- [ ] v1 #3 : vidéo de démo · v1 #4 : tag v1.0
- [ ] Signer /profile/playstat (cosmétique)
- [ ] Lire 3 j / 24 h / 85-10-5 sur le contrat au lieu du texte en dur

## P3 — Subgraph : ✅ DÉPLOYÉ 2026-10-08 (Goldsky, gamevault/0.2.0, tag prod)
- [x] Déployé sur Goldsky (Studio : compte bloqué ; Alchemy Subgraphs fermé)
- [x] /provenance/[tokenId] branché (SUBGRAPH_URL dans shared/deployments.ts)
- [x] Liens vers /provenance : fiche launcher, /trade, /friends, achat neuf (2026-10-08)
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

## P7 — Backlog launcher & plateforme (listé avec Helder le 2026-10-10)

Priorités pour le POC : **A** = à faire pour le POC (court, visible, sans
contrat), **B** = si le temps le permet, **C** = après le POC (demande une
décision de conception, un redéploiement ou une infra en plus).
« Déjà là » = ce qui existe en partie.

### Notifications
- [x] **A** (2026-10-10) Toasts en bas à droite : jeu téléchargé, message d'un ami, carte
      insérée / retirée, appareil déconnecté du compte depuis une autre
      machine. Déjà là : toasts carte et chat, à unifier.
- [x] **A** (2026-10-10) Notifications SUR LE BUREAU façon Steam (fenêtre AURA-64
      en bas à droite, au-dessus des autres logiciels) ; dans le launcher, le
      widget SLOT A entre en scène pour la carte.
- [x] **A** (2026-10-10) Se déconnecter (Réglages) : oublie la session du compte sur cette
      machine ; la clé de la machine reste, la carte aussi.
- [x] **A** (2026-10-10) Choisir sa page de démarrage (Accueil, Game Shelf, Amis,
      Téléchargements).
- [x] **A** (2026-10-10) Lancer AURA-64 au démarrage de Windows (option : directement dans
      la zone de notification).

### Téléchargements
- [x] **A** (2026-10-10) Limiter la vitesse de téléchargement.
- [x] **A** (2026-10-10) Autoriser ou non les téléchargements pendant une partie (défaut :
      pause automatique pendant le jeu, reprise après).
- [x] **B** (2026-10-10) Mode faible bande passante (téléchargement plafonné, moins de
      requêtes réseau, visuels allégés).
- [x] **B** (2026-10-10) Vider le cache : téléchargements interrompus, listes de morceaux,
      données du webview. Les jeux installés ne sont pas touchés.
- [ ] **C** Choisir sa région de téléchargement : utile seulement avec
      plusieurs serveurs (aujourd'hui un serveur + IPFS).
- [ ] **C** Mises à jour des jeux : planifiées, automatiques, visibles dans
      Téléchargements. Demande d'abord un modèle de versions : une édition
      porte aujourd'hui un seul build, figé on-chain → il faut que le studio
      puisse publier une nouvelle version d'une édition (contrat v1.2), les
      licences restant valides. La réparation par morceaux sert aussi aux
      mises à jour (seuls les morceaux changés se téléchargent).

### Game Shelf
- [x] **A** (2026-10-10) Vue Stockage : dossiers de jeux, taille de chaque jeu, où il est
      (PC ou carte), espace libre.

### Accessibilité
- [x] **A** (2026-10-10) Échelle de l'interface (90 % à 150 %).
- [x] **A** (2026-10-10) Réduction des mouvements et des effets étendue : plus de
      flash, de glitch ni d'animation clignotante (photosensibilité).
      Déjà là : le réglage « réduire les animations ».
- [x] **B** (2026-10-10) Modes daltonisme : palettes adaptées, et des états qui ne
      reposent jamais sur la couleur seule (icône ou texte en plus).

### Son
- [x] **B** (2026-10-10) Volumes séparés : interface, notifications, cinématiques,
      chacun multiplié par le volume global.

### Magasin
- [x] **B** (2026-10-10) Liste de souhaits, privée (ticketd) : cœur dans le launcher
      (fiche, aperçu, filtre SOUHAITS du shelf) et sur le web (page du jeu,
      Mon profil). Le prix neuf est figé on-chain → une « baisse » = une
      occasion sous le dernier prix vu : toast SOUHAITS dans le launcher.
- [ ] **C** Filtrage des contenus adultes : il faut d'abord une classification
      déclarée par le studio à la publication (PEGI / âge minimum), stockée
      avec l'édition ; filtre activé par défaut.

### Comptes & connexion
- [x] **B** (2026-10-10) Confidentialité du profil : public, amis, privé, par
      section (profil, présence, activité, bibliothèque). ticketd filtre selon
      qui regarde (session envoyée si elle existe) ; réglages dans le launcher
      et dans Mon profil. Dit clairement : la propriété des licences reste
      publique on-chain, seule la couche sociale se masque.
- [ ] **C** Plusieurs comptes sur une machine : sélecteur de compte. La clé de
      la machine peut servir à plusieurs comptes ; chaque compte garde sa
      limite de 2 machines.
- [ ] **C** Mode de connexion : signature du wallet (aujourd'hui) ou compte
      (e-mail, social) avec un wallet qui ne sert qu'à signer achats et
      transactions — piste « wallet intégré ». Grosse décision, à préparer.
- [x] Écarté : wallet de paiement pour payer pour quelqu'un d'autre (pas
      utile pour l'instant).
- [x] Écarté : authentification Google Authenticator — la signature du
      wallet est déjà un facteur plus fort.

### Social
- [ ] **C** Captures d'écran en jeu, visibles sur le profil.
- [ ] **C** Enregistrement vidéo des parties.
- [ ] **C** Personnalisation poussée de la page de profil (thème, vitrine,
      badges). Déjà là : profils, contacts, derniers jeux joués, emplacements
      de badges.

### Ordre proposé pour le POC
1. Notifications (toasts + Windows) — le launcher « vit », et ça sert tout le reste.
2. Se déconnecter, page de démarrage, lancement au démarrage de Windows.
3. Vue Stockage dans le Game Shelf.
4. Téléchargements : limite de vitesse, pause automatique pendant une partie.
5. Accessibilité : échelle de l'interface, réduction des effets étendue.
6. Puis les B, dans l'ordre de la liste, selon le temps.

## P8 — Nuit du 2026-10-10 → 11 (validée avec Helder, en autonomie)

Règles de la nuit : commits locaux par chantier, AUCUN push (Helder teste
au réveil, y compris les 5 commits P7 B). ETH de test autorisé avec la clé
de déploiement pour le gros build ; s'il n'y en a pas assez, faire le reste. Chaque chantier : typecheck + tests + exe release reconstruit.
Pas de vérification visuelle possible de mon côté : tout ce qui est UI est
à regarder au réveil. Rapport final dans docs/nuit-2026-10-11.md.

### 1. Profil accessible dans le launcher
- [x] Écran PROFIL (nav + clic sur l'avatar du compte) : avatar, pseudo,
      bio, temps de jeu, derniers jeux, amis, appareils. Édition pseudo /
      bio / avatar directement (session de la machine, pas de wallet).
- [x] Confidentialité et liste de souhaits regroupées là (+ lien vers la
      page publique web).

### 2. Game Shelf = MES jeux
- [x] Le shelf ne montre plus les jeux à acheter (le jeu test à
      0.00001 ETH disparaît) : seulement possédés, sur carte, prêtés,
      empruntés, en vente, souhaités.
- [x] Filtres : TOUS · JOUABLES · SOUHAITS · EN VENTE · PRÊTS.
- [x] Onglet BOUTIQUE dans le launcher (validé) : on navigue dans tout le
      catalogue (neuf + occasions), on souhaite ; un clic sur « acheter »
      ou sur une occasion ouvre la page web d'achat / de mise en vente.

### 3. Chat : sélecteur d'emojis
- [x] Bouton emoji dans la discussion (launcher ET web) : une grille,
      insertion à la position du curseur.

### 4. Retirer les textes « techniques / très IA » du parcours client
- [x] Audit de toutes les phrases affichées (launcher + web) : on retire
      les explications internes (« déchiffré en mémoire depuis la carte,
      la clé ne touche jamais le disque », « règle cartouche : prêter un
      jeu c'est le donner… », etc.). Elles restent UNIQUEMENT dans les
      Paramètres, où elles servent à comprendre.
- [x] Liste des phrases retirées dans le rapport, pour en remettre si besoin.

### 5. Style A « Chanfrein » partout
- [x] Coins coupés à 45° (cartouche) sur boutons, vignettes, bannières,
      panneaux, puces, segments, toasts — launcher, fenêtre des toasts,
      et web (même DA). LED carrées. Le sunset reste réservé à l'achat.
- [x] Skill art-direction mis à jour (formes : chanfrein, plus de pilules).

### 6. Téléchargements
- [x] La vue n'affiche plus les jeux installés : seulement à installer,
      en attente / en cours / en pause, à réparer, et (plus tard) à mettre
      à jour.
- [x] Jeu de test LOURD : un build factice d'~500 Mo généré localement
      (aléatoire déterministe, jamais téléchargé d'internet), qui reste
      jouable (vrai jeu + gros fichier de remplissage). Publié comme une
      vraie édition on-chain (Base Sepolia, clé de déploiement), servi
      par ticketd (/build en Range + manifest de ~125 morceaux), licence
      envoyée sur le wallet de Helder.
- [x] Mode d'emploi du test complet : télécharger, mettre en pause,
      reprendre, couper le réseau, CASSER un morceau (outil dev qui abîme
      des octets de build.enc), VÉRIFIER → réparation des seuls morceaux
      abîmés. Ça teste enfin le parallèle à 4 morceaux et la limite de
      vitesse sur un vrai volume.
- [x] Vérifier que le lancement tient avec 500 Mo déchiffrés en mémoire
      (sinon : le noter, ne pas casser le flux de la démo).

### 7. Infra : Docker, Kubernetes, Ansible (prêt pour du volume)
- [ ] Dockerfiles ticketd + web (multi-stage, utilisateur non-root,
      healthcheck sur /health).
- [ ] Manifests Kubernetes (k8s/) : namespace, Deployments, Services,
      Ingress (TLS cert-manager, rate limiting par IP, taille de requête,
      timeouts longs pour /events SSE et /build), HPA, probes
      liveness/readiness (redémarrage auto d'un conteneur mort),
      PodDisruptionBudget, ressources requests/limits, Secrets/ConfigMap,
      NetworkPolicy.
- [ ] Point dur à dire franchement : ticketd garde un état local (SQLite,
      présence et flux SSE en mémoire). Tant que ce n'est pas migré vers
      Postgres + Redis, ticketd ne peut tourner qu'en 1 réplique (volume
      persistant) ; le web, lui, monte en charge sans limite. Les manifests
      le reflètent ; la migration est écrite en chantier suivant.
- [ ] Builds de jeux volumineux : servis derrière un cache (CDN / objet
      storage) plutôt que par ticketd — noté dans le doc d'archi.
- [ ] Playbook Ansible (deploy/ansible/) : prépare des serveurs (Docker,
      k3s ou cluster existant), pose les secrets depuis un vault, applique
      les manifests, vérifie le déploiement.
- [ ] Validation locale : `kubectl apply --dry-run`, build des images
      Docker, ansible-lint si dispo (WSL). Pas de vrai cluster cette nuit.

### Oublis repérés ce soir (ajoutés)
- [ ] 5 commits locaux P7 B non poussés (57a13b8 → 3e84fa7) : push après
      ton test.
- [x] Repli IPFS jamais testé en vrai : le tester avec le gros build
      (ticketd coupé → morceaux depuis IPFS) si le pin passe (taille
      Pinata), sinon le noter.
- [ ] Petite course connue : un jeu qui se ferme dans la même seconde où un
      téléchargement se met en pause peut laisser le job en pause.
- [ ] « En attente de mise à jour » dans Téléchargements dépend du modèle
      de versions (contrat v1.2, item C) : prévu dans la vue, pas branché.

## Idées plus tard
0G storage swap (1 fichier : shared/storage.ts) · World ID gating si besoin
réel · pochettes SD imprimées · provenance embarquée dans le launcher
