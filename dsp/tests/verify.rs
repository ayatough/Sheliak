//! Offline verification of the DSP core (docs/development.md).
//!
//! 1. determinism — same patch + seed + sample rate ⇒ bit-identical output,
//!    for both the v0.1 voice path and the full v0.2 noise + 8-effect chain
//! 2. aliasing    — saw at ~C7, non-harmonic spectrum ≥60 dB below fundamental
//! 3. DC / level  — sustained supersaw, and dist + reverb, stay DC-free/unclipped
//! 4. click       — note on/off and a mid-note cutoff jump stay continuous
//! 5. noise       — deterministic, colours differ, disabled is a true no-op
//! 6. FX          — empty chain is a bit-exact bypass, mbcomp is transparent
//!    below threshold, and delay/reverb tails decay without runaway
//! 7. unit checks — detune curve symmetry, mipmap band limits
//! 8. note events — the per-note `glide_s`/`legato` arguments default to the
//!    old behaviour bit for bit, and a legato note-on bends pitch without
//!    retriggering the envelope or clicking

use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;

use sheliak_dsp::multi::{soft_clip_master, CLIP_KNEE};
use sheliak_dsp::noise::Noise;
use sheliak_dsp::oscillator::{detune_offsets, mip_level_for};
use sheliak_dsp::params::*;
use sheliak_dsp::tables::{mip_harmonics, mip_len, NUM_MIPS};
use sheliak_dsp::{MultiEngine, Track};

const SR: f32 = 48_000.0;

// ---------------------------------------------------------------- harness

#[derive(Clone)]
enum Ev {
    On(usize, f32, f32),
    /// Note-on with the full ABI: track, note, velocity, `glide_s`, legato.
    OnEx(usize, f32, f32, f32, bool),
    Off(usize, f32),
    Patch(usize, Box<[f32; PARAM_COUNT]>),
}

/// Renders `total` samples, dispatching events at sample-accurate offsets the
/// same way `web/public/worklet.js` is specified to (docs/architecture.md): split the
/// render quantum at the event boundary, never larger than MAX_BLOCK.
/// Every event carries its track index (v0.3).
fn render(engine: &mut MultiEngine, events: &[(usize, Ev)], total: usize) -> (Vec<f32>, Vec<f32>) {
    let mut l = vec![0.0f32; total];
    let mut r = vec![0.0f32; total];
    let mut pos = 0usize;
    let mut next = 0usize;
    while pos < total {
        while next < events.len() && events[next].0 <= pos {
            match &events[next].1 {
                Ev::On(t, n, v) => engine.note_on(*t, *n, *v),
                Ev::OnEx(t, n, v, g, l) => engine.note_on_ex(*t, *n, *v, *g, *l),
                Ev::Off(t, n) => engine.note_off(*t, *n),
                Ev::Patch(t, p) => engine.apply_patch(*t, p),
            }
            next += 1;
        }
        let mut len = MAX_BLOCK.min(total - pos);
        if next < events.len() {
            len = len.min(events[next].0 - pos);
        }
        assert!(len > 0);
        engine.process(&mut l[pos..pos + len], &mut r[pos..pos + len]);
        pos += len;
    }
    (l, r)
}

fn base_params() -> [f32; PARAM_COUNT] {
    let mut p = [0.0f32; PARAM_COUNT];
    p[P_POLYPHONY] = 8.0;
    p[P_GLIDE_S] = 0.0;
    p[P_MASTER_GAIN] = 0.5;
    p[P_SEED] = 42.0;

    p[OSC_A_BASE + OSC_ENABLED] = 1.0;
    p[OSC_A_BASE + OSC_TABLE_ID] = TABLE_SAW as f32;
    p[OSC_A_BASE + OSC_LEVEL] = 1.0;
    p[OSC_A_BASE + OSC_UNISON] = 1.0;
    p[OSC_A_BASE + OSC_PHASE_RANDOM] = 1.0;

    p[OSC_B_BASE + OSC_ENABLED] = 0.0;
    p[OSC_B_BASE + OSC_TABLE_ID] = TABLE_SAW as f32;
    p[OSC_B_BASE + OSC_LEVEL] = 1.0;
    p[OSC_B_BASE + OSC_UNISON] = 1.0;

    p[P_FILTER_MODE] = 0.0;
    p[P_FILTER_CUTOFF_HZ] = 20_000.0;
    p[P_FILTER_RES] = 0.0;
    p[P_FILTER_DRIVE] = 0.0;
    p[P_FILTER_KEYTRACK] = 0.0;

    p[ENV_AMP_BASE + ENV_A] = 0.005;
    p[ENV_AMP_BASE + ENV_D] = 0.2;
    p[ENV_AMP_BASE + ENV_S] = 0.7;
    p[ENV_AMP_BASE + ENV_R] = 0.12;

    p[ENV_FILTER_BASE + ENV_A] = 0.002;
    p[ENV_FILTER_BASE + ENV_D] = 0.4;
    p[ENV_FILTER_BASE + ENV_S] = 0.0;
    p[ENV_FILTER_BASE + ENV_R] = 0.1;

    p[P_LFO_WAVE] = 1.0;
    p[P_LFO_RATE_HZ] = 1.0;
    p[P_LFO_PHASE] = 0.0;
    p
}

/// Writes one parameter of an effect's 8-float block.
fn fxp(p: &mut [f32; PARAM_COUNT], ty: u32, off: usize, v: f32) {
    p[FX_PARAMS_BASE + (ty as usize - 1) * FX_PARAMS_STRIDE + off] = v;
}

/// Fills every effect's parameter block with a musically sensible setting.
/// Does *not* touch FX_ORDER — the caller decides which ones run.
fn fill_all_fx_params(p: &mut [f32; PARAM_COUNT]) {
    fxp(p, FX_DIST, DIST_DRIVE, 0.35);
    fxp(p, FX_DIST, DIST_MIX, 0.6);
    fxp(p, FX_DIST, DIST_MODE, 0.0);
    fxp(p, FX_DIST, DIST_TONE_HZ, 9_000.0);

    fxp(p, FX_EQ, EQ_LOW_DB, 3.0);
    fxp(p, FX_EQ, EQ_MID_DB, -2.5);
    fxp(p, FX_EQ, EQ_HIGH_DB, 4.0);
    fxp(p, FX_EQ, EQ_MID_FREQ_HZ, 1_200.0);

    fxp(p, FX_CHORUS, CHORUS_RATE_HZ, 0.8);
    fxp(p, FX_CHORUS, CHORUS_DEPTH, 0.4);
    fxp(p, FX_CHORUS, CHORUS_MIX, 0.35);

    fxp(p, FX_PHASER, PHASER_RATE_HZ, 0.4);
    fxp(p, FX_PHASER, PHASER_DEPTH, 0.7);
    fxp(p, FX_PHASER, PHASER_FEEDBACK, 0.4);
    fxp(p, FX_PHASER, PHASER_MIX, 0.4);
    fxp(p, FX_PHASER, PHASER_STAGES, 6.0);
    fxp(p, FX_PHASER, PHASER_CENTER_HZ, 800.0);

    fxp(p, FX_FLANGER, FLANGER_RATE_HZ, 0.25);
    fxp(p, FX_FLANGER, FLANGER_DEPTH, 0.6);
    fxp(p, FX_FLANGER, FLANGER_FEEDBACK, 0.5);
    fxp(p, FX_FLANGER, FLANGER_MIX, 0.35);

    fxp(p, FX_DELAY, DELAY_TIME_S, 0.28);
    fxp(p, FX_DELAY, DELAY_FEEDBACK, 0.45);
    fxp(p, FX_DELAY, DELAY_MIX, 0.25);
    fxp(p, FX_DELAY, DELAY_PINGPONG, 1.0);
    fxp(p, FX_DELAY, DELAY_TONE_HZ, 4_000.0);

    fxp(p, FX_REVERB, REVERB_SIZE, 0.6);
    fxp(p, FX_REVERB, REVERB_DAMP, 0.5);
    fxp(p, FX_REVERB, REVERB_MIX, 0.2);
    fxp(p, FX_REVERB, REVERB_PREDELAY_S, 0.02);
    fxp(p, FX_REVERB, REVERB_WIDTH, 1.0);

    fxp(p, FX_MBCOMP, MBCOMP_THRESH_LOW_DB, -18.0);
    fxp(p, FX_MBCOMP, MBCOMP_THRESH_MID_DB, -20.0);
    fxp(p, FX_MBCOMP, MBCOMP_THRESH_HIGH_DB, -22.0);
    fxp(p, FX_MBCOMP, MBCOMP_RATIO, 3.0);
    fxp(p, FX_MBCOMP, MBCOMP_ATTACK_S, 0.01);
    fxp(p, FX_MBCOMP, MBCOMP_RELEASE_S, 0.12);
    fxp(p, FX_MBCOMP, MBCOMP_MAKEUP, 1.4);
}

/// Puts all eight effects in the chain, in type order.
fn chain_all(p: &mut [f32; PARAM_COUNT]) {
    for (i, ty) in [
        FX_DIST, FX_EQ, FX_CHORUS, FX_PHASER, FX_FLANGER, FX_DELAY, FX_REVERB, FX_MBCOMP,
    ]
    .iter()
    .enumerate()
    {
        p[FX_ORDER_BASE + i] = *ty as f32;
    }
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
}

