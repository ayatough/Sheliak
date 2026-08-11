//! Zavalishin TPT/ZDF state-variable filter with drive and 2× oversampling
//! (REQUIREMENTS §4.2).
//!
//! Modes (SPEC §3): `0 = lp12`, `1 = lp24`, `2 = hp12`, `3 = bp12`.
//!
//! * **lp24** is two cascaded TPT lowpass stages at the same cutoff. The
//!   resonance is applied to the *first* stage only and the second stage runs
//!   critically damped (`k = 2`, Q = 0.5): cascading two resonant stages would
//!   square the peak and make the 24 dB mode wildly louder than the 12 dB one
//!   at the same `res` setting.
//! * **Oversampling**: the input is held (ZOH) and the filter runs two steps
//!   per output sample at `2·sr`; the two results are averaged. The average is
//!   a 2-tap FIR whose null sits at `sr`, which knocks down the images the
//!   saturator creates. Cutoff is prewarped for the oversampled rate:
//!   `g = tan(π·fc / (2·sr))`.
//! * **Drive**: `tanh` soft saturation in front of the filter,
//!   `y = tanh(x·g) / sqrt(g)` with `g = 1 + 4·drive`. Dividing by `sqrt(g)`
//!   (rather than `g`) keeps the output bounded by `1/sqrt(g) ≤ 1` while still
//!   letting the drive add loudness. At `drive = 0` the saturator is bypassed
//!   entirely, so a clean patch stays perfectly linear and generates no
//!   intermodulation products (this is what keeps the alias test honest).

/// Cutoff limits in Hz before prewarping.
pub const MIN_CUTOFF: f32 = 10.0;

#[derive(Copy, Clone, Debug, Default)]
pub struct Svf {
    s1: f32,
    s2: f32,
}

impl Svf {
    #[inline]
    pub fn reset(&mut self) {
        self.s1 = 0.0;
        self.s2 = 0.0;
    }

    /// One TPT step. `a1 = 1 / (1 + g·(g + k))`.
    #[inline(always)]
    pub fn step(&mut self, x: f32, g: f32, k: f32, a1: f32) -> (f32, f32, f32) {
        let hp = (x - (k + g) * self.s1 - self.s2) * a1;
        let v1 = g * hp;
        let bp = v1 + self.s1;
        self.s1 = bp + v1;
        let v2 = g * bp;
        let lp = v2 + self.s2;
        self.s2 = lp + v2;
        (lp, bp, hp)
    }
}

/// Per-sample coefficient set (cheap enough to rebuild per sample; `g` itself
/// is ramped linearly across the block by the caller).
#[derive(Copy, Clone, Debug)]
pub struct Coeffs {
    pub g: f32,
    pub k: f32,
    pub a1: f32,
    pub k2: f32,
    pub a12: f32,
    pub drive: f32,
    pub mode: u32,
}

/// Resonance mapping: `res` 0..1 → damping `k` 2.0 (Q = 0.5) .. 0.1 (Q = 10).
#[inline]
pub fn damping(res: f32) -> f32 {
    2.0 - 1.9 * res.clamp(0.0, 1.0)
}

/// Prewarped integrator gain for the 2× oversampled rate.
#[inline]
pub fn prewarp(cutoff_hz: f32, sample_rate: f32) -> f32 {
    let fc = cutoff_hz.clamp(MIN_CUTOFF, sample_rate * 0.45);
    (std::f32::consts::PI * fc / (2.0 * sample_rate)).tan()
}

impl Coeffs {
    #[inline]
    pub fn new(g: f32, res: f32, drive: f32, mode: u32) -> Self {
        let k = damping(res);
        let k2 = 2.0;
        Coeffs {
            g,
            k,
            a1: 1.0 / (1.0 + g * (g + k)),
            k2,
            a12: 1.0 / (1.0 + g * (g + k2)),
            drive,
            mode,
        }
    }

    /// Rebuilds the `g`-dependent terms after `g` was ramped.
    #[inline(always)]
    pub fn with_g(&self, g: f32) -> Self {
        Coeffs {
            g,
            k: self.k,
            a1: 1.0 / (1.0 + g * (g + self.k)),
            k2: self.k2,
            a12: 1.0 / (1.0 + g * (g + self.k2)),
            drive: self.drive,
            mode: self.mode,
        }
    }
}

#[inline(always)]
fn saturate(x: f32, drive: f32) -> f32 {
    if drive <= 0.0 {
        x
    } else {
        let g = 1.0 + 4.0 * drive;
        (x * g).tanh() * (1.0 / g.sqrt())
    }
}

/// Two cascaded SVF stages for one channel.
#[derive(Copy, Clone, Debug, Default)]
pub struct Channel {
    a: Svf,
    b: Svf,
}

impl Channel {
    #[inline]
    pub fn reset(&mut self) {
        self.a.reset();
        self.b.reset();
    }

    #[inline(always)]
    fn run(&mut self, x: f32, c: &Coeffs) -> f32 {
        let (lp, bp, hp) = self.a.step(x, c.g, c.k, c.a1);
        match c.mode {
            1 => {
                let (lp2, _, _) = self.b.step(lp, c.g, c.k2, c.a12);
                lp2
            }
            2 => hp,
            3 => bp,
            _ => lp,
        }
    }

    /// One output sample: saturate, run two oversampled steps, average.
    #[inline(always)]
    pub fn process(&mut self, x: f32, c: &Coeffs) -> f32 {
        let xs = saturate(x, c.drive);
        let y0 = self.run(xs, c);
        let y1 = self.run(xs, c);
        0.5 * (y0 + y1)
    }
}

/// Stereo pair of cascaded SVFs.
#[derive(Copy, Clone, Debug, Default)]
pub struct StereoFilter {
    pub l: Channel,
    pub r: Channel,
}

impl StereoFilter {
    pub fn reset(&mut self) {
        self.l.reset();
        self.r.reset();
    }
}
