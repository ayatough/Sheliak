//! What the engine costs in memory, measured rather than guessed.
//!
//! Two reasons this is a test and not a note in a document.
//!
//! **It guards the allocation rule from the other side.** `process()` may not
//! allocate, which the design says everywhere; the corollary is that `init()`
//! allocates *everything*, and nothing warns you when that quietly becomes a
//! large number. Eight tracks each holding eight effects is already the biggest
//! thing here, and the delay lines and reverb banks scale with the sample rate,
//! so a machine running at 96 kHz pays double what a reading at 48 kHz suggests.
//!
//! **It is the input [workstreams §12](../../docs/workstreams.md) asks for.**
//! Giving every chain slot its own instance — so that two reverbs can exist — is
//! a memory decision, and the numbers below are the ones it needs. The per-slot
//! projection is printed with `cargo test --test footprint -- --nocapture`.
//!
//! The ceiling asserted at the end is deliberately generous. It is not a budget
//! anyone should tune against; it is there to fail loudly if a change makes the
//! engine allocate an order of magnitude more than it does today.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use sheliak_dsp::fx::delay::Delay;
use sheliak_dsp::fx::dist::Dist;
use sheliak_dsp::fx::eq::Eq;
use sheliak_dsp::fx::mbcomp::MbComp;
use sheliak_dsp::fx::mod_fx::{Chorus, Flanger, Phaser};
use sheliak_dsp::fx::reverb::Reverb;
use sheliak_dsp::fx::Fx;
use sheliak_dsp::multi::MultiEngine;
use sheliak_dsp::params::FX_SLOTS;

/// Counts live heap bytes. `realloc` is left at the default, which routes
/// through `alloc` and `dealloc`, so it is accounted for without being counted
/// twice.
struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size(), Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Heap bytes still held by the value once it has been built.
fn held_by<T>(build: impl FnOnce() -> T) -> usize {
    let before = LIVE.load(Ordering::Relaxed);
    let value = build();
    let after = LIVE.load(Ordering::Relaxed);
    drop(value);
    after.saturating_sub(before)
}

fn kib(bytes: usize) -> String {
    format!("{:>9.1} KiB", bytes as f64 / 1024.0)
}

/// Every effect, in type-id order, measured at one sample rate.
fn effect_sizes(sr: f32) -> Vec<(&'static str, usize)> {
    vec![
        ("dist", held_by(|| Dist::new(sr))),
        ("eq", held_by(|| Eq::new(sr))),
        ("chorus", held_by(|| Chorus::new(sr))),
        ("phaser", held_by(|| Phaser::new(sr))),
        ("flanger", held_by(|| Flanger::new(sr))),
        ("delay", held_by(|| Delay::new(sr))),
        ("reverb", held_by(|| Reverb::new(sr))),
        ("mbcomp", held_by(|| MbComp::new(sr))),
    ]
}

/// One test, not several: the counter is global and the harness runs tests in
/// parallel, so a second test measuring at the same time lands in this one's
/// readings. That is exactly how the first version of this file reported a
/// chain smaller than the delay line inside it.
#[test]
fn the_engine_reports_what_it_costs() {
    for sr in [48_000.0f32, 96_000.0] {
        let sizes = effect_sizes(sr);
        let chain = held_by(|| Fx::new(sr));
        let sum: usize = sizes.iter().map(|(_, b)| *b).sum();
        let largest = sizes.iter().map(|(_, b)| *b).max().unwrap();

        println!("\n=== effects at {} kHz ===", sr / 1000.0);
        for (name, bytes) in &sizes {
            println!("  {name:<9}{}", kib(*bytes));
        }
        println!("  {:<9}{}", "sum", kib(sum));
        println!(
            "  {:<9}{}  one per type — what a track holds today",
            "chain",
            kib(chain)
        );
        println!(
            "  {:<9}{}  §12 A4b: {} slots x the largest effect",
            "per-slot",
            kib(largest * FX_SLOTS),
            FX_SLOTS
        );

        // The chain holds one of each, so it cannot cost less than its parts.
        // If this fails, an effect is sharing a buffer it does not own.
        assert!(
            chain >= sum,
            "chain ({chain}) holds less than its effects ({sum}) at {sr} Hz"
        );
    }

    // 96 kHz is the worst case a browser is likely to hand us, and every delay
    // line and reverb bank is sized from it.
    let engine = held_by(|| MultiEngine::new(96_000.0));
    println!("\nMultiEngine at 96 kHz: {}", kib(engine));

    // Generous by design — see the note at the top of this file. Today's figure
    // is far below it; this exists to catch an order-of-magnitude change, such
    // as giving every chain slot an instance of every effect type.
    const CEILING: usize = 256 * 1024 * 1024;
    assert!(
        engine < CEILING,
        "the engine allocated {} at 96 kHz, over the {} ceiling",
        kib(engine),
        kib(CEILING)
    );
}
