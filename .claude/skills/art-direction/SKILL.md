---
name: art-direction
description: Direction artistique GameVault/AURA-64 — à charger avant tout travail visuel (launcher, web, maquettes, cartouches, assets). Tokens, typo, motion, principes, et les décisions DA v1 cadrées avec Helder.
---

# Direction artistique — GameVault · AURA-64 (v1, cadrée 2026-10-06)

Charger ce skill avant TOUT travail visuel : écran launcher, page web,
maquette, pochette de cartouche, logo, asset de store.

## La phrase qui résume tout (Helder)

> « Réélever la qualité des interfaces, mais avec le vocabulaire Rétro. »

Autrement dit : **l'esthétique est rétro-futuriste (fixe), la disposition
est premium-clean (à la iiSU)**. On ne choisit pas entre les deux : la
matière vient de 1999, la rigueur de mise en page vient d'aujourd'hui.

## L'idée fondatrice (ne jamais la perdre)

GameVault vend de la **possession physique** dans un monde numérique.
L'AURA-64 est **une machine de 2035 rêvée en 1999** : verre poli
vaporwave/Outrun, vibe PlayStation 1-2 et borne d'arcade — pas une
webapp sombre, un hardware fantasmé. Public : geek ET classe.

## Références maîtresses

- **PlayStation old school** (PS1/PS2) : boot solennel, orbe, mémoire
  visuelle des cartes, sérieux du hardware.
- **Outrun / vaporwave** : horizon, chrome, dégradés sunset, verre poli.
- **Borne d'arcade** : attract mode, INSERT COIN→INSERT SD CARD, LED,
  immédiateté.
- **iiSU** (frontend d'ému, UI Nintendo Wii/Switch × XMB Sony) : LA
  référence de DISPOSITION uniquement — rangées horizontales avec
  voisins qui dépassent (peeking), menus contextuels en verre, focus
  states très marqués, widgets home, hiérarchie aérée. On emprunte la
  grille, pas la peau.

## Identité

- **AURA-64** : nom de la console/launcher — rappel assumé des consoles
  à suffixe numérique. **GameVault** : la plateforme. Les deux restent.
- **Logo** : une carte SD entourée d'une **aura qui crépite** (arcs
  électriques doux cyan/violet). À décliner : monogramme carte+aura,
  lettrage AURA-64 chromé.

## Palette — ACTÉE (Helder, 2026-10-06, après planches d'explo)

**Midnight Drive en principal, Chrome Sunset en secondaire.** Layout de
référence : la planche « DA · B — layout clean iiSU ». Le set C (CRT
Lounge) est écarté (réutilisable pour UNE pochette pop ponctuelle).

- Principal **Midnight Drive** : fond `#05060d`, cyan `--cyan` (système),
  violet `--violet` (commerce), **`--sunset oklch(0.75 0.15 45)`** réservé
  aux moments de gloire — RÈGLE : seul l'ACHAT (et un jour de sortie)
  porte le sunset ; jamais deux éléments sunset sur un même écran.
- Secondaire **Chrome Sunset** : `--chrome` (dégradé blanc→acier, classe
  `.chrome-text`) pour les titres de cérémonie (boot AURA-64, titre de la
  cinématique de lancement, h1 du hero store) ; `--magenta` en réserve,
  très parcimonieux (pas encore utilisé).
- États : ok `oklch(0.8 0.14 160)` · warn `oklch(0.82 0.12 85)` · bad
  `oklch(0.75 0.14 35)`.

Implémenté (commit DA v1) : tokens dans `launcher/src/styles.css` ET
`web/app/globals.css` (`--sunset`, `--chrome`) ; `.cta.sunset` /
`.btn.sunset` sur TOUS les boutons d'achat ; `.chrome-text` ; aura
crépitante (`.aura-arcs`) autour du logo de boot ; cartouche licence
« Collector verre » dans l'écran lecteur (`.lic-card` : verre fumé, bande
d'art, n° de licence) ; focus « respirant » sur la liste du shelf.

## Cartouches (planche validée — « j'adore les capsules »)

- **A Collector verre** = LA cartouche du produit (écran lecteur, widgets).
- **B Chrome Sunset** = déclinaison affiche/pochette imprimée vaporwave.
- **C Pop arcade** = déclinaison pochette ponctuelle si un jeu s'y prête.

## Typo & formes

