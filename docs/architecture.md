# Architecture

How Sheliak is put together, and the contracts the two halves hold each other to.
For the notation itself see [syntax.md](syntax.md); for building and testing see
[development.md](development.md).

## The pipeline

```
Markdown editor (TypeScript)
        |  fenced code block extraction        web/src/dsl/fences.ts
        v
DSL parser (TypeScript)                        web/src/dsl/{synth,fx,phrase,loop}.ts
        |  Patch IR (normalized, fully expanded)
        |  -> Float32Array(PARAM_COUNT)
        v  postMessage
AudioWorkletProcessor                          web/public/worklet.js
        |  writes the block into wasm memory, calls apply_patch(track)
        v
DSP core (Rust -> wasm32)                      dsp/src/
        |
        v
    out_l / out_r
```

Data flows one way and the boundary is narrow on purpose.

**The DSP core does not know the DSL.** Its entire input is a flat block of
normalized `f32` parameters plus note events. No field names, no units, no
strings. Two things follow: the notation can change without touching Rust, and
the core can be lifted into a native plugin later without dragging a parser along.

**The parser lives on the main thread, in TypeScript.** That is a deliberate trade
for iteration speed — putting it in Rust would mean a wasm rebuild on every
notation change. The output format (Patch IR) is what is being stabilized, so the
parser can move to Rust later without the contract moving with it.

**Unit conversion happens on the TypeScript side, always.** dB to linear, `%` to
`0..1`, kHz to Hz, musical time (`1/8`, `2bar`, `1.5beat`) to seconds or Hz from
the BPM, `st`/`c` to semitones and cents. The DSP core receives numbers that are
already in its own units.

## Repository layout

```
dsp/                 Rust DSP core
  src/lib.rs           raw WASM exports (no wasm-bindgen)
  src/params.rs        parameter block layout — contract file
  src/engine.rs        voice allocation and the per-track signal path
  src/multi.rs         track mixing and the master guard
  src/oscillator.rs    wavetable playback, unison
  src/tables.rs        procedural tables and FFT mipmaps
  src/filter.rs        TPT state-variable filter
  src/envelope.rs      exponential ADSR
  src/lfo.rs           LFO
  src/noise.rs         white / pink noise
  src/rng.rs           seeded RNG — the only source of randomness
  src/smoother.rs      one-pole parameter smoothing
  src/fx/              per-track effect chain, one file per effect
  tests/verify.rs      offline verification on the native target
web/
  public/worklet.js    AudioWorkletProcessor (plain JS, self-contained)
  src/shared/params.ts parameter block layout — contract file
  src/dsl/             fence extraction, YAML subset, parsing, canonical
                       formatting, the editing operations, surgical edits
  src/gui/             step sequencer and parameter panel
  src/audio/           AudioContext, wasm loading, worklet messaging
  src/defaultDoc.ts    the document the editor opens with
scripts/             build helpers
docs/                this
```

`dsp` is built as both a `cdylib` (for `wasm32-unknown-unknown`) and an `rlib`
(so the same code can be tested on the native target without a browser).

## The WASM ABI

Raw exports, no `wasm-bindgen`. Up to `MAX_TRACKS = 8` tracks, each with its own
patch, voices and effect chain; wavetable mipmaps are shared across all of them.

```
memory: WebAssembly.Memory

init(sample_rate: f32)          reset everything, build tables and mipmaps.
                                the only place allocation is allowed
params_ptr(track: u32) -> u32   offset of that track's f32 x PARAM_COUNT block
apply_patch(track: u32)         read the block and apply it (no allocation)
note_on(track: u32, note: f32, velocity: f32, glide_s: f32, legato: u32)
                                note may be fractional. glide_s < 0 = use the
                                patch's voice.glide; legato != 0 = bend the
                                sounding voice instead of starting a note
note_off(track: u32, note: f32)
all_notes_off()                 fast fade to silence on every track
process(nframes: u32)           nframes <= 128; writes out_l / out_r
master_guard(nframes: u32)      re-apply the master guard to out_l / out_r,
                                for a host that added audio of its own
out_l_ptr() -> u32              f32 x 128
out_r_ptr() -> u32              f32 x 128
out_track_l_ptr(track: u32)     f32 x 128 — that track's own output for the
out_track_r_ptr(track: u32)     block just rendered; 0 (null) out of range
```

