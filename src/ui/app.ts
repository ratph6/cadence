// Vanilla-DOM Spotify UI. Replaces the previous ImGui canvas surface.
// Layout: sidebar (nav + pinned + playlists) | top search | main view | now-bar.

import { auth, api, sys } from "../api";
import { state } from "../store";
import { playback, pollSuppressedUntil, suppressPollFor, apiToSlider } from "../player";
import { getConfig, patchConfig } from "../settings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listThemes, importTheme, applyTheme, deleteTheme } from "../themes";
import { applySuperAnimated } from "../super-animated";

type View = "home" | "search" | "playlist" | "liked" | "focus" | "settings" | "artist" | "stats";

let curView: View = "home";
let openPlaylistId: string | null = null;
let openArtistId: string | null = null;
let viewEl: HTMLElement;
let searchInput: HTMLInputElement;
let searchSeq = 0;
let lastSearchQ = "";

let viewDisposers: Array<() => void> = [];
function disposeViewSubs() {
  viewDisposers.forEach((d) => { try { d(); } catch {} });
  viewDisposers = [];
}

const BRAND = "Cadence";

const fmt = {
  ms: (ms: number) => {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  },
  esc: (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    ),
};

const idFromUri = (uri: string) => uri.split(":").pop() ?? uri;
const currentTrack = (p: any) => p?.track_window?.current_track ?? p?.item ?? null;
const currentDuration = (p: any) => currentTrack(p)?.duration_ms ?? p?.duration ?? 0;

// ----------------------------------------------------------------- mount

export function renderApp(root: HTMLElement): void {
  root.innerHTML = `
    <div class="titlebar" data-tauri-drag-region>
      <div class="titlebar-brand" data-tauri-drag-region>Cadence</div>
      <div class="titlebar-spacer" data-tauri-drag-region></div>
      <div class="titlebar-btns">
        <button class="tb-btn" id="tb-min" title="Minimize" aria-label="Minimize">
          <svg viewBox="0 0 12 12" width="12" height="12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
        <button class="tb-btn" id="tb-max" title="Maximize" aria-label="Maximize">
          <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2.5" y="2.5" width="7" height="7" rx="0.5"/></svg>
        </button>
        <button class="tb-btn close" id="tb-close" title="Close" aria-label="Close">
          <svg viewBox="0 0 12 12" width="12" height="12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="3" y1="3" x2="9" y2="9"/><line x1="9" y1="3" x2="3" y2="9"/></svg>
        </button>
      </div>
    </div>
    <div class="app">
      <aside class="sidebar">
        <div class="brand">${BRAND}</div>
        <nav class="nav">
          <button class="nav-btn" data-nav="home">Home</button>
          <button class="nav-btn" data-nav="focus">Focus</button>
          <button class="nav-btn" data-nav="settings">Settings</button>
        </nav>
        <div class="sec">
          <div class="sec-h">Pinned</div>
          <ul class="pinned" id="pinned"></ul>
        </div>
        <div class="sec grow">
          <div class="sec-h sec-h-pl">
            <span class="sec-h-label">Playlists</span>
            <input id="pl-filter" class="pl-filter" type="search"
                   autocomplete="off" spellcheck="false" placeholder="Filter…" />
            <button class="ico-btn" id="refresh-pl" title="Refresh">↻</button>
          </div>
          <ul class="playlists" id="playlists"></ul>
        </div>
        <div class="sidebar-foot">
          <button class="ico-btn stats-btn" id="stats-btn" title="Last.fm stats">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="20" x2="21" y2="20"/><rect x="5" y="12" width="3" height="8"/><rect x="10.5" y="6" width="3" height="14"/><rect x="16" y="9" width="3" height="11"/></svg>
          </button>
          <button class="logout" id="logout">Log out</button>
        </div>
      </aside>

      <header class="topbar">
        <div class="search-wrap">
          <input id="search" class="search" type="search" autocomplete="off" spellcheck="false"
                 placeholder="Search tracks, albums, artists" />
          <ul id="search-history" class="search-history" hidden></ul>
        </div>
        <div class="user" id="user"></div>
      </header>

      <main class="view" id="view"></main>

      <footer class="nowbar" id="nowbar"></footer>

      <div id="ctx-menu" class="ctx-menu" hidden></div>
    </div>`;

  viewEl = root.querySelector<HTMLElement>("#view")!;
  searchInput = root.querySelector<HTMLInputElement>("#search")!;

  root.querySelectorAll<HTMLButtonElement>(".nav-btn").forEach((b) => {
    b.addEventListener("click", () => navigate(b.dataset.nav as View));
  });
  root.querySelector<HTMLButtonElement>("#logout")!.addEventListener("click", async () => {
    await auth.logout();
    location.reload();
  });
  root.querySelector<HTMLButtonElement>("#stats-btn")!
    .addEventListener("click", () => navigate("stats"));
  root.querySelector<HTMLButtonElement>("#refresh-pl")!.addEventListener("click", () => {
    cache.playlists = null;
    loadPlaylists(true);
  });

  // Filter sidebar playlists in-place (no re-fetch). Show/hide by class so
  // event listeners on rows stay attached.
  const filterEl = root.querySelector<HTMLInputElement>("#pl-filter")!;
  filterEl.addEventListener("input", () => {
    const q = filterEl.value.trim().toLowerCase();
    const ul = document.getElementById("playlists");
    if (!ul) return;
    ul.querySelectorAll<HTMLLIElement>(".pl-item").forEach((li) => {
      const name = li.querySelector<HTMLElement>(".pl-name")?.textContent ?? "";
      const hit = !q || name.toLowerCase().includes(q);
      li.classList.toggle("hide", !hit);
    });
  });

  searchInput.addEventListener("input", onSearchInput);
  searchInput.addEventListener("focus", () => {
    if (searchInput.value.trim()) navigate("search");
    else renderSearchHistoryDropdown();
  });
  searchInput.addEventListener("blur", () => {
    // Tiny delay so a click inside the dropdown can complete before we hide.
    setTimeout(hideSearchHistoryDropdown, 120);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideSearchHistoryDropdown(); searchInput.blur(); }
  });

  state.view.subscribe((v) => {
    if (v === "search") {
      navigate("search");
      searchInput.focus();
    } else if (v === "focus" || v === "settings" || v === "home") {
      navigate(v as View);
    }
  });

  state.me.subscribe((m) => {
    const el = root.querySelector<HTMLElement>("#user")!;
    if (!m) { el.textContent = ""; return; }
    el.textContent = m.display_name ?? m.id ?? "";
  });

  // Global click hides any open context menu.
  document.addEventListener("click", () => hideCtxMenu(), true);
  window.addEventListener("blur", hideCtxMenu);

  // Single global delegated handler for external http(s) anchors. Beats
  // re-binding per-view; works for any future template that drops in <a>.
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    openUrl(href).catch((err) => console.warn("[opener]", err));
  });

  // Click bounce animation: any .ico-btn or .pulse-on-click flashes a brief
  // bounce keyframe. We toggle the class via reflow so re-clicking restarts
  // the animation instead of being ignored as "no change".
  document.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".ico-btn, .pulse-on-click");
    if (!b) return;
    b.classList.remove("clicked");
    void b.offsetWidth;
    b.classList.add("clicked");
  });

  applyFeatureClasses();

  // Custom title bar — wired to Tauri window APIs.
  const tauriWin = getCurrentWindow();
  document.getElementById("tb-min")!.addEventListener("click", () => tauriWin.minimize());
  document.getElementById("tb-max")!.addEventListener("click", () => tauriWin.toggleMaximize());
  document.getElementById("tb-close")!.addEventListener("click", () => tauriWin.close());

  // Hydrate from localStorage so the first paint shows real data instead
  // of "Loading…" placeholders. Fresh API calls then revalidate.
  persistLoad();

  // Kick off the playlists fetch and re-run prewarm once the network result
  // arrives — schedulePrewarm reads from `cache.playlists`, which on a cold
  // boot is still empty by the time the first prewarm runs. The prefetch
  // dedupes on already-cached entries so the duplicate call is cheap.
  loadPlaylists().then(() => schedulePrewarm());
  renderPinned();
  mountNowBar(root.querySelector<HTMLElement>("#nowbar")!);
  navigate("home");
  startPolling();
  schedulePrewarm();
}

function navigate(v: View) {
  if (v === "search" && curView === "search") return;
  disposeViewSubs();
  curView = v;
  document.querySelectorAll<HTMLButtonElement>(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.nav === v);
  });
  switch (v) {
    case "home":     return renderHome();
    case "search":   return renderSearch();
    case "playlist": return renderPlaylistDetail(openPlaylistId!);
    case "liked":    return renderLiked();
    case "focus":    return renderFocus();
    case "settings": return renderSettings();
    case "artist":   return renderArtist(openArtistId!);
    case "stats":    return renderStats();
  }
}

// ----------------------------------------------------------------- caches

const cache: {
  playlists: any[] | null;
  recents: any[] | null;
  playlistDetail: Map<string, { meta: any; tracks: any[]; total: number; paginating: boolean }>;
  liked: { tracks: any[]; total: number; paginating: boolean } | null;
  pinMeta: Map<string, any>;
  artist: Map<string, { meta: any | null; top: any[]; albums: any[] }>;
} = {
  playlists: null,
  recents: null,
  playlistDetail: new Map(),
  liked: null,
  pinMeta: new Map(),
  artist: new Map(),
};

// Cap on retained playlist-detail entries. Each entry holds the full
// tracks array of an opened playlist — for power users with hundreds of
// pinned/followed playlists, an unbounded Map grew into tens of MB of
// retained JS objects across a session. 30 covers a typical hot-set
// (recents + pins + ~20 click-throughs) without keeping stale ones live.
const PLAYLIST_DETAIL_CAP = 30;

/** LRU-by-recency setter for `cache.playlistDetail`. Map preserves insertion
 *  order, so we delete-then-set to bubble the just-touched entry to the end
 *  and evict the head when over cap. Call this anywhere we'd otherwise do
 *  `cache.playlistDetail.set(id, entry)` directly, so the eviction stays
 *  in one place. */
function setPlaylistDetail(id: string, entry: any) {
  cache.playlistDetail.delete(id);
  cache.playlistDetail.set(id, entry);
  while (cache.playlistDetail.size > PLAYLIST_DETAIL_CAP) {
    const oldest = cache.playlistDetail.keys().next().value;
    if (oldest === undefined) break;
    cache.playlistDetail.delete(oldest);
  }
}

/** Reorder an existing entry to the end of the LRU without changing its
 *  contents — called from the open-playlist path so a re-visit refreshes
 *  the recency without re-fetching. No-op if the entry doesn't exist. */
function touchPlaylistDetail(id: string) {
  const e = cache.playlistDetail.get(id);
  if (!e) return;
  cache.playlistDetail.delete(id);
  cache.playlistDetail.set(id, e);
}

// ----------------------------------------------------------------- persistence
// Bootstrap a warm cache from localStorage so home + sidebar paint instantly,
// then revalidate in the background. We bump the version when the schema
// changes so old payloads get ignored.
// v3 introduced slimming but accidentally re-wrapped already-unwrapped
// playlist tracks into `{added_at, track}` envelopes — trackList then
// rendered nothing. v4 stores bare slim tracks, matching the in-memory
// shape. Old v2/v3 blobs are dropped on load.
const PERSIST_KEY = "cadence:cache:v4";
const PERSIST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface Persisted {
  v: 4;
  ts: number;
  playlists?: any[];
  recents?: any[];
  pinMeta?: Record<string, any>;
  liked?: any | null;
  playlistDetail?: Record<string, any>;
}

function persistLoad() {
  // Drop old keys unconditionally — stale blobs would otherwise sit in
  // localStorage forever, eating quota from the active key.
  try { localStorage.removeItem("cadence:cache:v2"); } catch {}
  try { localStorage.removeItem("cadence:cache:v3"); } catch {}
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return;
    const p = JSON.parse(raw) as Persisted;
    if (p.v !== 4) return;
    if (Date.now() - p.ts > PERSIST_TTL_MS) return;
    if (p.playlists) cache.playlists = p.playlists;
    if (p.recents) cache.recents = p.recents;
    if (p.liked) cache.liked = p.liked;
    if (p.pinMeta) for (const [k, v] of Object.entries(p.pinMeta)) cache.pinMeta.set(k, v);
    if (p.playlistDetail) {
      for (const [k, v] of Object.entries(p.playlistDetail)) {
        setPlaylistDetail(k, v as any);
      }
    }
  } catch {}
}

// Spotify track payloads carry a 200+ entry `available_markets` array, plus
// `external_urls`, `external_ids`, `preview_url`, `linked_from`, `restrictions`,
// etc. — none of which any UI code touches. Slimming each track down to just
// the fields actually used cuts the cached blob by ~70-80% (was 6.91 MB →
// stays well under the 5 MB localStorage cap with the same playlist count).
function slimImage(im: any) {
  if (!im) return undefined;
  return { url: im.url, height: im.height ?? null, width: im.width ?? null };
}
function slimArtist(a: any) {
  if (!a) return undefined;
  return { id: a.id, uri: a.uri, name: a.name };
}
function slimAlbum(al: any) {
  if (!al) return undefined;
  return {
    id: al.id,
    uri: al.uri,
    name: al.name,
    images: Array.isArray(al.images) ? al.images.map(slimImage) : undefined,
  };
}
function slimTrack(t: any) {
  if (!t) return t;
  return {
    id: t.id,
    uri: t.uri,
    name: t.name,
    duration_ms: t.duration_ms,
    artists: Array.isArray(t.artists) ? t.artists.map(slimArtist) : [],
    album: slimAlbum(t.album),
  };
}
function slimPlaylistMeta(m: any) {
  if (!m) return m;
  return {
    id: m.id,
    uri: m.uri,
    name: m.name,
    description: m.description,
    images: Array.isArray(m.images) ? m.images.map(slimImage) : undefined,
    owner: m.owner ? { id: m.owner.id, display_name: m.owner.display_name } : undefined,
    tracks: m.tracks ? { total: m.tracks.total } : undefined,
  };
}

