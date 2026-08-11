//! Exponential ADSR (REQUIREMENTS §4.2: エンベロープ ADSR ×2、指数カーブ).
//!
//! Analogue-style one-pole segments driving toward an *overshooting* target,
//! which is what makes the attack snap instead of creeping asymptotically:
//!
//! * attack drives toward `1 + 0.3` and switches to decay when it crosses 1.0,
//! * decay drives toward `sustain − ε` and switches when it crosses sustain,
//! * release drives toward `−ε` and terminates exactly at 0.
//!
//! `ε = 1e-4`, so decay/release reach their targets in almost exactly the
//! programmed time while keeping a natural exponential shape. Release always
//! starts from the *current* level, so releasing during the attack does not
//! jump. A note-on never resets the level to zero (see [`Env::note_on`]) —
//! voice stealing is handled by a fast fade in `voice.rs`, not by resetting the
//! envelope, so there is no click either way.

const ATTACK_RATIO: f32 = 0.3;
const DR_RATIO: f32 = 1.0e-4;

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

/// Coefficients derived from the patch; shared by all voices, recomputed only
/// in `apply_patch()`.
#[derive(Copy, Clone, Debug)]
pub struct EnvConfig {
    atk_coef: f32,
    atk_base: f32,
    dec_coef: f32,
    dec_base: f32,
    rel_coef: f32,
    rel_base: f32,
    sustain: f32,
    sus_coef: f32,
}

#[inline]
fn seg_coef(samples: f32, ratio: f32) -> f32 {
    if samples <= 0.0 {
        return 0.0;
    }
    (-((1.0 + ratio) / ratio).ln() / samples).exp()
}

impl EnvConfig {
    pub fn new(a: f32, d: f32, s: f32, r: f32, sample_rate: f32) -> Self {
        let sr = sample_rate.max(1.0);
        let sustain = s.clamp(0.0, 1.0);
        let atk_coef = seg_coef(a.max(0.0) * sr, ATTACK_RATIO);
        let dec_coef = seg_coef(d.max(0.0) * sr, DR_RATIO);
        let rel_coef = seg_coef(r.max(0.0) * sr, DR_RATIO);
        EnvConfig {
            atk_coef,
            atk_base: (1.0 + ATTACK_RATIO) * (1.0 - atk_coef),
            dec_coef,
            dec_base: (sustain - DR_RATIO) * (1.0 - dec_coef),
            rel_coef,
            rel_base: -DR_RATIO * (1.0 - rel_coef),
            sustain,
            // ~5 ms tracking so that editing `sustain` while a note is held
            // slides instead of stepping.
            sus_coef: 1.0 - (-1.0 / (0.005 * sr)).exp(),
        }
    }
}

impl Default for EnvConfig {
    fn default() -> Self {
        EnvConfig::new(0.005, 0.2, 0.7, 0.12, 48_000.0)
    }
}

#[derive(Copy, Clone, Debug)]
pub struct Env {
    pub stage: Stage,
    pub level: f32,
}

impl Default for Env {
    fn default() -> Self {
        Env {
            stage: Stage::Idle,
            level: 0.0,
        }
    }
}

impl Env {
    #[inline]
    pub fn note_on(&mut self) {
        self.stage = Stage::Attack;
    }

    #[inline]
    pub fn note_off(&mut self) {
        if self.stage != Stage::Idle {
            self.stage = Stage::Release;
        }
    }

    #[inline]
    pub fn kill(&mut self) {
        self.stage = Stage::Idle;
        self.level = 0.0;
    }

    #[inline]
    pub fn is_idle(&self) -> bool {
        self.stage == Stage::Idle
    }

    /// Advances one sample and returns the new level.
    #[inline(always)]
    pub fn tick(&mut self, c: &EnvConfig) -> f32 {
        match self.stage {
            Stage::Idle => return 0.0,
            Stage::Attack => {
                self.level = c.atk_base + self.level * c.atk_coef;
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.level = c.dec_base + self.level * c.dec_coef;
                if self.level <= c.sustain {
                    self.level = c.sustain;
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Sustain => {
                self.level += (c.sustain - self.level) * c.sus_coef;
            }
            Stage::Release => {
                self.level = c.rel_base + self.level * c.rel_coef;
                if self.level <= 0.0 {
                    self.level = 0.0;
                    self.stage = Stage::Idle;
                }
            }
        }
        self.level
    }

    /// Advances `n` samples (used for the filter envelope, which is only read
    /// at control rate).
    pub fn advance(&mut self, n: usize, c: &EnvConfig) {
        for _ in 0..n {
            self.tick(c);
        }
    }
}
