//! Offline checks standing in for ears, in the spirit of `dsp/tests/verify.rs`:
//! determinism, boundedness, tuning, decay, the pedal, and the absence of the
//! failure modes a diff cannot show.

use sheliak_piano::keys::{key_scaling, stretch_cents, FIRST_KEY, LAST_KEY};
use sheliak_piano::model::{Piano, MAX_VOICES, P_DETUNE, P_KNOCK, P_STRETCH, P_SUSTAIN};

const SR: f32 = 48_000.0;
const BLOCK: usize = 128;

/// Renders with a note-on at t=0 and an optional note-off, in 128-frame
/// blocks, returning the left channel.
fn render(piano: &mut Piano, seconds: f32, key: i16, vel: f32, off_at: Option<f32>) -> Vec<f32> {
    let frames = (seconds * SR) as usize;
    let off_frame = off_at.map(|t| (t * SR) as usize);
    let mut left = vec![0.0f32; frames];
    let mut l = [0.0f32; BLOCK];
    let mut r = [0.0f32; BLOCK];
    piano.note_on(key, vel);
    let mut done = 0;
    let mut note_off_sent = false;
    while done < frames {
        if let Some(off) = off_frame {
            if !note_off_sent && done >= off {
                piano.note_off(key);
                note_off_sent = true;
            }
        }
        let n = (frames - done).min(BLOCK);
        piano.process(&mut l[..n], &mut r[..n]);
        left[done..done + n].copy_from_slice(&l[..n]);
        done += n;
    }
    left
}

fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |m, s| m.max(s.abs()))
}

fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt()
}

