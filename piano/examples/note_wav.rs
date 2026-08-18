//! Temporary probe: renders one note to a WAV for spectral comparison
//! against reference recordings. `-- <midi key> <velocity> <seconds> <path>`.

use std::io::Write;

use sheliak_piano::model::Piano;

const SR: f32 = 48_000.0;

fn main() -> std::io::Result<()> {
    let mut args = std::env::args().skip(1);
    let key: i16 = args.next().unwrap().parse().unwrap();
    let vel: f32 = args.next().unwrap().parse().unwrap();
    let seconds: f32 = args.next().unwrap().parse().unwrap();
    let path = args.next().unwrap();

    let mut piano = Piano::new(SR);
    piano.note_on(key, vel);
    let frames = (seconds * SR) as usize;
    let mut left = vec![0.0f32; frames];
    let mut right = vec![0.0f32; frames];
    let (mut l, mut r) = ([0.0f32; 128], [0.0f32; 128]);
    let mut done = 0;
    while done < frames {
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
    std::fs::File::create(&path)?.write_all(&wav)?;
    println!("wrote {path}");
    Ok(())
}
