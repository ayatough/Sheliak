//! Per-key physical parameters, derived rather than measured.
//!
//! The published literature gives measured string and hammer data for a
//! handful of notes (Chaigne & Askenfelt list C2, C4 and C7); a playable
//! instrument needs all 88. This module interpolates between anchor values in
//! log space, which is how the real quantities vary along the scale — string
//! length, linear density and hammer stiffness all change by orders of
//! magnitude from A0 to C8. The anchors are set from the ranges those papers
//! report; the curves between them are this instrument's voicing, and tuning
//! them by ear is expected.
//!
//! Everything here is deterministic: the per-key "jitter" that keeps
//! neighbouring keys from sounding like copies of one file comes from a hash
//! of the key number, not from a random source, so the same note always
//! renders the same samples.

/// Lowest and highest MIDI keys of a piano keyboard.
pub const FIRST_KEY: i16 = 21;
pub const LAST_KEY: i16 = 108;

/// Keys above this have no dampers on a real piano; their strings ring until
/// the sound dies on its own.
pub const HIGHEST_DAMPED_KEY: i16 = 88;

/// Everything the voice needs to build itself for one key.
pub struct KeyScaling {
    /// Equal-tempered fundamental, before stretch, in Hz.
    pub f0: f32,
    /// Inharmonicity coefficient `B` in `f_n = n·f0·sqrt(1 + B·n²)`.
    pub b: f32,
    /// String linear density times speaking length over two — the modal mass,
    /// identical for every mode of an ideal string.
    pub modal_mass: f32,
    /// Decay rate of the fundamental while the key is held, in 1/s.
    pub sigma0: f32,
    /// Frequency-dependent extra decay, applied as `sigma2·(f/1kHz)²`.
    pub sigma2: f32,
    /// How many strings this key strikes: one wound bass string, two in the
    /// tenor break, three above it.
    pub strings: usize,
    /// Partials per string, bounded by what is audible and affordable. Bass
    /// keys get more because their partial series starts so low.
    pub mode_cap: usize,
    /// Unison detune between the strings of one key, in cents.
    pub detune_cents: f32,
    /// Hammer strike point as a fraction of string length.
    pub strike_pos: f32,
    /// Output readout points (left/right channel) as fractions of length —
    /// two nearby points near the bridge, whose different partial weightings
    /// are what decorrelates the channels.
    pub read_l: f32,
    pub read_r: f32,
    /// Hammer head mass in kg.
    pub hammer_mass: f32,
    /// Felt stiffness `K` in `F = K·compression^p`.
    pub hammer_k: f32,
    /// Felt nonlinearity exponent `p`.
    pub hammer_p: f32,
    /// Whether a damper falls on this key's strings at note-off.
    pub has_damper: bool,
    /// Stereo position, -1 (left) to 1 (right) — bass keys sit to the
    /// player's left.
    pub pan: f32,
    /// Fundamental of the string's longitudinal modes in Hz, and how many of
    /// them the voice runs — zero outside the wound-string range. A struck
    /// wound string also compresses along its length, and those modes (around
    /// a kilohertz for the longest bass strings) are much of what separates
    /// "struck piano bass" from "plucked bass": they are driven by the square
    /// of the contact force, so they bite at forte and vanish at piano.
    pub long_f1: f32,
    pub long_modes: usize,
    /// Slowest hammer speed (m/s) this key is struck with. Raised toward the
    /// treble: a very slow hammer on a very short string spends so many
    /// string periods in contact that almost nothing transfers, which turns
    /// physical dynamics into an unusable pp-to-ff chasm. Compressing the
    /// speed range up there keeps the whole keyboard playable at one touch.
    pub velocity_floor: f32,
    /// The measured voicing correction from [`OUTPUT_TRIM`].
    pub output_trim: f32,
}

