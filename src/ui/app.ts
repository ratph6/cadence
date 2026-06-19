// Vanilla-DOM Spotify UI shell. Builds the chrome (titlebar, sidebar, topbar,
// now-bar) and wires the views together via the navigate() registry in
// ./state. The per-view rendering lives in ./views/*; shared helpers in
// ./util, ./components/*, ./sidebar, ./poll, ./features.

import { auth } from "../api";
import { state } from "../store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { BRAND } from "./util";
import { ui, navigate, registerViews, persistLoad, cache, type View } from "./state";
import { hideCtxMenu } from "./components/ctx-menu";
import { mountNowBar } from "./components/now-bar";
import { startPolling } from "./poll";
import { applyFeatureClasses } from "./features";
import { loadPlaylists, renderPinned } from "./sidebar";
import { renderHome } from "./views/home";
import { renderSearch, onSearchInput, renderSearchHistoryDropdown, hideSearchHistoryDropdown } from "./views/search";
import { renderPlaylistDetail, schedulePrewarm } from "./views/playlist";
import { renderLiked } from "./views/liked";
import { renderArtist } from "./views/artist";
import { renderFocus } from "./views/focus";
import { renderStats } from "./views/stats";
import { renderDevices } from "./views/devices";
import { renderSettings } from "./views/settings";

// Wire the navigate() dispatcher. playlist/artist read their target id from the
// shared `ui` refs (set by the click handlers that called navigate), matching
// the original switch's renderPlaylistDetail(openPlaylistId!) behaviour.
registerViews({
  home: renderHome,
  search: renderSearch,
  playlist: () => renderPlaylistDetail(ui.openPlaylistId!),
  liked: renderLiked,
  focus: renderFocus,
  settings: renderSettings,
  artist: () => renderArtist(ui.openArtistId!),
  stats: renderStats,
  devices: renderDevices,
});

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
          <button class="nav-btn" data-nav="devices">Devices</button>
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

  ui.viewEl = root.querySelector<HTMLElement>("#view")!;
  ui.searchInput = root.querySelector<HTMLInputElement>("#search")!;

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

  ui.searchInput.addEventListener("input", onSearchInput);
  ui.searchInput.addEventListener("focus", () => {
    if (ui.searchInput.value.trim()) navigate("search");
    else renderSearchHistoryDropdown();
  });
  ui.searchInput.addEventListener("blur", () => {
    // Tiny delay so a click inside the dropdown can complete before we hide.
    setTimeout(hideSearchHistoryDropdown, 120);
  });
  ui.searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideSearchHistoryDropdown(); ui.searchInput.blur(); }
  });

  state.view.subscribe((v) => {
    if (v === "search") {
      navigate("search");
      ui.searchInput.focus();
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
