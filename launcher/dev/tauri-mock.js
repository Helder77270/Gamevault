// DEV ONLY — lets the launcher UI render in a plain browser (vite dev,
// http://localhost:1420/preview.html) by answering the Tauri core calls
// with harmless sample values. Never part of the build: preview.html is
// not a vite input. Regenerate preview.html with `node dev/make-preview.mjs`.
(() => {
  const DEMO_WALLET = new URLSearchParams(location.search).get("wallet") || "0xbdde8af0afe38eb897f87177d3b10efcd5673f02";
  try {
    if (!localStorage.getItem("gv-session")) localStorage.setItem("gv-session", JSON.stringify({ address: DEMO_WALLET }));
  } catch {}
  const callbacks = new Map();
  let next = 1;
  const answers = {
    get_device_pubkey: "0x02" + "ab".repeat(32),
    scan_cartridges: [],
    list_removable_volumes: [],
    library_scan: [],
    default_library: "C:\\Users\\demo\\GameVault",
    disk_space: [120e9, 500e9],
    native_status: { running: false },
    launched_at_startup: false,
    cache_info: { bytes: 18_400_000, files: 7 },
    start_local_services: null,
    set_ui_scale: null,
    dl_set_limit: null,
    desktop_toast: null,
    focus_main: null,
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb, once) {
      const id = next++;
      callbacks.set(id, (v) => {
        if (once) callbacks.delete(id);
        return cb && cb(v);
      });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      if (cmd in answers) return answers[cmd];
      if (cmd === "device_session_proof") throw new Error("no device key in the browser preview");
      if (cmd.startsWith("plugin:")) return cmd.endsWith("is_enabled") || cmd.endsWith("is_maximized") ? false : null;
      console.info("[tauri-mock] unanswered", cmd, args);
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
})();
