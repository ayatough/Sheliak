//! 3-band compressor (FX_MBCOMP), crossovers fixed at 120 Hz / 2.5 kHz.
//!
//! # Crossover choice
//!
//! Linkwitz-Riley pairs give steep 24 dB/oct splits but only sum to an
//! *allpass*: the recombined signal is magnitude-flat yet phase-shifted, so a
//! multiband stage is never truly bypassable and the low band needs an extra
//! allpass to line up with the others. This implementation instead uses
//! **matched complementary one-poles**:
//!
//! ```text
//! low  = LP120(x)
//! rest = x − low
//! mid  = LP2500(rest)
//! high = rest − mid
//! ```
//!
//! `low + mid + high ≡ x` **sample for sample** (to f32 rounding), at any
//! frequency and with no phase compensation, which is exactly the
//! "bands must sum transparently" requirement — and the gain computer returns
//! exactly 1.0 below threshold, so an un-triggered mbcomp is transparent to
//! ~1e-7 relative error rather than "flat in magnitude only". The cost is
//! gentle 6 dB/oct slopes: the bands overlap more than an LR4 split would, so
//! compression is less surgical. For a master-bus glue compressor that is the
//! right trade.
//!
//! # Detector
//!
//! Per band, a **peak** follower (not RMS) over `max(|L|, |R|)` — stereo
//! linked, so compression never shifts the stereo image — with the shared
//! `ATTACK_S` / `RELEASE_S` one-pole times. Gain reduction is computed in dB
//! with a hard knee, and `MAKEUP` (linear) is applied after re-summing.

use crate::params::*;
use crate::smoother::{Smoother, DEFAULT_TAU};

use super::common::OnePole;
use super::Effect;

const LOW_XOVER_HZ: f32 = 120.0;
const HIGH_XOVER_HZ: f32 = 2_500.0;

pub struct MbComp {
    thresh_db: [Smoother; 3],
    ratio: Smoother,
    makeup: Smoother,
    attack_s: f32,
    release_s: f32,
    atk_c: f32,
    rel_c: f32,
    lp_low: [OnePole; 2],
    lp_high: [OnePole; 2],
    env: [f32; 3],
}

#[inline]
fn follower_coef(seconds: f32, sample_rate: f32) -> f32 {
    let t = seconds.max(1.0e-5) * sample_rate;
    1.0 - (-1.0 / t).exp()
}

impl MbComp {
    pub fn new(sample_rate: f32) -> Self {
        let mut c = MbComp {
            thresh_db: [
                Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
                Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
                Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            ],
            ratio: Smoother::new(sample_rate, DEFAULT_TAU, 1.0),
            makeup: Smoother::new(sample_rate, DEFAULT_TAU, 1.0),
            attack_s: 0.01,
            release_s: 0.12,
            atk_c: follower_coef(0.01, sample_rate),
            rel_c: follower_coef(0.12, sample_rate),
            lp_low: [OnePole::default(); 2],
            lp_high: [OnePole::default(); 2],
            env: [0.0; 3],
        };
        for ch in 0..2 {
            c.lp_low[ch].set_hz(LOW_XOVER_HZ, sample_rate);
            c.lp_high[ch].set_hz(HIGH_XOVER_HZ, sample_rate);
        }
        c
    }
}

impl Effect for MbComp {
    fn reset(&mut self) {
        for ch in 0..2 {
            self.lp_low[ch].reset();
            self.lp_high[ch].reset();
        }
        self.env = [0.0; 3];
    }

    fn apply_patch(&mut self, p: &[f32], sample_rate: f32, first: bool) {
        let t = [
            MBCOMP_THRESH_LOW_DB,
            MBCOMP_THRESH_MID_DB,
            MBCOMP_THRESH_HIGH_DB,
        ];
        for (i, idx) in t.iter().enumerate() {
            super::set(
                &mut self.thresh_db[i],
                super::fclamp(p[*idx], -80.0, 24.0),
                first,
            );
        }
        super::set(
            &mut self.ratio,
            super::fclamp(p[MBCOMP_RATIO], 1.0, 40.0),
            first,
        );
        super::set(
            &mut self.makeup,
            super::fclamp(p[MBCOMP_MAKEUP], 0.0, 16.0),
            first,
        );
        let a = super::fclamp(p[MBCOMP_ATTACK_S], 0.0001, 1.0);
        let r = super::fclamp(p[MBCOMP_RELEASE_S], 0.001, 4.0);
        if a != self.attack_s {
            self.attack_s = a;
            self.atk_c = follower_coef(a, sample_rate);
        }
        if r != self.release_s {
            self.release_s = r;
            self.rel_c = follower_coef(r, sample_rate);
        }
    }

    fn should_process(&self) -> bool {
        true
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], _sample_rate: f32) {
        let n = l.len();
        let mut makeup = self.makeup.block(n);
        let ratio = self.ratio.advance(n).max(1.0);
        let slope = 1.0 - 1.0 / ratio;
        let mut thresh_lin = [0.0f32; 3];
        for (i, t) in thresh_lin.iter_mut().enumerate() {
            *t = (10.0f32).powf(self.thresh_db[i].advance(n) / 20.0);
        }

        for i in 0..n {
            let (xl, xr) = (l[i], r[i]);
            let low_l = self.lp_low[0].process(xl);
            let low_r = self.lp_low[1].process(xr);
            let rest_l = xl - low_l;
            let rest_r = xr - low_r;
            let mid_l = self.lp_high[0].process(rest_l);
            let mid_r = self.lp_high[1].process(rest_r);
            let high_l = rest_l - mid_l;
            let high_r = rest_r - mid_r;

            let bands = [(low_l, low_r), (mid_l, mid_r), (high_l, high_r)];
            let mut sum_l = 0.0;
            let mut sum_r = 0.0;
            for (b, (bl, br)) in bands.iter().enumerate() {
                let peak = bl.abs().max(br.abs());
                let e = self.env[b];
                let c = if peak > e { self.atk_c } else { self.rel_c };
                let e = e + c * (peak - e);
                self.env[b] = e;

                let g = if e > thresh_lin[b] && slope > 0.0 {
                    let over_db = 20.0 * (e / thresh_lin[b]).log10();
                    (10.0f32).powf(-over_db * slope / 20.0)
                } else {
                    1.0
                };
                sum_l += bl * g;
                sum_r += br * g;
            }

            let mk = makeup.next();
            l[i] = sum_l * mk;
            r[i] = sum_r * mk;
        }
    }
}
