import { getConfig } from "../../settings";
import { fmt } from "../util";
import { ui } from "../state";


// ----------------------------------------------------------------- stats (stats.fm)

let statsRange: import("../../statsfm").Range = "weeks";
export async function renderStats() {
  const cfg = getConfig();
  const user = (cfg.statsFmUser ?? "").trim();

  ui.viewEl.innerHTML = `
    <div class="page stats-page">
      <h1>Stats</h1>
      ${!user ? `
        <div class="card">
          <p class="dim">Connect <a href="https://stats.fm/" target="_blank" rel="noopener">stats.fm</a> to see your listening history.</p>
          <p class="dim small">Settings → stats.fm → enter your stats.fm username (or your Spotify ID if you've imported via Spotify). Public profiles only — no auth.</p>
        </div>
      ` : `
        <div id="stats-info" class="card stats-info">Loading…</div>
        <div class="stats-tabs">
          ${(["today","weeks","months","lifetime"] as const).map((p) =>
            `<button class="stats-tab${p === statsRange ? " active" : ""}" data-p="${p}">${rangeLabel(p)}</button>`).join("")}
        </div>
        <div class="stats-grid">
          <section class="stats-col">
            <h2 class="sub">Top artists</h2>
            <ol id="stats-artists" class="stats-list"><li class="dim">Loading…</li></ol>
          </section>
          <section class="stats-col">
            <h2 class="sub">Top tracks</h2>
            <ol id="stats-tracks" class="stats-list"><li class="dim">Loading…</li></ol>
          </section>
          <section class="stats-col">
            <h2 class="sub">Top albums</h2>
            <ol id="stats-albums" class="stats-list"><li class="dim">Loading…</li></ol>
          </section>
          <section class="stats-col">
            <h2 class="sub">Recent streams</h2>
            <ol id="stats-recent" class="stats-list"><li class="dim">Loading…</li></ol>
          </section>
        </div>
      `}
    </div>`;

  if (!user) return;

  ui.viewEl.querySelectorAll<HTMLButtonElement>(".stats-tab").forEach((b) => {
    b.addEventListener("click", () => {
      const p = b.dataset.p as import("../../statsfm").Range;
      if (p === statsRange) return;
      statsRange = p;
      renderStats();
    });
  });

  loadStats(user, statsRange);
}

function rangeLabel(r: import("../../statsfm").Range): string {
  return r === "today" ? "today"
    : r === "days" ? "4 weeks"
    : r === "weeks" ? "6 months"
    : r === "months" ? "1 year"
    : "lifetime";
}

async function loadStats(user: string, range: import("../../statsfm").Range) {
  const { statsfm } = await import("../../statsfm");

  // User profile + lifetime totals.
  Promise.all([
    statsfm.user(user),
    statsfm.streamStats(user, range),
  ]).then(([u, s]: [any, any]) => {
    const el = document.getElementById("stats-info");
    if (!el || ui.curView !== "stats") return;
    const totalCount = s?.count ?? 0;
    const totalMs = s?.durationMs ?? 0;
    const hours = Math.round(totalMs / 1000 / 3600);
    const cardinality = s?.cardinality ?? {};
    el.innerHTML = `
      <div class="stats-info-head">
        <div class="stats-name">${fmt.esc(u?.displayName ?? u?.customId ?? user)}</div>
        <div class="dim small">${fmt.esc(rangeLabel(range))}</div>
      </div>
      <div class="stats-info-grid">
        <div><div class="stats-num">${Number(totalCount).toLocaleString()}</div><div class="dim small">streams</div></div>
        <div><div class="stats-num">${hours.toLocaleString()}</div><div class="dim small">hours played</div></div>
        <div><div class="stats-num">${cardinality.tracks ?? "—"}</div><div class="dim small">unique tracks</div></div>
        <div><div class="stats-num">${cardinality.artists ?? "—"}</div><div class="dim small">unique artists</div></div>
      </div>`;
  }).catch((e) => {
    const el = document.getElementById("stats-info");
    if (el) el.textContent = `Error: ${String(e)}`;
  });

  const fillList = (id: string, items: any[], render: (it: any, i: number) => string) => {
    const el = document.getElementById(id);
    if (!el || ui.curView !== "stats") return;
    el.innerHTML = items.length
      ? items.map(render).join("")
      : `<li class="dim small">Nothing.</li>`;
  };

  // streams field is null for non-Plus stats.fm accounts; just show ranks +
  // names then. playedMs may also be present and gives a duration figure.
  const ctBadge = (it: any) => {
    const s = it?.streams;
    if (typeof s === "number") return `<span class="ct dim small">${s.toLocaleString()} pl</span>`;
    const ms = it?.playedMs;
    if (typeof ms === "number" && ms > 0) {
      const m = Math.round(ms / 60000);
      return `<span class="ct dim small">${m.toLocaleString()}m</span>`;
    }
    return "";
  };

  statsfm.topArtists(user, range).then((items) => {
    fillList("stats-artists", items, (it: any, i: number) => {
      const a = it.artist ?? {};
      return `<li><span class="rank">${i + 1}</span><span class="name">${fmt.esc(a.name ?? "")}</span>${ctBadge(it)}</li>`;
    });
  }).catch((e) => fillList("stats-artists", [], () => `<li class="dim small">${fmt.esc(String(e))}</li>`));

  statsfm.topTracks(user, range).then((items) => {
    fillList("stats-tracks", items, (it: any, i: number) => {
      const t = it.track ?? {};
      const artists = (t.artists ?? []).map((a: any) => a.name).join(", ");
      return `<li><span class="rank">${i + 1}</span><span class="name">${fmt.esc(t.name ?? "")} <span class="dim small">— ${fmt.esc(artists)}</span></span>${ctBadge(it)}</li>`;
    });
  }).catch((e) => fillList("stats-tracks", [], () => `<li class="dim small">${fmt.esc(String(e))}</li>`));

  statsfm.topAlbums(user, range).then((items) => {
    fillList("stats-albums", items, (it: any, i: number) => {
      const a = it.album ?? {};
      const artists = (a.artists ?? []).map((ar: any) => ar.name).join(", ");
      return `<li><span class="rank">${i + 1}</span><span class="name">${fmt.esc(a.name ?? "")} <span class="dim small">— ${fmt.esc(artists)}</span></span>${ctBadge(it)}</li>`;
    });
  }).catch((e) => fillList("stats-albums", [], () => `<li class="dim small">${fmt.esc(String(e))}</li>`));

  statsfm.recentStreams(user, 25).then((items) => {
    fillList("stats-recent", items, (it: any) => {
      const t = it.track ?? {};
      const artists = (t.artists ?? []).map((a: any) => a.name).join(", ");
      const when = it.endTime ? timeAgo(new Date(it.endTime).getTime()) : "";
      return `<li><span class="name">${fmt.esc(t.name ?? "")} <span class="dim small">— ${fmt.esc(artists)}</span></span><span class="ct dim small">${fmt.esc(when)}</span></li>`;
    });
  }).catch((e) => fillList("stats-recent", [], () => `<li class="dim small">${fmt.esc(String(e))}</li>`));
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
