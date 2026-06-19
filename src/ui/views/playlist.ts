import { api } from "../../api";
import { getConfig } from "../../settings";
import { playback } from "../../player";
import { fmt, idFromUri } from "../util";
import { ui, navigate, cache, setPlaylistDetail, touchPlaylistDetail, persistSave } from "../state";
import { trackList } from "../components/track-list";


export function renderPlaylistDetail(id: string) {
  let entry = cache.playlistDetail.get(id);
  ui.viewEl.innerHTML = `
    <div class="page">
      <button class="back" data-back>← Back</button>
      <div class="hero" id="hero">Loading…</div>
      <div id="pl-tracks"></div>
    </div>`;
  ui.viewEl.querySelector<HTMLButtonElement>("[data-back]")!
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
      if (ui.curView === "playlist" && ui.openPlaylistId === id) drawPlaylistDetail(id);
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
export function prefetchPlaylistDetail(id: string) {
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
      if (ui.curView === "playlist" && ui.openPlaylistId === id) drawPlaylistDetail(id);
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
export function schedulePrewarm() {
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
      if (ui.curView === "playlist" && ui.openPlaylistId === id) drawPlaylistDetail(id);
    }
  } catch (e) {
    console.warn("[playlists] paginate failed", e);
  } finally {
    entry.paginating = false;
  }
}
