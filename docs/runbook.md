# Runbook GameVault — exploitation et passage en production

Écrit le 2026-10-11, après la migration de ticketd vers Postgres + Redis.
Ce document sert à deux choses : **exploiter** la plateforme (gestes du
quotidien, incidents) et **garder le contexte** des décisions pour le jour
de la vraie mise en production. Compagnon de `docs/infra.md` (architecture,
fichiers, ce qui a été vérifié).

---

## 1. Ce qui tourne, et ce qui garde des données

| Composant | Rôle | Réplicas | Données | Si on le perd |
|---|---|---|---|---|
| **web** (Next.js) | marketplace, profils, studio, appairage | 2 → 20 (HPA CPU) | aucune | rien : un autre réplica répond |
| **ticketd** (Node) | tickets, builds, appareils, social | 2 → 8 (HPA CPU) | aucune (cache de builds jetable) | rien : un autre réplica répond, les flux temps réel se reconnectent |
| **Postgres** | sessions, nonces, **clés de jeux chiffrées**, amis, chat, profils, avatars, appareils, souhaits, confidentialité | 1 (StatefulSet) ou managé | **oui — la seule donnée précieuse** | tickets et social indisponibles jusqu'au retour ; restauration depuis sauvegarde |
| **Redis** | présence, tickets d'appairage en attente, diffusion temps réel, limite du chat | 1 | jetable | mode dégradé (voir §5), rien de perdu d'important |
| **Chaîne Base Sepolia** | propriété des licences, éditions, prix | externe | source de vérité | lecture via RPC ; un RPC lent = tickets lents |
| **IPFS (Pinata)** | builds chiffrés (secours) | externe | builds publics chiffrés | ticketd sert son cache ; à grande échelle : stockage objet + CDN |
| **`KEYSTORE_MASTER_KEY`** | chiffre les clés de jeux au repos | — | **hors du cluster** | **sans elle, toutes les clés de jeux sont perdues** (même avec les sauvegardes) |

Règle d'or : **sauvegarde Postgres + `KEYSTORE_MASTER_KEY` gardée ailleurs**
= tout est récupérable. Le reste se reconstruit.

---

## 2. Déployer et mettre à jour

### Local, façon production (un poste)
```bash
docker compose up -d --build       # Postgres + Redis + 2 ticketd + web
docker compose ps                  # tout « healthy »
docker compose down                # garde la base ; down -v l'efface
```
ticketd : 18787 et 18788 (les deux réplicas), web : 13000.

### Kubernetes local (minikube)
```bash
powershell -ExecutionPolicy Bypass -File deploy\minikube.ps1     # -NoBuild si images déjà faites
node deploy/e2e-multireplica.mjs --rollout                       # preuve multi-réplicas
```

### Serveurs (Ansible)
```bash
cd deploy/ansible
ansible-playbook site.yml --ask-vault-pass                       # tout, rejouable
ansible-playbook site.yml --ask-vault-pass --tags gamevault      # seulement l'application
```

### Mettre à jour une version
1. Construire et pousser les images (workflow GitHub « Images », tag `X.Y.Z`).
2. `group_vars/all.yml` : `ticketd_image_tag` / `web_image_tag`.
3. `--tags gamevault`. Les Deployments font un **rolling update sans
   coupure** (vérifié : 0 requête perdue) ; ticketd applique les migrations
   de schéma au démarrage, sous verrou (un seul réplica les applique).
4. Retour arrière : `kubectl -n gamevault rollout undo deployment/ticketd`
   (et web). ⚠ Une migration de schéma ne se défait pas toute seule : écrire
   des migrations **additives** (ajouter colonnes/tables, ne pas renommer
   ni supprimer dans la même version que le code qui en dépend).

### Écrire une migration de schéma
Dans `ticketd/src/sql.ts`, ajouter à `MIGRATIONS` un objet
`{ version: N+1, name, sqlite, postgres }`. Jamais modifier une migration
déjà appliquée. Tester : `npm run selftest` (SQLite) puis
`GAMEVAULT_TEST_BACKENDS=1 DATABASE_URL=… REDIS_URL=… npm run selftest`.
État : `npm run migrate -w @gamevault/ticketd -- --status`.

