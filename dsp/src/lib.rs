//! Sheliak DSP core — wavetable synth engine.
//!
//! Two faces:
//!
//! * the safe [`Engine`] API (`rlib`), used by `tests/verify.rs` and by any
//!   future native host;
//! * the raw `extern "C"` exports below (`cdylib` → `wasm32-unknown-unknown`,
//!   no wasm-bindgen), which are a thin shell around exactly that API.
//!
//! ABI (SPEC §2):
//!
//! ```text
//! init(sample_rate: f32)
//! params_ptr() -> *mut f32      // f32 × PARAM_COUNT
//! apply_patch()
//! note_on(note: f32, velocity: f32)
//! note_off(note: f32)
//! all_notes_off()
//! process(nframes: u32)         // nframes ≤ 128
//! out_l_ptr() -> *const f32     // f32 × 128
//! out_r_ptr() -> *const f32
//! ```
//!
//! # Safety of the global state
//!
//! The engine lives in a single process-wide [`Shell`] guarded by an
//! `UnsafeCell`. This is sound **because the host is single-threaded by
//! construction**: the exports are only ever called from one AudioWorklet
//! render thread (SPEC §6; REQUIREMENTS §5.1 explicitly rules out
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
pub mod lfo;
pub mod oscillator;
pub mod params;
pub mod rng;
pub mod smoother;
pub mod tables;
pub mod voice;

pub use engine::Engine;

use core::cell::UnsafeCell;
use params::{MAX_BLOCK, PARAM_COUNT};

struct Shell {
    engine: Option<Engine>,
    params: [f32; PARAM_COUNT],
    out_l: [f32; MAX_BLOCK],
    out_r: [f32; MAX_BLOCK],
}

struct SingleThreaded(UnsafeCell<Shell>);

// SAFETY: see the module docs — the wasm host is single-threaded and calls
// into these exports sequentially. The type is never actually shared.
unsafe impl Sync for SingleThreaded {}

static STATE: SingleThreaded = SingleThreaded(UnsafeCell::new(Shell {
    engine: None,
    params: [0.0; PARAM_COUNT],
    out_l: [0.0; MAX_BLOCK],
    out_r: [0.0; MAX_BLOCK],
}));

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
    s.engine = Some(Engine::new(sample_rate));
    s.out_l = [0.0; MAX_BLOCK];
    s.out_r = [0.0; MAX_BLOCK];
}

/// Pointer to the `PARAM_COUNT`-long parameter block the host writes into.
#[no_mangle]
pub extern "C" fn params_ptr() -> *mut f32 {
    shell().params.as_mut_ptr()
}

/// Reads the parameter block into the engine. Allocation-free.
#[no_mangle]
pub extern "C" fn apply_patch() {
    let s = shell();
    let p = s.params;
    if let Some(e) = s.engine.as_mut() {
        e.apply_patch(&p);
    }
}

#[no_mangle]
pub extern "C" fn note_on(note: f32, velocity: f32) {
    if let Some(e) = shell().engine.as_mut() {
        e.note_on(note, velocity);
    }
}

#[no_mangle]
pub extern "C" fn note_off(note: f32) {
    if let Some(e) = shell().engine.as_mut() {
        e.note_off(note);
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