let persistTimer: number | undefined;
function persistSave() {
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    try {
      const detail: Record<string, any> = {};
      // Cap stored playlist tracks to 100 each (down from 200 — most users
      // never scroll past the first ~50, and a fresh fetch fills more in
      // the background when they do). NOTE: in-memory cache.playlistDetail
      // tracks are *unwrapped* track objects (the parsing code unwraps the
      // `{added_at, track}` envelope on fetch), so slim them as bare tracks.
      // Wrapping them back into envelopes would store rows without a `.uri`,
      // which trackList then silently skipped → empty playlist views.
      cache.playlistDetail.forEach((v, k) => {
        if (!v.meta) return;
        detail[k] = {
          meta: slimPlaylistMeta(v.meta),
          tracks: v.tracks.slice(0, 100).map(slimTrack),
          total: v.total,
          paginating: false,
        };
      });
      const blob: Persisted = {
        v: 4, ts: Date.now(),
        playlists: cache.playlists?.map(slimPlaylistMeta),
        recents: cache.recents?.map(slimTrack),
        liked: cache.liked
          ? {
              ...cache.liked,
              tracks: cache.liked.tracks.slice(0, 100).map(slimTrack),
              paginating: false,
            }
          : undefined,
        pinMeta: Object.fromEntries(
          Array.from(cache.pinMeta.entries()).map(([k, v]) => [k, slimPlaylistMeta(v)]),
        ),
        playlistDetail: detail,
      };
      localStorage.setItem(PERSIST_KEY, JSON.stringify(blob));
    } catch {}
  }, 1000);
}

async function loadPlaylists(force = false): Promise<any[]> {
  const ul = document.getElementById("playlists")!;
  if (cache.playlists && !force) {
    renderPlaylistsSidebar(cache.playlists);
  } else {
    ul.innerHTML = `<li class="dim">Loading…</li>`;
  }
  try {
    // Paginate all pages — `/me/playlists` returns owned + followed
    // playlists, but only 50 at a time. If the user has more than 50,
    // followed playlists from other users would otherwise be cut off.
    const all: any[] = [];
    let offset = 0;
    const PAGE = 50;
    while (true) {
      const r: any = await api.raw("GET", "/me/playlists",
        [["limit", String(PAGE)], ["offset", String(offset)]]);
      const items = r?.items ?? [];
      all.push(...items);
      if (items.length < PAGE) break;
      offset += PAGE;
      // Render the first page immediately so the sidebar populates fast,
      // then keep fetching in the background.
      if (offset === PAGE) {
        cache.playlists = all.slice();
        renderPlaylistsSidebar(cache.playlists);
      }
      if (offset >= 1000) break; // sanity cap
    }
    cache.playlists = all;
    renderPlaylistsSidebar(cache.playlists);
    persistSave();
    return cache.playlists;
  } catch {
    if (!cache.playlists) ul.innerHTML = `<li class="dim">Couldn't load.</li>`;
    return cache.playlists ?? [];
  }
}

function renderPlaylistsSidebar(items: any[]) {
  const ul = document.getElementById("playlists")!;
  if (!items.length) {
    ul.innerHTML = `<li class="dim">No playlists.</li>`;
    return;
  }
  const pinned = new Set(getConfig().pinnedPlaylists ?? []);
  const liked = `<li class="pl-item" data-id="liked-songs">
      <span class="pl-name">♥ Liked Songs</span>
      <button class="pin-btn ${pinned.has("liked-songs") ? "on" : ""}" title="Pin"
              data-pin="liked-songs">${pinned.has("liked-songs") ? "★" : "☆"}</button>
    </li>`;
  ul.innerHTML = liked + items
    .map((p) => {
      const id = idFromUri(p.uri);
      const total = p.tracks?.total ?? 0;
      const isP = pinned.has(id);
      return `<li class="pl-item" data-id="${fmt.esc(id)}" data-uri="${fmt.esc(p.uri)}">
        <span class="pl-name" title="${fmt.esc(p.name)}">${fmt.esc(p.name)}</span>
        <span class="pl-count dim small">${total}</span>
        <button class="pin-btn ${isP ? "on" : ""}" title="${isP ? "Unpin" : "Pin"}"
                data-pin="${fmt.esc(id)}">${isP ? "★" : "☆"}</button>
      </li>`;
    })
    .join("");

  ul.querySelectorAll<HTMLLIElement>(".pl-item").forEach((li) => {
    li.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".pin-btn")) return;
      openListItem(li.dataset.id!);
    });
    // Pre-fetch detail on hover so click → detail render is instant.
    li.addEventListener("mouseenter", () => prefetchPlaylistDetail(li.dataset.id!), { once: true });
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const id = li.dataset.id!;
      const isP = pinned.has(id);
      showCtxMenu(e, [
        { label: "Open", fn: () => openListItem(id) },
        { label: "Play", fn: () => {
          const ctx = id === "liked-songs"
            ? `spotify:user:${state.me.get()?.id}:collection`
            : `spotify:playlist:${id}`;
          playback.start({ contextUri: ctx });
        }},
        { label: isP ? "Unpin" : "Pin", fn: () => togglePin(id) },
      ]);
    });
  });
  ul.querySelectorAll<HTMLButtonElement>(".pin-btn").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(b.dataset.pin!);
    });
  });
}

function openListItem(id: string) {
  if (id === "liked-songs") return navigate("liked");
  openPlaylistId = id;
  navigate("playlist");
}

function togglePin(id: string) {
  const cfg = getConfig();
  const pins = new Set(cfg.pinnedPlaylists ?? []);
  if (pins.has(id)) pins.delete(id);
  else pins.add(id);
  patchConfig({ pinnedPlaylists: [...pins] }).then(() => {
    renderPinned();
    if (cache.playlists) renderPlaylistsSidebar(cache.playlists);
    if (curView === "home") renderHome();
    // Prefetch any newly-pinned playlist so its first open is instant.
    if (id !== "liked-songs") prefetchPlaylistDetail(id);
  });
}

function renderPinned() {
  const ul = document.getElementById("pinned")!;
  const pins = (getConfig().pinnedPlaylists ?? []).slice(0, 8);
  if (!pins.length) {
    ul.innerHTML = `<li class="dim small">★ a playlist to pin.</li>`;
    return;
  }
  ul.innerHTML = pins
    .map((id) => {
      const meta = cache.pinMeta.get(id);
      const name =
        id === "liked-songs"
          ? "♥ Liked Songs"
          : meta?.name ?? "…";
      return `<li class="pin-li" data-id="${fmt.esc(id)}" title="${fmt.esc(name)}">${fmt.esc(name)}</li>`;
    })
    .join("");
  ul.querySelectorAll<HTMLLIElement>(".pin-li").forEach((li) => {
    li.addEventListener("click", () => openListItem(li.dataset.id!));
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const id = li.dataset.id!;
      showCtxMenu(e, [
        { label: "Open", fn: () => openListItem(id) },
        { label: "Play", fn: () => {
          const ctx = id === "liked-songs"
            ? `spotify:user:${state.me.get()?.id}:collection`
            : `spotify:playlist:${id}`;
          playback.start({ contextUri: ctx });
        }},
        { label: "Unpin", fn: () => togglePin(id) },
      ]);
    });
  });
  pins.forEach((id) => {
    if (id === "liked-songs" || cache.pinMeta.has(id)) return;
    api.raw("GET", `/playlists/${id}`, [["fields", "name,images"]])
      .then((p: any) => { cache.pinMeta.set(id, p); persistSave(); renderPinned(); })
      .catch(() => {});
  });
}

// ----------------------------------------------------------------- views

function renderHome() {
  const hour = new Date().getHours();
  const greet =
    hour < 5 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const features = getConfig().features ?? {};
  const showRecents = features.showRecents !== false;
  const showClock = features.showClock !== false;

  const showCat = features.homeCatPhoto === true;
  const showJoke = features.homeDadJoke === true;
  const showNews = features.homeNews === true;
  const showViz = features.homeVisualizer === true;
  const anyExtras = showCat || showJoke || showNews || showViz;

  viewEl.innerHTML = `
    <div class="page home-page">
      <div class="home-head">
        <h1 class="hello">Good ${greet}.</h1>
        ${showClock ? `<div class="home-clock" id="home-clock"></div>` : ""}
      </div>

      <div id="home-pins"></div>

      ${anyExtras ? `
        <div class="home-extras">
          ${showViz ? `<div class="home-card home-viz" id="home-viz"><div class="home-card-h">Audio visualizer</div><div class="home-card-body viz-body"><canvas id="viz-canvas" width="320" height="120"></canvas></div></div>` : ""}
          ${showNews ? `<div class="home-card home-news" id="home-news"><div class="home-card-h">The Hacker News · cybersecurity</div><div class="home-card-body dim">Loading…</div></div>` : ""}
          ${showJoke ? `<div class="home-card home-joke" id="home-joke"><div class="home-card-h">Dad joke</div><div class="home-card-body">Loading…</div></div>` : ""}
          ${showCat ? `<div class="home-card home-cat" id="home-cat"><div class="home-card-h">Cat</div><div class="home-card-body cat-body"><div class="dim small">Loading…</div></div></div>` : ""}
        </div>
      ` : ""}

      ${showRecents ? `
        <h2 class="sub">Recently played</h2>
        <div id="recents"></div>
      ` : ""}
    </div>`;

  if (showCat) loadCatPhoto();
  if (showJoke) loadDadJoke();
  if (showNews) loadHackerNews();
  if (showViz) startVisualizer();

  if (showClock) startHomeClock();

  drawHomePins();

  if (showRecents) {
    const dest = document.getElementById("recents")!;
    if (cache.recents) {
      dest.innerHTML = "";
      dest.appendChild(trackList(cache.recents, { showAlbum: false }));
    } else {
      dest.innerHTML = `<p class="dim">Loading…</p>`;
      api.raw("GET", "/me/player/recently-played", [["limit", "20"]])
        .then((r: any) => {
          cache.recents = (r?.items ?? []).map((it: any) => it.track).filter(Boolean);
          persistSave();
          if (curView !== "home") return;
          dest.innerHTML = "";
          if (!cache.recents!.length) {
            dest.innerHTML = `<p class="dim">Nothing yet.</p>`;
            return;
          }
          dest.appendChild(trackList(cache.recents!, { showAlbum: false }));
        })
        .catch(() => {
          if (!cache.recents) dest.innerHTML = `<p class="dim">Couldn't load.</p>`;
        });
    }
  }
}

// ----- Home audio visualizer ------------------------------------------
// Polls Rust spectrum_get every animation frame, smooths transitions, draws
// 8 vertical bars. Falls flat (zeros) when the librespot+EQ pipeline isn't
// running — that's the only path with PCM access.
let vizRaf: number | undefined;
let vizDisplay: number[] = new Array(8).fill(0);
async function startVisualizer() {
  const canvas = document.getElementById("viz-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Match the canvas backing buffer to actual rendered size × devicePixelRatio
  // so the bars render at native sharpness instead of being stretched. We
  // observe the host card and re-fit on resize.
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(canvas);

  const { spectrum } = await import("../api");

  let lastSpectrum: number[] = new Array(8).fill(0);
  let pollInflight = false;
  let warned = false;
  const poll = async () => {
    if (pollInflight) return;
    pollInflight = true;
    try {
      const v = await spectrum.get();
      if (Array.isArray(v) && v.length === 8) lastSpectrum = v;
    } catch (e) {
      if (!warned) {
        console.warn("[viz] spectrum_get failed (audio backend is probably SDK; switch to librespot+EQ to see real bars):", e);
        warned = true;
      }
    }
    pollInflight = false;
  };
  // Poll Rust at 30 Hz, draw at full RAF rate using interpolation.
  const pollTimer = window.setInterval(poll, 33);
  poll();

  const tick = () => {
    if (!document.getElementById("viz-canvas")) {
      clearInterval(pollTimer);
      vizRaf = undefined;
      return;
    }
    // Smooth toward the latest sample for buttery animation.
    const k = 0.25;
    for (let i = 0; i < 8; i++) {
      const cur = vizDisplay[i] ?? 0;
      const tgt = lastSpectrum[i] ?? 0;
      vizDisplay[i] = cur + (tgt - cur) * k;
    }
    drawVizFrame(ctx, canvas, vizDisplay);
    vizRaf = requestAnimationFrame(tick);
  };
  vizRaf = requestAnimationFrame(tick);
  // If user navigates away, the canvas disappears — tick() catches that
  // and stops itself; the interval is also cleared inside.
  viewDisposers.push(() => {
    if (vizRaf !== undefined) cancelAnimationFrame(vizRaf);
    vizRaf = undefined;
    clearInterval(pollTimer);
    ro.disconnect();
  });
}

function drawVizFrame(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, values: number[]) {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const n = values.length;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  // Use device-pixel units so bars are crisp; everything below scales by dpr.
  const padding = 8 * dpr;
  const gap = 6 * dpr;
  const totalGap = gap * (n - 1);
  const barW = (w - 2 * padding - totalGap) / n;
  const radius = Math.min(barW / 2, 4 * dpr);
  for (let i = 0; i < n; i++) {
    // Visual scaling: bandpass RMS clusters low. sqrt + boost reads cleaner.
    const v = Math.min(1, Math.sqrt(Math.max(0, values[i]!) * 5));
    const bh = Math.max(2 * dpr, v * (h - 2 * padding));
    const x = padding + i * (barW + gap);
    const y = h - padding - bh;
    const grad = ctx.createLinearGradient(0, y, 0, h - padding);
    grad.addColorStop(0, "rgba(30,215,96,.95)");
    grad.addColorStop(1, "rgba(30,215,96,.30)");
    ctx.fillStyle = grad;
    // Pure rounded-rect (top corners only) using path API.
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + barW - radius, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + radius);
    ctx.lineTo(x + barW, h - padding);
    ctx.lineTo(x, h - padding);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
  }
}

// ----- Home extras (cataas / dad joke / Hacker News) ------------------
async function loadCatPhoto() {
  const card = document.getElementById("home-cat");
  if (!card) return;
  const body = card.querySelector<HTMLElement>(".home-card-body");
  if (!body) return;
  // cataas returns the image directly. Add a cache-buster so click-refresh
  // gets a fresh cat instead of a memoized one.
  const url = `https://cataas.com/cat?width=560&t=${Date.now()}`;
  body.innerHTML = `<img class="cat-img" loading="lazy" alt="cat" />`;
  const img = body.querySelector<HTMLImageElement>("img")!;
  img.src = url;
  img.onerror = () => { body.innerHTML = `<div class="dim small">Couldn't load cat.</div>`; };
  card.onclick = () => loadCatPhoto();
}

async function loadDadJoke() {
  const card = document.getElementById("home-joke");
  if (!card) return;
  const body = card.querySelector<HTMLElement>(".home-card-body");
  if (!body) return;
  try {
    const r = await fetch("https://icanhazdadjoke.com/", {
      headers: { Accept: "application/json" },
    });
    const j = await r.json();
    body.textContent = j.joke ?? "—";
  } catch {
    body.textContent = "Couldn't fetch a joke.";
  }
  card.onclick = () => loadDadJoke();
}

