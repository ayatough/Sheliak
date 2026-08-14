//! The three LFO-driven effects: chorus, flanger and phaser.
//!
//! They share the same skeleton — a free-running [`FxLfo`] (never reset after
//! `init()`, docs/architecture.md) read per sample, with the left and right channels taking
//! the LFO at different phase offsets to open up the stereo image.

use crate::params::*;
use crate::smoother::{Smoother, DEFAULT_TAU};

use super::common::{allpass_coef, phase_sin, soft_limit, Allpass1, DelayLine, FxLfo};
use super::Effect;

// --------------------------------------------------------------- chorus

/// Centre delay of the chorus taps.
const CHORUS_BASE_MS: f32 = 7.0;
/// Peak excursion at `depth = 1`.
const CHORUS_SWING_MS: f32 = 5.0;

pub struct Chorus {
    rate: Smoother,
    depth: Smoother,
    mix: Smoother,
    lfo: FxLfo,
    line: [DelayLine; 2],
}

impl Chorus {
    pub fn new(sample_rate: f32) -> Self {
        let cap = ((CHORUS_BASE_MS + CHORUS_SWING_MS + 4.0) * 0.001 * sample_rate) as usize + 8;
        Chorus {
            rate: Smoother::new(sample_rate, DEFAULT_TAU, 0.8),
            depth: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            mix: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            lfo: FxLfo::default(),
            line: [DelayLine::new(cap), DelayLine::new(cap)],
        }
    }
}

impl Effect for Chorus {
    fn reset(&mut self) {
        self.line[0].clear();
        self.line[1].clear();
    }

    fn apply_patch(&mut self, p: &[f32], _sample_rate: f32, first: bool) {
        super::set(
            &mut self.rate,
            super::fclamp(p[CHORUS_RATE_HZ], 0.0, 20.0),
            first,
        );
        super::set(
            &mut self.depth,
            super::fclamp(p[CHORUS_DEPTH], 0.0, 1.0),
            first,
        );
        super::set(&mut self.mix, super::fclamp(p[CHORUS_MIX], 0.0, 1.0), first);
    }

    fn should_process(&self) -> bool {
        self.mix.current() > 0.0 || self.mix.target() > 0.0
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        let n = l.len();
        let mut mix = self.mix.block(n);
        let depth = self.depth.advance(n);
        self.lfo.set_rate(self.rate.advance(n), sample_rate);

        let base = CHORUS_BASE_MS * 0.001 * sample_rate;
        let swing = CHORUS_SWING_MS * 0.001 * sample_rate * depth;

        for i in 0..n {
            let ph = self.lfo.step();
            let m = mix.next();
            // Quadrature LFOs: the two taps sweep 90° apart.
            let dl = base + swing * phase_sin(ph, 0.0);
            let dr = base + swing * phase_sin(ph, 0.25);
            self.line[0].write(l[i]);
            self.line[1].write(r[i]);
            let wl = self.line[0].read(dl);
            let wr = self.line[1].read(dr);
            l[i] += (wl - l[i]) * m;
            r[i] += (wr - r[i]) * m;
        }
    }
}

// -------------------------------------------------------------- flanger

const FLANGER_MIN_MS: f32 = 1.0;
const FLANGER_SPAN_MS: f32 = 7.0;
/// Hard ceiling on the feedback coefficient (REQUIREMENT: |fb| ≤ 0.95).
const MAX_FEEDBACK: f32 = 0.95;

pub struct Flanger {
    rate: Smoother,
    depth: Smoother,
    feedback: Smoother,
    mix: Smoother,
    lfo: FxLfo,
    line: [DelayLine; 2],
}

impl Flanger {
    pub fn new(sample_rate: f32) -> Self {
        let cap = ((FLANGER_MIN_MS + FLANGER_SPAN_MS + 4.0) * 0.001 * sample_rate) as usize + 8;
        Flanger {
            rate: Smoother::new(sample_rate, DEFAULT_TAU, 0.25),
            depth: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            feedback: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            mix: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            lfo: FxLfo::default(),
            line: [DelayLine::new(cap), DelayLine::new(cap)],
        }
    }
}

impl Effect for Flanger {
    fn reset(&mut self) {
        self.line[0].clear();
        self.line[1].clear();
    }

    fn apply_patch(&mut self, p: &[f32], _sample_rate: f32, first: bool) {
        super::set(
            &mut self.rate,
            super::fclamp(p[FLANGER_RATE_HZ], 0.0, 20.0),
            first,
        );
        super::set(
            &mut self.depth,
            super::fclamp(p[FLANGER_DEPTH], 0.0, 1.0),
            first,
        );
        super::set(
            &mut self.feedback,
            super::fclamp(p[FLANGER_FEEDBACK], -1.0, 1.0),
            first,
        );
        super::set(
            &mut self.mix,
            super::fclamp(p[FLANGER_MIX], 0.0, 1.0),
            first,
        );
    }

