//! One polyphonic voice: 2 wavetable oscillators (≤7 unison each, stereo) →
//! mix → TPT SVF → amp envelope (docs/ja/requirements.md §4.2).
//!
//! Modulation is evaluated once per block (≤128 samples ≈ 2.7 ms). Everything
//! that would zipper at that rate is ramped per sample instead: the filter
//! integrator gain `g`, the amp modulation and all smoothed patch parameters.
//! Morph and pitch modulation stay at block rate — they retune the mip/frame
//! selection, which cannot be interpolated cheaply, and 2.7 ms steps in timbre
//! are inaudible.

use crate::engine::{BlockCtx, ModSlot};
use crate::envelope::Env;
use crate::filter::{prewarp, Coeffs, StereoFilter};
use crate::lfo::Lfo;
use crate::noise::Noise;
use crate::oscillator::Osc;
use crate::params::{
    DST_AMP, DST_FILTER_CUTOFF, DST_OSC1_MORPH, DST_OSC2_MORPH, DST_PITCH, MAX_BLOCK,
};
use crate::smoother::Ramp;

/// Fixed headroom applied to every voice before the master gain, so that a
/// stack of unison voices does not clip on its own (docs/syntax.md keeps the default
/// master gain at 0.5 for the same reason).
pub const VOICE_HEADROOM: f32 = 0.5;

/// Steal / all-notes-off fade length (docs/ja/requirements.md §4.3: 1-2 ms).
pub const STEAL_FADE_S: f32 = 0.0015;

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum State {
    Idle,
    Active,
    /// Fading out for a steal or `all_notes_off()`.
    Fading,
    /// Fade finished, waiting for the engine to start `pending` next block.
    Pending,
}

/// Per-oscillator discrete configuration, latched at note-on.
#[derive(Copy, Clone, Debug, Default)]
pub struct OscNoteCfg {
    pub table_id: usize,
    pub unison: usize,
    pub phase_random: bool,
}

/// Everything the engine hands a voice to begin a note.
#[derive(Copy, Clone, Debug, Default)]
pub struct NoteStart {
    pub note: f32,
    pub velocity: f32,
    pub age: u64,
    pub seed: u32,
    /// Pitch (cents relative to A4) the note starts from — differs from the
    /// note's own pitch only when glide is active.
    pub start_cents: f32,
    /// Glide length in samples (0 = instant).
    pub glide_samples: f32,
    pub lfo_phase: f32,
    pub osc: [OscNoteCfg; 2],
    /// Noise layer, latched at note-on like the oscillator table id.
    pub noise_enabled: bool,
    pub noise_color: u32,
}

#[derive(Copy, Clone, Debug, Default)]
struct ModOut {
    cutoff_cents: f32,
    morph: [f32; 2],
    pitch_cents: f32,
    amp: f32,
}

pub struct Voice {
    pub state: State,
    pub note: f32,
    pub velocity: f32,
    pub age: u64,
    pub released: bool,
    pub seed: u32,

    osc: [Osc; 2],
    noise: Noise,
    noise_on: bool,
    env_amp: Env,
    env_flt: Env,
    lfo: Lfo,
    filt: StereoFilter,

    /// Current pitch in cents relative to A4 (glide target = note pitch).
    pitch_cents: f32,
    target_cents: f32,
    glide_inc: f32,

    fade: f32,
    fade_inc: f32,
    pending: Option<NoteStart>,
    /// The queued note received its note-off before it ever started.
    pending_released: bool,

    prev_mod: ModOut,

    scratch_l: [f32; MAX_BLOCK],
    scratch_r: [f32; MAX_BLOCK],
}

impl Default for Voice {
    fn default() -> Self {
        Voice {
            state: State::Idle,
            note: 0.0,
            velocity: 0.0,
            age: 0,
            released: false,
            seed: 0,
            osc: [Osc::default(), Osc::default()],
            noise: Noise::default(),
            noise_on: false,
            env_amp: Env::default(),
            env_flt: Env::default(),
            lfo: Lfo::default(),
            filt: StereoFilter::default(),
            pitch_cents: 0.0,
            target_cents: 0.0,
            glide_inc: 0.0,
            fade: 1.0,
            fade_inc: 0.0,
            pending: None,
            pending_released: false,
            prev_mod: ModOut::default(),
            scratch_l: [0.0; MAX_BLOCK],
            scratch_r: [0.0; MAX_BLOCK],
        }
    }
}

#[inline]
fn note_cents(note: f32) -> f32 {
    (note - 69.0) * 100.0
}

