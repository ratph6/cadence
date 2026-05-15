// Disk-backed store for user-imported CSS themes (Vencord / BetterDiscord
// format). Each theme lives as a single .css file under <config>/themes/.
//
// We deliberately don't parse Discord-format metadata blocks here — the
// frontend handles all of that, including stripping `@import` chains and
// remapping Discord CSS variables to Cadence's variable names. This module
// is just a typed file-system layer.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

fn themes_dir() -> Result<PathBuf, String> {
    let mut p = dirs::config_dir().ok_or("no config dir")?;
    p.push("cadence");
    p.push("themes");
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(p)
}

fn safe_filename(name: &str) -> String {
    // Strip path separators and other risky chars so a theme named
    // "../../etc/passwd" can't escape the themes/ dir. Spaces stay.
    name.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | ' ' | '-' | '_' | '.' | '(' | ')' => c,
            _ => '_',
        })
        .collect()
}

fn theme_path(name: &str) -> Result<PathBuf, String> {
    let safe = safe_filename(name);
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("invalid theme name".into());
    }
    let mut p = themes_dir()?;
    p.push(format!("{}.css", safe));
    Ok(p)
}

#[derive(Serialize, Deserialize)]
pub struct ThemeMeta {
    pub name: String,
    pub size: u64,
}

#[tauri::command]
pub fn theme_list() -> Result<Vec<ThemeMeta>, String> {
    let dir = themes_dir()?;
    let mut out = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("css") {
            continue;
        }
        let name = match path.file_stem().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(ThemeMeta { name, size });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub fn theme_save(name: String, content: String) -> Result<String, String> {
    let path = theme_path(&name)?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(safe_filename(&name))
}

#[tauri::command]
pub fn theme_read(name: String) -> Result<String, String> {
    let path = theme_path(&name)?;
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn theme_delete(name: String) -> Result<(), String> {
    let path = theme_path(&name)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
