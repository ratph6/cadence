import { api } from "../../api";
import { state } from "../../store";
import { playback } from "../../player";
import { fmt } from "../util";
import { ui, navigate, cache, persistSave } from "../state";
import { trackList } from "../components/track-list";


export function renderLiked() {
  let entry = cache.liked;
  ui.viewEl.innerHTML = `
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
  ui.viewEl.querySelector<HTMLButtonElement>("[data-back]")!
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
        if (ui.curView === "liked") draw();
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
      if (ui.curView === "liked") {
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
