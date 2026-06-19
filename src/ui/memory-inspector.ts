import { sys } from "../api";
import { state } from "../store";
import { getConfig } from "../settings";


// Memory graph: small canvas in the now-bar's right cell. Samples the
// Cadence process RSS via a Tauri command (works on macOS/Win/Linux —
// `performance.memory` is Chromium-only and missing in WKWebView).
const MEM_SAMPLES = 80;
const MEM_SAMPLE_MS = 200;
let memBuf: number[] = [];
let memTimer: number | undefined;
let memRaf: number | undefined;
let memLastSampleAt = 0;
let memLastRss = 0;
let memEl: HTMLDivElement | null = null;
let memCanvas: HTMLCanvasElement | null = null;
let memLabel: HTMLSpanElement | null = null;

export function applyMemoryGraph() {
  const on = getConfig().features?.showMemoryGraph === true;
  // Sits in the topbar, immediately before the user-name badge.
  const host = document.querySelector<HTMLElement>(".topbar");
  const userBadge = document.getElementById("user");
  if (on && !memEl && host) {
    memEl = document.createElement("div");
    memEl.className = "mem-widget";
    memEl.innerHTML = `<canvas width="180" height="36"></canvas><span class="mem-label">— MB</span>`;
    if (userBadge) host.insertBefore(memEl, userBadge);
    else host.appendChild(memEl);
    memCanvas = memEl.querySelector("canvas");
    memLabel = memEl.querySelector(".mem-label");
    memEl.title = "Click for memory breakdown";
    memEl.addEventListener("click", openMemoryInspector);
    memBuf = [];
    memLastSampleAt = performance.now();
    memTimer = window.setInterval(memSample, MEM_SAMPLE_MS);
    memSample();
    memRaf = requestAnimationFrame(memLoop);
  } else if (!on && memEl) {
    memEl.remove();
    memEl = null;
    memCanvas = null;
    memLabel = null;
    if (memTimer !== undefined) { clearInterval(memTimer); memTimer = undefined; }
    if (memRaf !== undefined) { cancelAnimationFrame(memRaf); memRaf = undefined; }
  }
}

async function memSample() {
  let used = 0;
  try {
    const { rss } = await sys.processMemory();
    used = rss;
  } catch {
    // Tauri command unavailable (e.g. running in plain browser dev). Fall back
    // to V8 heap so dev mode still shows something rather than a flat zero.
    const m = (performance as any).memory;
    used = m?.usedJSHeapSize ?? 0;
  }
  memLastRss = used;
  if (memBuf.push(used) > MEM_SAMPLES) memBuf.shift();
  memLastSampleAt = performance.now();
  if (memLabel) {
    const mb = used / 1048576;
    memLabel.textContent = `${mb.toFixed(1)} MB`;
  }
}

function memLoop() {
  if (!memCanvas) return;
  drawMem();
  memRaf = requestAnimationFrame(memLoop);
}

// ----------------------------------------------------------------- memory inspector

let memInspectorEl: HTMLDivElement | null = null;
let memInspectorTimer: number | undefined;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(2)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

interface MemRow { label: string; bytes: number; detail?: string; }

