// Discord Rich Presence integration. Connects via Discord's local IPC
// (named pipe on Windows / Unix socket elsewhere) to set the user's
// "playing" status to the currently-playing Spotify track.
//
// Discord requires an Application ID. The user registers one for free at
// https://discord.com/developers/applications, copies the client_id, and
// pastes it into Cadence settings.

use std::sync::Mutex;

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};

// DiscordIpcClient holds an OS handle. Wrap behind a mutex; commands are
// short-lived and not perf-critical.
static CLIENT: Mutex<Option<DiscordIpcClient>> = Mutex::new(None);

#[tauri::command]
pub fn discord_connect(client_id: String) -> Result<(), String> {
    if client_id.trim().is_empty() {
        return Err("missing Discord client ID".into());
    }
    let mut c = DiscordIpcClient::new(&client_id).map_err(|e| e.to_string())?;
    c.connect().map_err(|e| {
        format!("Discord IPC connect failed: {e}. Is Discord running?")
    })?;
    let mut guard = CLIENT.lock().map_err(|e| e.to_string())?;
    *guard = Some(c);
    Ok(())
}

#[tauri::command]
pub fn discord_disconnect() -> Result<(), String> {
    let mut guard = CLIENT.lock().map_err(|e| e.to_string())?;
    if let Some(mut c) = guard.take() {
        let _ = c.close();
    }
    Ok(())
}

#[tauri::command]
pub fn discord_status() -> bool {
    match CLIENT.lock() {
        Ok(g) => g.is_some(),
        Err(_) => false,
    }
}

#[derive(serde::Deserialize)]
pub struct PresencePayload {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: i64,
    pub position_ms: i64,
    pub paused: bool,
    pub track_url: Option<String>,
    pub cover_url: Option<String>,
}

#[tauri::command]
pub fn discord_set(payload: PresencePayload) -> Result<(), String> {
    let mut guard = CLIENT.lock().map_err(|e| e.to_string())?;
    let client = guard.as_mut().ok_or("Discord RPC not connected")?;

    // We have to keep `assets` and `timestamps` and `buttons` alive long
    // enough that activity can borrow them — bind to locals.
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut act = activity::Activity::new();

    let details = payload.title.clone();
    let state = if payload.artist.is_empty() {
        payload.album.clone()
    } else {
        format!("by {}", payload.artist)
    };
    act = act.details(&details);
    if !state.is_empty() { act = act.state(&state); }
    act = act.activity_type(activity::ActivityType::Listening);

    let timestamps = if !payload.paused && payload.duration_ms > 0 && payload.position_ms >= 0 {
        let start = now_secs - (payload.position_ms / 1000);
        let end = start + (payload.duration_ms / 1000);
        Some(activity::Timestamps::new().start(start).end(end))
    } else {
        None
    };
    if let Some(ts) = &timestamps { act = act.timestamps(ts.clone()); }

    let assets = if payload.cover_url.is_some() || payload.paused {
        let mut a = activity::Assets::new();
        if let Some(url) = payload.cover_url.as_deref() {
            if !url.is_empty() { a = a.large_image(url); }
        }
        a = a.large_text(if payload.album.is_empty() { "Cadence" } else { &payload.album });
        if payload.paused { a = a.small_text("Paused"); }
        Some(a)
    } else { None };
    if let Some(a) = &assets { act = act.assets(a.clone()); }

    let mut buttons: Vec<activity::Button> = Vec::new();
    if let Some(url) = payload.track_url.as_deref() {
        if url.starts_with("https://") {
            buttons.push(activity::Button::new("Listen on Spotify", url));
        }
    }
    if !buttons.is_empty() { act = act.buttons(buttons); }

    client.set_activity(act).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn discord_clear() -> Result<(), String> {
    let mut guard = CLIENT.lock().map_err(|e| e.to_string())?;
    if let Some(c) = guard.as_mut() {
        let _ = c.clear_activity();
    }
    Ok(())
}
