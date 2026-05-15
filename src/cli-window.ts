// Standalone CLI window. Mounted in a small, frameless, always-on-top Tauri
// webview that the global Alt+Space shortcut shows/hides. It does NOT load
// the Web Playback SDK, the auto-DJ, the UI, etc. — every command goes
// through HTTP (Web API) so it works regardless of which device is active.
//
// Commands are a deliberately small subset of the in-app CLI — only the
// transport actions that make sense as a Spotlight-style quick action.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";

const api = {
  raw: (method: string, path: string, query?: [string, string][], body?: unknown) =>
    invoke<any>("api_request", { method, path, query, body }),
  next: () => invoke<any>("api_next", { deviceId: undefined }),
  previous: () => invoke<any>("api_previous", { deviceId: undefined }),
  pause: () => invoke<any>("api_pause", { deviceId: undefined }),
  play: (args: { uris?: string[]; contextUri?: string }) =>
    invoke<any>("api_play", args),
  // Note: api_search takes `types` (plural) not `type`, per api.ts.
  search: (q: string, types = "track", limit = 6) =>
    invoke<any>("api_search", { q, types, limit }),
  queueAdd: (uri: string) => invoke<any>("api_queue_add", { uri, deviceId: undefined }),
  playbackState: () => invoke<any>("api_playback_state"),
};

interface Cmd {
  names: string[];
  hint: string;
  complete?: (arg: string) => Promise<string[]> | string[];
  run: (arg: string) => void | Promise<void>;
}

async function togglePlay() {
  try {
    const s = await api.playbackState();
    if (s?.is_playing) await api.pause();
    else await api.play({});
  } catch (e) {
    console.warn("[cli-window] togglePlay", e);
  }
}

async function searchTrackTitles(arg: string): Promise<string[]> {
  if (!arg || arg.length < 2) return [];
  try {
    const r: any = await api.search(arg, "track", 6);
    const items: any[] = r?.tracks?.items ?? [];
    return items.map((t) => `${t.name} — ${(t.artists ?? []).map((a: any) => a.name).join(", ")}`);
  } catch {
    return [];
  }
}

const CMDS: Cmd[] = [
  {
    names: ["pause", "p"],
    hint: "toggle play / pause",
    run: () => togglePlay(),
  },
  {
    names: ["play"],
    hint: "search and play first match — `play <query>`",
    complete: (q) => searchTrackTitles(q),
    run: async (q) => {
      if (!q) { await api.play({}).catch(() => {}); return; }
      const r: any = await api.search(q, "track", 1).catch(() => null);
      const t = r?.tracks?.items?.[0];
      if (t?.uri) await api.play({ uris: [t.uri] });
    },
  },
  {
    names: ["next", "n", "skip", "s"],
    hint: "next track",
    run: () => api.next().catch(() => {}),
  },
  {
    names: ["prev", "b", "back"],
    hint: "previous track",
    run: () => api.previous().catch(() => {}),
  },
  {
    names: ["queue", "q"],
    hint: "queue first match — `queue <query>`",
    complete: (q) => searchTrackTitles(q),
    run: async (q) => {
      if (!q) return;
      const r: any = await api.search(q, "track", 1).catch(() => null);
      const t = r?.tracks?.items?.[0];
      if (t?.uri) await api.queueAdd(t.uri).catch(() => {});
    },
  },
  {
    names: ["vol", "volume"],
    hint: "set / adjust volume — `vol 40`, `vol +10`, `vol *1.5`, `vol /2`",
    run: async (arg) => {
      const s = arg.trim();
      if (!s) return;
      // Pull current device volume so relative ops have something to bite.
      let cur = 0.6;
      try {
        const st: any = await api.playbackState();
        const vp = st?.device?.volume_percent;
        if (typeof vp === "number") cur = vp / 100;
      } catch {}
      let next: number | null = null;
      const m = s.match(/^([+\-*/])\s*(-?\d+(?:\.\d+)?)$/);
      if (m) {
        const v = parseFloat(m[2]!);
        if (!Number.isFinite(v)) return;
        switch (m[1]) {
          case "+": next = cur + v / 100; break;
          case "-": next = cur - v / 100; break;
          case "*": next = cur * v; break;
          case "/": next = v !== 0 ? cur / v : cur; break;
        }
      } else {
        const n = parseFloat(s.replace(/^=/, ""));
        if (Number.isFinite(n)) next = n / 100;
      }
      if (next === null) return;
      const pct = Math.round(Math.max(0, Math.min(1, next)) * 100);
      await api.raw("PUT", "/me/player/volume", [["volume_percent", String(pct)]]).catch(() => {});
    },
  },
  {
    names: ["seek"],
    hint: "seek — `seek <s>` or `seek <m:ss>`",
    run: async (q) => {
      let ms: number | null = null;
      const s = q.trim();
      if (s.includes(":")) {
        const [mm, ss] = s.split(":").map((x) => parseInt(x));
        if (Number.isFinite(mm!) && Number.isFinite(ss!)) ms = (mm! * 60 + ss!) * 1000;
      } else {
        const n = parseInt(s);
        if (Number.isFinite(n)) ms = n * 1000;
      }
      if (ms === null) return;
      await api.raw("PUT", "/me/player/seek", [["position_ms", String(ms)]]).catch(() => {});
    },
  },
];

const root = document.getElementById("cli-root")!;
root.innerHTML = `
  <div class="cli" id="cli-bar">
    <div class="cli-suggest" id="cli-suggest"></div>
    <div class="cli-row">
      <span class="cli-prompt">:</span>
      <input class="cli-input" id="cli-input" type="text" autocomplete="off"
             spellcheck="false" placeholder="command (tab to complete, esc to close)" />
    </div>
  </div>`;
