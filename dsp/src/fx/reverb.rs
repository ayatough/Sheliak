//! Freeverb-style reverb (FX_REVERB): 8 damped combs + 4 allpasses per
//! channel, fed through a predelay line.
//!
//! Jezar's classic tunings are given at 44.1 kHz, so every length is scaled by
//! `sample_rate / 44100`, then by `SIZE` (0.75×…1.25×) — a longer comb set is
//! a physically bigger room, and `SIZE` also raises the comb feedback the way
//! Freeverb's `roomsize` does. The right channel's lines are offset by the
//! classic 23-sample stereo spread.
//!
//! Fully deterministic: no randomised modulation anywhere (some reverbs
//! jitter their comb lengths — that would break the bit-exactness requirement
//! unless seeded, so it is simply omitted).
//!
//! Changing `SIZE` re-tunes the comb lengths, which can produce a short
//! transient in an existing tail. That is an accepted MVP behaviour (documented
//! in `fx/mod.rs`); the wet `MIX` is still smoothed, so the change never
//! clicks.

use crate::params::{REVERB_DAMP, REVERB_MIX, REVERB_PREDELAY_S, REVERB_SIZE, REVERB_WIDTH};
use crate::smoother::{Smoother, DEFAULT_TAU};

use super::common::DelayLine;

const COMB_TUNING: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_TUNING: [usize; 4] = [556, 441, 341, 225];
const STEREO_SPREAD: usize = 23;
const FIXED_GAIN: f32 = 0.015;
const MAX_SIZE_SCALE: f32 = 1.25;
const MIN_SIZE_SCALE: f32 = 0.75;
/// Predelay allocation (SPEC §3: PREDELAY_S ≤ 0.25).
pub const MAX_PREDELAY_S: f32 = 0.25;

struct Comb {
    line: DelayLine,
    store: f32,
    len: usize,
}

impl Comb {
    fn new(cap: usize) -> Self {
        Comb {
            line: DelayLine::new(cap),
            store: 0.0,
            len: cap / 2,
        }
    }

    #[inline(always)]
    fn process(&mut self, x: f32, feedback: f32, damp: f32) -> f32 {
        let y = self.line.read_int(self.len);
        self.store = y * (1.0 - damp) + self.store * damp;
        self.line.write(x + self.store * feedback);
        y
    }
}

struct Allpass {
    line: DelayLine,
    len: usize,
}

impl Allpass {
    fn new(cap: usize) -> Self {
        Allpass {
            line: DelayLine::new(cap),
            len: cap / 2,
        }
    }

    #[inline(always)]
    fn process(&mut self, x: f32) -> f32 {
        let buffered = self.line.read_int(self.len);
        self.line.write(x + buffered * 0.5);
        buffered - x
    }
}

pub struct Reverb {
    size: Smoother,
    damp: Smoother,
    mix: Smoother,
    width: Smoother,
    predelay: Smoother,
    combs: [[Comb; 8]; 2],
    aps: [[Allpass; 4]; 2],
    pre: [DelayLine; 2],
    sr_scale: f32,
    tuned_size: f32,
}

fn scaled(base: usize, sr_scale: f32, size_scale: f32) -> usize {
    ((base as f32 * sr_scale * size_scale) as usize).max(8)
}

impl Reverb {
    pub fn new(sample_rate: f32) -> Self {
        let sr_scale = sample_rate / 44_100.0;
        let comb_cap = |i: usize| scaled(COMB_TUNING[i] + STEREO_SPREAD, sr_scale, MAX_SIZE_SCALE) + 8;
        let ap_cap = |i: usize| scaled(ALLPASS_TUNING[i] + STEREO_SPREAD, sr_scale, 1.0) + 8;
        let pre_cap = (MAX_PREDELAY_S * sample_rate) as usize + 8;
        let mut rv = Reverb {
            size: Smoother::new(sample_rate, DEFAULT_TAU, 0.5),
            damp: Smoother::new(sample_rate, DEFAULT_TAU, 0.5),
            mix: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            width: Smoother::new(sample_rate, DEFAULT_TAU, 1.0),
            predelay: Smoother::new(sample_rate, DEFAULT_TAU, 2.0),
            combs: std::array::from_fn(|_| std::array::from_fn(|i| Comb::new(comb_cap(i)))),
            aps: std::array::from_fn(|_| std::array::from_fn(|i| Allpass::new(ap_cap(i)))),
            pre: [DelayLine::new(pre_cap), DelayLine::new(pre_cap)],
            sr_scale,
            tuned_size: -1.0,
        };
        rv.retune(0.5);
        rv
    }

