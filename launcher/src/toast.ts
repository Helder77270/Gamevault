// Desktop toast window (P7 #1). The launcher sends finished strings; this
// page only shows them, sizes the window to them (via Rust) and reports
// clicks back. It closes itself when the last toast leaves.

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";

interface Toast {
  id: string;
  kind: "download" | "message" | "card" | "security";
  kindLabel: string;
  title: string;
  body: string;
  hint?: string;
  out?: boolean; // card toasts: removed rather than inserted
}

const LIFE_MS = 6500;
const MAX = 3;
const stack = document.getElementById("stack")!;
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const ICONS: Record<string, string> = {
  download: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg>`,
  message: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"></path></svg>`,
  security: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z"></path><path d="M12 8v5M12 16v.01"></path></svg>`,
};

function fit(): void {
  if (!stack.children.length) {
    void invoke("toast_close");
    return;
  }
  void invoke("toast_fit", { height: Math.ceil(stack.getBoundingClientRect().height) });
}

function remove(el: HTMLElement): void {
  if (el.classList.contains("out")) return;
  el.classList.add("out");
  window.setTimeout(() => {
    el.remove();
    fit();
  }, 240);
}

function add(t: Toast): void {
  while (stack.children.length >= MAX) stack.firstElementChild?.remove();
  const el = document.createElement("div");
  el.className = `t t-${t.kind}`;
  el.setAttribute("role", "status");
  el.style.setProperty("--life", `${LIFE_MS}ms`);
  const ico =
    t.kind === "card"
      ? `<span class="t-reader" aria-hidden="true"><span class="t-card ${t.out ? "out" : ""}"></span><span class="t-slot"></span><span class="t-led"></span></span>`
      : `<span class="t-ico">${ICONS[t.kind] ?? ""}</span>`;
  el.innerHTML = `
    <div class="t-top"><span class="t-brand"><i></i>AURA-64</span><span class="t-k">${esc(t.kindLabel)}</span><button class="t-x" aria-label="Fermer">✕</button></div>
    <div class="t-row">${ico}<div style="min-width:0"><div class="t-title">${esc(t.title)}</div><div class="t-body">${esc(t.body)}</div></div></div>
    ${t.hint ? `<div class="t-hint">${esc(t.hint)}</div>` : ""}
    <div class="t-timer"><i></i></div>`;
  el.querySelector(".t-x")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    remove(el);
  });
  el.addEventListener("click", () => {
    void emitTo("main", "toast-action", { id: t.id });
    remove(el);
  });
  // the countdown pauses while hovered (the bar's animation does too)
  let left = LIFE_MS;
  let since = Date.now();
  let timer = window.setTimeout(() => remove(el), left);
  el.addEventListener("mouseenter", () => {
    window.clearTimeout(timer);
    left -= Date.now() - since;
  });
  el.addEventListener("mouseleave", () => {
    since = Date.now();
    timer = window.setTimeout(() => remove(el), Math.max(800, left));
  });
  stack.appendChild(el);
  fit();
}

void listen<Toast>("desktop-toast", (ev) => add(ev.payload));
void invoke<Toast[]>("toast_ready").then((queued) => queued.forEach(add));
