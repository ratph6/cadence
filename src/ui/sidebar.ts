import { api } from "../api";
import { state } from "../store";
import { playback } from "../player";
import { getConfig, patchConfig } from "../settings";
import { fmt, idFromUri } from "./util";
import { ui, navigate, cache, persistSave } from "./state";
import { showCtxMenu, type CtxItem } from "./components/ctx-menu";
import { prefetchPlaylistDetail } from "./views/playlist";
import { renderHome } from "./views/home";

/** Playback context URI for a playlist row. Liked Songs is the special
 *  `collection` pseudo-playlist keyed on the current user id. */
export function playlistContextUri(id: string): string {
  return id === "liked-songs"
    ? `spotify:user:${state.me.get()?.id}:collection`
    : `spotify:playlist:${id}`;
}

/** Shared Open / Play / (Un)pin context-menu items for any playlist row
 *  (sidebar list, pinned list, home pins). */
export function playlistCtxItems(id: string, pinLabel: "Pin" | "Unpin"): CtxItem[] {
  return [
    { label: "Open", fn: () => openListItem(id) },
    { label: "Play", fn: () => playback.start({ contextUri: playlistContextUri(id) }) },
    { label: pinLabel, fn: () => togglePin(id) },
  ];
}


export async function loadPlaylists(force = false): Promise<any[]> {
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

export function renderPlaylistsSidebar(items: any[]) {
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
      showCtxMenu(e, playlistCtxItems(id, pinned.has(id) ? "Unpin" : "Pin"));
    });
  });
  ul.querySelectorAll<HTMLButtonElement>(".pin-btn").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePin(b.dataset.pin!);
    });
  });
}

export function openListItem(id: string) {
  if (id === "liked-songs") return navigate("liked");
  ui.openPlaylistId = id;
  navigate("playlist");
}

export function togglePin(id: string) {
  const cfg = getConfig();
  const pins = new Set(cfg.pinnedPlaylists ?? []);
  if (pins.has(id)) pins.delete(id);
  else pins.add(id);
  patchConfig({ pinnedPlaylists: [...pins] }).then(() => {
    renderPinned();
    if (cache.playlists) renderPlaylistsSidebar(cache.playlists);
    if (ui.curView === "home") renderHome();
    // Prefetch any newly-pinned playlist so its first open is instant.
    if (id !== "liked-songs") prefetchPlaylistDetail(id);
  });
}

export function renderPinned() {
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
      showCtxMenu(e, playlistCtxItems(id, "Unpin"));
    });
  });
  pins.forEach((id) => {
    if (id === "liked-songs" || cache.pinMeta.has(id)) return;
    api.raw("GET", `/playlists/${id}`, [["fields", "name,images"]])
      .then((p: any) => { cache.pinMeta.set(id, p); persistSave(); renderPinned(); })
      .catch(() => {});
  });
}
