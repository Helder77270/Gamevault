# Infra GameVault — Docker, Kubernetes, Ansible (P8 #7, 2026-10-11)

## Vue d'ensemble

```
                 Internet
                    │  DNS : gamevault.example, api.gamevault.example
                    ▼
        ┌───────────────────────────┐
        │ ingress-nginx (2 à 6 pods)│  TLS Let's Encrypt (cert-manager)
        │ load balancer · limites   │  limites par IP (429), tailles, timeouts
        └──────┬─────────────┬──────┘
               │             │
     gamevault.example   api.gamevault.example
               │             │
        ┌──────▼─────┐  ┌────▼───────────┐
        │ web        │  │ ticketd        │──► Base Sepolia (RPC)
        │ Next.js    │  │ 2 à 8 pods     │──► Pinata / IPFS
        │ 2 à 20 pods│  │ (HPA CPU)      │
        └────────────┘  └──┬──────────┬──┘
                           │          │
                  ┌────────▼───┐  ┌───▼──────────┐
                  │ Postgres   │  │ Redis        │
                  │ données    │  │ temps réel   │
                  │ + dumps    │  │ (jetable)    │
                  └────────────┘  └──────────────┘
```

Le launcher (application Windows) parle à `api.…` ; le navigateur parle aux
deux. La blockchain et le subgraph (Goldsky) sont externes.

## Fichiers

