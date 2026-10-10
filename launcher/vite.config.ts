import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  resolve: {
    alias: {
      // Import shared/ as first-party TS source so Vite transpiles it directly.
      // Subpath entries MUST come before the bare one (order matters).
      "@gamevault/shared/registryCatalog": fileURLToPath(new URL("../shared/src/registryCatalog.ts", import.meta.url)),
      "@gamevault/shared/deployments": fileURLToPath(new URL("../shared/src/deployments.ts", import.meta.url)),
      "@gamevault/shared/storage": fileURLToPath(new URL("../shared/src/storage.ts", import.meta.url)),
      "@gamevault/shared/abi": fileURLToPath(new URL("../shared/src/abi.ts", import.meta.url)),
      "@gamevault/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },

  // Two pages: the launcher and the desktop toast window (toast.html).
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        toast: fileURLToPath(new URL("toast.html", import.meta.url)),
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
