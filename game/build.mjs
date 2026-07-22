// Builds the game as ONE self-contained HTML file (dist/index.html):
// Phaser + game code inlined. Single file keeps the launcher's in-memory
// protocol handler trivial — it serves exactly one document.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const phaser = readFileSync(require.resolve("phaser/dist/phaser.min.js"), "utf8");
const game = readFileSync(new URL("./src/game.js", import.meta.url), "utf8");

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>GameVault Runner</title>
<style>html,body{margin:0;height:100%;background:#0b0d11;display:grid;place-items:center;overflow:hidden}</style>
</head>
<body>
<div id="game"></div>
<script>${phaser}</script>
<script>${game}</script>
</body>
</html>
`;

mkdirSync(new URL("./dist", import.meta.url), { recursive: true });
writeFileSync(new URL("./dist/index.html", import.meta.url), html);
console.log(`game/dist/index.html written (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
