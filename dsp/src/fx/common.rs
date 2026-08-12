//! Shared building blocks for the master FX chain.
//!
//! Everything here is allocation-free after construction: delay lines size
//! themselves from the sample rate in `Fx::new()` (called from `init()`) and
//! only ever write in place afterwards.

use crate::tables::hermite;

/// Fractional-delay ring buffer.
///
/// `read(d)` returns the sample written `d` samples ago (`d = 1` is the most
/// recent write), interpolated with the same 4-point Hermite kernel the
/// oscillator uses, so modulated delays (chorus/flanger/delay-time changes)
/// stay clean instead of gaining the gritty high end linear interpolation
/// gives at large modulation depths.
pub struct DelayLine {
    buf: Vec<f32>,
    write: usize,
}

impl DelayLine {
    pub fn new(max_samples: usize) -> Self {
        DelayLine {
            buf: vec![0.0; max_samples.max(8)],
            write: 0,
        }
    }

    pub fn clear(&mut self) {
        self.buf.fill(0.0);
        self.write = 0;
    }

    pub fn capacity(&self) -> usize {
        self.buf.len()
    }

    /// Longest delay this line can serve, in samples.
    pub fn max_delay(&self) -> f32 {
        (self.buf.len() - 4) as f32
    }

    #[inline(always)]
    pub fn write(&mut self, x: f32) {
        self.buf[self.write] = x;
        self.write += 1;
        if self.write == self.buf.len() {
            self.write = 0;
        }
    }

    #[inline(always)]
    fn tap(&self, back: usize) -> f32 {
        let len = self.buf.len();
        let mut p = self.write + len - back;
        if p >= len {
            p -= len;
        }
        self.buf[p]
    }

    /// Interpolated read, `d` in samples (clamped into the usable range).
    #[inline(always)]
    pub fn read(&self, d: f32) -> f32 {
        let d = if d.is_finite() {
            d.clamp(2.0, self.max_delay())
        } else {
            2.0
        };
        let i = d.floor();
        let frac = d - i;
        let i = i as usize;
        // Going further back in time = larger `back`, so y1/y2 straddle `d`.
        let y0 = self.tap(i - 1);
        let y1 = self.tap(i);
        let y2 = self.tap(i + 1);
        let y3 = self.tap(i + 2);
        hermite(y0, y1, y2, y3, frac)
    }

    /// Non-interpolated read (integer delay), used by the reverb combs.
    #[inline(always)]
    pub fn read_int(&self, d: usize) -> f32 {
        self.tap(d.clamp(1, self.buf.len() - 1))
    }
}

/// One-pole lowpass, used for tone controls and feedback damping.
#[derive(Copy, Clone, Debug, Default)]
pub struct OnePole {
    z: f32,
    a: f32,
}

impl OnePole {
    pub fn set_hz(&mut self, hz: f32, sample_rate: f32) {
        let f = hz.clamp(1.0, sample_rate * 0.49);
        self.a = 1.0 - (-std::f32::consts::TAU * f / sample_rate).exp();
    }

    #[inline]
    pub fn set_coef(&mut self, a: f32) {
        self.a = a.clamp(0.0, 1.0);
    }

    pub fn reset(&mut self) {
        self.z = 0.0;
    }

    #[inline(always)]
    pub fn process(&mut self, x: f32) -> f32 {
        self.z += self.a * (x - self.z);
        self.z
    }
}

/// DC blocker (one-pole/one-zero highpass at ~20 Hz).
///
/// Asymmetric or folding waveshapers can rectify a signal into a real DC
/// offset; left alone that eats headroom and shows up in the DC test.
#[derive(Copy, Clone, Debug, Default)]
pub struct DcBlock {
    x1: f32,
    y1: f32,
    r: f32,
}

impl DcBlock {
    pub fn set_sample_rate(&mut self, sample_rate: f32) {
        self.r = 1.0 - std::f32::consts::TAU * 20.0 / sample_rate.max(1.0);
    }

    pub fn reset(&mut self) {
        self.x1 = 0.0;
        self.y1 = 0.0;
    }

    #[inline(always)]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = x - self.x1 + self.r * self.y1;
        self.x1 = x;
        self.y1 = y;
        y
    }
}

/// RBJ biquad coefficients (normalised by `a0`).
#[derive(Copy, Clone, Debug)]
pub struct BiquadCoeffs {
    pub b0: f32,
    pub b1: f32,
    pub b2: f32,
    pub a1: f32,
    pub a2: f32,
}

impl Default for BiquadCoeffs {
    fn default() -> Self {
        BiquadCoeffs {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
        }
    }
}

impl BiquadCoeffs {
    fn norm(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        let inv = 1.0 / a0;
        BiquadCoeffs {
            b0: b0 * inv,
            b1: b1 * inv,
            b2: b2 * inv,
            a1: a1 * inv,
            a2: a2 * inv,
        }
    }

