import { api } from "../../api";
import { getConfig } from "../../settings";
import { fmt } from "../util";
import { ui, cache, persistSave, pushDisposer } from "../state";
import { showCtxMenu } from "../components/ctx-menu";
import { trackList } from "../components/track-list";
import { openListItem, togglePin, playlistCtxItems } from "../sidebar";


// ----------------------------------------------------------------- views

export function renderHome() {
  const hour = new Date().getHours();
  const greet =
    hour < 5 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const features = getConfig().features ?? {};
  const showRecents = features.showRecents !== false;
  const showClock = features.showClock !== false;

  const showCat = features.homeCatPhoto === true;
  const showJoke = features.homeDadJoke === true;
  const showNews = features.homeNews === true;
  const showViz = features.homeVisualizer === true;
  const anyExtras = showCat || showJoke || showNews || showViz;

  ui.viewEl.innerHTML = `
    <div class="page home-page">
      <div class="home-head">
        <h1 class="hello">Good ${greet}.</h1>
        ${showClock ? `<div class="home-clock" id="home-clock"></div>` : ""}
      </div>

      <div id="home-pins"></div>

      ${anyExtras ? `
        <div class="home-extras">
          ${showViz ? `<div class="home-card home-viz" id="home-viz"><div class="home-card-h">Audio visualizer</div><div class="home-card-body viz-body"><canvas id="viz-canvas" width="320" height="120"></canvas></div></div>` : ""}
          ${showNews ? `<div class="home-card home-news" id="home-news"><div class="home-card-h">The Hacker News · cybersecurity</div><div class="home-card-body dim">Loading…</div></div>` : ""}
          ${showJoke ? `<div class="home-card home-joke" id="home-joke"><div class="home-card-h">Dad joke</div><div class="home-card-body">Loading…</div></div>` : ""}
          ${showCat ? `<div class="home-card home-cat" id="home-cat"><div class="home-card-h">Cat</div><div class="home-card-body cat-body"><div class="dim small">Loading…</div></div></div>` : ""}
        </div>
      ` : ""}

      ${showRecents ? `
        <h2 class="sub">Recently played</h2>
        <div id="recents"></div>
      ` : ""}
    </div>`;

  if (showCat) loadCatPhoto();
  if (showJoke) loadDadJoke();
  if (showNews) loadHackerNews();
  if (showViz) startVisualizer();

  if (showClock) startHomeClock();

  drawHomePins();

  if (showRecents) {
    const dest = document.getElementById("recents")!;
    if (cache.recents) {
      dest.innerHTML = "";
      dest.appendChild(trackList(cache.recents, { showAlbum: false }));
    } else {
      dest.innerHTML = `<p class="dim">Loading…</p>`;
      api.raw("GET", "/me/player/recently-played", [["limit", "20"]])
        .then((r: any) => {
          cache.recents = (r?.items ?? []).map((it: any) => it.track).filter(Boolean);
          persistSave();
          if (ui.curView !== "home") return;
          dest.innerHTML = "";
          if (!cache.recents!.length) {
            dest.innerHTML = `<p class="dim">Nothing yet.</p>`;
            return;
          }
          dest.appendChild(trackList(cache.recents!, { showAlbum: false }));
        })
        .catch(() => {
          if (!cache.recents) dest.innerHTML = `<p class="dim">Couldn't load.</p>`;
        });
    }
  }
}

