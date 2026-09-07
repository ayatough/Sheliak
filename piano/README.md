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
and play.

**Building in WSL for a Windows DAW?** A plain build in WSL produces a
*Linux* binary, and a Windows host's scan will just say "failed" on it.
Cross-build instead:

```bash
sudo apt install mingw-w64
rustup target add x86_64-pc-windows-gnu
./scripts/build-piano-clap.sh --windows
```

then copy `piano/dist/sheliak-piano.clap` to
`C:\Program Files\Common Files\CLAP\` and rescan.

To hear it without a DAW:

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
- **The soundboard.** Everything leaves through a modal board (`board.rs`):
  48 damped modes fitted by `tools/fit_board.py` to a recording of a
  grand's board being tapped, one biquad each, in two banks with their
  mode weights nudged apart for width. A note carries the board's ring and
  the attack carries its thump. The tap's own low body hump (120–450 Hz,
  some 20 dB above the rest) is pulled down `BOARD_HUMP_DB` through a
  smooth shelf, and each key is levelled by what the board lets through of
  its partials, so the voicing table stays near unity.
- **Two-stage decay.** Every key's banks are split into a *prompt sound* —
  the struck strings moving together, losing energy to the bridge
  `PROMPT_DECAY` times faster than the key's long time constant — and one
  quieter, slightly detuned *aftersound* bank kept at that long constant
  (Weinreich's two-stage decay). The note steps down 10–15 dB in its first
  half second and then settles into a tail that is still there seconds
  later, instead of sustaining evenly like a plucked bass.
- **Dampers and pedal.** Note-off drops a damper (a much faster decay set)
  unless the sustain pedal holds it off; the top octave and a half has no
  dampers, as on the real instrument. The pedal arrives as MIDI CC 64 or as
  the automatable `Sustain Pedal` parameter.
- **Voicing.** The per-key physical parameters are interpolated from anchors
  set by the published measurements, then levelled by a measured 88-entry
  output trim (`keys.rs`), the same job a technician's voicing does.
- **The strike noise.** At the instant the felt lands, each voice fires a
  short deterministic noise burst in two parts: a broadband *knock* (the
  hammer and its shank — brighter and shorter toward the treble, brighter
  still for a harder hammer or a faster blow) and a low *thump* (the blow
  reaching the board and key bed — heavier in the bass), coloured by a
  small radiator's lowpass and highpass corners and then, like the strings,
  by the board. The burst
  follows touch more steeply than the tone, so it is a real part of a
  fortissimo attack and absent from a pianissimo one; the `Knock` parameter
  scales it. The noise sequence is hashed from the key number and its peak
  is calibrated at note-on, so it renders identically every time and knocks
  at the same level on every key.

Not modelled yet, in honesty: sympathetic resonance between keys, una
corda and sostenuto, and repedalling half-damping. The board is a fitted
recording rather than a plate model, so its modes do not move with a
change of scale or bracing. The top octave's fortissimo
levelling leans on the voicing table rather than the contact physics.
[ROADMAP.md](ROADMAP.md) is the ordered plan for closing these gaps,
written to be picked up by a fresh agent.

## Tuning it

Two layers, from cheap to deep.

**In the DAW, live:** `Hammer Hardness` (dark→bright at the source),
`Brightness` (a plain output lowpass), `Unison Detune` (beating and the
two-stage decay), `Decay`, `Damper`, `Stretch`, `Dynamics` (velocity curve),
`Knock` (the strike noise, 0 = tone alone, 2 = twice the measured level).
Hardness, Detune, Stretch, Decay, Damper, Dynamics and Knock are read at
note-on — retrigger the note to hear the change.

**In the source, rebuilt:** the character constants live in two files.

| Knob | Where | Moves the sound |
|---|---|---|
| `BOARD_MODES` | `src/board.rs`, from `tools/fit_board.py <tap.wav>` | The board itself: refit from another tap for another instrument |
| `BOARD_HUMP_DB` (10), `BOARD_HUMP_HZ` (500) | `src/board.rs` | How far the tap's low body hump is pulled down, and where the shelf ends; 0 dB = the recording as fitted, boomy |
| `BOARD_GAIN` (0.1), `BOARD_WIDTH` (0.25) | `src/board.rs` | Board level (then `--retrim`) and left/right spread of the modes |
| `RADIATION_HZ` (180), `SOUNDBOARD_HZ` (1500) | `src/model.rs` | The strike noise's own corners: thinner or fuller knock, brighter or duller thump |
| Felt loss `0.5 * hammer.vh` | `src/model.rs` (`hammer_step`) | More = duller attack, tamer treble lobes |
| `sigma2` anchors | `src/keys.rs` | Higher = treble partials die faster (piano), lower = they ring (harpsichord) |
| `t60` anchors | `src/keys.rs` | Overall note length per register |
| `PROMPT_DECAY` (8), `AFTERSOUND_GAIN` (0.45) | `src/model.rs` | How fast the first stage falls and where the tail takes over; 1 / 1 = one even decay |
| `hammer_k` / `hammer_p` anchors | `src/keys.rs` | Felt stiffness curve: brightness vs velocity |
| `strike_pos` (0.12…0.10) | `src/keys.rs` | Comb position: which partials the hammer misses |
| `detune_cents`, polarisation `0.4 * detune` | `src/keys.rs`, `src/model.rs` | Unison shimmer and the aftersound's beating |
| `b` anchors (inharmonicity) | `src/keys.rs` | Metallic stretch of the partial series |
| `velocity_floor` | `src/keys.rs` | Treble dynamic-range compression |
| `KNOCK_PEAK_*`, `THUMP_PEAK_*` | `src/model.rs` | Strike-noise level per register, as a peak against the tone's ~0.13 |
| `KNOCK_HZ_*`, `KNOCK_TAU_*` | `src/model.rs` | Colour and length of the knock, bass to treble |
| `THUMP_HZ`, `THUMP_Q`, `THUMP_TAU_*` | `src/model.rs` | Pitch, ring and length of the thump |
| `KNOCK_VELOCITY_POWER` | `src/model.rs` | How much faster than the tone the noise grows with touch |

The listening loop:

```bash
cargo run --release --example bass_demo     # or render_wav — writes a WAV
cargo run --release --example render_wav -- --knock 0 --out tone-only.wav  # A/B the strike noise
cargo run --release --example render_wav -- --passage sweep --out sweep.wav   # or octaves: register by register
# edit, listen, repeat…
cargo run --release --example levels -- --retrim   # after level-shifting changes
# paste the printed block over OUTPUT_TRIM in src/keys.rs, then once more:
cargo test                                  # tuning/decay/level tests still hold?
./scripts/build-piano-clap.sh               # rebuild the .clap for the DAW
```

`--retrim` re-levels the keyboard after any change that shifts loudness
(damping, the board, hammer curves). Skip it for pitch-only changes. The
survey measures the tone with `Knock` at 0: the strike noise is voiced
against the tone inside the model, so it must not steer the table.

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
