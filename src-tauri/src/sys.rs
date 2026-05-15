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
