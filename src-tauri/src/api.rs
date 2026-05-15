// Thin proxy over Spotify Web API. We expose generic + a few targeted commands.
// All commands return raw `serde_json::Value` so the frontend can shape its own
// view-models without us having to mirror Spotify's schema in Rust.

use crate::auth::current_access_token;
use crate::HTTP;
use reqwest::Method;
use serde_json::{json, Value};

const BASE: &str = "https://api.spotify.com/v1";

async fn request(
    method: Method,
    path: &str,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
) -> Result<Value, String> {
    let token = current_access_token().await?;
    let base = if path.starts_with("http") {
        path.to_string()
    } else {
        format!("{}{}", BASE, path)
    };
    // Build URL ourselves — `reqwest::query(&Vec<_>)` round-trips through
    // serde_urlencoded which rejects top-level sequences, silently producing
    // junk query strings. `Url::parse_with_params` handles this correctly.
    let url = if let Some(ref q) = query {
        url::Url::parse_with_params(&base, q.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .map_err(|e| e.to_string())?
    } else {
        url::Url::parse(&base).map_err(|e| e.to_string())?
    };
    let url_for_err = url.to_string();
    eprintln!("[api] {} {}", method, url_for_err);
    let m = method.clone();
    let mut req = HTTP.request(method, url).bearer_auth(&token);
    if let Some(b) = body {
        req = req.json(&b);
    } else if matches!(m, reqwest::Method::PUT | reqwest::Method::POST | reqwest::Method::DELETE) {
        // Spotify rejects bodyless PUT/POST without Content-Length: 0
        // ("411 Length Required"). Force an empty body explicitly.
        req = req.header(reqwest::header::CONTENT_LENGTH, "0").body("");
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "{} {} ({}): {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            url_for_err,
            String::from_utf8_lossy(&bytes)
        ));
    }
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    // Spotify sometimes returns a 200 with a non-JSON body (e.g. snapshot id
    // from /me/player/pause). Treat unparseable success bodies as Null rather
    // than failing — our callers don't read the body for these endpoints.
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) => Ok(v),
        Err(_) => Ok(Value::Null),
    }
}

// ---- Targeted commands (cheap, common paths) -----------------------------

#[tauri::command]
pub async fn api_search(q: String, types: Option<String>, limit: Option<u32>) -> Result<Value, String> {
    // Spotify caps `limit` at 10 for Development-Mode apps (quota change late 2024).
    let lim = limit.unwrap_or(10).clamp(1, 10);
    request(
        Method::GET,
        "/search",
        Some(vec![
            ("q".into(), q),
            ("type".into(), types.unwrap_or_else(|| "track,album,artist".into())),
            ("limit".into(), lim.to_string()),
        ]),
        None,
    )
    .await
}

#[tauri::command]
pub async fn api_me() -> Result<Value, String> {
    request(Method::GET, "/me", None, None).await
}

#[tauri::command]
pub async fn api_devices() -> Result<Value, String> {
    request(Method::GET, "/me/player/devices", None, None).await
}

#[tauri::command]
pub async fn api_playback_state() -> Result<Value, String> {
    request(Method::GET, "/me/player", None, None).await
}

#[tauri::command]
pub async fn api_play(
    device_id: Option<String>,
    uris: Option<Vec<String>>,
    context_uri: Option<String>,
    position_ms: Option<u64>,
) -> Result<Value, String> {
    let q = device_id.map(|d| vec![("device_id".into(), d)]);
    let mut body = serde_json::Map::new();
    if let Some(u) = uris {
        body.insert("uris".into(), json!(u));
    }
    if let Some(c) = context_uri {
        body.insert("context_uri".into(), json!(c));
    }
    if let Some(p) = position_ms {
        body.insert("position_ms".into(), json!(p));
    }
    let body = if body.is_empty() { None } else { Some(Value::Object(body)) };
    request(Method::PUT, "/me/player/play", q, body).await
}

#[tauri::command]
pub async fn api_pause(device_id: Option<String>) -> Result<Value, String> {
    let q = device_id.map(|d| vec![("device_id".into(), d)]);
    request(Method::PUT, "/me/player/pause", q, None).await
}

#[tauri::command]
pub async fn api_next(device_id: Option<String>) -> Result<Value, String> {
    let q = device_id.map(|d| vec![("device_id".into(), d)]);
    request(Method::POST, "/me/player/next", q, None).await
}

#[tauri::command]
pub async fn api_previous(device_id: Option<String>) -> Result<Value, String> {
    let q = device_id.map(|d| vec![("device_id".into(), d)]);
    request(Method::POST, "/me/player/previous", q, None).await
}

#[tauri::command]
pub async fn api_queue_add(uri: String, device_id: Option<String>) -> Result<Value, String> {
    let mut q = vec![("uri".into(), uri)];
    if let Some(d) = device_id {
        q.push(("device_id".into(), d));
    }
    request(Method::POST, "/me/player/queue", Some(q), None).await
}

#[tauri::command]
pub async fn api_queue_get() -> Result<Value, String> {
    request(Method::GET, "/me/player/queue", None, None).await
}

#[tauri::command]
pub async fn api_transfer(device_id: String, play: Option<bool>) -> Result<Value, String> {
    let body = json!({ "device_ids": [device_id], "play": play.unwrap_or(false) });
    request(Method::PUT, "/me/player", None, Some(body)).await
}

// ---- Generic escape hatch -----------------------------------------------

#[tauri::command]
pub async fn api_request(
    method: String,
    path: String,
    query: Option<Vec<(String, String)>>,
    body: Option<Value>,
) -> Result<Value, String> {
    let m = Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    request(m, &path, query, body).await
}
