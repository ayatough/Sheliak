//! Parameter block layout — integration contract with web/src/shared/params.ts.
//! Do not change values without updating the TS mirror and docs/architecture.md.

pub const PARAM_COUNT: usize = 192;

// Global
pub const P_POLYPHONY: usize = 0; // 1..=16
pub const P_GLIDE_S: usize = 1;
pub const P_MASTER_GAIN: usize = 2; // linear
pub const P_SEED: usize = 3; // integer value stored as f32

// Oscillators: base + offset, stride 16
pub const OSC_A_BASE: usize = 8;
pub const OSC_B_BASE: usize = 24;
pub const OSC_ENABLED: usize = 0; // 0/1
pub const OSC_TABLE_ID: usize = 1;
pub const OSC_LEVEL: usize = 2; // linear
pub const OSC_MORPH: usize = 3; // 0..1
pub const OSC_UNISON: usize = 4; // 1..=7
pub const OSC_DETUNE_CENTS: usize = 5;
pub const OSC_SPREAD: usize = 6; // 0..1
pub const OSC_TUNE_SEMI: usize = 7;
pub const OSC_TUNE_CENTS: usize = 8;
pub const OSC_PHASE_RANDOM: usize = 9; // 0/1

// Filter
pub const P_FILTER_MODE: usize = 40; // 0=lp12 1=lp24 2=hp12 3=bp12
pub const P_FILTER_CUTOFF_HZ: usize = 41;
pub const P_FILTER_RES: usize = 42; // 0..1
pub const P_FILTER_DRIVE: usize = 43; // 0..1
pub const P_FILTER_KEYTRACK: usize = 44; // 0..1

// Envelopes (seconds, sustain 0..1)
pub const ENV_AMP_BASE: usize = 48;
pub const ENV_FILTER_BASE: usize = 52;
pub const ENV_A: usize = 0;
pub const ENV_D: usize = 1;
pub const ENV_S: usize = 2;
pub const ENV_R: usize = 3;

// LFO
pub const P_LFO_WAVE: usize = 56; // 0=sine 1=tri 2=saw 3=square
pub const P_LFO_RATE_HZ: usize = 57;
pub const P_LFO_PHASE: usize = 58; // 0..1

// Mod matrix: 8 slots, stride 4
pub const MOD_BASE: usize = 64;
pub const MOD_SLOTS: usize = 8;
pub const MOD_STRIDE: usize = 4;
pub const MOD_SRC: usize = 0; // 0=none 1=env.filter 2=env.amp 3=lfo.1 4=velocity
pub const MOD_DST: usize = 1; // see below
pub const MOD_AMOUNT: usize = 2;

// Mod destinations
pub const DST_NONE: u32 = 0;
pub const DST_FILTER_CUTOFF: u32 = 1; // amount in cents
pub const DST_OSC1_MORPH: u32 = 2; // amount normalized delta
pub const DST_OSC2_MORPH: u32 = 3; // amount normalized delta
pub const DST_PITCH: u32 = 4; // amount in cents
pub const DST_AMP: u32 = 5; // amount normalized delta

// Table registry
pub const TABLE_SINE: u32 = 0;
pub const TABLE_TRI: u32 = 1;
pub const TABLE_SAW: u32 = 2;
pub const TABLE_SQUARE: u32 = 3;
pub const TABLE_PWM: u32 = 4;
pub const TABLE_FOLD: u32 = 5;
pub const TABLE_COUNT: usize = 6;

// Noise layer (per voice, mixed with the oscillators pre-filter)
pub const NOISE_BASE: usize = 96;
pub const NOISE_ENABLED: usize = 0; // 0/1
pub const NOISE_LEVEL: usize = 1; // linear
pub const NOISE_COLOR: usize = 2; // 0=white 1=pink

// Per-track FX chain: processing order as a list of effect type ids, 0 = empty.
pub const FX_ORDER_BASE: usize = 104;
pub const FX_SLOTS: usize = 8;