async function loadHackerNews() {
  const card = document.getElementById("home-news");
  if (!card) return;
  const body = card.querySelector<HTMLElement>(".home-card-body");
  if (!body) return;
  // The Hacker News (cybersecurity news at thehackernews.com) doesn't expose
  // a JSON API; their RSS feed is at feeds.feedburner.com/TheHackersNews.
  // Use rss2json (free, no key) to convert to JSON cleanly.
  try {
    const url = "https://api.rss2json.com/v1/api.json?rss_url=" +
      encodeURIComponent("https://feeds.feedburner.com/TheHackersNews");
    const r = await fetch(url);
    const j = await r.json();
    const items = (j?.items ?? []).slice(0, 5);
    if (!items.length) { body.textContent = "No stories."; return; }
    body.innerHTML = `<ol class="news-list">${items.map((it: any) => {
      const link = it?.link ?? "https://thehackernews.com/";
      const date = it?.pubDate ? new Date(it.pubDate).toLocaleDateString(undefined,
        { month: "short", day: "numeric" }) : "";
      const author = it?.author ? ` · ${it.author}` : "";
      return `<li>
        <a class="news-title" href="${fmt.esc(link)}" target="_blank" rel="noopener">${fmt.esc(it?.title ?? "?")}</a>
        <div class="dim small">${fmt.esc(date)}${fmt.esc(author)} · thehackernews.com</div>
      </li>`;
    }).join("")}</ol>`;
  } catch (e) {
    body.textContent = `Couldn't load news (${String(e)}).`;
  }
}

let clockTimer: number | undefined;
function startHomeClock() {
  const tick = () => {
    const el = document.getElementById("home-clock");
    if (!el) {
      if (clockTimer) { clearInterval(clockTimer); clockTimer = undefined; }
      return;
    }
    const d = new Date();
    el.textContent = d.toLocaleTimeString(undefined,
      { hour: "2-digit", minute: "2-digit", hour12: false });
  };
  tick();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = window.setInterval(tick, 30_000);
  viewDisposers.push(() => {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = undefined; }
  });
}

function drawHomePins() {
  const dest = document.getElementById("home-pins");
  if (!dest) return;
  const pins = (getConfig().pinnedPlaylists ?? []).slice(0, 12);
  if (!pins.length) {
    dest.innerHTML = `<p class="dim small">Pin a playlist (★ in the sidebar) to see it here.</p>`;
    return;
  }
  dest.innerHTML = `<div class="home-pin-grid">${pins.map((id) => {
    const meta = cache.pinMeta.get(id);
    if (id === "liked-songs") {
      return `<button class="home-pin liked" data-id="liked-songs">
        <div class="home-pin-art liked-mini">♥</div>
        <div class="home-pin-name">Liked Songs</div>
      </button>`;
    }
    const cover = meta?.images?.[0]?.url ?? "";
    const name = meta?.name ?? "…";
    return `<button class="home-pin" data-id="${fmt.esc(id)}">
      ${cover ? `<img class="home-pin-art" loading="lazy" src="${fmt.esc(cover)}" />`
              : `<div class="home-pin-art ph"></div>`}
      <div class="home-pin-name">${fmt.esc(name)}</div>
    </button>`;
  }).join("")}</div>`;

  dest.querySelectorAll<HTMLButtonElement>(".home-pin").forEach((b) => {
    b.addEventListener("click", () => openListItem(b.dataset.id!));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const id = b.dataset.id!;
      showCtxMenu(e, [
        { label: "Open", fn: () => openListItem(id) },
        { label: "Play", fn: () => {
          const ctx = id === "liked-songs"
            ? `spotify:user:${state.me.get()?.id}:collection`
            : `spotify:playlist:${id}`;
          playback.start({ contextUri: ctx });
        }},
        { label: "Unpin", fn: () => togglePin(id) },
      ]);
    });
  });

  // Lazy-fetch any missing pin metadata for richer cards.
  pins.forEach((id) => {
    if (id === "liked-songs" || cache.pinMeta.has(id)) return;
    api.raw("GET", `/playlists/${id}`, [["fields", "name,images"]])
      .then((p: any) => { cache.pinMeta.set(id, p); if (curView === "home") drawHomePins(); })
      .catch(() => {});
  });
}

function renderSearch() {
  viewEl.innerHTML = `<div class="page"><div id="search-out"></div></div>`;
  const out = document.getElementById("search-out")!;
  const q = searchInput.value.trim();
  if (!q) { out.innerHTML = `<p class="dim">Type to search.</p>`; return; }
  if (q.length < 2) { out.innerHTML = `<p class="dim">Keep typing…</p>`; return; }
  const r = state.searchResults.get();
  const tracks: any[] = r?.tracks?.items ?? [];
  const artists: any[] = r?.artists?.items ?? [];
  out.innerHTML = "";

  if (artists.length) {
    const h = document.createElement("h2");
    h.className = "sub";
    h.textContent = "Artists";
    out.appendChild(h);
    const row = document.createElement("div");
    row.className = "artist-row";
    artists.slice(0, 6).forEach((a) => {
      const img = a.images?.[1]?.url ?? a.images?.[0]?.url ?? "";
      const card = document.createElement("button");
      card.className = "artist-card";
      card.innerHTML = `
        ${img ? `<img loading="lazy" src="${fmt.esc(img)}" />` : `<div class="ph round"></div>`}
        <div class="artist-name">${fmt.esc(a.name)}</div>
        <div class="dim small">Artist</div>`;
      card.addEventListener("click", () => {
        openArtistId = a.id;
        navigate("artist");
      });
      row.appendChild(card);
    });
    out.appendChild(row);
  }

  if (tracks.length) {
    const h = document.createElement("h2");
    h.className = "sub";
    h.textContent = "Tracks";
    out.appendChild(h);
    out.appendChild(trackList(tracks, { showAlbum: true, showQueueButton: true }));
  } else if (!artists.length) {
    out.innerHTML = `<p class="dim">No results.</p>`;
  }
}

// ----------------------------------------------------------------- search history
//
// Spotify Web API has no public search-history endpoint (recently-played is
// for tracks, not queries). Keep it client-side: last 20 unique queries in
// localStorage, surfaced as a dropdown when the search input is empty/focused.
const SEARCH_HISTORY_KEY = "cadence:search-history";
const SEARCH_HISTORY_CAP = 20;

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function pushSearchHistory(q: string) {
  const t = q.trim();
  if (!t) return;
  const cur = loadSearchHistory().filter((x) => x.toLowerCase() !== t.toLowerCase());
  cur.unshift(t);
  cur.length = Math.min(cur.length, SEARCH_HISTORY_CAP);
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(cur)); } catch {}
}
function clearSearchHistoryItem(q: string) {
  const cur = loadSearchHistory().filter((x) => x !== q);
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(cur)); } catch {}
}
function renderSearchHistoryDropdown() {
  const ul = document.getElementById("search-history") as HTMLUListElement | null;
  if (!ul) return;
  const items = loadSearchHistory();
  if (!items.length) { ul.hidden = true; ul.innerHTML = ""; return; }
  ul.innerHTML = items.map((q) => `
    <li class="sh-row" data-q="${fmt.esc(q)}">
      <span class="sh-icon">↻</span>
      <span class="sh-q">${fmt.esc(q)}</span>
      <button class="sh-x" data-clear="${fmt.esc(q)}" title="Remove">×</button>
    </li>`).join("");
  ul.hidden = false;
  ul.querySelectorAll<HTMLLIElement>(".sh-row").forEach((li) => {
    li.addEventListener("mousedown", (e) => {
      // mousedown (not click) so it fires before the input's blur hides us.
      if ((e.target as HTMLElement).closest(".sh-x")) return;
      const q = li.dataset.q!;
      searchInput.value = q;
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.blur();
    });
  });
  ul.querySelectorAll<HTMLButtonElement>(".sh-x").forEach((b) => {
    b.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      clearSearchHistoryItem(b.dataset.clear!);
      renderSearchHistoryDropdown();
    });
  });
}
function hideSearchHistoryDropdown() {
  const ul = document.getElementById("search-history");
  if (ul) ul.hidden = true;
}

function onSearchInput() {
  const q = searchInput.value.trim();
  if (q === "") {
    // Empty input + focused = show history.
    if (document.activeElement === searchInput) renderSearchHistoryDropdown();
  } else {
    hideSearchHistoryDropdown();
  }
  if (curView !== "search" && q) navigate("search");
  if (q === lastSearchQ) return;
  lastSearchQ = q;
  if (q.length < 2) {
    state.searchResults.set(null);
    if (curView === "search") renderSearch();
    return;
  }
  const my = ++searchSeq;
  setTimeout(() => {
    if (my !== searchSeq) return;
    api.search(q, "track,album,artist", 20)
      .then((r: any) => {
        if (my !== searchSeq) return;
        state.searchResults.set(r);
        // Only commit to history once we got a successful search back, so
        // typos that the user immediately corrects don't pollute the list.
        pushSearchHistory(q);
        if (curView === "search") renderSearch();
      })
      .catch(() => {});
  }, 200);
}

function renderPlaylistDetail(id: string) {
  let entry = cache.playlistDetail.get(id);
  viewEl.innerHTML = `
    <div class="page">
      <button class="back" data-back>← Back</button>
      <div class="hero" id="hero">Loading…</div>
      <div id="pl-tracks"></div>
    </div>`;
  viewEl.querySelector<HTMLButtonElement>("[data-back]")!
    .addEventListener("click", () => navigate("home"));

  // Stale-while-revalidate: paint the cached version immediately (so the
  // page feels instant), then always refetch in the background so edits
  // made on other devices — adding a track on the phone, reordering on
  // web — propagate without the user having to "force refresh". The
  // snapshot_id check below avoids redundantly trashing the cached tail
  // when nothing actually changed.
  if (entry?.meta) {
    drawPlaylistDetail(id);
    if (entry.tracks.length < entry.total) paginatePlaylist(id, entry);
  }

  // Dedupe concurrent fetches for the same playlist (e.g. prewarm + click).
  if (entry && (entry as any).__fetching) return;
  if (!entry) {
    entry = { meta: null, tracks: [], total: 0, paginating: false };
    setPlaylistDetail(id, entry);
  } else {
    touchPlaylistDetail(id);
  }
  (entry as any).__fetching = true;
  api.raw("GET", `/playlists/${id}`)
    .then((p: any) => {
      const prevSnap = entry!.meta?.snapshot_id;
      const nextSnap = p?.snapshot_id;
      entry!.meta = p;
      entry!.total = p?.tracks?.total ?? p?.items?.total ?? 0;
      // Only blow away the cached tracks when the playlist actually changed.
      // Otherwise a refetch after pagination has filled in pages 2..N would
      // truncate back to the first 100.
      if (!prevSnap || prevSnap !== nextSnap || entry!.tracks.length === 0) {
        const rawItems = p?.tracks?.items ?? p?.items?.items ?? [];
        entry!.tracks = rawItems
          .map((it: any) => it?.track ?? it?.item)
          .filter((t: any) => t && t.uri);
      }
      (entry as any).__fetching = false;
      persistSave();
      if (entry!.tracks.length < entry!.total) paginatePlaylist(id, entry!);
      if (curView === "playlist" && openPlaylistId === id) drawPlaylistDetail(id);
    })
    .catch((e: any) => {
      (entry as any).__fetching = false;
      // Only surface the error inline when there's nothing cached to fall
      // back on — otherwise the stale view is better than blanking the page.
      if (!entry!.meta) {
        const h = document.getElementById("hero");
        if (h) h.innerHTML = `<p class="dim">Error: ${fmt.esc(e)}</p>`;
      }
    });
}

function drawPlaylistDetail(id: string) {
  const entry = cache.playlistDetail.get(id);
  if (!entry || !entry.meta) return;
  const m = entry.meta;
  const cover = m.images?.[0]?.url ?? "";
  const ctx = `spotify:playlist:${id}`;
  const hero = document.getElementById("hero")!;
  hero.classList.add("hero-grid");
  hero.innerHTML = `
    ${cover ? `<img class="hero-art" src="${fmt.esc(cover)}" loading="lazy" />` : `<div class="hero-art placeholder"></div>`}
    <div class="hero-meta">
      <div class="kicker">Playlist</div>
      <h1>${fmt.esc(m.name)}</h1>
      ${m.description ? `<p class="desc">${fmt.esc(m.description)}</p>` : ""}
      <p class="dim">${fmt.esc(m.owner?.display_name ?? "")} · ${entry.total} tracks</p>
      <div class="actions">
        <button class="primary" data-act="play">Play</button>
        <button data-act="shuffle">Shuffle</button>
      </div>
    </div>`;
  hero.querySelector<HTMLButtonElement>('[data-act="play"]')!
    .addEventListener("click", () => playback.start({ contextUri: ctx }));
  hero.querySelector<HTMLButtonElement>('[data-act="shuffle"]')!
    .addEventListener("click", () => {
      api.raw("PUT", "/me/player/shuffle", [["state", "true"]]).catch(() => {});
      playback.start({ contextUri: ctx });
    });

  const dest = document.getElementById("pl-tracks")!;
  dest.innerHTML = "";
  dest.appendChild(trackList(entry.tracks, { showAlbum: true, contextUri: ctx }));
}

// Kick off a background fetch of a playlist's detail (meta + first 100
// tracks). Cheap network-wise; massive UX win because the click → detail
// render becomes instant. No-op if we already have meta cached.
function prefetchPlaylistDetail(id: string) {
  if (id === "liked-songs") return;
  const existing = cache.playlistDetail.get(id);
  if (existing?.meta) return;
  if (existing && (existing as any).__fetching) return;
  const entry: any = existing ?? { meta: null, tracks: [], total: 0, paginating: false };
  entry.__fetching = true;
  setPlaylistDetail(id, entry);
  api.raw("GET", `/playlists/${id}`)
    .then((p: any) => {
      entry.meta = p;
      entry.total = p?.tracks?.total ?? p?.items?.total ?? 0;
      const rawItems = p?.tracks?.items ?? p?.items?.items ?? [];
      entry.tracks = rawItems.map((it: any) => it?.track ?? it?.item).filter((t: any) => t && t.uri);
      entry.__fetching = false;
      persistSave();
      // If user is currently viewing this exact playlist, paint the result.
      if (curView === "playlist" && openPlaylistId === id) drawPlaylistDetail(id);
    })
    .catch(() => {
      entry.__fetching = false;
      cache.playlistDetail.delete(id);
    });
}

