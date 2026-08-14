//! Per-track FX chain (docs/architecture.md).
//!
//! Runs on one track's stereo bus, after its voices are summed and its master
//! gain applied — `MultiEngine` sums the tracks afterwards and adds nothing but
//! a soft-clip guard. "Master" here means the track's own bus, not the mix.
//! `FX_ORDER_BASE[0..8]` is a list of effect type ids giving the processing
//! order; `0` is an empty slot and each type may appear at most once
//! (duplicates after the first are ignored).
//!
//! # Allocation
//!
//! Every buffer — 2 s delay lines, the reverb's comb/allpass banks, the
//! predelay, the modulation lines — is sized from the sample rate and
//! allocated in [`Fx::new`], which only ever runs inside `init()`. Nothing in
//! `process()` allocates.
//!
//! # Parameter classes
//!
//! * **Continuous** (mix, drive, feedback, depth, gains, thresholds, times)
//!   are smoothed. `mix` and `makeup` ramp per sample so they can never
//!   zipper; the rest settle at block rate (≤2.7 ms), which is inaudible for
//!   coefficient-level parameters.
//! * **Discrete** (chain order, dist mode, phaser stages, ping-pong) switch
//!   immediately.
//! * **State resets**: when an effect becomes newly active — added to the
//!   chain, or its `MIX` moves off zero — its buffers are cleared, so a stale
//!   delay/reverb tail from minutes ago can never burst back in. Re-ordering
//!   the chain therefore may reset effect state; that is accepted MVP
//!   behaviour. Changing the reverb `SIZE` re-tunes its comb lengths in place,
//!   which can leave a brief transient in an existing tail.
//!
//! # Skipping work
//!
//! Empty slots cost nothing, and an effect whose `MIX` is zero (both current
//! and target) is skipped entirely — so a chain that is present but silent
//! does not burn CPU. An **empty chain does not touch the buffers at all**,
//! which makes FX bypass bit-exact.

pub mod common;
pub mod delay;
pub mod dist;
pub mod eq;
pub mod mbcomp;
pub mod mod_fx;
pub mod reverb;

use crate::params::*;
use crate::smoother::Smoother;

use delay::Delay;
use dist::Dist;
use eq::Eq;
use mbcomp::MbComp;
use mod_fx::{Chorus, Flanger, Phaser};
use reverb::Reverb;

#[inline]
pub(crate) fn fclamp(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        lo
    }
}

#[inline]
pub(crate) fn clamp_idx(v: f32, lo: f32, hi: f32) -> u32 {
    fclamp(v, lo, hi).round() as u32
}

#[inline]
pub(crate) fn set(s: &mut Smoother, v: f32, first: bool) {
    if first {
        s.snap(v);
    } else {
        s.set_target(v);
    }
}

pub struct Fx {
    sample_rate: f32,
    order: [u32; FX_SLOTS],
    /// Was this type active (in the chain and audible) at the last patch?
    /// Indexed by type id; slot 0 is unused.
    was_active: [bool; FX_TYPE_COUNT + 1],
    any: bool,
    dist: Dist,
    eq: Eq,
    chorus: Chorus,
    phaser: Phaser,
    flanger: Flanger,
    delay: Delay,
    reverb: Reverb,
    mbcomp: MbComp,
}

impl Fx {
    /// Allocates every FX buffer at its maximum size. `init()` only.
    pub fn new(sample_rate: f32) -> Self {
        Fx {
            sample_rate,
            order: [FX_NONE; FX_SLOTS],
            was_active: [false; FX_TYPE_COUNT + 1],
            any: false,
            dist: Dist::new(sample_rate),
            eq: Eq::new(sample_rate),
            chorus: Chorus::new(sample_rate),
            phaser: Phaser::new(sample_rate),
            flanger: Flanger::new(sample_rate),
            delay: Delay::new(sample_rate),
            reverb: Reverb::new(sample_rate),
            mbcomp: MbComp::new(sample_rate),
        }
    }

    fn params_for(p: &[f32; PARAM_COUNT], ty: u32) -> &[f32] {
        let base = FX_PARAMS_BASE + (ty as usize - 1) * FX_PARAMS_STRIDE;
        &p[base..base + FX_PARAMS_STRIDE]
    }

