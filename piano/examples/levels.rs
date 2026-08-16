//! Prints the peak level of every key at three velocities — the voicing
//! survey used to keep the keyboard balanced. Run with
//! `cargo run --release --example levels`.

use sheliak_piano::keys::{FIRST_KEY, LAST_KEY};
use sheliak_piano::model::Piano;

fn peak_of(key: i16, vel: f32) -> f32 {
    let sr = 48_000.0;
    let mut piano = Piano::new(sr);
    piano.note_on(key, vel);
    let mut l = [0.0f32; 128];
    let mut r = [0.0f32; 128];
    let mut peak = 0.0f32;
    for _ in 0..((sr as usize / 2) / 128) {
        piano.process(&mut l, &mut r);
        for s in l.iter().chain(r.iter()) {
            peak = peak.max(s.abs());
        }
    }
    peak
}

fn main() {
    println!("key   pp(0.1)   mf(0.5)   ff(1.0)");
    for key in FIRST_KEY..=LAST_KEY {
        println!(
            "{key:3}  {:8.4}  {:8.4}  {:8.4}",
            peak_of(key, 0.1),
            peak_of(key, 0.5),
            peak_of(key, 1.0)
        );
    }
}