// On boot (and when pins change) prefetch playlist details in idle time so
// click → detail is instant. Pins go first (always, no cap) since they're
// the user's "favorites"; then we also prewarm the first slice of the
// `/me/playlists` library so followed/saved playlists from other users
// don't have to do a cold fetch on first click. Capped to keep API quota
// and localStorage size sane on accounts with hundreds of playlists.
const PREWARM_LIBRARY_CAP = 12;
const PREWARM_CONCURRENCY = 3;
// Track prewarm queue across calls so the second invocation (after
// loadPlaylists resolves) doesn't pile new tasks on top of an already-running
// one — would have caused the 429 burst that blanked out playlists.
const prewarmQueued = new Set<string>();
let prewarmInFlight = 0;
async function runPrewarmQueue(queue: string[]) {
  while (queue.length || prewarmInFlight > 0) {
    while (prewarmInFlight < PREWARM_CONCURRENCY && queue.length) {
      const id = queue.shift()!;
      prewarmInFlight += 1;
      // prefetchPlaylistDetail is fire-and-forget; poll its in-flight flag
      // to know when to release the slot. This keeps us at ≤3 concurrent
      // /playlists/{id} requests instead of spraying ~12 at once.
      const release = () => { prewarmInFlight -= 1; prewarmQueued.delete(id); };
      prefetchPlaylistDetail(id);
      const entry: any = cache.playlistDetail.get(id);
      if (!entry?.__fetching) { release(); continue; }
      const tick = () => {
        const e: any = cache.playlistDetail.get(id);
        if (!e || !e.__fetching) release();
        else setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
function schedulePrewarm() {
  const run = () => {
    const pins = getConfig().pinnedPlaylists ?? [];
    const queue: string[] = [];
    const enqueue = (id: string) => {
      if (!id || id === "liked-songs") return;
      if (prewarmQueued.has(id)) return;
      const existing = cache.playlistDetail.get(id);
      if (existing?.meta) return;
      prewarmQueued.add(id);
      queue.push(id);
    };
    for (const id of pins) enqueue(id);
    const lib = cache.playlists ?? [];
    let added = 0;
    for (let i = 0; i < lib.length && added < PREWARM_LIBRARY_CAP; i++) {
      const id = idFromUri(lib[i]?.uri ?? "");
      const before = prewarmQueued.size;
      enqueue(id);
      if (prewarmQueued.size > before) added += 1;
    }
    if (queue.length) runPrewarmQueue(queue);
  };
  if ("requestIdleCallback" in window) {
    (window as any).requestIdleCallback(run, { timeout: 3000 });
  } else {
    setTimeout(run, 1500);
  }
}

async function paginatePlaylist(id: string, entry: any) {
  if (entry.paginating) return;
  entry.paginating = true;
  const PAGE = 100, CONC = 5;
  let off = entry.tracks.length;
  try {
    while (off < entry.total) {
      const batch: Promise<{ off: number; items: any[] }>[] = [];
      for (let i = 0; i < CONC && off < entry.total; i++) {
        const o = off; off += PAGE;
        batch.push(
          api.raw("GET", `/playlists/${id}/tracks`, [
            ["offset", String(o)], ["limit", String(PAGE)],
            ["additional_types", "track"],
          ]).then((r: any) => ({
            off: o,
            items: (r?.items ?? []).map((it: any) => it.track).filter((t: any) => t && t.uri),
          })),
        );
      }
      const pages = await Promise.all(batch);
      pages.sort((a, b) => a.off - b.off);
      for (const p of pages) entry.tracks.push(...p.items);
      if (curView === "playlist" && openPlaylistId === id) drawPlaylistDetail(id);
    }
  } catch (e) {
    console.warn("[playlists] paginate failed", e);
  } finally {
    entry.paginating = false;
  }
}

function renderLiked() {
  let entry = cache.liked;
  viewEl.innerHTML = `
    <div class="page">
      <button class="back" data-back>← Back</button>
      <div class="hero hero-grid">
        <div class="hero-art liked-art">♥</div>
        <div class="hero-meta">
          <div class="kicker">Playlist</div>
          <h1>Liked Songs</h1>
          <p class="dim" id="liked-count">…</p>
          <div class="actions">
            <button class="primary" id="liked-play">Play</button>
            <button id="liked-shuf">Shuffle</button>
          </div>
        </div>
      </div>
      <div id="liked-tracks"></div>
    </div>`;
  viewEl.querySelector<HTMLButtonElement>("[data-back]")!
    .addEventListener("click", () => navigate("home"));

  const dest = document.getElementById("liked-tracks")!;
  const cnt = document.getElementById("liked-count")!;

  const draw = () => {
    if (!entry) return;
    cnt.textContent = `${entry.total} tracks`;
    dest.innerHTML = "";
    if (!entry.tracks.length) {
      dest.innerHTML = `<p class="dim">No liked songs.</p>`;
      return;
    }
    dest.appendChild(trackList(entry.tracks, { showAlbum: true }));
  };

  document.getElementById("liked-play")!.addEventListener("click", () => {
    const uid = state.me.get()?.id;
    const ctx = uid ? `spotify:user:${uid}:collection` : null;
    if (ctx) playback.start({ contextUri: ctx });
    else if (entry?.tracks.length) {
      playback.start({
        uris: entry.tracks.slice(0, 50).map((t) => t.uri),
        optimisticTrack: entry.tracks[0],
      });
    }
  });
  document.getElementById("liked-shuf")!.addEventListener("click", () => {
    api.raw("PUT", "/me/player/shuffle", [["state", "true"]]).catch(() => {});
    const uid = state.me.get()?.id;
    if (uid) playback.start({ contextUri: `spotify:user:${uid}:collection` });
  });

  if (!entry) {
    entry = cache.liked = { tracks: [], total: 0, paginating: false };
    dest.innerHTML = `<p class="dim">Loading…</p>`;
    api.raw("GET", "/me/tracks", [["limit", "50"]])
      .then((r: any) => {
        entry!.total = r?.total ?? 0;
        entry!.tracks = (r?.items ?? []).map((it: any) => it.track).filter((t: any) => t && t.uri);
        persistSave();
        if (entry!.tracks.length < entry!.total) paginateLiked(entry!);
        if (curView === "liked") draw();
      })
      .catch((e: any) => { dest.innerHTML = `<p class="dim">Error: ${fmt.esc(e)}</p>`; });
  } else {
    draw();
  }
}

async function paginateLiked(entry: any) {
  if (entry.paginating) return;
  entry.paginating = true;
  const PAGE = 50, CONC = 5;
  let off = entry.tracks.length;
  try {
    while (off < entry.total) {
      const batch: Promise<{ off: number; items: any[] }>[] = [];
      for (let i = 0; i < CONC && off < entry.total; i++) {
        const o = off; off += PAGE;
        batch.push(
          api.raw("GET", "/me/tracks", [["offset", String(o)], ["limit", String(PAGE)]])
            .then((r: any) => ({
              off: o,
              items: (r?.items ?? []).map((it: any) => it.track).filter((t: any) => t && t.uri),
            })),
        );
      }
      const pages = await Promise.all(batch);
      pages.sort((a, b) => a.off - b.off);
      for (const p of pages) entry.tracks.push(...p.items);
      if (curView === "liked") {
        const dest = document.getElementById("liked-tracks");
        const cnt = document.getElementById("liked-count");
        if (dest && cnt) {
          cnt.textContent = `${entry.total} tracks`;
          dest.innerHTML = "";
          dest.appendChild(trackList(entry.tracks, { showAlbum: true }));
        }
      }
    }
  } catch (e) {
    console.warn("[liked] paginate failed", e);
  } finally {
    entry.paginating = false;
  }
}

function renderArtist(id: string) {
  let entry = cache.artist.get(id);
  viewEl.innerHTML = `
    <div class="page">
      <button class="back" data-back>← Back</button>
      <div class="hero" id="artist-hero">Loading…</div>
      <h2 class="sub">Top tracks</h2>
      <div id="artist-tracks"></div>
      <h2 class="sub">Albums</h2>
      <div id="artist-albums" class="album-row"></div>
    </div>`;
  viewEl.querySelector<HTMLButtonElement>("[data-back]")!
    .addEventListener("click", () => navigate("home"));

  // Re-fetch if cache entry exists but meta failed (null) last time so
  // closing/opening doesn't permanently stick on the failed result.
  if (entry && !entry.meta) {
    cache.artist.delete(id);
    entry = undefined;
  }
  if (!entry) {
    entry = { meta: null, top: [], albums: [] };
    cache.artist.set(id, entry);
    const market = state.me.get()?.country ?? "US";

    api.raw("GET", `/artists/${id}`)
      .then((m: any) => {
        console.log("[artist] meta response:", m);
        entry!.meta = m;
        if (curView === "artist" && openArtistId === id) drawArtist(id);
      })
      .catch((e: any) => {
        console.warn("[artist] meta failed:", e);
        const h = document.getElementById("artist-hero");
        if (h) h.textContent = `Couldn't load artist (${String(e)}).`;
      });

    // top-tracks: try the proper endpoint first. Spotify Development Mode
    // apps got that endpoint locked behind Extended Quota Mode in late 2024,
    // so on 403 we fall back to a `search?q=artist:"Name"&type=track` which
    // is still allowed for dev apps.
    const fetchTop = async (): Promise<any[]> => {
      for (const mk of [market, "US"]) {
        try {
          const t: any = await api.raw("GET", `/artists/${id}/top-tracks`, [["market", mk]]);
          const items = t?.tracks ?? [];
          if (items.length) return items;
        } catch (e) {
          console.warn(`[artist] top-tracks ${mk} failed:`, e);
        }
      }
      // Search fallback — needs the artist name, which arrives async.
      const name = await waitForArtistName(id);
      if (!name) return [];
      try {
        const r: any = await api.search(`artist:"${name}"`, "track", 10);
        return r?.tracks?.items ?? [];
      } catch (e) {
        console.warn("[artist] search fallback failed:", e);
        return [];
      }
    };
    fetchTop().then((tracks) => {
      entry!.top = tracks;
      if (curView === "artist" && openArtistId === id) drawArtist(id);
    });

    // Albums: Spotify dev mode rejects `limit=20` on this endpoint with 400
    // "Invalid limit". Cap at 10. On 403, fall back to search.
    const fetchAlbums = async (): Promise<any[]> => {
      try {
        const a: any = await api.raw("GET", `/artists/${id}/albums`,
          [["limit", "10"], ["include_groups", "album,single"], ["market", market]]);
        return a?.items ?? [];
      } catch (e) {
        console.warn("[artist] albums failed:", e);
      }
      const name = await waitForArtistName(id);
      if (!name) return [];
      try {
        const r: any = await api.search(`artist:"${name}"`, "album", 10);
        return r?.albums?.items ?? [];
      } catch (e) {
        console.warn("[artist] albums search fallback failed:", e);
        return [];
      }
    };
    fetchAlbums().then((items) => {
      entry!.albums = items;
      if (curView === "artist" && openArtistId === id) drawArtist(id);
    });
  } else if (entry.meta) {
    drawArtist(id);
  }
}

async function waitForArtistName(id: string): Promise<string | null> {
  // Poll the cache up to 2.5s — meta fetch usually wins by 200ms but we
  // can't guarantee ordering with the parallel fetches.
  for (let i = 0; i < 25; i++) {
    const e = cache.artist.get(id);
    if (e?.meta?.name) return e.meta.name;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

function drawArtist(id: string) {
  const e = cache.artist.get(id);
  if (!e) return;
  const hero = document.getElementById("artist-hero");
  if (e.meta && hero) {
    const m = e.meta;
    const img = m.images?.[0]?.url ?? "";
    const followers = m.followers?.total ?? 0;
    const popularity = typeof m.popularity === "number" ? m.popularity : null;
    const genres = Array.isArray(m.genres) ? m.genres.slice(0, 3) : [];
    // Spotify development-quota apps (the default tier since late 2024) get a
    // reduced /artists/{id} response that omits followers — it comes back as
    // 0 instead of the real number. Showing "0 followers" everywhere is just
    // misleading, so suppress the line in that case and fall back to
    // popularity + genres which are still returned.
    const subline = [
      followers > 0 ? `${followers.toLocaleString()} followers` : null,
      popularity !== null ? `popularity ${popularity}` : null,
      genres.length ? genres.join(" · ") : null,
    ].filter(Boolean).join("  ·  ");
    hero.classList.add("hero-grid");
    hero.innerHTML = `
      ${img ? `<img class="hero-art round" src="${fmt.esc(img)}" />` : `<div class="hero-art placeholder round"></div>`}
      <div class="hero-meta">
        <div class="kicker">Artist</div>
        <h1>${fmt.esc(m.name)}</h1>
        ${subline ? `<p class="dim">${fmt.esc(subline)}</p>` : ""}
        <div class="actions">
          <button class="primary" data-act="play">Play top</button>
        </div>
      </div>`;
    hero.querySelector<HTMLButtonElement>('[data-act="play"]')!
      .addEventListener("click", () => {
        if (e.top.length) {
          playback.start({
            uris: e.top.slice(0, 10).map((t) => t.uri),
            optimisticTrack: e.top[0],
          });
        }
      });
  }

  const tDest = document.getElementById("artist-tracks");
  if (tDest) {
    if (e.top.length) {
      tDest.innerHTML = "";
      tDest.appendChild(trackList(e.top, { showAlbum: true }));
    } else if (e.meta) {
      tDest.innerHTML = `<p class="dim small">No top tracks available in your market.</p>`;
    }
  }

  const aDest = document.getElementById("artist-albums");
  if (aDest && !e.albums.length && e.meta) {
    aDest.innerHTML = `<p class="dim small">No albums.</p>`;
  } else if (aDest && e.albums.length) {
    aDest.innerHTML = e.albums.map((a) => {
      const cover = a.images?.[1]?.url ?? a.images?.[0]?.url ?? "";
      return `<button class="album-card" data-uri="${fmt.esc(a.uri)}">
        ${cover ? `<img loading="lazy" src="${fmt.esc(cover)}" />` : `<div class="ph"></div>`}
        <div class="album-name">${fmt.esc(a.name)}</div>
        <div class="dim small">${fmt.esc((a.release_date ?? "").slice(0, 4))} · ${fmt.esc(a.album_type ?? "")}</div>
      </button>`;
    }).join("");
    aDest.querySelectorAll<HTMLButtonElement>(".album-card").forEach((b) => {
      b.addEventListener("click", () => playback.start({ contextUri: b.dataset.uri! }));
    });
  }
}

function renderFocus() {
  viewEl.innerHTML = `
    <div class="focus">
      <div class="focus-row">
        <button class="focus-side prev pulse-on-click" id="focus-prev" title="Previous">‹</button>
        <div class="focus-cover" id="focus-cover"></div>
        <button class="focus-side next pulse-on-click" id="focus-next" title="Next">›</button>
      </div>
      <div class="focus-text" id="focus-text"></div>
    </div>`;
  document.getElementById("focus-prev")!.addEventListener("click", () => playback.previous());
  document.getElementById("focus-next")!.addEventListener("click", () => playback.next());
  drawFocus();
  viewDisposers.push(state.playback.subscribe(drawFocus));
}

let lastFocusUri = "__none";
function drawFocus() {
  if (curView !== "focus") return;
  const cover = document.getElementById("focus-cover");
  const text = document.getElementById("focus-text");
  if (!cover || !text) return;
  const p = state.playback.get();
  const t = currentTrack(p);
  if (!t) {
    cover.innerHTML = `<div class="focus-art placeholder"></div>`;
    text.innerHTML = `<h1 class="focus-title dim">Nothing playing</h1>`;
    lastFocusUri = "__none";
    return;
  }
  if (t.uri !== lastFocusUri) {
    lastFocusUri = t.uri;
    const art = t.album?.images?.[0]?.url ?? "";
    const artists = (t.artists ?? []).map((a: any) => a.name).join(", ");
    cover.innerHTML = art
      ? `<img class="focus-art" src="${fmt.esc(art)}" />`
      : `<div class="focus-art placeholder"></div>`;
    text.innerHTML = `
      <h1 class="focus-title">${fmt.esc(t.name ?? "")}</h1>
      <p class="focus-artists">${fmt.esc(artists)}</p>`;
  }
}

// ----------------------------------------------------------------- stats (stats.fm)

let statsRange: import("../statsfm").Range = "weeks";
async function renderStats() {
  const cfg = getConfig();
  const user = (cfg.statsFmUser ?? "").trim();

  viewEl.innerHTML = `
    <div class="page stats-page">
      <h1>Stats</h1>
      ${!user ? `
        <div class="card">
          <p class="dim">Connect <a href="https://stats.fm/" target="_blank" rel="noopener">stats.fm</a> to see your listening history.</p>
          <p class="dim small">Settings → stats.fm → enter your stats.fm username (or your Spotify ID if you've imported via Spotify). Public profiles only — no auth.</p>
        </div>
      ` : `
        <div id="stats-info" class="card stats-info">Loading…</div>
        <div class="stats-tabs">
          ${(["today","weeks","months","lifetime"] as const).map((p) =>
            `<button class="stats-tab${p === statsRange ? " active" : ""}" data-p="${p}">${rangeLabel(p)}</button>`).join("")}
        </div>
        <div class="stats-grid">
          <section class="stats-col">
            <h2 class="sub">Top artists</h2>
            <ol id="stats-artists" class="stats-list"><li class="dim">Loading…</li></ol>
          </section>
          <section class="stats-col">
            <h2 class="sub">Top tracks</h2>
            <ol id="stats-tracks" class="stats-list"><li class="dim">Loading…</li></ol>
          </section>
          <section class="stats-col">
            <h2 class="sub">Top albums</h2>
            <ol id="stats-albums" class="stats-list"><li class="dim">Loading…</li></ol>
          </section>
          <section class="stats-col">
            <h2 class="sub">Recent streams</h2>
            <ol id="stats-recent" class="stats-list"><li class="dim">Loading…</li></ol>
          </section>
        </div>
      `}
    </div>`;

  if (!user) return;

  viewEl.querySelectorAll<HTMLButtonElement>(".stats-tab").forEach((b) => {
    b.addEventListener("click", () => {
      const p = b.dataset.p as import("../statsfm").Range;
      if (p === statsRange) return;
      statsRange = p;
      renderStats();
    });
  });

  loadStats(user, statsRange);
}

function rangeLabel(r: import("../statsfm").Range): string {
  return r === "today" ? "today"
    : r === "days" ? "4 weeks"
    : r === "weeks" ? "6 months"
    : r === "months" ? "1 year"
    : "lifetime";
}

async function loadStats(user: string, range: import("../statsfm").Range) {
  const { statsfm } = await import("../statsfm");

  // User profile + lifetime totals.
  Promise.all([
    statsfm.user(user),
    statsfm.streamStats(user, range),
  ]).then(([u, s]: [any, any]) => {
    const el = document.getElementById("stats-info");
    if (!el || curView !== "stats") return;
    const totalCount = s?.count ?? 0;
    const totalMs = s?.durationMs ?? 0;
    const hours = Math.round(totalMs / 1000 / 3600);
    const cardinality = s?.cardinality ?? {};
    el.innerHTML = `
      <div class="stats-info-head">
        <div class="stats-name">${fmt.esc(u?.displayName ?? u?.customId ?? user)}</div>
        <div class="dim small">${fmt.esc(rangeLabel(range))}</div>
      </div>
      <div class="stats-info-grid">
        <div><div class="stats-num">${Number(totalCount).toLocaleString()}</div><div class="dim small">streams</div></div>
        <div><div class="stats-num">${hours.toLocaleString()}</div><div class="dim small">hours played</div></div>
        <div><div class="stats-num">${cardinality.tracks ?? "—"}</div><div class="dim small">unique tracks</div></div>
        <div><div class="stats-num">${cardinality.artists ?? "—"}</div><div class="dim small">unique artists</div></div>
      </div>`;
  }).catch((e) => {
    const el = document.getElementById("stats-info");
    if (el) el.textContent = `Error: ${String(e)}`;
  });

  const fillList = (id: string, items: any[], render: (it: any, i: number) => string) => {
    const el = document.getElementById(id);
    if (!el || curView !== "stats") return;
    el.innerHTML = items.length
      ? items.map(render).join("")
      : `<li class="dim small">Nothing.</li>`;
  };

  // streams field is null for non-Plus stats.fm accounts; just show ranks +
  // names then. playedMs may also be present and gives a duration figure.
  const ctBadge = (it: any) => {
    const s = it?.streams;
    if (typeof s === "number") return `<span class="ct dim small">${s.toLocaleString()} pl</span>`;
    const ms = it?.playedMs;
    if (typeof ms === "number" && ms > 0) {
      const m = Math.round(ms / 60000);
      return `<span class="ct dim small">${m.toLocaleString()}m</span>`;
    }
    return "";
  };

  statsfm.topArtists(user, range).then((items) => {
    fillList("stats-artists", items, (it: any, i: number) => {
      const a = it.artist ?? {};
      return `<li><span class="rank">${i + 1}</span><span class="name">${fmt.esc(a.name ?? "")}</span>${ctBadge(it)}</li>`;
    });
  }).catch((e) => fillList("stats-artists", [], () => `<li class="dim small">${fmt.esc(String(e))}</li>`));

  statsfm.topTracks(user, range).then((items) => {
    fillList("stats-tracks", items, (it: any, i: number) => {
      const t = it.track ?? {};
      const artists = (t.artists ?? []).map((a: any) => a.name).join(", ");
      return `<li><span class="rank">${i + 1}</span><span class="name">${fmt.esc(t.name ?? "")} <span class="dim small">— ${fmt.esc(artists)}</span></span>${ctBadge(it)}</li>`;
    });
  }).catch((e) => fillList("stats-tracks", [], () => `<li class="dim small">${fmt.esc(String(e))}</li>`));

  statsfm.topAlbums(user, range).then((items) => {
    fillList("stats-albums", items, (it: any, i: number) => {
      const a = it.album ?? {};
      const artists = (a.artists ?? []).map((ar: any) => ar.name).join(", ");
      return `<li><span class="rank">${i + 1}</span><span class="name">${fmt.esc(a.name ?? "")} <span class="dim small">— ${fmt.esc(artists)}</span></span>${ctBadge(it)}</li>`;
    });
  }).catch((e) => fillList("stats-albums", [], () => `<li class="dim small">${fmt.esc(String(e))}</li>`));

  statsfm.recentStreams(user, 25).then((items) => {
    fillList("stats-recent", items, (it: any) => {
      const t = it.track ?? {};
      const artists = (t.artists ?? []).map((a: any) => a.name).join(", ");
      const when = it.endTime ? timeAgo(new Date(it.endTime).getTime()) : "";
      return `<li><span class="name">${fmt.esc(t.name ?? "")} <span class="dim small">— ${fmt.esc(artists)}</span></span><span class="ct dim small">${fmt.esc(when)}</span></li>`;
    });
  }).catch((e) => fillList("stats-recent", [], () => `<li class="dim small">${fmt.esc(String(e))}</li>`));
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function renderSettings() {
  const cfg = getConfig();
  viewEl.innerHTML = `
    <div class="page settings">
      <h1>Settings</h1>

      <h2 class="sub">Spotify Client ID</h2>
      <div class="row">
        <input id="cid-input" class="text-input" type="text" spellcheck="false"
               value="${fmt.esc(cfg.clientId ?? "")}" />
        <button id="cid-save">Save</button>
      </div>
      <p class="dim small">Stored in <code>config.json</code>.</p>

      <h2 class="sub">Audio backend</h2>
      <div class="row">
        <select id="backend-sel" class="text-input">
          <option value="sdk" ${(cfg.audioBackend ?? "sdk") === "sdk" ? "selected" : ""}>Web Playback SDK (default)</option>
          <option value="librespot" ${cfg.audioBackend === "librespot" ? "selected" : ""}>librespot (local audio)</option>
        </select>
        <span id="backend-status" class="dim small"></span>
      </div>
      <p class="dim small">
        Web SDK: official, DRM, gapless. <strong>librespot</strong>: reverse-engineered, local audio decode.
        Requires <code>librespot</code> on PATH (<code>cargo install librespot</code>). Violates Spotify ToS — small ban risk.
      </p>

      ${cfg.audioBackend === "librespot" ? `
        <h2 class="sub">Equalizer (librespot only)</h2>
        <label class="flag">
          <input type="checkbox" id="eq-enabled" ${cfg.features.eqEnabled ? "checked" : ""} />
          <span>Enable 10-band EQ <span class="dim small">(routes audio through internal pipe + cpal — ~30 ms extra latency)</span></span>
        </label>
        <div id="eq-panel" class="${cfg.features.eqEnabled ? "" : "dim"}">
          <div class="row" style="margin-top: 12px">
            <select id="eq-preset" class="text-input" style="max-width: 200px;">
              <option value="">— preset —</option>
              <option value="flat">Flat</option>
              <option value="bass_boost">Bass Boost</option>
              <option value="treble_boost">Treble Boost</option>
              <option value="vocal">Vocal</option>
              <option value="rock">Rock</option>
              <option value="pop">Pop</option>
              <option value="jazz">Jazz</option>
              <option value="classical">Classical</option>
              <option value="electronic">Electronic</option>
              <option value="loudness">Loudness</option>
            </select>
            <button id="eq-flat">Reset to flat</button>
          </div>
          <div id="eq-bands" class="eq-bands"></div>
        </div>
      ` : ""}

      <h2 class="sub">stats.fm</h2>
      <div class="row">
        <input id="sfm-user" class="text-input" type="text" spellcheck="false"
               placeholder="stats.fm username (or Spotify ID)"
               value="${fmt.esc(cfg.statsFmUser ?? "")}" />
        <button id="sfm-save">Save</button>
      </div>
      <p class="dim small">
        No API key needed. Public profile only. Sign up at
        <a href="https://stats.fm/" target="_blank" rel="noopener">stats.fm</a>
        and import your Spotify history first.
      </p>

      <h2 class="sub">Discord Rich Presence</h2>
      <div class="row">
        <input id="discord-cid" class="text-input" type="text" spellcheck="false"
               placeholder="Discord application ID"
               value="${fmt.esc(cfg.discordClientId ?? "")}" />
        <button id="discord-save">Save</button>
      </div>
      <p class="dim small">
        Register a free app at <a href="https://discord.com/developers/applications" target="_blank">discord.com/developers/applications</a>,
        copy its <code>Application ID</code>. Then enable the <code>discordRpc</code> feature flag and reload.
        Discord must be running locally.
      </p>

      <h2 class="sub">Global media keys</h2>
      <p class="dim small">Always active, even when window unfocused.</p>
      <div class="kbd-list">
        <div><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> &nbsp;previous</div>
        <div><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> &nbsp;play / pause</div>
        <div><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> &nbsp;next</div>
      </div>

      <h2 class="sub">In-app keybinds</h2>
      <p class="dim small">Click a row, press a new combo, Enter to commit, Esc to cancel.</p>
      <table class="kb">
        ${Object.entries(cfg.keybinds).map(([action, combos]) => `
          <tr data-action="${fmt.esc(action)}">
            <td>${fmt.esc(action)}</td>
            <td><button class="kb-btn">${fmt.esc((combos as string[]).join(" / "))}</button></td>
          </tr>`).join("")}
      </table>

      <h2 class="sub">Themes</h2>
      <p class="dim small">
        Import any Vencord or BetterDiscord <code>.css</code> / <code>.theme.css</code>
        file. Saved to disk under <code>themes/</code>; switch any time.
        Discord CSS variables are auto-aliased to Cadence's palette.
      </p>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <input type="file" id="theme-file" accept=".css,.theme.css,text/css" style="display: none;" />
        <button id="theme-import">Import theme…</button>
        <button id="theme-clear" class="ghost">Use default</button>
        <span id="theme-status" class="dim small"></span>
      </div>
      <ul id="theme-list" class="theme-list"></ul>

      <h2 class="sub">Features</h2>
      ${renderFeatureGroups(cfg.features)}
    </div>`;

  document.getElementById("cid-save")!.addEventListener("click", async () => {
    const v = (document.getElementById("cid-input") as HTMLInputElement).value.trim();
    await patchConfig({ clientId: v });
    flash("cid-save", "Saved ✓");
  });

  document.getElementById("discord-save")!.addEventListener("click", async () => {
    const v = (document.getElementById("discord-cid") as HTMLInputElement).value.trim();
    await patchConfig({ discordClientId: v });
    flash("discord-save", "Saved ✓");
  });

  document.getElementById("sfm-save")!.addEventListener("click", async () => {
    const u = (document.getElementById("sfm-user") as HTMLInputElement).value.trim();
    await patchConfig({ statsFmUser: u });
    flash("sfm-save", "Saved ✓");
  });

  // ---- Themes ----
  const themeFileInput = document.getElementById("theme-file") as HTMLInputElement;
  const themeStatus = document.getElementById("theme-status")!;
  const setStatus = (msg: string, ms = 2200) => {
    themeStatus.textContent = msg;
    if (ms > 0) setTimeout(() => { themeStatus.textContent = ""; }, ms);
  };
  const renderThemeList = async () => {
    const list = document.getElementById("theme-list");
    if (!list) return;
    try {
      const themes = await listThemes();
      const active = getConfig().activeTheme ?? null;
      if (!themes.length) {
        list.innerHTML = `<li class="dim small">No themes imported yet.</li>`;
        return;
      }
      list.innerHTML = themes.map((t) => {
        const isActive = t.name === active;
        const sizeKb = (t.size / 1024).toFixed(1);
        return `<li class="theme-row ${isActive ? "active" : ""}" data-name="${fmt.esc(t.name)}">
          <span class="theme-name">${fmt.esc(t.name)}</span>
          <span class="dim small">${sizeKb} KB</span>
          <button class="theme-apply" data-name="${fmt.esc(t.name)}">${isActive ? "Applied" : "Apply"}</button>
          <button class="theme-del ghost" data-name="${fmt.esc(t.name)}" title="Delete">×</button>
        </li>`;
      }).join("");
      list.querySelectorAll<HTMLButtonElement>(".theme-apply").forEach((b) => {
        b.addEventListener("click", async () => {
          await applyTheme(b.dataset.name!);
          setStatus(`Applied ${b.dataset.name}`);
          renderThemeList();
        });
      });
      list.querySelectorAll<HTMLButtonElement>(".theme-del").forEach((b) => {
        b.addEventListener("click", async () => {
          if (!confirm(`Delete theme "${b.dataset.name}"?`)) return;
          await deleteTheme(b.dataset.name!);
          renderThemeList();
        });
      });
    } catch (e) {
      list.innerHTML = `<li class="dim small">Couldn't list themes: ${fmt.esc(String(e))}</li>`;
    }
  };
  document.getElementById("theme-import")!.addEventListener("click", () => themeFileInput.click());
  themeFileInput.addEventListener("change", async () => {
    const files = themeFileInput.files;
    if (!files || !files.length) return;
    try {
      let lastName: string | null = null;
      for (const f of Array.from(files)) {
        lastName = await importTheme(f);
      }
      if (lastName) {
        await applyTheme(lastName);
        setStatus(`Imported & applied "${lastName}"`);
      }
    } catch (e) {
      setStatus(`Import failed: ${String(e)}`, 4000);
    } finally {
      themeFileInput.value = "";
      renderThemeList();
    }
  });
  document.getElementById("theme-clear")!.addEventListener("click", async () => {
    await applyTheme(null);
    setStatus("Reverted to default");
    renderThemeList();
  });
  renderThemeList();

  // External links inside the settings page should open in the browser, not
  // hijack the webview.
  viewEl.querySelectorAll<HTMLAnchorElement>("a[href^='http']").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openUrl(a.href).catch((err) => console.warn("[opener]", err));
    });
  });

  // Audio backend selector — reload page after switching so boot logic
  // routes through the new path cleanly (Web SDK or librespot).
  const backendSel = document.getElementById("backend-sel") as HTMLSelectElement;
  const backendStatus = document.getElementById("backend-status")!;
  refreshBackendStatus(backendStatus);
  backendSel.addEventListener("change", async () => {
    const v = backendSel.value as "sdk" | "librespot";
    await patchConfig({ audioBackend: v });
    if (v === "sdk") {
      try { await (await import("../api")).librespot.stop(); } catch {}
      try { await (await import("../api")).audioPipeline.stop(); } catch {}
    }
    backendStatus.textContent = "Reloading…";
    setTimeout(() => location.reload(), 500);
  });

  // EQ panel (only present when audioBackend = librespot).
  if (cfg.audioBackend === "librespot") {
    mountEqPanel();
  }

  viewEl.querySelectorAll<HTMLInputElement>("input[data-flag]").forEach((cb) => {
    cb.addEventListener("change", () => {
      patchConfig({
        features: { ...getConfig().features, [cb.dataset.flag!]: cb.checked },
      }).then(applyFeatureClasses);
    });
  });


  viewEl.querySelectorAll<HTMLTableRowElement>("tr[data-action]").forEach((tr) => {
    const btn = tr.querySelector<HTMLButtonElement>(".kb-btn")!;
    btn.addEventListener("click", () => beginRebind(tr.dataset.action!, btn));
  });
}

// Memory graph: small canvas in the now-bar's right cell. Samples the
// Cadence process RSS via a Tauri command (works on macOS/Win/Linux —
// `performance.memory` is Chromium-only and missing in WKWebView).
const MEM_SAMPLES = 80;
const MEM_SAMPLE_MS = 200;
let memBuf: number[] = [];
let memTimer: number | undefined;
let memRaf: number | undefined;
let memLastSampleAt = 0;
let memLastRss = 0;
let memEl: HTMLDivElement | null = null;
let memCanvas: HTMLCanvasElement | null = null;
let memLabel: HTMLSpanElement | null = null;

function applyMemoryGraph() {
  const on = getConfig().features?.showMemoryGraph === true;
  // Sits in the topbar, immediately before the user-name badge.
  const host = document.querySelector<HTMLElement>(".topbar");
  const userBadge = document.getElementById("user");
  if (on && !memEl && host) {
    memEl = document.createElement("div");
    memEl.className = "mem-widget";
    memEl.innerHTML = `<canvas width="180" height="36"></canvas><span class="mem-label">— MB</span>`;
    if (userBadge) host.insertBefore(memEl, userBadge);
    else host.appendChild(memEl);
    memCanvas = memEl.querySelector("canvas");
    memLabel = memEl.querySelector(".mem-label");
    memEl.title = "Click for memory breakdown";
    memEl.addEventListener("click", openMemoryInspector);
    memBuf = [];
    memLastSampleAt = performance.now();
    memTimer = window.setInterval(memSample, MEM_SAMPLE_MS);
    memSample();
    memRaf = requestAnimationFrame(memLoop);
  } else if (!on && memEl) {
    memEl.remove();
    memEl = null;
    memCanvas = null;
    memLabel = null;
    if (memTimer !== undefined) { clearInterval(memTimer); memTimer = undefined; }
    if (memRaf !== undefined) { cancelAnimationFrame(memRaf); memRaf = undefined; }
  }
}

async function memSample() {
  let used = 0;
  try {
    const { rss } = await sys.processMemory();
    used = rss;
  } catch {
    // Tauri command unavailable (e.g. running in plain browser dev). Fall back
    // to V8 heap so dev mode still shows something rather than a flat zero.
    const m = (performance as any).memory;
    used = m?.usedJSHeapSize ?? 0;
  }
  memLastRss = used;
  if (memBuf.push(used) > MEM_SAMPLES) memBuf.shift();
  memLastSampleAt = performance.now();
  if (memLabel) {
    const mb = used / 1048576;
    memLabel.textContent = `${mb.toFixed(1)} MB`;
  }
}

function memLoop() {
  if (!memCanvas) return;
  drawMem();
  memRaf = requestAnimationFrame(memLoop);
}

// ----------------------------------------------------------------- memory inspector

let memInspectorEl: HTMLDivElement | null = null;
let memInspectorTimer: number | undefined;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

interface MemRow { label: string; bytes: number; detail?: string; }

function gatherMemoryRows(): { rows: MemRow[]; heap: { used: number; total: number; limit: number } | null; rss: number } {
  const rows: MemRow[] = [];

  // 1. Images currently in the DOM. Decoded RGBA bytes ≈ width * height * 4.
  // Browser may dedupe identical sources, so this overstates a bit — call out
  // the assumption in the detail line.
  const imgs = Array.from(document.images);
  let imgBytes = 0;
  let imgCount = 0;
  for (const img of imgs) {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) continue;
    imgBytes += w * h * 4;
    imgCount += 1;
  }
  rows.push({
    label: "Images (decoded)",
    bytes: imgBytes,
    detail: `${imgCount} loaded <img> elements (RGBA estimate; browser may dedupe by URL)`,
  });

  // 2. Canvas backing stores. Same RGBA assumption.
  const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas"));
  let canvasBytes = 0;
  for (const c of canvases) canvasBytes += c.width * c.height * 4;
  rows.push({
    label: "Canvas surfaces",
    bytes: canvasBytes,
    detail: `${canvases.length} <canvas> elements (memory graph, visualizer, album art)`,
  });

  // 3. DOM nodes — rough 256 B per node from V8 retained-size heuristics.
  const nodeCount = document.getElementsByTagName("*").length;
  rows.push({
    label: "DOM nodes",
    bytes: nodeCount * 256,
    detail: `${nodeCount} elements × ~256 B retained per node (rough)`,
  });

  // 4. localStorage — JS strings are 16-bit per char.
  let lsChars = 0;
  let lsKeys = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      lsKeys += 1;
      lsChars += k.length + (localStorage.getItem(k)?.length ?? 0);
    }
  } catch {}
  rows.push({
    label: "localStorage",
    bytes: lsChars * 2,
    detail: `${lsKeys} keys × 2 B/char (cached config, queue history, tokens)`,
  });

  // 5. sessionStorage.
  let ssChars = 0;
  let ssKeys = 0;
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)!;
      ssKeys += 1;
      ssChars += k.length + (sessionStorage.getItem(k)?.length ?? 0);
    }
  } catch {}
  rows.push({
    label: "sessionStorage",
    bytes: ssChars * 2,
    detail: `${ssKeys} keys`,
  });

  // 6. Our own state caches (memory ring buffer + queue + recent playback object).
  let stateBytes = 0;
  try {
    stateBytes += JSON.stringify(state.playback.get() ?? {}).length * 2;
    stateBytes += JSON.stringify(state.queue.get() ?? []).length * 2;
  } catch {}
  rows.push({
    label: "Live state objects",
    bytes: stateBytes,
    detail: "Serialized playback + queue snapshot (proxy for retained state)",
  });

  // 7. Stylesheets (CSSOM). Imported Vencord themes can balloon this — a
  // 100 KB resolved theme parses into thousands of CSS rule objects, each
  // ~200-500 B retained. Measured by summing every <style>'s textContent
  // length × 2 (chars-to-bytes) plus a per-rule overhead estimate.
  let cssChars = 0;
  let cssRules = 0;
  let cssSheets = 0;
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      cssSheets += 1;
      try {
        const rules = (sheet as CSSStyleSheet).cssRules;
        if (rules) cssRules += rules.length;
      } catch { /* cross-origin sheet — skip */ }
    }
    for (const el of Array.from(document.querySelectorAll("style"))) {
      cssChars += (el.textContent?.length ?? 0);
    }
  } catch {}
  rows.push({
    label: "Stylesheets (CSSOM)",
    bytes: cssChars * 2 + cssRules * 256,
    detail: `${cssSheets} sheets, ${cssRules} rules, ${(cssChars / 1024).toFixed(1)} KB raw text (~256 B/rule retained)`,
  });

  rows.push({
    label: "Memory graph buffer",
    bytes: memBuf.length * 8,
    detail: `${memBuf.length} samples × 8 B (Number)`,
  });

  rows.sort((a, b) => b.bytes - a.bytes);

  const m = (performance as any).memory;
  const heap = m
    ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit }
    : null;
  return { rows, heap, rss: memLastRss };
}