fn assert_bit_identical(a: &[f32], b: &[f32], what: &str) {
    assert_eq!(a.len(), b.len());
    for i in 0..a.len() {
        assert_eq!(
            a[i].to_bits(),
            b[i].to_bits(),
            "{what}: sample {i} differs ({} vs {})",
            a[i],
            b[i]
        );
    }
}

fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

fn mean(x: &[f32]) -> f32 {
    x.iter().sum::<f32>() / x.len() as f32
}

fn max_delta(x: &[f32]) -> (f32, usize) {
    let mut best = 0.0f32;
    let mut at = 0usize;
    for i in 1..x.len() {
        let d = (x[i] - x[i - 1]).abs();
        if d > best {
            best = d;
            at = i;
        }
    }
    (best, at)
}

// ------------------------------------------------------------ 1. determinism

#[test]
fn determinism_is_bit_exact() {
    let mut p = base_params();
    // Exercise the interesting machinery: unison, morph table, mod matrix, LFO.
    p[OSC_A_BASE + OSC_UNISON] = 7.0;
    p[OSC_A_BASE + OSC_DETUNE_CENTS] = 22.0;
    p[OSC_A_BASE + OSC_SPREAD] = 0.8;
    p[OSC_B_BASE + OSC_ENABLED] = 1.0;
    p[OSC_B_BASE + OSC_TABLE_ID] = TABLE_PWM as f32;
    p[OSC_B_BASE + OSC_MORPH] = 0.4;
    p[OSC_B_BASE + OSC_TUNE_SEMI] = -12.0;
    p[OSC_B_BASE + OSC_UNISON] = 3.0;
    p[OSC_B_BASE + OSC_DETUNE_CENTS] = 9.0;
    p[P_FILTER_CUTOFF_HZ] = 900.0;
    p[P_FILTER_RES] = 0.4;
    p[P_FILTER_DRIVE] = 0.3;
    p[P_FILTER_KEYTRACK] = 0.5;
    p[MOD_BASE + MOD_SRC] = 1.0; // env.filter
    p[MOD_BASE + MOD_DST] = DST_FILTER_CUTOFF as f32;
    p[MOD_BASE + MOD_AMOUNT] = 2400.0;
    p[MOD_BASE + MOD_STRIDE + MOD_SRC] = 3.0; // lfo.1
    p[MOD_BASE + MOD_STRIDE + MOD_DST] = DST_OSC2_MORPH as f32;
    p[MOD_BASE + MOD_STRIDE + MOD_AMOUNT] = 0.25;
    p[MOD_BASE + 2 * MOD_STRIDE + MOD_SRC] = 4.0; // velocity
    p[MOD_BASE + 2 * MOD_STRIDE + MOD_DST] = DST_AMP as f32;
    p[MOD_BASE + 2 * MOD_STRIDE + MOD_AMOUNT] = -0.2;

    let half = SR as usize / 2;
    let events = vec![
        (0usize, Ev::Patch(0, Box::new(p))),
        (0, Ev::On(0, 48.0, 0.8)),
        (137, Ev::On(0, 55.0, 0.6)),
        (half, Ev::Off(0, 48.0)),
        (half + 1000, Ev::Off(0, 55.0)),
    ];
    let total = SR as usize;

    let mut a = MultiEngine::new(SR);
    let (al, ar) = render(&mut a, &events, total);
    let mut b = MultiEngine::new(SR);
    let (bl, br) = render(&mut b, &events, total);

    assert!(peak(&al) > 0.01, "render produced no signal");
    for i in 0..total {
        assert_eq!(
            al[i].to_bits(),
            bl[i].to_bits(),
            "L differs at sample {i}: {} vs {}",
            al[i],
            bl[i]
        );
        assert_eq!(ar[i].to_bits(), br[i].to_bits(), "R differs at sample {i}");
    }
}

// --------------------------------------------------------------- 2. aliasing

/// Fundamental is nudged onto an exact FFT bin (2095.0 Hz ≈ C7 + 1.6 cents) so
/// that the Hann window leaks into ±1 bin only and a ±2 bin exclusion around
/// each true harmonic is enough to isolate genuine alias products.
#[test]
fn aliasing_floor_below_minus_60db() {
    const N: usize = 16_384;
    let bin_hz = SR / N as f32;
    let f0 = 715.0 * bin_hz; // 2095.0 Hz
    let note = 69.0 + 12.0 * (f0 / 440.0).log2();

    let mut p = base_params();
    p[P_MASTER_GAIN] = 1.0;
    p[ENV_AMP_BASE + ENV_A] = 0.001;
    p[ENV_AMP_BASE + ENV_D] = 0.001;
    p[ENV_AMP_BASE + ENV_S] = 1.0;
    p[OSC_A_BASE + OSC_TABLE_ID] = TABLE_SAW as f32;

    let total = SR as usize;
    let mut e = MultiEngine::new(SR);
    let events = vec![
        (0usize, Ev::Patch(0, Box::new(p))),
        (0, Ev::On(0, note, 1.0)),
    ];
    let (l, _r) = render(&mut e, &events, total);

    // Analyse a window well inside the sustain.
    let start = SR as usize / 4;
    let mut buf: Vec<Complex32> = (0..N)
        .map(|i| {
            let w = 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / N as f32).cos();
            Complex32::new(l[start + i] * w, 0.0)
        })
        .collect();
    FftPlanner::<f32>::new()
        .plan_fft_forward(N)
        .process(&mut buf);

    let mag: Vec<f32> = buf[..N / 2].iter().map(|c| c.norm()).collect();
    let fund = mag[715];
    assert!(fund > 1.0, "fundamental too weak: {fund}");

    let nyq_harmonic = ((SR * 0.5) / f0) as usize; // highest legitimate partial
    let mut worst = 0.0f32;
    let mut worst_bin = 0usize;
    for (b, m) in mag.iter().enumerate().skip(3) {
        let is_harmonic = (1..=nyq_harmonic).any(|h| {
            let hb = 715 * h;
            b + 2 >= hb && b <= hb + 2
        });
        if !is_harmonic && *m > worst {
            worst = *m;
            worst_bin = b;
        }
    }
    let db = 20.0 * (worst / fund).log10();
    assert!(
        db <= -60.0,
        "alias/noise peak at bin {worst_bin} ({:.1} Hz) is {db:.1} dB below the fundamental",
        worst_bin as f32 * bin_hz
    );
}

// ------------------------------------------------------------- 3. DC / level

#[test]
fn supersaw_has_no_dc_and_does_not_clip() {
    let mut p = base_params();
    p[OSC_A_BASE + OSC_UNISON] = 7.0;
    p[OSC_A_BASE + OSC_DETUNE_CENTS] = 22.0;
    p[OSC_A_BASE + OSC_SPREAD] = 0.8;
    p[ENV_AMP_BASE + ENV_S] = 1.0;
    p[P_FILTER_CUTOFF_HZ] = 12_000.0;

    let total = SR as usize;
    let mut e = MultiEngine::new(SR);
    let events = vec![
        (0usize, Ev::Patch(0, Box::new(p))),
        (0, Ev::On(0, 48.0, 1.0)),
    ];
    let (l, r) = render(&mut e, &events, total);

    // Skip the attack so the measurement is of the sustained tone.
    let tail = SR as usize / 10;
    let dl = mean(&l[tail..]).abs();
    let dr = mean(&r[tail..]).abs();
    assert!(dl < 1.0e-3 && dr < 1.0e-3, "DC offset L={dl} R={dr}");

    let pl = peak(&l);
    let pr = peak(&r);
    assert!(pl > 0.05 && pr > 0.05, "supersaw is silent ({pl}, {pr})");
    assert!(pl <= 1.0 && pr <= 1.0, "clipping: L={pl} R={pr}");
}

#[test]
fn full_polyphony_is_finite_and_bounded() {
    let mut p = base_params();
    p[OSC_A_BASE + OSC_UNISON] = 7.0;
    p[OSC_A_BASE + OSC_DETUNE_CENTS] = 18.0;
    p[OSC_A_BASE + OSC_SPREAD] = 1.0;
    p[OSC_B_BASE + OSC_ENABLED] = 1.0;
    p[OSC_B_BASE + OSC_UNISON] = 7.0;
    p[OSC_B_BASE + OSC_TABLE_ID] = TABLE_FOLD as f32;
    p[P_POLYPHONY] = 16.0;
    p[P_MASTER_GAIN] = 0.1;

    let mut e = MultiEngine::new(SR);
    let mut events: Vec<(usize, Ev)> = vec![(0, Ev::Patch(0, Box::new(p)))];
    // 20 note-ons over 16 voices: forces stealing.
    for i in 0..20 {
        events.push((i * 500, Ev::On(0, 36.0 + i as f32 * 2.0, 0.9)));
    }
    let (l, r) = render(&mut e, &events, SR as usize);
    assert!(l.iter().all(|v| v.is_finite()));
    assert!(r.iter().all(|v| v.is_finite()));
    assert!(peak(&l) < 4.0, "runaway level {}", peak(&l));
    assert!(e.active_voices() <= MAX_VOICES);
}

// ------------------------------------------------------------------ 4. click

