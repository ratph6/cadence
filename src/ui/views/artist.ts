import { api } from "../../api";
import { state } from "../../store";
import { playback } from "../../player";
import { fmt } from "../util";
import { ui, navigate, cache } from "../state";
import { trackList } from "../components/track-list";


export function renderArtist(id: string) {
  let entry = cache.artist.get(id);
  ui.viewEl.innerHTML = `
    <div class="page">
      <button class="back" data-back>← Back</button>
      <div class="hero" id="artist-hero">Loading…</div>
      <h2 class="sub">Top tracks</h2>
      <div id="artist-tracks"></div>
      <h2 class="sub">Albums</h2>
      <div id="artist-albums" class="album-row"></div>
    </div>`;
  ui.viewEl.querySelector<HTMLButtonElement>("[data-back]")!
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
        entry!.meta = m;
        if (ui.curView === "artist" && ui.openArtistId === id) drawArtist(id);
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
      if (ui.curView === "artist" && ui.openArtistId === id) drawArtist(id);
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
      if (ui.curView === "artist" && ui.openArtistId === id) drawArtist(id);
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