function renderMemoryInspector(panel: HTMLElement) {
  const { rows, heap, rss } = gatherMemoryRows();
  const rssBlock = rss > 0
    ? `
      <table>
        <tr><td class="label">Process RSS</td><td class="val">${fmtBytes(rss)}</td></tr>
      </table>
      <table>
        <tr><td class="detail">Whole Cadence process — WebView + Rust side + audio pipeline. Updated every ${MEM_SAMPLE_MS} ms.</td></tr>
      </table>`
    : `<table><tr><td class="detail">Process memory unavailable.</td></tr></table>`;
  const heapBlock = heap
    ? `
      <table>
        <tr><td class="label">JS heap used</td><td class="val">${fmtBytes(heap.used)}</td></tr>
        <tr><td class="label">JS heap allocated</td><td class="val">${fmtBytes(heap.total)}</td></tr>
        <tr><td class="label">JS heap limit</td><td class="val">${fmtBytes(heap.limit)}</td></tr>
      </table>`
    : "";

  const total = rows.reduce((a, b) => a + b.bytes, 0);
  const breakdown = rows
    .map(
      (r) => `
        <tr>
          <td class="label">${r.label}</td>
          <td class="val">${fmtBytes(r.bytes)}</td>
        </tr>
        ${r.detail ? `<tr><td class="detail" colspan="2">${r.detail}</td></tr>` : ""}`,
    )
    .join("");

  panel.innerHTML = `
    <header>
      <h3>Cadence Memory Inspector</h3>
      <button class="close-x" aria-label="Close">×</button>
    </header>
    ${rssBlock}
    ${heapBlock}
    <table>
      <tr><td class="detail" style="padding-top:10px">Estimated breakdown of in-page allocations (approximations — see notes):</td></tr>
    </table>
    <table>${breakdown}</table>
    <footer>
      <span>Sum of estimates: ${fmtBytes(total)}</span>
      <span>Refreshes every 1s</span>
    </footer>`;

  panel.querySelector<HTMLButtonElement>(".close-x")!
    .addEventListener("click", closeMemoryInspector);
}

