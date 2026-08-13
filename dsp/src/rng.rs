//! Deterministic, seeded pseudo-randomness.
//!
//! Requirement (docs/ja/requirements.md §7): every random value must come from the patch
//! seed. **No system / global entropy is ever used** — there is not a single
//! call to `std::time`, `rand`, or any OS facility in this crate.
//!
//! Two primitives are provided:
//!
//! * [`Xorshift32`] — a stateful xorshift generator, used where a *stream* of
//!   values is wanted.
//! * [`hash_stream`] — a *stateless* derivation of a 32-bit value from a seed
//!   plus a handful of integer coordinates (osc index, unison index, note...).
//!
//! The engine derives unison start phases with [`hash_stream`] rather than with
//! a running generator, so that a phase depends only on
//! `(seed, osc, unison, note)` and *not* on the history of previously played
//! notes. Consequences (documented deviation-free design choice):
//!
//! * `apply_patch()` (hot reload) can never disturb the phases of sounding
//!   voices, because phases are never re-derived for a sounding voice.
//! * Replaying the same note yields the same start phases — maximally
//!   deterministic, and what the determinism test in `tests/verify.rs` checks.

/// Murmur3 `fmix32` avalanche finalizer.
#[inline]
pub fn fmix32(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x85eb_ca6b);
    h ^= h >> 13;
    h = h.wrapping_mul(0xc2b2_ae35);
    h ^= h >> 16;
    h
}

/// Stateless derivation of an independent 32-bit stream value from a seed and
/// three integer coordinates. Every argument avalanches into every output bit.
#[inline]
pub fn hash_stream(seed: u32, a: u32, b: u32, c: u32) -> u32 {
    let mut h = seed ^ 0x9e37_79b9;
    h = fmix32(h ^ a.wrapping_mul(0x85eb_ca6b));
    h = fmix32(h ^ b.wrapping_mul(0xc2b2_ae35));
    h = fmix32(h ^ c.wrapping_mul(0x27d4_eb2f));
    h
}

/// Classic 32-bit xorshift (Marsaglia 13/17/5).
#[derive(Copy, Clone, Debug)]
pub struct Xorshift32(u32);

impl Xorshift32 {
    /// Seeds the generator; the all-zero state is avoided by mixing.
    #[inline]
    pub fn new(seed: u32) -> Self {
        let s = fmix32(seed ^ 0x6d2b_79f5);
        Xorshift32(if s == 0 { 0x1234_5678 } else { s })
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    /// Uniform in `[0, 1)`.
    #[inline]
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }

    /// Uniform in `[-1, 1)`.
    #[inline]
    pub fn next_bipolar(&mut self) -> f32 {
        self.next_f32() * 2.0 - 1.0
    }
}
