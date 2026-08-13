//! Per-voice noise layer (docs/architecture.md: the Noise block).
//!
//! Mixed with the two oscillators **before** the filter, so the voice filter,
//! its drive and the amp envelope all act on the noise as well.
//!
//! # Determinism
//!
//! The generator is seeded exactly the way oscillator start phases are
//! (`rng::hash_stream`), from `(patch seed, "nois" stream tag, note number)`.
//! It therefore depends only on the patch and the note — never on how many
//! notes were played before, never on wall-clock time, and `apply_patch()`
//! cannot disturb a sounding voice. Replaying the same note reproduces the
//! same noise sample-for-sample, which is what the determinism test asserts.
//!
//! # Colours
//!
//! * `0 = white` — uniform in [-1, 1].
//! * `1 = pink` — Paul Kellett's "economy" 3-pole approximation of a −3 dB/oct
//!   filter (public domain, musicdsp.org), accurate to about ±0.3 dB from
//!   ~20 Hz to ~20 kHz.
//!
//! Both colours are scaled to the same RMS (that of uniform white noise,
//! `1/√3`), so switching colour is a timbre change and not a level jump.
//! [`PINK_NORM`] is the reciprocal of the Kellett filter's measured RMS gain
//! for uniform white input; `tests/verify.rs` asserts the two match within
//! 1 dB.

use crate::rng::{hash_stream, Xorshift32};

/// Stream tag mixed into the hash so the noise never correlates with the
/// oscillator phase streams. ASCII "nois".
pub const NOISE_STREAM: u32 = 0x6e6f_6973;

/// 1 / (RMS gain of the Kellett economy pink filter for uniform white input).
/// Measured over 200 k samples: the raw filter has an RMS gain of ≈3.0 for
/// uniform white in, so this lands pink at the same 1/√3 RMS as white.
const PINK_NORM: f32 = 0.3336;

#[derive(Copy, Clone, Debug)]
pub struct Noise {
    rng: Xorshift32,
    b0: f32,
    b1: f32,
    b2: f32,
    pink: bool,
}

impl Default for Noise {
    fn default() -> Self {
        Noise {
            rng: Xorshift32::new(0),
            b0: 0.0,
            b1: 0.0,
            b2: 0.0,
            pink: false,
        }
    }
}

impl Noise {
    /// Re-seeds deterministically for a note-on. `color`: 0 = white, 1 = pink.
    pub fn note_on(&mut self, seed: u32, note: f32, color: u32) {
        let note_key = (note * 16.0).round() as i32 as u32;
        self.rng = Xorshift32::new(hash_stream(seed, NOISE_STREAM, color, note_key));
        self.b0 = 0.0;
        self.b1 = 0.0;
        self.b2 = 0.0;
        self.pink = color >= 1;
    }

    /// Next sample. Named `next` to match the other per-sample generators in
    /// this crate; it is deliberately not an `Iterator` (that would cost an
    /// `Option` in the innermost audio loop).
    #[inline(always)]
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f32 {
        let white = self.rng.next_bipolar();
        if !self.pink {
            return white;
        }
        self.b0 = 0.997_65 * self.b0 + white * 0.099_046;
        self.b1 = 0.963_00 * self.b1 + white * 0.296_516_4;
        self.b2 = 0.570_00 * self.b2 + white * 1.052_691_3;
        (self.b0 + self.b1 + self.b2 + white * 0.184_8) * PINK_NORM
    }
}
