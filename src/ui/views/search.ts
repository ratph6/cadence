import { api } from "../../api";
import { state } from "../../store";
import { fmt } from "../util";
import { ui, navigate } from "../state";
import { trackList } from "../components/track-list";

let searchSeq = 0;
let lastSearchQ = "";


export function renderSearch() {
  ui.viewEl.innerHTML = `<div class="page"><div id="search-out"></div></div>`;
  const out = document.getElementById("search-out")!;
  const q = ui.searchInput.value.trim();
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
        ui.openArtistId = a.id;
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
export function renderSearchHistoryDropdown() {
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
      ui.searchInput.value = q;
      ui.searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      ui.searchInput.blur();
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
export function hideSearchHistoryDropdown() {
  const ul = document.getElementById("search-history");
  if (ul) ul.hidden = true;
}

export function onSearchInput() {
  const q = ui.searchInput.value.trim();
  if (q === "") {
    // Empty input + focused = show history.
    if (document.activeElement === ui.searchInput) renderSearchHistoryDropdown();
  } else {
    hideSearchHistoryDropdown();
  }
  if (ui.curView !== "search" && q) navigate("search");
  if (q === lastSearchQ) return;
  lastSearchQ = q;
  if (q.length < 2) {
    state.searchResults.set(null);
    if (ui.curView === "search") renderSearch();
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
        if (ui.curView === "search") renderSearch();
      })
      .catch(() => {});
  }, 200);
}