function openMemoryInspector() {
  if (memInspectorEl) return;
  memInspectorEl = document.createElement("div");
  memInspectorEl.className = "mem-inspector";
  memInspectorEl.innerHTML = `<div class="panel"></div>`;
  memInspectorEl.addEventListener("click", (e) => {
    if (e.target === memInspectorEl) closeMemoryInspector();
  });
  document.body.appendChild(memInspectorEl);

  const panel = memInspectorEl.querySelector<HTMLElement>(".panel")!;
  renderMemoryInspector(panel);
  memInspectorTimer = window.setInterval(() => {
    if (memInspectorEl) renderMemoryInspector(panel);
  }, 1000);

  document.addEventListener("keydown", memInspectorKeyHandler);
}

function closeMemoryInspector() {
  if (!memInspectorEl) return;
  memInspectorEl.remove();
  memInspectorEl = null;
  if (memInspectorTimer !== undefined) {
    clearInterval(memInspectorTimer);
    memInspectorTimer = undefined;
  }
  document.removeEventListener("keydown", memInspectorKeyHandler);
}

function memInspectorKeyHandler(e: KeyboardEvent) {
  if (e.key === "Escape") closeMemoryInspector();
}

function drawMem() {
  if (!memCanvas) return;
  const ctx = memCanvas.getContext("2d");
  if (!ctx) return;
  const w = memCanvas.width, h = memCanvas.height;
  ctx.clearRect(0, 0, w, h);
  if (memBuf.length < 2) return;

  const min = Math.min(...memBuf);
  const max = Math.max(...memBuf);
  const span = Math.max(max - min, 1);
  const yFor = (v: number) => h - 3 - ((v - min) / (span * 1.15)) * (h - 6);

  // Continuous left-scroll: phase ∈ [0,1] is "fraction of a sample period
  // since the last sample". Shift every x by phase * sampleWidth so the
  // curve flows leftward at exactly real-time speed instead of jumping
  // when a new sample arrives. The newest sample sits at x = w; each
  // older sample is one sampleWidth to the left.
  const sampleWidth = w / (MEM_SAMPLES - 1);
  const phase = Math.min(1, (performance.now() - memLastSampleAt) / MEM_SAMPLE_MS);

  const last = memBuf.length - 1;
  const pts: { x: number; y: number }[] = memBuf.map((v, i) => ({
    x: w + (i - last - phase) * sampleWidth,
    y: yFor(v),
  }));

  // Midpoint-quadratic smoothing.
  const buildPath = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
      const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
      ctx.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
    }
    const lastPt = pts[pts.length - 1]!;
    ctx.lineTo(lastPt.x, lastPt.y);
  };

  buildPath();
  ctx.lineTo(w + sampleWidth, h);
  ctx.lineTo(pts[0]!.x, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(30,215,96,.40)");
  grad.addColorStop(1, "rgba(30,215,96,0)");
  ctx.fillStyle = grad;
  ctx.fill();

  buildPath();
  ctx.strokeStyle = "rgba(30,215,96,.95)";
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

interface FlagMeta { group: string; label: string; desc: string; }
const FLAG_META: Record<string, FlagMeta> = {
  webPlayback:      { group: "Playback",     label: "Web Playback SDK",     desc: "Spotify's official browser SDK. Required for in-app audio when audio backend = sdk." },
  autoQueueRelated: { group: "Playback",     label: "Auto-DJ",              desc: "Pre-queue a related track when nothing is set as context, so single-track plays don't loop." },
  eqEnabled:        { group: "Audio",        label: "10-band EQ",           desc: "Routes audio through a local pipe → biquad EQ → cpal. Requires audio backend = librespot." },
  showCovers:       { group: "Interface",    label: "Album covers",         desc: "Show artwork everywhere. Off = bandwidth saver / minimal aesthetic." },
  showRecents:      { group: "Interface",    label: "Recently played row",  desc: "Show the recently-played track list on the home screen." },
  showClock:        { group: "Interface",    label: "Clock on home",        desc: "Show the current time next to the greeting." },
  disableAnimations:{ group: "Interface",    label: "Disable animations",   desc: "Kill every CSS transition + animation. Helps perf on slow GPUs." },
  richArtwork:      { group: "Interface",    label: "Rich artwork",         desc: "Use the highest-resolution album image tier. Off = smaller payload." },
  showLyrics:       { group: "Interface",    label: "Show lyrics",          desc: "Reserved — not yet wired in." },
  cliMode:          { group: "Power user",   label: "Vim-style CLI",        desc: "Press `:` anywhere to open a command bar with autocomplete." },
  showMemoryGraph:  { group: "Power user",   label: "Memory graph",         desc: "Top-right mini chart showing JS heap usage in real time." },
  enableContextMenu:{ group: "Power user",   label: "Right-click menu",     desc: "Show a custom right-click menu with an Inspect option. When off, right-clicking does nothing (default OS menu always suppressed)." },
  superBackground:  { group: "Super animated", label: "Galaxy background",   desc: "Fullscreen WebGL star-field behind the UI. Recolors with the active theme via hue shift." },
  superBackgroundMouse: { group: "Super animated", label: "Galaxy mouse repulsion", desc: "Stars warp away from the cursor. Off = static field that ignores the mouse." },
  superSliders:     { group: "Super animated", label: "Elastic sliders",     desc: "Volume + seek sliders pull elastically when dragged past the edges." },
  homeCatPhoto:     { group: "Home extras",  label: "Random cat",           desc: "Show a random cat photo on the home screen (cataas.com)." },
  homeDadJoke:      { group: "Home extras",  label: "Dad joke",             desc: "Rotating dad joke from icanhazdadjoke.com." },
  homeNews:         { group: "Home extras",  label: "The Hacker News",     desc: "Latest cybersecurity headlines from thehackernews.com (RSS via rss2json)." },
  homeVisualizer:   { group: "Home extras",  label: "Audio visualizer",    desc: "Real-time 8-band visualizer fed from PCM. Requires audio backend = librespot + EQ enabled." },
  discordRpc:       { group: "Integrations", label: "Discord Rich Presence",desc: "Push the current track to your Discord profile. Requires app ID in settings." },
  pauseOnLock:      { group: "Integrations", label: "Pause on session lock",desc: "Auto-pause when Windows locks the session. Reserved — not yet wired in." },
};
const FLAG_GROUP_ORDER = ["Playback", "Audio", "Interface", "Super animated", "Home extras", "Power user", "Integrations"];

function renderFeatureGroups(features: Record<string, boolean>): string {
  const grouped: Record<string, string[]> = {};
  for (const k of Object.keys(features)) {
    // Drop legacy / unknown flags from the UI; their values stay in the
    // config.json on disk so we don't unintentionally wipe user state.
    if (!FLAG_META[k]) continue;
    const g = FLAG_META[k].group;
    (grouped[g] ??= []).push(k);
  }
  const groupNames = [
    ...FLAG_GROUP_ORDER.filter((g) => grouped[g]),
    ...Object.keys(grouped).filter((g) => !FLAG_GROUP_ORDER.includes(g)),
  ];
  return groupNames.map((g) => `
    <div class="flag-group">
      <div class="flag-group-h">${fmt.esc(g)}</div>
      ${grouped[g]!.map((k) => {
        const m = FLAG_META[k] ?? { label: k, desc: "" };
        return `
          <label class="flag-row" for="flag-${fmt.esc(k)}">
            <div class="flag-text">
              <div class="flag-label">${fmt.esc(m.label)}</div>
              ${m.desc ? `<div class="flag-desc dim small">${fmt.esc(m.desc)}</div>` : ""}
            </div>
            <span class="switch">
              <input type="checkbox" id="flag-${fmt.esc(k)}"
                     data-flag="${fmt.esc(k)}" ${features[k] ? "checked" : ""} />
              <span class="switch-track"><span class="switch-thumb"></span></span>
            </span>
          </label>`;
      }).join("")}
    </div>`).join("");
}

function applyFeatureClasses() {
  const f = getConfig().features ?? {};
  document.body.classList.toggle("no-covers", f.showCovers === false);
  document.body.classList.toggle("no-anim", f.disableAnimations === true);
  applyMemoryGraph();
  applySuperAnimated();
}

async function mountEqPanel() {
  const { eq } = await import("../api");
  // Restore persisted gains into the Rust state before reading.
  const persisted = getConfig().eqGains;
  if (Array.isArray(persisted) && persisted.length === 10) {
    await Promise.all(persisted.map((g, i) => eq.setBand(i, g).catch(() => {})));
  }
  let st: any;
  try { st = await eq.get(); } catch { st = { gains_db: new Array(10).fill(0), bands_hz: [32,64,125,250,500,1000,2000,4000,8000,16000], enabled: true }; }
  const bandsEl = document.getElementById("eq-bands");
  const panel = document.getElementById("eq-panel");
  const enabledCb = document.getElementById("eq-enabled") as HTMLInputElement;
  const presetSel = document.getElementById("eq-preset") as HTMLSelectElement;
  const flatBtn = document.getElementById("eq-flat") as HTMLButtonElement;
  if (!bandsEl) return;

  const formatHz = (hz: number) =>
    hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k` : `${hz}`;

  const renderBands = (gains: number[]) => {
    bandsEl.innerHTML = st.bands_hz.map((hz: number, i: number) => {
      const v = gains[i] ?? 0;
      return `
        <div class="eq-band">
          <div class="eq-val small">${v >= 0 ? "+" : ""}${v.toFixed(1)}</div>
          <div class="eq-track-wrap">
            <div class="eq-zero-line"></div>
            <input type="range" orient="vertical" min="-18" max="18" step="0.5"
                   value="${v}" data-i="${i}" class="eq-slider" />
          </div>
          <div class="eq-label dim small">${formatHz(hz)}</div>
        </div>`;
    }).join("");
    bandsEl.querySelectorAll<HTMLInputElement>(".eq-slider").forEach((s) => {
      s.addEventListener("input", () => {
        const i = parseInt(s.dataset.i!);
        const v = parseFloat(s.value);
        eq.setBand(i, v).catch(() => {});
        const valEl = s.parentElement!.parentElement!.querySelector<HTMLElement>(".eq-val");
        if (valEl) valEl.textContent = `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
        scheduleEqSave();
      });
    });
  };
  renderBands(st.gains_db);

  enabledCb.addEventListener("change", async () => {
    await patchConfig({
      features: { ...getConfig().features, eqEnabled: enabledCb.checked },
    });
    panel?.classList.toggle("dim", !enabledCb.checked);
    flash("eq-enabled", "");
    // Setting takes effect on next app start (boot routes through pipeline
    // vs direct librespot). Tell user.
    const note = document.createElement("div");
    note.className = "dim small";
    note.style.marginTop = "8px";
    note.textContent = "Restart app to apply audio path change.";
    panel?.appendChild(note);
    setTimeout(() => note.remove(), 4000);
  });

  presetSel.addEventListener("change", async () => {
    const name = presetSel.value;
    if (!name) return;
    await eq.setPreset(name).catch(() => {});
    const fresh = await eq.get();
    renderBands(fresh.gains_db);
    presetSel.value = "";
    scheduleEqSave();
  });

  flatBtn.addEventListener("click", async () => {
    await eq.setPreset("flat");
    renderBands(new Array(10).fill(0));
    scheduleEqSave();
  });
}