    /// RBJ low shelf. `gain_db` at DC, `slope` = 1 (no overshoot).
    pub fn low_shelf(freq: f32, gain_db: f32, sample_rate: f32) -> Self {
        let a = (10.0f32).powf(gain_db / 40.0);
        let w = std::f32::consts::TAU * freq.clamp(10.0, sample_rate * 0.45) / sample_rate;
        let (sw, cw) = (w.sin(), w.cos());
        // RBJ shelf with slope S = 1: alpha = sin(w)/2 · sqrt(2).
        let alpha = sw * 0.5 * std::f32::consts::SQRT_2;
        let tsa = 2.0 * a.sqrt() * alpha;
        Self::norm(
            a * ((a + 1.0) - (a - 1.0) * cw + tsa),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cw),
            a * ((a + 1.0) - (a - 1.0) * cw - tsa),
            (a + 1.0) + (a - 1.0) * cw + tsa,
            -2.0 * ((a - 1.0) + (a + 1.0) * cw),
            (a + 1.0) + (a - 1.0) * cw - tsa,
        )
    }

    /// RBJ high shelf.
    pub fn high_shelf(freq: f32, gain_db: f32, sample_rate: f32) -> Self {
        let a = (10.0f32).powf(gain_db / 40.0);
        let w = std::f32::consts::TAU * freq.clamp(10.0, sample_rate * 0.45) / sample_rate;
        let (sw, cw) = (w.sin(), w.cos());
        let alpha = sw * 0.5 * std::f32::consts::SQRT_2;
        let tsa = 2.0 * a.sqrt() * alpha;
        Self::norm(
            a * ((a + 1.0) + (a - 1.0) * cw + tsa),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cw),
            a * ((a + 1.0) + (a - 1.0) * cw - tsa),
            (a + 1.0) - (a - 1.0) * cw + tsa,
            2.0 * ((a - 1.0) - (a + 1.0) * cw),
            (a + 1.0) - (a - 1.0) * cw - tsa,
        )
    }

    /// RBJ peaking EQ.
    pub fn peaking(freq: f32, gain_db: f32, q: f32, sample_rate: f32) -> Self {
        let a = (10.0f32).powf(gain_db / 40.0);
        let w = std::f32::consts::TAU * freq.clamp(10.0, sample_rate * 0.45) / sample_rate;
        let (sw, cw) = (w.sin(), w.cos());
        let alpha = sw / (2.0 * q.max(0.05));
        Self::norm(
            1.0 + alpha * a,
            -2.0 * cw,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cw,
            1.0 - alpha / a,
        )
    }
}

/// Transposed direct form II state (one per channel).
#[derive(Copy, Clone, Debug, Default)]
pub struct Biquad {
    z1: f32,
    z2: f32,
}

impl Biquad {
    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    #[inline(always)]
    pub fn process(&mut self, x: f32, c: &BiquadCoeffs) -> f32 {
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        y
    }
}

/// First-order allpass (phaser stage). `a` is the coefficient derived from the
/// break frequency by [`allpass_coef`].
#[derive(Copy, Clone, Debug, Default)]
pub struct Allpass1 {
    z: f32,
}

impl Allpass1 {
    pub fn reset(&mut self) {
        self.z = 0.0;
    }

    #[inline(always)]
    pub fn process(&mut self, x: f32, a: f32) -> f32 {
        let y = a * x + self.z;
        self.z = x - a * y;
        y
    }
}

/// Coefficient of a first-order allpass with its 90° point at `freq`.
#[inline]
pub fn allpass_coef(freq: f32, sample_rate: f32) -> f32 {
    let t = (std::f32::consts::PI * freq.clamp(20.0, sample_rate * 0.45) / sample_rate).tan();
    (t - 1.0) / (t + 1.0)
}

/// Free-running LFO for the modulation effects.
///
/// Never reset after `init()` (SPEC §3: FX の LFO は init 起点のフリーラン), so
/// the chorus/flanger/phaser keep a continuous sweep across notes and patch
/// edits. Determinism holds because the phase advances by exactly one step per
/// rendered sample.
#[derive(Copy, Clone, Debug, Default)]
pub struct FxLfo {
    phase: u32,
    inc: u32,
}

impl FxLfo {
    pub fn set_rate(&mut self, hz: f32, sample_rate: f32) {
        let hz = hz.clamp(0.0, 40.0);
        self.inc = (hz / sample_rate * 4_294_967_296.0) as u32;
    }

    /// Advances one sample and returns the phase *before* the step.
    #[inline(always)]
    pub fn step(&mut self) -> u32 {
        let p = self.phase;
        self.phase = self.phase.wrapping_add(self.inc);
        p
    }
}

/// Bipolar sine of a `u32` phase, with an optional phase offset (turns).
#[inline(always)]
pub fn phase_sin(phase: u32, offset: f32) -> f32 {
    let p = phase as f32 * (1.0 / 4_294_967_296.0) + offset;
    (p * std::f32::consts::TAU).sin()
}

/// Soft clipper that is **exactly** the identity below `knee` (the input is
/// returned untouched, bit for bit), then bends smoothly — C1-continuous at
/// the knee, since `d/du tanh(u) = 1` at `u = 0` — and asymptotes at `limit`
/// without ever reaching it.
#[inline(always)]
pub fn soft_clip(x: f32, knee: f32, limit: f32) -> f32 {
    let a = x.abs();
    if a <= knee {
        return x;
    }
    let over = limit - knee;
    let y = knee + over * ((a - knee) / over).tanh();
    if x < 0.0 {
        -y
    } else {
        y
    }
}

/// Safety limiter for feedback paths: linear below `0.6·limit`, so ordinary
/// signal levels pass through untouched and delay/flanger repeats stay clean.
#[inline(always)]
pub fn soft_limit(x: f32, limit: f32) -> f32 {
    soft_clip(x, limit * 0.6, limit)
}
