// Shared view-layer state extracted from app.ts: the mutable UI refs, the
// view-disposer registry, the navigate() dispatcher (wired through a renderer
// registry so app.ts and the view modules don't form an import cycle), and the
// in-memory + localStorage caches.

export type View = "home" | "search" | "playlist" | "liked" | "focus" | "settings" | "artist" | "stats" | "devices";

// Mutable shared refs live on one object: ES module bindings are read-only to
// importers, but other modules need to reassign these (e.g. `ui.openArtistId =
// id`), which a bare `export let` would forbid.
export const ui = {
  curView: "home" as View,
  openPlaylistId: null as string | null,
  openArtistId: null as string | null,
  viewEl: null as unknown as HTMLElement,
  searchInput: null as unknown as HTMLInputElement,
};

const viewDisposers: Array<() => void> = [];
export function pushDisposer(d: () => void) {
  viewDisposers.push(d);
}
export function disposeViewSubs() {
  viewDisposers.forEach((d) => { try { d(); } catch {} });
  viewDisposers.length = 0;
}

// navigate() dispatches to per-view render functions registered by app.ts at
// boot. The indirection breaks what would otherwise be a circular import
// (app.ts -> views -> app.ts) since views call navigate() back.
let viewRenderers: Partial<Record<View, () => void>> = {};
export function registerViews(r: Partial<Record<View, () => void>>) {
  viewRenderers = r;
}
export function navigate(v: View) {
  if (v === "search" && ui.curView === "search") return;
  disposeViewSubs();
  ui.curView = v;
  document.querySelectorAll<HTMLButtonElement>(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.nav === v);
  });
  viewRenderers[v]?.();
}

// ----------------------------------------------------------------- caches

export const cache: {
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
export function setPlaylistDetail(id: string, entry: any) {
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
export function touchPlaylistDetail(id: string) {
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

export function persistLoad() {
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
export function persistSave() {
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