- **Chakra Petch** (display/UI) + **Space Mono** (chrome machine,
  letter-spacing 0.14–0.3em) — conservés, ça marche.
- **Formes = Style A « Chanfrein » (validé par Helder le 2026-10-10)** :
  plus de pilules ni de grands rayons (ça faisait « très IA »). Coins
  coupés à 45° via `clip-path: polygon(...)` et la variable `--k` :
  `--cut-l` 14px (panneaux, cartes, toasts), `--cut` 9px (défaut),
  `--cut-s` 6px (boutons, champs, lignes), `--cut-xs` 4px (puces,
  avatars, jauges). CTA principal : 11px. Bulles de chat : le coin de
  l'orateur reste carré. LED, interrupteurs et pastilles : carrés.
  Restent ronds : l'horloge orbitale PS2, les blobs du boot, la touche
  manette de la home. Un élément coupé ne montre pas d'anneau de focus
  extérieur : le dessiner à l'intérieur (`outline-offset: -3px`).
  Couche dans `launcher/src/styles.css` et `web/app/globals.css`
  (bloc « Style A · Chanfrein »), à étendre à tout nouveau composant.
- Slots en creux ombrés, bordures `rgba(200,225,255,…)`, glows oklch
  doux. Matière : verre poli, reflets (auraSheen), jamais de flat mat.
- Art des jeux : gradients `hueOf(id)=id*137%360` + hachures (placeholder
  en attendant les vrais visuels studio).

## Hardware & sensations (décision forte)

Le skeuomorphisme est **assumé et poussé** : l'utilisateur doit SENTIR la
machine. Slots, LED, cartes qui s'insèrent, bruits mécaniques. Le sonore
est **très présent** — chaque interaction majeure a son feedback.

### Les 4 moments signatures (chacun a SON animation + SON son)

1. **Lancement d'un jeu** : bruit de carte SD qui s'insère dans la fente
   + chargement (clic mécanique, montée en spin) → cinématique VERIFY/
   DECRYPT/BOOT existante.
2. **Achat** : GLORIFIANT — fanfare courte, la capsule devient carte,
   burst d'aura, lumière sunset (accent chaud du Set A).
3. **Prêt** (à venir avec ERC-4907) : un AU REVOIR — façon échange de
   Pokéball : la carte SD s'envole vers l'ami, étiquette « À DANS 14 J »,
   son doux descendant. Le retour de prêt = retrouvailles (son inverse).
4. **Revente/révocation** : bruit de CASH qui rentre (tiroir-caisse,
   ka-ching court) côté vendeur ; côté machine révoquée : coupure sèche,
   écran froid (déjà : ERR 0x51/0x52).

Règle motion : flottements lents (auraDrift/Float), transitions 0.6–0.8s,
mises à jour chirurgicales — JAMAIS de re-render qui redémarre les
animations CSS.

## Disposition (le « clean iiSU »)

- Rangées horizontales de cartes avec voisins visibles (peeking), focus
  épais et lumineux, navigation au regard console (pensable à la manette).
- Menus contextuels en verre (blur + bordure claire), hiérarchie aérée,
  une action primaire évidente par écran.
- Chrome console permanent : topbar (logo, LED réelles) + bottombar
  (slot miniature, horloge) encadrent tout le launcher.

## Principes déjà actés (rappel)

1. L'horloge orbitale PS2 est LE cœur de la home — on compose autour,
   on ne la redessine jamais sans Helder.
2. Home à deux états : attract arcade sans carte / hero CONTINUE +
   widget carte quand une carte est lue.
3. Données techniques (CID, hash, ticket) repliées ; mode dev à terme.
4. Store : structure Steam + capsules OCCASION (le différenciateur).
5. Pas d'emoji comme icônes : SVG inline stroke ou glyphes typo.

## Priorités d'application

**Launcher > Store (web) > Studio > pochettes SD imprimées.**
README/GitHub en bonus. Une seule DA, déclinée (console / magasin /
print) — jamais contredite.

## Où appliquer

- `launcher/src/styles.css` — source de vérité des tokens
- `web/app/globals.css` — doit refléter les mêmes tokens
- Maquettes : artifact Design « AURA-64 UI Propositions » (planches DA
  d'explo en bas du canvas)
- À créer quand le set couleur est acté : `shared/src/theme.ts` (tokens
  partagés launcher+web), banque de sons (WebAudio, zéro asset si
  possible — voir `beep()` existant), pochettes imprimables