/// A band-limited saw legitimately moves ~1.0 in two samples at its flyback,
/// so continuity is measured on a sine — any real discontinuity from an
/// envelope, a steal fade or a parameter jump then stands out immediately.
#[test]
fn note_events_and_patch_jumps_are_click_free() {
    let mut p = base_params();
    p[OSC_A_BASE + OSC_TABLE_ID] = TABLE_SINE as f32;
    p[ENV_AMP_BASE + ENV_S] = 1.0;
    p[P_MASTER_GAIN] = 1.0;

    let mut jump = p;
    jump[P_FILTER_CUTOFF_HZ] = 300.0; // 20 kHz → 300 Hz mid-note
    jump[P_FILTER_RES] = 0.7;
    jump[OSC_A_BASE + OSC_LEVEL] = 0.4;

    let sr = SR as usize;
    let mut e = MultiEngine::new(SR);
    let events = vec![
        (0usize, Ev::Patch(0, Box::new(p))),
        (0, Ev::On(0, 48.0, 1.0)),
        (sr / 4, Ev::Patch(0, Box::new(jump))),
        (sr / 2, Ev::On(0, 52.0, 1.0)),
        (3 * sr / 4, Ev::Off(0, 48.0)),
        (3 * sr / 4 + 100, Ev::Off(0, 52.0)),
    ];
    let (l, r) = render(&mut e, &events, sr);

    let (dl, at_l) = max_delta(&l);
    let (dr, _) = max_delta(&r);
    assert!(peak(&l) > 0.05, "silent render");
    assert!(
        dl < 0.25 && dr < 0.25,
        "discontinuity {dl} at sample {at_l} (R {dr})"
    );
}

#[test]
fn voice_steal_is_click_free() {
    let mut p = base_params();
    p[OSC_A_BASE + OSC_TABLE_ID] = TABLE_SINE as f32;
    p[ENV_AMP_BASE + ENV_S] = 1.0;
    p[P_POLYPHONY] = 2.0;
    p[P_MASTER_GAIN] = 1.0;

    let sr = SR as usize;
    let mut e = MultiEngine::new(SR);
    let events = vec![
        (0usize, Ev::Patch(0, Box::new(p))),
        (0, Ev::On(0, 48.0, 1.0)),
        (2000, Ev::On(0, 52.0, 1.0)),
        // third note steals the oldest voice while it is at full level
        (8000, Ev::On(0, 55.0, 1.0)),
        (16000, Ev::On(0, 59.0, 1.0)),
    ];
    let (l, _r) = render(&mut e, &events, sr / 2);
    let (d, at) = max_delta(&l);
    assert!(d < 0.25, "steal discontinuity {d} at sample {at}");
}

#[test]
fn all_notes_off_fades_quickly_and_silently() {
    let mut p = base_params();
    p[OSC_A_BASE + OSC_TABLE_ID] = TABLE_SINE as f32;
    p[ENV_AMP_BASE + ENV_S] = 1.0;

    let mut e = MultiEngine::new(SR);
    e.apply_patch(0, &p);
    e.note_on(0, 48.0, 1.0);
    let mut l = vec![0.0f32; 4096];
    let mut r = vec![0.0f32; 4096];
    e.render(&mut l, &mut r);
    e.all_notes_off();
    let mut l2 = vec![0.0f32; 4096];
    let mut r2 = vec![0.0f32; 4096];
    e.render(&mut l2, &mut r2);

    let mut joined = l.clone();
    joined.extend_from_slice(&l2);
    let (d, at) = max_delta(&joined);
    assert!(d < 0.25, "all_notes_off discontinuity {d} at {at}");
    // silent within ~3 ms (1.5 ms fade + at most one block of latency)
    let tail = &l2[512..];
    assert!(peak(tail) == 0.0, "still ringing: {}", peak(tail));
    assert_eq!(e.active_voices(), 0);
}

// ------------------------------------------------------------- 5. unit tests

#[test]
fn detune_offsets_are_symmetric_and_nonlinear() {
    for n in 1..=MAX_UNISON {
        let o = detune_offsets(n);
        for i in 0..n {
            assert_eq!(
                o[i],
                -o[n - 1 - i],
                "unison {n}: offset {i} is not the mirror of {}",
                n - 1 - i
            );
        }
        if n > 1 {
            assert!((o[0] + 1.0).abs() < 1e-6 && (o[n - 1] - 1.0).abs() < 1e-6);
            for i in 1..n {
                assert!(o[i] > o[i - 1], "unison {n} offsets must be increasing");
            }
        }
        if n % 2 == 1 {
            assert_eq!(o[n / 2], 0.0, "odd unison count must have a centre voice");
        }
        for v in o.iter().take(n) {
            assert!(v.abs() <= 1.0);
        }
    }

    // Non-linear "packed centre" JP-8000 shape: the inner voices sit closer
    // together than a linear spread would put them.
    let o = detune_offsets(7);
    assert!(o[4] < 2.0 / 6.0, "curve should compress toward the centre");
    assert!(
        (o[4] - 0.2686).abs() < 0.05,
        "should track Szabo's measurement"
    );
    assert!(
        (o[5] - 0.6156).abs() < 0.05,
        "should track Szabo's measurement"
    );
}

#[test]
fn mip_selection_keeps_every_partial_below_nyquist() {
    // Level k is responsible for fundamentals in [2^k, 2^(k+1))·sr/4096.
    for k in 0..NUM_MIPS {
        let f_lo = SR / 4096.0 * (1 << k) as f32;
        let f_hi = f_lo * 2.0;
        assert_eq!(mip_level_for(f_lo, SR).floor() as usize, k);
        let top = mip_harmonics(k).min(mip_len(k) / 2 - 1) as f32 * f_hi;
        assert!(
            top <= SR * 0.5 + 1.0,
            "mip {k}: top partial {top} Hz exceeds Nyquist"
        );
        // ≥16× oversampled relative to its own band limit (except the two
        // lowest levels, which are capped at the 2048-sample source length).
        if mip_len(k) < FRAME_LEN {
            assert!(mip_len(k) >= 16 * mip_harmonics(k).min(mip_len(k) / 2 - 1));
        }
    }
    // Clamped at both ends.
    assert_eq!(mip_level_for(1.0, SR), 0.0);
    assert_eq!(mip_level_for(SR, SR), (NUM_MIPS - 1) as f32);
}

#[test]
fn tables_are_normalised_and_dc_free() {
    let e = MultiEngine::new(SR);
    for (id, t) in e.tables().iter().enumerate() {
        let p = t.data.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((p - 1.0).abs() < 1e-5, "table {id} peak {p}");
        // Mip 0, frame 0 must have (near) zero mean — pulse frames especially.
        let m = t.mips[0];
        for f in 0..t.frames as usize {
            let base = m.offset as usize + f * m.stride as usize + 1;
            let len = m.stride as usize - 4;
            let s: f32 = t.data[base..base + len].iter().sum::<f32>() / len as f32;
            assert!(s.abs() < 1e-4, "table {id} frame {f} has DC {s}");
        }
    }
}

// ============================================================ v0.2: noise

#[test]
fn noise_is_deterministic() {
    let mut p = base_params();
    p[OSC_A_BASE + OSC_LEVEL] = 0.5;
    p[NOISE_BASE + NOISE_ENABLED] = 1.0;
    p[NOISE_BASE + NOISE_LEVEL] = 0.8;
    p[NOISE_BASE + NOISE_COLOR] = 1.0; // pink
    p[ENV_AMP_BASE + ENV_S] = 1.0;
    p[P_FILTER_CUTOFF_HZ] = 6_000.0;

    let events = vec![
        (0usize, Ev::Patch(0, Box::new(p))),
        (0, Ev::On(0, 45.0, 0.9)),
        (5_000, Ev::On(0, 52.0, 0.7)),
        (20_000, Ev::Off(0, 45.0)),
    ];
    let total = SR as usize / 2;

    let mut a = MultiEngine::new(SR);
    let (al, ar) = render(&mut a, &events, total);
    let mut b = MultiEngine::new(SR);
    let (bl, br) = render(&mut b, &events, total);

    assert!(peak(&al) > 0.01, "noise patch produced no signal");
    assert_bit_identical(&al, &bl, "noise L");
    assert_bit_identical(&ar, &br, "noise R");
}

#[test]
fn noise_colours_differ_and_share_rms() {
    // Straight from the generator: 1/√3 is the RMS of uniform white.
    let mut white = Noise::default();
    white.note_on(1234, 48.0, 0);
    let w: Vec<f32> = (0..120_000).map(|_| white.next()).collect();
    let mut pink = Noise::default();
    pink.note_on(1234, 48.0, 1);
    let k: Vec<f32> = (0..120_000).map(|_| pink.next()).collect();

    let (rw, rk) = (rms(&w), rms(&k));
    let db = 20.0 * (rk / rw).log10();
    assert!(db.abs() < 1.0, "white {rw} vs pink {rk} differ by {db} dB");
    assert!((rw - 1.0 / 3.0f32.sqrt()).abs() < 0.01, "white RMS {rw}");

    // Pink must actually be filtered: neighbouring samples correlate.
    let corr = |x: &[f32]| {
        let mut acc = 0.0f64;
        for i in 1..x.len() {
            acc += (x[i] * x[i - 1]) as f64;
        }
        acc / (x.len() - 1) as f64 / (rms(x) * rms(x)) as f64
    };
    assert!(corr(&w).abs() < 0.02, "white should be uncorrelated");
    assert!(corr(&k) > 0.5, "pink should be strongly correlated");

    // And the two colours must not produce the same stream.
    assert!(w.iter().zip(k.iter()).any(|(a, b)| a != b));
}

