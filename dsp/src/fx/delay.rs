//! Stereo delay (FX_DELAY) with tone-shaped feedback and ping-pong.
//!
//! * `TIME_S` is clamped to `[1 ms, 2 s]` and **smoothed as a read position in
//!   samples**, with a deliberately slow (60 ms) pole. Hot-reloading a new
//!   delay time therefore slides the read head instead of jumping it: the
//!   repeats bend in pitch for a moment, exactly like a tape delay, and never
//!   click. (A crossfading dual-tap reader would avoid the bend, but the bend
//!   is the musical behaviour here.)
//! * `PINGPONG = 0` is dual mono (each channel feeds itself), `1` cross-feeds
//!   L→R→L.
//! * The feedback path is lowpassed by `TONE_HZ`, so repeats darken as they
//!   decay, and clamped to 0.95 with a soft limiter as a safety net against
//!   runaway.

use crate::params::{DELAY_FEEDBACK, DELAY_MIX, DELAY_PINGPONG, DELAY_TIME_S, DELAY_TONE_HZ};
use crate::smoother::{Smoother, DEFAULT_TAU};

use super::common::{soft_limit, DelayLine, OnePole};
use super::Effect;

/// Longest delay allocated at `init()` (docs/architecture.md: TIME_S ≤ 2.0).
pub const MAX_DELAY_S: f32 = 2.0;
const MIN_DELAY_S: f32 = 0.001;
const MAX_FEEDBACK: f32 = 0.95;
/// Time-constant for the read-position glide.
const TIME_TAU: f32 = 0.06;

pub struct Delay {
    time: Smoother,
    feedback: Smoother,
    mix: Smoother,
    tone: Smoother,
    pingpong: bool,
    line: [DelayLine; 2],
    lp: [OnePole; 2],
}

impl Delay {
    pub fn new(sample_rate: f32) -> Self {
        let cap = (MAX_DELAY_S * sample_rate) as usize + 8;
        Delay {
            time: Smoother::new(sample_rate, TIME_TAU, 0.25 * sample_rate),
            feedback: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            mix: Smoother::new(sample_rate, DEFAULT_TAU, 0.0),
            tone: Smoother::new(sample_rate, DEFAULT_TAU, 8_000.0),
            pingpong: false,
            line: [DelayLine::new(cap), DelayLine::new(cap)],
            lp: [OnePole::default(); 2],
        }
    }
}

impl Effect for Delay {
    fn reset(&mut self) {
        self.line[0].clear();
        self.line[1].clear();
        self.lp[0].reset();
        self.lp[1].reset();
    }

    fn apply_patch(&mut self, p: &[f32], sample_rate: f32, first: bool) {
        let secs = super::fclamp(p[DELAY_TIME_S], MIN_DELAY_S, MAX_DELAY_S);
        super::set(&mut self.time, secs * sample_rate, first);
        super::set(
            &mut self.feedback,
            super::fclamp(p[DELAY_FEEDBACK], 0.0, 1.0),
            first,
        );
        super::set(&mut self.mix, super::fclamp(p[DELAY_MIX], 0.0, 1.0), first);
        super::set(
            &mut self.tone,
            super::fclamp(p[DELAY_TONE_HZ], 100.0, sample_rate * 0.45).max(100.0),
            first,
        );
        self.pingpong = p[DELAY_PINGPONG] >= 0.5;
    }

    fn should_process(&self) -> bool {
        self.mix.current() > 0.0 || self.mix.target() > 0.0
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32], sample_rate: f32) {
        let n = l.len();
        let mut mix = self.mix.block(n);
        let mut time = self.time.block(n);
        let fb = self.feedback.advance(n).clamp(0.0, 1.0) * MAX_FEEDBACK;
        let tone = self.tone.advance(n);
        self.lp[0].set_hz(tone, sample_rate);
        self.lp[1].set_hz(tone, sample_rate);
        let cross = self.pingpong;

        for i in 0..n {
            let d = time.next();
            let m = mix.next();
            let wl = self.line[0].read(d);
            let wr = self.line[1].read(d);
            let (sl, sr) = if cross { (wr, wl) } else { (wl, wr) };
            self.line[0].write(soft_limit(l[i] + self.lp[0].process(sl) * fb, 2.0));
            self.line[1].write(soft_limit(r[i] + self.lp[1].process(sr) * fb, 2.0));
            l[i] += (wl - l[i]) * m;
            r[i] += (wr - r[i]) * m;
        }
    }
}
