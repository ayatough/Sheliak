//! One-pole parameter smoothing (SPEC §2: "全パラメータを平滑化 (one-pole, ~5ms)").
//!
//! `apply_patch()` only ever moves *targets*; the audio thread walks the
//! current value toward the target. Continuous linear-domain parameters
//! (levels, resonance, drive, spread, master gain) are smoothed directly;
//! cutoff and tuning are smoothed in the log domain (log2 Hz / cents) by the
//! caller, so a 2× cutoff sweep is perceptually linear and never dips through
//! odd intermediate frequencies.
//!
//! Blocks are at most 128 samples, so instead of stepping the pole per sample
//! in every consumer we solve it in closed form once per block and hand out a
//! [`Ramp`] (start value + per-sample increment). Every voice then reads the
//! *same* per-sample values, which keeps the result independent of voice count
//! and therefore bit-deterministic.

/// Default smoothing time constant in seconds (~5 ms per SPEC §2).
pub const DEFAULT_TAU: f32 = 0.005;

/// A linear per-sample ramp across one block.
#[derive(Copy, Clone, Debug, Default)]
pub struct Ramp {
    pub v: f32,
    pub inc: f32,
}

impl Ramp {
    #[inline]
    pub fn constant(v: f32) -> Self {
        Ramp { v, inc: 0.0 }
    }

    /// Value at sample `i` of the block.
    #[inline]
    pub fn at(&self, i: usize) -> f32 {
        self.v + self.inc * i as f32
    }

    /// Value at the block start, then step forward one sample.
    ///
    /// Deliberately named `next` even though this is not an `Iterator`: it is
    /// the innermost audio-loop call and must stay a trivially inlinable
    /// two-instruction step.
    #[inline]
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f32 {
        let v = self.v;
        self.v += self.inc;
        v
    }
}

#[derive(Copy, Clone, Debug)]
pub struct Smoother {
    current: f32,
    target: f32,
    coef: f32,
}

impl Smoother {
    pub fn new(sample_rate: f32, tau: f32, init: f32) -> Self {
        let coef = (-1.0 / (tau.max(1.0e-5) * sample_rate.max(1.0))).exp();
        Smoother {
            current: init,
            target: init,
            coef,
        }
    }

    #[inline]
    pub fn set_target(&mut self, v: f32) {
        self.target = v;
    }

    /// Jump immediately (used at `init()` and for the very first patch).
    #[inline]
    pub fn snap(&mut self, v: f32) {
        self.current = v;
        self.target = v;
    }

    #[inline]
    pub fn current(&self) -> f32 {
        self.current
    }

    #[inline]
    pub fn target(&self) -> f32 {
        self.target
    }

    /// Advance `n` samples and return the ramp covering the block.
    pub fn block(&mut self, n: usize) -> Ramp {
        let start = self.current;
        if n == 0 {
            return Ramp::constant(start);
        }
        let d = start - self.target;
        // |d| below the f32 denormal-ish floor: park exactly on target so the
        // smoother settles bit-exactly instead of creeping forever.
        if d.abs() <= 1.0e-9 {
            self.current = self.target;
            return Ramp::constant(self.target);
        }
        let end = self.target + d * self.coef.powi(n as i32);
        self.current = end;
        Ramp {
            v: start,
            inc: (end - start) / n as f32,
        }
    }

    /// Advance `n` samples, returning only the end value (block-rate params).
    pub fn advance(&mut self, n: usize) -> f32 {
        self.block(n);
        self.current
    }
}
