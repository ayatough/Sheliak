// Parameter block layout — integration contract with dsp/src/params.rs.
// Do not change values without updating the Rust mirror and docs/SPEC.md.

export const PARAM_COUNT = 192;

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

// Noise layer (per voice, mixed with the oscillators pre-filter)
export const NOISE_BASE = 96;
export const NOISE_ENABLED = 0; // 0/1
export const NOISE_LEVEL = 1; // linear
export const NOISE_COLOR = 2; // 0=white 1=pink

// Master FX chain: processing order as a list of effect type ids, 0 = empty.
export const FX_ORDER_BASE = 104;
export const FX_SLOTS = 8;

// Effect type ids (each type appears at most once in the chain)
export const FX_NONE = 0;
export const FX_DIST = 1;
export const FX_EQ = 2;
export const FX_CHORUS = 3;
export const FX_PHASER = 4;
export const FX_FLANGER = 5;
export const FX_DELAY = 6;
export const FX_REVERB = 7;
export const FX_MBCOMP = 8;

// Per-effect parameter blocks: base = FX_PARAMS_BASE + (type - 1) * FX_PARAMS_STRIDE
export const FX_PARAMS_BASE = 112;
export const FX_PARAMS_STRIDE = 8;

// Distortion (FX_DIST)
export const DIST_DRIVE = 0; // 0..1
export const DIST_MIX = 1; // 0..1 dry/wet
export const DIST_MODE = 2; // 0=tanh 1=fold 2=clip
export const DIST_TONE_HZ = 3; // post lowpass, 20000 = off

// 3-band EQ (FX_EQ): low shelf 120 Hz, peak at MID_FREQ, high shelf 6 kHz
export const EQ_LOW_DB = 0;
export const EQ_MID_DB = 1;
export const EQ_HIGH_DB = 2;
export const EQ_MID_FREQ_HZ = 3;

// Chorus (FX_CHORUS)
export const CHORUS_RATE_HZ = 0;
export const CHORUS_DEPTH = 1; // 0..1
export const CHORUS_MIX = 2; // 0..1

// Phaser (FX_PHASER)
export const PHASER_RATE_HZ = 0;
export const PHASER_DEPTH = 1; // 0..1
export const PHASER_FEEDBACK = 2; // 0..1
export const PHASER_MIX = 3; // 0..1
export const PHASER_STAGES = 4; // 2..8, even
export const PHASER_CENTER_HZ = 5;

// Flanger (FX_FLANGER)
export const FLANGER_RATE_HZ = 0;
export const FLANGER_DEPTH = 1; // 0..1
export const FLANGER_FEEDBACK = 2; // 0..1
export const FLANGER_MIX = 3; // 0..1

// Delay (FX_DELAY)
export const DELAY_TIME_S = 0; // seconds (TS converts musical time), max 2.0
export const DELAY_FEEDBACK = 1; // 0..1
export const DELAY_MIX = 2; // 0..1
export const DELAY_PINGPONG = 3; // 0/1
export const DELAY_TONE_HZ = 4; // feedback-path lowpass

// Reverb (FX_REVERB)
export const REVERB_SIZE = 0; // 0..1
export const REVERB_DAMP = 1; // 0..1
export const REVERB_MIX = 2; // 0..1
export const REVERB_PREDELAY_S = 3; // seconds, max 0.25
export const REVERB_WIDTH = 4; // 0..1

// Multiband compressor (FX_MBCOMP): 3 bands, fixed crossovers (120 Hz / 2.5 kHz)
export const MBCOMP_THRESH_LOW_DB = 0;
export const MBCOMP_THRESH_MID_DB = 1;
export const MBCOMP_THRESH_HIGH_DB = 2;
export const MBCOMP_RATIO = 3; // >= 1
export const MBCOMP_ATTACK_S = 4;
export const MBCOMP_RELEASE_S = 5;
export const MBCOMP_MAKEUP = 6; // linear

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
