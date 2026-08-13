//! Multi-track engine — owns every track and the shared wavetables.
//!
//! ```text
//! MultiEngine
//!   ├── tables: Vec<Table>          generated once in init(), immutable after
//!   ├── tracks: [Track; MAX_TRACKS] independent patch + voices + FX chain
//!   └── master bus                  Σ tracks → soft-clip guard → out L/R
//! ```
//!
//! # Why the tables live here
//!
//! The mipmapped wavetable set is ~5.5 MB and is **read-only after `init()`**.
//! Duplicating it per track would cost ~44 MB, and a module-level
//! `static`/`OnceLock` would either need unsafe global state or an atomic
//! check on every sample. Plain ownership is the cheapest correct option: the
//! `MultiEngine` owns the set and lends `&[Table]` to each track for the
//! duration of its `process()` call. Tracks and tables are disjoint fields, so
//! this borrows cleanly with no `Rc`, no locking and no indirection in the
//! audio path.
//!
//! # Master bus
//!
//! Track outputs are summed and passed through [`soft_clip_master`]: exactly
//! transparent (bit-identical) below 0.95, then C1-continuously bent so that
//! eight stacked tracks cannot hard-clip. A single moderate track therefore
//! sounds exactly as it did in v0.2.
//!
//! # Cost of idle tracks
//!
//! [`Track::process`] returns `false` without touching anything when the track
//! has never been patched, or when it is dormant (no voices, silent output,
//! FX tails expired). An unused track costs one branch per block.

use crate::engine::Track;
use crate::fx::common::soft_clip;
use crate::params::{MAX_BLOCK, MAX_TRACKS, PARAM_COUNT};
use crate::tables::{self, Table};

/// Below this the master guard is the identity, bit for bit.
pub const CLIP_KNEE: f32 = 0.95;
/// Asymptotic ceiling of the master guard.
pub const CLIP_LIMIT: f32 = 1.0;

/// Master output guard. Transparent below [`CLIP_KNEE`], asymptotic at
/// [`CLIP_LIMIT`], so `|out| < 1.0` always holds.
#[inline(always)]
pub fn soft_clip_master(x: f32) -> f32 {
    soft_clip(x, CLIP_KNEE, CLIP_LIMIT)
}

pub struct MultiEngine {
    sample_rate: f32,
    tables: Vec<Table>,
    tracks: Vec<Track>,
    scratch_l: [f32; MAX_BLOCK],
    scratch_r: [f32; MAX_BLOCK],
}

impl MultiEngine {
    /// Builds the shared wavetables and every track. **The only allocating
    /// entry point** — nothing below this line allocates again.
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate.is_finite() && sample_rate > 1000.0 {
            sample_rate
        } else {
            48_000.0
        };
        let mut tracks = Vec::with_capacity(MAX_TRACKS);
        for _ in 0..MAX_TRACKS {
            tracks.push(Track::new(sr));
        }
        MultiEngine {
            sample_rate: sr,
            tables: tables::build_all(),
            tracks,
            scratch_l: [0.0; MAX_BLOCK],
            scratch_r: [0.0; MAX_BLOCK],
        }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    /// Shared wavetable registry (test helper).
    pub fn tables(&self) -> &[Table] {
        &self.tables
    }

    pub fn track(&self, track: usize) -> Option<&Track> {
        self.tracks.get(track)
    }

    pub fn track_mut(&mut self, track: usize) -> Option<&mut Track> {
        self.tracks.get_mut(track)
    }

    /// Voices sounding across every track.
    pub fn active_voices(&self) -> usize {
        self.tracks.iter().map(|t| t.active_voices()).sum()
    }

    pub fn track_active_voices(&self, track: usize) -> usize {
        self.tracks.get(track).map_or(0, |t| t.active_voices())
    }

    /// Tracks that will actually be rendered this block.
    pub fn live_tracks(&self) -> usize {
        self.tracks
            .iter()
            .filter(|t| t.is_primed() && !t.is_dormant())
            .count()
    }

    // ------------------------------------------------------------ contract

    /// Out-of-range track indices are ignored silently (docs/architecture.md).
    pub fn apply_patch(&mut self, track: usize, p: &[f32; PARAM_COUNT]) {
        if let Some(t) = self.tracks.get_mut(track) {
            t.apply_patch(p);
        }
    }

    pub fn note_on(&mut self, track: usize, note: f32, velocity: f32) {
        if let Some(t) = self.tracks.get_mut(track) {
            t.note_on(note, velocity);
        }
    }

    /// Note-on with a per-note glide time and legato flag
    /// ([`Track::note_on_ex`]; docs/workstreams.md §10).
    pub fn note_on_ex(
        &mut self,
        track: usize,
        note: f32,
        velocity: f32,
        glide_s: f32,
        legato: bool,
    ) {
        if let Some(t) = self.tracks.get_mut(track) {
            t.note_on_ex(note, velocity, glide_s, legato);
        }
    }

    pub fn note_off(&mut self, track: usize, note: f32) {
        if let Some(t) = self.tracks.get_mut(track) {
            t.note_off(note);
        }
    }

    /// Fast-fades every voice on every track.
    pub fn all_notes_off(&mut self) {
        for t in self.tracks.iter_mut() {
            t.all_notes_off();
        }
    }

    /// Renders one block (≤ [`MAX_BLOCK`]). Allocation-free.
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len().min(out_r.len()).min(MAX_BLOCK);
        if n == 0 {
            return;
        }
        out_l[..n].fill(0.0);
        out_r[..n].fill(0.0);

        for t in self.tracks.iter_mut() {
            if !t.process(
                &self.tables,
                &mut self.scratch_l[..n],
                &mut self.scratch_r[..n],
            ) {
                continue;
            }
            for i in 0..n {
                out_l[i] += self.scratch_l[i];
                out_r[i] += self.scratch_r[i];
            }
        }

        for i in 0..n {
            out_l[i] = soft_clip_master(out_l[i]);
            out_r[i] = soft_clip_master(out_r[i]);
        }
    }

    /// Offline rendering helper (tests): drives `process` in ≤128-sample
    /// blocks exactly the way the worklet would.
    pub fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len().min(out_r.len());
        let mut i = 0;
        while i < n {
            let len = MAX_BLOCK.min(n - i);
            let (l, r) = (&mut out_l[i..i + len], &mut out_r[i..i + len]);
            self.process(l, r);
            i += len;
        }
    }
}