// ----- Home audio visualizer ------------------------------------------
// Polls Rust spectrum_get every animation frame, smooths transitions, draws
// 8 vertical bars. Falls flat (zeros) when the librespot+EQ pipeline isn't
// running — that's the only path with PCM access.
let vizRaf: number | undefined;
let vizDisplay: number[] = new Array(8).fill(0);
async function startVisualizer() {
  const canvas = document.getElementById("viz-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // Match the canvas backing buffer to actual rendered size × devicePixelRatio
  // so the bars render at native sharpness instead of being stretched. We
  // observe the host card and re-fit on resize.
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const fit = () => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  };
  fit();
  const ro = new ResizeObserver(fit);
  ro.observe(canvas);

  const { spectrum } = await import("../../api");

  let lastSpectrum: number[] = new Array(8).fill(0);
  let pollInflight = false;
  let warned = false;
  const poll = async () => {
    if (pollInflight) return;
    pollInflight = true;
    try {
      const v = await spectrum.get();
      if (Array.isArray(v) && v.length === 8) lastSpectrum = v;
    } catch (e) {
      if (!warned) {
        console.warn("[viz] spectrum_get failed (audio backend is probably SDK; switch to librespot+EQ to see real bars):", e);
        warned = true;
      }
    }
    pollInflight = false;
  };
  // Poll Rust at 30 Hz, draw at full RAF rate using interpolation.
  const pollTimer = window.setInterval(poll, 33);
  poll();

  const tick = () => {
    if (!document.getElementById("viz-canvas")) {
      clearInterval(pollTimer);
      vizRaf = undefined;
      return;
    }
    // Smooth toward the latest sample for buttery animation.
    const k = 0.25;
    for (let i = 0; i < 8; i++) {
      const cur = vizDisplay[i] ?? 0;
      const tgt = lastSpectrum[i] ?? 0;
      vizDisplay[i] = cur + (tgt - cur) * k;
    }
    drawVizFrame(ctx, canvas, vizDisplay);
    vizRaf = requestAnimationFrame(tick);
  };
  vizRaf = requestAnimationFrame(tick);
  // If user navigates away, the canvas disappears — tick() catches that
  // and stops itself; the interval is also cleared inside.
  pushDisposer(() => {
    if (vizRaf !== undefined) cancelAnimationFrame(vizRaf);
    vizRaf = undefined;
    clearInterval(pollTimer);
    ro.disconnect();
  });
}

function drawVizFrame(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, values: number[]) {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const n = values.length;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  // Use device-pixel units so bars are crisp; everything below scales by dpr.
  const padding = 8 * dpr;
  const gap = 6 * dpr;
  const totalGap = gap * (n - 1);
  const barW = (w - 2 * padding - totalGap) / n;
  const radius = Math.min(barW / 2, 4 * dpr);
  for (let i = 0; i < n; i++) {
    // Visual scaling: bandpass RMS clusters low. sqrt + boost reads cleaner.
    const v = Math.min(1, Math.sqrt(Math.max(0, values[i]!) * 5));
    const bh = Math.max(2 * dpr, v * (h - 2 * padding));
    const x = padding + i * (barW + gap);
    const y = h - padding - bh;
    const grad = ctx.createLinearGradient(0, y, 0, h - padding);
    grad.addColorStop(0, "rgba(30,215,96,.95)");
    grad.addColorStop(1, "rgba(30,215,96,.30)");
    ctx.fillStyle = grad;
    // Pure rounded-rect (top corners only) using path API.
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + barW - radius, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + radius);
    ctx.lineTo(x + barW, h - padding);
    ctx.lineTo(x, h - padding);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
  }
}

// ----- Home extras (cataas / dad joke / Hacker News) ------------------
async function loadCatPhoto() {
  const card = document.getElementById("home-cat");
  if (!card) return;
  const body = card.querySelector<HTMLElement>(".home-card-body");
  if (!body) return;
  // cataas returns the image directly. Add a cache-buster so click-refresh
  // gets a fresh cat instead of a memoized one.
  const url = `https://cataas.com/cat?width=560&t=${Date.now()}`;
  body.innerHTML = `<img class="cat-img" loading="lazy" alt="cat" />`;
  const img = body.querySelector<HTMLImageElement>("img")!;
  img.src = url;
  img.onerror = () => { body.innerHTML = `<div class="dim small">Couldn't load cat.</div>`; };
  card.onclick = () => loadCatPhoto();
}

async function loadDadJoke() {
  const card = document.getElementById("home-joke");
  if (!card) return;
  const body = card.querySelector<HTMLElement>(".home-card-body");
  if (!body) return;
  try {
    const r = await fetch("https://icanhazdadjoke.com/", {
      headers: { Accept: "application/json" },
    });
    const j = await r.json();
    body.textContent = j.joke ?? "—";
  } catch {
    body.textContent = "Couldn't fetch a joke.";
  }
  card.onclick = () => loadDadJoke();
}

