import { api } from "../../api";
import { state } from "../../store";
import { playback } from "../../player";
import { fmt, idFromUri, currentTrack } from "../util";
import { ui, navigate, cache, pushDisposer } from "../state";
import { showCtxMenu, type CtxItem } from "./ctx-menu";


// ----------------------------------------------------------------- track list

interface TrackListOpts {
  showAlbum?: boolean;
  showQueueButton?: boolean;
  contextUri?: string;
}

export function trackList(tracks: any[], opts: TrackListOpts): HTMLElement {
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
        if (aid) { ui.openArtistId = aid; navigate("artist"); }
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
          fn: () => { ui.openArtistId = a.id; navigate("artist"); },
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
    pushDisposer(() => { cancelled = true; });
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
  pushDisposer(state.playback.subscribe(sync));

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
