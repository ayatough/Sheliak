//! The raw `extern "C"` face of the core: the ABI the AudioWorklet drives.
//!
//! Every export here is documented in the crate root and in
//! docs/architecture.md; this file only holds them. It is a module of its own,
//! behind the default `abi` feature, because a `#[no_mangle]` symbol in an
//! rlib is exported from *whatever* cdylib links that rlib — so `wclap/`,
//! which is a cdylib that links this crate, would otherwise ship a CLAP plugin
//! with `note_on` and `process` hanging off it, and drag the whole engine into
//! a module that only wanted one effect. Turning the feature off leaves the
//! safe [`MultiEngine`](crate::MultiEngine) API and nothing else.

use core::cell::UnsafeCell;

use crate::params::{MAX_BLOCK, MAX_TRACKS, PARAM_COUNT};
use crate::MultiEngine;

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

/// One track's own output for the block just rendered — its stem, after that
/// track's FX chain and before the tracks are summed. Null for an out-of-range
/// index, and for any call made before `init`.
///
/// The stems of every track sum to what `out_l_ptr`/`out_r_ptr` hold, exactly,
/// unless the master guard engaged — which it does not below `CLIP_KNEE`.
#[no_mangle]
pub extern "C" fn out_track_l_ptr(track: u32) -> *const f32 {
    match shell()
        .engine
        .as_ref()
        .and_then(|e| e.track_out(track as usize))
    {
        Some((l, _)) => l.as_ptr(),
        None => core::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn out_track_r_ptr(track: u32) -> *const f32 {
    match shell()
        .engine
        .as_ref()
        .and_then(|e| e.track_out(track as usize))
    {
        Some((_, r)) => r.as_ptr(),
        None => core::ptr::null(),
    }
}