const input = document.getElementById("cli-input") as HTMLInputElement;
const suggestEl = document.getElementById("cli-suggest")!;

let suggestions: string[] = [];
let suggestIdx = 0;

function parseLine(line: string): { cmd: Cmd | null; arg: string; name: string } {
  const idx = line.indexOf(" ");
  const head = (idx === -1 ? line : line.slice(0, idx)).toLowerCase();
  const arg = idx === -1 ? "" : line.slice(idx + 1);
  const cmd = CMDS.find((c) => c.names.includes(head)) ?? null;
  return { cmd, arg, name: head };
}

function renderCmdSuggest() {
  suggestEl.innerHTML = CMDS.map((c, i) => `
    <button class="cli-item ${i === suggestIdx ? "active" : ""}" data-i="${i}">
      <span class="cli-cmd">${c.names[0]}</span>
      <span class="cli-hint">${c.hint}</span>
    </button>`).join("");
}

function renderArgSuggest() {
  suggestEl.innerHTML = suggestions.map((s, i) => `
    <button class="cli-item ${i === suggestIdx ? "active" : ""}" data-i="${i}">
      <span>${escapeHtml(s)}</span>
    </button>`).join("");
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]!);
}

async function refreshSuggest() {
  const line = input.value;
  if (!line.trim() || !line.includes(" ")) {
    suggestions = [];
    suggestIdx = 0;
    renderCmdSuggest();
    return;
  }
  const { cmd, arg } = parseLine(line);
  if (!cmd?.complete) {
    suggestions = [];
    suggestEl.innerHTML = "";
    return;
  }
  const out = await cmd.complete(arg);
  suggestions = Array.isArray(out) ? out : [];
  if (suggestIdx >= suggestions.length) suggestIdx = 0;
  renderArgSuggest();
}

async function submit() {
  const line = input.value.trim();
  if (!line) { hide(); return; }
  const { cmd, arg } = parseLine(line);
  if (!cmd) { hide(); return; }
  try { await cmd.run(arg); } catch (e) { console.warn("[cli-window] cmd error", e); }
  hide();
}

input.addEventListener("input", () => {
  suggestIdx = 0;
  refreshSuggest().catch(() => {});
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); hide(); return; }
  if (e.key === "Enter") { e.preventDefault(); submit(); return; }
  if (e.key === "Tab") {
    e.preventDefault();
    const line = input.value;
    if (!line.includes(" ")) {
      // Cycle through commands by their canonical name.
      suggestIdx = (suggestIdx + (e.shiftKey ? -1 : 1) + CMDS.length) % CMDS.length;
      input.value = CMDS[suggestIdx]!.names[0]! + " ";
      renderCmdSuggest();
      refreshSuggest().catch(() => {});
      return;
    }
    if (suggestions.length) {
      suggestIdx = (suggestIdx + (e.shiftKey ? -1 : 1) + suggestions.length) % suggestions.length;
      // For arg completions, swap in the highlighted suggestion as the arg.
      const { name } = parseLine(line);
      input.value = `${name} ${suggestions[suggestIdx]!}`;
      renderArgSuggest();
    }
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const len = (input.value.includes(" ") ? suggestions.length : CMDS.length);
    if (!len) return;
    e.preventDefault();
    suggestIdx = (suggestIdx + (e.key === "ArrowDown" ? 1 : -1) + len) % len;
    if (input.value.includes(" ")) renderArgSuggest(); else renderCmdSuggest();
  }
});

// Auto-hide when the window loses focus — feels right for a Spotlight-style
// quick action. (Tab-key navigation inside the bar keeps focus, so this only
// fires on real outside clicks / alt-tabs.)
window.addEventListener("blur", () => hide());

async function show() {
  const w = getCurrentWindow();
  await w.show().catch(() => {});
  // Re-center near the top of the active monitor. Tauri's `center: true`
  // window flag drops it dead-center which feels too low for a quick action;
  // we want y ≈ 18% of the monitor height instead.
  try {
    const mon = await currentMonitor();
    if (mon) {
      const innerW = window.innerWidth || 640;
      const innerH = window.innerHeight || 360;
      const dpr = mon.scaleFactor ?? 1;
      const x = Math.round(mon.position.x + (mon.size.width - innerW * dpr) / 2);
      const y = Math.round(mon.position.y + mon.size.height * 0.18);
      const { PhysicalPosition } = await import("@tauri-apps/api/window");
      await w.setPosition(new PhysicalPosition(x, y));
    }
  } catch (e) {
    console.warn("[cli-window] reposition failed", e);
  }
  await w.setFocus().catch(() => {});
  input.value = "";
  suggestIdx = 0;
  renderCmdSuggest();
  setTimeout(() => input.focus(), 0);
}

async function hide() {
  input.value = "";
  suggestions = [];
  suggestEl.innerHTML = "";
  await getCurrentWindow().hide().catch(() => {});
}

// Listen for explicit show/hide events emitted from the main window's
// global-shortcut handler (see global-keys.ts).
import("@tauri-apps/api/event").then(({ listen }) => {
  listen("cli-window:show", () => show());
  listen("cli-window:hide", () => hide());
  listen("cli-window:toggle", async () => {
    const w = getCurrentWindow();
    const visible = await w.isVisible().catch(() => false);
    if (visible) hide(); else show();
  });
});

// Boot: the window is created hidden — populate the suggestion list once so
// the first show() doesn't flash empty.
renderCmdSuggest();