async function loadHackerNews() {
  const card = document.getElementById("home-news");
  if (!card) return;
  const body = card.querySelector<HTMLElement>(".home-card-body");
  if (!body) return;
  // The Hacker News (cybersecurity news at thehackernews.com) doesn't expose
  // a JSON API; their RSS feed is at feeds.feedburner.com/TheHackersNews.
  // Use rss2json (free, no key) to convert to JSON cleanly.
  try {
    const url = "https://api.rss2json.com/v1/api.json?rss_url=" +
      encodeURIComponent("https://feeds.feedburner.com/TheHackersNews");
    const r = await fetch(url);
    const j = await r.json();
    const items = (j?.items ?? []).slice(0, 5);
    if (!items.length) { body.textContent = "No stories."; return; }
    body.innerHTML = `<ol class="news-list">${items.map((it: any) => {
      const link = it?.link ?? "https://thehackernews.com/";
      const date = it?.pubDate ? new Date(it.pubDate).toLocaleDateString(undefined,
        { month: "short", day: "numeric" }) : "";
      const author = it?.author ? ` · ${it.author}` : "";
      return `<li>
        <a class="news-title" href="${fmt.esc(link)}" target="_blank" rel="noopener">${fmt.esc(it?.title ?? "?")}</a>
        <div class="dim small">${fmt.esc(date)}${fmt.esc(author)} · thehackernews.com</div>
      </li>`;
    }).join("")}</ol>`;
  } catch (e) {
    body.textContent = `Couldn't load news (${String(e)}).`;
  }
}

let clockTimer: number | undefined;
function startHomeClock() {
  const tick = () => {
    const el = document.getElementById("home-clock");
    if (!el) {
      if (clockTimer) { clearInterval(clockTimer); clockTimer = undefined; }
      return;
    }
    const d = new Date();
    el.textContent = d.toLocaleTimeString(undefined,
      { hour: "2-digit", minute: "2-digit", hour12: false });
  };
  tick();
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = window.setInterval(tick, 30_000);
  pushDisposer(() => {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = undefined; }
  });
}

function drawHomePins() {
  const dest = document.getElementById("home-pins");
  if (!dest) return;
  const pins = (getConfig().pinnedPlaylists ?? []).slice(0, 12);
  if (!pins.length) {
    dest.innerHTML = `<p class="dim small">Pin a playlist (★ in the sidebar) to see it here.</p>`;
    return;
  }
  dest.innerHTML = `<div class="home-pin-grid">${pins.map((id) => {
    const meta = cache.pinMeta.get(id);
    if (id === "liked-songs") {
      return `<button class="home-pin liked" data-id="liked-songs">
        <div class="home-pin-art liked-mini">♥</div>
        <div class="home-pin-name">Liked Songs</div>
      </button>`;
    }
    const cover = meta?.images?.[0]?.url ?? "";
    const name = meta?.name ?? "…";
    return `<button class="home-pin" data-id="${fmt.esc(id)}">
      ${cover ? `<img class="home-pin-art" loading="lazy" src="${fmt.esc(cover)}" />`
              : `<div class="home-pin-art ph"></div>`}
      <div class="home-pin-name">${fmt.esc(name)}</div>
    </button>`;
  }).join("")}</div>`;

  dest.querySelectorAll<HTMLButtonElement>(".home-pin").forEach((b) => {
    b.addEventListener("click", () => openListItem(b.dataset.id!));
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const id = b.dataset.id!;
      showCtxMenu(e, playlistCtxItems(id, "Unpin"));
    });
  });

  // Lazy-fetch any missing pin metadata for richer cards.
  pins.forEach((id) => {
    if (id === "liked-songs" || cache.pinMeta.has(id)) return;
    api.raw("GET", `/playlists/${id}`, [["fields", "name,images"]])
      .then((p: any) => { cache.pinMeta.set(id, p); if (ui.curView === "home") drawHomePins(); })
      .catch(() => {});
  });
}
