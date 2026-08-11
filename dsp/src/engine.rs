//! Engine: patch decoding, parameter smoothing, voice allocation/stealing and
//! the block render loop.
//!
//! This is the safe, target-independent API. `lib.rs` is nothing but a thin
//! `extern "C"` shell around it, so the whole DSP core can be driven from
//! native code (and is, by `tests/verify.rs`).

use crate::envelope::EnvConfig;
use crate::filter::prewarp;
use crate::params::*;
use crate::smoother::{Ramp, Smoother, DEFAULT_TAU};
use crate::tables::{self, Table};
use crate::voice::{NoteStart, OscNoteCfg, State, Voice};

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
    pub mods: [ModSlot; MOD_SLOTS],
}

#[derive(Copy, Clone, Debug, Default)]
struct BlockParams {
    osc: [OscBlock; 2],
    filter: FilterBlock,
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

pub struct Engine {
    sample_rate: f32,
    tables: Vec<Table>,
    voices: Vec<Voice>,

    // ---- smoothed (continuous) parameters ----
    osc_s: [OscSmooth; 2],
    cutoff_log2: Smoother,
    res: Smoother,
    drive: Smoother,
    keytrack: Smoother,
    master: Smoother,

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

    age: u64,
    last_note: Option<f32>,
    primed: bool,
}

impl Engine {
    /// Builds tables, mipmaps and voices. **The only allocating entry point.**
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
        Engine {
            sample_rate: sr,
            tables: tables::build_all(),
            voices,
            osc_s: [OscSmooth::new(sr), OscSmooth::new(sr)],
            cutoff_log2: Smoother::new(sr, DEFAULT_TAU, 20_000.0f32.log2()),
            res: Smoother::new(sr, DEFAULT_TAU, 0.0),
            drive: Smoother::new(sr, DEFAULT_TAU, 0.0),
            keytrack: Smoother::new(sr, DEFAULT_TAU, 0.0),
            master: Smoother::new(sr, DEFAULT_TAU, 0.5),
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
            age: 0,
            last_note: None,
            primed: false,
        }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    /// Number of voices currently producing sound.
    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| !v.is_idle()).count()
    }

    // ---------------------------------------------------------------- patch

    /// Decodes the parameter block. No allocation, callable while playing.
    pub fn apply_patch(&mut self, p: &[f32; PARAM_COUNT]) {
        let sr = self.sample_rate;
        let first = !self.primed;
        self.primed = true;

        self.polyphony = (fclamp(p[P_POLYPHONY], 1.0, MAX_VOICES as f32).round()) as usize;
        self.glide_s = p[P_GLIDE_S].max(0.0);
        self.seed = f32_to_seed(p[P_SEED]);
        set(&mut self.master, fclamp(p[P_MASTER_GAIN], 0.0, 8.0), first);

        for (i, base) in [OSC_A_BASE, OSC_B_BASE].iter().enumerate() {
            let b = *base;
            self.osc_d[i].enabled = p[b + OSC_ENABLED] >= 0.5;
            self.osc_d[i].table_id =
                fclamp(p[b + OSC_TABLE_ID], 0.0, (TABLE_COUNT - 1) as f32).round() as usize;
            self.osc_d[i].unison = fclamp(p[b + OSC_UNISON], 1.0, MAX_UNISON as f32).round() as usize;
            self.osc_d[i].phase_random = p[b + OSC_PHASE_RANDOM] >= 0.5;
            let s = &mut self.osc_s[i];
            set(&mut s.level, fclamp(p[b + OSC_LEVEL], 0.0, 8.0), first);
            set(&mut s.morph, fclamp(p[b + OSC_MORPH], 0.0, 1.0), first);
            set(&mut s.detune, fclamp(p[b + OSC_DETUNE_CENTS], -200.0, 200.0), first);
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
        set(&mut self.keytrack, fclamp(p[P_FILTER_KEYTRACK], 0.0, 1.0), first);

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
    }

    // ---------------------------------------------------------------- notes

    pub fn note_on(&mut self, note: f32, velocity: f32) {
        if !note.is_finite() {
            return;
        }
        let note = note.clamp(-24.0, 144.0);
        self.age = self.age.wrapping_add(1);
        let ns = self.make_note_start(note, velocity);
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
            if v.released {
                if best_released.is_none_or(|(_, a)| v.age < a) {
                    best_released = Some((i, v.age));
                }
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

    fn make_note_start(&self, note: f32, velocity: f32) -> NoteStart {
        let start_cents = match self.last_note {
            Some(prev) if self.glide_s > 0.0 => (prev - 69.0) * 100.0,
            _ => (note - 69.0) * 100.0,
        };
        NoteStart {
            note,
            velocity: velocity.clamp(0.0, 1.0),
            age: self.age,
            seed: self.seed,
            start_cents,
            glide_samples: self.glide_s * self.sample_rate,
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
        }
    }

    pub fn note_off(&mut self, note: f32) {
        for v in self.voices.iter_mut() {
            v.note_off_matching(note);
        }
    }

    /// Fast-fade every sounding voice (SPEC §2: 高速フェード付き全消音).
    pub fn all_notes_off(&mut self) {
        let sr = self.sample_rate;
        for v in self.voices.iter_mut() {
            v.begin_fade(sr, None);
        }
        self.last_note = None;
    }

    // -------------------------------------------------------------- process

    /// Renders into `out_l` / `out_r` (equal length, ≤ [`MAX_BLOCK`]).
    /// Allocation-free.
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len().min(out_r.len()).min(MAX_BLOCK);
        if n == 0 {
            return;
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
                tables: &self.tables,
                osc: bp.osc,
                filter: bp.filter,
                env_amp: self.env_amp,
                env_filter: self.env_filter,
                lfo_wave: self.lfo_wave,
                mods: self.mods,
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
    }

    fn block_params(&mut self, n: usize) -> BlockParams {
        let mut osc = [OscBlock::default(); 2];
        for i in 0..2 {
            let s = &mut self.osc_s[i];
            osc[i] = OscBlock {
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

    /// Convenience for offline rendering (tests): renders `out` in ≤128-sample
    /// blocks exactly the way the worklet would.
    pub fn render(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len().min(out_r.len());
        let mut i = 0;
        while i < n {
            let len = MAX_BLOCK.min(n - i);
            let (l, r) = (&mut out_l[i..i + len], &mut out_r[i..i + len]);
            self.process(l, r);
            i += len;
        }
    }

    /// Cutoff actually used for a note, after key tracking (test helper).
    pub fn debug_cutoff_g(&self, note: f32) -> f32 {
        let kt = self.keytrack.current() * (note - 60.0) * 100.0;
        let hz = (self.cutoff_log2.current() + kt / 1200.0).exp2();
        prewarp(hz, self.sample_rate)
    }

    /// Table registry (test helper).
    pub fn tables(&self) -> &[Table] {
        &self.tables
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

/// The seed arrives as an integer stored in an f32 (SPEC §3).
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
