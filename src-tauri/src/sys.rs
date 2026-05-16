// Cross-platform process memory introspection.
//
// The frontend used to read `performance.memory.usedJSHeapSize`, which is a
// Chromium-only non-standard API. On macOS Tauri uses WKWebView (WebKit), so
// the API doesn't exist and the graph showed 0 forever. This command returns
// real RSS for the Cadence process via memory-stats, which handles all three
// platforms (mach on macOS, GetProcessMemoryInfo on Windows, /proc on Linux).

#[derive(serde::Serialize)]
pub struct ProcessMemory {
    pub rss: u64,
    pub virt: u64,
}

#[tauri::command]
pub fn process_memory() -> Result<ProcessMemory, String> {
    let stats = memory_stats::memory_stats().ok_or("memory_stats unavailable")?;
    Ok(ProcessMemory {
        rss: stats.physical_mem as u64,
        virt: stats.virtual_mem as u64,
    })
}

/// Force DWM to clip a window's corners with the Win11 rounded radius. Used
/// for the standalone CLI window — without this its OS-level Acrylic blur
/// renders as a sharp rectangle even when the CSS card is rounded. Silent
/// no-op on non-Windows targets so the frontend can call it unconditionally.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn window_round_corners(window: tauri::Window) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    // tauri::Window::hwnd() returns the `windows` crate's HWND newtype which
    // wraps a raw void pointer. windows-sys uses a bare `*mut c_void` HWND,
    // so we extract the pointer and pass it through. The two crates are ABI-
    // compatible (both literally hold the underlying HWND value), but the
    // typed wrappers don't auto-convert.
    let hwnd_typed = window.hwnd().map_err(|e| e.to_string())?;
    let hwnd_raw: *mut std::ffi::c_void = hwnd_typed.0 as *mut _;
    let pref: i32 = DWMWCP_ROUND as i32;
    let hr = unsafe {
        DwmSetWindowAttribute(
            hwnd_raw,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &pref as *const _ as *const _,
            std::mem::size_of_val(&pref) as u32,
        )
    };
    if hr < 0 {
        return Err(format!("DwmSetWindowAttribute failed: 0x{:08x}", hr));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn window_round_corners(_window: tauri::Window) -> Result<(), String> {
    Ok(())
}
