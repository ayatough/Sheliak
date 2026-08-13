//! Track: one independent instrument — patch decoding, parameter smoothing,
//! voice allocation/stealing, the block render loop and a private FX chain.
//!
//! Since v0.3 the engine is multi-track ([`crate::multi::MultiEngine`] owns
//! `MAX_TRACKS` of these). A `Track` deliberately does **not** own the
//! wavetables: they are immutable after `init()` and shared by every track, so
//! they are borrowed for the duration of [`Track::process`] instead of being
//! duplicated eight times (see `multi.rs` for the ownership rationale).
//!
//! This is the safe, target-independent API. `lib.rs` is nothing but a thin
//! `extern "C"` shell around it, so the whole DSP core can be driven from
//! native code (and is, by `tests/verify.rs`).
//!
//! # Parameter classes
//!
//! * **Continuous** (levels, morph, detune, spread, tune, cutoff, res, drive,
//!   key track, master gain) go through one-pole smoothers; cutoff and tuning
//!   are smoothed in the log domain. They apply to sounding voices at once.
//! * **Discrete** (polyphony, filter mode, LFO wave, mod routing, seed, glide)
//!   switch immediately — accepted MVP behaviour per docs/architecture.md. Switching the
//!   filter *mode* under a sounding note can step, since the SVF state means
//!   something different in each mode; everything else is click-free.
//! * **Latched at note-on** (table id, unison count, phase randomisation):
//!   rebuilding a unison stack under a sounding voice would splice in
//!   oscillators at unrelated phases, so those take effect on the next note.
//!   Glide is latched here too, and a note event may override the patch value
//!   for itself alone — see [`Track::note_on_ex`].
//!
//! # Determinism
//!
//! Given the same sample rate, the same parameter blocks and the same event
//! sequence *at the same sample offsets*, output is bit-identical (this is what
//! `tests/verify.rs::determinism_is_bit_exact` asserts, and what the worklet
//! guarantees because it derives event offsets from a sample counter).
//! Parameter smoothing is solved per block, so it is the event schedule — not
//! wall-clock timing or buffer sizes chosen at random — that the output
//! depends on.

use crate::envelope::EnvConfig;
use crate::fx::Fx;
use crate::params::*;
use crate::smoother::{Ramp, Smoother, DEFAULT_TAU};
use crate::tables::Table;
use crate::voice::{NoteStart, OscNoteCfg, State, Voice};

/// A note event's `glide_s` saying "use the patch's `voice.glide`". Any
/// negative value means this (docs/architecture.md); this is the spelling the
/// worklet sends.
pub const PATCH_GLIDE: f32 = -1.0;

/// Per-oscillator block snapshot handed to every voice.
#[derive(Copy, Clone, Debug, Default)]
pub struct OscBlock {
    pub enabled: bool,
    pub level: Ramp,
    pub morph: f32,
    pub detune_cents: f32,
    pub spread: f32,
    pub tune_cents: f32,
}

#[derive(Copy, Clone, Debug, Default)]
pub struct FilterBlock {
    pub mode: u32,
    /// Base cutoff in log2(Hz) at the start / end of the block.
    pub log2hz_start: f32,
    pub log2hz_end: f32,
    pub res: f32,
    pub drive: f32,
    pub keytrack: f32,
}

#[derive(Copy, Clone, Debug, Default)]
pub struct ModSlot {
    pub src: u32,
    pub dst: u32,
    pub amount: f32,
}

/// Everything a voice needs for one block.
pub struct BlockCtx<'a> {
    pub sample_rate: f32,
    pub tables: &'a [Table],
    pub osc: [OscBlock; 2],
    pub filter: FilterBlock,
    pub env_amp: EnvConfig,
    pub env_filter: EnvConfig,
    pub lfo_wave: u32,
    pub lfo_rate: f32,
    pub mods: [ModSlot; MOD_SLOTS],
    pub noise_level: Ramp,
}

#[derive(Copy, Clone, Debug, Default)]
struct BlockParams {
    osc: [OscBlock; 2],
    filter: FilterBlock,
    noise_level: Ramp,
}

