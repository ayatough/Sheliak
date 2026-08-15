//! Renders a **render job** to WAV on the native target.
//!
//! `sheliak render` already does this by loading `dsp.wasm` into Node, and that
//! is the canonical path — it runs the same binary the browser runs, so its
//! output cannot drift from what a listener hears. This exists for the one
//! thing that path cannot do: **host a native CLAP plugin**
//! ([workstreams §9](../../docs/workstreams.md)). A `.clap` is a dynamic
//! library, and no amount of design gets one into a browser tab.
//!
//! It deliberately knows nothing about Markdown. The notation is parsed in
//! TypeScript, and putting a second parser here would be two grammars to keep
//! in step — the thing the whole project is arranged to avoid. What crosses the
//! boundary is a *render job*: the flat parameter block per track, the loop's
//! events, and how long to render. That is the same content `worklet.js`
//! receives, written down.
//!
//! ```text
//! sheliak render song.md --emit-job job.json   # TypeScript: parse, compile
//! sheliak-render job.json -o out.wav           # this: synthesize
//! ```
//!
//! **This must agree with `web/src/audio/offline.ts` sample for sample.** Both
//! drive the same engine through the same ABI, so the block splitting, the
//! event dispatch, the loop wrap and the tail are copied from it deliberately
//! rather than reinvented; `scripts/check-render-parity.sh` renders a document
//! both ways and compares the bytes.

use std::process::ExitCode;

use sheliak_render::clap_host;

use serde::Deserialize;
use sheliak_dsp::multi::MultiEngine;
use sheliak_dsp::params::PARAM_COUNT;

/// The render quantum, as the worklet is called with.
const BLOCK: usize = 128;

const HELP: &str = "usage: sheliak-render <job.json> -o <out.wav> [--clap <plugin.clap>]

  <job.json>          from `sheliak render <song.md> --emit-job <job.json>`
  -o, --out <file>    where to write the WAV
  --clap <file>       run the finished mix through a CLAP plugin
  --clap-id <id>      which plugin, when the bundle carries more than one
  --list-clap <file>  list what a bundle carries, and exit

A `.clap` is a dynamic library, which is why this exists at all: the browser
renderer cannot load one. See docs/workstreams.md \u{a7}9.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    sample_rate: f32,
    tracks: Vec<JobTrack>,
    #[serde(rename = "loop")]
    loop_: JobLoop,
    /// Frames of loop to render, already multiplied out by the loop count.
    loop_frames: usize,
    /// Frames of tail after every note is released.
    tail_frames: usize,
    #[serde(default)]
    stems: bool,
}