function gatherMemoryRows(): { rows: MemRow[]; heap: { used: number; total: number; limit: number } | null; rss: number } {
  const rows: MemRow[] = [];

  // 1. Images currently in the DOM. Decoded RGBA bytes ≈ width * height * 4.
  // Browser may dedupe identical sources, so this overstates a bit — call out
  // the assumption in the detail line.
  const imgs = Array.from(document.images);
  let imgBytes = 0;
  let imgCount = 0;
  for (const img of imgs) {
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) continue;
    imgBytes += w * h * 4;
    imgCount += 1;
  }
  rows.push({
    label: "Images (decoded)",
    bytes: imgBytes,
    detail: `${imgCount} loaded <img> elements (RGBA estimate; browser may dedupe by URL)`,
  });

  // 2. Canvas backing stores. Same RGBA assumption.
  const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas"));
  let canvasBytes = 0;
  for (const c of canvases) canvasBytes += c.width * c.height * 4;
  rows.push({
    label: "Canvas surfaces",
    bytes: canvasBytes,
    detail: `${canvases.length} <canvas> elements (memory graph, visualizer, album art)`,
  });

  // 3. DOM nodes — rough 256 B per node from V8 retained-size heuristics.
  const nodeCount = document.getElementsByTagName("*").length;
  rows.push({
    label: "DOM nodes",
    bytes: nodeCount * 256,
    detail: `${nodeCount} elements × ~256 B retained per node (rough)`,
  });

  // 4. localStorage — JS strings are 16-bit per char.
  let lsChars = 0;
  let lsKeys = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      lsKeys += 1;
      lsChars += k.length + (localStorage.getItem(k)?.length ?? 0);
    }
  } catch {}
  rows.push({
    label: "localStorage",
    bytes: lsChars * 2,
    detail: `${lsKeys} keys × 2 B/char (cached config, queue history, tokens)`,
  });

  // 5. sessionStorage.
  let ssChars = 0;
  let ssKeys = 0;
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)!;
      ssKeys += 1;
      ssChars += k.length + (sessionStorage.getItem(k)?.length ?? 0);
    }
  } catch {}
  rows.push({
    label: "sessionStorage",
    bytes: ssChars * 2,
    detail: `${ssKeys} keys`,
  });

  // 6. Our own state caches (memory ring buffer + queue + recent playback object).
  let stateBytes = 0;
  try {
    stateBytes += JSON.stringify(state.playback.get() ?? {}).length * 2;
    stateBytes += JSON.stringify(state.queue.get() ?? []).length * 2;
  } catch {}
  rows.push({
    label: "Live state objects",
    bytes: stateBytes,
    detail: "Serialized playback + queue snapshot (proxy for retained state)",
  });

  // 7. Stylesheets (CSSOM). Imported Vencord themes can balloon this — a
  // 100 KB resolved theme parses into thousands of CSS rule objects, each
  // ~200-500 B retained. Measured by summing every <style>'s textContent
  // length × 2 (chars-to-bytes) plus a per-rule overhead estimate.
  let cssChars = 0;
  let cssRules = 0;
  let cssSheets = 0;
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      cssSheets += 1;
      try {
        const rules = (sheet as CSSStyleSheet).cssRules;
        if (rules) cssRules += rules.length;
      } catch { /* cross-origin sheet — skip */ }
    }
    for (const el of Array.from(document.querySelectorAll("style"))) {
      cssChars += (el.textContent?.length ?? 0);
    }
  } catch {}
  rows.push({
    label: "Stylesheets (CSSOM)",
    bytes: cssChars * 2 + cssRules * 256,
    detail: `${cssSheets} sheets, ${cssRules} rules, ${(cssChars / 1024).toFixed(1)} KB raw text (~256 B/rule retained)`,
  });

  rows.push({
    label: "Memory graph buffer",
    bytes: memBuf.length * 8,
    detail: `${memBuf.length} samples × 8 B (Number)`,
  });

  rows.sort((a, b) => b.bytes - a.bytes);

  const m = (performance as any).memory;
  const heap = m
    ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit }
    : null;
  return { rows, heap, rss: memLastRss };
}

