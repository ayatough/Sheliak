# Roadmap

Sheliak is at `v0.1.0`. Nothing has been released yet; `main` is what exists.

The goal is not a text-based DAW. It is a form in which a song can be **reviewed**:
read, played, diffed, merged, and reproduced exactly by anyone who clones the
repository. Everything below is ordered by how much it serves that.

## Done

The sound engine, and enough notation to use it.

- `synth` and `loop` fences, parsed in the browser with unit-typed values and
  fully expanded defaults
- Hot reload at 150 ms without stopping the transport; a broken fence keeps its
  last valid patch instead of silencing the song
- Wavetable engine: six tables, FFT mipmaps per octave, Hermite interpolation,
  fixed-point phase
- Two oscillators with unison, a four-mode TPT filter, two exponential ADSRs, an
  LFO, an 8-slot modulation matrix
- Seeded white and pink noise, mixed in before the filter
- An eight-type master effect chain applied in written order
- Eight tracks, one per `synth` fence
- A step sequencer and parameter panel that edit the document text itself, one
  token at a time
- Offline verification: determinism, aliasing, DC, clicks
- GitHub Pages deployment on every push to `main`, after CI

## Now — the note layer

The current `loop` fence carries every track's notes inline. That was enough to
prove the engine works, and it is a dead end for writing music: the shape of a
line is invisible in a list of note names, a phrase cannot be reused, and there is
nowhere to put velocity or timing.

The replacement is accepted and specified in
[workstreams.md](workstreams.md): notes move into a `phrase` fence — an ASCII grid
of pitch rows against time columns — and `loop` becomes the arrangement layer that
binds a phrase to a track. Expression is addressed by coordinate with a cascade,
and editing is constrained to a finite operation set so that text edits and model
edits can be *proven* to commute.

Two things about it are worth naming, because the rest of the roadmap leans on
them:

- **Rows are scale degrees.** Transposition and a change of mode become one
  attribute, not a rewrite of every note.
- **Editing is a finite operation set**, which is simultaneously the GUI's
  vocabulary, the notation's grammar, and the API an agent writes through.

## Next — structure

The document tree becomes the musical hierarchy. This is what makes Markdown
load-bearing rather than a container.

- **Frontmatter as the song header** — title, BPM, key, scale, meter, tempo map,
  engine version. `key` and `scale` inherit frontmatter → section → fence. This
  has to land before the notation spreads any further; it is cheap now and a
  breaking change later.
- **Headings as arrangement.** A `##` heading is a section, document order is
  playback order, and `from=` inherits a previous section so a variation is
  written as a difference rather than a copy. Composition is mostly repetition
  with small changes, and a DAW can only link or detach — never "the same, with
  the hats doubled".
- **Hierarchical automation.** Abstract curves — energy, density, brightness —
  defined at song, section and phrase scale and composed. Making the second half
  of a song more intense becomes one edit at the top level, with every local
  shape left intact.

## Later — reviewable songs

- **Rendered previews on a pull request.** A generated SVG score and an audio
  render posted as links, so a diff can be listened to rather than read. This is
  the point at which "review a song" stops being a metaphor.
- **Golden audio hashes.** Determinism already holds; pinning the engine version
  in frontmatter and checksumming the render makes a song a reproducible build.
- **Wavetables defined as text** — harmonic tables or expressions — so that a
  song can be entirely free of binary files.
- **Samples as pinned dependencies**, referenced by URL and hash in a lockfile
  rather than committed.
- **MIDI import and export.** Import quantizes and summarizes rather than
  reproducing faithfully; that is a consequence of the editing model, not a
  limitation to apologize for.
- **A two-channel site** — the last tag at the root, the tip of `main` at
  `/next/` — so that landing a change and releasing it stay separate.

## Not planned

- A general pitch-automation system with arbitrary per-note curves. Glissando and
  portamento are covered by note-level glide; anything beyond that buys
  complexity the notation cannot show.
- Recording audio, or a sampler for user audio. Sheliak synthesizes.
- Natural-language generation as a feature of the format. The document being
  legible to a model is a property of the notation, not a mode to add.

## Non-goals that shape the design

- **The DSP core will never know the DSL.** It is what keeps the notation free to
  change and the core reusable natively.
- **No binary project file, ever.** If a thing cannot be written as text, it is a
  referenced dependency, not part of the song.
