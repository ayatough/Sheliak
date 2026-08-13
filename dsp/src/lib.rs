//! Sheliak DSP core — wavetable synth engine.
//!
//! Two faces:
//!
//! * the safe [`MultiEngine`] API (`rlib`), used by `tests/verify.rs` and by
//!   any future native host;
//! * the raw `extern "C"` exports below (`cdylib` → `wasm32-unknown-unknown`,
//!   no wasm-bindgen), which are a thin shell around exactly that API.
//!
//! ABI (docs/architecture.md):
//!
//! ```text
//! init(sample_rate: f32)
//! params_ptr(track: u32) -> *mut f32   // f32 × PARAM_COUNT, per track
//! apply_patch(track: u32)
//! note_on(track: u32, note: f32, velocity: f32, glide_s: f32, legato: u32)
//! note_off(track: u32, note: f32)
//! all_notes_off()                      // every track
//! process(nframes: u32)                // nframes ≤ 128, summed master bus
//! out_l_ptr() -> *const f32            // f32 × 128
//! out_r_ptr() -> *const f32
//! ```
//!
//! `track` is `0..MAX_TRACKS`. **Out-of-range indices are ignored silently and
//! never panic**: the note/patch entry points become no-ops, and
//! `params_ptr()` hands back a scratch block that is never read back, so a
//! buggy host can write into it harmlessly.
//!
//! # Safety of the global state
//!
//! The engine lives in a single process-wide [`Shell`] guarded by an
//! `UnsafeCell`. This is sound **because the host is single-threaded by
//! construction**: the exports are only ever called from one AudioWorklet
//! render thread (docs/architecture.md explicitly rules out
//! `SharedArrayBuffer`/wasm threads for the MVP), and the calls are strictly
//! sequential — the worklet splits a render quantum at event boundaries and
//! calls `process(); note_on(); process(); ...` in order. No export re-enters
//! another, and no reference outlives its call. `params_ptr()` / `out_*_ptr()`
//! hand out pointers into the same cell; the host is expected to write params
//! before `apply_patch()` and read the outputs after `process()`, never
//! concurrently.
//!
//! Every export is defensive: calling anything before `init()` is a silent
//! no-op (or returns a valid pointer to zeroed memory), and `nframes` is
//! clamped to [`MAX_BLOCK`].

pub mod engine;
pub mod envelope;
pub mod filter;
pub mod fx;
pub mod lfo;
pub mod multi;
pub mod noise;
pub mod oscillator;
pub mod params;
pub mod rng;
pub mod smoother;
pub mod tables;
pub mod voice;

pub use engine::Track;
pub use multi::MultiEngine;

use core::cell::UnsafeCell;
use params::{MAX_BLOCK, MAX_TRACKS, PARAM_COUNT};

struct Shell {
    engine: Option<MultiEngine>,
    /// One parameter block per track, plus a trailing scratch block handed out
    /// for out-of-range track indices.
    params: [[f32; PARAM_COUNT]; MAX_TRACKS + 1],
    out_l: [f32; MAX_BLOCK],
    out_r: [f32; MAX_BLOCK],
}

struct SingleThreaded(UnsafeCell<Shell>);

// SAFETY: see the module docs — the wasm host is single-threaded and calls
// into these exports sequentially. The type is never actually shared.
unsafe impl Sync for SingleThreaded {}

static STATE: SingleThreaded = SingleThreaded(UnsafeCell::new(Shell {
    engine: None,
    params: [[0.0; PARAM_COUNT]; MAX_TRACKS + 1],
    out_l: [0.0; MAX_BLOCK],
    out_r: [0.0; MAX_BLOCK],
}));

/// Index of the scratch parameter block used for out-of-range tracks.
const DUMP: usize = MAX_TRACKS;

#[inline]
fn track_slot(track: u32) -> usize {
    let t = track as usize;
    if t < MAX_TRACKS {
        t
    } else {
        DUMP
    }
}

/// SAFETY: single-threaded host, no re-entrancy, borrow ends with the call.
#[inline]
#[allow(clippy::mut_from_ref)]
fn shell() -> &'static mut Shell {
    unsafe { &mut *STATE.0.get() }
}

/// Allocates tables, mipmaps and voices, and resets all state.
#[no_mangle]
pub extern "C" fn init(sample_rate: f32) {
    let s = shell();
    s.engine = Some(MultiEngine::new(sample_rate));
    s.out_l = [0.0; MAX_BLOCK];
    s.out_r = [0.0; MAX_BLOCK];
}

/// Pointer to a track's `PARAM_COUNT`-long parameter block. Out-of-range
/// tracks get the scratch block (writes there are simply never applied).
#[no_mangle]
pub extern "C" fn params_ptr(track: u32) -> *mut f32 {
    shell().params[track_slot(track)].as_mut_ptr()
}

/// Reads a track's parameter block into the engine. Allocation-free.
#[no_mangle]
pub extern "C" fn apply_patch(track: u32) {
    let t = track as usize;
    if t >= MAX_TRACKS {
        return;
    }
    let s = shell();
    let p = s.params[t];
    if let Some(e) = s.engine.as_mut() {
        e.apply_patch(t, &p);
    }
}

/// Starts a note. `glide_s` is a per-note glide time in seconds; a negative
/// value (the worklet sends `-1`) means "use the patch's `voice.glide`", which
/// is the behaviour this export had when it took three arguments. `legato != 0`
/// bends the newest sounding voice on the track to the new pitch instead of
/// starting a note, leaving the amplitude envelope running.
///
/// A host that still calls this with three arguments gets `NaN` for `glide_s`
/// and `0` for `legato` — non-finite is treated as the patch glide, so the old
/// call is bit-identical to `note_on(track, note, velocity, -1.0, 0)`.
#[no_mangle]
pub extern "C" fn note_on(track: u32, note: f32, velocity: f32, glide_s: f32, legato: u32) {
    if let Some(e) = shell().engine.as_mut() {
        e.note_on_ex(track as usize, note, velocity, glide_s, legato != 0);
    }
}

#[no_mangle]
pub extern "C" fn note_off(track: u32, note: f32) {
    if let Some(e) = shell().engine.as_mut() {
        e.note_off(track as usize, note);
    }
}

#[no_mangle]
pub extern "C" fn all_notes_off() {
    if let Some(e) = shell().engine.as_mut() {
        e.all_notes_off();
    }
}

/// Renders `nframes` (≤ [`MAX_BLOCK`]) into the output buffers.
#[no_mangle]
pub extern "C" fn process(nframes: u32) {
    let n = (nframes as usize).min(MAX_BLOCK);
    let s = shell();
    match s.engine.as_mut() {
        Some(e) => e.process(&mut s.out_l[..n], &mut s.out_r[..n]),
        None => {
            s.out_l[..n].fill(0.0);
            s.out_r[..n].fill(0.0);
        }
    }
}

#[no_mangle]
pub extern "C" fn out_l_ptr() -> *const f32 {
    shell().out_l.as_ptr()
}

#[no_mangle]
pub extern "C" fn out_r_ptr() -> *const f32 {
    shell().out_r.as_ptr()
}