#[derive(Deserialize)]
struct JobTrack {
    track: usize,
    id: String,
    params: Vec<f32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobLoop {
    length_samples: usize,
    events: Vec<JobEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobEvent {
    offset_samples: usize,
    track: usize,
    /// 0 = note on, 1 = note off.
    kind: u8,
    note: f32,
    #[serde(default)]
    velocity: f32,
}

/// One rendered span: the mix, plus each track's own output when asked for.
struct Rendered {
    l: Vec<f32>,
    r: Vec<f32>,
    stems: Vec<(usize, Vec<f32>, Vec<f32>)>,
}

fn new_stems(tracks: &[usize], total: usize) -> Vec<(usize, Vec<f32>, Vec<f32>)> {
    tracks
        .iter()
        .map(|t| (*t, vec![0.0; total], vec![0.0; total]))
        .collect()
}

/// Copies `n` frames of every requested stem out of the engine, as
/// `collectStems` does from the wasm buffers.
fn collect_stems(
    engine: &MultiEngine,
    stems: &mut [(usize, Vec<f32>, Vec<f32>)],
    n: usize,
    at: usize,
) {
    for (track, l, r) in stems.iter_mut() {
        // None for a track the engine does not have; the buffer stays the
        // silence it was allocated as.
        let Some((tl, tr)) = engine.track_out(*track) else {
            continue;
        };
        l[at..at + n].copy_from_slice(&tl[..n]);
        r[at..at + n].copy_from_slice(&tr[..n]);
    }
}

/// `renderLoop` from `offline.ts`, in Rust. The engine is constructed here
/// rather than by the caller for the same reason: a render that reused a
/// previous instance's state would not be reproducible.
fn render_loop(job: &Job, stem_tracks: &[usize]) -> (MultiEngine, Rendered) {
    let mut engine = MultiEngine::new(job.sample_rate);
    for track in &job.tracks {
        let mut block = [0.0f32; PARAM_COUNT];
        let n = track.params.len().min(PARAM_COUNT);
        block[..n].copy_from_slice(&track.params[..n]);
        engine.apply_patch(track.track, &block);
    }

    let total = job.loop_frames;
    let mut l = vec![0.0; total];
    let mut r = vec![0.0; total];
    let mut stems = new_stems(stem_tracks, total);
    let events = &job.loop_.events;
    let length = job.loop_.length_samples;

    let mut counter = 0usize;
    let mut ev_idx = 0usize;
    let mut written = 0usize;
    while written < total {
        while ev_idx < events.len() && events[ev_idx].offset_samples <= counter {
            let ev = &events[ev_idx];
            ev_idx += 1;
            // -1 / false, exactly as worklet.js sends them: use the patch's
            // glide, no legato.
            if ev.kind == 0 {
                engine.note_on_ex(ev.track, ev.note, ev.velocity, -1.0, false);
            } else {
                engine.note_off(ev.track, ev.note);
            }
        }
        let mut boundary = length;
        if ev_idx < events.len() {
            boundary = boundary.min(events[ev_idx].offset_samples);
        }
        let mut n = BLOCK
            .min(total - written)
            .min(boundary.saturating_sub(counter));
        if n == 0 {
            n = 1;
        }
        engine.process(&mut l[written..written + n], &mut r[written..written + n]);
        collect_stems(&engine, &mut stems, n, written);
        written += n;
        counter += n;
        while length > 0 && counter >= length {
            counter -= length;
            ev_idx = 0;
        }
    }
    (engine, Rendered { l, r, stems })
}

/// `renderTail`: every note released, the loop stopped, the effects and release
/// stages still running. Continues on the same engine.
fn render_tail(engine: &mut MultiEngine, total: usize, stem_tracks: &[usize]) -> Rendered {
    engine.all_notes_off();
    let mut l = vec![0.0; total];
    let mut r = vec![0.0; total];
    let mut stems = new_stems(stem_tracks, total);
    let mut written = 0usize;
    while written < total {
        let n = BLOCK.min(total - written);
        engine.process(&mut l[written..written + n], &mut r[written..written + n]);
        collect_stems(engine, &mut stems, n, written);
        written += n;
    }
    Rendered { l, r, stems }
}

// ------------------------------------------------------------------------ wav

const HEADER_BYTES: usize = 44;
const CHANNELS: u16 = 2;
const BITS: u16 = 16;
const FULL_SCALE: f64 = 32767.0;

/// The same conversion `wav.ts` performs, including its rounding.
///
/// JavaScript's `Math.round` is `floor(x + 0.5)`, which is *not* Rust's
/// `f32::round` — they disagree on exact negative halves, where JS rounds
/// towards positive infinity and Rust rounds away from zero. One sample in a
/// render landing on `-0.5` would be the whole difference between two files
/// that are supposed to be identical.
fn to_pcm16(v: f32) -> i16 {
    if !v.is_finite() {
        return 0;
    }
    let scaled = (v as f64) * FULL_SCALE;
    let rounded = (scaled + 0.5).floor();
    rounded.clamp(-FULL_SCALE - 1.0, FULL_SCALE) as i16
}

fn encode_wav(l: &[f32], r: &[f32], sample_rate: f32) -> Vec<u8> {
    let frames = l.len().min(r.len());
    let bytes_per_frame = u32::from(CHANNELS * BITS / 8);
    let data_bytes = frames as u32 * bytes_per_frame;
    let rate = sample_rate as u32;

    let mut out = Vec::with_capacity(HEADER_BYTES + data_bytes as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&CHANNELS.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * bytes_per_frame).to_le_bytes());
    out.extend_from_slice(&(bytes_per_frame as u16).to_le_bytes());
    out.extend_from_slice(&BITS.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes.to_le_bytes());
    for i in 0..frames {
        out.extend_from_slice(&to_pcm16(l[i]).to_le_bytes());
        out.extend_from_slice(&to_pcm16(r[i]).to_le_bytes());
    }
    out
}

/// `song.wav` + `lead` -> `song.lead.wav`, as `stemPath` does.
fn stem_path(out: &str, id: &str) -> String {
    let safe: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '-'
            }
        })
        .collect();
    match out.rfind('.') {
        Some(dot) => format!("{}.{}{}", &out[..dot], safe, &out[dot..]),
        None => format!("{out}.{safe}"),
    }
}