function renderMemoryInspector(panel: HTMLElement) {
  const { rows, heap, rss } = gatherMemoryRows();
  const rssBlock = rss > 0
    ? `
      <table>
        <tr><td class="label">Process RSS</td><td class="val">${fmtBytes(rss)}</td></tr>
      </table>
      <table>
        <tr><td class="detail">Whole Cadence process — WebView + Rust side + audio pipeline. Updated every ${MEM_SAMPLE_MS} ms.</td></tr>
      </table>`
    : `<table><tr><td class="detail">Process memory unavailable.</td></tr></table>`;
  const heapBlock = heap
    ? `
      <table>
        <tr><td class="label">JS heap used</td><td class="val">${fmtBytes(heap.used)}</td></tr>
        <tr><td class="label">JS heap allocated</td><td class="val">${fmtBytes(heap.total)}</td></tr>
        <tr><td class="label">JS heap limit</td><td class="val">${fmtBytes(heap.limit)}</td></tr>
      </table>`
    : "";

  const total = rows.reduce((a, b) => a + b.bytes, 0);
  const breakdown = rows
    .map(
      (r) => `
        <tr>
          <td class="label">${r.label}</td>
          <td class="val">${fmtBytes(r.bytes)}</td>
        </tr>
        ${r.detail ? `<tr><td class="detail" colspan="2">${r.detail}</td></tr>` : ""}`,
    )
    .join("");

  panel.innerHTML = `
    <header>
      <h3>Cadence Memory Inspector</h3>
      <button class="close-x" aria-label="Close">×</button>
    </header>
    ${rssBlock}
    ${heapBlock}
    <table>
      <tr><td class="detail" style="padding-top:10px">Estimated breakdown of in-page allocations (approximations — see notes):</td></tr>
    </table>
    <table>${breakdown}</table>
    <footer>
      <span>Sum of estimates: ${fmtBytes(total)}</span>
      <span>Refreshes every 1s</span>
    </footer>`;

  panel.querySelector<HTMLButtonElement>(".close-x")!
    .addEventListener("click", closeMemoryInspector);
}

function openMemoryInspector() {
  if (memInspectorEl) return;
  memInspectorEl = document.createElement("div");
  memInspectorEl.className = "mem-inspector";
  memInspectorEl.innerHTML = `<div class="panel"></div>`;
  memInspectorEl.addEventListener("click", (e) => {
    if (e.target === memInspectorEl) closeMemoryInspector();
  });
  document.body.appendChild(memInspectorEl);

  const panel = memInspectorEl.querySelector<HTMLElement>(".panel")!;
  renderMemoryInspector(panel);
  memInspectorTimer = window.setInterval(() => {
    if (memInspectorEl) renderMemoryInspector(panel);
  }, 1000);

  document.addEventListener("keydown", memInspectorKeyHandler);
}

function closeMemoryInspector() {
  if (!memInspectorEl) return;
  memInspectorEl.remove();
  memInspectorEl = null;
  if (memInspectorTimer !== undefined) {
    clearInterval(memInspectorTimer);
    memInspectorTimer = undefined;
  }
  document.removeEventListener("keydown", memInspectorKeyHandler);
}

function memInspectorKeyHandler(e: KeyboardEvent) {
  if (e.key === "Escape") closeMemoryInspector();
}

function drawMem() {
  if (!memCanvas) return;
  const ctx = memCanvas.getContext("2d");
  if (!ctx) return;
  const w = memCanvas.width, h = memCanvas.height;
  ctx.clearRect(0, 0, w, h);
  if (memBuf.length < 2) return;

  const min = Math.min(...memBuf);
  const max = Math.max(...memBuf);
  const span = Math.max(max - min, 1);
  const yFor = (v: number) => h - 3 - ((v - min) / (span * 1.15)) * (h - 6);

  // Continuous left-scroll: phase ∈ [0,1] is "fraction of a sample period
  // since the last sample". Shift every x by phase * sampleWidth so the
  // curve flows leftward at exactly real-time speed instead of jumping
  // when a new sample arrives. The newest sample sits at x = w; each
  // older sample is one sampleWidth to the left.
  const sampleWidth = w / (MEM_SAMPLES - 1);
  const phase = Math.min(1, (performance.now() - memLastSampleAt) / MEM_SAMPLE_MS);

  const last = memBuf.length - 1;
  const pts: { x: number; y: number }[] = memBuf.map((v, i) => ({
    x: w + (i - last - phase) * sampleWidth,
    y: yFor(v),
  }));

  // Midpoint-quadratic smoothing.
  const buildPath = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
      const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
      ctx.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
    }
    const lastPt = pts[pts.length - 1]!;
    ctx.lineTo(lastPt.x, lastPt.y);
  };

  buildPath();
  ctx.lineTo(w + sampleWidth, h);
  ctx.lineTo(pts[0]!.x, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(30,215,96,.40)");
  grad.addColorStop(1, "rgba(30,215,96,0)");
  ctx.fillStyle = grad;
  ctx.fill();

  buildPath();
  ctx.strokeStyle = "rgba(30,215,96,.95)";
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}
