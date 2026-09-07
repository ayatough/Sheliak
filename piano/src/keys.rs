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
const OUTPUT_TRIM: [f32; 88] = [
    0.277, // key 21
    0.258, // key 22
    0.228, // key 23
    0.242, // key 24
    0.262, // key 25
    0.256, // key 26
    0.251, // key 27
    0.271, // key 28
    0.281, // key 29
    0.328, // key 30
    0.327, // key 31
    0.331, // key 32
    0.335, // key 33
    0.330, // key 34
    0.331, // key 35
    0.405, // key 36
    0.451, // key 37
    0.441, // key 38
    0.456, // key 39
    0.563, // key 40
    0.539, // key 41
    0.516, // key 42
    0.539, // key 43
    0.451, // key 44
    0.347, // key 45
    0.323, // key 46
    0.456, // key 47
    0.380, // key 48
    0.504, // key 49
    0.445, // key 50
    0.508, // key 51
    0.442, // key 52
    0.349, // key 53
    0.428, // key 54
    0.429, // key 55
    0.408, // key 56
    0.382, // key 57
    0.565, // key 58
    0.438, // key 59
    0.452, // key 60
    0.733, // key 61
    0.468, // key 62
    0.849, // key 63
    0.700, // key 64
    0.664, // key 65
    0.373, // key 66
    0.563, // key 67
    0.516, // key 68
    0.661, // key 69
    0.562, // key 70
    0.548, // key 71
    0.745, // key 72
    0.779, // key 73
    0.680, // key 74
    0.417, // key 75
    0.708, // key 76
    0.703, // key 77
    0.682, // key 78
    0.764, // key 79
    1.246, // key 80
    0.957, // key 81
    0.740, // key 82
    0.880, // key 83
    1.265, // key 84
    1.287, // key 85
    0.921, // key 86
    1.313, // key 87
    1.225, // key 88
    0.803, // key 89
    1.316, // key 90
    1.037, // key 91
    1.344, // key 92
    1.133, // key 93
    2.600, // key 94
    2.348, // key 95
    1.796, // key 96
    2.804, // key 97
    2.173, // key 98
    2.193, // key 99
    2.094, // key 100
    2.276, // key 101
    1.664, // key 102
    0.573, // key 103
    0.924, // key 104
    0.872, // key 105
    0.887, // key 106
    0.532, // key 107
    0.382, // key 108
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

/// A deterministic 32-bit hash of the key number and a salt — the only
/// "randomness" the instrument has. `jitter` derives the per-key voicing
/// scatter from it, and the strike noise in `model.rs` seeds its burst from
/// it, so a key's noise is as much a property of that key as its stiffness.
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
        has_damper: key <= HIGHEST_DAMPED_KEY,
        pan: -0.45 + 0.9 * along,
        velocity_floor: 0.25 + 1.75 * along * along,
        output_trim: OUTPUT_TRIM[(key - FIRST_KEY) as usize],
    }
}
