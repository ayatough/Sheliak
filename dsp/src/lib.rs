//! Sheliak DSP core — wavetable synth engine.
//!
//! Two faces:
//!
//! * the safe [`MultiEngine`] API (`rlib`), used by `tests/verify.rs`, by
//!   `render/` and by `wclap/`;
//! * the raw `extern "C"` exports in [`abi`] (`cdylib` →
//!   `wasm32-unknown-unknown`, no wasm-bindgen), which are a thin shell around
//!   exactly that API. They are behind the default `abi` feature: a crate that
//!   links this one *into another cdylib* — `wclap/` does — turns the feature
//!   off, or every one of these symbols would be exported from that module too.
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
//! The engine lives in a single process-wide `Shell` guarded by an
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

#[cfg(feature = "abi")]
pub mod abi;
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
