// Local audio pipeline: librespot --backend pipe → 10-band EQ → cpal device.
//
// Used only when settings.audioBackend == "librespot" AND settings.eqEnabled
// is true.  Otherwise we spawn librespot directly (`librespot_backend.rs`)
// and let it talk to the OS audio backend itself, which has lower latency
// and zero EQ.
//
// Pipeline layout:
//   librespot stdout (S16LE 44.1kHz stereo, interleaved)
//     → reader thread (parses i16 → f32 normalized)
//     → SPSC ring buffer
//     → cpal output callback (per-channel biquad bank → device samples)
//
// Concurrency:
//   - Each pipeline instance owns one audio thread that holds the cpal
//     Stream (cpal::Stream is !Send on most backends).
//   - Reader thread is separate; both write/read the SPSC ring without locks.
//   - EQ band gains live behind a Mutex; the callback reads them once per
//     buffer and applies new biquad coefficients lazily (no audio glitches).

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use once_cell::sync::Lazy;
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::HeapRb;

use crate::storage;

// ---- Constants ----------------------------------------------------------

const SR: f32 = 44_100.0;
const CHANNELS: u16 = 2;

/// ISO third-octave-ish band centers, 10 bands.
const BAND_HZ: [f32; 10] = [
    32.0, 64.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];
const BAND_Q: f32 = 1.4;

// ---- Biquad (peaking EQ) ------------------------------------------------

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32, b1: f32, b2: f32,
    a1: f32, a2: f32,
    x1: f32, x2: f32,
    y1: f32, y2: f32,
}

impl Biquad {
    fn peaking(fs: f32, fc: f32, q: f32, gain_db: f32) -> Self {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * fc / fs;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q);

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos_w0;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1n = -2.0 * cos_w0;
        let a2n = 1.0 - alpha / a;

        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1n / a0,
            a2: a2n / a0,
            x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0,
        }
    }

    #[inline(always)]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x
            + self.b1 * self.x1
            + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1; self.x1 = x;
        self.y2 = self.y1; self.y1 = y;
        y
    }

    /// Replace coefficients while preserving the delay-line state. This
    /// keeps the filter continuous when the user drags a slider mid-stream.
    fn update_peaking(&mut self, fs: f32, fc: f32, q: f32, gain_db: f32) {
        let saved = (self.x1, self.x2, self.y1, self.y2);
        *self = Self::peaking(fs, fc, q, gain_db);
        self.x1 = saved.0; self.x2 = saved.1; self.y1 = saved.2; self.y2 = saved.3;
    }

    /// Constant-skirt-gain bandpass — used as an analyzer for the visualizer.
    /// Output amplitude = how much energy the input has near `fc`.
    fn bandpass(fs: f32, fc: f32, q: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * fc / fs;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q);
        let b0 = alpha;
        let b1 = 0.0;
        let b2 = -alpha;
        let a0 = 1.0 + alpha;
        let a1n = -2.0 * cos_w0;
        let a2n = 1.0 - alpha;
        Self {
            b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
            a1: a1n / a0, a2: a2n / a0,
            x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0,
        }
    }
}

// ---- EQ state -----------------------------------------------------------

#[derive(Clone, Copy)]
pub struct EqState {
    pub gains_db: [f32; 10],
    pub enabled: bool,
}

impl Default for EqState {
    fn default() -> Self {
        Self { gains_db: [0.0; 10], enabled: true }
    }
}

struct ChannelDsp {
    biquads: [Biquad; 10],
    last_gains: [f32; 10],
}

impl ChannelDsp {
    fn new(eq: &EqState) -> Self {
        let mut bq = [Biquad::default(); 10];
        for i in 0..10 {
            bq[i] = Biquad::peaking(SR, BAND_HZ[i], BAND_Q, eq.gains_db[i]);
        }
        Self { biquads: bq, last_gains: eq.gains_db }
    }
    fn maybe_update(&mut self, eq: &EqState) {
        for i in 0..10 {
            if (self.last_gains[i] - eq.gains_db[i]).abs() > f32::EPSILON {
                self.biquads[i].update_peaking(SR, BAND_HZ[i], BAND_Q, eq.gains_db[i]);
                self.last_gains[i] = eq.gains_db[i];
            }
        }
    }
    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let mut y = x;
        for i in 0..10 { y = self.biquads[i].process(y); }
        y
    }
}

// ---- Pipeline handle ----------------------------------------------------

struct PipelineHandle {
    shutdown_tx: mpsc::Sender<()>,
    child: Arc<Mutex<Option<Child>>>,
}