#[test]
fn disabled_noise_is_a_true_no_op() {
    // Same patch twice, except one has a loud noise layer that is *disabled*.
    // Bit-identical output proves the disabled path adds nothing, consumes no
    // shared randomness and leaves no DC behind.
    let mut off = base_params();
    off[ENV_AMP_BASE + ENV_S] = 1.0;
    let mut loud_but_off = off;
    loud_but_off[NOISE_BASE + NOISE_ENABLED] = 0.0;
    loud_but_off[NOISE_BASE + NOISE_LEVEL] = 4.0;
    loud_but_off[NOISE_BASE + NOISE_COLOR] = 1.0;

    let events_a = vec![
        (0usize, Ev::Patch(0, Box::new(off))),
        (0, Ev::On(0, 48.0, 1.0)),
    ];
    let events_b = vec![
        (0usize, Ev::Patch(0, Box::new(loud_but_off))),
        (0, Ev::On(0, 48.0, 1.0)),
    ];
    let n = SR as usize / 4;
    let mut a = MultiEngine::new(SR);
    let (al, ar) = render(&mut a, &events_a, n);
    let mut b = MultiEngine::new(SR);
    let (bl, br) = render(&mut b, &events_b, n);
    assert_bit_identical(&al, &bl, "disabled noise L");
    assert_bit_identical(&ar, &br, "disabled noise R");
}

// =============================================================== v0.2: FX

#[test]
fn determinism_with_full_fx_chain() {
    let mut p = base_params();
    p[OSC_A_BASE + OSC_UNISON] = 7.0;
    p[OSC_A_BASE + OSC_DETUNE_CENTS] = 20.0;
    p[OSC_A_BASE + OSC_SPREAD] = 0.9;
    p[OSC_B_BASE + OSC_ENABLED] = 1.0;
    p[OSC_B_BASE + OSC_TABLE_ID] = TABLE_FOLD as f32;
    p[OSC_B_BASE + OSC_MORPH] = 0.6;
    p[OSC_B_BASE + OSC_UNISON] = 3.0;
    p[NOISE_BASE + NOISE_ENABLED] = 1.0;
    p[NOISE_BASE + NOISE_LEVEL] = 0.3;
    p[NOISE_BASE + NOISE_COLOR] = 1.0;
    p[P_FILTER_CUTOFF_HZ] = 3_000.0;
    p[P_FILTER_RES] = 0.4;
    p[MOD_BASE + MOD_SRC] = 1.0;
    p[MOD_BASE + MOD_DST] = DST_FILTER_CUTOFF as f32;
    p[MOD_BASE + MOD_AMOUNT] = 2_400.0;
    fill_all_fx_params(&mut p);
    chain_all(&mut p);

    // A second patch mid-render exercises hot reload through the chain too.
    let mut p2 = p;
    fxp(&mut p2, FX_DELAY, DELAY_TIME_S, 0.15);
    fxp(&mut p2, FX_REVERB, REVERB_SIZE, 0.85);
    fxp(&mut p2, FX_DIST, DIST_MODE, 1.0);

    let sr = SR as usize;
    let events = vec![
        (0usize, Ev::Patch(0, Box::new(p))),
        (0, Ev::On(0, 43.0, 0.9)),
        (211, Ev::On(0, 50.0, 0.6)),
        (sr / 3, Ev::Patch(0, Box::new(p2))),
        (sr / 2, Ev::Off(0, 43.0)),
        (sr / 2 + 777, Ev::Off(0, 50.0)),
    ];

    let mut a = MultiEngine::new(SR);
    let (al, ar) = render(&mut a, &events, sr);
    let mut b = MultiEngine::new(SR);
    let (bl, br) = render(&mut b, &events, sr);

    assert!(peak(&al) > 0.01, "full-chain render produced no signal");
    assert!(al.iter().all(|v| v.is_finite()));
    assert_bit_identical(&al, &bl, "full fx chain L");
    assert_bit_identical(&ar, &br, "full fx chain R");
}

#[test]
fn empty_fx_chain_is_a_bit_exact_bypass() {
    // Identical patches; one carries a fully populated FX parameter area but
    // an empty FX_ORDER. Nothing may reach the bus.
    let mut plain = base_params();
    plain[OSC_A_BASE + OSC_UNISON] = 5.0;
    plain[OSC_A_BASE + OSC_DETUNE_CENTS] = 15.0;
    plain[NOISE_BASE + NOISE_ENABLED] = 1.0;
    plain[NOISE_BASE + NOISE_LEVEL] = 0.2;

    let mut with_params = plain;
    fill_all_fx_params(&mut with_params);
    // FX_ORDER left at all-zero.

    let events_a = vec![
        (0usize, Ev::Patch(0, Box::new(plain))),
        (0, Ev::On(0, 48.0, 1.0)),
    ];
    let events_b = vec![
        (0usize, Ev::Patch(0, Box::new(with_params))),
        (0, Ev::On(0, 48.0, 1.0)),
    ];
    let n = SR as usize / 2;
    let mut a = MultiEngine::new(SR);
    let (al, ar) = render(&mut a, &events_a, n);
    let mut b = MultiEngine::new(SR);
    let (bl, br) = render(&mut b, &events_b, n);

    assert!(peak(&al) > 0.01);
    assert_bit_identical(&al, &bl, "empty chain bypass L");
    assert_bit_identical(&ar, &br, "empty chain bypass R");
}

#[test]
fn mbcomp_below_threshold_is_transparent() {
    // Thresholds parked at +12 dBFS: nothing can trigger, makeup is unity, so
    // the crossover must reconstruct the input. The matched complementary
    // one-pole split reconstructs sample-for-sample (see fx/mbcomp.rs), so the
    // tolerance here is far tighter than the 1e-2 the contract asks for.
    let mut plain = base_params();
    plain[ENV_AMP_BASE + ENV_S] = 1.0;
    plain[OSC_A_BASE + OSC_UNISON] = 5.0;
    plain[OSC_A_BASE + OSC_DETUNE_CENTS] = 18.0;

    let mut comp = plain;
    comp[FX_ORDER_BASE] = FX_MBCOMP as f32;
    fxp(&mut comp, FX_MBCOMP, MBCOMP_THRESH_LOW_DB, 12.0);
    fxp(&mut comp, FX_MBCOMP, MBCOMP_THRESH_MID_DB, 12.0);
    fxp(&mut comp, FX_MBCOMP, MBCOMP_THRESH_HIGH_DB, 12.0);
    fxp(&mut comp, FX_MBCOMP, MBCOMP_RATIO, 4.0);
    fxp(&mut comp, FX_MBCOMP, MBCOMP_ATTACK_S, 0.01);
    fxp(&mut comp, FX_MBCOMP, MBCOMP_RELEASE_S, 0.12);
    fxp(&mut comp, FX_MBCOMP, MBCOMP_MAKEUP, 1.0);

    let n = SR as usize / 2;
    let mut a = MultiEngine::new(SR);
    let (al, _ar) = render(
        &mut a,
        &[
            (0usize, Ev::Patch(0, Box::new(plain))),
            (0, Ev::On(0, 48.0, 1.0)),
        ],
        n,
    );
    let mut b = MultiEngine::new(SR);
    let (bl, _br) = render(
        &mut b,
        &[
            (0usize, Ev::Patch(0, Box::new(comp))),
            (0, Ev::On(0, 48.0, 1.0)),
        ],
        n,
    );

    let reference = peak(&al);
    assert!(reference > 0.05);
    let err = al
        .iter()
        .zip(bl.iter())
        .fold(0.0f32, |m, (x, y)| m.max((x - y).abs()));
    assert!(
        err / reference < 1.0e-2,
        "mbcomp is not transparent below threshold: rel err {}",
        err / reference
    );
}

