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
- **Note events carry a glide time and a legato flag.** `note_on` is now
  `note_on(track, note, velocity, glide_s, legato)`: `glide_s` is that note's
  glide in seconds, a negative value asks for the patch's own `voice.glide`, and
  `legato` bends the sounding voice to the new pitch instead of starting a note,
  so a slide is one note rather than two. This is what the planned `gliss`
  gesture needs from the DSP core
  ([workstreams §10](docs/workstreams.md#10-what-the-dsp-core-needs)); nothing in
  the notation asks for it yet, so the worklet passes `-1` and `0` and the audio
  is bit-identical, which is checked against the previous build. The parameter
  block layout is unchanged.

- **The note layer: `phrase` grids, groups and a detail cascade.** Notes now live
  in ```` ```phrase ```` fences — an ASCII grid whose rows are pitches (scale
  degrees, absolute pitches or kit names) and whose columns are cells of time —
  and the ```` ```loop ```` fence became the arrangement, binding a track to a
  phrase by id. A phrase repeats to fill the loop. Expression is addressed by
  coordinate in an optional `detail:` block: `vel`, `nudge`, `gate`, `roll` and
  `gliss`, resolved through a cascade where the most specific entry wins per
  gesture and an address naming no note is an error. Notes sharing an onset and
  a glyph are one group, which is what `roll` strums; grouping never changes
  what you hear on its own.
- **One structure, one spelling.** The formatter derives row order, group tags,
  the beat ruler and the label alignment rather than preserving them, so
  `format(format(x)) == format(x)` — checked as a property over generated
  phrases. Fifteen operations (`web/src/dsl/ops.ts`) are the whole of what the
  GUI and an agent can do to a phrase, each of them total, canonical and local:
  placing a note rewrites one character, a detail entry one line, and the prose
  around the fence survives byte-for-byte. A property test over generated
  documents and operation sequences checks that applying an operation to the
  text and to the parsed model agree, including when both refuse.

- **A visual identity, generated rather than drawn.** A lyre — an elliptical arc
  whose stroke tapers to nothing at both ends — cradling β Lyrae, with five
  strings inside it lit one segment each as an arpeggio. `scripts/build-brand.mjs`
  is the source: it emits all fourteen SVGs under
  [assets/brand/](assets/brand/README.md) and the icons the web app serves, so the
  mark cannot drift between the eight files it appears in. CI re-runs it and fails
  if the committed output differs. The wordmark is drawn as monoline paths rather
  than set in a typeface, so no asset depends on a font being installed — which
  also means the typeface can still be chosen later without redrawing anything.
  The palette gains `#B07E00`, the gold for light backgrounds, because the brand
  gold sits at 1.9:1 on the cream and fails even the 3:1 threshold for graphics.
- **The app has a favicon, an icon set and a link preview.** `web/index.html`
  carries a description, `theme-color`, an SVG favicon, an Apple touch icon, a web
  manifest and Open Graph and Twitter card tags pointing at a 1200×630 image; the
  title says what Sheliak is rather than what it is built from. Nothing about the
  audio changed.
- **A link to the running app.** The README, its Japanese counterpart and the
  build instructions now point at <https://ayatough.github.io/Sheliak/>, which
  `deploy.yml` has been publishing since before anything said so.
- **A command line: `sheliak new` and `sheliak check`.** `new` writes the
  smallest song that makes a sound — one `synth` fence, one `phrase`, and the
  `loop` binding them — and never overwrites a file that exists; `--empty`
  writes a blank one. `check` runs the same `compile()` the browser runs and
  reports every error by line and column, exiting non-zero so a song can be
  gated in CI; it also warns about the two things a clean compile still leaves
  silent, a track no loop line binds and a phrase nothing plays, with `--strict`
  to fail on those and `--format json` for a caller that will act on the
  findings. Until now a syntax error could only be found by pasting the document
  into the browser. It is a Node program over the TypeScript parser rather than
  a second binary beside the DSP core, because a Rust CLI would mean parsing the
  notation twice. `npx github:ayatough/Sheliak check song.md` runs it with no
  clone and no Rust toolchain — Node.js 20 or newer is the only requirement —
  and `npm install && npm link` in a working copy puts `sheliak` on your `PATH`.
  There is a manifest at the repository root purely so those two have something
  to resolve: npm cannot install from a subdirectory of a git repository, and
  the CLI's package is `web/`. `npm install -g <git url>` is the one way in that
  does not work, because npm does not install dependencies before running a
  global package's `prepare`; publishing to npm is what fixes it. Inside a
  working copy `./scripts/sheliak` runs the CLI against the sources you are
  editing, rebuilding the bundle when it is stale.
- **`sheliak render` writes the song to a WAV.** The same `dsp.wasm`, the same
  sample-accurate scheduling as the AudioWorklet, off the audio thread — so the
  file is what the browser plays, and the same document and seed produce the
  same bytes on any machine. `--loops` repeats, `--tail 2s` renders the decay
  after the last note is released (off by default, so one loop is exactly
  loop-length and still loops seamlessly), `--sample-rate` picks the rate
  musical time resolves against. It refuses a document that does not compile
  rather than writing one with a track silently missing. The scheduling moved
  out of the end-to-end test into `web/src/audio/offline.ts` so that the test
  and the renderer cannot drift apart; a second copy of the ABI mirror is
  exactly what that test exists to catch.
- **`sheliak serve` points the app at a file.** The app opened a document
  compiled into the bundle and kept the song in a textarea, so nothing survived
  a reload and auditioning meant copy-paste. `serve song.md` runs the dev server
  on your file: saving it in your own editor reloads the sound without stopping
  the transport, and the step sequencer and parameter panel write their edits
  back to the same file. Both directions are guarded by one rule — text equal to
  what was last exchanged is not a change — which is what stops a write coming
  back through the watcher as a change to apply, and what makes a queued browser
  edit yield to an external save rather than undoing it. Without `serve` nothing
  answers the endpoint, and the app behaves exactly as before.
- **`sheliak fmt` gives one structure one spelling, across a whole document.**
  The formatter already existed for a single fence body — it is what lets a GUI
  gesture and a text edit be provably the same operation — but nothing ran it
  over a file. The beat ruler, row order, group tags, bar lines and label
  alignment are derived rather than typed, so a grid can no longer disagree with
  the ruler above it. Prose, `synth` fences, comments and every alignment outside
  a phrase survive byte-for-byte, and `--check` writes nothing and exits non-zero
  if anything would change. A document with a phrase that does not parse is left
  alone entirely rather than half-formatted.

### Changed
- **One mistake is reported once.** A miscounted phrase row used to produce
  four errors: one per row, plus `undefined phrase "verse"` on the loop line —
  which was false, since the phrase is declared and simply failed to parse, and
  was the loudest of the four. The loop now knows which ids the document
  *declares*, not only which ones parsed, exactly as it already knew about
  `synth` fences that failed; a line naming a declared-but-broken phrase reports
  nothing and still invalidates the loop, so the transport keeps the last valid
  arrangement rather than dropping a track mid-edit. A phrase whose rows all
  failed no longer adds `phrase has no usable rows` at the fence on top of the
  row errors that explain it, and `sheliak check` no longer reports unbound
  tracks and unused phrases on a document that has errors — every one of those
  was the fallout of the error, not a second thing to fix.
- **The interface wears the brand palette.** The editor was a cool near-black with
  a teal accent, which shared nothing with the mark on its own tab. It is now the
  warm near-black and the gold: `#0A0C0B` behind, `#111411` panels, `#E5A900` on
  the transport, the sliders, the sequencer's onsets and the scope trace. The
  `:root` block in `web/src/style.css` is the only place a colour is written —
  the seven values that were spelled out in rules, and the three the scope canvas
  had copied into `main.ts`, now read the tokens instead. `--warn` moved from a
  pale gold to amber `#E8912F` because the status dot switches between it and the
  accent, and two shades of the same hue is not a signal. The topbar shows the
  mark. Every foreground token clears 6:1 on the new background; nothing about the
  audio, the notation or the layout changed.
- **Notes moved out of the `loop` fence.** `lead: C4 . . .` no longer parses;
  the same music is written as a `phrase` grid and the loop line names it. The
  default document was rewritten accordingly, and the step sequencer now
  projects a phrase grid — one row per pitch — where a tap places or clears a
  note, a vertical drag moves it to another row and a horizontal one changes how
  long it holds. Every gesture goes through the operation set.
- **`LoopEvent` carries `glideS` and `legato`** so a `gliss` can say how long it
  slides. Every other note passes `-1` and `0`, which is "use the patch's
  `voice.glide`" — today's audio is unchanged. The worklet does not read them
  yet: the extended `note_on` is Track B's (docs/workstreams.md §10), so a
  glissando currently sounds its destination on time without sliding into it.
- **The interface is in English.** Button labels, status lines, editor hints and
  the document the editor opens with were Japanese while the code around them
  was English. The repository convention now covers the app itself, not only its
  source, so there is one language in the project rather than a boundary
  somewhere inside it. No musical content changed: the default song's fences are
  untouched, only its prose and comments.

### Documentation
- **[docs/syntax.md](docs/syntax.md) describes the note layer that runs**: the
  `phrase` fence, row namespaces and the kit map, groups, the detail gestures
  and the address cascade, and `loop` as the arrangement.
- **MIT licence.**
- **[docs/workstreams.md](docs/workstreams.md): the note layer, redesigned.** The
  current `loop` fence carries every track's notes inline, which cannot show the
  shape of a line, cannot reuse a phrase, and has nowhere to put velocity or
  timing. The accepted replacement splits notes (`phrase`, an ASCII grid of pitch
  rows against time columns) from arrangement (`loop`, which binds a phrase to a
  track), addresses expression by coordinate with a cascade, and constrains
  editing to a finite operation set so that text edits and model edits can be
  proven to commute. Not implemented yet. The stream is split into two tracks
  with file ownership, landing order and per-step acceptance criteria written
  down, so a second agent can take one without reading the conversation the
  design came out of. Track A — the note layer — is implemented; Track B, the
  note-event ABI, is not.
- **English is the source of truth.** The README and `docs/` are English;
  `docs/ja/` holds Japanese translations and the original design notes.
- **[AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md) and this
  changelog.** The working agreement, the contribution policy and the release
  process are written down rather than remembered.
