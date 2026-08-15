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

/// What the chain needs from an effect, and the whole of it.
///
/// The parameter slice is the effect's own block — it never sees the rest of
/// the patch, and it never sees a name, a unit or a default. Those live on the
/// TypeScript side, where the DSL does; an effect here reads numbers out of
/// `p` by offset and nothing else. That is non-negotiable 1 restated one level
/// down: the chain does not know the DSL either.
///
/// `new()` is deliberately not on the trait. It runs inside `init()`, it is the
/// only place an effect may allocate, and it returns `Self` rather than a boxed
/// trait object, so it stays an inherent constructor.
pub(crate) trait Effect {
    /// Reads this effect's parameter block. Called while audio runs, so it
    /// moves smoother targets rather than values — `first` snaps instead.
    fn apply_patch(&mut self, p: &[f32], sample_rate: f32, first: bool);

    /// Would this effect change the signal? A chain that is present but silent
    /// costs nothing because of this.
    fn should_process(&self) -> bool;

    /// Clears buffers and filter memory. Called on the rising edge into
    /// audible, so a tail from minutes ago can never burst back in.
    fn reset(&mut self);

    /// Processes the stereo bus in place. **No allocation.**
    fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32);

    /// One turn in the chain. The default skips a silent effect entirely; an
    /// effect whose state goes stale while idle overrides this instead of the
    /// chain carrying a special case for it.
    fn run(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        if self.should_process() {
            self.process(l, r, sample_rate);
        }
    }
}

/// What an effect that is not in the chain reads. Its own slot no longer
/// exists, and silence is what the region held before it was written.
const SILENT_SLOT: [f32; FX_SLOT_STRIDE] = [0.0; FX_SLOT_STRIDE];

pub struct Fx {
    sample_rate: f32,
    order: [u32; FX_SLOTS],
    /// Was this type active (in the chain and audible) at the last patch?
    /// Indexed by type id; slot 0 is unused.
    was_active: [bool; FX_TYPE_COUNT + 1],
    any: bool,
    /// One effect per type, indexed by `type id - 1`. The array length is
    /// `FX_TYPE_COUNT`, so adding a type without registering it here does not
    /// compile — which is the point of holding them in an array rather than in
    /// eight named fields with four `match` statements over them.
    effects: [Box<dyn Effect>; FX_TYPE_COUNT],
}

impl Fx {
    /// Allocates every FX buffer at its maximum size. `init()` only — the
    /// boxes below are the last allocation the chain performs.
    pub fn new(sample_rate: f32) -> Self {
        // In type-id order: index i is type id i + 1.
        let effects: [Box<dyn Effect>; FX_TYPE_COUNT] = [
            Box::new(Dist::new(sample_rate)),
            Box::new(Eq::new(sample_rate)),
            Box::new(Chorus::new(sample_rate)),
            Box::new(Phaser::new(sample_rate)),
            Box::new(Flanger::new(sample_rate)),
            Box::new(Delay::new(sample_rate)),
            Box::new(Reverb::new(sample_rate)),
            Box::new(MbComp::new(sample_rate)),
        ];
        Fx {
            sample_rate,
            order: [FX_NONE; FX_SLOTS],
            was_active: [false; FX_TYPE_COUNT + 1],
            any: false,
            effects,
        }
    }

    /// The effect registered for a type id, or `None` for `FX_NONE` and for
    /// anything out of range. Out of range is ignored, never a panic.
    fn effect(&mut self, ty: u32) -> Option<&mut Box<dyn Effect>> {
        let index = (ty as usize).checked_sub(1)?;
        self.effects.get_mut(index)
    }

    pub fn apply_patch(&mut self, p: &[f32; PARAM_COUNT], first: bool) {
        // Decode the order, dropping duplicates (each type at most once), and
        // remember which slot each type landed in — that slot is where its
        // parameters are.
        let mut order = [FX_NONE; FX_SLOTS];
        let mut seen = [false; FX_TYPE_COUNT + 1];
        let mut slot_of = [None; FX_TYPE_COUNT + 1];
        let mut any = false;
        for (i, slot) in order.iter_mut().enumerate() {
            let ty = clamp_idx(p[FX_ORDER_BASE + i], 0.0, FX_TYPE_COUNT as f32);
            if ty == FX_NONE || seen[ty as usize] {
                continue;
            }
            seen[ty as usize] = true;
            slot_of[ty as usize] = Some(i);
            *slot = ty;
            any = true;
        }
        self.order = order;
        self.any = any;

        // Every effect reads a block, in type-id order, whether or not it is in
        // the chain: an effect that has just been dropped still has to land on
        // silence, or adding it back would snap from a value minutes old.
        //
        // A type in the chain reads the block of *its slot*; one that is not
        // reads zeros, which is what the writing side leaves in an unused slot
        // and therefore what it used to read from its own vacated region.
        let sr = self.sample_rate;
        for (index, effect) in self.effects.iter_mut().enumerate() {
            let slot = slot_of[index + 1];
            let block = match slot {
                Some(slot) => {
                    let base = FX_SLOT_BASE + slot * FX_SLOT_STRIDE;
                    &p[base..base + FX_SLOT_STRIDE]
                }
                None => &SILENT_SLOT[..],
            };
            effect.apply_patch(block, sr, first);
        }

        // Rising edge (absent/silent → active) clears stale buffers.
        for ty in 1..=FX_TYPE_COUNT as u32 {
            let in_chain = seen[ty as usize];
            let was_active = self.was_active[ty as usize];
            let Some(effect) = self.effect(ty) else {
                continue;
            };
            let active = in_chain && effect.should_process();
            if active && !was_active {
                effect.reset();
            }
            self.was_active[ty as usize] = active;
        }
    }

    /// Is any effect in the chain? Used by the track's dormancy logic: a
    /// track with an empty chain has no tail to wait for.
    pub fn is_active(&self) -> bool {
        self.any
    }

    /// Clears every effect (used by `init()`-time construction and tests).
    pub fn reset_all(&mut self) {
        for effect in self.effects.iter_mut() {
            effect.reset();
        }
    }

    /// Processes this track's stereo bus in place. No allocation.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        if !self.any {
            return; // bit-exact bypass
        }
        let sr = self.sample_rate;
        for i in 0..FX_SLOTS {
            let ty = self.order[i];
            if let Some(effect) = self.effect(ty) {
                effect.run(l, r, sr);
            }
        }
    }
}