    /// Recomputes every line length for a new `SIZE`.
    fn retune(&mut self, size: f32) {
        let scale = MIN_SIZE_SCALE + (MAX_SIZE_SCALE - MIN_SIZE_SCALE) * size.clamp(0.0, 1.0);
        for (ch, combs) in self.combs.iter_mut().enumerate() {
            let spread = if ch == 1 { STEREO_SPREAD } else { 0 };
            for (i, c) in combs.iter_mut().enumerate() {
                let len = scaled(COMB_TUNING[i] + spread, self.sr_scale, scale);
                c.len = len.min(c.line.capacity() - 2);
            }
        }
        for (ch, aps) in self.aps.iter_mut().enumerate() {
            let spread = if ch == 1 { STEREO_SPREAD } else { 0 };
            for (i, a) in aps.iter_mut().enumerate() {
                let len = scaled(ALLPASS_TUNING[i] + spread, self.sr_scale, 1.0);
                a.len = len.min(a.line.capacity() - 2);
            }
        }
        self.tuned_size = size;
    }

    pub fn reset(&mut self) {
        for combs in self.combs.iter_mut() {
            for c in combs.iter_mut() {
                c.line.clear();
                c.store = 0.0;
            }
        }
        for aps in self.aps.iter_mut() {
            for a in aps.iter_mut() {
                a.line.clear();
            }
        }
        self.pre[0].clear();
        self.pre[1].clear();
    }

    pub fn apply_patch(&mut self, p: &[f32], sample_rate: f32, first: bool) {
        super::set(&mut self.size, super::fclamp(p[REVERB_SIZE], 0.0, 1.0), first);
        super::set(&mut self.damp, super::fclamp(p[REVERB_DAMP], 0.0, 1.0), first);
        super::set(&mut self.mix, super::fclamp(p[REVERB_MIX], 0.0, 1.0), first);
        super::set(&mut self.width, super::fclamp(p[REVERB_WIDTH], 0.0, 1.0), first);
        super::set(
            &mut self.predelay,
            (super::fclamp(p[REVERB_PREDELAY_S], 0.0, MAX_PREDELAY_S) * sample_rate).max(2.0),
            first,
        );
    }

    pub fn should_process(&self) -> bool {
        self.mix.current() > 0.0 || self.mix.target() > 0.0
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], _sample_rate: f32) {
        let n = l.len();
        let mut mix = self.mix.block(n);
        let mut pre_d = self.predelay.block(n);
        let size = self.size.advance(n);
        let damp = self.damp.advance(n) * 0.4;
        let width = self.width.advance(n);

        // Comb lengths only change on a real SIZE move (they are integers, so
        // most blocks retune to the same values anyway).
        if (size - self.tuned_size).abs() > 1.0e-4 {
            self.retune(size);
        }
        let feedback = 0.7 + 0.28 * size;
        let wet1 = width * 0.5 + 0.5;
        let wet2 = (1.0 - width) * 0.5;

        for i in 0..n {
            let m = mix.next();
            let d = pre_d.next();
            self.pre[0].write(l[i]);
            self.pre[1].write(r[i]);
            let xl = self.pre[0].read(d) * FIXED_GAIN;
            let xr = self.pre[1].read(d) * FIXED_GAIN;

            let mut wl = 0.0;
            let mut wr = 0.0;
            for c in self.combs[0].iter_mut() {
                wl += c.process(xl, feedback, damp);
            }
            for c in self.combs[1].iter_mut() {
                wr += c.process(xr, feedback, damp);
            }
            for a in self.aps[0].iter_mut() {
                wl = a.process(wl);
            }
            for a in self.aps[1].iter_mut() {
                wr = a.process(wr);
            }

            let ol = wl * wet1 + wr * wet2;
            let or = wr * wet1 + wl * wet2;
            l[i] += (ol - l[i]) * m;
            r[i] += (or - r[i]) * m;
        }
    }
}
