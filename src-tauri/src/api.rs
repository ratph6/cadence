// Thin proxy over Spotify Web API. We expose generic + a few targeted commands.
// All commands return raw `serde_json::Value` so the frontend can shape its own
// view-models without us having to mirror Spotify's schema in Rust.

use crate::auth::current_access_token;
use crate::HTTP;
use once_cell::sync::Lazy;
use reqwest::Method;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const BASE: &str = "https://api.spotify.com/v1";

// Spotify's docs are silent on exact quota, but 429 returns `Retry-After`
// (seconds). We share a process-wide cooldown so parallel callers don't all
// hammer Spotify the instant the limit lifts — they queue behind the same
// timestamp. Cap at 30s; longer values propagate as errors so the UI can
// show real failure instead of pretending the app is fine for 5 minutes.
static RATE_LIMITED_UNTIL: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));
const MAX_BACKOFF: Duration = Duration::from_secs(30);

fn cooldown_remaining() -> Option<Duration> {
    let g = RATE_LIMITED_UNTIL.lock().ok()?;
    let until = (*g)?;
    let now = Instant::now();
    if until > now { Some(until - now) } else { None }
}

fn set_cooldown(dur: Duration) {
    if let Ok(mut g) = RATE_LIMITED_UNTIL.lock() {
        *g = Some(Instant::now() + dur);
    }
}

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

    // Security: every request here attaches the user's bearer token. An
    // absolute `path` (Spotify pagination `next` URLs, and the `api_request`
    // escape hatch reachable from the frontend) must resolve to a Spotify
    // host, or a compromised/injected caller could exfiltrate the token to an
    // attacker-controlled origin. Allow only *.spotify.com.
    match url.host_str() {
        Some(h) if h == "spotify.com" || h.ends_with(".spotify.com") => {}
        other => {
            return Err(format!(
                "refusing to send bearer token to non-Spotify host: {}",
                other.unwrap_or("(none)")
            ));
        }
    }

    let url_for_err = url.to_string();

    // Honor any active cooldown before sending. Bounded by MAX_BACKOFF; if
    // the cooldown is somehow longer, fail fast rather than hang the call.
    if let Some(wait) = cooldown_remaining() {
        if wait > MAX_BACKOFF {
            return Err(format!(
                "429 rate-limited ({}): cooldown {}s exceeds {}s budget",
                url_for_err,
                wait.as_secs(),
                MAX_BACKOFF.as_secs()
            ));
        }
        if cfg!(debug_assertions) {
            eprintln!("[api] cooldown {}ms before {}", wait.as_millis(), url_for_err);
        }
        tokio::time::sleep(wait).await;
    }

    let build = || -> reqwest::RequestBuilder {
        let mut req = HTTP.request(method.clone(), url.clone()).bearer_auth(&token);
        if let Some(b) = body.clone() {
            req = req.json(&b);
        } else if matches!(method, Method::PUT | Method::POST | Method::DELETE) {
            // Spotify rejects bodyless PUT/POST without Content-Length: 0
            // ("411 Length Required"). Force an empty body explicitly.
            req = req.header(reqwest::header::CONTENT_LENGTH, "0").body("");
        }
        req
    };

    if cfg!(debug_assertions) {
        eprintln!("[api] {} {}", method, url_for_err);
    }
    let mut resp = build().send().await.map_err(|e| e.to_string())?;

    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_s = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(1)
            .max(1);
        let wait = Duration::from_secs(retry_s);
        set_cooldown(wait);
        if wait > MAX_BACKOFF {
            // Drain body for the error message before bailing.
            let bytes = resp.bytes().await.unwrap_or_default();
            return Err(format!(
                "429 Too Many Requests ({}): Retry-After {}s exceeds budget — {}",
                url_for_err,
                retry_s,
                String::from_utf8_lossy(&bytes)
            ));
        }
        if cfg!(debug_assertions) {
            eprintln!("[api] 429 — sleeping {}s then retrying {}", retry_s, url_for_err);
        }
        tokio::time::sleep(wait).await;
        resp = build().send().await.map_err(|e| e.to_string())?;
    }

    let status = resp.status();
    if status == reqwest::StatusCode::NO_CONTENT {
        return Ok(Value::Null);
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            // Retry already happened — extend cooldown so the next caller waits.
            set_cooldown(Duration::from_secs(5));
        }
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
