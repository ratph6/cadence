import { api } from "../../api";
import { state } from "../../store";
import { playback, apiToSlider, suppressPollFor } from "../../player";
import { fmt, currentTrack, currentDuration } from "../util";
import { ui, navigate } from "../state";

// ----------------------------------------------------------------- now-bar

export function mountNowBar(root: HTMLElement) {
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
    if (a?.id) { ui.openArtistId = a.id; navigate("artist"); }
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
