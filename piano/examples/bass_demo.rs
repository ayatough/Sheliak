//! A bass-register listening pass: long single notes for the decay and the
//! polarisation shimmer, a pedalled walking line, the same key at pp and ff,
//! and a closing bottom octave. Run with
//! `cargo run --release --example bass_demo`.

use std::io::Write;

use sheliak_piano::model::{Piano, P_SUSTAIN};

const SR: f32 = 48_000.0;

fn main() -> std::io::Result<()> {
    let mut piano = Piano::new(SR);

    // (time, key, velocity, duration)
    let notes: Vec<(f32, i16, f32, f32)> = vec![
        // The bottom of the keyboard, alone and long.
        (0.0, 21, 0.95, 3.5), // A0 fortissimo
        (4.0, 24, 0.7, 2.5),  // C1 mezzo
        // A pedalled walking line up the bottom two octaves.
        (7.0, 28, 0.75, 0.45),
        (7.5, 31, 0.75, 0.45),
        (8.0, 33, 0.75, 0.45),
        (8.5, 36, 0.8, 0.45),
        (9.2, 38, 0.8, 1.5), // D2
        (9.2, 45, 0.7, 1.5), // + A2
        // The same low C, brushed then struck.
        (11.5, 36, 0.15, 1.2),
        (13.0, 36, 1.0, 1.2),
        // A closing bottom octave, held to the end.
        (14.8, 21, 0.9, 3.5),
        (14.8, 33, 0.85, 3.5),
    ];
    let pedal = vec![(7.0, true), (11.0, false), (14.8, true)];

    let seconds = 19.0f32;
    let frames = (seconds * SR) as usize;

    let mut ons: Vec<(usize, i16, f32)> = Vec::new();
    let mut offs: Vec<(usize, i16)> = Vec::new();
    for &(t, key, vel, dur) in &notes {
        ons.push(((t * SR) as usize, key, vel));
        offs.push((((t + dur) * SR) as usize, key));
    }
    let mut pedals: Vec<(usize, bool)> = pedal
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

    let mut wav = Vec::with_capacity(44 + frames * 4);
    let data_len = (frames * 4) as u32;
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
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

    std::fs::File::create("piano-bass-demo.wav")?.write_all(&wav)?;
    let peak = left
        .iter()
        .chain(&right)
        .fold(0.0f32, |m, s| m.max(s.abs()));
    println!("wrote piano-bass-demo.wav ({seconds} s, peak {peak:.3})");
    Ok(())
}
