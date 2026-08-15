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
  --clap-instrument <file>
                      a CLAP instrument that plays one track's notes,
                      in place of the engine's voice for that track
  --clap-instrument-id <id>
                      which instrument, when the bundle carries more than one
  --clap-track <n>    the track the instrument plays (with --clap-instrument)
  --list-clap <file>  list what a bundle carries, and exit
                      with --clap-id, list that plugin's parameters instead

A `.clap` is a dynamic library, which is why this exists at all: the browser
renderer cannot load one. See docs/workstreams.md \u{a7}9 and \u{a7}13.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    sample_rate: f32,
    tracks: Vec<JobTrack>,
    /// Absent in a job written before the `plugin` fence existed.
    #[serde(default)]
    plugin_tracks: Vec<JobPluginTrack>,
    #[serde(rename = "loop")]
    loop_: JobLoop,
    /// Frames of loop to render, already multiplied out by the loop count.
    loop_frames: usize,
    /// Frames of tail after every note is released.
    tail_frames: usize,
    #[serde(default)]
    stems: bool,
}

/// A document's parameter settings for one plugin track, in the order written.
///
/// The job carries them as the notation spelled them — a percentage of the
/// parameter's own range, or the plugin's own number — because only the side
/// holding the plugin knows what either means.
fn settings_of(track: &JobPluginTrack) -> Result<Vec<clap_host::ParamSetting>, String> {
    let mut out = Vec::with_capacity(track.params.len());
    for (name, raw) in &track.params {
        let kind = raw.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let value = raw
            .get("value")
            .and_then(serde_json::Value::as_f64)
            .ok_or_else(|| format!("track `{}`: parameter \"{name}\" has no number", track.id))?;
        out.push(clap_host::ParamSetting {
            name: name.clone(),
            normalized: match kind {
                "normalized" => true,
                "plain" => false,
                other => {
                    return Err(format!(
                        "track `{}`: parameter \"{name}\" has an unknown kind \"{other}\"",
                        track.id
                    ))
                }
            },
            value,
        });
    }
    Ok(out)
}