/// Signal energy at one frequency (Goertzel), over the given samples.
fn goertzel(samples: &[f32], freq: f32) -> f32 {
    let w = std::f32::consts::TAU * freq / SR;
    let coeff = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f32, 0.0f32);
    for &x in samples {
        let s0 = x + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    (s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.len().max(1) as f32
}

// ---------------------------------------------------------------- determinism

#[test]
fn the_same_events_render_the_same_samples() {
    let run = || {
        let mut piano = Piano::new(SR);
        piano.set_param(P_SUSTAIN, 1.0);
        let mut out = render(&mut piano, 1.0, 60, 0.8, Some(0.4));
        piano.note_on(45, 0.6);
        let mut l = [0.0f32; BLOCK];
        let mut r = [0.0f32; BLOCK];
        for _ in 0..40 {
            piano.process(&mut l, &mut r);
            out.extend_from_slice(&l);
        }
        out
    };
    let a = run();
    let b = run();
    assert_eq!(a, b, "two identical runs disagreed");
}

// ------------------------------------------------------------- every key sane

#[test]
fn every_key_is_audible_bounded_and_finite() {
    for key in FIRST_KEY..=LAST_KEY {
        let mut piano = Piano::new(SR);
        let out = render(&mut piano, 0.5, key, 1.0, None);
        assert!(
            out.iter().all(|s| s.is_finite()),
            "key {key} produced a non-finite sample"
        );
        let p = peak(&out);
        assert!(p < 1.0, "key {key} clips a single fortissimo note: {p}");
        assert!(p > 0.01, "key {key} is nearly inaudible: {p}");
    }
}

#[test]
fn soft_and_loud_are_ordered_and_bounded() {
    for &key in &[24, 48, 60, 84, 105] {
        let quiet = peak(&render(&mut Piano::new(SR), 0.5, key, 0.1, None));
        let loud = peak(&render(&mut Piano::new(SR), 0.5, key, 1.0, None));
        assert!(
            loud > quiet * 2.0,
            "key {key}: velocity hardly changes level (pp {quiet}, ff {loud})"
        );
    }
}

// ----------------------------------------------------------------- decay

#[test]
fn a_held_note_rings_and_a_released_note_stops() {
    // Held: a mid key still sounds at 3 s.
    let mut piano = Piano::new(SR);
    let held = render(&mut piano, 3.0, 48, 0.9, None);
    let late = rms(&held[(2.8 * SR) as usize..]);
    assert!(late > 1.0e-5, "a held C3 died inside 3 s: {late}");

    // Released at 0.5 s: the damper ends it well before 2 s.
    let mut piano = Piano::new(SR);
    let released = render(&mut piano, 2.0, 48, 0.9, Some(0.5));
    let tail = rms(&released[(1.8 * SR) as usize..]);
    assert!(tail < 2.0e-4, "the damper is not damping: {tail}");
    assert!(tail < late, "release must be quieter than holding");
}

#[test]
fn the_top_of_the_keyboard_has_no_dampers() {
    // Key 105 (A7) has no damper: note-off must not shorten it much.
    let held = rms(&render(&mut Piano::new(SR), 1.0, 105, 0.9, None)[(0.7 * SR) as usize..]);
    let released =
        rms(&render(&mut Piano::new(SR), 1.0, 105, 0.9, Some(0.1))[(0.7 * SR) as usize..]);
    assert!(
        released > held * 0.5,
        "an undamped key was damped (held {held}, released {released})"
    );
}

#[test]
fn the_sustain_pedal_holds_a_released_note() {
    let mut piano = Piano::new(SR);
    piano.set_pedal(true);
    let pedalled = render(&mut piano, 2.0, 48, 0.9, Some(0.3));
    let mut piano = Piano::new(SR);
    let plain = render(&mut piano, 2.0, 48, 0.9, Some(0.3));
    let with_pedal = rms(&pedalled[(1.5 * SR) as usize..]);
    let without = rms(&plain[(1.5 * SR) as usize..]);
    assert!(
        with_pedal > without * 10.0,
        "the pedal changes nothing (with {with_pedal}, without {without})"
    );
}

// ----------------------------------------------------------------- tuning

#[test]
fn the_fundamental_lands_where_the_model_says() {
    for &key in &[33, 48, 60, 72, 96] {
        let mut piano = Piano::new(SR);
        // Stretch off so the expected frequency is the plain equal-tempered
        // one; detune off so the partial is a single line.
        piano.set_param(P_STRETCH, 0.0);
        piano.set_param(P_DETUNE, 0.0);
        let out = render(&mut piano, 1.0, key, 0.7, None);
        let steady = &out[(0.3 * SR) as usize..];
        let f0 = key_scaling(key).f0;

        let on_pitch = goertzel(steady, f0);
        let flat = goertzel(steady, f0 * 0.971);
        let sharp = goertzel(steady, f0 * 1.03);
        assert!(
            on_pitch > flat * 3.0 && on_pitch > sharp * 3.0,
            "key {key}: fundamental is off pitch (on {on_pitch}, -50ct {flat}, +51ct {sharp})"
        );
    }
}

#[test]
fn partials_are_stretched_by_inharmonicity() {
    // On a stiff string the 8th partial sits sharp of 8×f0. Energy at the
    // predicted inharmonic frequency must beat energy at the harmonic one.
    let key = 48;
    let scale = key_scaling(key);
    let mut piano = Piano::new(SR);
    piano.set_param(P_STRETCH, 0.0);
    piano.set_param(P_DETUNE, 0.0);
    let out = render(&mut piano, 1.0, key, 0.9, None);
    let steady = &out[(0.2 * SR) as usize..];

    let n = 8.0f32;
    let predicted = n * scale.f0 * ((1.0 + scale.b * n * n) / (1.0 + scale.b)).sqrt();
    let harmonic = n * scale.f0;
    assert!(
        predicted > harmonic * 1.001,
        "test premise broken: B too small to observe"
    );
    let at_predicted = goertzel(steady, predicted);
    let at_harmonic = goertzel(steady, harmonic);
    assert!(
        at_predicted > at_harmonic,
        "partial 8 is not stretched (predicted {at_predicted}, harmonic {at_harmonic})"
    );
}

#[test]
fn stretch_moves_the_treble_sharp() {
    let key = 100;
    let cents = stretch_cents(key, 1.0);
    assert!(cents > 5.0, "the stretch curve is flat at key {key}");
    let f_stretched = key_scaling(key).f0 * 2.0f32.powf(cents / 1200.0);

    let mut piano = Piano::new(SR);
    piano.set_param(P_DETUNE, 0.0);
    let out = render(&mut piano, 0.6, key, 0.7, None);
    let steady = &out[(0.1 * SR) as usize..];
    let at_stretched = goertzel(steady, f_stretched);
    let at_plain = goertzel(steady, key_scaling(key).f0);
    assert!(
        at_stretched > at_plain,
        "stretch tuning is not applied (stretched {at_stretched}, plain {at_plain})"
    );
}

// ------------------------------------------------------------- timbre

#[test]
fn a_louder_note_is_brighter_not_just_louder() {
    let key = 60;
    let scale = key_scaling(key);
    let high_partial = |vel: f32| {
        let mut piano = Piano::new(SR);
        piano.set_param(P_DETUNE, 0.0);
        let out = render(&mut piano, 0.5, key, vel, None);
        let steady = &out[(0.05 * SR) as usize..];
        let n = 10.0f32;
        let f = n * scale.f0 * ((1.0 + scale.b * n * n) / (1.0 + scale.b)).sqrt();
        goertzel(steady, f) / goertzel(steady, scale.f0).max(1.0e-20)
    };
    let soft = high_partial(0.15);
    let loud = high_partial(1.0);
    assert!(
        loud > soft * 1.5,
        "the felt nonlinearity is not brightening loud notes (pp {soft}, ff {loud})"
    );
}

// ------------------------------------------------------- the strike noise

/// The knock alone: the same strike rendered with the burst at maximum and
/// at zero differ by exactly the burst, since it never feeds the strings and
/// the master path is linear.
fn knock_alone(key: i16, vel: f32) -> Vec<f32> {
    let mut piano = Piano::new(SR);
    piano.set_param(P_KNOCK, 2.0);
    let with = render(&mut piano, 0.3, key, vel, None);
    let mut piano = Piano::new(SR);
    piano.set_param(P_KNOCK, 0.0);
    let without = render(&mut piano, 0.3, key, vel, None);
    with.iter().zip(&without).map(|(a, b)| a - b).collect()
}

#[test]
fn the_knock_is_a_short_transient_that_vanishes_with_the_touch() {
    for &key in &[30, 60, 90] {
        let knock = knock_alone(key, 1.0);
        let p = peak(&knock);
        assert!(p > 1.0e-3, "key {key}: no knock at fortissimo: {p}");

        // A transient, not a tone: from its own peak it must fall to −40 dB
        // inside 20 ms.
        let peak_at = knock
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
            .map(|(i, _)| i)
            .unwrap();
        let tail = peak(&knock[peak_at + (0.02 * SR) as usize..]);
        assert!(
            tail < p * 0.01,
            "key {key}: the knock rings past 20 ms (peak {p}, tail {tail})"
        );

        // And it must all but vanish when the key is barely touched.
        let silent = peak(&knock_alone(key, 0.005));
        assert!(
            silent < p * 1.0e-3,
            "key {key}: a near-zero-velocity strike still knocks: {silent}"
        );
    }
}

// ------------------------------------------------------- clicks, DC, voices

#[test]
fn no_dc_offset_accumulates() {
    let mut piano = Piano::new(SR);
    let out = render(&mut piano, 2.0, 36, 1.0, Some(1.0));
    let tail = &out[(1.5 * SR) as usize..];
    let mean = tail.iter().sum::<f32>() / tail.len() as f32;
    assert!(mean.abs() < 1.0e-4, "DC left behind after the note: {mean}");
}

#[test]
fn a_note_off_does_not_click() {
    let mut piano = Piano::new(SR);
    let out = render(&mut piano, 1.5, 60, 0.9, Some(0.5));
    // The largest sample-to-sample step after the release must stay well
    // under the note's own peak — a damper is a decay, not a cut.
    let release_at = (0.5 * SR) as usize;
    let p = peak(&out[..release_at]);
    let max_step = out[release_at..]
        .windows(2)
        .map(|w| (w[1] - w[0]).abs())
        .fold(0.0f32, f32::max);
    assert!(
        max_step < p * 0.5,
        "release clicks: step {max_step} against peak {p}"
    );
}

#[test]
fn hammering_every_key_at_once_stays_bounded() {
    let mut piano = Piano::new(SR);
    for key in FIRST_KEY..=LAST_KEY {
        piano.note_on(key, 1.0);
    }
    assert!(piano.active_voices() <= MAX_VOICES);
    let mut l = [0.0f32; BLOCK];
    let mut r = [0.0f32; BLOCK];
    let mut p = 0.0f32;
    for _ in 0..(SR as usize / BLOCK) {
        piano.process(&mut l, &mut r);
        for s in l.iter().chain(r.iter()) {
            assert!(s.is_finite(), "a full-keyboard cluster went non-finite");
            p = p.max(s.abs());
        }
    }
    assert!(p < 4.0, "a full-keyboard cluster left the rails: {p}");
}

#[test]
fn a_restruck_key_does_not_stack_forever() {
    let mut piano = Piano::new(SR);
    piano.set_param(P_SUSTAIN, 1.0);
    let mut l = [0.0f32; BLOCK];
    let mut r = [0.0f32; BLOCK];
    for _ in 0..64 {
        piano.note_on(60, 0.9);
        for _ in 0..8 {
            piano.process(&mut l, &mut r);
        }
    }
    assert!(piano.active_voices() <= MAX_VOICES);
    assert!(l.iter().all(|s| s.is_finite()));
}

#[test]
fn other_sample_rates_keep_the_pitch() {
    // The tuning must not depend on the sample rate: the fundamental of the
    // same key lands on the same frequency at 44.1k and 96k.
    for &(sr, seconds) in &[(44_100.0f32, 0.8f32), (96_000.0, 0.8)] {
        let mut piano = Piano::new(sr);
        piano.set_param(P_STRETCH, 0.0);
        piano.set_param(P_DETUNE, 0.0);
        let frames = (seconds * sr) as usize;
        let mut left = vec![0.0f32; frames];
        let mut l = [0.0f32; BLOCK];
        let mut r = [0.0f32; BLOCK];
        piano.note_on(60, 0.7);
        let mut done = 0;
        while done < frames {
            let n = (frames - done).min(BLOCK);
            piano.process(&mut l[..n], &mut r[..n]);
            left[done..done + n].copy_from_slice(&l[..n]);
            done += n;
        }
        let steady = &left[(0.3 * sr) as usize..];
        let f0 = key_scaling(60).f0;
        let w = std::f32::consts::TAU * f0 / sr;
        let coeff = 2.0 * w.cos();
        let energy = |freq: f32| {
            let w = std::f32::consts::TAU * freq / sr;
            let c = 2.0 * w.cos();
            let (mut s1, mut s2) = (0.0f32, 0.0f32);
            for &x in steady {
                let s0 = x + c * s1 - s2;
                s2 = s1;
                s1 = s0;
            }
            (s1 * s1 + s2 * s2 - c * s1 * s2) / steady.len() as f32
        };
        let _ = coeff;
        assert!(
            energy(f0) > energy(f0 * 0.971) * 3.0 && energy(f0) > energy(f0 * 1.03) * 3.0,
            "pitch drifted at {sr} Hz"
        );
    }
}