| Où | Quoi |
|---|---|
| `ticketd/Dockerfile` | Node 22, TypeScript exécuté nativement, utilisateur non-root, healthcheck `/health`, données dans `/app/ticketd/data` |
| `web/Dockerfile` | build Next.js en sortie `standalone` (serveur autonome), non-root ; les `NEXT_PUBLIC_*` sont passés au build |
| `.dockerignore` | contexte = racine du monorepo ; aucun `.env`, aucune donnée locale dans une image |
| `k8s/base/` | manifests Kubernetes (kustomize) : namespace, ConfigMap, ticketd, web, Redis, 5 Ingress, NetworkPolicy |
| `k8s/components/postgres/` | composant optionnel : Postgres dans le cluster + sauvegarde nocturne + ticketd branché dessus (laisser hors de l'overlay avec un Postgres managé) |
| `k8s/overlays/minikube/` | overlay de test local (images locales, `*.gamevault.local`) |
| `k8s/ops/postgres-restore.yaml` | Job de restauration d'un dump (à la main) |
| `docker-compose.yml` | toute la pile façon production sur un poste |
| `deploy/minikube.ps1` | déploiement minikube d'une commande |
| `deploy/e2e-multireplica.mjs` | test de bout en bout multi-réplicas (+ redémarrage progressif) |
| `docs/runbook.md` | exploitation, incidents, sauvegardes, passage en production |
| `k8s/base/secret.example.yaml` | forme du Secret (jamais de vraie valeur dans le dépôt) |
| `k8s/platform/cluster-issuer.yaml` | émetteur Let's Encrypt (exemple ; Ansible pose le vrai) |
| `deploy/ansible/` | playbook complet : serveurs → k3s → ingress + TLS → application |
| `deploy/check-manifests.py` | contrôles hors ligne des manifests |
| `deploy/render-overlay.py` | rend les modèles Ansible pour les vérifier hors ligne |
| `.github/workflows/images.yml` | construit et publie les images sur GHCR (déclenchement manuel) |

## Ce que fait Kubernetes

- **Redémarrage automatique** : chaque conteneur a trois sondes HTTP
  (démarrage, vivacité, disponibilité). Un ticketd figé est redémarré ; un
  pod qui ne répond plus sort du load balancer en quelques secondes.
- **Montée en charge** : `web` part à 2 réplicas et monte jusqu'à 20 selon
  le CPU (HPA, redescente lissée sur 5 min). Les réplicas sont répartis sur
  les nœuds ; un budget de perturbation en garde toujours un pendant les
  maintenances. Les déploiements ne passent jamais sous la capacité
  (`maxUnavailable: 0`).
- **Load balancer et accès** : ingress-nginx termine le TLS et route par
  domaine et par chemin. Cinq classes de trafic, chacune ses règles :

  | Ingress | Chemins | Limite par IP | Corps | Particularités |
  |---|---|---|---|---|
  | web | `gamevault.example/` | 30 req/s (rafale ×5), 40 connexions | défaut | |
  | api | `api…/` | 10 req/s (rafale ×4), 20 connexions | 1 Mo | JSON, avatars |
  | api-auth | `/ticket`, `/session`, `/devices/revoke` | 30 req/min | 64 Ko | signatures et clés : anti-force brute |
  | api-publish | `/publish` | 6 req/min | 110 Mo | upload studio, timeouts 10 min |
  | api-stream | `/events`, `/build` | 40 req/s, 12 connexions | — | sans tampon, SSE tenu 1 h, téléchargements par morceaux |

  Au-delà : réponse **429**. Derrière un CDN, le contrôleur lit la vraie IP
  (`use-forwarded-headers`).
- **Sécurité** : namespace en Pod Security « restricted » (non-root,
  seccomp, aucune capacité, système de fichiers en lecture seule), trafic
  entrant interdit sauf depuis l'ingress (NetworkPolicy), secrets chiffrés
  au repos dans k3s, Secret applicatif créé par Ansible depuis un vault
  chiffré.

## ticketd monte en charge (depuis le 11 octobre)

ticketd ne garde plus d'état local : le durable est dans **Postgres**
(sessions, nonces anti-rejeu, clés de jeux chiffrées, amis, chat, profils,
avatars, appareils, souhaits, confidentialité), le jetable dans **Redis**
(présence, tickets d'appairage en attente, diffusion des événements temps
réel entre pods, limite du chat). Il tourne donc en **Deployment de 2 à 8
pods** avec autoscaler, comme le web. SQLite + mémoire restent le défaut
sans `DATABASE_URL` / `REDIS_URL` : le dev local et le POC ne changent pas.

Détails d'exploitation (migrations, sauvegardes, incidents, capacité) :
`docs/runbook.md`.

## Distribution des jeux à grande échelle

Aujourd'hui chaque pod ticketd sert `/build` depuis son cache local (en flux,
par plages d'octets), rechargé depuis IPFS et vérifié contre l'empreinte
on-chain. Pour beaucoup de joueurs simultanés : stockage
objet (S3, R2…) derrière un CDN qui gère les plages d'octets, ticketd ne
renvoyant plus que l'adresse. L'intégrité ne change pas : chaque morceau
est vérifié, puis l'empreinte inscrite on-chain.

## Déployer

Prérequis : 1 à 3 serveurs Ubuntu 22.04/24.04 avec une clé SSH, deux noms
de domaine pointant dessus, Ansible ≥ 2.15 sur le poste de pilotage.

```bash
# 1. images (une fois par version) — ou le workflow GitHub « Images »
docker build -f ticketd/Dockerfile -t ghcr.io/<org>/ticketd:0.1.0 .
docker build -f web/Dockerfile --build-arg NEXT_PUBLIC_TICKETD_URL=https://api.<domaine> -t ghcr.io/<org>/web:0.1.0 .
docker push ghcr.io/<org>/ticketd:0.1.0 && docker push ghcr.io/<org>/web:0.1.0

# 2. configuration
cd deploy/ansible
ansible-galaxy collection install -r requirements.yml
cp inventory.example.ini inventory.ini            # vos serveurs
cp group_vars/vault.example.yml group_vars/vault.yml
ansible-vault encrypt group_vars/vault.yml        # clés : jamais en clair
# éditer group_vars/all.yml : domaines, registre, tags, e-mail ACME

# 3. tout déployer (rejouable)
ansible-playbook site.yml --ask-vault-pass
# une seule partie : --tags common | k3s | platform | gamevault
```

Le playbook finit par un test de fumée HTTPS (`/health` de ticketd et la
page d'accueil), en attendant que le certificat soit émis.

## Vérifié / pas vérifié (nuit du 11 octobre)

Vérifié :
- `kubectl kustomize k8s/base` rend 16 objets ;
  `deploy/check-manifests.py` les contrôle (sondes, ressources, non-root,
  seccomp, capacités, images épinglées, Services ↔ ports, Ingress ↔ Services
  et TLS, HPA ↔ cible) — et détecte bien une erreur volontaire.
- Les modèles Ansible rendus avec Jinja2 (`deploy/render-overlay.py`) puis
  passés dans kustomize et les mêmes contrôles : domaines, images, CORS,
  tailles bien substitués.
- Tous les YAML Ansible se lisent ; chaque tâche a un nom et un module.
- Le service de builds en flux de ticketd (nécessaire au conteneur avec de
  gros jeux) est testé en vrai sur 480 Mio.

Vérifié le 11 octobre (après ton feu vert pour Docker, Ansible, minikube) :
- **Images construites** : `gamevault/ticketd` (296 Mo) et `gamevault/web`
  (314 Mo). Les deux tournent en utilisateur non-root ; ticketd répond sur
  `/health`, le web sert l'accueil et une fiche jeu même en système de
  fichiers **en lecture seule** (comme dans Kubernetes).
  Le build a révélé deux vrais bugs, corrigés : une apostrophe non échappée
  (page studio) qui cassait `next build`, et un `NEXT_PUBLIC_*` vide qui
  n'utilisait pas la valeur par défaut.
- **Ansible** (ansible-core 2.13 + ansible-lint 6.8, installés dans WSL
  pour l'utilisateur) : `--syntax-check` OK, **ansible-lint passe au
  profil « production » : 0 erreur, 0 avertissement**.

- **Déploiement complet sur minikube** (Kubernetes 1.31, Docker 29,
  cgroups v2) avec `k8s/overlays/minikube`, tout passé par l'ingress :
  - les 16 objets acceptés **sans aucun avertissement de la politique
    « restricted »** (non-root, seccomp, capacités, lecture seule) ;
  - ticketd + volume persistant de 5 Gio, 2 réplicas web, autoscaler qui
    lit la charge (1 % / 70 %) ;
  - HTTPS : `api…/health` → `{"ok":true}`, accueil web → 200 ;
    HTTP → **308** vers HTTPS ;
  - **limite de débit** : 80 requêtes rapides sur `/session` → 60 passent
    (rafale autorisée), **20 refusées en 429** ;
  - **redémarrage automatique** : ticketd tué brutalement depuis le nœud →
    ~3 s de 502/503, puis 200, compteur de redémarrages à 1 ;
  - **continuité** : un pod web supprimé sous trafic → 40 requêtes sur 40
    en 200, remplaçant recréé tout seul.
  - Refaire tout ça d'une commande :
    `powershell -ExecutionPolicy Bypass -File deploy\minikube.ps1`
    (`-NoBuild` si les images existent déjà).

Pas vérifié :
- Les NetworkPolicy : le réseau par défaut de minikube ne les applique pas
  (il faudrait Calico ou Cilium) ; elles sont acceptées mais pas éprouvées.
- cert-manager / Let's Encrypt (il faut un vrai domaine) et le playbook
  Ansible sur de vrais serveurs.
- L'autoscaler sous un vrai tir de charge.

Réglages machine faits le 11 octobre avec ton accord : Docker Desktop mis
à jour en 29.8.2, et `C:\Users\helde\.wslconfig` force les cgroups v2
(`kernelCommandLine = cgroup_no_v1=all`) — le noyau WSL 6.18 n'a plus le
contrôleur mémoire en v1, indispensable à Kubernetes. Pour revenir en
arrière : supprimer ce fichier puis `wsl --shutdown`.

Vérifié le 11 octobre, migration Postgres + Redis :
- selftest ticketd (40 contrôles) en mémoire **et** sur un vrai Postgres 16
  + Redis 7 ; la vraie base locale copiée vers Postgres (`npm run migrate
  -- --from-sqlite`) → mêmes réponses API, avatar à l'octet près ;
- minikube : Postgres + Redis + 2 ticketd + 2 web, aucun redémarrage ;
  `deploy/e2e-multireplica.mjs` : session ouverte sur un pod et valide sur
  l'autre, rejeu refusé sur l'autre pod, amitié et chat entre pods, flux
  temps réel reçu par l'autre pod (Redis pub/sub), présence, limite du
  chat partagée, avatar partagé ; **redémarrage progressif sous charge :
  0 requête perdue**, flux SSE fermés proprement ;
- sauvegarde CronJob → restauration dans une base séparée : mêmes comptes ;
- pannes : Redis coupé → mode dégradé, pods prêts, profils OK ; Postgres
  coupé → pods hors trafic sans redémarrage, retour automatique ;
- `docker compose up` : 5 conteneurs sains ; ansible-lint profil
  production 0/0 ; les deux variantes Ansible (Postgres intégré / managé)
  rendues et contrôlées.

## Ce qui reste avant une vraie mise en ligne

La liste complète, avec le pourquoi de chaque point, est dans
**`docs/runbook.md` §7** (Postgres managé, builds sur stockage objet + CDN,
adresses de production du launcher, gestionnaire de secrets et rotation des
clés, sauvegardes hors cluster, observabilité, RPC payant, NetworkPolicy
éprouvées avec Calico/Cilium, tir de charge).
