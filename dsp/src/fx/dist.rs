//! Distortion (FX_DIST): tanh / wavefold / hard clip + post tone control.
//!
//! The three shapers have wildly different output levels for the same drive,
//! and every shaper gets louder as it saturates. Instead of hand-tuned magic
//! numbers, the compensation gain is *measured*: the shaper is swept over one
//! cycle of a −9 dBFS sine and the gain that restores the input RMS is used.
//! That keeps A/B comparisons between modes and drive settings honest — the
//! mix knob stays a mix knob rather than doubling as a volume knob.
//!
//! Not oversampled (unlike the per-voice filter drive): this is a master-bus
//! effect where the input is already band-limited, and 2× oversampling the
//! whole bus would cost more than the rest of the chain combined. Documented
//! MVP trade-off.

use crate::smoother::{Smoother, DEFAULT_TAU};

use super::common::OnePole;

/// Maximum pre-gain at `drive = 1` (≈ +28 dB).
const MAX_PRE: f32 = 24.0;
/// `TONE_HZ` at or above this bypasses the post filter entirely.
pub const TONE_BYPASS_HZ: f32 = 20_000.0;

#[inline(always)]
fn shape(x: f32, mode: u32) -> f32 {
    match mode {
        // Triangle fold: identity on [-1, 1], reflects beyond it.
        1 => {
            let t = x * 0.25 + 0.25;
            1.0 - 4.0 * ((t - t.floor()) - 0.5).abs()
        }
        2 => x.clamp(-1.0, 1.0),
        _ => x.tanh(),
    }
}

/// RMS-matching gain for `shape(pre · x)`, measured on a −9 dBFS sine.
fn compensation(mode: u32, pre: f32) -> f32 {
    const N: usize = 64;
    const AMP: f32 = 0.35;
    let mut acc = 0.0f32;
    for i in 0..N {
        let s = AMP * (std::f32::consts::TAU * i as f32 / N as f32).sin();
        let y = shape(s * pre, mode);
        acc += y * y;
    }
    let rms_out = (acc / N as f32).sqrt();
    let rms_in = AMP * std::f32::consts::FRAC_1_SQRT_2;
    if rms_out > 1.0e-6 {
        (rms_in / rms_out).clamp(0.0, 4.0)
    } else {
        1.0
    }
}

pub struct Dist {
    drive: Smoother,
    mix: Smoother,
    tone: Smoother,
    mode: u32,
    lp: [OnePole; 2],
    comp: f32,
    cached_pre: f32,
}

impl Dist {
    pub fn new(sample_rate: f32) -> Self {
        Dist {
            drive: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            mix: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            tone: Smoother::new(sample_rate, DEFAULT_TAU, TONE_BYPASS_HZ),
            mode: 0,
            lp: [OnePole::default(); 2],
            comp: 1.0,
            cached_pre: -1.0,
        }
    }

    pub fn reset(&mut self) {
        self.lp[0].reset();
        self.lp[1].reset();
    }

    pub fn apply_patch(&mut self, p: &[f32], sample_rate: f32, first: bool) {
        let mode = super::clamp_idx(p[crate::params::DIST_MODE], 0.0, 2.0);
        if mode != self.mode {
            self.mode = mode;
            self.cached_pre = -1.0; // force the compensation to be re-measured
        }
        super::set(
            &mut self.drive,
            super::fclamp(p[crate::params::DIST_DRIVE], 0.0, 1.0),
            first,
        );
        super::set(
            &mut self.mix,
            super::fclamp(p[crate::params::DIST_MIX], 0.0, 1.0),
            first,
        );
        super::set(
            &mut self.tone,
            super::fclamp(p[crate::params::DIST_TONE_HZ], 20.0, TONE_BYPASS_HZ)
                .min(sample_rate * 0.45),
            first,
        );
    }

    pub fn should_process(&self) -> bool {
        self.mix.current() > 0.0 || self.mix.target() > 0.0
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        let n = l.len();
        let mut mix = self.mix.block(n);
        let drive = self.drive.advance(n);
        let tone = self.tone.advance(n);

        let pre = 1.0 + MAX_PRE * drive;
        if (pre - self.cached_pre).abs() > 1.0e-6 {
            self.comp = compensation(self.mode, pre);
            self.cached_pre = pre;
        }

        let tone_on = tone < TONE_BYPASS_HZ.min(sample_rate * 0.45) - 1.0;
        if tone_on {
            self.lp[0].set_hz(tone, sample_rate);
            self.lp[1].set_hz(tone, sample_rate);
        }

        let (comp, mode) = (self.comp, self.mode);
        for i in 0..n {
            let m = mix.next();
            let mut wl = shape(l[i] * pre, mode) * comp;
            let mut wr = shape(r[i] * pre, mode) * comp;
            if tone_on {
                wl = self.lp[0].process(wl);
                wr = self.lp[1].process(wr);
            }
            l[i] += (wl - l[i]) * m;
            r[i] += (wr - r[i]) * m;
        }
    }
}
