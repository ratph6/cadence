// OS keychain wrapper with an in-memory cache so we don't trigger a Keychain
// prompt on every API call (~hundreds per session).
//
//   - First read on a fresh process: hits Keychain (one prompt; user clicks
//     "Always Allow" once and never sees it again on this build).
//   - Saves write through to both memory and Keychain.
//   - Refresh updates memory; we persist immediately so a crash doesn't lose it.

use keyring::Entry;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const SERVICE: &str = "dev.raph.cadence";
const ACCOUNT: &str = "spotify-tokens";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    /// unix seconds when access_token expires
    pub expires_at: i64,
    pub scope: String,
}

#[derive(Default)]
struct Cache {
    loaded: bool,
    tokens: Option<Tokens>,
}

static CACHE: Lazy<Mutex<Cache>> = Lazy::new(|| Mutex::new(Cache::default()));

fn entry() -> keyring::Result<Entry> {
    Entry::new(SERVICE, ACCOUNT)
}

fn read_keychain() -> Result<Option<Tokens>, String> {
    match entry().map_err(|e| e.to_string())?.get_password() {
        Ok(s) => serde_json::from_str(&s).map(Some).map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_keychain(tokens: &Tokens) -> Result<(), String> {
    let blob = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    entry()
        .map_err(|e| e.to_string())?
        .set_password(&blob)
        .map_err(|e| e.to_string())
}

fn delete_keychain() -> Result<(), String> {
    match entry().map_err(|e| e.to_string())?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub async fn load() -> Result<Option<Tokens>, String> {
    let mut c = CACHE.lock().await;
    if !c.loaded {
        c.tokens = read_keychain()?;
        c.loaded = true;
    }
    Ok(c.tokens.clone())
}

pub async fn save(tokens: &Tokens) -> Result<(), String> {
    write_keychain(tokens)?;
    let mut c = CACHE.lock().await;
    c.tokens = Some(tokens.clone());
    c.loaded = true;
    Ok(())
}

pub async fn clear() -> Result<(), String> {
    delete_keychain()?;
    let mut c = CACHE.lock().await;
    c.tokens = None;
    c.loaded = true;
    Ok(())
}