/// Discrete (non-smoothed) oscillator configuration, latched at note-on.
#[derive(Copy, Clone, Debug)]
struct OscDiscrete {
    enabled: bool,
    table_id: usize,
    unison: usize,
    phase_random: bool,
}

impl Default for OscDiscrete {
    fn default() -> Self {
        OscDiscrete {
            enabled: true,
            table_id: TABLE_SAW as usize,
            unison: 1,
            phase_random: true,
        }
    }
}

struct OscSmooth {
    level: Smoother,
    morph: Smoother,
    detune: Smoother,
    spread: Smoother,
    tune: Smoother,
}

impl OscSmooth {
    fn new(sr: f32) -> Self {
        OscSmooth {
            level: Smoother::new(sr, DEFAULT_TAU, 1.0),
            morph: Smoother::new(sr, DEFAULT_TAU, 0.0),
            detune: Smoother::new(sr, DEFAULT_TAU, 0.0),
            spread: Smoother::new(sr, DEFAULT_TAU, 0.0),
            tune: Smoother::new(sr, DEFAULT_TAU, 0.0),
        }
    }
}

pub struct Track {
    sample_rate: f32,
    voices: Vec<Voice>,

    // ---- smoothed (continuous) parameters ----
    osc_s: [OscSmooth; 2],
    cutoff_log2: Smoother,
    res: Smoother,
    drive: Smoother,
    keytrack: Smoother,
    master: Smoother,
    noise_level: Smoother,

    // ---- discrete parameters ----
    osc_d: [OscDiscrete; 2],
    filter_mode: u32,
    polyphony: usize,
    glide_s: f32,
    seed: u32,
    lfo_wave: u32,
    lfo_rate: f32,
    lfo_phase: f32,
    env_amp: EnvConfig,
    env_filter: EnvConfig,
    mods: [ModSlot; MOD_SLOTS],
    noise_enabled: bool,
    noise_color: u32,

    /// Master FX chain (v0.2). Buffers allocated here, never in `process()`.
    fx: Fx,

    age: u64,
    last_note: Option<f32>,
    primed: bool,

    /// Consecutive silent samples with no voice activity; drives dormancy.
    quiet_samples: usize,
    /// Dormant tracks are skipped entirely by the mixer.
    dormant: bool,
}

/// A track output below this counts as silence for dormancy purposes
/// (-140 dBFS).
const SILENCE_EPS: f32 = 1.0e-7;
/// How long a track must stay silent before it is parked. Longer than the
/// maximum delay time (2 s) so a slow echo waiting between repeats can never
/// be frozen mid-tail.
const TAIL_HOLD_S: f32 = 2.5;
/// Without any FX there is no tail at all, so park almost immediately.
const DRY_HOLD_S: f32 = 0.05;

