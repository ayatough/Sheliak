//! Parameter block layout — integration contract with web/src/shared/params.ts.
//! Do not change values without updating the TS mirror and docs/SPEC.md.

pub const PARAM_COUNT: usize = 96;

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

// Engine limits
pub const MAX_VOICES: usize = 16;
pub const MAX_UNISON: usize = 7;
pub const MAX_BLOCK: usize = 128;
pub const FRAME_LEN: usize = 2048;
