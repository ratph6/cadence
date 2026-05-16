mod auth;
mod api;
mod config;
mod storage;
mod librespot_backend;
mod audio_pipeline;
mod discord_rpc;
mod themes;
mod sys;

use once_cell::sync::Lazy;
use reqwest::Client;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

pub(crate) static HTTP: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .pool_idle_timeout(Duration::from_secs(60))
        .timeout(Duration::from_secs(20))
        .gzip(true)
        .user_agent(concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client")
});

/// Open the WebView's devtools panel. Wired to the in-app right-click
/// "Inspect" menu (gated by the `enableContextMenu` feature flag). The
/// underlying `open_devtools()` API only exists in debug builds or when the
/// `devtools` Cargo feature is enabled — guard accordingly so release builds
/// still compile.
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    #[cfg(debug_assertions)]
    window.open_devtools();
    #[cfg(not(debug_assertions))]
    let _ = window;
}

/// Build the system-tray icon + menu and wire its events into the webview.
/// Menu items emit `tray:<verb>` events that the frontend (`tray.ts`) listens
/// for; left-click on the icon itself emits `tray:show` so the user can
/// re-summon a minimized/hidden window. Errors are swallowed — a missing
/// tray on an exotic platform shouldn't kill the app.
fn install_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let mi_show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
    let mi_play = MenuItem::with_id(app, "play_pause", "Play / Pause", true, None::<&str>)?;
    let mi_prev = MenuItem::with_id(app, "prev", "Previous", true, None::<&str>)?;
    let mi_next = MenuItem::with_id(app, "next", "Next", true, None::<&str>)?;
    let mi_quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&mi_show, &mi_play, &mi_prev, &mi_next, &mi_quit],
    )?;

    // Cadence ships icons for every platform via tauri.conf.json, so
    // `default_window_icon()` is virtually always Some — but if a future
    // build strips it, skip the tray rather than crashing setup.
    let icon = match app.default_window_icon().cloned() {
        Some(i) => i,
        None => return Ok(()),
    };
    let _tray = TrayIconBuilder::with_id("cadence-tray")
        .tooltip("Cadence")
        .icon(icon)
        // On macOS, render the icon in the menu bar as a template image so
        // it auto-inverts to match the light/dark menu bar. Without this the
        // bundled colored PNG would look out of place next to system icons.
        .icon_as_template(cfg!(target_os = "macos"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let verb = match event.id.as_ref() {
                "play_pause" => "play_pause",
                "prev" => "prev",
                "next" => "next",
                "show" => {
                    toggle_main_window(app);
                    return;
                }
                "quit" => {
                    app.exit(0);
                    return;
                }
                _ => return,
            };
            let _ = app.emit(&format!("tray:{verb}"), ());
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click on the icon (no menu) re-summons the main window.
            // We deliberately use Up so menu-open via right-click on macOS/
            // Linux isn't swallowed.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn toggle_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        if visible {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            if let Err(e) = install_tray(&app.handle()) {
                eprintln!("[tray] install failed: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            // auth
            auth::start_login,
            auth::is_logged_in,
            auth::logout,
            auth::access_token,
            // api
            api::api_search,
            api::api_me,
            api::api_devices,
            api::api_playback_state,
            api::api_play,
            api::api_pause,
            api::api_next,
            api::api_previous,
            api::api_queue_add,
            api::api_queue_get,
            api::api_transfer,
            api::api_request,
            // config
            config::config_load,
            config::config_save,
            // librespot
            librespot_backend::librespot_start,
            librespot_backend::librespot_stop,
            librespot_backend::librespot_status,
            librespot_backend::librespot_device_name,
            // local EQ pipeline
            audio_pipeline::audio_pipeline_start,
            audio_pipeline::audio_pipeline_stop,
            audio_pipeline::audio_pipeline_status,
            audio_pipeline::eq_get,
            audio_pipeline::eq_set_band,
            audio_pipeline::eq_set_enabled,
            audio_pipeline::eq_set_preset,
            audio_pipeline::spectrum_get,
            // discord rpc
            discord_rpc::discord_connect,
            discord_rpc::discord_disconnect,
            discord_rpc::discord_status,
            discord_rpc::discord_set,
            discord_rpc::discord_clear,
            // themes
            themes::theme_list,
            themes::theme_save,
            themes::theme_read,
            themes::theme_delete,
            // process introspection
            sys::process_memory,
            sys::window_round_corners,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
