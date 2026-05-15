// Spotify OAuth Authorization Code Flow with PKCE.
//
// Flow:
//  1. Frontend calls `start_login`. We pick an ephemeral local port,
//     generate PKCE verifier+challenge, open the browser to the
//     Spotify authorize URL with redirect_uri = http://127.0.0.1:<port>/callback.
//  2. A tiny one-shot HTTP listener accepts the redirect, extracts `code`,
//     exchanges it for tokens at /api/token, and stores them in the OS keychain.
//  3. Refresh is on-demand: any caller fetching the access token via
//     `current_access_token` will trigger a refresh if expiry < now+30s.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::storage::{self, Tokens};
use crate::HTTP;

// --- CONFIGURE THIS --------------------------------------------------------
// Client ID resolution order:
//   1. config.json `clientId` field (set via the GUI)
//   2. SPOTIFY_CLIENT_ID env at runtime
//   3. SPOTIFY_CLIENT_ID env at build time
// Register `http://127.0.0.1:53127/callback` in your Spotify app dashboard.
const COMPILE_CLIENT_ID: Option<&str> = option_env!("SPOTIFY_CLIENT_ID");
const REDIRECT_PORT: u16 = 53127;

fn client_id() -> Result<String, String> {
    if let Ok(cfg) = crate::config::config_load() {
        if let Some(id) = cfg.get("clientId").and_then(|v| v.as_str()) {
            if !id.is_empty() {
                return Ok(id.to_string());
            }
        }
    }
    if let Ok(id) = std::env::var("SPOTIFY_CLIENT_ID") {
        if !id.is_empty() {
            return Ok(id);
        }
    }
    if let Some(id) = COMPILE_CLIENT_ID.filter(|s| !s.is_empty()) {
        return Ok(id.to_string());
    }
    Err("Spotify Client ID not set. Enter it on the login screen.".into())
}
// ---------------------------------------------------------------------------

const SCOPES: &str = concat!(
    "user-read-private user-read-email ",
    "user-read-playback-state user-modify-playback-state user-read-currently-playing ",
    "streaming app-remote-control ",
    "playlist-read-private playlist-read-collaborative ",
    "user-library-read user-top-read user-read-recently-played"
);

static LOGIN_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    token_type: String,
    expires_in: i64,
    refresh_token: Option<String>,
    scope: String,
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

fn gen_pkce() -> (String, String) {
    let mut buf = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut buf);
    let verifier = URL_SAFE_NO_PAD.encode(buf);
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
    (verifier, challenge)
}

fn random_state() -> String {
    let mut buf = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

#[tauri::command]
pub async fn start_login(app: tauri::AppHandle) -> Result<(), String> {
    let _g = LOGIN_LOCK.lock().await;

    let cid = client_id()?;
    let (verifier, challenge) = gen_pkce();
    let state = random_state();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", REDIRECT_PORT);

    // Bind early so the URI is reachable before we open the browser.
    let listener = TcpListener::bind(("127.0.0.1", REDIRECT_PORT))
        .await
        .map_err(|e| format!("port {} busy: {}", REDIRECT_PORT, e))?;

    let url = url::Url::parse_with_params(
        "https://accounts.spotify.com/authorize",
        &[
            ("client_id", cid.as_str()),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri.as_str()),
            ("scope", SCOPES),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge.as_str()),
            ("state", state.as_str()),
        ],
    )
    .map_err(|e| e.to_string())?;

    // Open in default browser via opener plugin.
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())?;

    // Wait for the redirect (single accept).
    let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;

    let mut buf = [0u8; 4096];
    let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);
    let first = req.lines().next().unwrap_or("");
    // GET /callback?code=...&state=...
    let path = first.split_whitespace().nth(1).unwrap_or("/");
    let parsed = url::Url::parse(&format!("http://x{}", path)).map_err(|e| e.to_string())?;
    let mut code = None;
    let mut got_state = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => got_state = Some(v.into_owned()),
            _ => {}
        }
    }

    let body = if got_state.as_deref() == Some(state.as_str()) && code.is_some() {
        b"<!doctype html><meta charset=utf-8><title>OK</title>\
          <body style=\"font-family:system-ui;background:#111;color:#eee;text-align:center;padding-top:20vh\">\
          <h2>Logged in.</h2><p>You can close this tab.</p></body>" as &[u8]
    } else {
        b"<!doctype html><meta charset=utf-8><body>State mismatch. Try again.</body>"
    };
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = sock.write_all(resp.as_bytes()).await;
    let _ = sock.write_all(body).await;
    let _ = sock.shutdown().await;

    let code = code.ok_or("no code in callback")?;
    if got_state.as_deref() != Some(state.as_str()) {
        return Err("oauth state mismatch".into());
    }

    let resp: TokenResp = HTTP
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", cid.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if resp.token_type.to_lowercase() != "bearer" {
        return Err(format!("unexpected token_type {}", resp.token_type));
    }

    let tokens = Tokens {
        access_token: resp.access_token,
        refresh_token: resp
            .refresh_token
            .ok_or("no refresh_token returned")?,
        expires_at: now_secs() + resp.expires_in - 30,
        scope: resp.scope,
    };
    storage::save(&tokens).await?;
    Ok(())
}

async fn refresh(t: &Tokens) -> Result<Tokens, String> {
    let cid = client_id()?;
    let response = HTTP
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", t.refresh_token.as_str()),
            ("client_id", cid.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        // Refresh token is invalid (revoked / expired / mismatched scopes).
        // Wipe stored credentials so the next call forces re-login.
        let body = response.text().await.unwrap_or_default();
        let _ = storage::clear().await;
        return Err(format!(
            "refresh_token rejected ({}): {} — logged out, please sign in again",
            status, body
        ));
    }
    let resp: TokenResp = response.json().await.map_err(|e| e.to_string())?;

    let new = Tokens {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token.unwrap_or_else(|| t.refresh_token.clone()),
        expires_at: now_secs() + resp.expires_in - 30,
        scope: resp.scope,
    };
    storage::save(&new).await?;
    Ok(new)
}

/// Returns a usable access token, refreshing if necessary.
pub async fn current_access_token() -> Result<String, String> {
    let t = storage::load().await?.ok_or("not logged in")?;
    if t.expires_at <= now_secs() {
        let new = refresh(&t).await?;
        Ok(new.access_token)
    } else {
        Ok(t.access_token)
    }
}

#[tauri::command]
pub async fn is_logged_in() -> Result<bool, String> {
    Ok(storage::load().await?.is_some())
}

#[tauri::command]
pub async fn logout() -> Result<(), String> {
    storage::clear().await
}

/// Frontend uses this to feed the Web Playback SDK's OAuth callback.
#[tauri::command]
pub async fn access_token() -> Result<String, String> {
    current_access_token().await
}
