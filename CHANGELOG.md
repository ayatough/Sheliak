# Changelog

All notable changes to Sheliak are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
`0.MINOR.PATCH` while the project is pre-1.0: **a minor bump may change the
notation**. See [docs/development.md](docs/development.md#versioning) for the
policy.

`## [Unreleased]` collects what is on `main` and not yet tagged.
[`scripts/release.sh`](scripts/release.sh) closes it — see
[docs/releasing.md](docs/releasing.md).

## [Unreleased]

### Added
- **A physically modelled piano, as a native CLAP instrument** (`piano/`,
  built by `scripts/build-piano-clap.sh` into `piano/dist/`). Modal strings —
  up to three per key, detuned, with a stiff-string inharmonicity curve and a
  Railsback stretch — struck by a simulated nonlinear felt hammer, so
  velocity changes timbre and not just level. Dampers fall at note-off (the
  top octaves have none, as on the real instrument), the sustain pedal
  arrives as MIDI CC 64 or as an automatable parameter, and parameter state
  survives a DAW project reload. Deterministic by construction: the same
  events at the same sample rate render bit-identical audio, so
  `sheliak-render` can treat it as a `pinned` plugin rather than an
  audition. No samples anywhere; where to listen:
  `cargo run --release --example render_wav --manifest-path piano/Cargo.toml`.
- **The piano strikes with a knock.** A deterministic strike-noise burst —
  key knock, shank thunk, soundboard thump — fires at the moment of felt
  contact, shaped per register (a dark few-millisecond thump in the bass, a
  shorter brighter knock in the treble) and routed through the same
  radiation and soundboard shaping as the strings. Its level rises faster
  with velocity than the string tone, so it dominates a fortissimo attack
  and all but vanishes at pianissimo. A new automatable `Knock` parameter
  scales it (0–2, default 1). The "noise" is a fixed per-key sequence seeded
  from the key-number hash, so renders stay bit-identical.
- **The piano's bass bites like a struck string, not a plucked one.** The
  wound keys (up to G2) now carry a longitudinal-mode bank — the mode
  series a hammer excites by stretching the string along its length,
  around a kilohertz for the longest bass strings. It is driven by the
  square of the contact force, so the metallic bite appears at forte and
  vanishes at piano, which is the perceptual signature that separates a
  piano bass from a bass guitar.
- **The piano is now fitted to real recordings.** The decay, radiation and
  hammer parameters are measured against the Salamander Grand Piano
  reference set (CC-BY Yamaha C5) instead of hand-guessed: every key gains
  the real instrument's two-stage decay (a fast attack bloom over a quiet
  aftersound bank — the missing first stage was why notes read as
  sustained, plucked strings), the soundboard's midrange decline and treble
  shelf replace the flat band, and a hashed per-mode mobility ripple
  replaces the bridge-readout combs that had hollowed out the low partials.
  `examples/analyze.rs` (per-partial measurement) and
  `examples/note_wav.rs` (single-key render) make the fitting loop
  repeatable against any reference piano.
- **The piano's soundboard now rings.** A 48-mode resonator bank rung by
  the string signal adds the diffuse halo between the partials that a real
  note carries and widens the stereo image; per-register mobility ripple
  and a constant-hertz polarisation split (measured, like everything else,
  against the reference recordings) give each note the uneven shimmer and
  slow beats of a real unison.
- **The GUI panel draws a plugin's controls, from the plugin.** Selecting a
  plugin track shows one control per CLAP parameter: the plugin's own names, its
  ranges, and its own spelling of every value — `8000 Hz`, `0.400 s`, `Square` —
  because `value_to_text` is the only label Sheliak has for a control it knows
  nothing about. Turning one rewrites exactly the line it belongs to and nothing
  else, **keeping the spelling that line already used**: `cutoff: 40%` stays a
  percentage, `cutoff: 8000` stays a number.

  A moved knob reaches the running plugin as a CLAP event rather than rebuilding
  it, so scrubbing a control during playback does not cut the note it is holding.

  A plugin track is now visible as one: its tab carries a mark, the panel's
  heading is the plugin's own name with its id under it, and the meta line reads
  `1 plugin playing` — counted from what the audio thread actually loaded, not
  from what the document asked for, so a plugin that failed to load says
  `0/1 plugins playing` rather than nothing at all.

  One thing is guessed rather than known: whether a slider is linear or
  logarithmic. CLAP carries no unit and no hint, so a range spanning a factor of
  a hundred or more gets a log slider. It is a guess about feel — the value
  written is identical either way.