// Effect type ids. A type still appears at most once in a chain; the ids no
// longer index the parameter region, so a new one needs no room reserved.
pub const FX_NONE: u32 = 0;
pub const FX_DIST: u32 = 1;
pub const FX_EQ: u32 = 2;
pub const FX_CHORUS: u32 = 3;
pub const FX_PHASER: u32 = 4;
pub const FX_FLANGER: u32 = 5;
pub const FX_DELAY: u32 = 6;
pub const FX_REVERB: u32 = 7;
pub const FX_MBCOMP: u32 = 8;
pub const FX_TYPE_COUNT: usize = 8;

// Per-slot parameter blocks: base = FX_SLOT_BASE + slot * FX_SLOT_STRIDE.
// Keyed by position in the chain, not by type — so the region is a fixed
// 8 x 8 = 64 floats however many effect types exist.
pub const FX_SLOT_BASE: usize = 112;
pub const FX_SLOT_STRIDE: usize = 8;

// Distortion (FX_DIST)
pub const DIST_DRIVE: usize = 0; // 0..1
pub const DIST_MIX: usize = 1; // 0..1 dry/wet
pub const DIST_MODE: usize = 2; // 0=tanh 1=fold 2=clip
pub const DIST_TONE_HZ: usize = 3; // post lowpass, 20000 = off

// 3-band EQ (FX_EQ): low shelf 120 Hz, peak at MID_FREQ, high shelf 6 kHz
pub const EQ_LOW_DB: usize = 0;
pub const EQ_MID_DB: usize = 1;
pub const EQ_HIGH_DB: usize = 2;
pub const EQ_MID_FREQ_HZ: usize = 3;

// Chorus (FX_CHORUS)
pub const CHORUS_RATE_HZ: usize = 0;
pub const CHORUS_DEPTH: usize = 1; // 0..1
pub const CHORUS_MIX: usize = 2; // 0..1

// Phaser (FX_PHASER)
pub const PHASER_RATE_HZ: usize = 0;
pub const PHASER_DEPTH: usize = 1; // 0..1
pub const PHASER_FEEDBACK: usize = 2; // 0..1
pub const PHASER_MIX: usize = 3; // 0..1
pub const PHASER_STAGES: usize = 4; // 2..8, even
pub const PHASER_CENTER_HZ: usize = 5;

// Flanger (FX_FLANGER)
pub const FLANGER_RATE_HZ: usize = 0;
pub const FLANGER_DEPTH: usize = 1; // 0..1
pub const FLANGER_FEEDBACK: usize = 2; // 0..1
pub const FLANGER_MIX: usize = 3; // 0..1

// Delay (FX_DELAY)
pub const DELAY_TIME_S: usize = 0; // seconds (TS converts musical time), max 2.0
pub const DELAY_FEEDBACK: usize = 1; // 0..1
pub const DELAY_MIX: usize = 2; // 0..1
pub const DELAY_PINGPONG: usize = 3; // 0/1
pub const DELAY_TONE_HZ: usize = 4; // feedback-path lowpass

// Reverb (FX_REVERB)
pub const REVERB_SIZE: usize = 0; // 0..1
pub const REVERB_DAMP: usize = 1; // 0..1
pub const REVERB_MIX: usize = 2; // 0..1
pub const REVERB_PREDELAY_S: usize = 3; // seconds, max 0.25
pub const REVERB_WIDTH: usize = 4; // 0..1

// Multiband compressor (FX_MBCOMP): 3 bands, fixed crossovers (120 Hz / 2.5 kHz)
pub const MBCOMP_THRESH_LOW_DB: usize = 0;
pub const MBCOMP_THRESH_MID_DB: usize = 1;
pub const MBCOMP_THRESH_HIGH_DB: usize = 2;
pub const MBCOMP_RATIO: usize = 3; // >= 1
pub const MBCOMP_ATTACK_S: usize = 4;
pub const MBCOMP_RELEASE_S: usize = 5;
pub const MBCOMP_MAKEUP: usize = 6; // linear

// Engine limits
pub const MAX_TRACKS: usize = 8;
pub const MAX_VOICES: usize = 16;
pub const MAX_UNISON: usize = 7;
pub const MAX_BLOCK: usize = 128;
pub const FRAME_LEN: usize = 2048;