/// Measured per-key output trim — the voicing table.
///
/// The physics above levels the keyboard only approximately: with a handful
/// of partials, a treble key's radiated level depends on how its contact
/// pulse happens to align with its string period, and that alignment sweeps
/// through interference lobes as the scale climbs. Real pianos absorb the
/// same physics in the voicing room; this table is that step, measured by
/// `examples/levels.rs` at default parameters — the geometric mean of the
/// mezzo-forte and fortissimo corrections up to key 93, and the fortissimo
/// correction alone above that, where the lobes are steepest at full force.
/// Regenerate it after any change to the model or to `key_scaling` — the
/// numbers are downstream of both.
// A measured value is allowed to land near π — 3.140 is a trim, not geometry.
#[allow(clippy::approx_constant)]
const OUTPUT_TRIM: [f32; 88] = [
    0.240, // key 21
    0.249, // key 22
    0.265, // key 23
    0.271, // key 24
    0.270, // key 25
    0.245, // key 26
    0.247, // key 27
    0.276, // key 28
    0.350, // key 29
    0.274, // key 30
    0.268, // key 31
    0.300, // key 32
    0.354, // key 33
    0.283, // key 34
    0.303, // key 35
    0.304, // key 36
    0.362, // key 37
    0.418, // key 38
    0.396, // key 39
    0.425, // key 40
    0.433, // key 41
    0.482, // key 42
    0.473, // key 43
    0.296, // key 44
    0.335, // key 45
    0.365, // key 46
    0.350, // key 47
    0.415, // key 48
    0.433, // key 49
    0.479, // key 50
    0.530, // key 51
    0.540, // key 52
    0.596, // key 53
    0.611, // key 54
    0.717, // key 55
    0.790, // key 56
    0.828, // key 57
    0.862, // key 58
    0.843, // key 59
    1.052, // key 60
    1.088, // key 61
    0.883, // key 62
    1.175, // key 63
    1.250, // key 64
    1.085, // key 65
    0.915, // key 66
    1.240, // key 67
    1.177, // key 68
    0.953, // key 69
    0.839, // key 70
    1.328, // key 71
    1.273, // key 72
    1.271, // key 73
    1.688, // key 74
    0.792, // key 75
    1.280, // key 76
    1.454, // key 77
    1.437, // key 78
    1.391, // key 79
    2.138, // key 80
    1.591, // key 81
    1.689, // key 82
    1.674, // key 83
    2.090, // key 84
    2.424, // key 85
    1.816, // key 86
    3.520, // key 87
    3.374, // key 88
    2.919, // key 89
    3.182, // key 90
    2.701, // key 91
    2.981, // key 92
    2.895, // key 93
    3.811, // key 94
    3.871, // key 95
    3.496, // key 96
    4.710, // key 97
    4.084, // key 98
    5.667, // key 99
    3.150, // key 100
    6.025, // key 101
    2.758, // key 102
    0.748, // key 103
    4.606, // key 104
    2.149, // key 105
    1.314, // key 106
    6.735, // key 107
    3.140, // key 108
];

/// Piecewise-linear interpolation over `(midi_key, value)` anchor points.
fn piecewise(key: f32, points: &[(f32, f32)]) -> f32 {
    let first = points[0];
    if key <= first.0 {
        return first.1;
    }
    for pair in points.windows(2) {
        let (x0, y0) = pair[0];
        let (x1, y1) = pair[1];
        if key <= x1 {
            return y0 + (y1 - y0) * (key - x0) / (x1 - x0);
        }
    }
    points[points.len() - 1].1
}

/// The same, for quantities that vary exponentially: anchors hold `log10`.
fn piecewise_log(key: f32, points: &[(f32, f32)]) -> f32 {
    10.0f32.powf(piecewise(key, points))
}

/// The deterministic per-key hash behind [`jitter`] — also the seed of the
/// strike-noise burst in `model.rs`, which is how the knock stays free of any
/// random source: the "noise" is a fixed sequence chosen by the key number.
pub fn key_hash(key: i16, salt: u32) -> u32 {
    let mut h = (key as u32).wrapping_add(salt.wrapping_mul(0x9E37_79B9));
    h ^= h >> 16;
    h = h.wrapping_mul(0x85EB_CA6B);
    h ^= h >> 13;
    h
}

