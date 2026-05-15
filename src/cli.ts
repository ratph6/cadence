// Vim-style command bar. Activated with `:` (Shift+Semicolon) when the user
// is not focused on a text input. Disable via features.cliMode = false.

import { api } from "./api";
import { state } from "./store";
import { playback } from "./player";
import { getConfig } from "./settings";

interface CmdSpec {
  /** Trigger names: first match used as the canonical name. */
  names: string[];
  /** Hint text shown next to the name in the suggestion list. */
  hint: string;
  /** Provide tab-completion candidates for this command's argument. */
  complete?: (arg: string) => Promise<string[]> | string[];
  /** Run with the trailing argument. */
  run: (arg: string) => void | Promise<void>;
}

let bar: HTMLElement | null = null;
let input: HTMLInputElement | null = null;
let suggestEl: HTMLElement | null = null;
let suggestions: string[] = [];
let suggestIdx = 0;

const CMDS: CmdSpec[] = [
  {
    names: ["pause", "p"],
    hint: "toggle play/pause",
    run: () => playback.togglePlay(),
  },
  {
    names: ["play"],
    hint: "search and play first match — `play <query>`",
    complete: (arg) => searchTrackTitles(arg),
    run: async (q) => {
      if (!q) return playback.play();
      const r: any = await api.search(q, "track", 1);
      const t = r?.tracks?.items?.[0];
      if (t) playback.start({ uris: [t.uri], optimisticTrack: t });
    },
  },
  {
    names: ["next", "n", "skip", "s"],
    hint: "next track",
    run: () => playback.next(),
  },
  {
    names: ["prev", "b", "back"],
    hint: "previous track",
    run: () => playback.previous(),
  },
  {
    names: ["queue", "q"],
    hint: "search and queue first match — `queue <query>`",
    complete: (arg) => searchTrackTitles(arg),
    run: async (q) => {
      if (!q) return;
      const r: any = await api.search(q, "track", 1);
      const t = r?.tracks?.items?.[0];
      if (t) await api.queueAdd(t.uri).catch(() => {});
    },
  },
  {
    names: ["playlist", "pl"],
    hint: "play a playlist by name — `playlist <name>`",
    complete: async (arg) => {
      const r: any = await api.raw("GET", "/me/playlists", [["limit", "50"]]);
      const items: any[] = r?.items ?? [];
      return items
        .map((p) => p.name)
        .filter((n: string) => n.toLowerCase().includes(arg.toLowerCase()));
    },
    run: async (q) => {
      if (!q) return;
      const r: any = await api.raw("GET", "/me/playlists", [["limit", "50"]]);
      const items: any[] = r?.items ?? [];
      const match = items.find((p) => p.name.toLowerCase() === q.toLowerCase())
        ?? items.find((p) => p.name.toLowerCase().includes(q.toLowerCase()));
      if (match) playback.start({ contextUri: match.uri });
    },
  },
  {
    names: ["vol", "volume"],
    // Forms:
    //   vol 40       → set to 40 %
    //   vol =40      → set to 40 % (explicit)
    //   vol +10      → bump by +10 percentage points
    //   vol -25      → bump by -25 pp
    //   vol *1.5     → multiply current by 1.5
    //   vol /2       → halve current
    hint: "set/adjust volume — `vol 40`, `vol +10`, `vol -5`, `vol *1.5`, `vol /2`",
    run: (q) => {
      const s = q.trim();
      if (!s) return;
      const cur = state.volume.get() ?? 0;
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
      playback.setVolume(Math.max(0, Math.min(1, next)));
    },
  },
  {
    names: ["seek"],
    hint: "seek seconds — `seek <s>` or `seek <m:ss>`",
    run: (q) => {
      let ms: number | null = null;
      if (q.includes(":")) {
        const [m, s] = q.split(":").map((x) => parseInt(x));
        if (Number.isFinite(m!) && Number.isFinite(s!)) ms = (m! * 60 + s!) * 1000;
      } else {
        const n = parseFloat(q);
        if (Number.isFinite(n)) ms = Math.round(n * 1000);
      }
      if (ms !== null) playback.seek(ms);
    },
  },
  {
    names: ["shuffle", "shuf"],
    hint: "shuffle — `shuffle on|off`",
    run: (q) => {
      const want = q === "off" ? false : q === "on" ? true : !state.playback.get()?.shuffle_state;
      api.raw("PUT", "/me/player/shuffle", [["state", String(want)]]).catch(() => {});
    },
  },
  {
    names: ["repeat", "rep"],
    hint: "repeat — `repeat off|context|track`",
    complete: () => ["off", "context", "track"],
    run: (q) => {
      const v = ["off", "context", "track"].includes(q) ? q : "off";
      api.raw("PUT", "/me/player/repeat", [["state", v]]).catch(() => {});
    },
  },
  {
    names: ["like", "save"],
    hint: "save current track to liked",
    run: async () => {
      const t = state.playback.get()?.track_window?.current_track ?? state.playback.get()?.item;
      const id = t?.id ?? t?.uri?.split(":").pop();
      if (id) await api.raw("PUT", "/me/tracks", [["ids", id]]).catch(() => {});
    },
  },
  {
    names: ["home"],
    hint: "go to home view",
    run: () => state.view.set("home"),
  },
  {
    names: ["focus"],
    hint: "go to focus view",
    run: () => state.view.set("focus"),
  },
  {
    names: ["settings"],
    hint: "go to settings",
    run: () => state.view.set("settings"),
  },
  {
    names: ["search"],
    hint: "open search bar",
    run: () => state.view.set("search"),
  },
];