static EQ_STATE: Lazy<Arc<Mutex<EqState>>> =
    Lazy::new(|| Arc::new(Mutex::new(EqState::default())));
static PIPELINE: Lazy<Mutex<Option<PipelineHandle>>> = Lazy::new(|| Mutex::new(None));
// Serializes `start_pipeline` so the check-then-insert below is atomic across
// concurrent callers. Without it two `audio_pipeline_start` calls could both
// pass the `is_some()` check and spawn two librespot processes + audio threads,
// leaking the first handle. A tokio Mutex (not std) so we can hold it across
// the `.await` points in start_pipeline.
static START_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

// 8-band visualizer state. Each band is a bandpass biquad + running squared-
// sum across samples, converted to RMS at the end of every cpal callback,
// smoothed with the previous frame, and parked in this Mutex for the
// frontend to poll at 60 Hz.
const VIZ_BANDS: [f32; 8] = [60.0, 200.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 12000.0];
const VIZ_Q: f32 = 1.6;
const VIZ_SMOOTH: f32 = 0.55;
static VIZ_LEVELS: Lazy<Arc<Mutex<[f32; 8]>>> =
    Lazy::new(|| Arc::new(Mutex::new([0.0; 8])));

struct Visualizer {
    bp_l: [Biquad; 8],
    bp_r: [Biquad; 8],
    sum_sq: [f32; 8],
    samples: u32,
    smoothed: [f32; 8],
}
impl Visualizer {
    fn new() -> Self {
        let mut bp_l = [Biquad::default(); 8];
        let mut bp_r = [Biquad::default(); 8];
        for i in 0..8 {
            bp_l[i] = Biquad::bandpass(SR, VIZ_BANDS[i], VIZ_Q);
            bp_r[i] = Biquad::bandpass(SR, VIZ_BANDS[i], VIZ_Q);
        }
        Self { bp_l, bp_r, sum_sq: [0.0; 8], samples: 0, smoothed: [0.0; 8] }
    }
    #[inline]
    fn feed(&mut self, l: f32, r: f32) {
        for i in 0..8 {
            let a = self.bp_l[i].process(l);
            let b = self.bp_r[i].process(r);
            let mix = (a + b) * 0.5;
            self.sum_sq[i] += mix * mix;
        }
        self.samples += 1;
    }
    fn flush(&mut self) {
        if self.samples == 0 { return; }
        let n = self.samples as f32;
        for i in 0..8 {
            let rms = (self.sum_sq[i] / n).sqrt();
            self.smoothed[i] = self.smoothed[i] * VIZ_SMOOTH + rms * (1.0 - VIZ_SMOOTH);
            self.sum_sq[i] = 0.0;
        }
        self.samples = 0;
        if let Ok(mut g) = VIZ_LEVELS.lock() {
            *g = self.smoothed;
        }
    }
}

// ---- Lifecycle ----------------------------------------------------------

