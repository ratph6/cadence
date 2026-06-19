import { fmt } from "../util";


// ----------------------------------------------------------------- context menu

export interface CtxItem { label: string; fn: () => void; }

export function showCtxMenu(e: MouseEvent, items: CtxItem[]) {
  const m = document.getElementById("ctx-menu")!;
  m.innerHTML = items.map((it, i) =>
    `<button class="ctx-item" data-i="${i}">${fmt.esc(it.label)}</button>`,
  ).join("");
  m.hidden = false;
  // Position with viewport clamping.
  m.style.left = "0px"; m.style.top = "0px";
  const rect = m.getBoundingClientRect();
  const x = Math.min(e.clientX, window.innerWidth - rect.width - 6);
  const y = Math.min(e.clientY, window.innerHeight - rect.height - 6);
  m.style.left = `${Math.max(0, x)}px`;
  m.style.top = `${Math.max(0, y)}px`;
  m.querySelectorAll<HTMLButtonElement>(".ctx-item").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const idx = parseInt(btn.dataset.i!);
      hideCtxMenu();
      items[idx]?.fn();
    });
  });
}

export function hideCtxMenu() {
  const m = document.getElementById("ctx-menu");
  if (m) m.hidden = true;
}
