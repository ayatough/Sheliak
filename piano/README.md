# Sheliak Piano

A physically modelled piano as a native CLAP instrument — modal strings
struck by a simulated felt hammer, no samples anywhere. Built to sit beside
Sheliak: load it in any CLAP host, or point a Sheliak document's `plugin`
fence at `io.github.ayatough.sheliak.piano` and let `sheliak-render` play it.

## Build and install

```bash
./scripts/build-piano-clap.sh          # from the repository root
```

The plugin lands in `piano/dist/` — `sheliak-piano.clap` on Linux and
Windows, a `Sheliak Piano.clap` bundle on macOS. Copy it into your host's
CLAP search path (`~/.clap` or `/usr/lib/clap` on Linux, `~/Library/Audio/
Plug-Ins/CLAP` on macOS, `%COMMONPROGRAMFILES%\CLAP` on Windows), rescan,
and play. To hear it without a DAW:

```bash
cargo run --release --example render_wav --manifest-path piano/Cargo.toml
```

writes `piano-demo.wav`.

## What is modelled

- **Strings.** Each key drives one to three detuned strings, each a bank of
  modal resonators (up to 128 partials in the bass). Partial frequencies
  follow the stiff-string law `f_n = n·f0·√(1+Bn²)` with a per-key
  inharmonicity curve. Tuning follows a Railsback-style stretch curve.
- **Two-stage decay, measured.** Every key runs its primary strings at a
  fast early decay rate and one quiet, slightly detuned aftersound bank at
  a slow late rate — the loud attack bloom that sinks into a singing tail.
  Both rates and the aftersound level are fitted per register to the
  Salamander Grand reference recordings (CC-BY Yamaha C5); without the
  fast first stage a piano note reads as a sustained, plucked string.
