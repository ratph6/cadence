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

async function emitToMain(name: string, payload?: any) {
  // Route through the main window so transport actions use its SDK fast
  // path (no HTTP roundtrip when the SDK is the active device). The cli
  // window itself never loads the Web Playback SDK; without this hop
  // every pause/skip would always go over HTTPS to Spotify's Web API.
  //
  // Use the global `emitTo("main", ...)` rather than grabbing the main
  // WebviewWindow handle and calling .emit on it — webview.emit() emits
  // *from* that webview which doesn't reliably fire main-window listeners,
  // while emitTo targets listeners scoped to the named window.
  const { emitTo } = await import("@tauri-apps/api/event");
  await emitTo("main", name, payload);
}

async function togglePlay() {
  try { await emitToMain("cli:play_pause"); } catch (e) {
    console.warn("[cli-window] togglePlay emit failed; HTTP fallback", e);
    try {
      const s = await api.playbackState();
      if (s?.is_playing) await api.pause(); else await api.play({});
    } catch {}
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

// One-shot fetch of the user's own playlists for the playlist command. Cached
// for the lifetime of this cli window — the cli is short-lived per session
// and Spotify's /me/playlists endpoint is rate-limited, so refetching on
// every keystroke would burn quota fast.
let playlistsCache: any[] | null = null;
let playlistsFetching: Promise<any[]> | null = null;
async function getMyPlaylists(): Promise<any[]> {
  if (playlistsCache) return playlistsCache;
  if (playlistsFetching) return playlistsFetching;
  playlistsFetching = (async () => {
    try {
      const r: any = await api.raw("GET", "/me/playlists", [["limit", "50"]]);
      playlistsCache = (r?.items ?? []) as any[];
      return playlistsCache;
    } catch (e) {
      console.warn("[cli-window] /me/playlists failed", e);
      return [];
    } finally {
      playlistsFetching = null;
    }
  })();
  return playlistsFetching;
}

/** Strip a leading `-s ` flag from a playlist-command argument. Returns
 *  the cleaned name + whether shuffle was requested. */
function parsePlaylistArg(arg: string): { name: string; shuffle: boolean } {
  let shuffle = false;
  let name = arg.trim();
  if (name === "-s") return { name: "", shuffle: true };
  if (name.startsWith("-s ")) { shuffle = true; name = name.slice(3).trim(); }
  return { name, shuffle };
}

async function searchPlaylistNames(arg: string): Promise<string[]> {
  const { name, shuffle } = parsePlaylistArg(arg);
  if (!name) return [];
  const pls = await getMyPlaylists();
  const lower = name.toLowerCase();
  const names = pls
    .filter((p) => (p?.name ?? "").toLowerCase().includes(lower))
    .slice(0, 8)
    .map((p) => p.name as string);
  // Preserve the `-s` flag in the suggestion strings so Tab / Right-arrow
  // accepting a suggestion doesn't drop the shuffle flag. The generic
  // completion logic replaces the entire arg with the suggestion, so the
  // suggestion has to carry the flag itself.
  return shuffle ? names.map((n) => `-s ${n}`) : names;
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
    run: () => emitToMain("cli:next").catch(() => api.next().catch(() => {})),
  },
  {
    names: ["prev", "b", "back"],
    hint: "previous track",
    run: () => emitToMain("cli:prev").catch(() => api.previous().catch(() => {})),
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
    names: ["playlist", "pl"],
    hint: "play playlist — `playlist <name>` (add `-s` for shuffle)",
    complete: (arg) => searchPlaylistNames(arg),
    run: async (arg) => {
      const { name, shuffle } = parsePlaylistArg(arg);
      if (!name) return;
      const pls = await getMyPlaylists();
      const lower = name.toLowerCase();
      // Prefer exact match, then prefix, then any substring.
      const match =
        pls.find((p) => (p?.name ?? "").toLowerCase() === lower) ??
        pls.find((p) => (p?.name ?? "").toLowerCase().startsWith(lower)) ??
        pls.find((p) => (p?.name ?? "").toLowerCase().includes(lower));
      const uri: string | undefined = match?.uri;
      if (!uri) return;
      // Set shuffle BEFORE play so the very first track served from the
      // playlist context comes out of a shuffled queue. Reversing the order
      // means the first track is always the playlist's first item even
      // with `-s`.
      await api.raw("PUT", "/me/player/shuffle",
        [["state", shuffle ? "true" : "false"]]).catch(() => {});
      await api.play({ contextUri: uri }).catch(() => {});
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
      <div class="cli-input-wrap">
        <input class="cli-input" id="cli-input" type="text" autocomplete="off"
               spellcheck="false" placeholder="command (→ to accept, ↑↓ + Enter, esc to close)" />
        <span class="cli-ghost" id="cli-ghost"></span>
      </div>
    </div>
  </div>`;
const input = document.getElementById("cli-input") as HTMLInputElement;
const suggestEl = document.getElementById("cli-suggest")!;
const ghostEl = document.getElementById("cli-ghost")!;
const card = document.getElementById("cli-bar")!;

// Resize the OS window to exactly fit the rounded card whenever the card's
// height changes (suggestion list expanding/collapsing). The window has
// Acrylic/Mica/Vibrancy applied at the OS level, so making the window
// hug the card means the frosted blur stops at the rounded corners
// instead of bleeding into a big rect around it.
let syncQueued = false;
async function syncWindowSize() {
  if (syncQueued) return;
  syncQueued = true;
  // Coalesce to one rAF — ResizeObserver can fire several times per layout
  // pass and setSize is a relatively expensive IPC call.
  requestAnimationFrame(async () => {
    syncQueued = false;
    const rect = card.getBoundingClientRect();
    const h = Math.max(48, Math.ceil(rect.height));
    const w = Math.max(320, Math.ceil(rect.width));
    const dpr = window.devicePixelRatio || 1;
    try {
      const { PhysicalSize } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setSize(
        new PhysicalSize(Math.round(w * dpr), Math.round(h * dpr)),
      );
    } catch (e) {
      console.warn("[cli-window] resize failed", e);
    }
  });
}
new ResizeObserver(syncWindowSize).observe(card);

let suggestions: string[] = [];
let suggestIdx = 0;

function parseLine(line: string): { cmd: Cmd | null; arg: string; name: string } {
  const idx = line.indexOf(" ");
  const head = (idx === -1 ? line : line.slice(0, idx)).toLowerCase();
  const arg = idx === -1 ? "" : line.slice(idx + 1);
  const cmd = CMDS.find((c) => c.names.includes(head)) ?? null;
  return { cmd, arg, name: head };
}

// Match the in-app CLI exactly: use <div data-i> for rows (not <button>),
// otherwise the browser's default button chrome paints a light-grey box
// per row, which is what made the standalone window look unstyled.
function renderCmdSuggest() {
  suggestEl.innerHTML = firstWordMatches.map((c, i) => `
    <div class="cli-item ${i === suggestIdx ? "active" : ""}" data-i="${i}">
      <span class="cli-cmd">${escapeHtml(c.names[0]!)}</span>
      <span class="cli-hint">${escapeHtml(c.hint)}</span>
    </div>`).join("");
  attachRowClicks();
}

function renderArgSuggest() {
  suggestEl.innerHTML = suggestions.map((s, i) => `
    <div class="cli-item ${i === suggestIdx ? "active" : ""}" data-i="${i}">
      <span>${escapeHtml(s)}</span>
    </div>`).join("");
  attachRowClicks();
}

function attachRowClicks() {
  suggestEl.querySelectorAll<HTMLElement>(".cli-item[data-i]").forEach((row) => {
    row.addEventListener("click", () => {
      const i = parseInt(row.dataset.i!);
      if (!Number.isFinite(i)) return;
      suggestIdx = i;
      const v = input.value;
      const space = v.indexOf(" ");
      if (space !== -1 && suggestions.length) {
        input.value = v.slice(0, space + 1) + suggestions[i]!;
      } else if (firstWordMatches[i]) {
        input.value = firstWordMatches[i]!.names[0]! + " ";
        recomputeFirstWordMatches();
        refreshSuggest().catch(() => {});
      }
      input.focus();
      updateGhost();
    });
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]!);
}

let suggestSeq = 0;
// Track whether the user has navigated suggestions with arrow keys. If they
// have, Enter should apply the highlighted entry rather than running whatever
// happens to be in the input (which may be a partial first letter).
let userNavigated = false;
// Subset of CMDS whose canonical name (or alias) prefix-matches what the
// user has typed so far. The suggestion list, Tab/Enter accept, ghost
// completion, and arrow navigation all read from this — without filtering,
// "playlis<Tab>" was filling the *first* command in CMDS regardless of
// what was typed.
let firstWordMatches: Cmd[] = CMDS.slice();

function recomputeFirstWordMatches() {
  const v = input.value;
  if (v.includes(" ")) {
    firstWordMatches = CMDS.slice();
    return;
  }
  if (!v) {
    firstWordMatches = CMDS.slice();
    return;
  }
  const lower = v.toLowerCase();
  const matched = CMDS.filter((c) =>
    c.names.some((n) => n.toLowerCase().startsWith(lower)),
  );
  // Fall back to the full list if nothing matches — better to keep the row
  // populated than blank it out mid-type.
  firstWordMatches = matched.length ? matched : CMDS.slice();
}

/** Update the inline ghost-completion span shown after the cursor — a faint
 *  preview of the most likely command (first-word) or first suggestion
 *  (arg). Pressing → at the end of the input accepts whatever's previewed. */
function updateGhost() {
  const v = input.value;
  let ghost = "";
  if (!v.includes(" ")) {
    if (v.length > 0 && firstWordMatches.length) {
      const lower = v.toLowerCase();
      // Prefer the highlighted match if the user has arrowed.
      const candidate = firstWordMatches[suggestIdx] ?? firstWordMatches[0]!;
      const name = candidate.names.find((n) => n.toLowerCase().startsWith(lower))
        ?? candidate.names[0]!;
      if (name.length > v.length) {
        ghost = name.slice(v.length);
      }
    }
  } else {
    const space = v.indexOf(" ");
    const arg = v.slice(space + 1);
    const first = suggestions[suggestIdx] ?? suggestions[0];
    if (first && first.toLowerCase().startsWith(arg.toLowerCase()) && first.length > arg.length) {
      ghost = first.slice(arg.length);
    }
  }
  ghostEl.textContent = ghost;
}

async function refreshSuggest() {
  // Bump a sequence number so we can discard the result of any in-flight
  // arg-completion call whose input no longer matches. Without this, a
  // slow searchTrackTitles("foo") that resolves AFTER the user has cleared
  // the input would clobber the freshly-rendered command list with stale
  // song results — the exact symptom of "delete the text, songs keep
  // showing up". Mirrors the suggestSeq guard in the embedded cli.ts.
  const my = ++suggestSeq;
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
  if (my !== suggestSeq) return;
  suggestions = Array.isArray(out) ? out : [];
  if (suggestIdx >= suggestions.length) suggestIdx = 0;
  renderArgSuggest();
  updateGhost();
}

function submit() {
  // If the user navigated suggestions via arrow keys, the highlighted entry
  // is what they meant — apply it over whatever's typed. Without this Enter
  // would run the partial first-word match instead of the selected row.
  let line = input.value;
  if (userNavigated) {
    if (!line.includes(" ")) {
      const pick = firstWordMatches[suggestIdx]?.names[0];
      if (pick) line = pick;
    } else if (suggestions.length) {
      const space = line.indexOf(" ");
      const pick = suggestions[suggestIdx];
      if (pick) line = line.slice(0, space + 1) + pick;
    }
  } else if (!line.includes(" ") && line.length > 0 && firstWordMatches.length) {
    // No explicit arrow navigation: if the typed prefix matches a unique
    // command, run that command rather than failing because the literal
    // text isn't a registered name (e.g. user types "playlis" → run
    // "playlist"). Picks the first prefix match — same row the ghost was
    // previewing.
    const pick = firstWordMatches[0]!.names[0];
    if (pick && pick.toLowerCase().startsWith(line.toLowerCase())) {
      line = pick;
    }
  }
  line = line.trim();
  if (!line) { hide(); return; }
  const { cmd, arg } = parseLine(line);
  if (!cmd) { hide(); return; }
  // Defer hide() a couple of frames so the Enter key's `keyup` event fires
  // on THIS window before focus shifts. If we hide synchronously inside the
  // Enter `keydown` handler, the keyup is delivered to whatever app gains
  // focus next (Discord, a code editor, etc.) — the Enter "leaks" through
  // the CLI into the surrounding desktop and submits forms / sends chats
  // the user didn't intend. The command itself still dispatches right
  // away so playback feels instant.
  Promise.resolve()
    .then(() => cmd.run(arg))
    .catch((e) => console.warn("[cli-window] cmd error", e));
  setTimeout(hide, 80);
}

input.addEventListener("input", () => {
  suggestIdx = 0;
  userNavigated = false;
  recomputeFirstWordMatches();
  refreshSuggest().catch(() => {});
  updateGhost();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hide(); return; }
  if (e.key === "Enter") {
    // stopPropagation as belt-and-braces; the real fix for "Enter leaks to
    // the next app" is the deferred hide() inside submit() — preventDefault
    // alone doesn't stop the OS from routing the subsequent keyup to a
    // newly-focused window if we hide synchronously.
    e.preventDefault();
    e.stopPropagation();
    submit();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    const line = input.value;
    const isFirstWord = !line.includes(" ");
    // Apply whatever's currently highlighted FIRST, then bump the index for
    // the next Tab press. This way "ArrowDown ArrowDown Tab" fills the 3rd
    // row (what the user selected) instead of the 4th, while bare repeated
    // Tabs still cycle through suggestions like the in-app CLI.
    if (isFirstWord) {
      if (!firstWordMatches.length) return;
      input.value = firstWordMatches[suggestIdx]!.names[0]! + " ";
      suggestIdx = (suggestIdx + (e.shiftKey ? -1 : 1) + firstWordMatches.length) % firstWordMatches.length;
      recomputeFirstWordMatches();
      renderCmdSuggest();
      refreshSuggest().catch(() => {});
    } else if (suggestions.length) {
      const { name } = parseLine(line);
      input.value = `${name} ${suggestions[suggestIdx]!}`;
      suggestIdx = (suggestIdx + (e.shiftKey ? -1 : 1) + suggestions.length) % suggestions.length;
      renderArgSuggest();
    }
    updateGhost();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const len = (input.value.includes(" ") ? suggestions.length : firstWordMatches.length);
    if (!len) return;
    e.preventDefault();
    userNavigated = true;
    suggestIdx = (suggestIdx + (e.key === "ArrowDown" ? 1 : -1) + len) % len;
    if (input.value.includes(" ")) renderArgSuggest(); else renderCmdSuggest();
    updateGhost();
    return;
  }
  if (e.key === "ArrowRight") {
    // Accept the inline ghost completion when caret is at the end of input.
    // If caret is mid-text the user is just navigating — leave the cursor
    // alone so we don't trample standard text-editing.
    const ghost = ghostEl.textContent ?? "";
    const atEnd = input.selectionStart === input.value.length
      && input.selectionEnd === input.value.length;
    if (ghost && atEnd) {
      e.preventDefault();
      input.value = input.value + ghost;
      suggestIdx = 0;
      userNavigated = false;
      refreshSuggest().catch(() => {});
      updateGhost();
    }
    return;
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
  // Fully reset transient state — show() is reached on every re-open of
  // the CLI window, so any leftover filter / suggestion / navigation flag
  // from the previous session has to be cleared. The "only 2 suggestions
  // show" symptom came from firstWordMatches staying narrowed to the last
  // typed prefix even after input was blanked.
  input.value = "";
  suggestIdx = 0;
  userNavigated = false;
  suggestions = [];
  recomputeFirstWordMatches();
  renderCmdSuggest();
  updateGhost();
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

// Boot: pre-paint the command list so the first frame is never empty, then
// kick a show() so positioning + focus happens immediately. The window is
// created lazily (see global-keys.ts) so reaching this code means the user
// just pressed Alt+Space — auto-showing is the desired UX.
renderCmdSuggest();
show().catch(() => {});

// On Win11, DWM otherwise renders the frameless transparent window as a
// sharp rectangle even when the CSS card is rounded — which makes the
// OS-level Acrylic blur read as a "big rect" around the bar. The Rust
// command calls DwmSetWindowAttribute(DWMWCP_ROUND) so the OS clips the
// window itself to a rounded shape. Silent no-op on macOS/Linux.
invoke("window_round_corners").catch((e) => {
  console.warn("[cli-window] round corners failed", e);
});