---

## 3. Sauvegardes et restauration (testées le 11 octobre)

- **Automatique** : CronJob `postgres-backup` chaque nuit à 03:17,
  `pg_dump --format=custom` vérifié par `pg_restore --list`, gardé 14 jours
  sur le volume `postgres-backups`.
- **À la demande** :
  `kubectl -n gamevault create job --from=cronjob/postgres-backup backup-now`
- **Hors Kubernetes** : `npm run backup -w @gamevault/ticketd` (SQLite :
  copie du fichier ; Postgres : `pg_dump` si le client est installé).
- **Restaurer** : `k8s/ops/postgres-restore.yaml` (mode d'emploi en tête du
  fichier). Par défaut il restaure **à côté** (`gamevault_restore`) pour
  comparer avant de basculer. Pour écraser la base vivante : mettre
  ticketd à 0 réplica, `TARGET_DB=gamevault`, restaurer, remettre ticketd.
- Testé : dump de la base de minikube → restauré dans une base séparée →
  mêmes comptes partout (profils, amitiés, 90 messages, sessions, avatars).

À faire en production : **copier les dumps hors du cluster** (stockage objet,
autre région) ; un volume dans le même cluster ne protège pas d'une perte du
cluster. Avec un Postgres managé : activer le PITR (restauration à la minute)
et garder quand même un dump logique régulier.

---

## 4. Migrer les données SQLite (POC) vers Postgres

```bash
DATABASE_URL=postgres://… KEYSTORE_MASTER_KEY=<la même> npm run migrate -w @gamevault/ticketd -- --from-sqlite ticketd/data/ticketd.db
```
- Une seule transaction ; refuse une cible non vide (sauf `--force`).
- Vérifie d'abord que la clé maître déchiffre les clés de la source.
- Recopie aussi les avatars restés en fichiers.
- Testé sur la vraie base locale : 6 clés de jeux, profils, amitiés, chat,
  sessions, souhaits, avatar → un ticketd branché sur Postgres répond
  **exactement** comme celui sur SQLite.

---

## 5. Incidents : quoi regarder, quoi faire

| Symptôme | Cause probable | Ce qui se passe tout seul | Quoi faire |
|---|---|---|---|
| ticketd `READY 0/1`, `/ready` → `base : ECONNREFUSED` | Postgres arrêté / injoignable | les pods sortent du trafic **sans redémarrer** ; ils reviennent seuls quand la base revient (testé) | `kubectl -n gamevault get pod postgres-0`, logs, volume plein ? |
| `/ready` → `"liveOk": false` | Redis arrêté | **mode dégradé** : téléchargements, tickets, profils OK ; présence = « hors ligne », pas d'événements temps réel, appairage possiblement à refaire, chat non limité | relancer Redis (`kubectl -n gamevault rollout restart deploy/redis`) ; rien à restaurer |
| 429 côté clients | limites par IP de l'ingress | normal sous attaque ou client trop bavard | ajuster `limit-*` dans `k8s/base/ingress.yaml` |
| ticketd redémarre en boucle | crash au démarrage (migration, config) | backoff Kubernetes | `kubectl -n gamevault logs deploy/ticketd --previous` ; une migration cassée affiche `migration N (...)` |
| tickets lents / échouent sur `ownerOf` | RPC Base lent ou limité | — | RPC payant (`RPC_URL` dans le ConfigMap) |
| « KEYSTORE_MASTER_KEY manquant ou invalide » | Secret incomplet | — | remettre la clé (vault Ansible) ; **ne jamais en générer une nouvelle** sur une base existante |
| Disque Postgres plein | croissance chat/sessions | — | agrandir le volume ; les sessions et nonces expirés sont purgés en continu |

Utile :
```bash
kubectl -n gamevault get pods,hpa,pvc
kubectl -n gamevault logs deploy/ticketd --tail=100
kubectl -n gamevault exec postgres-0 -- psql -U gamevault -d gamevault -c "SELECT version, name FROM schema_migrations"
kubectl -n gamevault port-forward svc/ticketd 8787:8787   # puis /ready, /metrics
```

