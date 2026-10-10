# Infra GameVault — Docker, Kubernetes, Ansible (P8 #7, 2026-10-11)

## Vue d'ensemble

```
                 Internet
                    │  DNS : gamevault.example, api.gamevault.example
                    ▼
        ┌───────────────────────────┐
        │ ingress-nginx (2 à 6 pods)│  TLS Let's Encrypt (cert-manager)
        │ load balancer · limites   │  limites par IP, tailles, timeouts
        └──────┬─────────────┬──────┘
               │             │
     gamevault.example   api.gamevault.example
               │             │
        ┌──────▼─────┐  ┌────▼──────────────┐
        │ web        │  │ ticketd           │
        │ Next.js    │  │ 1 pod (StatefulSet)│──► Base Sepolia (RPC)
        │ 2 à 20 pods│  │ volume persistant  │──► Pinata / IPFS
        │ (HPA CPU)  │  │ SQLite + builds    │
        └────────────┘  └────────────────────┘
```

Le launcher (application Windows) parle à `api.…` ; le navigateur parle aux
deux. La blockchain et le subgraph (Goldsky) sont externes.

## Fichiers

| Où | Quoi |
|---|---|
| `ticketd/Dockerfile` | Node 22, TypeScript exécuté nativement, utilisateur non-root, healthcheck `/health`, données dans `/app/ticketd/data` |
| `web/Dockerfile` | build Next.js en sortie `standalone` (serveur autonome), non-root ; les `NEXT_PUBLIC_*` sont passés au build |
| `.dockerignore` | contexte = racine du monorepo ; aucun `.env`, aucune donnée locale dans une image |
| `k8s/base/` | manifests Kubernetes (kustomize) : namespace, ConfigMap, ticketd, web, 5 Ingress, NetworkPolicy |
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

## Le point dur, dit franchement : ticketd ne monte pas encore en charge

ticketd garde un état local : SQLite (sessions, nonces anti-rejeu, clés de
contenu chiffrées, amis, chat, profils, souhaits), et en mémoire la
présence, les flux temps réel (SSE) et les tickets d'appairage en attente.
Deux réplicas se partageraient cet état de travers (un nonce rejoué sur
l'autre pod, un message de chat qui n'arrive jamais). **Il tourne donc en
un seul pod** (StatefulSet + volume persistant), redémarré par Kubernetes en
cas de panne — quelques secondes d'indisponibilité, sans perte de données.

Pour du volume de masse, le chantier suivant (noté dans TODO.md) :

1. **Postgres** à la place de SQLite (même schéma, transactions déjà
   isolées dans `db.ts`) — managé ou en StatefulSet avec sauvegardes.
2. **Redis** pour la présence, les tickets d'appairage en attente (TTL) et
   la diffusion des événements temps réel entre pods (pub/sub).
3. ticketd passe alors en Deployment + HPA comme `web`.

## Distribution des jeux à grande échelle

Aujourd'hui ticketd sert `/build` depuis son volume (en flux, par plages
d'octets), IPFS en secours. Pour beaucoup de joueurs simultanés : stockage
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

Pas vérifié :
- **Déploiement sur minikube** : impossible sur cette machine en l'état.
  Le noyau WSL est récent (6.18) et n'offre plus le contrôleur mémoire
  des cgroups v1 ; Docker Desktop 20.10 (2021) n'utilise que les cgroups
  v1. Résultat : `missing required cgroups: memory`, kubelet ne démarre
  pas. Même blocage pour kind ou k3d (ils tournent dans le même Docker).
  Deux façons d'en sortir (à toi de choisir) :
  1. **Mettre à jour Docker Desktop** (une version récente gère les
     cgroups v2 du noyau actuel) — le plus simple, il faut accepter sa
     licence et les droits admin, donc c'est toi qui l'installes ;
  2. passer WSL en cgroups v2 seuls (`.wslconfig` :
     `kernelCommandLine = cgroup_no_v1=all`, puis `wsl --shutdown`) —
     touche la configuration de WSL pour toutes les distributions, et un
     Docker Desktop aussi ancien pourrait ne pas suivre.
  Ensuite : `minikube start --driver=docker`, `minikube image load` des
  deux images, `minikube addons enable ingress`, `kubectl apply -k`.

## Ce qui reste avant une vraie mise en ligne

- Le launcher a ses adresses de POC en dur (`127.0.0.1:8787`, le site en
  `localhost:3000`) : il faut une configuration de build production
  pointant vers `https://api.<domaine>` et le site public.
- Sauvegarde automatique de la base ticketd (`npm run backup` existe ; à
  brancher en CronJob, ou gratuit avec un Postgres managé). Garder
  `KEYSTORE_MASTER_KEY` hors du cluster : sans elle, plus aucune clé de jeu.
- Un RPC Base payant sous charge (les RPC publics limitent).
- Observabilité : les métriques d'ingress-nginx sont activées ; ajouter
  Prometheus/Grafana et la collecte des logs.
