//! The voicing survey: the peak level of every key at three velocities.
//!
//! Two modes:
//!
//! ```text
//! cargo run --release --example levels              # print the survey
//! cargo run --release --example levels -- --retrim  # print a corrected OUTPUT_TRIM
//! ```
//!
//! `--retrim` measures the keyboard as it currently sounds and prints a
//! ready-to-paste replacement for the `OUTPUT_TRIM` table in
//! `src/keys.rs`. Run it after any change to the model or to `key_scaling`
//! that shifts levels (damping, radiation, hammer curves…), paste the block
//! over the old table, rebuild, and the keyboard is level again. The recipe
//! matches how the shipped table was made: correct toward a 0.028 peak at
//! mezzo-forte and 0.16 at fortissimo, by the geometric mean of the two up
//! to key 93 and by the fortissimo correction alone above that, where the
//! contact-alignment lobes are steepest at full force.

use sheliak_piano::keys::{key_scaling, FIRST_KEY, LAST_KEY};
use sheliak_piano::model::Piano;

const TARGET_MF: f32 = 0.028;
const TARGET_FF: f32 = 0.16;

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
    let retrim = std::env::args().any(|a| a == "--retrim");
    if retrim {
        println!("const OUTPUT_TRIM: [f32; 88] = [");
        for key in FIRST_KEY..=LAST_KEY {
            let mf = peak_of(key, 0.5);
            let ff = peak_of(key, 1.0);
            let t_mf = if mf > 0.0 { TARGET_MF / mf } else { 14.0 };
            let t_ff = if ff > 0.0 { TARGET_FF / ff } else { 14.0 };
            let correction = if key <= 93 {
                (t_mf * t_ff).sqrt()
            } else {
                t_ff
            };
            let trim = (key_scaling(key).output_trim * correction).clamp(0.05, 14.0);
            println!("    {trim:.3}, // key {key}");
        }
        println!("];");
    } else {
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
}
