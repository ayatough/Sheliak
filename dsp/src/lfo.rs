//! Single LFO (SPEC §3: wave 0=sine 1=tri 2=saw 3=square, RATE_HZ, PHASE).
//!
//! The LFO is **per voice and retriggered at note-on**, starting from the
//! patch's `PHASE` offset: every note then hears the same modulation shape,
//! which is what makes a patch reproducible (and is required for the
//! determinism test). After the retrigger it free-runs at `RATE_HZ`.
//!
//! Tempo sync is handled on the TS side, which converts musical values to Hz
//! before writing `RATE_HZ` (SPEC §3).
//!
//! Output is bipolar, `-1..1`. It is read once per block (control rate) —
//! `advance(n)` moves the phase by exactly `n` samples, so splitting a render
//! quantum at event boundaries cannot change the result.

#[derive(Copy, Clone, Debug, Default)]
pub struct Lfo {
    phase: u32,
    inc: u32,
}

impl Lfo {
    /// Retriggers to the patch phase offset (0..1).
    #[inline]
    pub fn reset(&mut self, phase01: f32) {
        let p = phase01 - phase01.floor();
        self.phase = (p * 4_294_967_296.0) as u32;
    }

    #[inline]
    pub fn set_rate(&mut self, hz: f32, sample_rate: f32) {
        let hz = hz.clamp(0.0, sample_rate * 0.25);
        self.inc = (hz / sample_rate.max(1.0) * 4_294_967_296.0) as u32;
    }

    #[inline]
    pub fn advance(&mut self, n: usize) {
        self.phase = self.phase.wrapping_add(self.inc.wrapping_mul(n as u32));
    }

    /// Current bipolar value for the given wave id.
    #[inline]
    pub fn value(&self, wave: u32) -> f32 {
        let p = self.phase as f32 * (1.0 / 4_294_967_296.0);
        match wave {
            0 => (p * std::f32::consts::TAU).sin(),
            2 => 2.0 * p - 1.0,
            3 => {
                if p < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
            _ => 1.0 - 4.0 * ((p + 0.25).fract() - 0.5).abs(),
        }
    }
}