- **A soundboard band shape, measured.** Radiation falls below ~105 Hz and
  declines through the midrange (≈10 dB/octave above 200 Hz, shelving at
  −20 dB near the board's critical frequency), with a hashed per-mode
  mobility ripple standing in for the board's resonance peaks — different
  per channel, which is what decorrelates the stereo image. The shape is
  fitted so each note's partial profile matches the reference recordings.
- **Hammer.** A mass with a nonlinear felt spring (`F = K·ξ^p`, after
  Chaigne & Askenfelt) with Hunt–Crossley felt loss, integrated against the
  string's displacement at the strike point, sub-stepped during the
  millisecond of contact. Loud notes compress the felt into its stiff
  region, shortening the pulse and brightening the spectrum — velocity
  changes timbre, not just level.
- **Dampers and pedal.** Note-off drops a damper (a much faster decay set)
  unless the sustain pedal holds it off; the top octave and a half has no
  dampers, as on the real instrument. The pedal arrives as MIDI CC 64 or as
  the automatable `Sustain Pedal` parameter.
- **Voicing.** The per-key physical parameters are interpolated from anchors
  set by the published measurements, then levelled by a measured 88-entry
  output trim (`keys.rs`), the same job a technician's voicing does.
- **Longitudinal bite.** A struck wound string also compresses along its
  length, and that second mode series — around a kilohertz for the longest
  bass strings — is driven by the square of the contact force. The wound
  keys (up to G2) carry such a bank: at forte the bass bites like struck
  metal, at piano it stays round. Without it a piano bass reads as a
  plucked bass, which is exactly what the ears reported.
- **Strike noise.** A deterministic noise burst — key knock, shank thunk,
  soundboard thump — fires at the moment of felt contact, shaped per
  register (a dark few-millisecond thump in the bass, a shorter brighter
  knock in the treble) and routed through the same radiation and soundboard
  shaping as the strings. Its level rises faster with velocity than the
  string tone does, so it dominates a fortissimo attack and all but
  vanishes at pianissimo. The `Knock` parameter scales it.

Not modelled yet, in honesty: a resonating soundboard (a tone filter
stands in for it), sympathetic resonance between keys, una corda and
sostenuto, and repedalling half-damping. The top octave's fortissimo
levelling leans on the voicing table rather than the contact physics.
[ROADMAP.md](ROADMAP.md) is the ordered plan for closing these gaps,
written to be picked up by a fresh agent.

## Tuning it

Two layers, from cheap to deep.

**In the DAW, live:** `Hammer Hardness` (dark→bright at the source),
`Brightness` (a plain output lowpass), `Unison Detune` (beating and the
two-stage decay), `Decay`, `Damper`, `Stretch`, `Dynamics` (velocity curve),
`Knock` (the strike-noise level). Hardness, Detune, Stretch, Decay, Damper,
Dynamics and Knock are read at note-on — retrigger the note to hear the
change.

**In the source, rebuilt:** the character constants live in two files.

| Knob | Where | Moves the sound |
|---|---|---|
| `KNOCK_SCALE`, `KNOCK_LP_*`, `KNOCK_TAU_*` | `src/model.rs` | Strike-noise level, colour and length per register |
| `LONG_SCALE`, `LONG_SIGMA` | `src/model.rs` | Bass metallic bite: level and ring time |
| `long_f1` (`c_long` anchors) | `src/keys.rs` | Pitch of the bass bite cluster |
| `RADIATION_HZ` (105) | `src/model.rs` | Higher = less low fundamental, lighter bass |
| `SOUNDBOARD_HZ`/`_POW`/`_FLOOR` (200/0.85/0.1) | `src/model.rs` | The board's midrange decline and treble shelf |
| Felt loss `0.5 * hammer.vh` | `src/model.rs` (`hammer_step`) | More = duller attack, tamer treble lobes |
| `sigma2` anchors | `src/keys.rs` | Extra early decay of high partials |
| `t60_early` anchors | `src/keys.rs` | Attack-bloom length per register (fitted) |
| `t60_late`, `after_gain` anchors | `src/keys.rs` | Aftersound length and level (fitted) |
| `hammer_k` / `hammer_p` anchors | `src/keys.rs` | Felt stiffness curve: brightness vs velocity |
| `strike_pos` (0.12…0.10) | `src/keys.rs` | Comb position: which partials the hammer misses |
| `detune_cents`, polarisation `0.4 * detune` | `src/keys.rs`, `src/model.rs` | Unison shimmer and bass aftersound |
| `b` anchors (inharmonicity) | `src/keys.rs` | Metallic stretch of the partial series |
| `velocity_floor` | `src/keys.rs` | Treble dynamic-range compression |

The listening loop:

```bash
cargo run --release --example bass_demo     # or render_wav — writes a WAV
# edit, listen, repeat…
cargo run --release --example levels -- --retrim   # after level-shifting changes
# paste the printed block over OUTPUT_TRIM in src/keys.rs, then once more:
cargo test                                  # tuning/decay/level tests still hold?
./scripts/build-piano-clap.sh               # rebuild the .clap for the DAW
```

`--retrim` re-levels the keyboard after any change that shifts loudness
(damping, radiation, hammer curves). Skip it for pitch-only changes.

**Fitting to a reference recording** (ROADMAP workstream 5) closes the loop
with measurement instead of guesses:

```bash
cargo run --release --example note_wav -- 36 1.0 5.0 model_C2.wav  # model
cargo run --release --example analyze -- model_C2.wav 36           # measure it
cargo run --release --example analyze -- real_C2.wav  36           # measure the reference
# move the keys.rs anchors toward the reference's numbers, rebuild, repeat
```

`analyze` prints per-partial attack levels and early/late decay slopes
(dB/s = 60/T60) plus band medians — the exact quantities the `t60_early`,
`t60_late`, `after_gain`, soundboard and hammer anchors were fitted from.
References must be WAV (convert FLAC with `ffmpeg -i in.flac out.wav`). The
current anchors were fitted against the Salamander Grand Piano set
(CC-BY, `sfzinstruments/salamandergrandpiano`), keys A0–C6, and the fit is
sample-set agnostic: point the same loop at recordings of any piano.

## Determinism

The same events at the same sample rate render bit-identical audio: nothing
reads a clock or a random source, and the per-key variation is hashed from
the key number. This is what lets `render/tests/` treat the plugin path as a
verifiable render rather than an audition.

## Layout

| Path | Owns |
|---|---|
| `src/model.rs` | The instrument: voices, hammer contact, dampers, master path |
| `src/keys.rs` | Per-key physical parameters and the voicing table |
| `src/lib.rs` | The CLAP shell: entry, ports, params, state, MIDI |
| `examples/levels.rs` | The keyboard-balance survey behind the voicing table |
| `examples/render_wav.rs` | A demo passage to WAV, for ears |
| `examples/analyze.rs` | Per-partial measurement of a note — the fitting loop |
| `examples/note_wav.rs` | One key to WAV, the render half of that loop |
| `tests/model.rs` | Determinism, tuning, decay, pedal, boundedness |
| `tests/native.rs` | The plugin driven through the CLAP ABI, as a DAW would |