let eqSaveTimer: number | undefined;
function scheduleEqSave() {
  if (eqSaveTimer !== undefined) clearTimeout(eqSaveTimer);
  eqSaveTimer = window.setTimeout(async () => {
    try {
      const { eq } = await import("../api");
      const fresh = await eq.get();
      await patchConfig({ eqGains: fresh.gains_db });
    } catch {}
  }, 500);
}

async function refreshBackendStatus(el: HTMLElement) {
  try {
    const { librespot } = await import("../api");
    const running = await librespot.status();
    el.textContent = running ? "librespot running" : "stopped";
    el.classList.toggle("ok", running);
  } catch {
    el.textContent = "—";
  }
}

function flash(id: string, text: string) {
  const b = document.getElementById(id) as HTMLButtonElement | null;
  if (!b) return;
  const orig = b.textContent;
  b.textContent = text;
  setTimeout(() => { b.textContent = orig; }, 1200);
}

let rebindAction: string | null = null;
let rebindBtn: HTMLButtonElement | null = null;
function beginRebind(action: string, btn: HTMLButtonElement) {
  rebindAction = action;
  rebindBtn = btn;
  btn.textContent = "press a key…";
  btn.classList.add("rebinding");
}
window.addEventListener("keydown", async (e) => {
  if (!rebindAction || !rebindBtn) return;
  e.preventDefault(); e.stopPropagation();
  if (e.key === "Escape") {
    rebindBtn.classList.remove("rebinding");
    const cfg = getConfig();
    rebindBtn.textContent = (cfg.keybinds[rebindAction] ?? []).join(" / ");
    rebindAction = null; rebindBtn = null;
    return;
  }
  if (e.key === "Enter") return;
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const mods: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push("Mod");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const combo = [...mods, e.code].join("+");
  rebindBtn.textContent = combo;
  const cfg = getConfig();
  await patchConfig({ keybinds: { ...cfg.keybinds, [rebindAction]: [combo] } });
  const { rebindKeybinds } = await import("../main");
  rebindKeybinds();
  rebindBtn.classList.remove("rebinding");
  rebindAction = null; rebindBtn = null;
}, true);

// ----------------------------------------------------------------- track list

interface TrackListOpts {
  showAlbum?: boolean;
  showQueueButton?: boolean;
  contextUri?: string;
}

function trackList(tracks: any[], opts: TrackListOpts): HTMLElement {
  const tbl = document.createElement("table");
  tbl.className = "tracks";
  const tbody = document.createElement("tbody");
  tbl.appendChild(tbody);

  // Build a single row by index. Pulled out so the chunked renderer below
  // can defer rows past the first 100 to subsequent frames — a 5000-track
  // playlist used to spend ~600ms blocking the main thread on first paint.
  const buildRow = (t: any, i: number) => {
    if (!t?.uri) return;
    const art = t.album?.images?.[t.album.images.length - 1]?.url ?? "";
    const artistsHtml = (t.artists ?? [])
      .map((a: any) =>
        `<span class="artist-link" data-artist-id="${fmt.esc(a.id ?? "")}">${fmt.esc(a.name)}</span>`,
      )
      .join(", ");
    const tr = document.createElement("tr");
    tr.className = "tr";
    tr.dataset.uri = t.uri;
    tr.innerHTML = `
      <td class="td-num">${i + 1}</td>
      <td class="td-art">
        ${art ? `<img loading="lazy" src="${fmt.esc(art)}" />` : `<div class="ph"></div>`}
      </td>
      <td class="td-title">
        <div class="t-name">${fmt.esc(t.name ?? "")}</div>
        <div class="t-art">${artistsHtml}</div>
      </td>
      ${opts.showAlbum ? `<td class="td-album dim">
        <span class="album-link" data-album-uri="${fmt.esc(t.album?.uri ?? "")}">${fmt.esc(t.album?.name ?? "")}</span>
      </td>` : ""}
      <td class="td-time dim">${fmt.ms(t.duration_ms ?? 0)}</td>
      ${opts.showQueueButton ? `<td class="td-q"><button class="ico-btn q-btn" title="Add to queue">+</button></td>` : ""}
    `;
    tr.addEventListener("dblclick", () => playTrack(t, opts));
    tr.addEventListener("click", (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest(".q-btn")) return;
      const al = tgt.closest<HTMLElement>(".artist-link");
      if (al) {
        const aid = al.dataset.artistId;
        if (aid) { openArtistId = aid; navigate("artist"); }
        return;
      }
      const albumLink = tgt.closest<HTMLElement>(".album-link");
      if (albumLink) {
        const auri = albumLink.dataset.albumUri;
        if (auri) playback.start({ contextUri: auri });
        return;
      }
      playTrack(t, opts);
    });
    tr.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const items: CtxItem[] = [
        { label: "Play", fn: () => playTrack(t, opts) },
        { label: "Add to queue", fn: () => api.queueAdd(t.uri).catch(() => {}) },
      ];
      (t.artists ?? []).forEach((a: any) => {
        if (a.id) items.push({
          label: `Go to artist · ${a.name}`,
          fn: () => { openArtistId = a.id; navigate("artist"); },
        });
      });
      if (t.album?.uri) items.push({
        label: `Go to album · ${t.album.name}`,
        fn: () => playback.start({ contextUri: t.album.uri }),
      });
      items.push({ label: "Add to playlist…", fn: () => openAddToPlaylist(t) });
      items.push({ label: "Copy link", fn: () => copyLink(t) });
      items.push({ label: "Copy URI", fn: () => copy(t.uri) });
      showCtxMenu(e, items);
    });
    if (opts.showQueueButton) {
      tr.querySelector<HTMLButtonElement>(".q-btn")!.addEventListener("click", (e) => {
        e.stopPropagation();
        api.queueAdd(t.uri).catch(() => {});
      });
    }
    tbody.appendChild(tr);
  };

  const FIRST_BATCH = 100;
  const BATCH_SIZE = 200;
  const total = tracks.length;
  const upper1 = Math.min(FIRST_BATCH, total);
  for (let i = 0; i < upper1; i++) buildRow(tracks[i], i);

  if (total > FIRST_BATCH) {
    let next = FIRST_BATCH;
    let cancelled = false;
    const append = () => {
      if (cancelled) return;
      const end = Math.min(next + BATCH_SIZE, total);
      for (let i = next; i < end; i++) buildRow(tracks[i], i);
      next = end;
      if (next < total) requestAnimationFrame(append);
    };
    requestAnimationFrame(append);
    // If the user navigates away mid-render, stop appending.
    viewDisposers.push(() => { cancelled = true; });
  }

  // Track which row currently has the .playing class so we can flip it in
  // O(1) on every playback state change. The old code did querySelectorAll
  // + a classList.toggle PER row — on a 5000-track playlist that's a 5000-
  // element tree walk firing every time `state.playback` ticked, and it
  // was the dominant cost of a track click feeling laggy.
  let lastPlayingRow: HTMLTableRowElement | null = null;
  const sync = (p: any) => {
    const uri = currentTrack(p)?.uri ?? null;
    if (lastPlayingRow && lastPlayingRow.dataset.uri !== uri) {
      lastPlayingRow.classList.remove("playing");
      lastPlayingRow = null;
    }
    if (uri && (!lastPlayingRow || lastPlayingRow.dataset.uri !== uri)) {
      // querySelector with an attribute selector still walks until first hit,
      // but it's a single pass and bails as soon as the matching row is
      // found — vastly cheaper than touching every row on every event.
      const next = tbody.querySelector<HTMLTableRowElement>(
        `.tr[data-uri="${(window as any).CSS?.escape ? CSS.escape(uri) : uri.replace(/"/g, '\\"')}"]`,
      );
      if (next) {
        next.classList.add("playing");
        lastPlayingRow = next;
      }
    }
  };
  sync(state.playback.get());
  viewDisposers.push(state.playback.subscribe(sync));

  return tbl;
}