const ALL_CMD_NAMES = CMDS.flatMap((c) => c.names);

export function startCli(): void {
  // Single global keydown — we intercept `:` only when the user is not in
  // an editable element, so it doesn't fight the search box.
  window.addEventListener("keydown", (e) => {
    if (!getConfig().features?.cliMode) return;
    const tgt = e.target as HTMLElement | null;

    // Inside our own CLI input — capture nav keys, don't re-open.
    if (bar && tgt === input) {
      handleCliKey(e);
      return;
    }

    if (e.key === ":") {
      e.preventDefault();
      // If focus is in any text input (eg. the search bar), blur it first
      // so `:` always opens the CLI from anywhere.
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA"
          || (tgt as any).isContentEditable)) {
        (tgt as HTMLElement).blur();
      }
      open();
    }
  }, true);
}

function ensureBar() {
  if (bar) return bar;
  bar = document.createElement("div");
  bar.className = "cli";
  bar.hidden = true;
  bar.innerHTML = `
    <div class="cli-suggest" id="cli-suggest"></div>
    <div class="cli-row">
      <span class="cli-prompt">:</span>
      <input class="cli-input" id="cli-input" type="text" autocomplete="off"
             spellcheck="false" placeholder="command (tab to complete, esc to close)" />
    </div>`;
  document.body.appendChild(bar);
  input = bar.querySelector("#cli-input");
  suggestEl = bar.querySelector("#cli-suggest");
  input!.addEventListener("input", refreshSuggest);
  return bar;
}

function open() {
  ensureBar();
  bar!.hidden = false;
  input!.value = "";
  suggestions = [];
  suggestIdx = 0;
  refreshSuggest();
  setTimeout(() => input!.focus(), 0);
}

function close() {
  if (bar) bar.hidden = true;
  if (input) input.value = "";
  if (suggestEl) suggestEl.innerHTML = "";
  suggestions = [];
}

function handleCliKey(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    runCurrent();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    completeCurrent(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    suggestIdx = Math.min(suggestions.length - 1, suggestIdx + 1);
    paintSuggest();
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    suggestIdx = Math.max(0, suggestIdx - 1);
    paintSuggest();
    return;
  }
}

let suggestSeq = 0;
let suggestTimer: number | undefined;

async function refreshSuggest() {
  if (suggestTimer !== undefined) { clearTimeout(suggestTimer); suggestTimer = undefined; }
  const my = ++suggestSeq;
  const v = input!.value;
  const space = v.indexOf(" ");
  if (space === -1) {
    // First-word state — show matching command names with hints. Build
    // `suggestions` from canonical names so arrow-key nav works uniformly.
    const q = v.toLowerCase();
    suggestions = CMDS
      .filter((c) => c.names[0]!.startsWith(q) || q === "")
      .map((c) => c.names[0]!);
    suggestIdx = 0;
    paintSuggest();
    return;
  }
  const cmd = v.slice(0, space).toLowerCase();
  const arg = v.slice(space + 1);
  const spec = CMDS.find((c) => c.names.includes(cmd));
  if (!spec?.complete) {
    suggestions = [];
    paintSuggest();
    return;
  }
  suggestTimer = window.setTimeout(async () => {
    try {
      const rsp = await spec.complete!(arg);
      if (my !== suggestSeq) return;
      suggestions = rsp;
      suggestIdx = 0;
      paintSuggest();
    } catch {
      if (my !== suggestSeq) return;
      suggestions = [];
      paintSuggest();
    }
  }, 180);
}

