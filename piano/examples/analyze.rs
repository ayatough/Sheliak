//! Per-partial analysis of a recorded (or rendered) piano note — the
//! measuring half of the sample-fitting loop (ROADMAP workstream 5).
//!
//! ```text
//! cargo run --release --example analyze -- <note.wav> <midi key>
//! ```
//!
//! Reads a 16- or 24-bit PCM WAV (mono or stereo; a FLAC reference must be
//! converted first, e.g. `ffmpeg -i note.flac note.wav`), then prints, per
//! partial: the measured frequency (→ inharmonicity `B`), the attack level
//! relative to the loudest partial (→ strike position, hammer, soundboard
//! shape), and the early/late envelope slopes in dB/s (→ `t60_early`,
//! `t60_late`, `after_gain` anchors in `keys.rs`; dB/s = 60/T60). Band
//! medians at the bottom summarise the same numbers the way the anchors
//! were fitted. Compare a model render (`examples/note_wav.rs`) against a
//! reference recording of the same key and move the anchors toward the
//! reference.

use std::f32::consts::TAU;

fn midi_f0(m: i32) -> f32 {
    440.0 * 2.0f32.powf((m as f32 - 69.0) / 12.0)
}

/// Minimal PCM WAV reader: 16- or 24-bit integer samples, any channel
/// count (averaged to mono).
fn read_wav(path: &str) -> (Vec<f32>, f32) {
    let bytes = std::fs::read(path).expect("cannot read file");
    assert!(
        &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE",
        "not a WAV"
    );
    let mut pos = 12;
    let mut sr = 0u32;
    let mut channels = 1u16;
    let mut bits = 16u16;
    let mut data: &[u8] = &[];
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = &bytes[pos + 8..(pos + 8 + len).min(bytes.len())];
        match id {
            b"fmt " => {
                channels = u16::from_le_bytes(body[2..4].try_into().unwrap());
                sr = u32::from_le_bytes(body[4..8].try_into().unwrap());
                bits = u16::from_le_bytes(body[14..16].try_into().unwrap());
            }
            b"data" => data = body,
            _ => {}
        }
        pos += 8 + len + (len & 1);
    }
    assert!(sr > 0 && !data.is_empty(), "malformed WAV");
    let step = (bits / 8) as usize;
    let frame = step * channels as usize;
    let mut mono = Vec::with_capacity(data.len() / frame);
    let mut i = 0;
    while i + frame <= data.len() {
        let mut acc = 0.0f32;
        for c in 0..channels as usize {
            let s = &data[i + c * step..];
            let v = match bits {
                16 => i16::from_le_bytes(s[..2].try_into().unwrap()) as f32 / 32768.0,
                24 => {
                    let raw = ((s[2] as i32) << 24 | (s[1] as i32) << 16 | (s[0] as i32) << 8) >> 8;
                    raw as f32 / 8_388_608.0
                }
                _ => panic!("only 16/24-bit PCM supported"),
            };
            acc += v;
        }
        mono.push(acc / channels as f32);
        i += frame;
    }
    (mono, sr as f32)
}

/// Goertzel energy → amplitude estimate over a Hann-windowed segment.
fn goertzel_amp(x: &[f32], sr: f32, f: f32) -> f32 {
    let n = x.len();
    let w = TAU * f / sr;
    let coeff = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f32, 0.0f32);
    for (i, &v) in x.iter().enumerate() {
        let hann = 0.5 - 0.5 * (TAU * i as f32 / n as f32).cos();
        let s0 = v * hann + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    let energy = (s1 * s1 + s2 * s2 - coeff * s1 * s2).max(0.0);
    // Hann window: coherent gain 0.5 → amplitude ≈ 4·sqrt(E)/N.
    4.0 * energy.sqrt() / n as f32
}

/// Peak amplitude and frequency near `f`, scanned in fine steps.
fn peak_near(x: &[f32], sr: f32, f: f32, half_width: f32) -> (f32, f32) {
    let step = (half_width / 24.0).max(0.25);
    let mut best = (0.0f32, f);
    let mut probe = f - half_width;
    while probe <= f + half_width {
        if probe > 0.0 {
            let a = goertzel_amp(x, sr, probe);
            if a > best.0 {
                best = (a, probe);
            }
        }
        probe += step;
    }
    best
}

fn db(a: f32, reference: f32) -> f32 {
    20.0 * (a.max(1.0e-9) / reference).log10()
}

/// Least-squares slope (dB/s) of a series of (t, dB) points.
fn slope(points: &[(f32, f32)]) -> Option<f32> {
    if points.len() < 4 {
        return None;
    }
    let n = points.len() as f32;
    let (mut st, mut sy, mut stt, mut sty) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for &(t, y) in points {
        st += t;
        sy += y;
        stt += t * t;
        sty += t * y;
    }
    let denominator = n * stt - st * st;
    if denominator.abs() < 1.0e-9 {
        return None;
    }
    Some((n * sty - st * sy) / denominator)
}