impl Track {
    /// Allocates voices and FX buffers. Called only from `init()`.
    pub fn new(sample_rate: f32) -> Self {
        let sr = if sample_rate.is_finite() && sample_rate > 1000.0 {
            sample_rate
        } else {
            48_000.0
        };
        let mut voices = Vec::with_capacity(MAX_VOICES);
        for _ in 0..MAX_VOICES {
            voices.push(Voice::default());
        }
        Track {
            sample_rate: sr,
            voices,
            osc_s: [OscSmooth::new(sr), OscSmooth::new(sr)],
            cutoff_log2: Smoother::new(sr, DEFAULT_TAU, 20_000.0f32.log2()),
            res: Smoother::new(sr, DEFAULT_TAU, 0.0),
            drive: Smoother::new(sr, DEFAULT_TAU, 0.0),
            keytrack: Smoother::new(sr, DEFAULT_TAU, 0.0),
            master: Smoother::new(sr, DEFAULT_TAU, 0.5),
            noise_level: Smoother::new(sr, DEFAULT_TAU, 0.0),
            osc_d: [
                OscDiscrete::default(),
                OscDiscrete {
                    enabled: false,
                    ..OscDiscrete::default()
                },
            ],
            filter_mode: 0,
            polyphony: 8,
            glide_s: 0.0,
            seed: 0,
            lfo_wave: 1,
            lfo_rate: 1.0,
            lfo_phase: 0.0,
            env_amp: EnvConfig::new(0.005, 0.2, 0.7, 0.12, sr),
            env_filter: EnvConfig::new(0.002, 0.4, 0.0, 0.1, sr),
            mods: [ModSlot::default(); MOD_SLOTS],
            noise_enabled: false,
            noise_color: 0,
            fx: Fx::new(sr),
            age: 0,
            last_note: None,
            primed: false,
            quiet_samples: 0,
            dormant: false,
        }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    /// Number of voices currently producing sound.
    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| !v.is_idle()).count()
    }

    /// Has a patch ever been applied? An unprimed track is completely inert.
    pub fn is_primed(&self) -> bool {
        self.primed
    }

    /// Parked: silent, no voices, and its FX tails have run out.
    pub fn is_dormant(&self) -> bool {
        self.dormant
    }

    /// Anything that can start sound again must wake the track first.
    #[inline]
    fn wake(&mut self) {
        self.dormant = false;
        self.quiet_samples = 0;
    }

    // ---------------------------------------------------------------- patch

    /// Decodes the parameter block. No allocation, callable while playing.
    pub fn apply_patch(&mut self, p: &[f32; PARAM_COUNT]) {
        let sr = self.sample_rate;
        let first = !self.primed;
        self.primed = true;
        self.wake();

        self.polyphony = (fclamp(p[P_POLYPHONY], 1.0, MAX_VOICES as f32).round()) as usize;
        self.glide_s = p[P_GLIDE_S].max(0.0);
        self.seed = f32_to_seed(p[P_SEED]);
        set(&mut self.master, fclamp(p[P_MASTER_GAIN], 0.0, 8.0), first);

        for (i, base) in [OSC_A_BASE, OSC_B_BASE].iter().enumerate() {
            let b = *base;
            self.osc_d[i].enabled = p[b + OSC_ENABLED] >= 0.5;
            self.osc_d[i].table_id =
                fclamp(p[b + OSC_TABLE_ID], 0.0, (TABLE_COUNT - 1) as f32).round() as usize;
            self.osc_d[i].unison =
                fclamp(p[b + OSC_UNISON], 1.0, MAX_UNISON as f32).round() as usize;
            self.osc_d[i].phase_random = p[b + OSC_PHASE_RANDOM] >= 0.5;
            let s = &mut self.osc_s[i];
            set(&mut s.level, fclamp(p[b + OSC_LEVEL], 0.0, 8.0), first);
            set(&mut s.morph, fclamp(p[b + OSC_MORPH], 0.0, 1.0), first);
            set(
                &mut s.detune,
                fclamp(p[b + OSC_DETUNE_CENTS], -200.0, 200.0),
                first,
            );
            set(&mut s.spread, fclamp(p[b + OSC_SPREAD], 0.0, 1.0), first);
            set(
                &mut s.tune,
                fclamp(p[b + OSC_TUNE_SEMI], -48.0, 48.0) * 100.0
                    + fclamp(p[b + OSC_TUNE_CENTS], -1200.0, 1200.0),
                first,
            );
        }

        self.filter_mode = fclamp(p[P_FILTER_MODE], 0.0, 3.0).round() as u32;
        let cutoff = fclamp(p[P_FILTER_CUTOFF_HZ], 10.0, sr * 0.45);
        set(&mut self.cutoff_log2, cutoff.log2(), first);
        set(&mut self.res, fclamp(p[P_FILTER_RES], 0.0, 1.0), first);
        set(&mut self.drive, fclamp(p[P_FILTER_DRIVE], 0.0, 1.0), first);
        set(
            &mut self.keytrack,
            fclamp(p[P_FILTER_KEYTRACK], 0.0, 1.0),
            first,
        );

        self.env_amp = EnvConfig::new(
            p[ENV_AMP_BASE + ENV_A].max(0.0),
            p[ENV_AMP_BASE + ENV_D].max(0.0),
            fclamp(p[ENV_AMP_BASE + ENV_S], 0.0, 1.0),
            p[ENV_AMP_BASE + ENV_R].max(0.0),
            sr,
        );
        self.env_filter = EnvConfig::new(
            p[ENV_FILTER_BASE + ENV_A].max(0.0),
            p[ENV_FILTER_BASE + ENV_D].max(0.0),
            fclamp(p[ENV_FILTER_BASE + ENV_S], 0.0, 1.0),
            p[ENV_FILTER_BASE + ENV_R].max(0.0),
            sr,
        );

        self.lfo_wave = fclamp(p[P_LFO_WAVE], 0.0, 3.0).round() as u32;
        self.lfo_rate = fclamp(p[P_LFO_RATE_HZ], 0.0, sr * 0.25);
        self.lfo_phase = p[P_LFO_PHASE];

        self.noise_enabled = p[NOISE_BASE + NOISE_ENABLED] >= 0.5;
        self.noise_color = fclamp(p[NOISE_BASE + NOISE_COLOR], 0.0, 1.0).round() as u32;
        set(
            &mut self.noise_level,
            fclamp(p[NOISE_BASE + NOISE_LEVEL], 0.0, 8.0),
            first,
        );

        for (i, slot) in self.mods.iter_mut().enumerate() {
            let b = MOD_BASE + i * MOD_STRIDE;
            slot.src = fclamp(p[b + MOD_SRC], 0.0, 4.0).round() as u32;
            slot.dst = fclamp(p[b + MOD_DST], 0.0, 5.0).round() as u32;
            slot.amount = if p[b + MOD_AMOUNT].is_finite() {
                p[b + MOD_AMOUNT]
            } else {
                0.0
            };
        }

        self.fx.apply_patch(p, first);
    }

    // ---------------------------------------------------------------- notes

    /// Starts a note the way the engine always has: the patch's `voice.glide`
    /// and a full retrigger.
    pub fn note_on(&mut self, note: f32, velocity: f32) {
        self.note_on_ex(note, velocity, PATCH_GLIDE, false);
    }

    /// The full note-on of the ABI (docs/workstreams.md §10). `glide_s` is a
    /// per-note glide time in seconds; [`PATCH_GLIDE`] — any negative or
    /// non-finite value — means "use the patch's `voice.glide`". `legato`
    /// bends the newest sounding voice to the new pitch instead of starting a
    /// note, so the amplitude envelope does not retrigger.
    ///
    /// Legato is monophonic per track: it takes over one voice, the newest one
    /// that is sounding and not yet released. With nothing to bend it falls
    /// back to an ordinary note-on, so the call is never silent.
    pub fn note_on_ex(&mut self, note: f32, velocity: f32, glide_s: f32, legato: bool) {
        if !note.is_finite() {
            return;
        }
        let note = note.clamp(-24.0, 144.0);
        self.wake();
        self.age = self.age.wrapping_add(1);
        let glide = self.glide_seconds(glide_s);

        if legato {
            if let Some(i) = self.newest_sounding() {
                let (age, samples) = (self.age, glide * self.sample_rate);
                self.voices[i].retarget(note, samples, age);
                self.last_note = Some(note);
                return;
            }
        }

        let ns = self.make_note_start(note, velocity, glide);
        self.last_note = Some(note);

        let busy = self
            .voices
            .iter()
            .filter(|v| !v.is_idle() || v.pending().is_some())
            .count();

        if busy < self.polyphony {
            if let Some(i) = self
                .voices
                .iter()
                .position(|v| v.is_idle() && v.pending().is_none())
            {
                let (sr, hz) = (self.sample_rate, self.lfo_rate);
                self.voices[i].start(&ns, sr, hz);
                return;
            }
        }

        // Steal: oldest releasing voice first, otherwise the oldest voice.
        if let Some(i) = self.pick_steal() {
            let sr = self.sample_rate;
            self.voices[i].begin_fade(sr, Some(ns));
        }
    }

    fn pick_steal(&self) -> Option<usize> {
        let mut best: Option<(usize, u64)> = None;
        let mut best_released: Option<(usize, u64)> = None;
        for (i, v) in self.voices.iter().enumerate() {
            if v.state != State::Active {
                continue;
            }
            if v.released && best_released.is_none_or(|(_, a)| v.age < a) {
                best_released = Some((i, v.age));
            }
            if best.is_none_or(|(_, a)| v.age < a) {
                best = Some((i, v.age));
            }
        }
        best_released.or(best).map(|(i, _)| i).or_else(|| {
            // Everything is already fading — reuse the oldest of those.
            self.voices
                .iter()
                .enumerate()
                .filter(|(_, v)| !v.is_idle())
                .min_by_key(|(_, v)| v.age)
                .map(|(i, _)| i)
        })
    }

    /// Resolves a note event's `glide_s` against the patch. A negative value is
    /// the documented "use the patch's `voice.glide`" sentinel; a non-finite one
    /// means the same, which is what a host that calls the export with the old
    /// three arguments produces (JS turns the missing float into `NaN`).
    #[inline]
    fn glide_seconds(&self, glide_s: f32) -> f32 {
        if glide_s.is_finite() && glide_s >= 0.0 {
            glide_s
        } else {
            self.glide_s
        }
    }

    /// Newest voice that is sounding and has not been released — the one a
    /// legato note-on bends.
    fn newest_sounding(&self) -> Option<usize> {
        self.voices
            .iter()
            .enumerate()
            .filter(|(_, v)| v.state == State::Active && !v.released)
            .max_by_key(|(_, v)| v.age)
            .map(|(i, _)| i)
    }

    fn make_note_start(&self, note: f32, velocity: f32, glide: f32) -> NoteStart {
        let start_cents = match self.last_note {
            Some(prev) if glide > 0.0 => (prev - 69.0) * 100.0,
            _ => (note - 69.0) * 100.0,
        };
        NoteStart {
            note,
            velocity: velocity.clamp(0.0, 1.0),
            age: self.age,
            seed: self.seed,
            start_cents,
            glide_samples: glide * self.sample_rate,
            lfo_phase: self.lfo_phase,
            osc: [
                OscNoteCfg {
                    table_id: self.osc_d[0].table_id,
                    unison: self.osc_d[0].unison,
                    phase_random: self.osc_d[0].phase_random,
                },
                OscNoteCfg {
                    table_id: self.osc_d[1].table_id,
                    unison: self.osc_d[1].unison,
                    phase_random: self.osc_d[1].phase_random,
                },
            ],
            noise_enabled: self.noise_enabled,
            noise_color: self.noise_color,
        }
    }

    pub fn note_off(&mut self, note: f32) {
        for v in self.voices.iter_mut() {
            v.note_off_matching(note);
        }
    }

    /// Fast-fade every sounding voice (docs/architecture.md: `all_notes_off`).
    pub fn all_notes_off(&mut self) {
        self.wake();
        let sr = self.sample_rate;
        for v in self.voices.iter_mut() {
            v.begin_fade(sr, None);
        }
        self.last_note = None;
    }

    // -------------------------------------------------------------- process

    /// Renders this track into `out_l` / `out_r` (equal length, ≤
    /// [`MAX_BLOCK`]), **overwriting** them. Allocation-free.
    ///
    /// Returns `false` if the track wrote nothing at all — it has never been
    /// patched, or it is dormant (silent, no voices, FX tails run out). The
    /// mixer then skips it entirely, so idle tracks cost a branch per block.
    /// `tables` is the shared, immutable wavetable set owned by the
    /// [`crate::multi::MultiEngine`].
    pub fn process(&mut self, tables: &[Table], out_l: &mut [f32], out_r: &mut [f32]) -> bool {
        let n = out_l.len().min(out_r.len()).min(MAX_BLOCK);
        if n == 0 || !self.primed || self.dormant {
            return false;
        }
        out_l[..n].fill(0.0);
        out_r[..n].fill(0.0);

        // Voices whose steal-fade completed last block start their note now.
        let (sr, hz) = (self.sample_rate, self.lfo_rate);
        for v in self.voices.iter_mut() {
            if v.state == State::Pending {
                if let Some(ns) = v.pending() {
                    v.start(&ns, sr, hz);
                } else {
                    v.state = State::Idle;
                }
            }
        }

        let bp = self.block_params(n);
        {
            let ctx = BlockCtx {
                sample_rate: self.sample_rate,
                tables,
                osc: bp.osc,
                filter: bp.filter,
                env_amp: self.env_amp,
                env_filter: self.env_filter,
                lfo_wave: self.lfo_wave,
                lfo_rate: self.lfo_rate,
                mods: self.mods,
                noise_level: bp.noise_level,
            };
            for v in self.voices.iter_mut() {
                v.process(&ctx, &mut out_l[..n], &mut out_r[..n]);
            }
        }

        let mut master = self.master.block(n);
        for i in 0..n {
            let g = master.next();
            out_l[i] *= g;
            out_r[i] *= g;
        }

        // Per-track FX chain runs after that track's master gain, so
        // delay/reverb tails keep ringing even when no voice is active.
        self.fx.process(&mut out_l[..n], &mut out_r[..n]);

        // ---- dormancy bookkeeping ----------------------------------------
        let busy = self
            .voices
            .iter()
            .any(|v| !v.is_idle() || v.pending().is_some());
        let loud = out_l[..n]
            .iter()
            .chain(out_r[..n].iter())
            .any(|v| v.abs() > SILENCE_EPS);
        if busy || loud {
            self.quiet_samples = 0;
        } else {
            self.quiet_samples += n;
            let hold = if self.fx.is_active() {
                TAIL_HOLD_S
            } else {
                DRY_HOLD_S
            };
            if self.quiet_samples as f32 >= hold * self.sample_rate {
                self.dormant = true;
            }
        }
        true
    }

    fn block_params(&mut self, n: usize) -> BlockParams {
        let mut osc = [OscBlock::default(); 2];
        for (i, ob) in osc.iter_mut().enumerate() {
            let s = &mut self.osc_s[i];
            *ob = OscBlock {
                enabled: self.osc_d[i].enabled,
                level: s.level.block(n),
                morph: s.morph.advance(n),
                detune_cents: s.detune.advance(n),
                spread: s.spread.advance(n),
                tune_cents: s.tune.advance(n),
            };
        }
        let log2hz_start = self.cutoff_log2.current();
        let log2hz_end = self.cutoff_log2.advance(n);
        BlockParams {
            osc,
            noise_level: self.noise_level.block(n),
            filter: FilterBlock {
                mode: self.filter_mode,
                log2hz_start,
                log2hz_end,
                res: self.res.advance(n),
                drive: self.drive.advance(n),
                keytrack: self.keytrack.advance(n),
            },
        }
    }

    /// Convenience for offline rendering of a bare track (tests): renders
    /// `out` in ≤128-sample blocks exactly the way the worklet would.
    pub fn render(&mut self, tables: &[Table], out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len().min(out_r.len());
        let mut i = 0;
        while i < n {
            let len = MAX_BLOCK.min(n - i);
            let (l, r) = (&mut out_l[i..i + len], &mut out_r[i..i + len]);
            if !self.process(tables, l, r) {
                l.fill(0.0);
                r.fill(0.0);
            }
            i += len;
        }
    }
}

#[inline]
fn fclamp(v: f32, lo: f32, hi: f32) -> f32 {
    if v.is_finite() {
        v.clamp(lo, hi)
    } else {
        lo
    }
}

#[inline]
fn set(s: &mut Smoother, v: f32, first: bool) {
    if first {
        s.snap(v);
    } else {
        s.set_target(v);
    }
}

/// The seed arrives as an integer stored in an f32 (docs/architecture.md).
#[inline]
fn f32_to_seed(v: f32) -> u32 {
    if !v.is_finite() {
        return 0;
    }
    let r = v.round();
    if r < 0.0 {
        (-r as u32).wrapping_neg()
    } else if r >= 4_294_967_296.0 {
        u32::MAX
    } else {
        r as u32
    }
}
