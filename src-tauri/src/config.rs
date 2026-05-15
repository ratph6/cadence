// JSON-based user config: theme, layout, keybinds, feature flags, plugins.
// Stored at OS config dir / cadence / config.json.

use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn config_dir() -> Result<PathBuf, String> {
    let mut p = dirs::config_dir().ok_or("no config dir")?;
    p.push("cadence");
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("config.json"))
}

const DEFAULT: &str = include_str!("default_config.json");

#[tauri::command]
pub fn config_load() -> Result<Value, String> {
    let path = config_path()?;
    if !path.exists() {
        // first run -> seed defaults
        fs::write(&path, DEFAULT).map_err(|e| e.to_string())?;
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn config_save(value: Value) -> Result<(), String> {
    let path = config_path()?;
    let pretty = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&path, pretty).map_err(|e| e.to_string())
}
