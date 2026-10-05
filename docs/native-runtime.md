# Évolution : jeux natifs (.exe) lancés hors du launcher

> Préparé le 2026-10-05. Objectif : un jeu peut être un exécutable natif
> lancé comme processus séparé, vérifié par empreinte et suivi par le
> launcher — au lieu du bundle HTML joué dans la webview.

## 1 · La vérité d'architecture à accepter d'abord

Le modèle actuel promet « le build déchiffré ne touche jamais le disque »
— tenable uniquement parce que la webview consomme des octets servis
depuis la RAM. **Windows ne peut exécuter un .exe que depuis le disque.**
L'évolution remplace donc cette garantie par celle de Steam :

- *au repos* : seul `build.enc` (chiffré) vit sur la cartouche ;
- *au lancement* : déchiffrement → écriture transitoire vérifiée →
  exécution → suppression à la sortie ;
- *l'application de la propriété se fait AU LANCEMENT* (ticket + ownerOf),
  pas par l'inaccessibilité des octets. Cohérent avec notre positionnement
  « ownership verification, not DRM ».

Les deux runtimes coexistent : `meta.json` gagne `runtime: "html" | "exe"`
(défaut `"html"` — zéro régression pour Runner/Snake).

## 2 · Chaîne d'intégrité (le « checksum » demandé)

Rien à ajouter on-chain pour la v1 — la chaîne existante suffit :

1. `buildCid` + `buildHash` on-chain ⇒ `build.enc` téléchargé est le bon
   (déjà vérifié par `fetchBuild`).
2. AES-256-GCM est **authentifié** : un déchiffrement qui aboutit prouve
   que le plaintext est exactement celui chiffré par le studio (tag GCM).
3. Donc : l'exe écrit sur disque juste après déchiffrement est authentique
   par construction. On re-hash quand même le fichier écrit avant `spawn`
   (sha256 en Rust, comparé au hash du buffer déchiffré) pour attraper
   toute altération disque/antivirus entre écriture et exécution.
4. Jamais de cache d'exe entre sessions en v1 : re-déchiffrement à chaque
   lancement (quelques centaines de ms). Un cache viendra avec un manifeste
   local signé si le besoin de vitesse apparaît.

## 3 · Cycle de vie du processus (Rust, `launcher/src-tauri`)

Nouvelles commandes :

- `launch_native(mount_point) -> pid`
  1. lire ticket + `build.enc` (comme `play_game`)
  2. unwrap ECIES (keystore) → déchiffrer en mémoire
  3. écrire `%LOCALAPPDATA%\GameVault\run\<tokenId>-<nonce>\game.exe`
     (dossier créé avec ACL restreinte à l'utilisateur courant)
  4. re-hash du fichier écrit == hash du buffer, sinon abort + cleanup
  5. `std::process::Command::spawn`, garder le `Child` dans l'état géré
  6. thread de surveillance : à la sortie du processus → event Tauri
     `native-exited { code, seconds }` + suppression du dossier run
- `stop_native()` — kill du Child (bouton EJECT)
- `native_status()` — pid/uptime pour l'UI
- Balayage au démarrage de l'app : purge des dossiers `run\*` orphelins
  (crash antérieur).

**Suivi pendant la partie** : le launcher garde son contrôle hybride —
re-check `ownerOf` toutes les 5 min pendant qu'un processus natif tourne ;
en cas de revente détectée : notification + terminaison du processus
(configurable ; pour la démo : on termine — la révocation en direct
devient spectaculaire même en pleine partie).

**Playtime** : la session du playlog se mesure spawn→exit du processus
(plus fiable que la session webview actuelle, survit au crash du jeu).

## 4 · Côté UI (TS)

- `detailView` : PLAY branche sur `meta.runtime` — `"exe"` → cinématique
  identique (les étapes réelles restent VERIFY/DECRYPT/BOOT) puis
  `launch_native` ; l'écran affiche « EN COURS · PID … · depuis HH:MM »
  avec EJECT au lieu de monter l'iframe.
- Événements `native-exited` → clôture playlog + retour fiche + stats.

## 5 · Côté publication (studio)

- `/studio` accepte `.exe` en plus de `.html` (le renifleur de format
  route : HTML autonome → runtime html ; PE (`MZ` magic) → runtime exe ;
  tout le reste refusé).
- v1 : exe **mono-fichier** uniquement. Multi-fichiers (assets) = v2 avec
  archive zip + extraction (même pipeline, hash sur l'archive).
- `meta.json` écrit à l'installation porte `runtime`.

## 6 · Risques à assumer (à lire avant d'implémenter)

- **Surface malware** : une marketplace d'exécutables natifs non sandboxés
  distribue du code arbitraire. Mitigations par étapes : v1 avertissement
  explicite à l'achat/installation ; v2 exigence de signature de code par
  studio (certificat) vérifiée au lancement ; v3 AppContainer/sandbox.
- **SmartScreen/Defender** : exe non signé fraîchement écrit → warnings
  Windows probables au premier spawn. Documenter ; la signature (v2) les
  résout.
- **Le vendeur technique** garde la même limite qu'aujourd'hui (clé
  extraite avant revente) — inchangé, déjà assumé publiquement.

## 7 · Ordre d'implémentation proposé

1. `runtime` dans meta + renifleur de /studio + refus propre (petit)
2. Rust : `launch_native` + cleanup + events (cœur)
3. UI : branchement PLAY + état EN COURS + playlog sur events
4. Surveillance ownerOf pendant la partie + kill-on-revocation
5. v2 : zip multi-fichiers, signature studio, cache manifesté

Questions ouvertes avant de coder : faut-il tuer le processus à la
revente (démo) ou seulement notifier ? Un jeu de test .exe à prévoir
(ex. : build Tauri/Godot minimal) pour la première édition native.