/// A track whose voice is a plugin, named by the document's `plugin` fence.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobPluginTrack {
    track: usize,
    id: String,
    /// The plugin's CLAP id. Resolved to a file here, because which file
    /// carries it is a property of this machine and not of the song.
    from: String,
    #[serde(default)]
    params: std::collections::BTreeMap<String, serde_json::Value>,
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
///
/// `muted` withholds those tracks' events: when a CLAP instrument is that
/// track's voice, the engine's voice must not also play them (§13).
fn render_loop(job: &Job, stem_tracks: &[usize], muted: &[usize]) -> (MultiEngine, Rendered) {
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
            if muted.contains(&ev.track) {
                continue;
            }
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

/// Expands one track's loop events into absolute frames across every loop
/// pass, firing exactly where `render_loop`'s wrapping counter would fire
/// them — plus a release per key still held where the tail begins, which is
/// this path's `all_notes_off`.
///
/// The whole span is expanded up front because an instrument is driven the
/// other way round from the engine: whole blocks with in-block offsets, not
/// blocks split at event boundaries (§13). Sharing the engine's loop would
/// force its splitting onto a plugin that never asked for it.
fn instrument_notes(job: &Job, track: usize) -> Vec<clap_host::NoteEvent> {
    let length = job.loop_.length_samples;
    let total = job.loop_frames;
    let mut out = Vec::new();
    let mut held: Vec<u8> = Vec::new();
    let mut base = 0usize;
    loop {
        for ev in &job.loop_.events {
            if ev.track != track {
                continue;
            }
            // An offset past the loop length never fires in the engine path
            // either: the counter wraps before reaching it.
            if length > 0 && ev.offset_samples >= length {
                continue;
            }
            let frame = base + ev.offset_samples;
            if frame >= total {
                continue;
            }
            let key = ev.note.round().clamp(0.0, 127.0) as u8;
            let on = ev.kind == 0;
            out.push(clap_host::NoteEvent {
                frame,
                on,
                key,
                velocity: ev.velocity,
            });
            if on {
                if !held.contains(&key) {
                    held.push(key);
                }
            } else {
                held.retain(|k| *k != key);
            }
        }
        base += length;
        if length == 0 || base >= total {
            break;
        }
    }
    // Sorted so the releases arrive in one order however the notes were
    // written; `frame == total` lands on the first frame of the tail.
    held.sort_unstable();
    out.extend(held.into_iter().map(|key| clap_host::NoteEvent {
        frame: total,
        on: false,
        key,
        velocity: 0.0,
    }));
    out
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
    let mut instrument_path: Option<String> = None;
    let mut instrument_id: Option<String> = None;
    let mut instrument_track: Option<usize> = None;
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
            "--clap-instrument" => {
                i += 1;
                instrument_path = args.get(i).cloned();
            }
            "--clap-instrument-id" => {
                i += 1;
                instrument_id = args.get(i).cloned();
            }
            "--clap-track" => {
                i += 1;
                let raw = args.get(i).ok_or("--clap-track needs a track number")?;
                instrument_track =
                    Some(raw.parse().map_err(|_| {
                        format!("--clap-track wants a track number, got \"{raw}\"")
                    })?);
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
    // Listing one plugin's parameters is what someone writing a `plugin` fence
    // actually needs: the names it accepts, and what each one's range is.
    if let (Some(path), Some(id)) = (&list_clap, &clap_id) {
        let plugin = clap_host::HostedPlugin::load(path, Some(id), 48_000.0)?;
        let params = plugin.parameters().to_vec();
        if params.is_empty() {
            return Ok(format!("{} ({id}) has no parameters", plugin.name));
        }
        let mut report = format!("{} ({id}):", plugin.name);
        for p in &params {
            report.push_str(&format!(
                "\n  {:<24} {} .. {}   default {}",
                p.name.to_lowercase().replace([' ', '-'], "_"),
                p.min,
                p.max,
                p.default
            ));
        }
        return Ok(report);
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
                "  [instrument — plays a track: --clap-instrument]"
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

    // The pairing is checked before anything renders: half a flag pair is a
    // mistake, not a render with a surprise in it.
    let instrument = match (instrument_path, instrument_track) {
        (Some(path), Some(track)) => Some((path, track)),
        (Some(_), None) => {
            return Err("--clap-instrument needs --clap-track <n>: which track it plays".into())
        }
        (None, Some(_)) => {
            return Err("--clap-track does nothing without --clap-instrument <plugin.clap>".into())
        }
        (None, None) => {
            if instrument_id.is_some() {
                return Err(
                    "--clap-instrument-id does nothing without --clap-instrument <plugin.clap>"
                        .into(),
                );
            }
            None
        }
    };
    // Loaded before the engine runs so a missing plugin fails in milliseconds
    // rather than after the whole render.
    let mut instruments: Vec<(clap_host::HostedPlugin, usize)> = Vec::new();
    if let Some((path, track)) = instrument {
        instruments.push((
            clap_host::HostedPlugin::load(&path, instrument_id.as_deref(), job.sample_rate)?,
            track,
        ));
    }

    // The document's own plugin tracks. `--clap-instrument` stays for driving a
    // plugin a document does not name — proving a plugin works before writing a
    // fence for it — and a flag naming a track the document already claims is a
    // contradiction rather than an override.
    for declared in &job.plugin_tracks {
        if instruments.iter().any(|(_, t)| *t == declared.track) {
            return Err(format!(
                "--clap-track {} is the track `{}`, which the document already plays with {}",
                declared.track, declared.id, declared.from
            ));
        }
        let path = clap_host::find_by_id(&declared.from)?;
        let text = path.display().to_string();
        let mut plugin =
            clap_host::HostedPlugin::load(&text, Some(&declared.from), job.sample_rate)?;
        plugin.set_params(&settings_of(declared)?)?;
        instruments.push((plugin, declared.track));
    }

    let stem_tracks: Vec<usize> = if job.stems {
        job.tracks.iter().map(|t| t.track).collect()
    } else {
        Vec::new()
    };

    let muted: Vec<usize> = instruments.iter().map(|(_, track)| *track).collect();
    let (mut engine, body) = render_loop(&job, &stem_tracks, &muted);
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

    // The instrument plays its track over the whole span, tail included — its
    // release ring is the tail, the way the engine's own voices ring out. Its
    // output joins the mix where the engine's voice would have: added to the
    // other tracks, before any mix effect.
    let mut played: Vec<String> = Vec::new();
    for (plugin, track) in instruments.iter_mut() {
        let notes = instrument_notes(&job, *track);
        let mut il = vec![0.0; total];
        let mut ir = vec![0.0; total];
        plugin.render_notes(&notes, &mut il, &mut ir)?;
        for i in 0..total {
            l[i] += il[i];
            r[i] += ir[i];
        }
        // The track's stem is what its voice produced, and its voice is now the
        // plugin; the engine's silence would be a stem-shaped lie.
        for (t, sl, sr) in stems.iter_mut() {
            if t == track {
                sl.copy_from_slice(&il);
                sr.copy_from_slice(&ir);
            }
        }
        played.push(format!(
            "track {track} played by {} ({})",
            plugin.name, plugin.id
        ));
    }

    // A plugin's output joins the mix *after* `MultiEngine` has already put its
    // own sum through the master guard, so the sum of the two is outside the
    // guarantee the engine makes: Kars at its defaults takes this document to
    // +5.4 dBFS, which the WAV encoder then hard-clips. Putting the total back
    // through the same guard restores "the master bus is bounded" for audio
    // that did not all come from the engine.
    //
    // Only when a plugin actually contributed. The guard is bit-transparent
    // below 0.95 but not above it, and a plugin-free render must stay identical
    // to what the browser produces (`scripts/check-render-parity.sh`).
    if !played.is_empty() {
        for i in 0..total {
            l[i] = sheliak_dsp::multi::soft_clip_master(l[i]);
            r[i] = sheliak_dsp::multi::soft_clip_master(r[i]);
        }
    }

    let applied: usize = job.plugin_tracks.iter().map(|t| t.params.len()).sum();

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
        job.tracks.len() + job.plugin_tracks.len(),
        if job.tracks.len() + job.plugin_tracks.len() == 1 {
            ""
        } else {
            "s"
        },
        20.0 * peak_of(&l, &r).max(1.0e-9).log10(),
    );
    for entry in &played {
        report.push_str(&format!("\n      {entry}"));
    }
    if applied > 0 {
        report.push_str(&format!(
            "\n      {applied} plugin parameter(s) set from the document"
        ));
    }
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

    fn a_job(length: usize, loop_frames: usize, events: Vec<JobEvent>) -> Job {
        Job {
            sample_rate: 48_000.0,
            plugin_tracks: Vec::new(),
            tracks: Vec::new(),
            loop_: JobLoop {
                length_samples: length,
                events,
            },
            loop_frames,
            tail_frames: 0,
            stems: false,
        }
    }

    fn ev(offset_samples: usize, track: usize, kind: u8, note: f32) -> JobEvent {
        JobEvent {
            offset_samples,
            track,
            kind,
            note,
            velocity: 0.8,
        }
    }

    /// The expansion has to fire where the engine's wrapping counter fires:
    /// once per loop pass, at `pass * length + offset`, for this track only.
    #[test]
    fn instrument_notes_repeat_per_loop_pass_and_ignore_other_tracks() {
        let job = a_job(
            1000,
            2000,
            vec![ev(0, 0, 0, 57.0), ev(100, 1, 0, 60.0), ev(500, 0, 1, 57.0)],
        );
        let notes = instrument_notes(&job, 0);
        let frames: Vec<(usize, bool)> = notes.iter().map(|n| (n.frame, n.on)).collect();
        assert_eq!(
            frames,
            vec![(0, true), (500, false), (1000, true), (1500, false)]
        );
        assert!(notes.iter().all(|n| n.key == 57));
    }

    /// A key still held when the loop span ends gets its release on the first
    /// frame of the tail — the engine path's `all_notes_off`, written as an
    /// event because that is the only language an instrument plugin has.
    #[test]
    fn instrument_notes_release_held_keys_where_the_tail_begins() {
        let job = a_job(1000, 2000, vec![ev(0, 0, 0, 57.0), ev(200, 0, 0, 60.0)]);
        let notes = instrument_notes(&job, 0);
        let releases: Vec<(usize, u8)> = notes
            .iter()
            .filter(|n| !n.on)
            .map(|n| (n.frame, n.key))
            .collect();
        // One release per held key, not per note-on that held it.
        assert_eq!(releases, vec![(2000, 57), (2000, 60)]);
    }

    /// An event past the loop length never fires in the engine path — the
    /// counter wraps before reaching it — so it must not fire here either.
    #[test]
    fn instrument_notes_drop_events_the_loop_never_reaches() {
        let job = a_job(1000, 2000, vec![ev(1200, 0, 0, 57.0)]);
        let notes = instrument_notes(&job, 0);
        assert!(notes.is_empty(), "got {notes:?}");
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