#[test]
fn delay_and_reverb_tails_decay_without_runaway() {
    let mut p = base_params();
    p[P_MASTER_GAIN] = 0.5;
    p[FX_ORDER_BASE] = FX_DELAY as f32;
    p[FX_ORDER_BASE + 1] = FX_REVERB as f32;
    fxp(&mut p, FX_DELAY, DELAY_TIME_S, 0.2);
    fxp(&mut p, FX_DELAY, DELAY_FEEDBACK, 0.9); // top of the allowed range
    fxp(&mut p, FX_DELAY, DELAY_MIX, 0.5);
    fxp(&mut p, FX_DELAY, DELAY_PINGPONG, 1.0);
    fxp(&mut p, FX_DELAY, DELAY_TONE_HZ, 4_000.0);
    fxp(&mut p, FX_REVERB, REVERB_SIZE, 0.7);
    fxp(&mut p, FX_REVERB, REVERB_DAMP, 0.4);
    fxp(&mut p, FX_REVERB, REVERB_MIX, 0.4);
    fxp(&mut p, FX_REVERB, REVERB_WIDTH, 1.0);

    let mut e = MultiEngine::new(SR);
    e.apply_patch(0, &p);
    e.note_on(0, 48.0, 1.0);
    let half = SR as usize / 2;
    let (mut l, mut r) = (vec![0.0f32; half], vec![0.0f32; half]);
    e.render(&mut l, &mut r);
    let note_peak = peak(&l);
    assert!(note_peak > 0.05);
    e.note_off(0, 48.0);

    // 0.5 s after note-off the amp envelope (120 ms release) is long gone,
    // so anything left is the FX tail.
    let (mut l, mut r) = (vec![0.0f32; half], vec![0.0f32; half]);
    e.render(&mut l, &mut r);
    assert_eq!(e.active_voices(), 0, "voice should have been released");
    let tail = peak(&l[half / 2..]);
    assert!(
        tail > note_peak * 1.0e-3,
        "no audible tail after release: {tail}"
    );

    // ...and it must run down instead of self-oscillating.
    let mut prev = tail;
    let mut last = 0.0f32;
    for sec in 0..14 {
        let (mut l, mut r) = (vec![0.0f32; SR as usize], vec![0.0f32; SR as usize]);
        e.render(&mut l, &mut r);
        assert!(l.iter().all(|v| v.is_finite()), "non-finite tail");
        last = peak(&l);
        assert!(
            last <= prev * 1.05,
            "tail grew at second {sec}: {prev} -> {last}"
        );
        prev = last;
        if last < note_peak * 1.0e-3 {
            break;
        }
    }
    let db = 20.0 * (last / note_peak).log10();
    assert!(
        db < -60.0,
        "tail never fell below -60 dB (reached {db:.1} dB)"
    );
}

#[test]
fn dist_and_reverb_stay_dc_free_and_unclipped() {
    // docs/syntax.md default-ish dist + reverb over a supersaw with a noise layer.
    let mut p = base_params();
    p[OSC_A_BASE + OSC_UNISON] = 7.0;
    p[OSC_A_BASE + OSC_DETUNE_CENTS] = 22.0;
    p[OSC_A_BASE + OSC_SPREAD] = 0.8;
    p[ENV_AMP_BASE + ENV_S] = 1.0;
    p[NOISE_BASE + NOISE_ENABLED] = 1.0;
    p[NOISE_BASE + NOISE_LEVEL] = 0.25;
    p[FX_ORDER_BASE] = FX_DIST as f32;
    p[FX_ORDER_BASE + 1] = FX_REVERB as f32;
    fxp(&mut p, FX_DIST, DIST_DRIVE, 0.3);
    fxp(&mut p, FX_DIST, DIST_MIX, 1.0);
    fxp(&mut p, FX_DIST, DIST_MODE, 0.0);
    fxp(&mut p, FX_DIST, DIST_TONE_HZ, 20_000.0);
    fxp(&mut p, FX_REVERB, REVERB_SIZE, 0.6);
    fxp(&mut p, FX_REVERB, REVERB_DAMP, 0.5);
    fxp(&mut p, FX_REVERB, REVERB_MIX, 0.2);
    fxp(&mut p, FX_REVERB, REVERB_PREDELAY_S, 0.02);
    fxp(&mut p, FX_REVERB, REVERB_WIDTH, 1.0);

    let total = SR as usize;
    let mut e = MultiEngine::new(SR);
    let (l, r) = render(
        &mut e,
        &[
            (0usize, Ev::Patch(0, Box::new(p))),
            (0, Ev::On(0, 48.0, 1.0)),
        ],
        total,
    );

    let tail = SR as usize / 10;
    let dl = mean(&l[tail..]).abs();
    let dr = mean(&r[tail..]).abs();
    assert!(dl < 1.0e-3 && dr < 1.0e-3, "DC offset L={dl} R={dr}");
    let (pl, pr) = (peak(&l), peak(&r));
    assert!(pl > 0.05 && pr > 0.05, "silent ({pl}, {pr})");
    assert!(pl <= 1.0 && pr <= 1.0, "clipping: L={pl} R={pr}");
}

#[test]
fn every_effect_alone_is_stable_and_finite() {
    for ty in [
        FX_DIST, FX_EQ, FX_CHORUS, FX_PHASER, FX_FLANGER, FX_DELAY, FX_REVERB, FX_MBCOMP,
    ] {
        let mut p = base_params();
        p[ENV_AMP_BASE + ENV_S] = 1.0;
        fill_all_fx_params(&mut p);
        // Push every feedback path to its maximum for this stability check.
        fxp(&mut p, FX_DELAY, DELAY_FEEDBACK, 1.0);
        fxp(&mut p, FX_FLANGER, FLANGER_FEEDBACK, 1.0);
        fxp(&mut p, FX_PHASER, PHASER_FEEDBACK, 1.0);
        fxp(&mut p, FX_REVERB, REVERB_SIZE, 1.0);
        fxp(&mut p, FX_DIST, DIST_DRIVE, 1.0);
        p[FX_ORDER_BASE] = ty as f32;

        let mut e = MultiEngine::new(SR);
        let (l, r) = render(
            &mut e,
            &[
                (0usize, Ev::Patch(0, Box::new(p))),
                (0, Ev::On(0, 48.0, 1.0)),
                (SR as usize / 4, Ev::Off(0, 48.0)),
            ],
            SR as usize,
        );
        assert!(
            l.iter().all(|v| v.is_finite()),
            "fx {ty} produced non-finite L"
        );
        assert!(
            r.iter().all(|v| v.is_finite()),
            "fx {ty} produced non-finite R"
        );
        assert!(peak(&l) < 4.0, "fx {ty} runaway: peak {}", peak(&l));
    }
}

#[test]
fn fx_order_is_respected_and_deduplicated() {
    // dist → delay and delay → dist are different signal chains.
    let mut a = base_params();
    a[ENV_AMP_BASE + ENV_S] = 1.0;
    fill_all_fx_params(&mut a);
    fxp(&mut a, FX_DIST, DIST_DRIVE, 0.9);
    fxp(&mut a, FX_DIST, DIST_MIX, 1.0);
    fxp(&mut a, FX_DELAY, DELAY_MIX, 0.5);
    fxp(&mut a, FX_DELAY, DELAY_FEEDBACK, 0.6);
    let mut b = a;
    a[FX_ORDER_BASE] = FX_DIST as f32;
    a[FX_ORDER_BASE + 1] = FX_DELAY as f32;
    b[FX_ORDER_BASE] = FX_DELAY as f32;
    b[FX_ORDER_BASE + 1] = FX_DIST as f32;
    // A duplicate type must be ignored rather than processed twice.
    let mut c = a;
    c[FX_ORDER_BASE + 2] = FX_DIST as f32;
    c[FX_ORDER_BASE + 3] = FX_DELAY as f32;

    let n = SR as usize / 2;
    let run = |p: [f32; PARAM_COUNT]| {
        let mut e = MultiEngine::new(SR);
        render(
            &mut e,
            &[
                (0usize, Ev::Patch(0, Box::new(p))),
                (0, Ev::On(0, 48.0, 1.0)),
            ],
            n,
        )
        .0
    };
    let (ra, rb, rc) = (run(a), run(b), run(c));
    assert!(
        ra.iter()
            .zip(rb.iter())
            .any(|(x, y)| (x - y).abs() > 1.0e-4),
        "chain order had no effect"
    );
    assert_bit_identical(&ra, &rc, "duplicate fx types must be ignored");
}

#[test]
fn fx_hot_reload_is_click_free() {
    // A sine carrier makes any discontinuity obvious (see the note on the
    // saw flyback above). Every continuous FX parameter is yanked mid-note.
    let mut p = base_params();
    p[OSC_A_BASE + OSC_TABLE_ID] = TABLE_SINE as f32;
    p[ENV_AMP_BASE + ENV_S] = 1.0;
    p[P_MASTER_GAIN] = 1.0;
    fill_all_fx_params(&mut p);
    chain_all(&mut p);

    let mut jump = p;
    fxp(&mut jump, FX_DIST, DIST_DRIVE, 0.95);
    fxp(&mut jump, FX_DIST, DIST_MIX, 1.0);
    fxp(&mut jump, FX_EQ, EQ_LOW_DB, -12.0);
    fxp(&mut jump, FX_EQ, EQ_HIGH_DB, 12.0);
    fxp(&mut jump, FX_CHORUS, CHORUS_DEPTH, 1.0);
    fxp(&mut jump, FX_CHORUS, CHORUS_MIX, 1.0);
    fxp(&mut jump, FX_PHASER, PHASER_FEEDBACK, 0.9);
    fxp(&mut jump, FX_FLANGER, FLANGER_MIX, 1.0);
    fxp(&mut jump, FX_DELAY, DELAY_TIME_S, 0.05);
    fxp(&mut jump, FX_DELAY, DELAY_MIX, 0.8);
    fxp(&mut jump, FX_REVERB, REVERB_SIZE, 1.0);
    fxp(&mut jump, FX_REVERB, REVERB_MIX, 0.9);
    fxp(&mut jump, FX_MBCOMP, MBCOMP_MAKEUP, 2.0);

    let sr = SR as usize;
    let mut e = MultiEngine::new(SR);
    let (l, r) = render(
        &mut e,
        &[
            (0usize, Ev::Patch(0, Box::new(p))),
            (0, Ev::On(0, 48.0, 1.0)),
            (sr / 3, Ev::Patch(0, Box::new(jump))),
            (2 * sr / 3, Ev::Patch(0, Box::new(p))),
        ],
        sr,
    );
    let (dl, at) = max_delta(&l);
    let (dr, _) = max_delta(&r);
    assert!(peak(&l) > 0.02, "silent render");
    assert!(
        dl < 0.25 && dr < 0.25,
        "fx hot-reload discontinuity {dl} at sample {at} (R {dr})"
    );
}

