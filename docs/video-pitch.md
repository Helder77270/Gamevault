# Vidéo de présentation GameVault — script (≈ 2 min)

But : montrer **les fonctionnalités et leur raison d'être**, pas prouver que
tout marche. On passe d'écran en écran, une idée par plan. Aucune
transaction n'a besoin d'aller au bout : on peut ouvrir la fenêtre du wallet
puis annuler.

Voix off ≈ 290 mots, soit 1 min 55 à un débit posé. Pour tenir en 1 min 30,
couper les plans marqués *(optionnel)*.

## Préparer le tournage

- Lancer `dev.cmd` (ticketd, site, launcher). Enregistrer en 1920×1080 (OBS).
- Onglets ouverts à l'avance dans le navigateur, wallet connecté :
  `localhost:3000`, `/game/1`, `/occasions`, `/trade`, `/friends`, `/u/<ton adresse>`, `/studio`.
- Une carte SD (ou le dossier de dev) avec un jeu déjà appairé, pour le plan « jouer ».
- Masquer la barre des tâches et les notifications Windows.

## Le script

| # | Temps | À l'écran | Voix off |
|---|---|---|---|
| 1 | 0:00 – 0:10 | Launcher : la séquence de démarrage AURA-64 (Réglages › Système › REDÉMARRER pour la rejouer) | « Quand vous achetez un jeu en ligne, vous n'achetez pas un jeu. Vous louez un droit d'accès. Vous ne pouvez ni le revendre, ni le prêter. » |
| 2 | 0:10 – 0:22 | Accueil du launcher, horloge, emplacement de carte « INSERT SD CARD » | « GameVault change ça. Chaque copie d'un jeu est une licence unique sur la blockchain, et le jeu vit sur une carte SD ou une clé USB : une vraie cartouche, comme avant. » |
| 3 | 0:22 – 0:37 | Onglet BOUTIQUE du launcher, survol des jeux, clic sur un jeu → la page `/game/…` s'ouvre dans le navigateur, bouton Acheter, fenêtre du wallet (annuler) | « On achète dans la boutique, avec son wallet. Et sur une vente neuve, le studio garde 92 %. Les grandes plateformes en prennent 30. » |
| 4 | 0:37 – 0:52 | Fiche du jeu dans le launcher : bouton WRITE TO CARD, puis l'écran d'appairage avec le QR code, puis la page `/pair` | « Le launcher écrit le jeu sur la carte, puis on autorise sa machine en une signature. Pas de mot de passe : c'est le wallet qui prouve que le jeu est à vous. » |
| 5 | 0:52 – 1:05 | Carte insérée → PLAY, la cinématique VERIFY / DECRYPT / BOOT, le jeu démarre | « Ensuite, on insère la carte et on joue. Même sans internet, pendant trente jours. Le jeu est chiffré, et ne s'ouvre que sur une machine autorisée par son propriétaire. » |
| 6 | 1:05 – 1:22 | `/trade` : mettre une licence en vente. Puis `/occasions` : les annonces, avec le vendeur visible | « Vous avez fini le jeu ? Revendez-le. Le marché d'occasion est intégré, et à chaque revente, le studio touche automatiquement 10 %. Une première : les créateurs gagnent aussi sur l'occasion. » |
| 7 | 1:22 – 1:32 | Launcher de l'ancien propriétaire : message de révocation (ERR 0x51), puis `/provenance/<n°>` : l'historique de la licence | « Dès que la licence change de main, l'ancien propriétaire perd l'accès. Et chaque copie garde son historique, public et vérifiable. » |
| 8 | 1:32 – 1:45 | `/friends` : la liste d'amis, le bouton PRÊTER, le compteur de jours | « On peut aussi prêter un jeu à un ami, comme on prêtait une cartouche. Pendant le prêt, c'est lui qui joue, et vous récupérez le jeu à la fin. » |
| 9 *(optionnel)* | 1:45 – 1:52 | Onglet AMIS du launcher avec le chat, puis le profil public `/u/…` | « Amis, chat, profils, liste de souhaits : toute la vie d'une plateforme de jeu est là. » |
| 10 *(optionnel)* | 1:52 – 1:58 | `/studio` : création d'une édition (prix, stock, revente autorisée, redevance) | « Côté studio, on publie son jeu, on fixe son prix et on choisit si la revente est autorisée. » |
| 11 | 1:58 – 2:05 | Retour au launcher, logo AURA-64 / GameVault | « GameVault. Le support physique transporte, la blockchain verrouille. Vos jeux vous appartiennent à nouveau. » |

## Version courte (≈ 1 min 30)

Garder les plans 1, 2, 3, 4, 5, 6, 8 et 11. Dans le plan 6, ajouter en fin de
phrase : « …et l'ancien propriétaire perd l'accès au jeu. » (le plan 7 saute).

## Phrases à éviter dans la vidéo

- « DRM » : on dit « vérification de propriété ».
- Les détails techniques (ECIES, tickets, clé d'appareil) : ils sont dans la
  doc, pas dans le pitch.
- « Testnet » : inutile à l'écran, on ne montre pas d'adresse de contrat.