impl Voice {
    pub fn is_idle(&self) -> bool {
        self.state == State::Idle
    }

    pub fn pending(&self) -> Option<NoteStart> {
        self.pending
    }

    /// Starts a note immediately on this voice (the voice must be silent).
    pub fn start(&mut self, ns: &NoteStart, sample_rate: f32, lfo_hz: f32) {
        self.state = State::Active;
        self.note = ns.note;
        self.velocity = ns.velocity.clamp(0.0, 1.0);
        self.age = ns.age;
        self.released = false;
        self.seed = ns.seed;
        self.pending = None;
        self.fade = 1.0;
        self.fade_inc = 0.0;

        self.target_cents = note_cents(ns.note);
        self.pitch_cents = ns.start_cents;
        self.glide_inc = if ns.glide_samples > 0.5 {
            (self.target_cents - self.pitch_cents) / ns.glide_samples
        } else {
            self.pitch_cents = self.target_cents;
            0.0
        };

        for (i, o) in self.osc.iter_mut().enumerate() {
            let c = ns.osc[i];
            o.note_on(
                ns.seed,
                i as u32,
                ns.note,
                c.unison,
                c.table_id,
                c.phase_random,
            );
        }

        self.noise_on = ns.noise_enabled;
        if self.noise_on {
            self.noise.note_on(ns.seed, ns.note, ns.noise_color);
        }

        self.env_amp.kill();
        self.env_flt.kill();
        self.env_amp.note_on();
        self.env_flt.note_on();
        self.lfo.reset(ns.lfo_phase);
        self.lfo.set_rate(lfo_hz, sample_rate);
        self.filt.reset();
        self.prev_mod = ModOut::default();

        if self.pending_released {
            self.pending_released = false;
            self.note_off();
        }
    }

    /// Bends a sounding voice to a new pitch without starting a note: the
    /// oscillator phases, both envelopes, the filter state and the LFO all
    /// carry on untouched. This is what a legato `note_on` does
    /// (docs/workstreams.md §10) — a glissando is one note, not two.
    ///
    /// Velocity is deliberately *not* updated. It scales the per-sample gain
    /// and feeds the mod matrix, so changing it mid-note would step both; the
    /// slide keeps the expression of the note it started from.
    pub fn retarget(&mut self, note: f32, glide_samples: f32, age: u64) {
        self.note = note;
        self.age = age;
        self.target_cents = note_cents(note);
        self.glide_inc = if glide_samples > 0.5 {
            (self.target_cents - self.pitch_cents) / glide_samples
        } else {
            self.pitch_cents = self.target_cents;
            0.0
        };
    }

    pub fn note_off(&mut self) {
        if self.state == State::Active {
            self.released = true;
            self.env_amp.note_off();
            self.env_flt.note_off();
        }
    }

    /// Releases this voice if it is playing `note`. A note-off that arrives
    /// while a stolen voice is still fading is remembered and applied as soon
    /// as the queued note starts, so a very short note can never hang.
    pub fn note_off_matching(&mut self, note: f32) {
        if self.state == State::Active && !self.released && (self.note - note).abs() < 0.01 {
            self.note_off();
        }
        if let Some(p) = &self.pending {
            if (p.note - note).abs() < 0.01 {
                self.pending_released = true;
            }
        }
    }

    /// Begins the fast fade-out. `pending` is started by the engine once the
    /// fade completes (at most one block later, ≈2.7 ms — click-free, and the
    /// new note is only a few samples late).
    pub fn begin_fade(&mut self, sample_rate: f32, pending: Option<NoteStart>) {
        self.pending = pending;
        self.pending_released = false;
        if self.state == State::Idle {
            self.state = if pending.is_some() {
                State::Pending
            } else {
                State::Idle
            };
            return;
        }
        self.state = State::Fading;
        let samples = (STEAL_FADE_S * sample_rate).max(1.0);
        self.fade_inc = 1.0 / samples;
    }

    fn eval_mods(&self, ctx: &BlockCtx, slots: &[ModSlot]) -> ModOut {
        let mut m = ModOut::default();
        let env_f = self.env_flt.level;
        let env_a = self.env_amp.level;
        let lfo = self.lfo.value(ctx.lfo_wave);
        for s in slots {
            let src = match s.src {
                1 => env_f,
                2 => env_a,
                3 => lfo,
                4 => self.velocity,
                _ => continue,
            };
            let v = src * s.amount;
            match s.dst {
                DST_FILTER_CUTOFF => m.cutoff_cents += v,
                DST_OSC1_MORPH => m.morph[0] += v,
                DST_OSC2_MORPH => m.morph[1] += v,
                DST_PITCH => m.pitch_cents += v,
                DST_AMP => m.amp += v,
                _ => {}
            }
        }
        m
    }

