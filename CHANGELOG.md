# Changelog

All notable changes to Sheliak are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
`0.MINOR.PATCH` while the project is pre-1.0: **a minor bump may change the
notation**. See [docs/development.md](docs/development.md#versioning) for the
policy.

Nothing has been released yet. Everything below is on `main` and unreleased; the
first tag will close this section.

## [Unreleased]

### Added
- **A song is a Markdown file that makes sound.** Synth patches written in
  ```` ```synth ```` fences and note data in ```` ```loop ```` fences are parsed
  in the browser, compiled to a flat parameter block, and rendered by a Rust DSP
  core running as WebAssembly inside an AudioWorklet. Editing the text
  recompiles after 150 ms and takes effect without stopping playback, and a
  fence that fails to parse keeps playing its last valid patch instead of
  silencing the song.
- **A wavetable engine that stays clean at the top of the range.** Tables are
  generated procedurally at `init()` and mipmapped per octave with an FFT, so
  harmonics above the Nyquist limit are removed rather than folded back. Playback
  crossfades between adjacent mip levels, interpolates samples with a 4-point
  Hermite curve and frames linearly, and runs off a fixed-point phase
  accumulator. Six tables ship: sine, triangle, saw, square, a 64-frame PWM morph
  and a 64-frame wavefolder morph.
- **Two oscillators, unison, a filter and modulation.** Each voice has two
  wavetable oscillators with up to 7 unison voices, detune and stereo spread; a
  TPT state-variable filter in 12 dB low-pass, 24 dB low-pass, 12 dB high-pass or
  band-pass; two exponential ADSR envelopes; one LFO; and an 8-slot modulation
  matrix routing envelopes, the LFO and velocity to cutoff, morph, pitch and
  amplitude.
- **A noise source and a master effects chain.** Noise is generated per voice
  from a seeded RNG and mixed before the filter, in white or pink. Eight effect
  types — distortion, EQ, chorus, phaser, flanger, delay, reverb and a
  three-band compressor — run on the master bus in the order the `fx:` list is
  written.
- **Eight tracks.** Each ```` ```synth ```` fence is a track with its own patch,
  voices and effect chain; wavetable mipmaps are shared across all of them. Track
  outputs are summed with a soft-clip guard that only acts near full scale.
- **A GUI that edits the text, not a model beside it.** The step sequencer and
  the parameter panel are projections of the document: every gesture becomes the
  smallest possible text patch, driven by parser source positions, and flows back
  through the normal compile path. Comments, alignment and unrelated fields
  survive byte-for-byte, and value spellings are canonical so scrubbing a slider
  back and forth does not grow the file.
- **Bit-identical renders.** The same document and the same seed produce the same
  samples, verified offline on the native target along with checks for aliasing,
  DC offset and clicks at note boundaries and patch changes.
- **A published build.** GitHub Pages deploys the app on every push to `main`,
  after CI has passed.

### Changed
- **The interface is in English.** Button labels, status lines, editor hints and
  the document the editor opens with were Japanese while the code around them
  was English. The repository convention now covers the app itself, not only its
  source, so there is one language in the project rather than a boundary
  somewhere inside it. No musical content changed: the default song's fences are
  untouched, only its prose and comments.

### Documentation
- **MIT licence.**
- **[docs/workstreams.md](docs/workstreams.md): the note layer, redesigned.** The
  current `loop` fence carries every track's notes inline, which cannot show the
  shape of a line, cannot reuse a phrase, and has nowhere to put velocity or
  timing. The accepted replacement splits notes (`phrase`, an ASCII grid of pitch
  rows against time columns) from arrangement (`loop`, which binds a phrase to a
  track), addresses expression by coordinate with a cascade, and constrains
  editing to a finite operation set so that text edits and model edits can be
  proven to commute. Not implemented yet.
- **English is the source of truth.** The README and `docs/` are English;
  `docs/ja/` holds Japanese translations and the original design notes.
- **[AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md) and this
  changelog.** The working agreement, the contribution policy and the release
  process are written down rather than remembered.