fn median(mut v: Vec<f32>) -> Option<f32> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(f32::total_cmp);
    Some(v[v.len() / 2])
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: analyze <note.wav> <midi key>");
    let midi: i32 = args.next().expect("missing midi key").parse().unwrap();
    let (mut x, sr) = read_wav(&path);

    // Trim leading silence to the first sample above 2 % of peak.
    let peak = x.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    let start = x
        .iter()
        .position(|s| s.abs() > 0.02 * peak)
        .unwrap_or(0)
        .saturating_sub((0.005 * sr) as usize);
    x.drain(..start);
    let length_s = x.len() as f32 / sr;

    // Refine f0 on a long attack window, then fit B from partials ≥ 4.
    let f0_nom = midi_f0(midi);
    let win = ((6.0 / f0_nom).max(0.35).min(length_s - 0.06) * sr) as usize;
    let head = &x[(0.05 * sr) as usize..(0.05 * sr) as usize + win];
    let (_, f0) = peak_near(head, sr, f0_nom, 0.05 * f0_nom);

    let mut b = 0.0f32;
    let mut freqs: Vec<(usize, f32, f32)> = Vec::new(); // (n, f, attack amp)
    for _ in 0..3 {
        freqs.clear();
        for n in 1..=30usize {
            let nf = n as f32;
            let fe = nf * f0 * ((1.0 + b * nf * nf) / (1.0 + b)).sqrt();
            if fe > 0.45 * sr {
                break;
            }
            let (a, fm) = peak_near(head, sr, fe, (0.35 * f0).max(8.0));
            freqs.push((n, fm, a));
        }
        let (mut num, mut den) = (0.0f32, 0.0f32);
        for &(n, fm, _) in freqs.iter().filter(|(n, _, _)| *n >= 4) {
            let nf = n as f32;
            let y = (fm / (nf * f0)).powi(2) * (1.0 + b) - 1.0;
            num += y * nf * nf;
            den += nf * nf * nf * nf;
        }
        if den > 0.0 && num > 0.0 {
            b = num / den;
        }
    }

    // Envelope tracking: sliding Goertzel at each measured partial.
    let hop = 0.05f32;
    let dur = ((4.0 / f0).max(0.12) * sr) as usize;
    let mut track: Vec<(usize, Vec<(f32, f32)>)> = Vec::new(); // n → (t, amp)
    for &(n, fm, _) in &freqs {
        let mut env = Vec::new();
        let mut t = 0.0f32;
        while ((t * sr) as usize) + dur < x.len() && t < 5.0 {
            let seg = &x[(t * sr) as usize..(t * sr) as usize + dur];
            let (a, _) = peak_near(seg, sr, fm, (0.35 * f0).max(9.0));
            env.push((t, a));
            t += hop;
        }
        track.push((n, env));
    }

    let reference = track
        .iter()
        .flat_map(|(_, env)| env.iter().take(7).map(|&(_, a)| a))
        .fold(1.0e-9f32, f32::max);

    println!("file {path}  midi {midi}  f0 {f0:.2} Hz  B {b:.2e}");
    println!("  n   f(Hz)   attack(dB)  early(dB/s)  late(dB/s)");
    let mut rows: Vec<(usize, f32, Option<f32>, Option<f32>)> = Vec::new();
    for (n, env) in &track {
        let attack = env.iter().take(7).map(|&(_, a)| a).fold(0.0f32, f32::max);
        let attack_db = db(attack, reference);
        let early: Vec<(f32, f32)> = env
            .iter()
            .filter(|(t, _)| (0.05..=0.8).contains(t))
            .map(|&(t, a)| (t, db(a, reference)))
            .collect();
        let late: Vec<(f32, f32)> = env
            .iter()
            .filter(|(t, _)| (1.5..=3.5).contains(t))
            .map(|&(t, a)| (t, db(a, reference)))
            .collect();
        let es = slope(&early);
        let ls = slope(&late);
        let f = freqs.iter().find(|(m, _, _)| m == n).unwrap().1;
        let fmt = |o: Option<f32>| o.map_or("      -".into(), |v| format!("{v:7.1}"));
        println!("{n:3} {f:8.1}   {attack_db:8.1}  {}  {}", fmt(es), fmt(ls));
        rows.push((*n, attack_db, es, ls));
    }

    println!("  band medians (attack > -35 dB):");
    for (lo, hi) in [(1, 3), (4, 8), (9, 16), (17, 24)] {
        let sel: Vec<_> = rows
            .iter()
            .filter(|(n, a, _, _)| (lo..=hi).contains(n) && *a > -35.0)
            .collect();
        let att = median(sel.iter().map(|r| r.1).collect());
        let es = median(sel.iter().filter_map(|r| r.2).collect());
        let ls = median(sel.iter().filter_map(|r| r.3).collect());
        let fmt = |o: Option<f32>| o.map_or("     -".into(), |v| format!("{v:6.1}"));
        println!(
            "    n{lo}-{hi}: attack {}  early {}  late {}",
            fmt(att),
            fmt(es),
            fmt(ls)
        );
    }
}