    pub fn apply_patch(&mut self, p: &[f32; PARAM_COUNT], first: bool) {
        // Decode the order, dropping duplicates (each type at most once).
        let mut order = [FX_NONE; FX_SLOTS];
        let mut seen = [false; FX_TYPE_COUNT + 1];
        let mut any = false;
        for (i, slot) in order.iter_mut().enumerate() {
            let ty = clamp_idx(p[FX_ORDER_BASE + i], 0.0, FX_TYPE_COUNT as f32);
            if ty == FX_NONE || seen[ty as usize] {
                continue;
            }
            seen[ty as usize] = true;
            *slot = ty;
            any = true;
        }
        self.order = order;
        self.any = any;

        let sr = self.sample_rate;
        self.dist
            .apply_patch(Self::params_for(p, FX_DIST), sr, first);
        self.eq.apply_patch(Self::params_for(p, FX_EQ), sr, first);
        self.chorus
            .apply_patch(Self::params_for(p, FX_CHORUS), sr, first);
        self.phaser
            .apply_patch(Self::params_for(p, FX_PHASER), sr, first);
        self.flanger
            .apply_patch(Self::params_for(p, FX_FLANGER), sr, first);
        self.delay
            .apply_patch(Self::params_for(p, FX_DELAY), sr, first);
        self.reverb
            .apply_patch(Self::params_for(p, FX_REVERB), sr, first);
        self.mbcomp
            .apply_patch(Self::params_for(p, FX_MBCOMP), sr, first);

        // Rising edge (absent/silent → active) clears stale buffers.
        for ty in 1..=FX_TYPE_COUNT as u32 {
            let active = seen[ty as usize] && self.wants(ty);
            if active && !self.was_active[ty as usize] {
                self.reset_type(ty);
            }
            self.was_active[ty as usize] = active;
        }
    }

    fn wants(&self, ty: u32) -> bool {
        match ty {
            FX_DIST => self.dist.should_process(),
            FX_EQ => self.eq.should_process(),
            FX_CHORUS => self.chorus.should_process(),
            FX_PHASER => self.phaser.should_process(),
            FX_FLANGER => self.flanger.should_process(),
            FX_DELAY => self.delay.should_process(),
            FX_REVERB => self.reverb.should_process(),
            FX_MBCOMP => self.mbcomp.should_process(),
            _ => false,
        }
    }

    fn reset_type(&mut self, ty: u32) {
        match ty {
            FX_DIST => self.dist.reset(),
            FX_EQ => self.eq.reset(),
            FX_CHORUS => self.chorus.reset(),
            FX_PHASER => self.phaser.reset(),
            FX_FLANGER => self.flanger.reset(),
            FX_DELAY => self.delay.reset(),
            FX_REVERB => self.reverb.reset(),
            FX_MBCOMP => self.mbcomp.reset(),
            _ => {}
        }
    }

    /// Is any effect in the chain? Used by the track's dormancy logic: a
    /// track with an empty chain has no tail to wait for.
    pub fn is_active(&self) -> bool {
        self.any
    }

    /// Clears every effect (used by `init()`-time construction and tests).
    pub fn reset_all(&mut self) {
        for ty in 1..=FX_TYPE_COUNT as u32 {
            self.reset_type(ty);
        }
    }

    /// Processes this track's stereo bus in place. No allocation.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if !self.any {
            return; // bit-exact bypass
        }
        let sr = self.sample_rate;
        for i in 0..FX_SLOTS {
            match self.order[i] {
                FX_DIST => {
                    if self.dist.should_process() {
                        self.dist.process(l, r, sr);
                    }
                }
                FX_EQ => {
                    if self.eq.should_process() {
                        self.eq.process(l, r, sr);
                    } else {
                        // Keep the biquad memory from going stale while flat.
                        self.eq.reset();
                    }
                }
                FX_CHORUS => {
                    if self.chorus.should_process() {
                        self.chorus.process(l, r, sr);
                    }
                }
                FX_PHASER => {
                    if self.phaser.should_process() {
                        self.phaser.process(l, r, sr);
                    }
                }
                FX_FLANGER => {
                    if self.flanger.should_process() {
                        self.flanger.process(l, r, sr);
                    }
                }
                FX_DELAY => {
                    if self.delay.should_process() {
                        self.delay.process(l, r, sr);
                    }
                }
                FX_REVERB => {
                    if self.reverb.should_process() {
                        self.reverb.process(l, r, sr);
                    }
                }
                FX_MBCOMP => self.mbcomp.process(l, r, sr),
                _ => {}
            }
        }
    }
}