    fn should_process(&self) -> bool {
        self.mix.current() > 0.0 || self.mix.target() > 0.0
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        let n = l.len();
        let mut mix = self.mix.block(n);
        let depth = self.depth.advance(n);
        let fb = (self.feedback.advance(n) * MAX_FEEDBACK).clamp(-MAX_FEEDBACK, MAX_FEEDBACK);
        self.lfo.set_rate(self.rate.advance(n), sample_rate);

        let base = FLANGER_MIN_MS * 0.001 * sample_rate;
        let span = FLANGER_SPAN_MS * 0.001 * sample_rate * depth;

        for i in 0..n {
            let ph = self.lfo.step();
            let m = mix.next();
            // Unipolar sweep so the delay never dips below the 1 ms floor;
            // the channels sit half a cycle apart for width.
            let dl = base + span * (0.5 + 0.5 * phase_sin(ph, 0.0));
            let dr = base + span * (0.5 + 0.5 * phase_sin(ph, 0.5));
            let wl = self.line[0].read(dl);
            let wr = self.line[1].read(dr);
            self.line[0].write(soft_limit(l[i] + wl * fb, 2.0));
            self.line[1].write(soft_limit(r[i] + wr * fb, 2.0));
            l[i] += (wl - l[i]) * m;
            r[i] += (wr - r[i]) * m;
        }
    }
}

// --------------------------------------------------------------- phaser

const MAX_STAGES: usize = 8;
/// Sweep range at `depth = 1`, in octaves either side of `CENTER_HZ`.
const SWEEP_OCTAVES: f32 = 2.0;

pub struct Phaser {
    rate: Smoother,
    depth: Smoother,
    feedback: Smoother,
    center: Smoother,
    mix: Smoother,
    stages: usize,
    lfo: FxLfo,
    ap: [[Allpass1; MAX_STAGES]; 2],
    fb_state: [f32; 2],
}

impl Phaser {
    pub fn new(sample_rate: f32) -> Self {
        Phaser {
            rate: Smoother::new(sample_rate, DEFAULT_TAU, 0.4),
            depth: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            feedback: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            center: Smoother::new(sample_rate, DEFAULT_TAU, 800.0),
            mix: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            stages: 6,
            lfo: FxLfo::default(),
            ap: [[Allpass1::default(); MAX_STAGES]; 2],
            fb_state: [0.0; 2],
        }
    }
}

impl Effect for Phaser {
    fn reset(&mut self) {
        for ch in self.ap.iter_mut() {
            for s in ch.iter_mut() {
                s.reset();
            }
        }
        self.fb_state = [0.0; 2];
    }

    fn apply_patch(&mut self, p: &[f32], sample_rate: f32, first: bool) {
        // 2..8, even.
        let raw = super::fclamp(p[PHASER_STAGES], 2.0, MAX_STAGES as f32).round() as usize;
        self.stages = (raw & !1).clamp(2, MAX_STAGES);
        super::set(
            &mut self.rate,
            super::fclamp(p[PHASER_RATE_HZ], 0.0, 20.0),
            first,
        );
        super::set(
            &mut self.depth,
            super::fclamp(p[PHASER_DEPTH], 0.0, 1.0),
            first,
        );
        super::set(
            &mut self.feedback,
            super::fclamp(p[PHASER_FEEDBACK], -1.0, 1.0),
            first,
        );
        super::set(
            &mut self.center,
            super::fclamp(p[PHASER_CENTER_HZ], 40.0, sample_rate * 0.4).max(40.0),
            first,
        );
        super::set(&mut self.mix, super::fclamp(p[PHASER_MIX], 0.0, 1.0), first);
    }

    fn should_process(&self) -> bool {
        self.mix.current() > 0.0 || self.mix.target() > 0.0
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        let n = l.len();
        let mut mix = self.mix.block(n);
        let depth = self.depth.advance(n);
        let center = self.center.advance(n);
        let fb = (self.feedback.advance(n) * MAX_FEEDBACK).clamp(-MAX_FEEDBACK, MAX_FEEDBACK);
        self.lfo.set_rate(self.rate.advance(n), sample_rate);

        let stages = self.stages;
        let log_center = center.log2();
        let swing = SWEEP_OCTAVES * depth;
        let max_hz = sample_rate * 0.45;

        for i in 0..n {
            let ph = self.lfo.step();
            let m = mix.next();
            // Sweep in the log domain so the notch motion is musical.
            let fl = (log_center + swing * phase_sin(ph, 0.0))
                .exp2()
                .clamp(20.0, max_hz);
            let fr = (log_center + swing * phase_sin(ph, 0.25))
                .exp2()
                .clamp(20.0, max_hz);
            let al = allpass_coef(fl, sample_rate);
            let ar = allpass_coef(fr, sample_rate);

            let mut yl = l[i] + self.fb_state[0] * fb;
            let mut yr = r[i] + self.fb_state[1] * fb;
            for s in 0..stages {
                yl = self.ap[0][s].process(yl, al);
                yr = self.ap[1][s].process(yr, ar);
            }
            self.fb_state[0] = soft_limit(yl, 2.0);
            self.fb_state[1] = soft_limit(yr, 2.0);

            l[i] += (yl - l[i]) * m;
            r[i] += (yr - r[i]) * m;
        }
    }
}
