// Builds each game as ONE self-contained HTML file (dist/<name>.html):
// Phaser + game code inlined — the launcher's in-memory protocol handler
// serves exactly one document.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const GAMES = {
  runner: { src: "./src/game.js", title: "GameVault Runner" },
  snake: { src: "./src/snake.js", title: "GameVault Snake" },
};

const require = createRequire(import.meta.url);
const phaser = readFileSync(require.resolve("phaser/dist/phaser.min.js"), "utf8");
mkdirSync(new URL("./dist", import.meta.url), { recursive: true });

for (const [name, { src, title }] of Object.entries(GAMES)) {
  const code = readFileSync(new URL(src, import.meta.url), "utf8");
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>html,body{margin:0;height:100%;background:#0b0d11;display:grid;place-items:center;overflow:hidden}</style>
</head>
<body>
<div id="game"></div>
<script>${phaser}</script>
<script>${code}</script>
</body>
</html>
`;
  writeFileSync(new URL(`./dist/${name}.html`, import.meta.url), html);
  console.log(`dist/${name}.html (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
}
