import { playback } from "../../player";
import { state } from "../../store";
import { fmt, currentTrack } from "../util";
import { ui, pushDisposer } from "../state";


export function renderFocus() {
  ui.viewEl.innerHTML = `
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
  pushDisposer(state.playback.subscribe(drawFocus));
}

let lastFocusUri = "__none";
function drawFocus() {
  if (ui.curView !== "focus") return;
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
