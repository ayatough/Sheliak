//! The soundboard as a resonator, not a filter.
//!
//! Everything the strings and the strike make passes through the board on
//! its way out, and the board answers with its own modes: a cluster of body
//! resonances in the low hundreds of hertz, thinning upward, each ringing
//! for a few tens of milliseconds. The old stand-in was two shelving
//! corners; this is a bank of damped modes fitted to a recording of a
//! grand's board being tapped, so a note carries the board's ring and the
//! attack carries its thump — the part of the sound that the author's ears
//! picked as "a piano" in an A/B against the shelving filters.
//!
//! The table is fitted offline by `tools/fit_board.py` (matrix pencil on the
//! first 300 ms of the tap) and shipped as constants: frequency, decay rate,
//! amplitude and phase per mode. At run time each mode is one biquad whose
//! impulse response is exactly that damped cosine, scaled so the same
//! continuous-time board is heard at any sample rate. Two banks, left and
//! right, with mode weights nudged apart from a hash of the mode index, give
//! the board its width.
//!
//! The tap's own body hump — the 120–450 Hz region sits about 20 dB above
//! everything higher, which the ears heard as a painful, peaky low end — is
//! pulled down by `BOARD_HUMP_DB` through a smooth shelf, so the board reads
//! as a board and not as a resonant boom.

use crate::keys::key_hash;

// Fitted from Piano_IR.wav at 44100 Hz: 48 modes.
pub const BOARD_FIT_RATE: f32 = 44100.0;
pub const BOARD_MODES: [[f32; 4]; 48] = [
    [118.0, 144.3, 0.932375, -1.3379],
    [168.7, 2236.5, 17.600076, 1.5244],
    [242.1, 146.4, 1.624416, -1.6374],
    [412.6, 142.9, 1.307221, -0.5227],
    [487.1, 517.2, 0.966376, 0.9535],
    [639.9, 326.8, 0.792737, -2.7495],
    [783.9, 325.5, 0.313031, -1.9261],
    [927.7, 270.8, 0.122144, 2.7931],
    [1123.5, 170.2, 0.100959, -1.7536],
    [1260.2, 341.4, 0.042424, 1.5230],
    [1462.6, 307.9, 0.430958, 0.9721],
    [1518.7, 498.0, 0.714361, 2.9586],
    [1699.8, 233.0, 0.074722, 1.2105],
    [1824.9, 175.0, 0.075486, -1.2809],
    [1992.6, 183.3, 0.067499, 2.9179],
    [2152.7, 327.9, 0.193635, -2.1643],
    [2294.4, 364.3, 0.134290, 0.0865],
    [2433.5, 276.5, 0.156634, 1.6507],
    [2581.0, 231.0, 0.132161, 0.4627],
    [2709.8, 434.1, 0.361548, 1.5798],
    [2887.7, 820.6, 0.492205, 2.1865],
    [2947.3, 1728.7, 0.789955, -1.8404],
    [3073.6, 180.8, 0.053585, 2.6751],
    [3237.3, 310.3, 0.068478, 2.3692],
    [3378.7, 278.5, 0.094657, -1.7699],
    [3550.4, 354.8, 0.071033, 0.0415],
    [3675.0, 234.5, 0.045475, -2.8501],
    [3878.2, 277.5, 0.012478, 0.6937],
    [4033.7, 384.5, 0.048415, 0.7649],
    [4149.5, 330.8, 0.116521, 2.9381],
    [4361.6, 152.1, 0.018996, -2.8963],
    [4542.4, 110.8, 0.012418, 1.1738],
    [4687.0, 624.5, 0.084069, 0.3465],
    [4912.3, 330.6, 0.052184, 1.8451],
    [5077.4, 1488.8, 0.291278, -3.1368],
    [5302.4, 102.9, 0.001891, -0.6975],
    [5842.0, 185.3, 0.014321, 2.8562],
    [6214.7, 350.0, 0.012156, 2.3301],
    [6754.5, 525.5, 0.032896, 1.9140],
    [7073.0, 310.0, 0.019004, -2.5897],
    [7772.4, 405.8, 0.017008, -3.0281],
    [9312.3, 6279.3, 0.099614, -2.6620],
    [10871.0, 743.8, 0.022956, 2.3736],
    [11961.8, 789.6, 0.045393, 2.9055],
    [12867.7, 567.4, 0.020146, 1.9538],
    [14305.3, 920.7, 0.002869, -1.5530],
    [14812.6, 919.1, 0.042921, 1.1903],
    [15414.7, 1850.4, 0.078196, -2.6095],
];

/// How far the tap's low body hump is pulled down against the mids and
/// highs, in dB. 0 keeps the recording as fitted (boomy, peaky in the low
/// hundreds of hertz); more flattens the board toward the mids.
pub const BOARD_HUMP_DB: f32 = 10.0;

/// Where the hump shelf hands over to the unshelved response.
pub const BOARD_HUMP_HZ: f32 = 500.0;

/// Overall level of the board, chosen so the voicing table stays near
/// unity with the board in the path.
pub const BOARD_GAIN: f32 = 0.1;

/// Left/right spread of the mode weights, as a fraction of each weight.
const BOARD_WIDTH: f32 = 0.25;

/// Modes whose frequency sits this close to Nyquist (or above) are left out
/// at that sample rate.
const NYQUIST_GUARD: f32 = 0.45;