#[test]
fn delay_reaches_its_two_second_maximum() {
    // Verifies the delay line really is allocated for the full 2 s the
    // contract allows: a short blip must reappear ~2 s later, once.
    let mut p = base_params();
    p[P_MASTER_GAIN] = 1.0;
    p[OSC_A_BASE + OSC_TABLE_ID] = TABLE_SINE as f32;
    p[ENV_AMP_BASE + ENV_R] = 0.01;
    p[FX_ORDER_BASE] = FX_DELAY as f32;
    fxp(&mut p, FX_DELAY, DELAY_TIME_S, 2.0);
    fxp(&mut p, FX_DELAY, DELAY_FEEDBACK, 0.0);
    fxp(&mut p, FX_DELAY, DELAY_MIX, 1.0);
    fxp(&mut p, FX_DELAY, DELAY_TONE_HZ, 18_000.0);

    let sr = SR as usize;
    let mut e = MultiEngine::new(SR);
    let (l, _r) = render(
        &mut e,
        &[
            (0usize, Ev::Patch(0, Box::new(p))),
            (0, Ev::On(0, 60.0, 1.0)),
            (sr / 10, Ev::Off(0, 60.0)),
        ],
        3 * sr,
    );

    // Fully wet: nothing until the repeat arrives.
    assert!(peak(&l[..sr]) < 1.0e-4, "wet-only delay leaked dry signal");
    let echo = peak(&l[2 * sr - sr / 20..2 * sr + sr / 5]);
    assert!(echo > 0.02, "no echo at 2 s: {echo}");
    assert!(
        peak(&l[2 * sr + sr / 2..]) < echo * 0.05,
        "echo repeated with feedback at 0"
    );
}

// ====================================================== v0.3: multi-track

/// Supersaw lead, for track 0.
fn lead_patch() -> [f32; PARAM_COUNT] {
    let mut p = base_params();
    p[P_SEED] = 11.0;
    p[OSC_A_BASE + OSC_UNISON] = 7.0;
    p[OSC_A_BASE + OSC_DETUNE_CENTS] = 20.0;
    p[OSC_A_BASE + OSC_SPREAD] = 0.85;
    p[P_FILTER_CUTOFF_HZ] = 2_400.0;
    p[P_FILTER_RES] = 0.35;
    p[MOD_BASE + MOD_SRC] = 1.0;
    p[MOD_BASE + MOD_DST] = DST_FILTER_CUTOFF as f32;
    p[MOD_BASE + MOD_AMOUNT] = 3_600.0;
    p
}

/// Sine "kick": the filter envelope sweeps *pitch* down fast.
fn kick_patch() -> [f32; PARAM_COUNT] {
    let mut p = base_params();
    p[P_SEED] = 22.0;
    p[P_POLYPHONY] = 2.0;
    p[OSC_A_BASE + OSC_TABLE_ID] = TABLE_SINE as f32;
    p[OSC_A_BASE + OSC_PHASE_RANDOM] = 0.0;
    p[ENV_AMP_BASE + ENV_A] = 0.001;
    p[ENV_AMP_BASE + ENV_D] = 0.18;
    p[ENV_AMP_BASE + ENV_S] = 0.0;
    p[ENV_AMP_BASE + ENV_R] = 0.05;
    p[ENV_FILTER_BASE + ENV_A] = 0.0005;
    p[ENV_FILTER_BASE + ENV_D] = 0.045;
    p[ENV_FILTER_BASE + ENV_S] = 0.0;
    p[MOD_BASE + MOD_SRC] = 1.0; // env.filter
    p[MOD_BASE + MOD_DST] = DST_PITCH as f32;
    p[MOD_BASE + MOD_AMOUNT] = 3_600.0; // +3 octaves at the transient
    p
}

/// Noise-only "hat": both oscillators off, pink noise through a 12 dB highpass.
fn hat_patch() -> [f32; PARAM_COUNT] {
    let mut p = base_params();
    p[P_SEED] = 33.0;
    p[OSC_A_BASE + OSC_ENABLED] = 0.0;
    p[OSC_B_BASE + OSC_ENABLED] = 0.0;
    p[NOISE_BASE + NOISE_ENABLED] = 1.0;
    p[NOISE_BASE + NOISE_LEVEL] = 0.7;
    p[NOISE_BASE + NOISE_COLOR] = 1.0;
    p[P_FILTER_MODE] = 2.0; // hp12
    p[P_FILTER_CUTOFF_HZ] = 7_000.0;
    p[P_FILTER_RES] = 0.3;
    p[ENV_AMP_BASE + ENV_A] = 0.0005;
    p[ENV_AMP_BASE + ENV_D] = 0.04;
    p[ENV_AMP_BASE + ENV_S] = 0.0;
    p[ENV_AMP_BASE + ENV_R] = 0.03;
    p
}

/// Interleaved events across three tracks, as a loop player would emit them.
fn three_track_events() -> Vec<(usize, Ev)> {
    let sr = SR as usize;
    let mut ev: Vec<(usize, Ev)> = vec![
        (0, Ev::Patch(0, Box::new(lead_patch()))),
        (0, Ev::Patch(1, Box::new(kick_patch()))),
        (0, Ev::Patch(2, Box::new(hat_patch()))),
    ];
    // 8th-note grid over one second.
    for step in 0..8 {
        let t = step * sr / 8;
        if step % 2 == 0 {
            ev.push((t, Ev::On(1, 36.0, 1.0)));
            ev.push((t + 900, Ev::Off(1, 36.0)));
        }
        ev.push((t + 37, Ev::On(2, 90.0, 0.7)));
        ev.push((t + 37 + 400, Ev::Off(2, 90.0)));
        if step % 4 == 0 {
            let note = 48.0 + (step / 4) as f32 * 3.0;
            ev.push((t + 11, Ev::On(0, note, 0.9)));
            ev.push((t + sr / 5, Ev::Off(0, note)));
        }
    }
    ev.sort_by_key(|(t, _)| *t);
    ev
}

#[test]
fn multi_track_determinism_is_bit_exact() {
    let events = three_track_events();
    let total = SR as usize;

    let mut a = MultiEngine::new(SR);
    let (al, ar) = render(&mut a, &events, total);
    let mut b = MultiEngine::new(SR);
    let (bl, br) = render(&mut b, &events, total);

    assert!(peak(&al) > 0.05, "three-track render produced no signal");
    assert!(al.iter().all(|v| v.is_finite()));
    assert_bit_identical(&al, &bl, "multi-track L");
    assert_bit_identical(&ar, &br, "multi-track R");
}

#[test]
fn idle_tracks_are_bit_exactly_inert() {
    // Track 0 alone, versus track 0 with a fully patched but never-played
    // track 1 sitting next to it (FX chain and all).
    let mut other = lead_patch();
    fill_all_fx_params(&mut other);
    chain_all(&mut other);

    let events_solo = vec![
        (0usize, Ev::Patch(0, Box::new(lead_patch()))),
        (0, Ev::On(0, 50.0, 0.9)),
        (SR as usize / 3, Ev::Off(0, 50.0)),
    ];
    let mut events_pair = events_solo.clone();
    events_pair.insert(1, (0, Ev::Patch(1, Box::new(other))));

    let n = SR as usize;
    let mut a = MultiEngine::new(SR);
    let (al, ar) = render(&mut a, &events_solo, n);
    let mut b = MultiEngine::new(SR);
    let (bl, br) = render(&mut b, &events_pair, n);

    assert!(peak(&al) > 0.05);
    assert_bit_identical(&al, &bl, "silent neighbour track L");
    assert_bit_identical(&ar, &br, "silent neighbour track R");
    assert_eq!(b.track_active_voices(1), 0);
    // The neighbour parks itself once its (silent) tail window elapses.
    let mut l = vec![0.0f32; 4 * SR as usize];
    let mut r = vec![0.0f32; 4 * SR as usize];
    b.render(&mut l, &mut r);
    assert_eq!(b.live_tracks(), 0, "silent tracks should go dormant");
}

#[test]
fn unpatched_tracks_cost_nothing() {
    let mut e = MultiEngine::new(SR);
    assert_eq!(e.live_tracks(), 0);
    e.apply_patch(0, &lead_patch());
    e.note_on(0, 48.0, 1.0);
    let mut l = vec![0.0f32; 1024];
    let mut r = vec![0.0f32; 1024];
    e.render(&mut l, &mut r);
    assert_eq!(e.live_tracks(), 1, "only the patched track should render");
    assert!(peak(&l) > 0.01);
}

