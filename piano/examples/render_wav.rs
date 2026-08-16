//! Renders a short demo passage to `piano-demo.wav` — the way to *hear* the
//! model without a DAW. Run with `cargo run --release --example render_wav`.
//!
//! The passage exercises what the tests can only measure: a bass octave, a
//! pedalled arpeggio, a staccato chord, and a fortissimo-versus-pianissimo
//! pair on the same key.

use std::io::Write;

use sheliak_piano::model::{Piano, P_SUSTAIN};

const SR: f32 = 48_000.0;

struct Score {
    /// (time in seconds, key, velocity 0..1, duration in seconds)
    notes: Vec<(f32, i16, f32, f32)>,
    /// (time, pedal down?)
    pedal: Vec<(f32, bool)>,
}

fn score() -> Score {
    let mut notes = Vec::new();
    let mut pedal = Vec::new();

    // A bass octave, held.
    notes.push((0.0, 36, 0.85, 2.8));
    notes.push((0.0, 48, 0.8, 2.8));

    // A pedalled arpeggio over it.
    pedal.push((0.2, true));
    for (i, key) in [55i16, 60, 64, 67, 72, 76, 79, 84].iter().enumerate() {
        notes.push((0.3 + i as f32 * 0.22, *key, 0.65, 0.18));
    }
    pedal.push((2.9, false));

    // A staccato chord, no pedal.
    for key in [48i16, 60, 64, 67] {
        notes.push((3.3, key, 0.9, 0.12));
    }

    // The same key twice: pianissimo, then fortissimo.
    notes.push((4.0, 65, 0.15, 0.8));
    notes.push((5.0, 65, 1.0, 0.8));

    Score { notes, pedal }
}

fn main() -> std::io::Result<()> {
    let mut piano = Piano::new(SR);
    let score = score();
    let seconds = 7.5f32;
    let frames = (seconds * SR) as usize;

    // Flatten the score into per-frame events.
    let mut ons: Vec<(usize, i16, f32)> = Vec::new();
    let mut offs: Vec<(usize, i16)> = Vec::new();
    for &(t, key, vel, dur) in &score.notes {
        ons.push(((t * SR) as usize, key, vel));
        offs.push((((t + dur) * SR) as usize, key));
    }
    let mut pedals: Vec<(usize, bool)> = score
        .pedal
        .iter()
        .map(|&(t, down)| ((t * SR) as usize, down))
        .collect();
    ons.sort_by_key(|e| e.0);
    offs.sort_by_key(|e| e.0);
    pedals.sort_by_key(|e| e.0);

    let mut left = vec![0.0f32; frames];
    let mut right = vec![0.0f32; frames];
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let (mut a, mut b, mut c) = (0, 0, 0);
    let mut done = 0;
    while done < frames {
        while a < ons.len() && ons[a].0 <= done {
            piano.note_on(ons[a].1, ons[a].2);
            a += 1;
        }
        while b < offs.len() && offs[b].0 <= done {
            piano.note_off(offs[b].1);
            b += 1;
        }
        while c < pedals.len() && pedals[c].0 <= done {
            piano.set_param(P_SUSTAIN, if pedals[c].1 { 1.0 } else { 0.0 });
            c += 1;
        }
        let n = (frames - done).min(128);
        piano.process(&mut l[..n], &mut r[..n]);
        left[done..done + n].copy_from_slice(&l[..n]);
        right[done..done + n].copy_from_slice(&r[..n]);
        done += n;
    }

    // A plain 16-bit stereo WAV.
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

    std::fs::File::create("piano-demo.wav")?.write_all(&wav)?;
    let peak = left
        .iter()
        .chain(&right)
        .fold(0.0f32, |m, s| m.max(s.abs()));
    println!("wrote piano-demo.wav ({seconds} s, peak {peak:.3})");
    Ok(())
}