- **The per-track taps are stems.** `out_track_*_ptr` points at the buffer that
  track wrote in the last `process`, after its own effect chain and before the
  tracks are summed, so **the stems add back up to the mix exactly** — the
  master bus does nothing but sum, and its soft-clip guard is the identity below
  `CLIP_KNEE`. Only the first `nframes` are meaningful and only until the next
  `process`, so a caller collecting stems copies them block by block; a track
  that fell dormant has its buffer cleared rather than left holding the block it
  stopped on. `dsp/tests/verify.rs` checks all three properties, and
  `web/src/integration.test.ts` checks the sum through the real binary.
- A track index outside `0..MAX_TRACKS` is ignored, never a panic. Panics abort.
- A track with no patch applied is silent and costs nothing.
- **`note_on` carries the glide and legato a glissando needs**
  ([workstreams §10](workstreams.md#10-what-the-dsp-core-needs)). `glide_s` is
  that note's glide in seconds; anything negative — the worklet sends `-1` —
  means "use the patch's `voice.glide`", which is what the export did when it
  took three arguments. `legato != 0` bends the newest sounding, unreleased
  voice on the track to the new pitch rather than starting a note: oscillator
  phases, both envelopes and the filter state carry on, so a slide is one note
  instead of two. It is monophonic per track — one voice is taken over — and it
  keeps that voice's velocity, since velocity scales the gain and feeds the mod
  matrix, and moving it mid-note would step both. With nothing to bend, a legato
  note-on is an ordinary one. The parameter block layout does not change.
- **Events are sample-accurate.** The worklet splits the 128-frame render quantum
  at event boundaries and calls `process(n1); note_on(...); process(n2); ...`.
  The DSP core has no event queue and needs none.
- `apply_patch()` is called while audio is running. Every parameter is smoothed
  (one-pole, roughly 5 ms); cutoff and pitch are smoothed in the log domain, in
  cents, so a sweep sounds even.
- **No allocation in `process()`.** Voices, buffers, delay lines and tables all
  come from `init()`.

## The parameter block

`dsp/src/params.rs` and `web/src/shared/params.ts` define the same constants. They
are one file written twice, and a disagreement between them is silent — the audio
just comes out wrong. Change both in the same commit.

| Region | Base | Contents |
|---|---|---|
| Global | 0 | `POLYPHONY` (1–16), `GLIDE_S`, `MASTER_GAIN` (linear), `SEED` |
| Osc A | 8 | `ENABLED`, `TABLE_ID`, `LEVEL`, `MORPH`, `UNISON` (1–7), `DETUNE_CENTS`, `SPREAD`, `TUNE_SEMI`, `TUNE_CENTS`, `PHASE_RANDOM` |
| Osc B | 24 | as above |
| Filter | 40 | `MODE` (0 = lp12, 1 = lp24, 2 = hp12, 3 = bp12), `CUTOFF_HZ`, `RES`, `DRIVE`, `KEYTRACK` |
| Env amp | 48 | `A_S`, `D_S`, `S`, `R_S` (seconds) |
| Env filter | 52 | as above |
| LFO | 56 | `WAVE` (0 = sine, 1 = tri, 2 = saw, 3 = square), `RATE_HZ`, `PHASE` |
| Mod slots | 64–95 | 8 slots of `[SRC, DST, AMOUNT, reserved]` |
| Noise | 96 | `ENABLED`, `LEVEL` (linear), `COLOR` (0 = white, 1 = pink) |
| FX order | 104–111 | effect type ids in processing order, 0 = empty |
| FX params | 112–175 | one 8-float block per chain **slot**: `base = 112 + slot * 8` |

`PARAM_COUNT = 192`.

**Effect type ids** — append, never renumber:

| id | Type | Parameters |
|---|---|---|
| 1 | dist | `DRIVE`, `MIX`, `MODE` (0 = tanh, 1 = fold, 2 = clip), `TONE_HZ` |
| 2 | eq | `LOW_DB`, `MID_DB`, `HIGH_DB`, `MID_FREQ_HZ` (shelves fixed at 120 Hz / 6 kHz) |
| 3 | chorus | `RATE_HZ`, `DEPTH`, `MIX` |
| 4 | phaser | `RATE_HZ`, `DEPTH`, `FEEDBACK`, `MIX`, `STAGES` (2–8 even), `CENTER_HZ` |
| 5 | flanger | `RATE_HZ`, `DEPTH`, `FEEDBACK`, `MIX` |
| 6 | delay | `TIME_S` (≤ 2.0), `FEEDBACK`, `MIX`, `PINGPONG`, `TONE_HZ` |
| 7 | reverb | `SIZE`, `DAMP`, `MIX`, `PREDELAY_S` (≤ 0.25), `WIDTH` |
| 8 | mbcomp | `THRESH_{LOW,MID,HIGH}_DB`, `RATIO`, `ATTACK_S`, `RELEASE_S`, `MAKEUP` (crossovers fixed at 120 Hz / 2.5 kHz) |

The chain is per track, in stereo: it runs on that track's output, after its
voices are summed and its level applied, which is why `FX_*` lives in the track's
own parameter block. The tracks are summed after that and the master bus does
nothing but the soft-clip guard. Each type appears at most once.

**A block belongs to a slot, not to a type.** An effect's parameters are at the
block of the position it occupies in the chain, so moving it along the chain
moves its parameters with it, and the region is a fixed 8 x 8 = 64 floats
however many effect types come to exist. Type ids are names, not addresses:
adding a ninth type needs no room reserved for it and does not move anything.
Two instances of one type still cannot coexist — the chain drops duplicates —
because each type has one instance per track to hold its buffers; that is the
remaining half of the problem, and it is a memory question rather than a layout
one ([workstreams §12](workstreams.md#12-a4-decided-before-it-is-written)).

**Modulation sources**: 0 none, 1 `env.filter`, 2 `env.amp`, 3 `lfo.1`,
4 `velocity`. Envelopes are `0..1`, the LFO is bipolar `-1..1`, velocity is `0..1`.

**Modulation destinations**, and what `AMOUNT` means for each:

| id | Target | Unit |
|---|---|---|
| 1 | `filter.cutoff` | cents |
| 2 | `osc1.morph` | normalized delta |
| 3 | `osc2.morph` | normalized delta |
| 4 | `pitch` (all oscillators) | cents |
| 5 | `amp` | normalized delta, added before the gain multiply |

LFO tempo sync is resolved to Hz on the TypeScript side and rewritten when the
BPM changes.

## Wavetables

Tables are generated procedurally in Rust at `init()`, 2048 samples a frame. The
TypeScript side holds nothing but a name-to-id map.

| id | Name | Frames |
|---|---|---|
| 0 | `basic/sine` | 1 |
| 1 | `basic/tri` | 1 |
| 2 | `basic/saw` | 1 |
| 3 | `basic/square` | 1 |
| 4 | `morph/pwm` | 64, pulse width 50% → 5% |
| 5 | `morph/fold` | 64, increasing wavefold |

Each table is mipmapped per octave with an FFT so that harmonics above the Nyquist
limit are removed rather than folded back as aliasing. Playback selects a mip
level from the fundamental and crossfades to the adjacent one; samples are
interpolated with a 4-point Hermite curve and frames linearly. The phase
accumulator is fixed-point `u32`.

Procedural generation is also why a song carries no binary: there is no wavetable
file to ship.

## Patch IR

The parser's output, typed in `web/src/dsl/ir.ts`. **The IR is never sent to the
worklet** — TypeScript converts it into a `Float32Array(PARAM_COUNT)` and posts
that.

Unspecified fields are filled with defaults, and the fully expanded result can be
dumped as JSON. That is a transparency requirement, not a debugging aid: a patch
should never depend on a value you cannot see. The defaults are listed in
[syntax.md](syntax.md).

## The worklet protocol

`web/public/worklet.js` is self-contained plain JavaScript, because an
AudioWorklet module is fetched by URL at runtime and never passes through the
bundler.

```
main -> worklet:
  { type: 'load-wasm',    bytes: ArrayBuffer }
  { type: 'patch',        track: number, params: Float32Array }
  { type: 'clear-tracks', keep: number }
  { type: 'loop',         loop: LoopIR | null }
  { type: 'transport',    playing: boolean }
  { type: 'plugins',      bundles: ArrayBuffer[], tracks: CompiledPluginTrack[] }
  { type: 'plugin-params', track: number, params: Record<string, PluginParam> }

worklet -> main:
  { type: 'ready' }
  { type: 'position', samples: number, loopLen: number }
  { type: 'plugin-status', tracks: number, errors: string[] }
```

`load-wasm` transfers **bytes, not a `WebAssembly.Module`**. Chrome drops a
compiled module sent through `postMessage` without cross-origin isolation
(COOP/COEP), silently, and the worklet never boots. Sheliak deliberately avoids
COOP/COEP, so the worklet compiles the bytes itself.

`plugins` carries the WCLAP bundles as bytes for the same reason `load-wasm`
does, and it is sent only when *which* plugin sits on *which* track changed:
rebuilding means new plugin instances, and a sounding note stops. A parameter
that moved goes through `plugin-params` instead, which reaches the running
plugin as CLAP events — that is what makes a knob usable while the song plays,
and it is the same path the panel uses for every gesture. The host that runs them
is TypeScript and reaches the worklet through `globalThis.SheliakWclap`, put
there by `wclap-host.js` — a second `addModule()` into the same global scope,
built by `npm run build:worklet-host`. Without that file the app still runs;
a document that names a plugin gets a `plugin-status` saying why it is silent.

A plugin track's audio is added into the engine's own output buffers and the
total goes back through `master_guard`, because audio that did not come from the
engine is outside the bound the engine promised.

```ts
interface LoopIR {
  lengthSamples: number;
  events: LoopEvent[];          // ascending by offsetSamples
}
interface LoopEvent {
  offsetSamples: number;
  track: number;                // 0..MAX_TRACKS-1
  kind: 0 | 1;                  // 0 = noteOn, 1 = noteOff
  note: number;                 // MIDI note number
  velocity: number;             // 0..1, noteOn only
}
```

Track assignment: the order in which ```` ```synth ```` fences appear in the
document is the track index. A `loop` line binds to the `synth` fence with the
same id.

The worklet keeps position with a sample counter and dispatches events at
`counter % lengthSamples`. **No `setTimeout` or `setInterval` scheduling** — it is
not sample-accurate and it drifts.

## Determinism

The same document and the same seed must produce bit-identical audio. This is
what makes a song reproducible for anyone who clones the repository, and it is why
a rendered result can be checksummed at all.

- Every random value derives from the patch seed via `dsp/src/rng.rs`. Nothing
  reads a clock or a process-global RNG.
- Pink noise is filtered white noise from that same seed.
- The effect LFOs (chorus, phaser, flanger) free-run from `init()`, so the same
  event sequence after the same `init()` gives the same output.

`dsp/tests/verify.rs` renders offline on the native target and checks
determinism, aliasing, DC offset and clicks. Since nobody working on this can
necessarily listen to the result, those four checks are the substitute — see
[AGENTS.md](../AGENTS.md).