function playTrack(t: any, opts: TrackListOpts) {
  const args: any = { uris: [t.uri], optimisticTrack: t };
  if (opts.contextUri) {
    args.contextUri = opts.contextUri;
    args.offsetUri = t.uri;
    delete args.uris;
  }
  playback.start(args);
}

function copyLink(t: any) {
  const id = idFromUri(t.uri);
  copy(`https://open.spotify.com/track/${id}`);
}

function copy(s: string) {
  navigator.clipboard?.writeText(s).catch(() => {});
}

// ----------------------------------------------------------------- context menu

interface CtxItem { label: string; fn: () => void; }

function showCtxMenu(e: MouseEvent, items: CtxItem[]) {
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

function hideCtxMenu() {
  const m = document.getElementById("ctx-menu");
  if (m) m.hidden = true;
}

// ----- Add to playlist picker ----------------------------------------
// Lightweight modal: lists every playlist the user can actually write to
// (owned outright, or collaborative). Spotify rejects adds to other people's
// non-collaborative playlists with 403, so we filter them out client-side to
// keep the list short. Triggered from the track row context menu.
function openAddToPlaylist(track: any) {
  const meId = state.me.get()?.id;
  const all = cache.playlists ?? [];
  const editable = all.filter(
    (p) => p?.collaborative || (meId && p?.owner?.id === meId),
  );

  const root = document.createElement("div");
  root.className = "addpl-overlay";
  root.innerHTML = `
    <div class="addpl-card" role="dialog" aria-label="Add to playlist">
      <div class="addpl-title">Add "${fmt.esc(track?.name ?? "")}" to…</div>
      <input class="addpl-search" type="text" placeholder="Filter playlists…" />
      <div class="addpl-list"></div>
      <div class="addpl-foot dim small">Esc to close</div>
    </div>`;
  document.body.appendChild(root);

  const input = root.querySelector<HTMLInputElement>(".addpl-search")!;
  const list = root.querySelector<HTMLDivElement>(".addpl-list")!;

  function render(filter: string) {
    const q = filter.trim().toLowerCase();
    const rows = (q ? editable.filter((p) => (p.name ?? "").toLowerCase().includes(q)) : editable)
      .slice(0, 200);
    if (!rows.length) {
      list.innerHTML = `<div class="addpl-empty dim">No editable playlists.</div>`;
      return;
    }
    list.innerHTML = rows
      .map((p) => `<button class="addpl-row" data-id="${fmt.esc(idFromUri(p.uri))}">
        <span class="addpl-name">${fmt.esc(p.name ?? "")}</span>
        <span class="addpl-count dim small">${p.tracks?.total ?? 0}</span>
      </button>`)
      .join("");
    list.querySelectorAll<HTMLButtonElement>(".addpl-row").forEach((btn) => {
      btn.addEventListener("click", () => add(btn.dataset.id!));
    });
  }

  function add(playlistId: string) {
    if (!track?.uri) return close();
    // POST /playlists/{id}/tracks accepts a JSON body { uris: [...] }; the
    // raw bridge serializes the body for us. Adding succeeds silently on
    // 201 — we just close the picker. A failed add (403/404) shouldn't
    // wedge the UI, so we still close and log.
    api.raw("POST", `/playlists/${playlistId}/tracks`, undefined, { uris: [track.uri] })
      .then(() => {
        // Invalidate the cached detail for this playlist so the next open
        // refetches the real new state instead of showing stale tracks.
        const entry = cache.playlistDetail.get(playlistId);
        if (entry) (entry as any).meta = null;
        close();
      })
      .catch((e) => {
        console.warn("[add-to-playlist] failed", e);
        close();
      });
  }

  function close() {
    document.removeEventListener("keydown", onKey, true);
    root.remove();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Enter" && document.activeElement === input) {
      const first = list.querySelector<HTMLButtonElement>(".addpl-row");
      if (first) first.click();
    }
  }
  document.addEventListener("keydown", onKey, true);
  root.addEventListener("click", (e) => { if (e.target === root) close(); });
  input.addEventListener("input", () => render(input.value));
  render("");
  setTimeout(() => input.focus(), 0);
}

// ----------------------------------------------------------------- now-bar

function mountNowBar(root: HTMLElement) {
  root.innerHTML = `
    <div class="np-left">
      <div class="np-art-wrap"><img class="np-art" id="np-art" /></div>
      <div class="np-meta">
        <div class="np-title" id="np-title">—</div>
        <div class="np-artists dim" id="np-artists"></div>
      </div>
    </div>
    <div class="np-center">
      <div class="np-controls">
        <button class="ico-btn" id="np-shuf" title="Shuffle">⇄</button>
        <button class="ico-btn" id="np-prev" title="Previous">⏮</button>
        <button class="ico-btn play" id="np-play" title="Play/Pause">▶</button>
        <button class="ico-btn" id="np-next" title="Next">⏭</button>
        <button class="ico-btn" id="np-rep" title="Repeat">⟲</button>
      </div>
      <div class="np-seek">
        <span class="dim small" id="np-pos">0:00</span>
        <input type="range" id="np-seek" min="0" max="1000" value="0" step="0.01" />
        <span class="dim small" id="np-dur">0:00</span>
      </div>
    </div>
    <div class="np-right">
      <div class="np-vol-row">
        <span class="dim small">vol</span>
        <input type="range" id="np-vol" min="0" max="100" value="60" step="0.01" />
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

  $("np-prev").addEventListener("click", () => playback.previous());
  $("np-next").addEventListener("click", () => playback.next());
  $("np-play").addEventListener("click", () => playback.togglePlay());
  // Shuffle and repeat both target the active Connect device. Without a
  // device id the request returns 404 NO_ACTIVE_DEVICE — pass the id we
  // already track in state. Errors are logged so the user can see *why*
  // the click didn't take effect.
  const shufRepeatRequest = async (path: string, params: [string, string][]) => {
    const did = state.deviceId.get();
    const q: [string, string][] = params.slice();
    if (did) q.push(["device_id", did]);
    // Suppress the 5s HTTP poll so a stale snapshot doesn't undo the
    // optimistic toggle while Spotify's eventual-consistency layer settles.
    suppressPollFor(3000);
    try {
      await api.raw("PUT", path, q);
    } catch (e) {
      console.warn(`[playback] ${path} failed:`, e);
    }
  };
  $("np-shuf").addEventListener("click", () => {
    const p = state.playback.get();
    const next = !p?.shuffle_state;
    if (p) state.playback.set({ ...p, shuffle_state: next });
    shufRepeatRequest("/me/player/shuffle", [["state", String(next)]]);
  });
  $("np-rep").addEventListener("click", () => {
    const p = state.playback.get();
    const cur: string = p?.repeat_state ?? "off";
    const next = cur === "off" ? "context" : cur === "context" ? "track" : "off";
    if (p) state.playback.set({ ...p, repeat_state: next });
    shufRepeatRequest("/me/player/repeat", [["state", next]]);
  });

  const volEl = $("np-vol") as HTMLInputElement;
  volEl.addEventListener("input", () => playback.setVolume(parseFloat(volEl.value) / 100));
  // Stash the target volume; the rAF tick lerps the slider toward it so a
  // 5 s polled snapshot doesn't snap the thumb in one frame.
  np.volTarget = parseFloat(volEl.value);
  np.volCurrent = np.volTarget;
  state.volume.subscribe((v) => {
    np.volTarget = v * 100;
    // While the user is dragging, their input wins outright — never fight them.
    if (document.activeElement === volEl) {
      np.volCurrent = np.volTarget;
    }
  });

  const seekEl = $("np-seek") as HTMLInputElement;
  let dragging = false;
  let dragVal = 0;
  seekEl.addEventListener("input", () => {
    dragging = true;
    dragVal = parseInt(seekEl.value) / 1000;
  });
  seekEl.addEventListener("change", () => {
    const dur = currentDuration(state.playback.get());
    const ms = Math.round(dragVal * dur);
    playback.seek(ms);
    np.lastPos = ms;
    np.lastSync = performance.now();
    dragging = false;
  });

  np.posEl = $("np-pos");
  np.durEl = $("np-dur");
  np.titleEl = $("np-title");
  np.artistsEl = $("np-artists");
  np.artEl = $("np-art") as HTMLImageElement;
  np.playBtn = $("np-play") as HTMLButtonElement;
  np.shufBtn = $("np-shuf") as HTMLButtonElement;
  np.repBtn = $("np-rep") as HTMLButtonElement;
  np.seekEl = seekEl;
  np.volEl = volEl;
  np.dragging = () => dragging;
  np.dragVal = () => dragVal;

  // Click artist name in now-bar → artist view.
  np.artistsEl.addEventListener("click", () => {
    const t = currentTrack(state.playback.get());
    const a = t?.artists?.[0];
    if (a?.id) { openArtistId = a.id; navigate("artist"); }
  });

  state.playback.subscribe((p) => {
    if (!p) return;
    const t = currentTrack(p);
    np.lastDur = currentDuration(p);
    np.lastPos = p?.position ?? p?.progress_ms ?? 0;
    np.lastSync = performance.now();
    np.paused = p?.paused ?? !(p?.is_playing ?? false);
    np.curUri = t?.uri ?? null;
    np.shufBtn!.classList.toggle("active", !!p.shuffle_state);
    // repeat is a tri-state (off → context → track → off); a single .active
    // class makes the two "on" states look identical, so the button appears
    // unresponsive for one click out of three. Swap the glyph for track mode
    // so each click visibly advances.
    const rep = p.repeat_state ?? "off";
    np.repBtn!.classList.toggle("active", rep !== "off");
    np.repBtn!.dataset.mode = rep;
    np.repBtn!.textContent = rep === "track" ? "⟳¹" : "⟲";
    np.playBtn!.textContent = np.paused ? "▶" : "⏸";
    if (t) {
      const cover = t.album?.images?.[0]?.url ?? "";
      if (np.artEl!.src !== cover) np.artEl!.src = cover || "";
      np.artEl!.classList.toggle("hidden", !cover);
      np.titleEl!.textContent = t.name ?? "";
      np.artistsEl!.textContent = (t.artists ?? []).map((a: any) => a.name).join(", ");
    } else {
      np.titleEl!.textContent = "—";
      np.artistsEl!.textContent = "";
    }
    const vp = p?.device?.volume_percent;
    if (typeof vp === "number") {
      // Invert the perceptual taper applied in sliderToApi so the slider
      // shows the same value the user dragged to (not Spotify's reported
      // raw amplitude, which would snap the thumb downward).
      state.volume.set(apiToSlider(vp / 100));
    }
  });

  // The slider thumb is the visible "where am I" indicator — a 250 ms
  // setInterval update gives only 4 fps and looks janky against album art
  // motion. Drive the slider position from rAF (~60 fps) so the dot glides;
  // keep the text labels on a 250 ms cadence since they only show seconds.
  let lastTextUpdate = 0;
  const tick = (now: number) => {
    if (np.posEl) {
      const dur = np.lastDur;
      const at = dur
        ? Math.min(dur, np.lastPos + (np.paused ? 0 : performance.now() - np.lastSync))
        : 0;
      if (!np.dragging()) {
        // Sub-integer precision avoids the slider snapping in 1/1000 jumps
        // (toFixed keeps the value on a continuous numeric track).
        np.seekEl.value = dur ? ((at / dur) * 1000).toFixed(2) : "0";
      }
      if (now - lastTextUpdate >= 250) {
        np.posEl.textContent = fmt.ms(at);
        np.durEl.textContent = fmt.ms(dur);
        lastTextUpdate = now;
      }
    }
    // Volume lerp — only when the user isn't actively dragging the slider.
    // Exponential approach (~18%/frame ≈ 100 ms time constant at 60 fps) feels
    // snappy without being jumpy.
    if (np.volEl && document.activeElement !== np.volEl && typeof np.volTarget === "number") {
      const diff = np.volTarget - np.volCurrent;
      if (Math.abs(diff) > 0.05) {
        np.volCurrent += diff * 0.18;
        np.volEl.value = np.volCurrent.toFixed(2);
      } else if (np.volCurrent !== np.volTarget) {
        np.volCurrent = np.volTarget;
        np.volEl.value = np.volCurrent.toFixed(2);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const np: any = {
  lastDur: 0, lastPos: 0, lastSync: performance.now(), paused: true, curUri: null,
};

// ----------------------------------------------------------------- polling

function startPolling() {
  // In-flight dedupe — without this, a slow network or paused renderer can
  // queue up several pending playback/queue fetches that all resolve at once
  // and thrash state subscribers. Skip the next tick if one is still pending.
  let playbackInFlight = false;
  let queueInFlight = false;
  const pollPlayback = () => {
    if (playbackInFlight) return;
    playbackInFlight = true;
    api.playbackState()
      .then((s: any) => { if (s) state.playback.set(s); })
      .catch(() => {})
      .finally(() => { playbackInFlight = false; });
  };
  const pollQueue = () => {
    if (queueInFlight) return;
    queueInFlight = true;
    api.queueGet()
      .then((r: any) => state.queue.set(r?.queue ?? []))
      .catch(() => {})
      .finally(() => { queueInFlight = false; });
  };
  // Skip polls while the window is hidden — saves API quota and CPU. When
  // the user comes back, kick a fresh poll immediately so state isn't stale.
  setInterval(() => {
    if (document.hidden) return;
    if (performance.now() < pollSuppressedUntil()) return;
    pollPlayback();
  }, 5000);
  setInterval(() => {
    if (document.hidden) return;
    pollQueue();
  }, 4000);
  pollPlayback();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    pollPlayback();
    pollQueue();
  });
}
