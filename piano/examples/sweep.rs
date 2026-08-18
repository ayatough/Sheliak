//! Renders every key from the bottom of the keyboard to the top, one strike
//! at a time, to `piano-sweep.wav` — the register-by-register listening pass.
//! Run with `cargo run --release --example sweep`. Optional arguments:
//! a velocity (0..1, default 0.85) and a per-note spacing in seconds
//! (default 0.3), e.g. `-- 0.4 0.5` for a quiet, slower walk.

use std::io::Write;

use sheliak_piano::keys::{FIRST_KEY, LAST_KEY};
use sheliak_piano::model::Piano;

const SR: f32 = 48_000.0;

fn main() -> std::io::Result<()> {
    let mut args = std::env::args().skip(1);
    let velocity: f32 = args
        .next()
        .and_then(|a| a.parse().ok())
        .unwrap_or(0.85f32)
        .clamp(0.0, 1.0);
    let spacing: f32 = args
        .next()
        .and_then(|a| a.parse().ok())
        .unwrap_or(0.3f32)
        .clamp(0.1, 2.0);
    let hold = 0.8 * spacing;

    let keys: Vec<i16> = (FIRST_KEY..=LAST_KEY).collect();
    let seconds = keys.len() as f32 * spacing + 2.0;
    let frames = (seconds * SR) as usize;

    let mut piano = Piano::new(SR);
    let mut left = vec![0.0f32; frames];
    let mut right = vec![0.0f32; frames];
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);

    let mut ons: Vec<(usize, i16)> = Vec::new();
    let mut offs: Vec<(usize, i16)> = Vec::new();
    for (i, &key) in keys.iter().enumerate() {
        let t = i as f32 * spacing;
        ons.push(((t * SR) as usize, key));
        offs.push((((t + hold) * SR) as usize, key));
    }

    let (mut a, mut b) = (0, 0);
    let mut done = 0;
    while done < frames {
        while a < ons.len() && ons[a].0 <= done {
            piano.note_on(ons[a].1, velocity);
            a += 1;
        }
        while b < offs.len() && offs[b].0 <= done {
            piano.note_off(offs[b].1);
            b += 1;
        }
        let n = (frames - done).min(128);
        piano.process(&mut l[..n], &mut r[..n]);
        left[done..done + n].copy_from_slice(&l[..n]);
        right[done..done + n].copy_from_slice(&r[..n]);
        done += n;
    }

    let mut wav = Vec::with_capacity(44 + frames * 4);
    let data_len = (frames * 4) as u32;
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&2u16.to_le_bytes()); // stereo
    wav.extend_from_slice(&(SR as u32).to_le_bytes());
    wav.extend_from_slice(&(SR as u32 * 4).to_le_bytes());
    wav.extend_from_slice(&4u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for (l, r) in left.iter().zip(&right) {
        for s in [l, r] {
            let s = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            wav.extend_from_slice(&s.to_le_bytes());
        }
    }

    std::fs::File::create("piano-sweep.wav")?.write_all(&wav)?;
    let peak = left
        .iter()
        .chain(&right)
        .fold(0.0f32, |m, s| m.max(s.abs()));
    println!("wrote piano-sweep.wav ({seconds:.1} s, velocity {velocity}, peak {peak:.3})");
    Ok(())
}
