---
name: art-direction
description: Direction artistique GameVault/AURA-64 — à charger avant tout travail visuel (launcher, web, maquettes, cartouches, assets). Tokens, typo, motion, principes, et les décisions DA prises avec Helder.
---

# Direction artistique — GameVault · AURA-64

Charger ce skill avant TOUT travail visuel : écran launcher, page web,
maquette, pochette de cartouche, logo, asset de store.

## Statut

- **v0 (actuel)** : la DA de facto, extraite de `launcher/src/styles.css`
  et des maquettes (artifact « AURA-64 UI Propositions »). Sert de base.
- **v1 (en cours)** : séance de cadrage avec Helder (10 questions posées
  le 2026-10-06). Les réponses remplaceront les sections marquées
  `[À CADRER]`. Ne pas inventer à leur place — demander.

## L'idée fondatrice (ne jamais la perdre)

GameVault vend de la **possession physique** dans un monde numérique :
la cartouche SD est réelle, la licence est on-chain, le prêt est une
vraie dépossession. La DA doit matérialiser ça : du **hardware fantasmé**
(console AURA-64), des objets qui s'insèrent, des LED qui répondent, des
cartes qui se tiennent en main. Jamais une « webapp avec un thème sombre ».

## Tokens actuels (source de vérité : `launcher/src/styles.css` `:root`)

- Fond : `--bg #05060d` · panneaux `oklch(0.14 0.045 266)` → `oklch(0.09 0.035 268)`
- Encre : `--ink #eef5ff` · sub `rgba(214,230,255,.62)` · dim `.45`
- Accents : cyan `oklch(0.8 0.1 200)` (système, état OK, heure) ·
  violet `oklch(0.8 0.11 310)` (store, commerce, CTA secondaires)
- États : ok `oklch(0.8 0.14 160)` · warn ambre `oklch(0.82 0.12 85)` ·
  bad `oklch(0.75 0.14 35)`
- Typo : **Chakra Petch** (display/UI) + **Space Mono** (chrome, labels
  `letter-spacing 0.14–0.3em`, tailles 8.5–11px)
- Formes : pills `border-radius 999px` · cartes 12–18px · art des jeux =
  gradients `hueOf(editionId) = id*137 % 360` + hachures diagonales
- Motion : auraDrift/auraFloat (flottement lent), auraSheen (reflet),
  auraBlink (deux-points, attract), orbe horloge PS2 (barres orbitales,
  transitions 0.6–0.8s, mises à jour chirurgicales — JAMAIS de re-render
  qui redémarre les animations)
- Matière : glows oklch doux, bordures `rgba(200,225,255,…)`, slots en
  dégradé sombre avec ombre interne — plastique/verre de console

## Principes déjà actés

1. L'horloge orbitale est LE cœur de la home — on ne la redessine pas,
   on compose autour (décision Helder 2026-10-06).
2. Home à deux états : attract arcade « INSERT SD CARD TO PLAY » sans
   carte / hero CONTINUE + widget carte quand une carte est lue.
3. Données techniques (CID, hash, ticket) repliées, jamais dans le flux
   principal ; mode développeur à terme.
4. Store : structure Steam assumée, MAIS différenciateur visible :
   capsules OCCASION (revente P2P, royalties) à côté du NEUF.
5. Chrome console permanent : topbar (logo, LEDs réelles) + bottombar
   (slot miniature, horloge) encadrent tous les écrans du launcher.
6. Pas d'emoji comme icônes dans le neuf : SVG inline stroke ou glyphes
   typographiques (héritage d'emoji existants à résorber).

## [À CADRER] — réponses de Helder attendues

- Références maîtresses (consoles/jeux/époques) et ce qu'on en garde
- Position sur l'axe rétro ↔ futuriste, et l'époque de référence
- Matérialité dominante (verre, métal brossé, plastique translucide, CRT…)
- Palette définitive (garder cyan/violet ? accent chaud ?)
- Typo display définitive (Chakra Petch confirmé ou remplacé)
- Ton (sérieux premium / joueur / nostalgique / technoïde)
- Logo + mascotte éventuelle, nom définitif (GameVault ? AURA-64 ?)
- Niveau de skeuomorphisme (slots, cartes, LED : jusqu'où ?)
- Motion & son : intensité, moments signatures (insertion, achat, révocation)
- Étendue : launcher / web / pochettes SD imprimées / page studio —
  une seule DA ou déclinaisons ?

## Où appliquer

- `launcher/src/styles.css` — source de vérité des tokens
- `web/app/globals.css` — doit refléter les mêmes tokens (aujourd'hui
  partiellement alignés)
- Maquettes : artifact Design « AURA-64 UI Propositions »
- À créer quand la v1 est actée : `shared/src/theme.ts` (tokens exportés
  pour launcher + web) et pochettes SD imprimables