#[test]
fn master_guard_is_transparent_below_the_knee() {
    // Unit level: identity, bit for bit, below the knee.
    for i in 0..2001 {
        let x = -1.0 + i as f32 * 0.001;
        if x.abs() <= 0.95 {
            assert_eq!(
                soft_clip_master(x).to_bits(),
                x.to_bits(),
                "guard is not transparent at {x}"
            );
        } else {
            let y = soft_clip_master(x);
            assert!(y.abs() < 1.0, "guard failed to bound {x} -> {y}");
            assert!(y.abs() > 0.94 && y.signum() == x.signum());
        }
    }
    // C1 at the knee: the slope either side matches.
    let d = 1.0e-4;
    let below = (soft_clip_master(0.95) - soft_clip_master(0.95 - d)) / d;
    let above = (soft_clip_master(0.95 + d) - soft_clip_master(0.95)) / d;
    assert!(
        (below - above).abs() < 1.0e-2,
        "kink at the knee: {below} vs {above}"
    );

    // Engine level: a moderate single track goes through the master bus
    // unchanged relative to rendering that same Track standalone.
    let tables = sheliak_dsp::tables::build_all();
    let p = lead_patch();
    let n = SR as usize / 2;

    let mut multi = MultiEngine::new(SR);
    let (ml, mr) = render(
        &mut multi,
        &[
            (0usize, Ev::Patch(0, Box::new(p))),
            (0, Ev::On(0, 48.0, 0.9)),
        ],
        n,
    );

    let mut solo = Track::new(SR);
    solo.apply_patch(&p);
    solo.note_on(48.0, 0.9);
    let mut sl = vec![0.0f32; n];
    let mut sr_buf = vec![0.0f32; n];
    solo.render(&tables, &mut sl, &mut sr_buf);

    assert!(peak(&ml) > 0.05 && peak(&ml) < 0.95, "level {}", peak(&ml));
    assert_bit_identical(&ml, &sl, "master bus L");
    assert_bit_identical(&mr, &sr_buf, "master bus R");
}

#[test]
fn hot_multi_track_stack_cannot_clip() {
    // Six tracks, each deliberately over-driven, all playing at once.
    let mut e = MultiEngine::new(SR);
    for t in 0..6 {
        let mut p = lead_patch();
        p[P_SEED] = 100.0 + t as f32;
        p[P_MASTER_GAIN] = 2.0; // way past sensible
        p[P_FILTER_CUTOFF_HZ] = 18_000.0;
        p[ENV_AMP_BASE + ENV_S] = 1.0;
        p[NOISE_BASE + NOISE_ENABLED] = 1.0;
        p[NOISE_BASE + NOISE_LEVEL] = 0.5;
        e.apply_patch(t, &p);
        for k in 0..4 {
            e.note_on(t, 40.0 + t as f32 * 2.0 + k as f32 * 5.0, 1.0);
        }
    }
    let n = SR as usize / 2;
    let mut l = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    e.render(&mut l, &mut r);

    assert!(l.iter().all(|v| v.is_finite()) && r.iter().all(|v| v.is_finite()));
    assert!(peak(&l) > 0.9, "stack should actually be hitting the guard");
    assert!(
        peak(&l) <= 1.0 && peak(&r) <= 1.0,
        "clipped: {} {}",
        peak(&l),
        peak(&r)
    );
    assert_eq!(e.live_tracks(), 6);
}

#[test]
fn noise_only_patch_sounds_and_full_silence_is_exact() {
    // Both oscillators off + noise on ⇒ audible.
    let mut e = MultiEngine::new(SR);
    let (l, r) = render(
        &mut e,
        &[
            (0usize, Ev::Patch(0, Box::new(hat_patch()))),
            (0, Ev::On(0, 90.0, 1.0)),
        ],
        SR as usize / 4,
    );
    assert!(peak(&l) > 0.01, "noise-only patch is silent: {}", peak(&l));
    assert!(peak(&r) > 0.01);

    // Both oscillators off + noise off ⇒ *exact* digital silence.
    let mut mute = hat_patch();
    mute[NOISE_BASE + NOISE_ENABLED] = 0.0;
    let mut e = MultiEngine::new(SR);
    let (l, r) = render(
        &mut e,
        &[
            (0usize, Ev::Patch(0, Box::new(mute))),
            (0, Ev::On(0, 90.0, 1.0)),
        ],
        SR as usize / 4,
    );
    assert!(
        l.iter().chain(r.iter()).all(|v| *v == 0.0),
        "muted patch leaked signal: {}",
        peak(&l)
    );
}

#[test]
fn out_of_range_track_calls_are_no_ops() {
    let reference = {
        let mut e = MultiEngine::new(SR);
        render(
            &mut e,
            &[
                (0usize, Ev::Patch(0, Box::new(lead_patch()))),
                (0, Ev::On(0, 48.0, 0.9)),
            ],
            SR as usize / 4,
        )
    };

    let mut e = MultiEngine::new(SR);
    // Everything below must be silently ignored — and must not panic.
    e.apply_patch(MAX_TRACKS, &hat_patch());
    e.apply_patch(usize::MAX, &hat_patch());
    e.note_on(MAX_TRACKS, 60.0, 1.0);
    e.note_on(9_999, 60.0, 1.0);
    e.note_off(MAX_TRACKS, 60.0);
    assert!(e.track(MAX_TRACKS).is_none());
    assert_eq!(e.track_active_voices(MAX_TRACKS), 0);

    let (l, r) = render(
        &mut e,
        &[
            (0usize, Ev::Patch(0, Box::new(lead_patch()))),
            (0, Ev::On(0, 48.0, 0.9)),
        ],
        SR as usize / 4,
    );
    assert_eq!(e.active_voices(), 1);
    assert_bit_identical(&reference.0, &l, "out-of-range calls perturbed L");
    assert_bit_identical(&reference.1, &r, "out-of-range calls perturbed R");
}

#[test]
fn tracks_are_independently_seeded_and_isolated() {
    // Same patch on two tracks with different seeds must differ; identical
    // seeds on different tracks must produce identical audio.
    let render_track = |seed: f32, track: usize| {
        let mut p = lead_patch();
        p[P_SEED] = seed;
        let mut e = MultiEngine::new(SR);
        render(
            &mut e,
            &[
                (0usize, Ev::Patch(track, Box::new(p))),
                (0, Ev::On(track, 48.0, 0.9)),
            ],
            SR as usize / 4,
        )
        .0
    };
    let a = render_track(1.0, 0);
    let b = render_track(2.0, 0);
    let c = render_track(1.0, 3);
    assert!(a.iter().zip(b.iter()).any(|(x, y)| x != y), "seed ignored");
    assert_bit_identical(&a, &c, "track index must not change the sound");
}

// ============================== note events: per-note glide and legato (§10)

/// Rough fundamental of a monophonic signal from its zero crossings. Exact
/// enough for a sine: ±1 crossing over the window, so ±0.5 · SR / len Hz.
fn zc_hz(x: &[f32]) -> f32 {
    let mut n = 0usize;
    for i in 1..x.len() {
        if (x[i - 1] < 0.0) != (x[i] < 0.0) {
            n += 1;
        }
    }
    n as f32 * 0.5 * SR / x.len() as f32
}

/// A sine that decays to a low sustain, so an amplitude-envelope retrigger is
/// plainly visible in the RMS, and pitch is readable from zero crossings.
fn glide_patch() -> [f32; PARAM_COUNT] {
    let mut p = base_params();
    p[OSC_A_BASE + OSC_TABLE_ID] = TABLE_SINE as f32;
    p[OSC_A_BASE + OSC_PHASE_RANDOM] = 0.0;
    p[P_MASTER_GAIN] = 1.0;
    p[ENV_AMP_BASE + ENV_A] = 0.005;
    p[ENV_AMP_BASE + ENV_D] = 0.15;
    p[ENV_AMP_BASE + ENV_S] = 0.25;
    p
}

const HZ_48: f32 = 130.81; // note 48
const HZ_60: f32 = 261.63; // note 60

#[test]
fn the_new_note_on_arguments_default_to_todays_behaviour() {
    // The claim Track B rests on: the extra arguments are inaudible until
    // something asks for them. `-1` is what the worklet sends, and `NaN` is
    // what a host that still calls the export with three arguments produces
    // (JS turns the missing float into NaN).
    let events = three_track_events();
    let with_glide = |g: f32| -> Vec<(usize, Ev)> {
        events
            .iter()
            .map(|(t, e)| {
                let e = match e {
                    Ev::On(tr, n, v) => Ev::OnEx(*tr, *n, *v, g, false),
                    other => other.clone(),
                };
                (*t, e)
            })
            .collect()
    };

    let total = SR as usize;
    let mut a = MultiEngine::new(SR);
    let (al, ar) = render(&mut a, &events, total);
    assert!(peak(&al) > 0.05, "reference render produced no signal");

    for (label, g) in [("-1", -1.0f32), ("NaN", f32::NAN)] {
        let mut b = MultiEngine::new(SR);
        let (bl, br) = render(&mut b, &with_glide(g), total);
        assert_bit_identical(&al, &bl, &format!("glide_s = {label}, L"));
        assert_bit_identical(&ar, &br, &format!("glide_s = {label}, R"));
    }
}

