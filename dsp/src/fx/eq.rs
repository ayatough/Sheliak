//! 3-band EQ (FX_EQ): RBJ low shelf @120 Hz, peaking @MID_FREQ (Q 0.7),
//! high shelf @6 kHz — fixed corner frequencies per SPEC §3.
//!
//! Gains are smoothed and the biquad coefficients are rebuilt once per block
//! (≤2.7 ms), which is inaudible for shelf/peak gain moves and far cheaper
//! than per-sample coefficient updates. When all three gains sit at 0 dB the
//! EQ bypasses completely and resets its state, so an idle EQ in the chain is
//! bit-transparent.

use crate::params::{EQ_HIGH_DB, EQ_LOW_DB, EQ_MID_DB, EQ_MID_FREQ_HZ};
use crate::smoother::{Smoother, DEFAULT_TAU};

use super::common::{Biquad, BiquadCoeffs};

const LOW_HZ: f32 = 120.0;
const HIGH_HZ: f32 = 6_000.0;
const MID_Q: f32 = 0.7;

pub struct Eq {
    low_db: Smoother,
    mid_db: Smoother,
    high_db: Smoother,
    mid_hz: Smoother,
    /// `[band][channel]`
    state: [[Biquad; 2]; 3],
}

impl Eq {
    pub fn new(sample_rate: f32) -> Self {
        Eq {
            low_db: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            mid_db: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            high_db: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            mid_hz: Smoother::new(sample_rate, DEFAULT_TAU, 1_000.0),
            state: [[Biquad::default(); 2]; 3],
        }
    }

    pub fn reset(&mut self) {
        for band in self.state.iter_mut() {
            for ch in band.iter_mut() {
                ch.reset();
            }
        }
    }

    pub fn apply_patch(&mut self, p: &[f32], sample_rate: f32, first: bool) {
        super::set(&mut self.low_db, super::fclamp(p[EQ_LOW_DB], -24.0, 24.0), first);
        super::set(&mut self.mid_db, super::fclamp(p[EQ_MID_DB], -24.0, 24.0), first);
        super::set(
            &mut self.high_db,
            super::fclamp(p[EQ_HIGH_DB], -24.0, 24.0),
            first,
        );
        super::set(
            &mut self.mid_hz,
            super::fclamp(p[EQ_MID_FREQ_HZ], 40.0, sample_rate * 0.45).max(40.0),
            first,
        );
    }

    pub fn should_process(&self) -> bool {
        let flat = |s: &Smoother| s.current().abs() < 1.0e-4 && s.target().abs() < 1.0e-4;
        !(flat(&self.low_db) && flat(&self.mid_db) && flat(&self.high_db))
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        let n = l.len();
        let low = self.low_db.advance(n);
        let mid = self.mid_db.advance(n);
        let high = self.high_db.advance(n);
        let mid_hz = self.mid_hz.advance(n);

        let c = [
            BiquadCoeffs::low_shelf(LOW_HZ, low, sample_rate),
            BiquadCoeffs::peaking(mid_hz, mid, MID_Q, sample_rate),
            BiquadCoeffs::high_shelf(HIGH_HZ, high, sample_rate),
        ];

        for i in 0..n {
            let mut xl = l[i];
            let mut xr = r[i];
            for (band, coeffs) in c.iter().enumerate() {
                xl = self.state[band][0].process(xl, coeffs);
                xr = self.state[band][1].process(xr, coeffs);
            }
            l[i] = xl;
            r[i] = xr;
        }
    }
}
