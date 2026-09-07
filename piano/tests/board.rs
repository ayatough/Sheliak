//! The modal soundboard: it rings the way a tapped board does, sits on its
//! body resonances, is the same board at any sample rate, and has width.

use sheliak_piano::board::Board;

fn impulse_response(sample_rate: f32, side: u32, seconds: f32) -> Vec<f32> {
    let mut board = Board::new(sample_rate, side);
    let n = (seconds * sample_rate) as usize;
    (0..n)
        .map(|i| board.step(if i == 0 { 1.0 } else { 0.0 }))
        .collect()
}

fn rms(x: &[f32]) -> f32 {
    (x.iter().map(|v| v * v).sum::<f32>() / x.len().max(1) as f32).sqrt()
}

fn band_energy(x: &[f32], sample_rate: f32, lo: f32, hi: f32) -> f32 {
    // A plain DFT over the band — the response is short, so this is cheap.
    let mut energy = 0.0f64;
    let mut hz = lo;
    while hz < hi {
        let (mut re, mut im) = (0.0f64, 0.0f64);
        for (i, v) in x.iter().enumerate() {
            let phase = core::f64::consts::TAU * hz as f64 * i as f64 / sample_rate as f64;
            re += *v as f64 * phase.cos();
            im -= *v as f64 * phase.sin();
        }
        energy += re * re + im * im;
        hz += 10.0;
    }
    energy as f32
}

#[test]
fn a_tapped_board_rings_and_then_is_silent() {
    let sr = 48_000.0;
    let h = impulse_response(sr, 0, 1.0);
    let peak = h.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(peak > 0.0, "the board is silent");
    assert!(h.iter().all(|v| v.is_finite()), "the board blew up");
    // The tap has a body: it is still ringing at 20 ms …
    let early = rms(&h[(0.02 * sr) as usize..(0.03 * sr) as usize]);
    assert!(
        early > 0.01 * peak,
        "no ring at 20 ms: {early} against {peak}"
    );
    // … and gone by 400 ms.
    let late = rms(&h[(0.4 * sr) as usize..(0.5 * sr) as usize]);
    assert!(
        late < 1.0e-3 * peak,
        "the board rings too long: {late} against {peak}"
    );
    let end = rms(&h[(0.9 * sr) as usize..]);
    assert!(end < 1.0e-6 * peak, "the board never settles: {end}");
}

#[test]
fn the_board_sits_on_its_body_resonances() {
    // A soundboard's modes cluster in the low hundreds of hertz: the tap
    // carries more of its energy there than in the top of the treble, but
    // the hump is shelved so the mids are not buried under it.
    let sr = 48_000.0;
    let h = impulse_response(sr, 0, 0.5);
    let body = band_energy(&h, sr, 100.0, 500.0);
    let mids = band_energy(&h, sr, 500.0, 2000.0);
    let top = band_energy(&h, sr, 4000.0, 8000.0);
    assert!(
        body > top,
        "no body: {body} in the body against {top} on top"
    );
    assert!(
        body < 30.0 * mids,
        "the body hump buries the mids: {body} against {mids}"
    );
    assert!(
        mids > top,
        "the mids are weaker than the top: {mids} against {top}"
    );
}

#[test]
fn the_board_is_the_same_board_at_any_sample_rate() {
    // A 1 ms pulse of unit area through the board at 48 kHz and at 96 kHz:
    // the same physical board, so the same response, within a few percent.
    let mut peaks = Vec::new();
    for sr in [48_000.0f32, 96_000.0] {
        let mut board = Board::new(sr, 0);
        let width = (0.001 * sr) as usize;
        let mut peak = 0.0f32;
        for i in 0..(0.2 * sr) as usize {
            // The sampled continuous pulse: 1 ms tall enough for unit area.
            let x = if i < width { 1000.0 } else { 0.0 };
            peak = peak.max(board.step(x).abs());
        }
        peaks.push(peak);
    }
    let ratio = peaks[0] / peaks[1];
    assert!(
        (0.95..1.05).contains(&ratio),
        "the board changes with the sample rate: {peaks:?}"
    );
}

#[test]
fn the_board_has_width_but_one_body() {
    let sr = 48_000.0;
    let l = impulse_response(sr, 0, 0.3);
    let r = impulse_response(sr, 1, 0.3);
    let dot: f32 = l.iter().zip(&r).map(|(a, b)| a * b).sum();
    let corr = dot / (rms(&l) * rms(&r) * l.len() as f32);
    assert!(l != r, "left and right are the same channel");
    assert!(
        corr > 0.9,
        "left and right are different boards: correlation {corr}"
    );
}

#[test]
fn clear_silences_the_board() {
    let mut board = Board::new(48_000.0, 0);
    board.step(1.0);
    for _ in 0..100 {
        board.step(0.0);
    }
    board.clear();
    assert_eq!(board.step(0.0), 0.0);
}