#[test]
fn legato_note_on_bends_pitch_without_retriggering_or_clicking() {
    let p = glide_patch();
    let sr = SR as usize;
    let at = sr / 4; // well into the sustain
    let env_win = sr / 20; // 50 ms
    let pitch_win = sr / 5; // 200 ms

    let run = |second: Option<Ev>| {
        let mut ev: Vec<(usize, Ev)> = vec![
            (0usize, Ev::Patch(0, Box::new(p))),
            (0, Ev::On(0, 48.0, 1.0)),
        ];
        if let Some(e) = second {
            ev.push((at, e));
        }
        let mut engine = MultiEngine::new(SR);
        let (l, _r) = render(&mut engine, &ev, sr);
        (l, engine.active_voices())
    };

    let (held, _) = run(None);
    let (legato, voices) = run(Some(Ev::OnEx(0, 60.0, 1.0, 0.0, true)));
    let (retrig, retrig_voices) = run(Some(Ev::On(0, 60.0, 1.0)));

    // Nothing before the event may move.
    assert_bit_identical(&held[..at], &legato[..at], "before the legato note-on");

    // It is one voice that changed pitch, not a second one that started.
    assert_eq!(voices, 1, "legato must not allocate a voice");
    assert_eq!(
        retrig_voices, 2,
        "control: a plain note-on does allocate one"
    );
    let before = zc_hz(&legato[at - pitch_win..at]);
    let after = zc_hz(&legato[at..at + pitch_win]);
    assert!(
        (before - HZ_48).abs() < 4.0,
        "source pitch reads {before} Hz"
    );
    assert!(
        (after - HZ_60).abs() < 4.0,
        "legato did not reach note 60: {after} Hz"
    );

    // The amplitude envelope carried on: the same sustain level as the held
    // note, where a retrigger climbs back toward the peak.
    let rms_held = rms(&held[at..at + env_win]);
    let rms_legato = rms(&legato[at..at + env_win]);
    let rms_retrig = rms(&retrig[at..at + env_win]);
    assert!(rms_held > 0.01, "held note is silent");
    assert!(
        (rms_legato - rms_held).abs() / rms_held < 0.05,
        "envelope moved: held {rms_held} vs legato {rms_legato}"
    );
    assert!(
        rms_retrig > rms_legato * 1.5,
        "control: a retrigger should be louder ({rms_retrig} vs {rms_legato})"
    );

    // ...and it did not click. A 261.6 Hz sine at this level moves ~0.004 per
    // sample; a phase reset or an envelope jump is an order of magnitude more.
    let (d, sample) = max_delta(&legato);
    assert!(d < 0.02, "legato discontinuity {d} at sample {sample}");
}

#[test]
fn per_note_glide_overrides_the_patch_in_both_directions() {
    let sr = SR as usize;
    let at = sr / 4;
    let win = sr / 10; // 100 ms

    // The patch glides instantly; the note asks for a quarter-second slide.
    let mut ev = vec![
        (0usize, Ev::Patch(0, Box::new(glide_patch()))),
        (0, Ev::On(0, 48.0, 1.0)),
        (at, Ev::OnEx(0, 60.0, 1.0, 0.25, true)),
    ];
    let mut e = MultiEngine::new(SR);
    let (sliding, _) = render(&mut e, &ev, sr);

    let during = zc_hz(&sliding[at..at + win]);
    assert!(
        during > HZ_48 + 5.0 && during < HZ_60 - 40.0,
        "a 0.25 s slide should still be under way after 100 ms, not at {during} Hz"
    );
    let arrived = zc_hz(&sliding[sr - win..]);
    assert!(
        (arrived - HZ_60).abs() < 4.0,
        "the slide never arrived: {arrived} Hz"
    );
    let (d, sample) = max_delta(&sliding);
    assert!(d < 0.02, "glide discontinuity {d} at sample {sample}");

    // The other direction: a patch with glide, a note that asks for none.
    let mut p = glide_patch();
    p[P_GLIDE_S] = 0.25;
    ev[0] = (0, Ev::Patch(0, Box::new(p)));
    ev[2] = (at, Ev::OnEx(0, 60.0, 1.0, 0.0, true));
    let mut e = MultiEngine::new(SR);
    let (instant, _) = render(&mut e, &ev, sr);
    let jumped = zc_hz(&instant[at..at + win]);
    assert!(
        (jumped - HZ_60).abs() < 4.0,
        "glide_s = 0 should override the patch glide, but pitch reads {jumped} Hz"
    );
}

// ============================== stems (per-track taps)

/// Stereo audio: left and right, same length.
type Stereo = (Vec<f32>, Vec<f32>);

/// Renders like [`render`], but also collects each track's own output block by
/// block — which is the only way to read a stem, since the buffers hold one
/// block at a time.
fn render_with_stems(
    engine: &mut MultiEngine,
    events: &[(usize, Ev)],
    total: usize,
    tracks: usize,
) -> (Stereo, Vec<Stereo>) {
    let mut l = vec![0.0f32; total];
    let mut r = vec![0.0f32; total];
    let mut stems: Vec<Stereo> = (0..tracks)
        .map(|_| (Vec::with_capacity(total), Vec::with_capacity(total)))
        .collect();
    let mut pos = 0usize;
    let mut next = 0usize;
    while pos < total {
        while next < events.len() && events[next].0 <= pos {
            match &events[next].1 {
                Ev::On(t, n, v) => engine.note_on(*t, *n, *v),
                Ev::OnEx(t, n, v, g, lg) => engine.note_on_ex(*t, *n, *v, *g, *lg),
                Ev::Off(t, n) => engine.note_off(*t, *n),
                Ev::Patch(t, p) => engine.apply_patch(*t, p),
            }
            next += 1;
        }
        let mut len = MAX_BLOCK.min(total - pos);
        if next < events.len() {
            len = len.min(events[next].0 - pos);
        }
        assert!(len > 0);
        engine.process(&mut l[pos..pos + len], &mut r[pos..pos + len]);
        for (track, stem) in stems.iter_mut().enumerate() {
            let (sl, sr) = engine.track_out(track).expect("track in range");
            stem.0.extend_from_slice(&sl[..len]);
            stem.1.extend_from_slice(&sr[..len]);
        }
        pos += len;
    }
    ((l, r), stems)
}

#[test]
fn stems_sum_to_the_mix() {
    // The promise a stem export makes: the parts add up to the whole. It holds
    // bit for bit because the master bus does nothing but sum — the guard is
    // the identity below CLIP_KNEE, which two quiet tracks stay under.
    let mut lead = lead_patch();
    lead[P_MASTER_GAIN] = 0.25;
    let mut bass = lead_patch();
    bass[P_SEED] = 9.0;
    bass[P_MASTER_GAIN] = 0.25;

    let mut e = MultiEngine::new(SR);
    let ((mix_l, mix_r), stems) = render_with_stems(
        &mut e,
        &[
            (0usize, Ev::Patch(0, Box::new(lead))),
            (0, Ev::Patch(1, Box::new(bass))),
            (0, Ev::On(0, 60.0, 0.8)),
            (240, Ev::On(1, 36.0, 0.9)),
            (SR as usize / 8, Ev::Off(0, 60.0)),
        ],
        SR as usize / 4,
        2,
    );

    assert!(peak(&mix_l) < CLIP_KNEE, "test must stay under the guard");
    assert!(rms(&stems[0].0) > 0.0001, "the lead stem is silent");
    assert!(rms(&stems[1].0) > 0.0001, "the bass stem is silent");

    let sum_l: Vec<f32> = (0..mix_l.len())
        .map(|i| stems[0].0[i] + stems[1].0[i])
        .collect();
    let sum_r: Vec<f32> = (0..mix_r.len())
        .map(|i| stems[0].1[i] + stems[1].1[i])
        .collect();
    assert_bit_identical(&sum_l, &mix_l, "stems must sum to the mix (L)");
    assert_bit_identical(&sum_r, &mix_r, "stems must sum to the mix (R)");
}

#[test]
fn a_stem_carries_only_its_own_track() {
    // What makes it a stem rather than a copy of the mix: silence on a track
    // that was never asked to play, however loud the others are.
    let mut e = MultiEngine::new(SR);
    let (_, stems) = render_with_stems(
        &mut e,
        &[
            (0usize, Ev::Patch(0, Box::new(lead_patch()))),
            (0, Ev::Patch(1, Box::new(lead_patch()))),
            (0, Ev::On(0, 60.0, 0.9)),
        ],
        SR as usize / 8,
        2,
    );
    assert!(rms(&stems[0].0) > 0.001, "the playing track is silent");
    assert!(
        stems[1].0.iter().all(|v| *v == 0.0),
        "a track with no note must produce an empty stem"
    );
}

#[test]
fn a_dormant_track_does_not_repeat_its_last_block() {
    // The buffer is reused every block, so a track that falls dormant has to be
    // cleared rather than left holding the audio it stopped on.
    let mut short = lead_patch();
    short[ENV_AMP_BASE + ENV_D] = 0.005;
    short[ENV_AMP_BASE + ENV_S] = 0.0;
    short[ENV_AMP_BASE + ENV_R] = 0.005;

    let mut e = MultiEngine::new(SR);
    let (_, stems) = render_with_stems(
        &mut e,
        &[
            (0usize, Ev::Patch(0, Box::new(short))),
            (0, Ev::On(0, 60.0, 0.9)),
            (480, Ev::Off(0, 60.0)),
        ],
        SR as usize / 2,
        1,
    );
    let tail = &stems[0].0[stems[0].0.len() - MAX_BLOCK..];
    assert!(
        tail.iter().all(|v| *v == 0.0),
        "a dormant track's stem must be silent, not its last live block"
    );
}
