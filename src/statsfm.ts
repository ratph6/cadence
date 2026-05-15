// stats.fm public read API. No auth — just the user's stats.fm username
// (defaults to their Spotify user id if they imported via Spotify).
//
// Docs: https://docs.stats.fm/

const BASE = "https://api.stats.fm/api/v1";

export type Range = "today" | "days" | "weeks" | "months" | "lifetime";

async function call(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`stats.fm ${path} ${r.status}: ${body.slice(0, 120)}`);
  }
  return r.json();
}

export const statsfm = {
  user: (u: string) => call(`/users/${encodeURIComponent(u)}`).then((j) => j.item ?? j),

  streamStats: (u: string, range: Range = "lifetime") =>
    call(`/users/${encodeURIComponent(u)}/streams/stats?range=${range}`)
      .then((j) => j.items ?? j),

  topTracks: (u: string, range: Range = "weeks", limit = 25) =>
    call(`/users/${encodeURIComponent(u)}/top/tracks?range=${range}&limit=${limit}`)
      .then((j) => j.items ?? []),

  topArtists: (u: string, range: Range = "weeks", limit = 25) =>
    call(`/users/${encodeURIComponent(u)}/top/artists?range=${range}&limit=${limit}`)
      .then((j) => j.items ?? []),

  topAlbums: (u: string, range: Range = "weeks", limit = 25) =>
    call(`/users/${encodeURIComponent(u)}/top/albums?range=${range}&limit=${limit}`)
      .then((j) => j.items ?? []),

  recentStreams: (u: string, limit = 25) =>
    call(`/users/${encodeURIComponent(u)}/streams?limit=${limit}`)
      .then((j) => j.items ?? []),
};
