// Parameter block layout — integration contract with dsp/src/params.rs.
// Do not change values without updating the Rust mirror and docs/SPEC.md.

export const PARAM_COUNT = 96;

// Global
export const P_POLYPHONY = 0; // 1..16
export const P_GLIDE_S = 1;
export const P_MASTER_GAIN = 2; // linear
export const P_SEED = 3; // integer value stored as f32

// Oscillators: base + offset, stride 16
export const OSC_A_BASE = 8;
export const OSC_B_BASE = 24;
export const OSC_ENABLED = 0; // 0/1
export const OSC_TABLE_ID = 1;
export const OSC_LEVEL = 2; // linear
export const OSC_MORPH = 3; // 0..1
export const OSC_UNISON = 4; // 1..7
export const OSC_DETUNE_CENTS = 5;
export const OSC_SPREAD = 6; // 0..1
export const OSC_TUNE_SEMI = 7;
export const OSC_TUNE_CENTS = 8;
export const OSC_PHASE_RANDOM = 9; // 0/1

// Filter
export const P_FILTER_MODE = 40; // 0=lp12 1=lp24 2=hp12 3=bp12
export const P_FILTER_CUTOFF_HZ = 41;
export const P_FILTER_RES = 42; // 0..1
export const P_FILTER_DRIVE = 43; // 0..1
export const P_FILTER_KEYTRACK = 44; // 0..1

// Envelopes (seconds, sustain 0..1)
export const ENV_AMP_BASE = 48;
export const ENV_FILTER_BASE = 52;
export const ENV_A = 0;
export const ENV_D = 1;
export const ENV_S = 2;
export const ENV_R = 3;

// LFO
export const P_LFO_WAVE = 56; // 0=sine 1=tri 2=saw 3=square
export const P_LFO_RATE_HZ = 57;
export const P_LFO_PHASE = 58; // 0..1

// Mod matrix: 8 slots, stride 4
export const MOD_BASE = 64;
export const MOD_SLOTS = 8;
export const MOD_STRIDE = 4;
export const MOD_SRC = 0; // 0=none 1=env.filter 2=env.amp 3=lfo.1 4=velocity
export const MOD_DST = 1;
export const MOD_AMOUNT = 2;

// Mod sources
export const SRC_NONE = 0;
export const SRC_ENV_FILTER = 1;
export const SRC_ENV_AMP = 2;
export const SRC_LFO1 = 3;
export const SRC_VELOCITY = 4;

// Mod destinations
export const DST_NONE = 0;
export const DST_FILTER_CUTOFF = 1; // amount in cents
export const DST_OSC1_MORPH = 2; // amount normalized delta
export const DST_OSC2_MORPH = 3; // amount normalized delta
export const DST_PITCH = 4; // amount in cents
export const DST_AMP = 5; // amount normalized delta

// Table registry (DSL name -> id)
export const TABLE_IDS: Record<string, number> = {
  'basic/sine': 0,
  'basic/tri': 1,
  'basic/saw': 2,
  'basic/square': 3,
  'morph/pwm': 4,
  'morph/fold': 5,
};

// Engine limits
export const MAX_VOICES = 16;
export const MAX_UNISON = 7;
export const MAX_BLOCK = 128;
