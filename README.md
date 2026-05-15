# Cadence

A small Spotify desktop client. Tauri 2 + Rust + vanilla TypeScript. Roughly the same job as the official desktop app, with a different UI and some side toys (built-in CLI, real EQ via librespot, Discord rich presence, stats.fm tile, a memory graph if you want it).

It plays Spotify through the official Web API plus the Web Playback SDK by default. There is also an optional librespot path — that one's reverse-engineered, slightly nicer (real EQ, lower-latency control), and slightly riskier (against TOS, can theoretically get an account flagged). Both are described below; pick whichever you want.

This document covers everything: what to install, how the auth dance works, where files end up, every feature flag, every setting, and what to do when something doesn't behave.

---

## Table of contents

1. [What you need to install](#what-you-need-to-install)
2. [Getting it running for the first time](#getting-it-running-for-the-first-time)
3. [The Spotify Client ID](#the-spotify-client-id)
4. [Where Cadence stores stuff](#where-cadence-stores-stuff)
5. [Building installers](#building-installers)
6. [Audio backends — Web SDK vs librespot](#audio-backends--web-sdk-vs-librespot)
7. [The 10-band EQ](#the-10-band-eq)
8. [The CLI](#the-cli)
9. [Discord rich presence](#discord-rich-presence)
10. [stats.fm tile](#statsfm-tile)
11. [Home extras (cat / dad joke / Hacker News / visualizer)](#home-extras)
12. [Memory graph](#memory-graph)
13. [Keybinds](#keybinds)
14. [Settings reference](#settings-reference)
15. [Architecture](#architecture)
16. [Troubleshooting](#troubleshooting)
17. [Compliance / what's not in the box](#compliance)

---

## What you need to install

You need three things on your machine before any of this works:

- **Rust toolchain** — `rustup` from <https://rustup.rs>. The release profile uses LTO + `opt-level = "s"`; first build pulls about 250 crates and takes 5–10 minutes. Subsequent builds are fast.
- **Node.js 20 or newer** — for the dev server and bundler. Comes with `npm`.
- **A C/C++ toolchain**:
  - **Windows:** the MSVC build tools (the "Desktop development with C++" workload from the Visual Studio installer is the simplest) plus the WebView2 runtime, which is preinstalled on Windows 11 and most up-to-date Windows 10 boxes.
  - **macOS:** `xcode-select --install`.
  - **Linux:** `webkit2gtk-4.1`, `libssl-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev` and `build-essential`. The exact packages depend on your distro — see the Tauri prerequisites page if your build fails on a missing library.

Optional but useful:

- **`librespot`** binary — only if you plan to use the librespot audio backend. Install via `cargo install librespot` (this builds in your terminal, not as part of Cadence; takes ~5 minutes the first time). After that, `librespot --version` should work from any shell.

---

## Getting it running for the first time

```bash
# clone, then:
cd cadence
npm install
```

Now you need to register a Spotify app and grab a Client ID.

### Register a Spotify app

1. Go to <https://developer.spotify.com/dashboard>, sign in with the same Spotify account you'll use Cadence with.
2. **Create app**.
   - Name: anything, e.g. *Cadence*.
   - Description: anything.
   - Website: leave blank.
   - **Redirect URI:** `http://127.0.0.1:53127/callback` — this exact URL, no trailing slash, no `localhost`. The PKCE listener inside Cadence binds to `127.0.0.1:53127`, so the redirect has to match.
   - APIs: tick **Web API** and **Web Playback SDK**.
3. After creation, you'll see a **Client ID** on the app's page. Copy it.

A note on Spotify's Development Mode: when you make a new app it's in "Development Mode" by default, which means a small subset of endpoints (`/artists/{id}/top-tracks`, `/me/top/*`, `/recommendations`, `/audio-features`) return `403 Forbidden` for users that aren't explicitly added under "Users and access". For your own personal account, the easiest fix is to add yourself there. Anyone else who tries Cadence with that same Client ID will hit those errors. Cadence falls back to search-based queries where possible, but a few features (`/me/top/tracks` for auto-DJ seed) need the user added.

### First run

```bash
npm run tauri dev
```

The first launch:

1. The login screen asks for the Client ID. Paste it, click **Save**, then **Log in with Spotify**.
2. Your browser opens to the Spotify authorize page. Approve.
3. The browser tab shows "Logged in." and the app reloads itself.
4. Refresh tokens get stored in your OS credential store: macOS Keychain, Windows Credential Manager, or libsecret on Linux.

Subsequent launches don't ask for anything — they just open.

---

## The Spotify Client ID

There are two places Cadence will look for the Client ID, in order:

1. The `clientId` field in `config.json` (this is what the login screen sets).
2. The `SPOTIFY_CLIENT_ID` environment variable at runtime.

Most people just use the GUI option. The env var is useful for scripted launches or local development.

If you ever need to change the Client ID — for example, you registered a new Spotify app — go to **Settings → Spotify Client ID**, edit, save. No reboot needed; the next API call uses the new ID. (You will need to log out and log back in if the new app has different scopes.)

---

## Where Cadence stores stuff

Two locations:

- **Configuration JSON** — `<OS config dir>/cadence/config.json`.
  - Linux: `~/.config/cadence/config.json`
  - macOS: `~/Library/Application Support/cadence/config.json`
  - Windows: `%APPDATA%\cadence\config.json`

- **OAuth tokens** — OS keychain, under service identifier `dev.raph.cadence`, account `spotify-tokens`. They're never written to disk in plaintext.

If you want to start fresh, delete `config.json` and remove the keychain entry (Keychain Access on macOS, `credman` / Credential Manager on Windows, `secret-tool clear` on Linux).

The frontend also keeps a `localStorage` cache (`cadence:cache:v2`) of your playlists, recents, and pinned-playlist details so the first paint after a relaunch is instant. This is purely a UX cache — clearing it does no damage; it'll just refetch.

---

## Building installers

```bash
npm run tauri build
```

Outputs land in `src-tauri/target/release/bundle/`:

- macOS: `dmg/*.dmg` and `macos/*.app`
- Windows: `msi/*.msi` (recommended for silent installs) and `nsis/*.exe` (smaller installer with a wizard)
- Linux: `deb/*.deb`, `rpm/*.rpm`, and `appimage/*.AppImage` depending on what's available on your build host.

The release build is around 8–15 MB depending on platform. The first release build is slow because it does full LTO; subsequent builds are incremental. If you change `Cargo.toml` deps, expect a from-scratch rebuild.

---

## Audio backends — Web SDK vs librespot

Cadence can talk to Spotify two different ways. You pick which in **Settings → Audio backend**.

### Web Playback SDK (default)

This is Spotify's official, browser-based player. The SDK loads inside the WebView, decrypts via Widevine/EME, and outputs to your OS audio mixer. Pros and cons:

- **Pros:** It's the supported path. Works exactly like the Spotify desktop app. Won't get your account flagged. Gapless playback within albums works. Premium-only (free Spotify accounts can still control external Connect devices through the API, but they can't stream into Cadence directly — that's a Spotify rule, not ours).
- **Cons:** Audio is end-to-end encrypted in the browser. We never see decoded samples, which means **no real EQ, no spectrum analyzer, no waveform**. That's a Chromium guarantee, not a Cadence one — `AudioContext.createMediaElementSource()` returns silent audio when given EME-protected media, and there is no workaround that doesn't violate the spec.

### librespot

This is the [librespot project](https://github.com/librespot-org/librespot) — a reverse-engineered Rust client that speaks Spotify's native AP protocol. With this enabled, Cadence spawns `librespot` as a subprocess, it appears as a Spotify Connect receiver named "Cadence (librespot)" or "Cadence (librespot+EQ)", and Cadence transfers playback to it via the Web API.

- **Pros:** Audio is decoded locally as raw PCM, which makes real EQ, the spectrum visualizer, and (eventually) crossfade possible. Lower control latency. Works on Linux/headless setups where Web SDK doesn't.
- **Cons:** Reverse-engineering Spotify's protocol violates their TOS. Account-ban risk is currently low but non-zero — historical incidents exist. The auth flow has drifted twice in 2024 alone; expect occasional breakage when Spotify ships protocol changes. **Do not use this with an account you can't afford to lose.**
- **Requirement:** the `librespot` binary must be on your `PATH`. Install with `cargo install librespot` once.

If librespot is selected but the binary isn't found, Cadence prints an error in the dev console and falls back to the Web SDK so you don't lose playback entirely.

### Switching

Settings → Audio backend → choose. Cadence saves the choice and reloads itself. If you flip to librespot and it's working, you'll see a green "librespot running" pill next to the dropdown.

---

## The 10-band EQ

Visible in **Settings** when audio backend = librespot.

Bands: 32 Hz, 64 Hz, 125 Hz, 250 Hz, 500 Hz, 1 kHz, 2 kHz, 4 kHz, 8 kHz, 16 kHz. Each is a peaking biquad with `Q ≈ 1.4`. Range is ±18 dB.

**How to enable:**

1. Audio backend = librespot.
2. Tick the **10-band EQ** flag.
3. Restart the app — the routing changes from "librespot direct → OS audio" to "librespot stdout pipe → cpal output stream", which only happens at boot.

When the EQ is on, Cadence spawns librespot with `--backend pipe --format S16`, reads stereo S16LE samples from its stdout, applies the biquad bank in Rust, and writes the result to the default cpal output device. A few notes on this:

- Latency is ~30 ms higher than direct librespot because of the buffering layer. Negligible for music; noticeable on fast game-style audio cues.
- Coefficient updates happen lazily inside the audio callback and preserve the filter state, so dragging a slider doesn't click.
- Band gains are persisted to `config.json` (debounced 500 ms after movement) so they survive restarts.

**Presets:** Flat, Bass Boost, Treble Boost, Vocal, Rock, Pop, Jazz, Classical, Electronic, Loudness. They're hard-coded in `src-tauri/src/audio_pipeline.rs::eq_set_preset` if you want to add your own.

**EQ off:** the pipeline still runs (librespot stdout → cpal), but the biquads are skipped, so it's effectively a passthrough.

---

## The CLI

Vim-style command bar. Default off. Toggle on via **Settings → Vim-style CLI**, then press `:` from anywhere.

Inside the bar:

- Type the start of a command and press **Tab** to cycle through matches.
- **Up / Down** moves the highlight in the suggestion list.
- **Enter** runs the line. If something is highlighted, it's applied first.
- **Esc** closes without running.
- **Click** any suggestion row to pick it.

Commands:

| Command | Aliases | What it does |
| --- | --- | --- |
| `pause` | `p` | Toggle play / pause |
| `play <query>` | | Search Spotify, play the first match. With autocomplete. |
| `next` | `n`, `skip`, `s` | Skip to next track |
| `prev` | `b`, `back` | Previous track |
| `queue <query>` | `q` | Add the first match to the queue |
| `playlist <name>` | `pl` | Open / play a playlist by name. Autocompletes from your library. |
| `vol <0-100>` | `volume` | Set volume |
| `seek <s>` or `seek <m:ss>` | | Seek to position |
| `shuffle [on\|off]` | `shuf` | Toggle or set shuffle |
| `repeat [off\|context\|track]` | `rep` | Set repeat mode |
| `like` | `save` | Save the current track to your library |
| `home` / `focus` / `settings` / `search` | | Navigate to a view |

Pressing `:` while focused inside any text field will blur the field and open the CLI. So you don't have to click off the search box first.

---

## Discord rich presence

Pushes the currently-playing track to your Discord profile (the "Listening to X by Y" status with album art and a progress bar).

**Setup, one-time:**

1. Go to <https://discord.com/developers/applications>, **New Application**, name it whatever (the name is what shows up in Discord — "Cadence" is fine).
2. Copy the **Application ID** from the General Information tab.
3. (Optional) Upload a square image as **Rich Presence → Art Assets → large_image** if you want a logo on the status.

In Cadence:

1. **Settings → Discord Rich Presence** → paste the Application ID → Save.
2. **Settings → Features → Discord Rich Presence** → on.
3. Reload the app. Make sure your local Discord client is running.

The status updates either when the track changes, the play/pause state changes, or every 5 seconds — whichever comes first. Status clears when there's no track.

If it doesn't appear in your profile, common causes are: Discord wasn't running when you booted Cadence, the Application ID is wrong, or your Discord privacy setting "Display current activity as a status message" is off.

---

## stats.fm tile

[stats.fm](https://stats.fm/) is a third-party listening-history service that you import your Spotify history into. Cadence reads stats from it (top tracks, top artists, top albums, recent streams) — **read-only**, no scrobbling, no auth.

Setup:

1. Sign up at stats.fm and import your history.
2. Note your username (the URL part: `stats.fm/<username>`).
3. **Settings → stats.fm** → enter username → Save.
4. Click the bar-chart icon at the bottom-left of the sidebar to open the Stats view.

The stream counts you see (`X pl`) only populate for **stats.fm Plus** accounts. The free tier returns `null` for the `streams` field — Cadence hides the badge when that happens, so you'll see ranked lists without numbers.

Time ranges: today, 6 months, 1 year, lifetime.

---

## Home extras

Toggleable home-page tiles. **Settings → Home extras**.

- **Random cat** — A photo from [cataas.com](https://cataas.com). Click the tile to fetch a different cat.
- **Dad joke** — One joke from [icanhazdadjoke.com](https://icanhazdadjoke.com). Click for a new one.
- **The Hacker News** — Top 5 cybersecurity headlines from <https://thehackernews.com> via their RSS feed (proxied through `api.rss2json.com`, which is free, no key).
- **Audio visualizer** — 8-band live spectrum from the audio pipeline. **Only works when audio backend = librespot AND EQ is enabled** — that's the only path with PCM access. In Web SDK mode the bars stay at zero (DRM, see above).

All four are off by default. They tile auto-fit on the home page; on a wide window they sit side-by-side, on narrow they stack.

---

## Memory graph

A tiny line chart in the top-right of the topbar showing the renderer's JS heap usage in real time. Sample rate is 5 Hz; the line scrolls smoothly via `requestAnimationFrame` interpolation between samples. Mostly useful for catching memory leaks while developing — turn it on temporarily, watch for monotonic growth.

Toggle: **Settings → Memory graph**.

---

## Keybinds

There are two layers, with completely separate config:

### In-app keybinds (work only when the window is focused)

Configurable in **Settings → In-app keybinds**. Stored in `config.json` under `keybinds.{action}`. Defaults:

| Action | Default | Notes |
| --- | --- | --- |
| `playPause` | Space | |
| `next` | J or MediaTrackNext | |
| `previous` | K or MediaTrackPrevious | |
| `search` | Mod+K | Mod = Cmd on macOS, Ctrl elsewhere |
| `volumeUp` | `=` | |
| `volumeDown` | `-` | |
| `toggleLayout` | Mod+Shift+L | Reserved, no-op currently |
| `cycleTheme` | Mod+Shift+T | Reserved, no-op currently |
| `settings` | Mod+`,` | |
| `focus` | Mod+F | Open focus mode |

Rebinding: click the row in Settings, press your new combo, **Enter** to commit, **Esc** to cancel. The combo string uses `code` values (physical keys), so layout changes don't break your binds.

### Global keybinds (work even when the app is unfocused)

Hardcoded in `src/global-keys.ts`. Default:

- `Ctrl+Alt+A` — previous
- `Ctrl+Alt+S` — play / pause
- `Ctrl+Alt+D` — next

These are OS-level shortcuts registered via Tauri's `global-shortcut` plugin. If another app (Discord push-to-talk, OBS, etc.) already holds one of these combos, you'll see `[global-keys] ... already held by another process — skipping` in the dev console, and that key won't fire for Cadence. Either close the other app or edit `src/global-keys.ts` to use a different combo.

---

## Settings reference

A run-down of every section in the Settings view.

- **Spotify Client ID** — see [Client ID section](#the-spotify-client-id).
- **Audio backend** — Web Playback SDK or librespot. See [Audio backends](#audio-backends--web-sdk-vs-librespot).
- **Equalizer** — only visible when backend = librespot. See [10-band EQ](#the-10-band-eq).
- **stats.fm** — username for the stats integration.
- **Discord Rich Presence** — Application ID input. The toggle is in Features.
- **Global media keys** — read-only display of the hardcoded global shortcuts.
- **In-app keybinds** — table of actions. Click a row to rebind.
- **Features** — every toggle, grouped by what it affects:
  - **Playback:** `webPlayback` (loads the Web SDK at boot), `autoQueueRelated` (the auto-DJ — pre-queues a related track when you play a single URI without a context).
  - **Audio:** `eqEnabled` (10-band EQ — librespot only).
  - **Interface:** `showCovers`, `showRecents`, `showClock`, `disableAnimations`, `richArtwork`.
  - **Home extras:** `homeCatPhoto`, `homeDadJoke`, `homeNews`, `homeVisualizer`.
  - **Power user:** `cliMode`, `showMemoryGraph`.
  - **Integrations:** `discordRpc`, `pauseOnLock` (reserved, not implemented).

Anything not in this list that appears in your `config.json` is a legacy flag from an earlier build; Cadence hides legacy flags from the UI but keeps their values intact in the file.

---

## Architecture

```
 ┌───────────────────────┐         IPC (invoke)            ┌─────────────────────────┐
 │  Vanilla TS + Vite    │  ──────────────────────────▶    │   Rust core (Tauri 2)   │
 │  src/ui/app.ts (DOM)  │  ◀─────  serde_json  ────────   │   - reqwest pool        │
 │  src/store.ts         │                                 │   - keyring (OAuth)     │
 │  src/cli.ts           │                                 │   - PKCE listener       │
 │  src/auto-dj.ts       │                                 │   - librespot subprocess│
 │  src/discord-presence │                                 │   - cpal audio output   │
 └───────────────────────┘                                 │   - 10-band biquad EQ   │
                                                          │   - Discord IPC        │
                                                          └─────────────────────────┘
```

Notable choices and the reasoning behind them:

- **Tokens never touch the renderer.** Access tokens are fetched on demand by the Web Playback SDK callback (a tight, short-lived path); refresh happens entirely in Rust. The renderer can request a current access token via `auth.access_token` when the SDK asks for one, but it's not stored in JS memory.
- **All Spotify API calls go through Rust.** Renderer calls `invoke("api_request", ...)`, Rust does the actual HTTP via a single `reqwest` connection pool with gzip + rustls. Benefits: connection reuse, one place to handle 401-then-refresh, one place to log, no CORS headaches.
- **Vanilla TS, no framework.** No React, no Solid, no virtual DOM. Each Signal in `src/store.ts` has its own subscriber list, so a queue update doesn't re-render the now-bar. Hot paths (search input, now-playing tick, queue refresh) are 1–2 DOM mutations.
- **Track lists render in batches.** First 100 rows synchronously; remaining rows in 200-row chunks via `requestAnimationFrame`, so a 5000-track playlist doesn't freeze the main thread for 600 ms on first paint.
- **localStorage cache.** Playlists, recents, liked-songs, pin metadata, and the first 200 tracks of each viewed playlist are persisted under `cadence:cache:v2` (TTL 7 days). On boot Cadence paints the cache immediately, then revalidates in the background.
- **Hover prefetch.** Hovering a sidebar playlist fires its detail fetch, so click-to-render is instant if you've hovered first.
- **Polling pauses on hidden window.** `setInterval`s for player state and queue skip ticks while `document.hidden`; `visibilitychange` fires an immediate refetch on focus.
- **Audio thread does the minimum.** The cpal callback applies biquads + writes the visualizer accumulators. EQ coefficients are looked up via `try_lock` so contention never blocks audio.
- **Release profile:** `lto = true`, `opt-level = "s"`, `panic = "abort"`, `strip = true`, `codegen-units = 1`. Smaller binary, faster cold start.

### Folder layout

```
cadence/
├── index.html                       # the renderer entry
├── src/                             # frontend (TypeScript)
│   ├── main.ts                      # boot
│   ├── store.ts                     # Signal pub/sub
│   ├── api.ts                       # invoke wrappers
│   ├── settings.ts                  # config typing + getters/setters
│   ├── player.ts                    # playback abstraction (Web SDK + transport)
│   ├── auto-dj.ts                   # related-track recommender
│   ├── cli.ts                       # vim-style command bar
│   ├── statsfm.ts                   # stats.fm read API wrapper
│   ├── discord-presence.ts          # Discord RPC frontend subscriber
│   ├── global-keys.ts               # OS-level media keys
│   ├── plugins.ts                   # JS plugin loader
│   ├── styles/base.css              # the entire stylesheet
│   └── ui/
│       ├── app.ts                   # main DOM UI (~2000 lines, monolithic)
│       └── login.ts                 # login screen
├── src-tauri/                       # Rust backend
│   ├── Cargo.toml
│   ├── tauri.conf.json              # window config + CSP
│   ├── capabilities/default.json    # Tauri 2 permissions
│   └── src/
│       ├── main.rs                  # entry
│       ├── lib.rs                   # invoke handler registration
│       ├── auth.rs                  # OAuth PKCE + refresh
│       ├── api.rs                   # Spotify Web API proxy
│       ├── config.rs                # JSON config read/write
│       ├── storage.rs               # OS keychain wrapper
│       ├── librespot_backend.rs     # librespot subprocess management
│       ├── audio_pipeline.rs        # PCM pipe → EQ → cpal + spectrum
│       └── discord_rpc.rs           # Discord IPC client
└── package.json
```

---

## Troubleshooting

**"Spotify Client ID not set."** — Either you skipped the login-screen step, or your `config.json` got wiped. Settings → Spotify Client ID → paste → Save.

**Login redirects but Cadence never reloads.** — The PKCE listener didn't bind. Most likely cause: another app holds port 53127. Run `netstat -ano | findstr :53127` (Windows) or `lsof -i :53127` (mac/Linux) to see who, kill it, retry. Less likely: the redirect URI in your Spotify dashboard isn't an exact match — must be `http://127.0.0.1:53127/callback` literally.

**`403 Forbidden` on artist top-tracks / albums / `/me/top/*`.** — Your Spotify dev app is in Development Mode. Go to the dashboard, **Users and Access**, add yourself as a user. Cadence already falls back to search-based queries for top tracks and albums on artist pages, but `/me/top/*` (used by the auto-DJ) needs the user added.

**Shuffle / repeat buttons do nothing.** — Two common causes:
- No active Spotify Connect device. Open Spotify on any device (phone, official desktop, or Cadence's own SDK player), then try again. The shuffle/repeat endpoints need an active device to target.
- You're a free Spotify user. These endpoints require Premium.

The dev console shows the exact API error when the click silently fails.

**Global keys don't fire.** — Look for `[global-keys] ... already held by another process` in the dev console. Discord's voice keys and OBS hotkeys are the usual culprits. Either close the other app or rebind in `src/global-keys.ts`.

**Visualizer bars are flat.** — Audio backend has to be librespot AND `eqEnabled` has to be on. The visualizer reads from the audio pipeline, which only exists in that mode.

**`librespot: program not found`** — install it: `cargo install librespot`. Make sure `librespot --version` works in the same shell you launch Cadence from. On Windows, restart the shell after installing so the new PATH entry is picked up.

**Audio crackling / dropouts in librespot+EQ mode.** — The cpal output device is undersized. Try a different output device (Settings → not implemented yet — for now, change the Windows default audio device, or pass a specific `--device` to librespot in `audio_pipeline.rs`). Slower CPUs may also struggle with the EQ at 44.1 kHz; lower the band count if needed.

**Discord status doesn't show.** — Discord client must be running locally before Cadence starts. The `connect` call is synchronous — if it fails at boot, it doesn't retry. Workaround: with Cadence open, toggle the `discordRpc` flag off and back on.

**Memory graph shows `0 MB` forever.** — `performance.memory` is a Chromium-only API. Tauri's WebView2 (Windows) and macOS WKWebView with the right Chromium-version exposes it; older WKWebView builds don't. There is no clean cross-browser equivalent.

**`config.json` got corrupted, app crashes at boot.** — Quit, edit the file directly (it's regular JSON), or just delete it — Cadence regenerates a default on next launch. Tokens are in the keychain, not in this file, so deleting it doesn't log you out.

---

## Compliance

- OAuth 2.0 Authorization Code Flow with PKCE. No client secret, ever.
- Redirect listener is loopback-only (`127.0.0.1`).
- The default audio backend (Web Playback SDK) uses only documented Spotify endpoints. No ad bypass, no DRM circumvention, no impersonation of `Spotify.app`.
- The optional librespot backend uses a reverse-engineered protocol. That violates Spotify's terms of service. Use it on a personal account at your own risk; do not redistribute Cadence as if it were a Spotify product.
- All third-party APIs Cadence talks to (cataas, icanhazdadjoke, thehackernews via rss2json, stats.fm) are public and free; nothing is sent to our servers because there are no servers.
