import { api } from "../../api";
import { suppressPollFor } from "../../player";
import { fmt } from "../util";
import { ui, pushDisposer } from "../state";


// ----------------------------------------------------------------- devices

interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
  supports_volume: boolean;
}

function deviceIcon(type: string): string {
  const t = (type ?? "").toLowerCase();
  if (t === "computer") {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><line x1="8" y1="20" x2="16" y2="20"/><line x1="12" y1="16" x2="12" y2="20"/></svg>`;
  }
  if (t === "smartphone" || t === "phone" || t === "tablet") {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2"/><line x1="11" y1="18.5" x2="13" y2="18.5"/></svg>`;
  }
  if (t === "speaker" || t === "avr" || t === "stb" || t === "audiodongle") {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2.5" width="14" height="19" rx="2"/><circle cx="12" cy="15" r="3.2"/><circle cx="12" cy="7" r="1"/></svg>`;
  }
  if (t === "tv" || t === "castvideo" || t === "gameconsole") {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="1.5"/><line x1="8" y1="20.5" x2="16" y2="20.5"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>`;
}

export function renderDevices() {
  ui.viewEl.innerHTML = `
    <div class="page devices-page">
      <div class="devices-head">
        <h1>Devices</h1>
        <button class="ico-btn" id="dev-refresh" title="Refresh">↻</button>
      </div>
      <p class="dim small">Pick a Spotify Connect device. Click a device to transfer playback.</p>
      <ul id="dev-list" class="dev-list"><li class="dim small">Loading…</li></ul>
    </div>`;

  const listEl = ui.viewEl.querySelector<HTMLUListElement>("#dev-list")!;
  let busy = false;

  async function load() {
    try {
      const res = await api.devices();
      const devs: SpotifyDevice[] = (res?.devices ?? []) as SpotifyDevice[];
      if (ui.curView !== "devices") return;
      if (!devs.length) {
        listEl.innerHTML = `<li class="dim small">No devices found. Open Spotify on another device or start the built-in player from Settings.</li>`;
        return;
      }
      listEl.innerHTML = devs.map((d) => {
        const vol = d.volume_percent ?? -1;
        const volStr = vol >= 0 ? `${vol}%` : "—";
        const disabled = !d.id || d.is_restricted;
        return `
          <li class="dev-row ${d.is_active ? "active" : ""} ${disabled ? "disabled" : ""}"
              data-id="${fmt.esc(d.id ?? "")}"
              title="${fmt.esc(d.type)}${d.is_restricted ? " — restricted" : ""}">
            <span class="dev-icon">${deviceIcon(d.type)}</span>
            <span class="dev-meta">
              <span class="dev-name">${fmt.esc(d.name)}</span>
              <span class="dev-sub dim">${fmt.esc(d.type)}${d.is_active ? " · playing here" : ""}</span>
            </span>
            <span class="dev-vol dim">${fmt.esc(volStr)}</span>
          </li>`;
      }).join("");

      listEl.querySelectorAll<HTMLLIElement>(".dev-row").forEach((row) => {
        row.addEventListener("click", async () => {
          if (busy) return;
          const id = row.dataset.id;
          if (!id || row.classList.contains("active") || row.classList.contains("disabled")) return;
          busy = true;
          row.classList.add("pending");
          try {
            await api.transfer(id, true);
            suppressPollFor(1500);
            await load();
          } catch (e) {
            console.error("transfer failed", e);
            row.classList.remove("pending");
          } finally {
            busy = false;
          }
        });
      });
    } catch (e) {
      if (ui.curView !== "devices") return;
      listEl.innerHTML = `<li class="dim small">Failed to load devices: ${fmt.esc(String(e))}</li>`;
    }
  }

  ui.viewEl.querySelector<HTMLButtonElement>("#dev-refresh")!
    .addEventListener("click", load);

  load();
  const timer = setInterval(load, 5000);
  pushDisposer(() => clearInterval(timer));
}
