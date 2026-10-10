// Builds launcher/preview.html = index.html + the Tauri mock, so the UI can
// be looked at in a plain browser during `npm run dev` (DEV ONLY).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = readFileSync(join(root, "index.html"), "utf8");
const out = index.replace(
  '<script type="module" src="/src/main.ts" defer></script>',
  '<script src="/dev/tauri-mock.js"></script>\n    <script type="module" src="/src/main.ts" defer></script>',
);
if (out === index) throw new Error("index.html: main.ts script tag not found");
writeFileSync(join(root, "preview.html"), out.replace("<title>", "<title>[PREVIEW] "));
console.log("preview.html written — open http://localhost:1420/preview.html");