pub async fn start_pipeline() -> Result<(), String> {
    // Held for the whole function so the is_some() check and the final insert
    // can't interleave with another start. See START_LOCK definition.
    let _start = START_LOCK.lock().await;
    {
        let g = PIPELINE.lock().map_err(|e| e.to_string())?;
        if g.is_some() {
            return Ok(());
        }
    }

    let tokens = storage::load().await?
        .ok_or("not logged in — sign in to Spotify first")?;

    // Spawn librespot, reading 16-bit signed-LE PCM from its stdout.
    // NOTE: see librespot_backend.rs — the access token is passed via argv
    // because librespot offers no stdin/env channel; visible to other local
    // users on a shared machine. Short-lived, user's own scope only.
    let mut child = Command::new("librespot")
        .args([
            "--name", "Cadence (librespot+EQ)",
            "--bitrate", "320",
            "--initial-volume", "60",
            "--access-token", tokens.access_token.as_str(),
            "--backend", "pipe",
            "--format", "S16",
            // Note: librespot writes to stdout when --backend pipe is used
            // and no --device is given.
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!(
            "failed to spawn librespot: {e}. \
             Install with `cargo install librespot` and ensure it's on PATH.",
        ))?;

    let stdout = child.stdout.take().ok_or("no stdout from librespot")?;

    // Ring buffer holds ~0.25 sec of stereo float samples.
    let cap = (SR as usize) * (CHANNELS as usize) / 4;
    let rb: HeapRb<f32> = HeapRb::new(cap);
    let (mut prod, mut cons) = rb.split();

    let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();
    let child_arc = Arc::new(Mutex::new(Some(child)));

    // ---- Reader thread: librespot stdout → ring producer ----
    {
        let child_arc = child_arc.clone();
        thread::spawn(move || {
            let mut reader = stdout;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // S16LE → f32 normalized
                        let mut i = 0;
                        while i + 1 < n {
                            let s = i16::from_le_bytes([buf[i], buf[i + 1]]);
                            let f = (s as f32) / 32768.0;
                            // Spin briefly if ring is full (consumer is slow).
                            // librespot will block on the next pipe write,
                            // which is the natural backpressure path.
                            while prod.try_push(f).is_err() {
                                thread::sleep(std::time::Duration::from_micros(500));
                            }
                            i += 2;
                        }
                    }
                    Err(_) => break,
                }
            }
            // Reader exited — clear child handle so status flips.
            if let Ok(mut g) = child_arc.lock() {
                if let Some(mut c) = g.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
        });
    }

    // ---- Audio thread: cpal stream pulling from ring → EQ → device ----
    let eq_state = EQ_STATE.clone();
    let _audio_thread = thread::spawn(move || {
        let host = cpal::default_host();
        let device = match host.default_output_device() {
            Some(d) => d,
            None => return,
        };

        // Pick a stream config close to 44.1kHz stereo f32.
        let config = match device.default_output_config() {
            Ok(c) => c,
            Err(_) => return,
        };
        let sample_format = config.sample_format();
        let stream_config: StreamConfig = config.into();

        // Recover from a poisoned EQ mutex (a panic elsewhere while holding it)
        // rather than panicking the audio thread — the gains are plain data and
        // the rest of this file already treats the lock as poison-tolerant.
        let mut left = ChannelDsp::new(&eq_state.lock().unwrap_or_else(|e| e.into_inner()));
        let mut right = ChannelDsp::new(&eq_state.lock().unwrap_or_else(|e| e.into_inner()));
        let viz = std::sync::Arc::new(std::sync::Mutex::new(Visualizer::new()));

        let err_fn = |e| eprintln!("[audio] cpal stream error: {e}");

        let viz_for_f32 = viz.clone();
        let viz_for_i16 = viz.clone();
        let stream_result = match sample_format {
            SampleFormat::F32 => device.build_output_stream(
                &stream_config,
                move |out: &mut [f32], _| {
                    fill_f32(out, &mut cons, &mut left, &mut right, &eq_state, stream_config.channels);
                    if let Ok(mut v) = viz_for_f32.lock() {
                        feed_viz_from_buffer(&mut v, out, stream_config.channels);
                    }
                },
                err_fn,
                None,
            ),
            SampleFormat::I16 => device.build_output_stream(
                &stream_config,
                move |out: &mut [i16], _| {
                    let mut tmp = vec![0.0f32; out.len()];
                    fill_f32(&mut tmp, &mut cons, &mut left, &mut right, &eq_state, stream_config.channels);
                    if let Ok(mut v) = viz_for_i16.lock() {
                        feed_viz_from_buffer(&mut v, &tmp, stream_config.channels);
                    }
                    for (i, s) in tmp.into_iter().enumerate() {
                        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                        out[i] = v;
                    }
                },
                err_fn,
                None,
            ),
            _ => return,
        };

        let stream = match stream_result { Ok(s) => s, Err(_) => return };
        if stream.play().is_err() { return; }

        // Block this thread until shutdown — owning the stream keeps it alive.
        let _ = shutdown_rx.recv();
        // Stream drops here, releasing the device.
    });

    let mut g = PIPELINE.lock().map_err(|e| e.to_string())?;
    *g = Some(PipelineHandle { shutdown_tx, child: child_arc });
    Ok(())
}

fn fill_f32<C: Consumer<Item = f32>>(
    out: &mut [f32],
    cons: &mut C,
    left: &mut ChannelDsp,
    right: &mut ChannelDsp,
    eq_state: &Arc<Mutex<EqState>>,
    out_channels: u16,
) {
    let snapshot: EqState = match eq_state.try_lock() {
        Ok(g) => *g,
        Err(_) => return, // contention — skip update this buffer
    };
    if snapshot.enabled {
        left.maybe_update(&snapshot);
        right.maybe_update(&snapshot);
    }

    // Pull stereo source samples and lay them into the device's channel layout.
    // librespot is always stereo; if the device is mono, average L+R; if it
    // has more channels, leave the rest at zero.
    let frames = out.len() / out_channels.max(1) as usize;
    for f in 0..frames {
        let l_in = cons.try_pop().unwrap_or(0.0);
        let r_in = cons.try_pop().unwrap_or(0.0);
        let (lo, ro) = if snapshot.enabled {
            (left.process(l_in), right.process(r_in))
        } else {
            (l_in, r_in)
        };
        let base = f * out_channels as usize;
        match out_channels {
            1 => { out[base] = (lo + ro) * 0.5; }
            2 => { out[base] = lo; out[base + 1] = ro; }
            _ => {
                out[base] = lo;
                if out_channels >= 2 { out[base + 1] = ro; }
                for c in 2..out_channels as usize { out[base + c] = 0.0; }
            }
        }
    }
}