fn peak_of(l: &[f32], r: &[f32]) -> f32 {
    l.iter().chain(r.iter()).fold(0.0f32, |a, v| a.max(v.abs()))
}

// ----------------------------------------------------------------------- main

fn run() -> Result<String, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut job_path = None;
    let mut out = None;
    let mut clap_path: Option<String> = None;
    let mut clap_id: Option<String> = None;
    let mut list_clap: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-o" | "--out" => {
                i += 1;
                out = args.get(i).cloned();
            }
            "--clap" => {
                i += 1;
                clap_path = args.get(i).cloned();
            }
            "--clap-id" => {
                i += 1;
                clap_id = args.get(i).cloned();
            }
            "--list-clap" => {
                i += 1;
                list_clap = args.get(i).cloned();
            }
            "-h" | "--help" => {
                return Ok(HELP.into());
            }
            other if other.starts_with('-') => return Err(format!("unknown option {other}")),
            other => job_path = Some(other.to_string()),
        }
        i += 1;
    }
    // Listing is a question about a file, not a render: it needs no job.
    if let Some(path) = list_clap {
        let found = clap_host::describe(&path)?;
        if found.is_empty() {
            return Ok(format!("{path} declares no plugins"));
        }
        let mut report = format!("{path}:");
        for plugin in found {
            // The features are what say whether a host has to send it notes or
            // audio, so they are the useful half of a listing rather than trivia.
            let kind = if plugin.is_instrument() {
                "  [instrument — not supported yet]"
            } else {
                ""
            };
            report.push_str(&format!(
                "\n  {}  {}{}\n      {}",
                plugin.id,
                plugin.name,
                kind,
                plugin.features.join(", ")
            ));
        }
        return Ok(report);
    }

    let job_path = job_path.ok_or("no job file given (try --help)")?;
    let out = out.ok_or("no output file given: -o <out.wav>")?;

    let text = std::fs::read_to_string(&job_path)
        .map_err(|e| format!("cannot read the job {job_path}: {e}"))?;
    let job: Job =
        serde_json::from_str(&text).map_err(|e| format!("{job_path} is not a render job: {e}"))?;
    if job.tracks.is_empty() {
        return Err("the job has no tracks, so there is nothing to render".into());
    }

    let stem_tracks: Vec<usize> = if job.stems {
        job.tracks.iter().map(|t| t.track).collect()
    } else {
        Vec::new()
    };

    let (mut engine, body) = render_loop(&job, &stem_tracks);
    let total = job.loop_frames + job.tail_frames;
    let mut l = body.l;
    let mut r = body.r;
    l.resize(total, 0.0);
    r.resize(total, 0.0);
    let mut stems = body.stems;
    for (_, sl, sr) in stems.iter_mut() {
        sl.resize(total, 0.0);
        sr.resize(total, 0.0);
    }
    if job.tail_frames > 0 {
        let tail = render_tail(&mut engine, job.tail_frames, &stem_tracks);
        l[job.loop_frames..].copy_from_slice(&tail.l);
        r[job.loop_frames..].copy_from_slice(&tail.r);
        for (track, sl, sr) in stems.iter_mut() {
            if let Some((_, tl, tr)) = tail.stems.iter().find(|(t, _, _)| t == track) {
                sl[job.loop_frames..].copy_from_slice(tl);
                sr[job.loop_frames..].copy_from_slice(tr);
            }
        }
    }

    // The plugin sees the finished mix. Stems are left alone deliberately: they
    // are what each track produced, and a master-bus effect is not part of that.
    let mut hosted = None;
    if let Some(path) = clap_path {
        let mut plugin = clap_host::HostedPlugin::load(&path, clap_id.as_deref(), job.sample_rate)?;
        plugin.process(&mut l, &mut r)?;
        hosted = Some(format!("{} ({})", plugin.name, plugin.id));
    }

    std::fs::write(&out, encode_wav(&l, &r, job.sample_rate))
        .map_err(|e| format!("cannot write {out}: {e}"))?;

    let mut report = format!(
        "wrote {out} — {:.2}s · {} track{} · peak {:.1} dBFS",
        total as f32 / job.sample_rate,
        job.tracks.len(),
        if job.tracks.len() == 1 { "" } else { "s" },
        20.0 * peak_of(&l, &r).max(1.0e-9).log10(),
    );
    if let Some(plugin) = hosted {
        report.push_str(&format!("\n      through {plugin}"));
    }
    for track in &job.tracks {
        let Some((_, sl, sr)) = stems.iter().find(|(t, _, _)| *t == track.track) else {
            continue;
        };
        let path = stem_path(&out, &track.id);
        std::fs::write(&path, encode_wav(sl, sr, job.sample_rate))
            .map_err(|e| format!("cannot write {path}: {e}"))?;
        report.push_str(&format!("\n      {path}"));
    }
    Ok(report)
}

