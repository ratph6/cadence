// Optional librespot backend. Spawns the `librespot` binary as a Spotify
// Connect receiver, logged in via the user's OAuth access token. The
// frontend can then transfer Web API playback to this device, getting
// local audio decode (instead of the DRM-protected Web Playback SDK).
//
// Requirements:
//   - `librespot` must be on PATH. Install:  cargo install librespot
//   - User must be logged in (so we have an access token to pass).
//
// The access token is short-lived (≈1h). When it expires, librespot's
// session usually persists; if it drops, frontend can restart via
// `librespot_stop` + `librespot_start`.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use crate::storage;

static CHILD: Mutex<Option<Child>> = Mutex::new(None);

const DEVICE_NAME: &str = "Cadence (librespot)";

#[tauri::command]
pub async fn librespot_start() -> Result<String, String> {
    {
        let mut guard = CHILD.lock().map_err(|e| e.to_string())?;
        if let Some(c) = guard.as_mut() {
            // A previously-spawned child may have exited (token expiry, crash)
            // without us noticing. Reap it so we re-spawn instead of reporting a
            // dead process as "already running".
            match c.try_wait() {
                Ok(Some(_)) => { *guard = None; }
                _ => return Ok(DEVICE_NAME.into()),
            }
        }
    }
    let tokens = storage::load().await?
        .ok_or("not logged in — sign in to Spotify first")?;

    // NOTE: the access token is passed as a CLI argument because librespot
    // exposes no stdin/env channel for it. On a shared machine other local
    // users may see it via the process list (`ps`, /proc/<pid>/cmdline). The
    // token is short-lived (~1h) and only grants the logged-in user's own
    // Spotify scope, but treat single-user machines as the supported model.
    let child_res = Command::new("librespot")
        .args([
            "--name", DEVICE_NAME,
            "--bitrate", "320",
            "--initial-volume", "60",
            "--access-token", tokens.access_token.as_str(),
            // Pick the first sensible OS audio backend automatically.
            // librespot tries SDL, PortAudio, Rodio etc. depending on build.
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    let child = child_res.map_err(|e| {
        format!(
            "failed to spawn librespot: {e}. \
             Is the `librespot` binary on PATH? Install with `cargo install librespot`.",
        )
    })?;

    let mut guard = CHILD.lock().map_err(|e| e.to_string())?;
    *guard = Some(child);
    Ok(DEVICE_NAME.into())
}

#[tauri::command]
pub fn librespot_stop() -> Result<(), String> {
    let mut guard = CHILD.lock().map_err(|e| e.to_string())?;
    if let Some(mut c) = guard.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn librespot_status() -> bool {
    let mut guard = match CHILD.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if let Some(c) = guard.as_mut() {
        // try_wait → Some if process exited; clear our handle in that case.
        match c.try_wait() {
            Ok(Some(_)) => { *guard = None; false }
            Ok(None) => true,
            Err(_) => true,
        }
    } else {
        false
    }
}

#[tauri::command]
pub fn librespot_device_name() -> String {
    DEVICE_NAME.into()
}