const MODES: usize = BOARD_MODES.len();

/// The board's shelf weight for a mode at `hz`.
fn shelf(hz: f32) -> f32 {
    let floor = 10.0f32.powf(-BOARD_HUMP_DB / 20.0);
    floor + (1.0 - floor) * hz * hz / (hz * hz + BOARD_HUMP_HZ * BOARD_HUMP_HZ)
}

/// The board's steady-state magnitude response at `hz`, for the board as
/// built at `sample_rate` (the mean of the two sides). The strings use it
/// to level each key by what the board lets through of its partials.
pub fn board_magnitude(hz: f32, sample_rate: f32) -> f32 {
    let dt = 1.0 / sample_rate;
    let rate_scale = BOARD_FIT_RATE / sample_rate;
    let (zc, zs) = {
        let w = core::f32::consts::TAU * hz * dt;
        (w.cos(), -w.sin())
    };
    // z^-1 = e^{-jw} = (zc, zs); z^-2 = z^-1 squared.
    let (z2c, z2s) = (zc * zc - zs * zs, 2.0 * zc * zs);
    let (mut re, mut im) = (0.0f32, 0.0f32);
    for mode in BOARD_MODES.iter() {
        let [f, sigma, amp, phase] = *mode;
        if f >= NYQUIST_GUARD * sample_rate {
            continue;
        }
        let gain = amp * shelf(f) * rate_scale * BOARD_GAIN;
        let r = (-sigma * dt).exp();
        let theta = core::f32::consts::TAU * f * dt;
        let a1 = -2.0 * r * theta.cos();
        let a2 = r * r;
        let b0 = gain * phase.cos();
        let b1 = -gain * r * (phase - theta).cos();
        // (b0 + b1 z^-1) / (1 + a1 z^-1 + a2 z^-2)
        let (nr, ni) = (b0 + b1 * zc, b1 * zs);
        let (dr, di) = (1.0 + a1 * zc + a2 * z2c, a1 * zs + a2 * z2s);
        let d = dr * dr + di * di;
        re += (nr * dr + ni * di) / d;
        im += (ni * dr - nr * di) / d;
    }
    (re * re + im * im).sqrt()
}

/// One channel of the board: a bank of second-order resonators.
#[derive(Clone)]
pub struct Board {
    a1: [f32; MODES],
    a2: [f32; MODES],
    b0: [f32; MODES],
    b1: [f32; MODES],
    y1: [f32; MODES],
    y2: [f32; MODES],
    x1: f32,
}

impl Board {
    /// A board for one channel. `side` (0 or 1) selects which way the
    /// stereo nudge of each mode's weight goes.
    pub fn new(sample_rate: f32, side: u32) -> Self {
        let sample_rate = if sample_rate.is_finite() {
            sample_rate.clamp(8000.0, 384_000.0)
        } else {
            48_000.0
        };
        let dt = 1.0 / sample_rate;
        let mut board = Board {
            a1: [0.0; MODES],
            a2: [0.0; MODES],
            b0: [0.0; MODES],
            b1: [0.0; MODES],
            y1: [0.0; MODES],
            y2: [0.0; MODES],
            x1: 0.0,
        };
        // The tap was fitted at its own rate; a unit sample carries area
        // 1/sample_rate, so the gain follows the ratio of the rates.
        let rate_scale = BOARD_FIT_RATE / sample_rate;
        for (k, mode) in BOARD_MODES.iter().enumerate() {
            let [hz, sigma, amp, phase] = *mode;
            if hz >= NYQUIST_GUARD * sample_rate {
                continue;
            }
            // Nudge the weight one way on the left, the other on the right.
            let nudge = (key_hash(k as i16, 7) & 0xFFFF) as f32 / 65535.0;
            let spread =
                1.0 + BOARD_WIDTH * (2.0 * nudge - 1.0) * if side == 0 { 1.0 } else { -1.0 };
            let gain = amp * shelf(hz) * spread * rate_scale * BOARD_GAIN;
            let r = (-sigma * dt).exp();
            let theta = core::f32::consts::TAU * hz * dt;
            board.a1[k] = -2.0 * r * theta.cos();
            board.a2[k] = r * r;
            board.b0[k] = gain * phase.cos();
            board.b1[k] = -gain * r * (phase - theta).cos();
        }
        board
    }

    /// Silence the board's ring.
    pub fn clear(&mut self) {
        self.y1 = [0.0; MODES];
        self.y2 = [0.0; MODES];
        self.x1 = 0.0;
    }

    /// One sample in, one sample out.
    #[inline]
    pub fn step(&mut self, x: f32) -> f32 {
        let mut out = 0.0f32;
        for k in 0..MODES {
            let y = self.b0[k] * x + self.b1[k] * self.x1
                - self.a1[k] * self.y1[k]
                - self.a2[k] * self.y2[k];
            self.y2[k] = self.y1[k];
            self.y1[k] = y;
            out += y;
        }
        self.x1 = x;
        out
    }

    /// Flush a ring that has decayed below hearing to exact zero, so a
    /// silent board costs no denormal arithmetic. Call once per block.
    pub fn settle(&mut self) {
        for k in 0..MODES {
            if self.y1[k].abs() < 1.0e-18 && self.y2[k].abs() < 1.0e-18 {
                self.y1[k] = 0.0;
                self.y2[k] = 0.0;
            }
        }
    }
}