/// A deterministic per-key value in -1..1, from nothing but the key number.
fn jitter(key: i16, salt: u32) -> f32 {
    (key_hash(key, salt) & 0xFFFF) as f32 / 32768.0 - 1.0
}

/// Tuning stretch for one key in cents, scaled by the Stretch parameter.
///
/// The Railsback curve: octaves tuned wide so that inharmonic partials line
/// up, flat in the bass and sharp in the treble, roughly cubic around the
/// middle of the keyboard.
pub fn stretch_cents(key: i16, amount: f32) -> f32 {
    let d = (key as f32 - 66.0) / 24.0;
    amount * 8.0 * d * d.abs()
}

pub fn key_scaling(key: i16) -> KeyScaling {
    let key = key.clamp(FIRST_KEY, LAST_KEY);
    let k = key as f32;
    let along = (key - FIRST_KEY) as f32 / (LAST_KEY - FIRST_KEY) as f32;

    let f0 = 440.0 * 2.0f32.powf((k - 69.0) / 12.0);

    // Inharmonicity has its minimum where wound strings hand over to plain
    // ones (around C2–C3) and rises steeply toward the short treble strings.
    let b = piecewise_log(k, &[(21.0, -3.7), (41.0, -4.1), (108.0, -1.8)]);

    // Linear density (kg/m) and speaking length (m), each spanning orders of
    // magnitude; only their product matters to the sound, as the modal mass.
    let mu = piecewise_log(k, &[(21.0, -0.72), (60.0, -2.12), (108.0, -2.32)]);
    let length = piecewise_log(k, &[(21.0, 0.29), (60.0, -0.18), (108.0, -1.27)]);
    let modal_mass = mu * length / 2.0;

    // Decay time of the held fundamental: half a minute in the bass, under a
    // second at the top. sigma = ln(1000)/T60.
    let t60 = piecewise(
        k,
        &[
            (21.0, 28.0),
            (45.0, 20.0),
            (60.0, 13.0),
            (84.0, 4.0),
            (108.0, 0.85),
        ],
    );
    let sigma0 = 6.9078 / t60;
    let sigma2 = piecewise(k, &[(21.0, 0.30), (108.0, 0.55)]);

    let (strings, mode_cap) = match key {
        ..=33 => (1, 128),
        34..=43 => (2, 96),
        44..=59 => (3, 72),
        _ => (3, 48),
    };

    // Longitudinal fundamental: fL1 = cL / 2L, with cL the effective
    // longitudinal wave speed of the wound string — the copper winding adds
    // mass but no stiffness, so it sits well below plain steel's ~5100 m/s
    // and recovers toward it as the winding thins out up the scale. The
    // per-key jitter keeps neighbouring keys' metallic clusters from
    // landing on one frequency.
    let (long_f1, long_modes) = if key <= 43 {
        let c_long = piecewise(k, &[(21.0, 2500.0), (43.0, 3900.0)]);
        (c_long / (2.0 * length) * (1.0 + 0.04 * jitter(key, 5)), 12)
    } else {
        (0.0, 0)
    };

    KeyScaling {
        f0,
        b,
        modal_mass,
        sigma0,
        sigma2,
        strings,
        mode_cap,
        detune_cents: 0.5 + 1.0 * along,
        strike_pos: 0.120 - 0.020 * along + jitter(key, 1) * 0.004,
        read_l: 0.93 + jitter(key, 2) * 0.02,
        read_r: 0.89 + jitter(key, 3) * 0.02,
        hammer_mass: 0.0118 - 0.0066 * along,
        hammer_k: piecewise_log(k, &[(21.0, 8.6), (108.0, 11.0)]),
        hammer_p: 2.2 + 0.8 * along,
        long_f1,
        long_modes,
        has_damper: key <= HIGHEST_DAMPED_KEY,
        pan: -0.45 + 0.9 * along,
        velocity_floor: 0.25 + 1.75 * along * along,
        output_trim: OUTPUT_TRIM[(key - FIRST_KEY) as usize],
    }
}
