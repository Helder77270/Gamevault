# Profils de build du launcher

Un profil dit **à quel serveur GameVault parle un launcher compilé**. Il est
choisi à la compilation et gravé dans le binaire : un launcher installé ne
lit aucune adresse au démarrage, on ne peut donc pas le rediriger vers un
autre serveur en modifiant un fichier.

| Profil | Pour quoi | ticketd | Site |
|---|---|---|---|
| `local.json` (défaut) | Développement, `dev.cmd`, `npm run dev` | `localhost:8787` | `localhost:3000` |
| `compose.json` | La stack `docker compose up -d` | `127.0.0.1:18787` | `127.0.0.1:13000` |
| `production.json` | **Modèle** tant qu'il n'y a pas de serveur | `api.gamevault.example` | `gamevault.example` |

## Champs

| Champ | Obligatoire | Rôle |
|---|---|---|
| `name` | oui | `[a-z0-9-]`, affiché dans Réglages › Système |
| `ticketdUrl` | oui | API ticketd (tickets, amis, chat, appareils, `/events`) |
| `webUrl` | oui | Le site : appairage (`/pair`, QR code), achat, revente, profils. Seule adresse que le launcher peut ouvrir dans le navigateur |
| `buildsUrl` | non | Miroir des builds (`<cid>` et `<cid>/manifest`). Défaut : `ticketdUrl` + `/build/`. Le jour où un CDN sert les builds, c'est ici |
| `rpcUrl` | non | RPC Base. Défaut : celui de `shared/src/deployments.ts` (public, limité) |
| `ipfsGateways` | non | Miroirs de secours. Défaut : Pinata, ipfs.io, dweb.link |
| `ticketSignerPubKeys` | oui en release | Clés publiques des tickets acceptés, compressées, en hex. Une par clé de signature de ticketd |
| `localServices` | non | `true` seulement en local : le launcher peut démarrer ticketd et le site depuis le dépôt |

Toute adresse hors de cette machine doit être en `https://`.

## Commandes (depuis `launcher/`)

```bash
npm run profile -- production            # affiche le profil complété, sa CSP, et s'il passe les contrôles release
npm run dev:profile -- compose           # tauri dev contre la stack Docker
npm run build:profile -- compose --no-bundle   # exe release seul
npm run build:profile -- production      # exe + installeurs (refusé tant que le modèle n'est pas rempli)
```

`GAMEVAULT_PROFILE` accepte aussi un chemin vers un fichier `.json` (utile en CI).
Un `npx tauri dev` ou `npx tauri build` sans script reste en profil `local`.

## Ce que le profil pilote

- **Webview** (Vite, `__GV_PROFILE__` → `src/profile.ts`) : toutes les
  requêtes vers ticketd, les liens vers le site, le RPC, les clés de tickets.
- **Cœur Rust** (`src-tauri/build.rs` → variables `GV_*` à la compilation) :
  le téléchargeur (`download.rs`), la vérification des tickets
  (`ticket.rs`), l'interdiction des services locaux hors profil local.
- **Tauri** (`src-tauri/profile.conf.json`, généré, non versionné) : la CSP
  (seuls les hôtes du profil sont joignables) et la liste des adresses que
  le launcher peut ouvrir dans le navigateur.

Ce qui n'est **pas** dans le profil : la chaîne et les adresses des
contrats (toujours `shared/src/deployments.ts`, une seule vérité pour web,
ticketd et launcher), la clé de test DEV (acceptée seulement dans les builds
de debug).

## Garde-fous d'une release

Une compilation release (`tauri build` sans `--debug`) est refusée, côté
script, côté Vite **et** côté Rust, si le profil :

- vise encore un hôte d'exemple (`*.example`, `*.invalid`, `*.test`) ;
- n'a aucune clé de ticket (aucun ticket ne serait accepté) ;
- s'appelle `production` et autorise les services locaux.

## Mise en production : la marche à suivre

À faire le jour où un serveur existe. Le côté serveur est décrit dans
`docs/runbook.md` et `docs/infra.md`.

1. **Choisir les deux domaines** : le site et l'API. Ce sont les mêmes que
   `web_domain` et `api_domain` dans `deploy/ansible/group_vars/all.yml`
   (ils deviennent les hôtes de l'Ingress Kubernetes).
2. **Créer la clé de signature des tickets de production** (toi, pas
   Claude) et la ranger dans le vault Ansible (`vault_ticket_signer_privkey`)
   et dans le gestionnaire de mots de passe. Ne jamais réutiliser la clé
   locale.
3. **Lire sa clé publique**, au choix :
   - avant le déploiement : `npm run signer-pubkey -w @gamevault/ticketd`
     avec la clé dans l'environnement (affiche la clé publique seulement,
     dernière ligne) ;
   - après : `curl https://<api>/health` → champ `ticketSigner`.
4. **Remplir `production.json`** : les deux hôtes, la clé publique, un RPC
   Base payant (`rpcUrl`). `npm run profile -- production` doit afficher
   `"release": "OK"`.
5. **Compiler** : `npm run build:profile -- production`. Les installeurs
   sortent dans `src-tauri/target/release/bundle/`.
6. **Vérifier** sur une machine propre : Réglages › Système affiche
   `PRODUCTION` et les deux hôtes ; `ticketSigner` de `/health` est bien
   dans `ticketSignerPubKeys` ; un appairage complet passe.

Rien à changer côté CORS pour le launcher : ticketd accepte déjà l'origine
de la webview release (`http://tauri.localhost`). Le site, lui, est ajouté
par `CORS_ORIGINS` (fait par Ansible à partir de `web_domain`).

## Rotation de la clé des tickets

Le launcher accepte toute clé listée. Pour changer de clé sans casser les
cartes :

1. ajouter la nouvelle clé publique au profil, **garder l'ancienne**, publier
   cette version du launcher ;
2. basculer ticketd sur la nouvelle clé privée ;
3. une version plus tard (après la fenêtre hors ligne de 30 jours), retirer
   l'ancienne clé du profil.

Une clé compromise se retire tout de suite : les cartes signées avec elle
devront être réappairées.

## À savoir

- Les cartes appairées contre le ticketd local (clé `02f99334…`) ne sont pas
  acceptées par un launcher de production, et inversement : chaque serveur
  a sa clé. Il faudra réappairer.
- Il reste à faire avant de distribuer un installeur au public : signature
  de code Windows (Authenticode, sinon SmartScreen bloque) et mise à jour
  automatique (plugin updater de Tauri, avec sa propre clé). Voir TODO.md P9.
