import { auth } from "../api";
import { getConfig, patchConfig } from "../settings";
import { openUrl } from "@tauri-apps/plugin-opener";

const REDIRECT_URI = "http://127.0.0.1:53127/callback";

export function renderLogin(root: HTMLElement): void {
  const cid = getConfig().clientId ?? "";

  root.innerHTML = `
    <div class="login">
      <h1>Cadence</h1>

      <div class="login-card">
        <label for="cid">Spotify Client ID</label>
        <input id="cid" type="text" spellcheck="false" autocomplete="off"
               placeholder="paste your Client ID" value="${escapeAttr(cid)}" />
        <p class="muted small">
          Get one at <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>.
          Add this exact redirect URI to your app:
        </p>
        <code class="copyable">${REDIRECT_URI}</code>

        <div class="row">
          <button id="save-cid">Save</button>
          <button id="login-btn" class="primary" ${cid ? "" : "disabled"}>
            Log in with Spotify
          </button>
        </div>

        <div id="login-error" class="error" hidden></div>
      </div>

      <p class="muted small">
        Premium required for in-app playback. Free accounts can still control
        external Spotify Connect devices.
      </p>
    </div>`;

  root.querySelectorAll<HTMLAnchorElement>(".login a[href^='http']").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openUrl(a.href);
    });
  });

  const input = root.querySelector<HTMLInputElement>("#cid")!;
  const loginBtn = root.querySelector<HTMLButtonElement>("#login-btn")!;
  const saveBtn = root.querySelector<HTMLButtonElement>("#save-cid")!;
  const err = root.querySelector<HTMLElement>("#login-error")!;

  const showErr = (msg: string) => {
    err.textContent = msg;
    err.hidden = false;
  };
  const hideErr = () => (err.hidden = true);

  input.addEventListener("input", () => {
    loginBtn.disabled = !input.value.trim();
    hideErr();
  });

  saveBtn.addEventListener("click", async () => {
    const val = input.value.trim();
    try {
      await patchConfig({ clientId: val });
      saveBtn.textContent = "Saved ✓";
      setTimeout(() => (saveBtn.textContent = "Save"), 1200);
    } catch (e) {
      showErr(String(e));
    }
  });

  loginBtn.addEventListener("click", async () => {
    hideErr();
    const val = input.value.trim();
    if (!val) {
      showErr("Enter your Client ID first.");
      return;
    }
    if (val !== getConfig().clientId) {
      try {
        await patchConfig({ clientId: val });
      } catch (e) {
        showErr(String(e));
        return;
      }
    }
    loginBtn.disabled = true;
    loginBtn.textContent = "Waiting for browser…";
    try {
      await auth.startLogin();
      location.reload();
    } catch (e) {
      loginBtn.disabled = false;
      loginBtn.textContent = "Log in with Spotify";
      showErr(String(e));
    }
  });
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