- **A `plugin` track plays — in the browser and in `sheliak render`.** The fence
  was already notation; now it makes sound, for any plugin Sheliak ships as a
  `.wclap`:

  ````markdown
  ```plugin id=lead from=io.github.ayatough.sheliak.synth
  waveform: 3
  cutoff:   40%
  release:  0.4
  ```
  ````

  The parameters are resolved by name against the plugin's own list, sent as
  CLAP events, and a name it does not have — or a value outside the range it
  declares — is reported by the plugin's name rather than by the line, because
  the line was written before anyone could know. The notes come from the same
  `loop` line as any other track. A plugin the machine does not have is still
  reported and still silent, and the rest of the document plays.

  The audio thread runs it: `wclap-host.js` (built by
  `npm run build:worklet-host`) puts the CLAP host in the worklet's scope, and
  `scripts/check-worklet-plugin.sh` renders a plugin track in a real browser to
  prove it. A plugin track's output is added to the engine's mix and the total
  goes back through the master guard, which is now exported as `master_guard` —
  audio the engine did not make is outside the bound the engine promised.
- **Sheliak compiles a CLAP plugin, and hosts one in the browser.** Two halves
  of the same experiment, and they meet in the middle:

  `wclap/` is Sheliak's own distortion behind the CLAP C ABI, built for wasm32
  by `./scripts/build-wclap.sh` into `web/public/sheliak.wclap/module.wasm`. It
  imports nothing, exports its memory, a growable function table, `clap_entry`
  and `malloc` — which is precisely what the WCLAP draft asks a module for, and
  it takes two linker flags rather than a C toolchain to produce.

  `web/src/audio/wclap.ts` is a CLAP host written from scratch in the language a
  browser has: it lays the ABI's structs out at byte offsets inside the plugin's
  own memory, installs JavaScript callbacks into the plugin's function table
  through a generated bridge module, and renders blocks with parameter changes
  landing on exact frames.

  The reason for doing Sheliak's own effect first is that it can be checked:
  **one block through the plugin is bit-identical to the same block through the
  same effect in the engine's chain.** Running an effect as a plugin is not a
  different effect.

  The module carries two plugins: the distortion, and **Sheliak Synth** — one
  track of the wavetable engine with a dozen of its parameters exposed and a
  CLAP note port on the front. It is the reference the note path is checked
  against, the same way the distortion is the reference for the audio path, and
  it holds to the same standard: a note played through the plugin comes out
  sample for sample identical to the same note played through the engine's own
  track. The host reads a plugin's declared ports rather than assuming a stereo
  input — an instrument has none, and handing it one is what crashed a
  third-party instrument in the native renderer.

  A module that needs WASI is refused by name, which is most third-party
  plugins for now. See docs/workstreams.md §8.
- **A track can be played by a CLAP plugin, named in the document.** A new
  ```` ```plugin ```` fence is a track like a ```` ```synth ```` fence is,
  taking an index in the same sequence and binding to a `loop` line the same
  way:

  ````markdown
  ```plugin id=pad from=studio.kx.distrho.Nekobi
  cutoff: 60
  decay:  90
  ```
  ````

  `from=` names the plugin, not a file: the renderer finds it by id on the CLAP
  search path (`CLAP_PATH`, `~/.clap`, `/usr/lib/clap`, `/usr/local/lib/clap`),
  because which file carries a plugin is a property of the machine and not of
  the song. The body is that plugin's parameters, written either as a
  percentage of the parameter's own range (`60%`) or as the plugin's own number
  (`60`); a name it does not have, or a value outside its range, is an error
  naming the plugin. `sheliak-render --list-clap <file> --clap-id <id>` prints
  the names, ranges and defaults.

  **A `.clap` installed on this machine plays through `sheliak-render` only** —
  it is a dynamic library, and neither the browser nor `sheliak render` can load
  one. A plugin Sheliak ships as a `.wclap` plays everywhere (see the entry
  above). The other tracks play normally either way, and `sheliak check` says
  which track is silent here and how to hear it.
