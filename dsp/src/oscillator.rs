//! Wavetable oscillator with up to 7 unison voices (SPEC §4, REQUIREMENTS §4.1).
//!
//! * `u32` fixed-point phase accumulator (wrapping add), so phase precision
//!   does not degrade at high frequencies the way an `f32` phase would.
//! * Sample interpolation: 4-point Hermite. Frame (morph) interpolation:
//!   linear. Mip level: linear crossfade between the two adjacent octave
//!   levels, so no discontinuity is audible while gliding across an octave
//!   boundary.
//! * Unison: JP-8000 style non-linear detune spread, equal-power stereo
//!   spread, and constant-power gain compensation.

use std::f32::consts::PI;

use crate::params::MAX_UNISON;
use crate::rng::hash_stream;
use crate::smoother::Ramp;
use crate::tables::{Mip, Table, NUM_MIPS};

/// Lowest fundamental handled by mip level 0 is `sr / 4096`.
pub const MIP_BASE_DIV: f32 = 4096.0;

/// Fractional mip level for a fundamental — level `k` covers the octave
/// `[2^k, 2^(k+1)) · sr/4096`.
#[inline]
pub fn mip_level_for(freq: f32, sample_rate: f32) -> f32 {
    let f0 = sample_rate / MIP_BASE_DIV;
    (freq / f0).max(1.0e-6).log2().clamp(0.0, (NUM_MIPS - 1) as f32)
}

/// JP-8000 / "supersaw" detune spread.
///
/// The JP-8000's seven oscillators are *not* spread linearly; Adam Szabo's
/// reverse-engineering of the instrument ("How to Emulate the Super Saw",
/// KTH 2010) measured the relative offsets
/// `[-1, -0.6357, -0.2900, 0, +0.2288, +0.6098, +1]`. Those magnitudes follow
/// a power law very closely: `|offset| ≈ |x|^1.2` for evenly spaced
/// `x ∈ [-1, 1]` (fit error < 0.02). We use the symmetric form
///
/// ```text
/// offset(x) = sign(x) · |x|^1.2
/// ```
///
/// which reproduces the characteristic "packed centre, splayed edges"
/// distribution that gives the supersaw its beating, generalises to any unison
/// count (the measured table only covers 7), and — unlike the raw measurement,
/// which is slightly asymmetric — stays exactly symmetric so the detuning
/// cannot pull the perceived pitch off centre.
///
/// The returned offsets are multiplied by `detune_cents`.
pub fn detune_offsets(n: usize) -> [f32; MAX_UNISON] {
    let mut out = [0.0f32; MAX_UNISON];
    if n <= 1 {
        return out;
    }
    let n = n.min(MAX_UNISON);
    for (i, o) in out.iter_mut().take(n).enumerate() {
        // Written as (2i − (n−1)) / (n−1) rather than −1 + 2i/(n−1) so that
        // mirrored indices produce *exactly* negated floats.
        let x = (2 * i) as f32 - (n - 1) as f32;
        let x = x / (n - 1) as f32;
        *o = x.abs().powf(1.2) * if x < 0.0 { -1.0 } else { 1.0 };
    }
    out
}

/// Linear stereo positions in `[-1, 1]`, later scaled by the spread amount.
pub fn pan_positions(n: usize) -> [f32; MAX_UNISON] {
    let mut out = [0.0f32; MAX_UNISON];
    if n <= 1 {
        return out;
    }
    let n = n.min(MAX_UNISON);
    for (i, o) in out.iter_mut().take(n).enumerate() {
        *o = ((2 * i) as f32 - (n - 1) as f32) / (n - 1) as f32;
    }
    out
}

/// Per-unison-voice gains: the centre voice stays at full level and the
/// detuned voices sit slightly below it (as on the JP-8000, where the centre
/// saw dominates), then the whole set is normalised to unit power so that
/// changing the unison count does not change perceived loudness.
pub fn unison_gains(n: usize) -> [f32; MAX_UNISON] {
    let mut out = [0.0f32; MAX_UNISON];
    let n = n.clamp(1, MAX_UNISON);
    let offs = detune_offsets(n);
    let mut power = 0.0;
    for (i, o) in out.iter_mut().take(n).enumerate() {
        let g = 1.0 - 0.15 * offs[i].abs();
        *o = g;
        power += g * g;
    }
    let norm = 1.0 / power.max(1.0e-9).sqrt();
    for o in out.iter_mut().take(n) {
        *o *= norm;
    }
    out
}

/// Everything needed to read one unison voice's sample; recomputed once per
/// block (it only depends on frequency and morph, both control-rate).
#[derive(Copy, Clone, Default)]
pub struct Tap {
    pub m0: Mip,
    pub m1: Mip,
    pub mfrac: f32,
    pub fr0: u32,
    pub fr1: u32,
    pub ffrac: f32,
}

impl Tap {
    #[inline(always)]
    pub fn sample(&self, table: &Table, phase: u32) -> f32 {
        let a = table.sample_mip(&self.m0, self.fr0, self.fr1, self.ffrac, phase);
        if self.mfrac <= 0.0 {
            return a;
        }
        let b = table.sample_mip(&self.m1, self.fr0, self.fr1, self.ffrac, phase);
        a + (b - a) * self.mfrac
    }
}

