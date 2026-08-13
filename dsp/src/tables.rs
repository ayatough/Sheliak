//! Procedural wavetable generation + per-octave FFT mipmaps (docs/architecture.md).
//!
//! # Registry
//!
//! | id | name         | frames | content                                  |
//! |----|--------------|--------|------------------------------------------|
//! | 0  | basic/sine   | 1      | sine                                     |
//! | 1  | basic/tri    | 1      | triangle                                 |
//! | 2  | basic/saw    | 1      | sawtooth                                 |
//! | 3  | basic/square | 1      | square                                   |
//! | 4  | morph/pwm    | 64     | pulse width 50% → 5%                      |
//! | 5  | morph/fold   | 64     | sine wavefolder, amount 1.0 → 5.0         |
//!
//! # How the frames are built
//!
//! Every frame is described by its **harmonic series** `(a_k, b_k)` — i.e.
//! `x(t) = Σ_k a_k·cos(2πkt) + b_k·sin(2πkt)` — up to `FRAME_LEN/2` harmonics.
//! For sine/tri/saw/square/pwm those coefficients are known analytically, so
//! the base frames are *exactly* band-limited by construction (naively
//! sampling an ideal saw at 2048 points would already bake in aliasing near
//! the top of the spectrum). `morph/fold` is a nonlinearity with no closed
//! form, so it is rendered 4× oversampled (8192 points) and analysed with a
//! forward FFT to recover its harmonics.
//!
//! DC (`k = 0`) is always forced to zero. This matters for `morph/pwm`, whose
//! narrow-pulse frames would otherwise carry up to −0.9 of DC offset and blow
//! the DC test.
//!
//! # Mipmaps
//!
//! Mip level `k` keeps harmonics `1..=1024>>k`. Playback picks
//! `level = log2(f · 4096 / sr)`, so a fundamental in level `k`'s octave is at
//! most `sr·2^k/2048` Hz and its highest retained partial is at most
//! `(1024>>k) · sr·2^k/2048 = sr/2` — i.e. every retained partial sits below
//! Nyquist across the whole octave the level is responsible for. 11 levels
//! cover `sr/4096` Hz (≈11.7 Hz @48k) up to Nyquist.
//!
//! Higher mips need far fewer samples, so each level is stored at a reduced
//! length `L_k = clamp(pow2_ceil(16·H_k), 64, 2048)` — always at least 16×
//! oversampled relative to its own band limit (except the two lowest levels,
//! which are capped at the source length of 2048). That keeps the 4-point
//! Hermite interpolation error far below the −60 dB alias floor while cutting
//! table memory from ~12 MB to ~5.5 MB.
//!
//! Each stored frame is surrounded by guard samples so the Hermite kernel can
//! read `x[i-1..=i+2]` with no wrapping branch: the layout is
//! `[x[L-1], x[0..L], x[0], x[1], x[2]]`, hence `stride = L + 4` and the four
//! taps for integer index `i` are simply `data[base+i .. base+i+4]`.

use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;

use crate::params::{FRAME_LEN, TABLE_COUNT};

/// Number of octave mipmap levels.
pub const NUM_MIPS: usize = 11;
/// Guard samples appended per stored frame (see module docs).
pub const GUARD: usize = 4;
/// Harmonics retained by mip level 0.
const MAX_HARM: usize = FRAME_LEN / 2;
/// Oversampling factor used to analyse the wavefolder.
const FOLD_FFT: usize = FRAME_LEN * 4;
/// Frames in the morph tables (docs/architecture.md).
const MORPH_FRAMES: usize = 64;

/// Description of one mipmap level inside [`Table::data`].
#[derive(Copy, Clone, Debug, Default)]
pub struct Mip {
    /// Offset of the level's first frame within `data`.
    pub offset: u32,
    /// `log2(len)` — the phase accumulator is shifted right by `32 - bits`.
    pub bits: u32,
    /// Distance between consecutive frames of this level (`len + GUARD`).
    pub stride: u32,
}

/// One wavetable: `frames` morph frames × [`NUM_MIPS`] band-limited copies.
pub struct Table {
    pub frames: u32,
    pub mips: [Mip; NUM_MIPS],
    pub data: Vec<f32>,
}