fn main() -> ExitCode {
    match run() {
        Ok(report) => {
            println!("{report}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("sheliak-render: {message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The conversion has to match `wav.ts`, and the interesting cases are the
    /// ones where JavaScript and Rust disagree about rounding on their own.
    #[test]
    fn pcm_conversion_rounds_the_way_javascript_does() {
        // +-0.5 are the only samples in range whose scaled value lands exactly
        // on a half: 32767 is odd, so the product is a half only when the input
        // is m/2 with m odd, and only +-0.5 is inside +-1. That makes them the
        // whole of the discriminating case.
        //
        // Math.round is floor(x + 0.5), so the negative half rounds *up*
        // towards zero: JS gives -16383 where Rust's f32::round gives -16384.
        assert_eq!(to_pcm16(0.5), 16384);
        assert_eq!(to_pcm16(-0.5), -16383);
        assert_ne!(to_pcm16(-0.5), (-0.5f32 * FULL_SCALE as f32).round() as i16);

        assert_eq!(to_pcm16(0.0), 0);
        assert_eq!(to_pcm16(1.0), 32767);
        assert_eq!(to_pcm16(-1.0), -32767);

        // Outside +-1 is clipped, not rescaled, and the floor is one lower than
        // the ceiling because two's complement has room for it.
        assert_eq!(to_pcm16(2.0), 32767);
        assert_eq!(to_pcm16(-2.0), -32768);

        // A non-finite sample is silence, exactly as `wav.ts` decides it: it
        // can only arrive from a bug, and infinity clamped to full scale would
        // be the loud version of a bug reaching someone's ears.
        assert_eq!(to_pcm16(f32::NAN), 0);
        assert_eq!(to_pcm16(f32::INFINITY), 0);
        assert_eq!(to_pcm16(f32::NEG_INFINITY), 0);
    }

    #[test]
    fn stem_paths_match_the_typescript_naming() {
        assert_eq!(stem_path("song.wav", "lead"), "song.lead.wav");
        assert_eq!(stem_path("out/mix.wav", "bass 1"), "out/mix.bass-1.wav");
        assert_eq!(stem_path("noext", "lead"), "noext.lead");
    }

    #[test]
    fn the_wav_header_is_the_canonical_44_bytes() {
        let wav = encode_wav(&[0.0, 0.0], &[0.0, 0.0], 48_000.0);
        assert_eq!(wav.len(), HEADER_BYTES + 2 * 4);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 8);
    }
}
