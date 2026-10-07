# Succès (achievements) — état de l'art et design GameVault

> Statut : **pré-intégration**. Rien n'est câblé dans le launcher, le web ou
> ticketd. Ce document fixe le format et le modèle pour que l'intégration
> future soit mécanique. Code de référence : `shared/src/achievements.ts`
> (types, `validateManifest`, `evaluateUnlocks`, `applyStatIngest`), exemple :
> `docs/examples/achievements.example.json`.

Principe directeur : **ne rien inventer**. Un studio qui a déjà des succès
sur Steam ou Epic doit pouvoir les porter en recopiant ses champs presque
1 pour 1.

---

## 1. Ce que font les plateformes existantes

### 1.1 Tableau comparatif

| Plateforme | Où / comment on définit | Champs de définition | Déclenchement | Progression | Caché | Rareté / grades / points |
|---|---|---|---|---|---|---|
| **Steam** (Steamworks) | Formulaire « App Admin » ; schéma exportable (fichier VDF, que GOG sait importer) ; lecture via Web API `GetSchemaForGame` | API Name, Display Name, Description (localisés), Set By, Hidden?, Achieved Icon, Unachieved Icon, Progress Stat | **Direct** (`SetAchievement`) **ou stat** : un succès lié à une *Progress Stat* se débloque automatiquement quand la stat atteint la valeur cible | Oui, via Progress Stat (barre de progression) ; `IndicateAchievementProgress` n'affiche qu'une notification | Oui (`Hidden?`) | Pas de grades ni de points ; % global de déblocage (`GetAchievementAchievedPercent`) |
| **Steam — stats** | Même écran | API Name, Type (INT / FLOAT / AVGRATE), Set By, Increment Only, Max Change, Min/Max Value, Default Value, Aggregated, Display Name | Le jeu écrit la **valeur absolue** (`SetStat`) ; Steam est la source de vérité | — | — | — |
| **Epic Online Services** | Developer Portal ; **Bulk Import/Export** : archive `.zip` de fichiers `.csv` (stats + succès), modèle téléchargeable | AchievementId, Unlocked/Locked DisplayName, Unlocked/Locked Description, FlavorText, icônes unlocked/locked, IsHidden, **StatThresholds** (liste stat + seuil) | **Direct** (`UnlockAchievements`) **ou seuils de stats** gérés par le service : le client *ingère* des valeurs, le serveur agrège (SUM / MIN / MAX ; LATEST n'est pas utilisable comme seuil) et débloque | Oui (progression calculée sur les seuils) | Oui | Couche « Epic Achievements » du store : XP par succès, paliers bronze / argent / or, platine à 1000 XP |
| **Xbox** (GDK / Partner Center) | Partner Center (config serveur, plus de fichier local dans le package) | Nom, description verrouillée, description déverrouillée (100 car.), image 1920×1080, base / non-base (DLC), Gamerscore 0–200, Public / Secret, deep link, récompenses (art / in-game) | **Title-managed** (recommandé) : appel direct avec un `percentComplete`. **Event-based** (ancien) : événements télémétriques + règles côté serveur | Oui, `percentComplete` 0–100 calculé par le jeu | Oui (Secret) | Gamerscore (1000 pour le jeu de base) |
| **PlayStation** (trophées) | Trophy pack signé (`TROPHY.TRP`, SFM/XML), outillage partenaire sous NDA | id, nom, détail, **grade**, hidden, icône, groupe (DLC), récompense ; PS5 : valeur cible de progression | Direct (le jeu débloque) | PS5 uniquement (`progress_target_value`) | Oui | **Grades bronze / argent / or / platine** (platine = tous les autres) ; rareté commun / rare / très rare / ultra rare selon % de joueurs |
| **Google Play Games** | Play Console, ou **import zip** (`AchievementsMetadata.csv` + localisations + mapping d'icônes) | Id, Name (100 car.), Description (500 car.), Icon, List Order, Points, Incremental + nombre d'étapes, état initial | **Standard** (déblocage en une fois) ou **incrémental** (étapes) | Oui (incrémental) | États : Hidden / Revealed / Unlocked | Points multiples de 5, ≤ 200 / succès, ≤ 2000 / jeu |
| **Apple Game Center** | App Store Connect | Reference Name, Achievement ID (≤ 100 car.), Point Value, Hidden, Achievable More Than Once ; par langue : Display Name, Pre-earned / Earned Description, image 1024×1024 | Direct avec `percentComplete` (`GKAchievement`) | Oui (0–100 %) | Oui | Points ≤ 100 / succès, ≤ 1000 / jeu |
| **Unity Platform Toolkit** (couche multi-plateforme) | Import **CSV** dans l'Achievement Editor | ID universel (≤ 64 car., alphanum + `_`/`-`), `Progress_Target` (1 = simple, > 1 = progressif), ID par plateforme | Déduit de `Progress_Target` | Oui | — | — |

### 1.2 Ce qu'il faut retenir

1. **Il n'existe pas de format fichier universel.** Chaque plateforme a son
   back-office ; les imports en masse sont du CSV zippé (EOS, Google Play,
   Unity) ou du VDF (Steam → GOG). Ce qui *est* universel, c'est le **jeu de
   champs** : identifiant stable, nom + description localisés (souvent une
   variante « verrouillé »), caché oui/non, icône débloquée / verrouillée.
2. **Deux modèles de déclenchement coexistent partout** :
   - *déblocage direct* : le jeu dit « succès X obtenu » ;
   - *seuil de stat* : le jeu remonte des stats, le succès tombe quand la stat
     franchit un seuil (Steam Progress Stat, EOS StatThresholds, Google Play
     incrémental, Xbox event-based, PS5 progression).
3. **Qui agrège la stat** est le vrai choix d'architecture. Steam fait écrire
   la valeur absolue par le client ; EOS fait *ingérer* des valeurs et agrège
   côté serveur (SUM/MIN/MAX/LATEST) ; Xbox title-managed laisse tout au jeu.
   Pour une plateforme où le serveur doit garder la main (GameVault), le
   modèle **EOS** est le plus adapté.
4. **Points / grades** : bronze/argent/or est commun à PlayStation et au store
   Epic ; un plafond de **200 points par succès / 1000 par jeu** est la norme
   Xbox, Epic (XP) et quasi Apple (100 / 1000).
5. **Aucune plateforme ne fait confiance au client par magie** : Steam propose
   `Set By: GS` (serveur de jeu officiel), `Max Change`, `Increment Only`,
   bornes min/max. Ce sont des garde-fous déclaratifs — on les reprend.

---

## 2. Design GameVault recommandé

### 2.1 Le manifeste `achievements.json` (par édition)

Le studio livre, à côté de `build.enc`, un dossier :

```
achievements/
  achievements.json      # le manifeste (schemaVersion 1)
  icons/*.png            # carrées, 256×256 recommandé (le launcher réduit)
```

- **Public, non chiffré** : comme `build.enc`, ce n'est pas un secret, et le
  store web doit pouvoir afficher la liste des succès avant achat.
- **Épinglé sur IPFS** comme un répertoire (un CID couvre manifeste + icônes)
  et **copié sur la cartouche** dans `/gamevault/achievements/` pour le mode
  hors-ligne.
- **Intégrité** : `achievementsCid` + `achievementsHash` (sha256 des octets de
  `achievements.json`), sur le même modèle que `buildCid` / `buildHash`. En
  phase 1 ces deux valeurs vivent dans `meta.json` et dans la config de
  ticketd ; en phase 3 elles rejoignent l'édition dans `GameRegistry`
  (changement de contrat → redéploiement, donc pas maintenant).

Structure (types exacts dans `shared/src/achievements.ts`) :

```jsonc
{
  "schemaVersion": 1,
  "defaultLocale": "fr",
  "stats": [
    { "id": "COINS_COLLECTED", "type": "int", "aggregation": "sum",
      "minValue": 0, "maxChange": 10, "incrementOnly": true }
  ],
  "achievements": [
    { "id": "HOARDER",
      "name": { "fr": "Trésorier", "en": "Hoarder" },
      "description": { "fr": "Ramasser 250 pièces.", "en": "Collect 250 coins." },
      "lockedDescription": { "fr": "…" },            // optionnel
      "hidden": false,
      "icon": "icons/hoarder.png", "iconLocked": "icons/hoarder_locked.png",
      "unlock": { "type": "stat", "thresholds": [{ "stat": "COINS_COLLECTED", "value": 250 }] },
      "grade": "silver", "points": 50, "order": 2 }
  ]
}
```

Choix de schéma :

| Règle | Pourquoi |
|---|---|
| `id` = `[A-Za-z0-9_]{1,64}` | Compatible API Names Steam, IDs EOS, ID universel Unity : on garde **le même identifiant** que sur les autres plateformes. |
| Textes = objets `{ locale BCP-47 : texte }`, `defaultLocale` obligatoire | Toutes les plateformes localisent ; nom ≤ 100 car., description ≤ 500 (limites Google Play). |
| `unlock: { type: "direct" }` ou `{ type: "stat", thresholds: [...] }` | Les deux modèles universels. Plusieurs seuils = **tous** requis (sémantique EOS) ; un seul seuil = Progress Stat Steam. |
| `aggregation`: `sum` / `max` / `min` / `latest` | Modèle EOS. Seuil atteint si valeur ≥ seuil, ou ≤ seuil pour `min` (meilleur temps). `latest` ne peut pas piloter un déblocage (non monotone — même restriction qu'EOS). |
| `minValue`, `maxValue`, `maxChange`, `incrementOnly` | Garde-fous Steam repris tels quels, appliqués **par ticketd** à chaque ingestion. |
| `grade` bronze/silver/gold, `points` 0–200, total ≤ 1000 | Commun PlayStation / Epic / Xbox / Apple. Le « platine » (méta-succès) est reporté. |
| Champs inconnus = erreur, sauf préfixe `x-` | Attrape les fautes de frappe ; `x-flavorText`, `x-lockedName`… pour garder des champs propres à une plateforme sans casser le schéma. |
| `schemaVersion: 1` | Toute évolution incompatible incrémente la version ; le launcher refuse ce qu'il ne connaît pas. |

### 2.2 Déclenchement et remontée des événements

```
Jeu (Phaser, webview)            Launcher (Rust)                       ticketd
---------------------            ---------------                       -------
gamevault.achievements           valide vs manifeste local
  .ingestStat(id, valeur)  --->  journal local signé (clé device) ---> POST /achievements/events
  .unlock(id)                    toast immédiat (hors-ligne OK)        vérifie, agrège, débloque
```

1. **API côté jeu** : un objet `window.gamevault.achievements` injecté par le
   launcher, avec `ingestStat(statId, value)` et `unlock(achievementId)`. Si
   l'objet est absent (jeu lancé hors GameVault), les appels sont des no-op :
   le jeu n'en dépend jamais.
2. **Launcher** : valide chaque appel contre le manifeste de la cartouche
   (id connu, bornes), calcule localement avec `applyStatIngest` +
   `evaluateUnlocks` pour afficher la notification **même hors-ligne**, et
   ajoute l'événement à un **journal append-only** stocké sur la machine (pas
   sur la cartouche : les succès appartiennent au joueur, pas à la copie).
   Chaque lot est signé par la **clé device** déjà appairée via SIWE.
3. **Synchronisation** (dès que le réseau revient, comme le refresh de
   ticket) : `POST /achievements/events` avec
   `{ tokenId, contract, chainId, devicePubKey, events[], deviceSig }`, chaque
   événement portant un numéro de séquence et un horodatage.
4. **ticketd** est la source de vérité :
   - vérifie la signature device et que ce device est appairé au
     propriétaire du ticket (même logique que `POST /ticket`) ;
   - déduplique par `(devicePubKey, seq)` — rejouer le journal est sans effet ;
   - replie chaque valeur avec `applyStatIngest` (rejette ce qui viole
     `maxChange`, `incrementOnly`, `min/maxValue`) ;
   - évalue `evaluateUnlocks` et accepte les déblocages directs ;
   - stocke par **(adresse du joueur, jeu)**, pas par `tokenId`. Toutes les
     éditions d'un même jeu doivent donc partager les mêmes ids (une édition
     peut en ajouter, jamais en redéfinir).
5. **Revente** : l'acheteur repart de zéro, le vendeur garde son palmarès —
   exactement le comportement d'un compte Steam/PSN. Les succès ne suivent
   pas la cartouche.
6. **Rareté** : ticketd peut calculer le % de joueurs ayant débloqué chaque
   succès (équivalent `GetGlobalAchievementPercentages` / rareté PSN). Plus
   tard.

### 2.3 Anti-triche : ce qu'on peut et ne peut pas garantir

Soyons honnêtes : **dans un produit hors-ligne d'abord, tout événement de jeu
est déclaré par le client.** Il n'y a pas de serveur de jeu qui observe la
partie (l'équivalent du `Set By: GS` de Steam n'existe pas chez nous).

Ce que le design garantit :
- l'événement vient **d'un device appairé par le propriétaire du jeu** (clé
  device dans le keystore, liée par SIWE) — on ne peut pas créditer le compte
  de quelqu'un d'autre ni injecter des événements depuis un script anonyme ;
- les **garde-fous déclaratifs** du studio sont appliqués côté serveur
  (`maxChange`, `incrementOnly`, bornes : un « meilleur temps » de 0,5 s est
  rejeté si `minValue` vaut 3000 ms) ;
- le serveur **agrège lui-même** (modèle EOS) : le client ne peut pas écrire
  directement « COINS_COLLECTED = 1 000 000 » si la stat est en `sum` avec
  `maxChange: 10`.

Ce qu'il ne garantit pas :
- qu'une partie a réellement eu lieu : le build déchiffré tourne en mémoire,
  un joueur technique peut le modifier ou appeler l'API à la main ;
- l'horodatage : l'horloge d'une machine hors-ligne est falsifiable ;
- la fenêtre de grâce : un vendeur qui joue hors-ligne pendant les 30 jours
  de validité de son ticket peut encore générer des événements après la
  vente (rejet possible plus tard en comparant avec le bloc du `Transfer` via
  le subgraph).

Conséquences de design :
- les succès restent **cosmétiques** : aucune valeur économique, jamais
  transférables, jamais conditions d'accès à un actif payant — c'est ce qui
  retire l'incitation à tricher ;
- côté serveur on **signale** (flag) les incohérences plutôt que de bannir ;
- c'est la même posture que pour la licence : *vérification, pas DRM*.

### 2.4 Portabilité (optionnelle, plus tard)

Deux couches complémentaires, aucune nécessaire pour la v1 :

- **Open Badges 3.0** (1EdTech, aligné sur les W3C Verifiable Credentials 2.0) :
  export d'un succès débloqué en `AchievementCredential`. Mapping direct :
  `Achievement.id/name/description/image` ← notre définition,
  `criteria.narrative` ← description, `creator` ← studio, émetteur ← GameVault,
  `credentialSubject.id` ← identifiant du joueur (par ex. un DID `did:pkh`
  dérivé de l'adresse). Preuve : Data Integrity (`eddsa-rdfc-2022`) ou VC-JWT
  — à trancher, avec une **clé dédiée**, pas la clé plateforme qui signe les
  tickets. Avantage : vérifiable hors chaîne, sans gas, lisible par des
  portefeuilles de badges existants.
- **Badge on-chain non transférable** : **ERC-5192** (Minimal Soulbound,
  statut *Final*) — un ERC-721 dont `locked(tokenId)` renvoie `true` et dont
  les transferts échouent, frappé **à la demande du joueur** (claim) pour les
  succès qui le méritent (or, 100 %). **ERC-5114** (Soulbound Badge) lie un
  badge à un *autre NFT* plutôt qu'à une adresse : appliqué à la licence, le
  badge suivrait la cartouche à la revente (« cette copie a fini le jeu ») —
  idée amusante pour la page de provenance, mais contraire au principe « les
  succès appartiennent au joueur », et l'EIP n'est pas finalisé (resté en
  *Last Call* en 2023). Recommandation : ERC-5192 pour le joueur, ERC-5114
  seulement si on veut un jour un historique de copie.

---

## 3. Mapping depuis Steam

| Steamworks | GameVault | Remarque |
|---|---|---|
| Achievement **API Name** | `achievements[].id` | Identique (même charset). |
| **Display Name** (par langue) | `name` | Langues Steam (`english`, `french`…) → BCP-47 (`en`, `fr`). |
| **Description** | `description` | — |
| **Hidden?** | `hidden` | — |
| **Achieved Icon** / **Unachieved Icon** | `icon` / `iconLocked` | Copier dans `icons/`. |
| **Progress Stat** + valeur cible | `unlock: { type: "stat", thresholds: [{ stat, value }] }` | Sans Progress Stat → `{ type: "direct" }`. |
| **Set By** (Client / GS) | — | Pas de serveur de jeu : tout passe par ticketd (voir §2.3). |
| Stat **API Name** | `stats[].id` | Identique. |
| Stat **Type** INT / FLOAT | `type: "int"` / `"float"` | **AVGRATE** non supporté (pas de seuil possible) ; au besoin `float` + `latest`. |
| **Increment Only** | `incrementOnly` | — |
| **Max Change** | `maxChange` | — |
| **Min Value** / **Max Value** / **Default Value** | `minValue` / `maxValue` / `defaultValue` | — |
| **Aggregated** | — | Les agrégats globaux seront calculés par ticketd. |
| `SetStat(valeur absolue)` | `aggregation: "max"` + `ingestStat(valeurAbsolue)` | Portage **sans toucher au code de jeu** pour un compteur monotone ; idempotent. Pour bénéficier de `maxChange`, passer en `sum` et remonter des deltas. |
| `SetAchievement(id)` | `unlock(id)` | — |

Source pratique : l'export VDF du schéma Steam (celui qu'importe GOG) ou
`GetSchemaForGame` (champs `name`, `displayName`, `description`, `hidden`,
`icon`, `icongray`, `defaultvalue`) suffisent pour écrire un convertisseur.

## 4. Mapping depuis EOS

| EOS | GameVault | Remarque |
|---|---|---|
| **AchievementId** | `achievements[].id` | Identique. |
| **UnlockedDisplayName** | `name` | — |
| **UnlockedDescription** | `description` | — |
| **LockedDescription** | `lockedDescription` | — |
| **LockedDisplayName** | `x-lockedName` (extension) | Pas d'équivalent Steam ; conservé tel quel. |
| **FlavorText** | `x-flavorText` (extension) | Idem. |
| Unlocked / Locked **icon** | `icon` / `iconLocked` | — |
| **IsHidden** | `hidden` | — |
| **StatThresholds** `[{ Name, Threshold }]` | `unlock.thresholds [{ stat, value }]` | Même sémantique « tous requis ». |
| Stat **Name** | `stats[].id` | — |
| Stat **Aggregation** SUM / MIN / MAX / LATEST | `aggregation` `sum` / `min` / `max` / `latest` | 1:1. `IngestStat` ↔ `ingestStat`. |
| Epic Achievements **XP** et palier | `points` et `grade` | Mêmes plafonds (200 / 1000). |

Source pratique : l'archive **Bulk Export** (zip de CSV) du Developer Portal
EOS se convertit ligne à ligne.

---

## 5. Plan par phases

| Phase | Contenu | Touche |
|---|---|---|
| **0 — fait** | Ce document ; types + `validateManifest` + `evaluateUnlocks` + `applyStatIngest` dans `shared/src/achievements.ts` (non exporté du package) ; manifeste exemple « GameVault Runner ». | `docs/`, `shared/` |
| **1 — pré-intégration légère** | `station/publish` valide et épingle `achievements/` si présent, écrit CID + hash dans `meta.json`, copie sur la cartouche. Launcher : affiche la liste (verrouillés / cachés) depuis la cartouche ; API `window.gamevault.achievements` en no-op journalisé. Exporter le module dans `shared/package.json`. | station, launcher, shared |
| **2 — boucle complète** | Journal local signé par la clé device ; `POST /achievements/events` + tables dans ticketd ; toasts in-game ; page profil web avec succès et % de rareté. Brancher 3 succès dans GameVault Runner pour la démo. | launcher, ticketd, web, game |
| **3 — ancrage** | `achievementsCid` / `achievementsHash` dans l'édition `GameRegistry` (redéploiement) ; entités subgraph ; convertisseurs `steam-vdf → achievements.json` et `eos-zip → achievements.json` ; rejet des événements postérieurs à un `Transfer`. | contracts, subgraph, station |
| **4 — portabilité** | Export Open Badges 3.0 ; claim ERC-5192 opt-in pour certains succès ; méta-succès « platine ». | ticketd, contracts, web |

---

## Sources

Steam
- [Steamworks — Stats and Achievements](https://partner.steamgames.com/doc/features/achievements)
- [Steamworks — Step by Step: Stats](https://partner.steamgames.com/doc/features/achievements/stats_guide)
- [Steamworks — ISteamUserStats (SDK)](https://partner.steamgames.com/doc/api/ISteamUserStats)
- [Steamworks — ISteamUserStats (Web API, GetSchemaForGame)](https://partner.steamgames.com/doc/webapi/ISteamUserStats)
- [GOG — Importing achievements from Steam (VDF)](https://docs.gog.com/sdk-steam-import/)

Epic
- [EOS — Achievements Interface Reference](https://dev.epicgames.com/docs/epic-online-services/player-and-game-data/achievements-interface/achievements-reference)
- [EOS — Tool: Bulk Import / Export](https://dev.epicgames.com/docs/epic-online-services/eos-fundamentals/tools/bulk-importer-exporter-tool)
- [Unreal — FAchievementDefinition](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/OnlineServicesInterface/FAchievementDefinition)
- [Unreal — FAchievementStatDefinition](https://dev.epicgames.com/documentation/unreal-engine/API/Plugins/OnlineServicesInterface/FAchievementStatDefinition)
- [Epic Games Store — Achievements Setup Guide](https://dev.epicgames.com/docs/epic-games-store/services/epic-achievements/achievements-setup)
- [Epic Games Store — Epic Achievements are launching](https://store.epicgames.com/news/epic-games-achievements-are-launching-next-week)

Xbox
- [GDK — Event-based vs. title-managed Achievements](https://learn.microsoft.com/en-us/gaming/gdk/docs/services/player-data/achievements/live-achievements-eb-vs-tm)
- [GDK — Configuring title-managed Achievements in Partner Center](https://learn.microsoft.com/en-us/gaming/xbox-live/features/player-data/achievements/title-managed/config/live-achievements-tm-config)
- [Xbox — Steam porting guide: stats and achievements](https://devdocs.xbox.com/build/steam-porting-guide/features/stats-and-achievements)
- [Xbox — Event-based vs. title-managed Stats](https://devdocs.xbox.com/services/xbox-services/player-data/stats-leaderboards/live-stats-eb-vs-tm)

PlayStation (documentation partenaire sous NDA — sources publiques secondaires)
- [Wikipedia — PlayStation Network, section Trophies](https://en.wikipedia.org/wiki/PlayStation_Network)
- [PSNAWP — modèle Trophy (API PSN, non officiel)](https://psnawp.readthedocs.io/en/latest/generated/psnawp_api.models.trophies.trophy.html)

Google / Apple / multi-plateforme
- [Google Play Games Services — Achievements](https://developer.android.com/games/pgs/achievements)
- [Google Play Games Services — Integrate achievements](https://developer.android.com/games/pgs/integrate-achievements)
- [Play Console — import d'achievements (zip CSV)](https://support.google.com/googleplay/android-developer/answer/2990418)
- [App Store Connect — Achievements reference](https://developer.apple.com/help/app-store-connect/reference/achievements)
- [GameKit — GKAchievement](https://developer.apple.com/documentation/gamekit/gkachievement)
- [Unity Platform Toolkit — Import achievement data](https://docs.unity3d.com/Packages/com.unity.platformtoolkit@1.0/manual/achievements/import-achievement-data.html)

Standards ouverts / on-chain
- [1EdTech — Open Badges 3.0](https://www.imsglobal.org/spec/ob/v3p0/)
- [ERC-5192 — Minimal Soulbound NFTs](https://eips.ethereum.org/EIPS/eip-5192)
- [ERC-5114 — Soulbound Badge](https://eips.ethereum.org/EIPS/eip-5114)