/// Harmonics retained by mip level `k`.
#[inline]
pub fn mip_harmonics(k: usize) -> usize {
    (MAX_HARM >> k).max(1)
}

/// Stored sample count of mip level `k`.
#[inline]
pub fn mip_len(k: usize) -> usize {
    let want = (mip_harmonics(k) * 16).next_power_of_two();
    want.clamp(64, FRAME_LEN)
}

/// 4-point, 3rd-order Hermite (Catmull-Rom) interpolation.
#[inline(always)]
pub fn hermite(y0: f32, y1: f32, y2: f32, y3: f32, t: f32) -> f32 {
    let c1 = 0.5 * (y2 - y0);
    let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    ((c3 * t + c2) * t + c1) * t + y1
}

impl Table {
    /// Interpolated sample of one mip level, blending two adjacent morph
    /// frames linearly (docs/architecture.md: Hermite between samples, linear between frames).
    #[inline(always)]
    pub fn sample_mip(&self, m: &Mip, fr0: u32, fr1: u32, ffrac: f32, phase: u32) -> f32 {
        let idx = (phase >> (32 - m.bits)) as usize;
        let t = ((phase << m.bits) as f32) * (1.0 / 4_294_967_296.0);
        let stride = m.stride as usize;
        let b0 = m.offset as usize + fr0 as usize * stride + idx;
        let d = &self.data[b0..b0 + 4];
        let s0 = hermite(d[0], d[1], d[2], d[3], t);
        if fr0 == fr1 {
            return s0;
        }
        let b1 = m.offset as usize + fr1 as usize * stride + idx;
        let d = &self.data[b1..b1 + 4];
        let s1 = hermite(d[0], d[1], d[2], d[3], t);
        s0 + (s1 - s0) * ffrac
    }

    fn push_frame(&mut self, time: &[f32]) {
        let len = time.len();
        self.data.push(time[len - 1]);
        self.data.extend_from_slice(time);
        self.data.push(time[0]);
        self.data.push(time[1 % len]);
        self.data.push(time[2 % len]);
    }
}

/// `(a_k, b_k)` harmonic coefficients of one frame, index 0 unused (DC = 0).
type Spectrum = Vec<Complex32>;

fn empty_spectrum() -> Spectrum {
    vec![Complex32::new(0.0, 0.0); MAX_HARM + 1]
}

fn sine_spectrum() -> Spectrum {
    let mut s = empty_spectrum();
    s[1].im = 1.0;
    s
}

fn saw_spectrum() -> Spectrum {
    // x(t) = 2t - 1  =>  b_k = -2/(πk)
    let mut s = empty_spectrum();
    for (k, c) in s.iter_mut().enumerate().skip(1) {
        c.im = -2.0 / (std::f32::consts::PI * k as f32);
    }
    s
}

fn tri_spectrum() -> Spectrum {
    // b_k = 8/(π²k²)·sin(kπ/2) for odd k
    let mut s = empty_spectrum();
    let mut sign = 1.0f32;
    let mut k = 1;
    while k <= MAX_HARM {
        s[k].im = sign * 8.0 / (std::f32::consts::PI * std::f32::consts::PI * (k * k) as f32);
        sign = -sign;
        k += 2;
    }
    s
}

/// Bipolar pulse of duty `d`, DC removed.
///
/// `c_k = [sin θ − i(1 − cos θ)] / (πk)` with `θ = 2πkd`, and the real series
/// coefficients follow as `a_k = 2·Re(c_k)`, `b_k = −2·Im(c_k)`.
fn pulse_spectrum(d: f32) -> Spectrum {
    let mut s = empty_spectrum();
    for (k, c) in s.iter_mut().enumerate().skip(1) {
        let theta = 2.0 * std::f32::consts::PI * k as f32 * d;
        let inv = 1.0 / (std::f32::consts::PI * k as f32);
        c.re = 2.0 * theta.sin() * inv;
        c.im = 2.0 * (1.0 - theta.cos()) * inv;
    }
    s
}

