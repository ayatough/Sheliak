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
  inharmonicity curve; decay rates grow along the partial series and with
  frequency, and the detuned unison produces the beating and two-stage decay
  of a real key. Tuning follows a Railsback-style stretch curve.
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

Not modelled yet, in honesty: a soundboard (a tone filter stands in for it),
sympathetic resonance between keys, una corda and sostenuto, and repedalling
half-damping. The top octave's fortissimo levelling leans on the voicing
table rather than the contact physics.

## Tuning it

Two layers, from cheap to deep.

**In the DAW, live:** `Hammer Hardness` (dark→bright at the source),
`Brightness` (a plain output lowpass), `Unison Detune` (beating and the
two-stage decay), `Decay`, `Damper`, `Stretch`, `Dynamics` (velocity curve).
Hardness, Detune, Stretch, Decay, Damper and Dynamics are read at note-on —
retrigger the note to hear the change.

**In the source, rebuilt:** the character constants live in two files.

| Knob | Where | Moves the sound |
|---|---|---|
| `RADIATION_HZ` (180) | `src/model.rs` | Higher = less low fundamental, lighter bass |
| `SOUNDBOARD_HZ` (1500) | `src/model.rs` | Higher = brighter, glassier; lower = warmer, darker |
| Felt loss `0.5 * hammer.vh` | `src/model.rs` (`hammer_step`) | More = duller attack, tamer treble lobes |
| `sigma2` anchors | `src/keys.rs` | Higher = treble partials die faster (piano), lower = they ring (harpsichord) |
| `t60` anchors | `src/keys.rs` | Overall note length per register |
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
| `tests/model.rs` | Determinism, tuning, decay, pedal, boundedness |
| `tests/native.rs` | The plugin driven through the CLAP ABI, as a DAW would |