pub fn stop_pipeline() {
    let mut g = match PIPELINE.lock() { Ok(g) => g, Err(_) => return };
    if let Some(handle) = g.take() {
        let _ = handle.shutdown_tx.send(());
        if let Ok(mut c) = handle.child.lock() {
            if let Some(mut child) = c.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

pub fn is_running() -> bool {
    let g = match PIPELINE.lock() { Ok(g) => g, Err(_) => return false };
    g.is_some()
}

// ---- Tauri commands -----------------------------------------------------

#[tauri::command]
pub async fn audio_pipeline_start() -> Result<(), String> {
    start_pipeline().await
}

#[tauri::command]
pub fn audio_pipeline_stop() -> Result<(), String> {
    stop_pipeline();
    Ok(())
}

#[tauri::command]
pub fn audio_pipeline_status() -> bool {
    is_running()
}

#[tauri::command]
pub fn eq_get() -> Result<serde_json::Value, String> {
    let g = EQ_STATE.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "gains_db": g.gains_db,
        "enabled": g.enabled,
        "bands_hz": BAND_HZ,
    }))
}

#[tauri::command]
pub fn eq_set_band(idx: usize, gain_db: f32) -> Result<(), String> {
    if idx >= 10 { return Err("band idx out of range".into()); }
    let g_db = gain_db.clamp(-18.0, 18.0);
    let mut g = EQ_STATE.lock().map_err(|e| e.to_string())?;
    g.gains_db[idx] = g_db;
    Ok(())
}

#[tauri::command]
pub fn eq_set_enabled(enabled: bool) -> Result<(), String> {
    let mut g = EQ_STATE.lock().map_err(|e| e.to_string())?;
    g.enabled = enabled;
    Ok(())
}

// Frontend pulls these values via spectrum_get every animation frame and
// renders the bars. Returns 8 floats roughly in [0, 1] (often peaks higher
// for very loud tracks; frontend clamps).
#[tauri::command]
pub fn spectrum_get() -> [f32; 8] {
    match VIZ_LEVELS.lock() {
        Ok(g) => *g,
        Err(_) => [0.0; 8],
    }
}

fn feed_viz_from_buffer(viz: &mut Visualizer, out: &[f32], ch: u16) {
    let chs = ch as usize;
    if chs == 0 { return; }
    let frames = out.len() / chs;
    for f in 0..frames {
        let l = out[f * chs];
        let r = if chs >= 2 { out[f * chs + 1] } else { l };
        viz.feed(l, r);
    }
    viz.flush();
}

#[tauri::command]
pub fn eq_set_preset(name: String) -> Result<(), String> {
    let g_db: [f32; 10] = match name.as_str() {
        "flat"        => [0.0; 10],
        "bass_boost"  => [ 6.0,  5.0,  4.0,  2.0,  0.0,  0.0,  0.0,  0.0,  0.0,  0.0],
        "treble_boost"=> [ 0.0,  0.0,  0.0,  0.0,  0.0,  0.0,  2.0,  4.0,  5.0,  6.0],
        "vocal"       => [-2.0, -1.0,  0.0,  1.0,  3.0,  4.0,  3.0,  1.0,  0.0, -1.0],
        "rock"        => [ 5.0,  3.0, -1.0, -2.0, -1.0,  1.0,  3.0,  4.0,  5.0,  5.0],
        "pop"         => [-1.0,  0.0,  2.0,  4.0,  3.0,  1.0, -1.0, -1.0,  1.0,  2.0],
        "jazz"        => [ 3.0,  2.0,  1.0,  2.0, -1.0, -1.0,  0.0,  1.0,  2.0,  3.0],
        "classical"   => [ 4.0,  3.0,  2.0,  1.0, -1.0, -1.0, -1.0,  1.0,  2.0,  3.0],
        "electronic"  => [ 4.0,  3.0,  1.0,  0.0, -2.0,  1.0,  0.0,  1.0,  3.0,  4.0],
        "loudness"    => [ 5.0,  3.0,  0.0,  0.0, -1.0,  0.0,  0.0,  2.0,  4.0,  5.0],
        _ => return Err(format!("unknown preset: {name}")),
    };
    let mut g = EQ_STATE.lock().map_err(|e| e.to_string())?;
    g.gains_db = g_db;
    Ok(())
}