---

## 6. Capacité : les nombres qui comptent

- **Connexions Postgres** = `PG_POOL_MAX` (10) × réplicas ticketd (max 8) +
  sauvegardes ≤ `max_connections` (200 dans `postgres.yaml`). Monter le
  max de l'HPA ⇒ monter `max_connections` (ou mettre PgBouncer devant).
- **Flux temps réel (SSE)** : une connexion ouverte par launcher / onglet,
  tenue par un réplica ; mesurée par `ticketd_sse_streams` (`/metrics`).
  Node en tient des milliers par pod ; l'ingress coupe à 1 h (le client se
  reconnecte). Limite de 12 connexions par IP sur `/events` et `/build`.
- **Redis** : petites clés à durée de vie + pub/sub ; 256 Mo suffisent
  très largement. Politique `volatile-ttl`.
- **Builds** : chaque pod ticketd garde un cache (jusqu'à 10 Gio) et se
  recharge depuis IPFS. C'est le premier goulot à grande échelle (voir §7).

---

## 7. Passage en production : la liste, avec le pourquoi

Décisions déjà prises (ne pas les refaire sans raison) :
- ticketd **sans état** : tout le durable dans Postgres, le jetable dans
  Redis. Avatars en base (plus de fichiers par pod). Nonces en base (clé
  primaire = anti-rejeu atomique entre réplicas). Verrous consultatifs
  Postgres par portefeuille pour les plafonds (2 appareils, 16 amis, 50
  souhaits).
- `/ready` ne dépend que de Postgres : une panne Redis dégrade, elle ne
  coupe pas tout. `/health` ne dépend de rien : pas de tempête de
  redémarrages quand la base tombe.
- SQLite reste le défaut sans `DATABASE_URL` : le POC et le dev local ne
  changent pas.

À faire avant d'ouvrir au public :
1. **Postgres managé** (PITR, bascule automatique) : laisser le composant
   `k8s/components/postgres` hors de l'overlay, mettre `DATABASE_URL` dans
   le vault (`vault_external_database_url`, `?sslmode=require`).
2. **Redis managé ou Sentinel** si la présence temps réel devient
   importante (aujourd'hui une panne ne coûte que du confort).
3. **Builds sur stockage objet + CDN** (plages d'octets) : ticketd ne
   renverrait que l'adresse ; l'intégrité ne change pas (morceaux + empreinte
   on-chain). Évite que chaque pod télécharge 500 Mo depuis IPFS.
4. **Launcher en mode production** : ses adresses sont aujourd'hui en dur
   (`127.0.0.1:8787` dans `launcher/src/main.ts` et dans
   `launcher/src-tauri/src/download.rs`, le site en `localhost:3000`) →
   configuration de build vers `https://api.<domaine>`.
5. **Secrets** : passer du vault Ansible à un gestionnaire (External Secrets,
   Sealed Secrets, ou celui du cloud) ; plan de rotation des clés de
   signature (`TICKET_SIGNER_PRIVKEY` : sa clé publique est embarquée dans le
   launcher → rotation = nouvelle version du launcher qui accepte les deux).
6. **Sauvegardes hors cluster** et un exercice de restauration trimestriel.
7. **Observabilité** : Prometheus (scrape `/metrics` de ticketd et
   d'ingress-nginx), Grafana, logs centralisés, alertes : pods non prêts,
   `ticketd_live_up 0`, disque Postgres, échecs du CronJob de sauvegarde.
8. **RPC Base payant** et, plus tard, passage du testnet au mainnet
   (nouvelles adresses de contrats dans `shared/src/deployments.ts`).
9. **NetworkPolicy** : écrites, mais le CNI de minikube ne les applique pas ;
   vérifier avec Calico/Cilium sur le vrai cluster.
10. **Charge** : faire un vrai tir (k6) pour valider les seuils de l'HPA et
    les limites de l'ingress.