    /// Renders `n` samples, accumulating into the engine's stereo output.
    pub fn process(&mut self, ctx: &BlockCtx, out_l: &mut [f32], out_r: &mut [f32]) {
        if self.state == State::Idle || self.state == State::Pending {
            return;
        }
        let n = out_l.len().min(out_r.len()).min(MAX_BLOCK);
        if n == 0 {
            return;
        }

        // Patch edits to the LFO rate must reach sounding voices too.
        self.lfo.set_rate(ctx.lfo_rate, ctx.sample_rate);

        let m = self.eval_mods(ctx, &ctx.mods);
        let prev = self.prev_mod;

        // ---- oscillators -------------------------------------------------
        let scratch_l = &mut self.scratch_l[..n];
        let scratch_r = &mut self.scratch_r[..n];
        scratch_l.fill(0.0);
        scratch_r.fill(0.0);

        let base_pitch = self.pitch_cents + m.pitch_cents;
        for i in 0..2 {
            let ob = &ctx.osc[i];
            if !ob.enabled {
                continue;
            }
            let table = &ctx.tables[self.osc[i].table_id.min(ctx.tables.len() - 1)];
            let morph = (ob.morph + m.morph[i]).clamp(0.0, 1.0);
            self.osc[i].configure(
                table,
                ctx.sample_rate,
                base_pitch + ob.tune_cents,
                ob.detune_cents,
                ob.spread,
                morph,
            );
            self.osc[i].render(table, n, scratch_l, scratch_r, ob.level);
        }

        // Noise layer, summed with the oscillators ahead of the filter. It is
        // a centred mono source, so it takes the same -3 dB equal-power gain
        // the oscillators' centre pan position gets.
        if self.noise_on {
            let mut lv = ctx.noise_level;
            for i in 0..n {
                let s = self.noise.next() * lv.next() * std::f32::consts::FRAC_1_SQRT_2;
                scratch_l[i] += s;
                scratch_r[i] += s;
            }
        }

        // ---- filter coefficients (ramped across the block) ---------------
        let kt = ctx.filter.keytrack * (self.note - 60.0) * 100.0;
        let hz0 = (ctx.filter.log2hz_start + (kt + prev.cutoff_cents) * (1.0 / 1200.0)).exp2();
        let hz1 = (ctx.filter.log2hz_end + (kt + m.cutoff_cents) * (1.0 / 1200.0)).exp2();
        let g0 = prewarp(hz0, ctx.sample_rate);
        let g1 = prewarp(hz1, ctx.sample_rate);
        let g_inc = (g1 - g0) / n as f32;
        let coeffs = Coeffs::new(g0, ctx.filter.res, ctx.filter.drive, ctx.filter.mode);

        let mut amp_mod = Ramp {
            v: 1.0 + prev.amp,
            inc: (m.amp - prev.amp) / n as f32,
        };
        let mut g = g0;
        let vel = self.velocity * VOICE_HEADROOM;
        let fading = self.state == State::Fading;

        for i in 0..n {
            let c = coeffs.with_g(g);
            g += g_inc;

            let e = self.env_amp.tick(&ctx.env_amp);
            let mut gain = e * vel * amp_mod.next().max(0.0);
            if fading {
                gain *= self.fade;
                self.fade -= self.fade_inc;
                if self.fade < 0.0 {
                    self.fade = 0.0;
                }
            }

            out_l[i] += self.filt.l.process(scratch_l[i], &c) * gain;
            out_r[i] += self.filt.r.process(scratch_r[i], &c) * gain;
        }

        // ---- housekeeping -------------------------------------------------
        self.env_flt.advance(n, &ctx.env_filter);
        self.lfo.advance(n);
        self.prev_mod = m;

        if self.glide_inc != 0.0 {
            self.pitch_cents += self.glide_inc * n as f32;
            if (self.glide_inc > 0.0 && self.pitch_cents >= self.target_cents)
                || (self.glide_inc < 0.0 && self.pitch_cents <= self.target_cents)
            {
                self.pitch_cents = self.target_cents;
                self.glide_inc = 0.0;
            }
        }

        if fading && self.fade <= 0.0 {
            self.state = if self.pending.is_some() {
                State::Pending
            } else {
                State::Idle
            };
            self.env_amp.kill();
            self.env_flt.kill();
        } else if self.env_amp.is_idle() {
            self.state = State::Idle;
        }
    }
}