async function searchTrackTitles(arg: string): Promise<string[]> {
  const q = arg.trim();
  if (q.length < 2) return [];
  try {
    const r: any = await api.search(q, "track", 8);
    const items: any[] = r?.tracks?.items ?? [];
    return items.map((t) => {
      const artist = (t.artists ?? [])[0]?.name ?? "";
      return `${t.name}${artist ? " — " + artist : ""}`;
    });
  } catch {
    return [];
  }
}

function paintSuggest() {
  if (!suggestEl) return;
  if (!suggestions.length) {
    suggestEl.innerHTML = "";
    return;
  }
  // First-word state shows command name + hint pair; arg state shows raw text.
  const v = input!.value;
  const isFirstWord = !v.includes(" ");
  suggestEl.innerHTML = suggestions.map((s, i) => {
    const cls = `cli-item${i === suggestIdx ? " active" : ""}`;
    if (isFirstWord) {
      const spec = CMDS.find((c) => c.names[0] === s);
      return `<div class="${cls}" data-i="${i}">
        <span class="cli-cmd">${escapeHtml(s)}</span>
        <span class="cli-hint">${escapeHtml(spec?.hint ?? "")}</span>
      </div>`;
    }
    return `<div class="${cls}" data-i="${i}">${escapeHtml(s)}</div>`;
  }).join("");

  suggestEl.querySelectorAll<HTMLElement>(".cli-item[data-i]").forEach((row) => {
    row.addEventListener("click", () => {
      const i = parseInt(row.dataset.i!);
      if (!Number.isFinite(i)) return;
      suggestIdx = i;
      const cur = input!.value;
      const space = cur.indexOf(" ");
      if (space !== -1) input!.value = cur.slice(0, space + 1) + suggestions[i]!;
      else input!.value = suggestions[i]! + " ";
      input!.focus();
      paintSuggest();
    });
  });
  scrollActiveIntoView();
}

function scrollActiveIntoView() {
  const a = suggestEl?.querySelector<HTMLElement>(".cli-item.active");
  a?.scrollIntoView({ block: "nearest" });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function completeCurrent(dir: number) {
  if (!suggestions.length) return;
  suggestIdx = (suggestIdx + dir + suggestions.length) % suggestions.length;
  const v = input!.value;
  const space = v.indexOf(" ");
  if (space === -1) {
    input!.value = suggestions[suggestIdx]! + " ";
  } else {
    input!.value = v.slice(0, space + 1) + suggestions[suggestIdx]!;
  }
  paintSuggest();
}

function runCurrent() {
  // If a suggestion is highlighted, apply it before running so arrow→Enter
  // works the way users expect (no separate Tab step required).
  if (suggestions.length && input) {
    const v = input.value;
    const space = v.indexOf(" ");
    const pick = suggestions[suggestIdx]!;
    if (space === -1) {
      // First-word: only auto-apply if the user hasn't already typed an
      // exact command match.
      const exact = CMDS.find((c) => c.names.includes(v.toLowerCase()));
      if (!exact) input.value = pick;
    } else {
      input.value = v.slice(0, space + 1) + pick;
    }
  }

  const raw = input!.value.trim();
  if (!raw) { close(); return; }
  const space = raw.indexOf(" ");
  const cmd = (space === -1 ? raw : raw.slice(0, space)).toLowerCase();
  const arg = space === -1 ? "" : raw.slice(space + 1).trim();
  const spec = CMDS.find((c) => c.names.includes(cmd));
  if (spec) {
    Promise.resolve(spec.run(arg)).catch((e) => console.warn("[cli]", e));
  } else {
    console.warn("[cli] unknown command:", cmd);
  }
  close();
}