/// Triangle wavefolder: reflects the input back into [-1, 1].
#[inline]
fn wavefold(x: f32) -> f32 {
    // asin(sin(·)) is the exact triangle fold, and this runs at table-build
    // time only.
    (x * std::f32::consts::FRAC_PI_2).sin().asin() * std::f32::consts::FRAC_2_PI
}

fn fold_spectrum(amount: f32, planner: &mut FftPlanner<f32>) -> Spectrum {
    let fft = planner.plan_fft_forward(FOLD_FFT);
    let mut buf: Vec<Complex32> = (0..FOLD_FFT)
        .map(|n| {
            let t = n as f32 / FOLD_FFT as f32;
            let x = wavefold(amount * (2.0 * std::f32::consts::PI * t).sin());
            Complex32::new(x, 0.0)
        })
        .collect();
    fft.process(&mut buf);
    let norm = 2.0 / FOLD_FFT as f32;
    let mut s = empty_spectrum();
    for (k, c) in s.iter_mut().enumerate().skip(1) {
        c.re = buf[k].re * norm;
        c.im = -buf[k].im * norm;
    }
    s
}

fn table_spectra(id: usize, planner: &mut FftPlanner<f32>) -> Vec<Spectrum> {
    match id {
        0 => vec![sine_spectrum()],
        1 => vec![tri_spectrum()],
        2 => vec![saw_spectrum()],
        3 => vec![pulse_spectrum(0.5)],
        4 => (0..MORPH_FRAMES)
            .map(|i| {
                let f = i as f32 / (MORPH_FRAMES - 1) as f32;
                pulse_spectrum(0.5 - 0.45 * f)
            })
            .collect(),
        _ => (0..MORPH_FRAMES)
            .map(|i| {
                let f = i as f32 / (MORPH_FRAMES - 1) as f32;
                fold_spectrum(1.0 + 4.0 * f, planner)
            })
            .collect(),
    }
}

fn build_table(id: usize, planner: &mut FftPlanner<f32>) -> Table {
    let spectra = table_spectra(id, planner);
    let nframes = spectra.len();

    let mut table = Table {
        frames: nframes as u32,
        mips: [Mip::default(); NUM_MIPS],
        data: Vec::new(),
    };

    let total: usize = (0..NUM_MIPS).map(|k| (mip_len(k) + GUARD) * nframes).sum();
    table.data.reserve_exact(total);

    let mut time = vec![0.0f32; FRAME_LEN];
    let mut offset = 0usize;
    for k in 0..NUM_MIPS {
        let len = mip_len(k);
        let stride = len + GUARD;
        table.mips[k] = Mip {
            offset: offset as u32,
            bits: len.trailing_zeros(),
            stride: stride as u32,
        };
        // The Nyquist bin of the reduced-length IFFT cannot carry a sine
        // component, so cap one below it.
        let hmax = mip_harmonics(k).min(len / 2 - 1);
        let ifft = planner.plan_fft_inverse(len);
        let mut buf = vec![Complex32::new(0.0, 0.0); len];
        for spec in &spectra {
            for c in buf.iter_mut() {
                *c = Complex32::new(0.0, 0.0);
            }
            for h in 1..=hmax {
                let a = spec[h].re;
                let b = spec[h].im;
                buf[h] = Complex32::new(0.5 * a, -0.5 * b);
                buf[len - h] = Complex32::new(0.5 * a, 0.5 * b);
            }
            ifft.process(&mut buf);
            for (dst, src) in time[..len].iter_mut().zip(buf.iter()) {
                *dst = src.re;
            }
            table.push_frame(&time[..len]);
        }
        offset += stride * nframes;
    }

    // Normalise the whole table with a single scalar so that morphing and mip
    // crossfades never step in level; peak ends up at exactly 1.0.
    let peak = table.data.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    if peak > 1.0e-9 {
        let g = 1.0 / peak;
        for v in table.data.iter_mut() {
            *v *= g;
        }
    }
    table
}

/// Builds the whole registry. Allocation-heavy: only ever called from `init()`.
pub fn build_all() -> Vec<Table> {
    let mut planner = FftPlanner::<f32>::new();
    (0..TABLE_COUNT)
        .map(|id| build_table(id, &mut planner))
        .collect()
}