/// Morph position → adjacent frame indices + crossfade.
#[inline]
pub fn frame_pos(frames: usize, morph: f32) -> (u32, u32, f32) {
    if frames <= 1 {
        return (0, 0, 0.0);
    }
    let pos = morph.clamp(0.0, 1.0) * (frames - 1) as f32;
    let i0 = pos.floor();
    let frac = pos - i0;
    let a = i0 as usize;
    if frac == 0.0 {
        // Frame-aligned (morph = 0 is the common case): collapse to a single
        // frame so the inner loop does half the interpolation work.
        return (a as u32, a as u32, 0.0);
    }
    let b = (a + 1).min(frames - 1);
    (a as u32, b as u32, frac)
}

pub struct Osc {
    pub phase: [u32; MAX_UNISON],
    pub inc: [u32; MAX_UNISON],
    pub taps: [Tap; MAX_UNISON],
    pub gain_l: [f32; MAX_UNISON],
    pub gain_r: [f32; MAX_UNISON],
    /// Unison count, latched at note-on (see [`Osc::note_on`]).
    pub count: usize,
    /// Table id, latched at note-on.
    pub table_id: usize,
}

impl Default for Osc {
    fn default() -> Self {
        Osc {
            phase: [0; MAX_UNISON],
            inc: [0; MAX_UNISON],
            taps: [Tap::default(); MAX_UNISON],
            gain_l: [0.0; MAX_UNISON],
            gain_r: [0.0; MAX_UNISON],
            count: 1,
            table_id: 0,
        }
    }
}

impl Osc {
    /// Latches the discrete configuration and derives the start phases.
    ///
    /// `table_id`, `count` and `phase_random` are *latched per note*: changing
    /// them mid-note would mean rebuilding the unison stack under a sounding
    /// voice (new oscillators appearing at unrelated phases), which clicks.
    /// They therefore take effect on the next note-on. All continuous
    /// parameters (level, morph, detune, spread, tune) stay live and smoothed.
    ///
    /// Phases come from `hash_stream(seed, osc, unison, note)` — a pure
    /// function, so they never depend on how many notes were played before,
    /// and `apply_patch()` cannot disturb a sounding voice.
    pub fn note_on(
        &mut self,
        seed: u32,
        osc_idx: u32,
        note: f32,
        count: usize,
        table_id: usize,
        phase_random: bool,
    ) {
        self.count = count.clamp(1, MAX_UNISON);
        self.table_id = table_id;
        let note_key = (note * 16.0).round() as i32 as u32;
        for (u, p) in self.phase.iter_mut().enumerate() {
            *p = if phase_random {
                hash_stream(seed, osc_idx, u as u32, note_key)
            } else {
                0
            };
        }
    }

    /// Recomputes per-block state: phase increments, mip taps, pan gains.
    #[allow(clippy::too_many_arguments)]
    pub fn configure(
        &mut self,
        table: &Table,
        sample_rate: f32,
        base_cents: f32,
        detune_cents: f32,
        spread: f32,
        morph: f32,
    ) {
        let n = self.count;
        let offs = detune_offsets(n);
        let pans = pan_positions(n);
        let gains = unison_gains(n);
        let (fr0, fr1, ffrac) = frame_pos(table.frames as usize, morph);
        let max_freq = sample_rate * 0.49;

        for u in 0..n {
            let cents = base_cents + offs[u] * detune_cents;
            let freq = (440.0 * (cents * (1.0 / 1200.0)).exp2()).clamp(0.0, max_freq);
            self.inc[u] = (freq / sample_rate * 4_294_967_296.0) as u32;

            let lvl = mip_level_for(freq, sample_rate);
            let base = lvl.floor();
            let i0 = base as usize;
            let i1 = (i0 + 1).min(NUM_MIPS - 1);
            self.taps[u] = Tap {
                m0: table.mips[i0],
                m1: table.mips[i1],
                mfrac: if i1 == i0 { 0.0 } else { lvl - base },
                fr0,
                fr1,
                ffrac,
            };

            // Equal-power pan across [-spread, +spread].
            let angle = (pans[u] * spread + 1.0) * (PI * 0.25);
            self.gain_l[u] = angle.cos() * gains[u];
            self.gain_r[u] = angle.sin() * gains[u];
        }
    }

    /// Renders `n` samples, accumulating into the voice's stereo scratch.
    pub fn render(&mut self, table: &Table, n: usize, l: &mut [f32], r: &mut [f32], level: Ramp) {
        let count = self.count.min(MAX_UNISON);
        let l = &mut l[..n];
        let r = &mut r[..n];
        for u in 0..count {
            let tap = self.taps[u];
            let inc = self.inc[u];
            let gl = self.gain_l[u];
            let gr = self.gain_r[u];
            let mut ph = self.phase[u];
            let mut lv = level;
            for i in 0..n {
                let s = tap.sample(table, ph) * lv.next();
                ph = ph.wrapping_add(inc);
                l[i] += s * gl;
                r[i] += s * gr;
            }
            self.phase[u] = ph;
        }
    }
}