- **A native renderer, and CLAP effects on the mix.** `sheliak render song.md
  --emit-job job.json` compiles a document to a render job — the flat parameter
  block per track and the loop's events, no Markdown — and `sheliak-render
  job.json -o out.wav` synthesizes it without a browser or a wasm runtime. That
  is what makes plugin hosting possible at all: a `.clap` is a dynamic library
  and cannot be loaded in a tab. `--clap <plugin.clap>` runs the finished mix
  through an effect.
- **A CLAP instrument can be a track's voice.** `sheliak-render job.json -o
  out.wav --clap-instrument <plugin.clap> --clap-track <n>` sends that track's
  notes to the plugin — sample-accurately, in the note dialect the plugin
  declares — and mixes its output with the other tracks in place of the
  engine's voice; the track's stem becomes the plugin's output. The host now
  builds each plugin's audio port layout from what it declares instead of
  assuming stereo in and out, which is what made instruments (zero audio
  inputs) hostable at all. Verified against DPF's Kars and Nekobi; Nekobi
  renders bit-identically twice, and Kars measurably cannot — its excitation
  noise is unseeded upstream — which the tests record by name.

### Notes

- **A render through a plugin is reproducible against that build of that
  plugin, and nothing weaker.** CLAP guarantees nothing about determinism — a
  plugin may read a clock or use an unseeded RNG, and no host can stop it — so
  Sheliak's own guarantee stops at its own engine. The plugin tests measure it
  per plugin rather than assuming it.
- **The native and wasm builds of the engine agree to one LSB, not to the
  byte.** `scripts/check-render-parity.sh` renders a document both ways and
  reports the difference: on a document using every effect, 6% of samples
  differ and every difference is a single least-significant bit at 16 bits
  (about -90 dBFS); a track with no effects is byte-for-byte identical. The
  divergence is in the effect chain, where `tanh`, `exp` and `sin` are, and the
  two targets reach different implementations of them. Determinism itself is
  untouched — the same document, seed and *build* still produce the same bytes
  — but a golden audio hash pins an engine build rather than a version.

## [0.1.0] - 2026-08-14

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
- **A noise source and an effect chain per track.** Noise is generated per voice
  from a seeded RNG and mixed before the filter, in white or pink. Eight effect
  types — distortion, EQ, chorus, phaser, flanger, delay, reverb and a
  three-band compressor — run on the track that writes them, in the order the
  `fx:` list is written, after that track's voices are summed. The master bus
  sums the tracks and does nothing else but guard against clipping.
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
- **An installer: `curl … | sh`, no clone and no Rust toolchain.** A release
  publishes one tarball for every platform — the CLI bundle, the built app and
  `dsp.wasm` — because nothing in it is platform-specific, so there is no target
  matrix each only as tested as the machine that built it. `scripts/install.sh`
  verifies the published checksum, extracts to `~/.local/share/sheliak` and puts
  a wrapper in `~/.local/bin`; it refuses before downloading anything when Node
  is missing or older than 20. `release.yml` builds the archive with the same
  script a contributor runs, extracts it somewhere unrelated to the repository
  and runs the CLI out of it before publishing anything, and `workflow_dispatch`
  does all of that without publishing, so the packaging can be checked before a
  tag makes it permanent.
- **`sheliak serve` runs without a repository.** It serves the *built* app over
  a plain Node HTTP server instead of starting Vite, and pushes file changes
  over server-sent events instead of Vite's HMR socket. That is what lets a
  release carry everything `serve` needs, and it leaves the CLI with no runtime
  dependency at all. Working on the app itself is what `npm run dev` is for.
- **Stems: `sheliak render --stems`.** One WAV per track beside the mix, named
  after it (`song.wav` → `song.lead.wav`). `MultiEngine` now keeps each track's
  output for the block it just rendered instead of summing it away through a
  shared scratch buffer, and two new exports — `out_track_l_ptr(track)` and
  `out_track_r_ptr(track)` — hand it back. A stem is tapped after that track's
  own effect chain and before the tracks are summed, so **the stems add back up
  to the mix exactly**: the master bus does nothing but sum, and its soft-clip
  guard is the identity below `CLIP_KNEE`. `dsp/tests/verify.rs` asserts that
  bit for bit, that a track with no note yields silence rather than a copy of
  the mix, and that a track falling dormant clears its buffer instead of
  repeating the block it stopped on; `web/src/integration.test.ts` checks the
  sum through the real `dsp.wasm` over the four-track default document. The
  parameter block layout is unchanged and the mix is bit-identical to before.
- **Two published sites: the release, and the tip of `main`.** GitHub Pages
  serves one directory tree per repository, so `pages.yml` builds two into it:
  `/` from the newest tag's own checkout, and `/next/` from `main`, marked as a
  working copy in the page's own header and carrying a `noindex`. Publishing
  used to be the same action as pushing, which put every unreleased afternoon on
  the front page. It is triggered by CI and Release *finishing* rather than by
  the push — run on the same event they race, and a red commit can reach the
  site first — and `scripts/build-site.sh` builds either channel, here or in CI.
  Cutting a release is therefore two pushes in order: the version bump, CI
  green, then the tag.

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
