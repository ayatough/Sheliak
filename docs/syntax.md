# Syntax

The notation as it exists today. The note layer described here — `phrase` grids,
groups and the detail cascade — is Stream 1 of
[workstreams.md](workstreams.md), and it runs; the section hierarchy above the
loop does not exist yet.

## Units

**A bare number is a parse error.** Units are how the notation stops you from
confusing milliseconds with seconds, or a gain with a ratio. The only exception is
a field that is genuinely a normalized `0.0`–`1.0` ratio and says so below.

| Kind | Spelling | Example |
|---|---|---|
| Frequency | `Hz`, `kHz` | `320Hz`, `4.5kHz` |
| Gain | `dB` | `-6dB` |
| Time, absolute | `ms`, `s` | `180ms` |
| Time, musical | `1/16`, `2bar`, `1.5beat` | `1/8` |
| Pitch | `c` (cents), `st` (semitones) | `-7c`, `+12st` |
| Ratio | `%` | `70%` |
| Reference | dotted path | `filter.cutoff` |

Musical time is resolved against the loop's BPM on the TypeScript side, and
rewritten when the BPM changes.

## Fences

A song is a Markdown document. Three info strings are recognized:

````markdown
```synth  id=lead seed=42
```plugin id=pad  from=studio.kx.distrho.Kars
```phrase id=verse-lead key=C scale=minor res=1/16 bars=1
```loop   id=demo bars=2 bpm=124
````

Everything else in the document — headings, paragraphs, other code blocks — is
ignored, so a song file can carry its own prose.

The body of a fence is a YAML subset: top-level `key:`, one level of nesting, flow
maps `{ ... }`, flow sequences `[ ... ]`, and `- ` lists. `#` starts a comment.

## `synth`

Each ```` ```synth ```` fence is one track. Their order in the document — counted
together with ```` ```plugin ```` fences — is the track index, `0` to `7`.

| Attribute | Default | |
|---|---|---|
| `id` | — | Required. `loop` lines bind to it by name |
| `seed` | `0` | Every random value in the patch derives from this |

### `osc`

A list of up to two oscillators. `osc: []` means no oscillator — a noise-only
patch, which is how hi-hats are made.

```yaml
osc:
  - { table: basic/saw, level: 0dB, morph: 0%, unison: 7, detune: 22c, spread: 80% }
  - { table: basic/square, level: -8dB, tune: -12st }
```

| Field | Default | |
|---|---|---|
| `table` | `basic/saw` | `basic/sine`, `basic/tri`, `basic/saw`, `basic/square`, `morph/pwm`, `morph/fold` |
| `level` | `0dB` | |
| `morph` | `0%` | Position within a multi-frame table |
| `unison` | `1` | 1–7 |
| `detune` | `0c` | Spread of the unison voices |
| `spread` | `0%` | Stereo width of the unison voices |
| `tune` | `0st` | Also accepts cents |
| `phase_random` | on | |

### `filter`

```yaml
filter: { type: lp12, cutoff: 800Hz, res: 0.3, drive: 0.2, key_track: 50% }
```

| Field | Default | |
|---|---|---|
| `type` | `lp12` | `lp12`, `lp24`, `hp12`, `bp12` |
| `cutoff` | `20000Hz` | |
| `res` | `0` | Normalized `0.0`–`1.0` |
| `drive` | `0` | Normalized `0.0`–`1.0` |
| `key_track` | `0%` | How much the note follows into the cutoff |

### `env`

Two envelopes, both exponential ADSR.

```yaml
env:
  amp:    { a: 5ms, d: 200ms, s: 70%, r: 120ms }
  filter: { a: 2ms, d: 400ms, s: 0%,  r: 100ms }
```

Defaults: `amp` is `{ a: 5ms, d: 200ms, s: 70%, r: 120ms }`, `filter` is
`{ a: 2ms, d: 400ms, s: 0%, r: 100ms }`.

`env.filter` is not wired to anything by itself — route it through `mod`. That is
what makes it useful for things other than a filter sweep: sent to `pitch` with a
short decay it is the attack transient of a kick drum.

### `lfo`

```yaml
lfo:
  1: { wave: tri, rate: 1/4, phase: 0% }
```

Default `{ wave: tri, rate: 1Hz, phase: 0% }`. `rate` accepts either `Hz` or
musical time; musical rates follow the BPM.

### `mod`

Up to 8 slots. The unit of `amount` depends on the destination.

```yaml
mod:
  - { from: env.filter, to: filter.cutoff, amount: +2400c }
  - { from: lfo.1,      to: osc.1.morph,   amount: 25% }
```

| `from` | Range |
|---|---|
| `env.amp`, `env.filter` | `0..1` |
| `lfo.1` | `-1..1` |
| `velocity` | `0..1` |

| `to` | Unit of `amount` |
|---|---|
| `filter.cutoff` | cents |
| `osc.1.morph`, `osc.2.morph` | normalized delta |
| `pitch` | cents |
| `amp` | normalized delta |

### `noise`

Only active when the section is present.

```yaml
noise: { level: -6dB, color: white }
```

Default `{ level: -12dB, color: white }`; `color` is `white` or `pink`. Noise is
mixed with the oscillators inside the voice, before the filter.

### `fx`

A list. **The order you write is the order they process**, each type at most once,
up to 8. **The chain belongs to the track it is written in**: it runs on that
track's own stereo output, after its voices are summed and its level applied.
Tracks are summed after that, and the master bus does nothing but a soft-clip
guard — so a reverb in one `synth` fence does not wash over the others.

```yaml
fx:
  - { type: dist,   drive: 0.4, mix: 60% }
  - { type: delay,  time: 3/16, feedback: 45%, mix: 25% }
  - { type: reverb, size: 70%, mix: 20% }
```

| Type | Defaults |
|---|---|
| `dist` | `{ drive: 0.3, mix: 100%, mode: tanh, tone: 20kHz }` — `mode` is `tanh`, `fold` or `clip` |
| `eq` | `{ low: 0dB, mid: 0dB, high: 0dB, mid_freq: 1kHz }` |
| `chorus` | `{ rate: 0.8Hz, depth: 30%, mix: 35% }` |
| `phaser` | `{ rate: 0.4Hz, depth: 70%, feedback: 30%, mix: 40%, stages: 6, center: 800Hz }` |
| `flanger` | `{ rate: 0.25Hz, depth: 60%, feedback: 50%, mix: 35% }` |
| `delay` | `{ time: 3/16, feedback: 40%, mix: 25%, pingpong: on, tone: 4kHz }` |
| `reverb` | `{ size: 60%, damp: 50%, mix: 20%, predelay: 20ms, width: 100% }` |
| `comp` | `{ thresh_low: -24dB, thresh_mid: -24dB, thresh_high: -24dB, ratio: 3, attack: 10ms, release: 120ms, makeup: 0dB }` |

`distortion` and `mbcomp` are accepted as aliases for `dist` and `comp`. `ratio`
and `stages` may be bare numbers; EQ gains and compressor thresholds require `dB`.

**A `:` in an effect type is reserved.** Built-in effects are bare names and that
set will grow; an id with a colon in it is how an effect from outside the engine
will be named, so it can never be a built-in whatever gets added later. Nothing
hosts plugins yet, and writing one is an error that says so rather than listing
the built-ins you were not looking for.

### `voice`

```yaml
voice: { polyphony: 8, glide: 0ms }
```

Default `{ polyphony: 8, glide: 0ms }`; polyphony is 1–16.

### Drums are patches

There is no drum sampler. Percussion is synthesized like anything else:

- **Kick** — a sine oscillator with `env.filter` routed to `pitch` at something
  like `+3600c` and a very short decay, so the pitch falls three octaves in
  50 ms, plus a short amp envelope.
- **Hi-hat** — `osc: []`, a noise section, a high-pass filter and a 40 ms decay.

Both are in `web/src/defaultDoc.ts`.

## `plugin`

A track whose voice comes from outside the engine: a CLAP plugin plays its
notes. It takes an index in the same sequence as `synth` fences and binds to a
`loop` line the same way.

```plugin id=pad from=studio.kx.distrho.Kars
brightness: 60%
damping:    35%
```

| Attribute | | |
|---|---|---|
| `id` | — | Required. `loop` lines bind to it |
| `from` | — | Required. The plugin's CLAP id, which `sheliak-render --list-clap <file.clap>` prints |

The body is that plugin's parameters, one per line. **Two spellings, and no
others:**

| | |
|---|---|
| `60%` | A position between that parameter's own minimum and maximum |
| `800` | The plugin's own value, in whatever unit it uses |

`500ms` is an error, and so is any other unit. Everywhere else in this notation
a unit is how the document stops you confusing milliseconds with seconds; here
Sheliak does not know what the parameter measures, and writing a unit would be a
promise it cannot keep.

**The parameter names are not checked by the parser.** Sheliak cannot know what
`studio.kx.distrho.Kars` has until the plugin is loaded, so a name is carried
through as written and resolved there. A misspelling is reported by whatever
loads the plugin, naming the plugin and listing the parameters it does have,
rather than by the editor.

The GUI panel writes back here. A plugin Sheliak can load gets a control per
parameter, generated from the plugin's own list — its names, its ranges, and its
own spelling of a value (`8000 Hz`, `Square`) — and turning one rewrites exactly
the line it belongs to, keeping the spelling that line already used.

**Where a plugin track plays depends on what kind of plugin it is.**

A plugin Sheliak ships as a `.wclap` — WebAssembly, so a browser can load it —
plays everywhere: the app, `sheliak render`, and the native renderer.
`io.github.ayatough.sheliak.synth` is one, and `sheliak check` lists any that
are not available. For example:

````markdown
```plugin id=lead from=io.github.ayatough.sheliak.synth
waveform: 3
cutoff:   40%
release:  0.4
```
````

**A `.clap` installed on your machine is a dynamic library**, which no browser
can open, so a track naming one is silent in the app and in `sheliak render`.
The other tracks play normally; `sheliak check` says which track is silent and
why. To hear it, render through the native renderer:

```bash
sheliak render song.md --emit-job job.json
sheliak-render job.json -o out.wav
```

The renderer finds the plugin by the id `from=` names, searching `CLAP_PATH`,
`~/.clap`, `/usr/lib/clap` and `/usr/local/lib/clap`. A song names a plugin
because that is a property of the song; which file carries it is a property of
the machine reading it.

To find out what a plugin accepts, ask it:

```bash
sheliak-render --list-clap /usr/lib/clap/Kars.clap --clap-id studio.kx.distrho.Kars
  sustain                  0 .. 1   default 0
  release                  0 .. 5   default 0.01
  volume                   0 .. 100   default 75
```

Names are matched loosely — lowercase, with spaces and dashes as underscores —
so a parameter the plugin calls `Cutoff Freq` is written `cutoff_freq`. A name
the plugin does not have is an error listing the ones it does. A value outside
the parameter's range is an error too, rather than being clamped: a number that
far out is almost always the wrong unit, and the document is what should be
fixed.

## `phrase`

A phrase is one track's notes over one to a few bars: an ASCII grid where rows
are pitches and columns are time, plus an optional block of expression detail.

````markdown
```phrase id=verse-lead key=C scale=minor res=1/16 bars=1
grid:
  #     1...2...3...4...
  5'   |a---....o---....|
  b3'  |a---............|
  1    |b-------....o---|

detail:
  1.1a  : { roll: +12ms }
  1.1:1 : { vel: 90% }
```
````

| Attribute | Default | |
|---|---|---|
| `id` | — | Required, unique in the document; `loop` lines refer to it |
| `key` | `C` | Tonic pitch class |
| `scale` | `major` | `major`, `minor`, the five other modes, or `chromatic` |
| `res` | `1/16` | Grid resolution: `1/16` is 4 cells a beat, `1/8` two, `1/12` three |
| `bars` | `1` | Meter is 4/4 for now |

Every row is exactly `bars × 4 × cells-per-beat` cells long. The cell run opens
and closes with `|`; interior `|` are bar lines and **must fall in the same
column on every row**. A line starting with `#` is a comment — the formatter
writes the beat ruler as one.

### Cells

| Glyph | |
|---|---|
| `.` | Rest |
| `-` | The previous note continuing |
| `a`–`z` | An onset. The letter is the group tag; `o` is the conventional default |
| `\|` | Bar line, visual only |

A note lasts its onset cell plus the following `-` run, and note-off lands one
sample before the end. A `-` with no onset before it is an error.

### Row labels

The spelling decides the namespace, and **a phrase may not mix namespaces**.

| Kind | Spelling | Examples | Resolves via |
|---|---|---|---|
| Scale degree | digit, optionally `b`/`#` first | `1`, `b3`, `#4`, `5'`, `b7,` | `key` and `scale` |
| Absolute pitch | **uppercase** note letter | `C4`, `Eb2`, `F#5` | itself |
| Percussion | any other identifier | `kick`, `sd`, `hh` | the kit map |

**Case is significant**: `b3` is a minor third, `B3` is the note B in octave 3.

`1` with no octave mark is the tonic in octave 3 (C3 = MIDI 48); `'` raises an
octave and `,` lowers one, both repeatable. A plain degree follows the scale, so
`3` is E in C major and Eb in C minor. An accidental spells an interval instead:
`b3` is a minor third and `b7` a minor seventh whatever the scale is, which is
what makes `1 b3 5` a minor triad in either. Under `scale=chromatic`, degrees
1–12 are the twelve semitones.

The kit map covers `kick`/`bd`, `rim`, `snare`/`sd`, `clap`/`cp`, `lt`, `hh`/`ch`,
`mt`, `oh`, `ht`, `crash`/`cr`, `ride`/`rd`, `perc`, `shaker`/`sh`. Drums are
patches, not samples, so the note number only matters to a patch that tracks
pitch — a kick's sine sweep does, a noise hat does not.

Rows are written highest pitch first; percussion rows keep the order they were
written in. A duplicate row label is an error.

### Groups

> **Same onset and same glyph = one group. A solo note is a group of one.**

In the example above, group `a` on beat 1 is the chord `{5', b3'}` and group `b`
is `{1}`, an independent voice starting at the same instant. A group is confined
to one onset, and **grouping never changes what you hear** — only a detail entry
that targets the group does. If every note at an onset is one group the glyph is
`o`, otherwise they are `a`, `b`, `c` … from the top row down.

### `detail`

A flow map keyed by address, applied on top of the grid.

```yaml
detail:
  1.1a     : { roll: +12ms }
  1.1:b3'  : { vel: 60% }
  *:1      : { vel: 80% }
  1.3      : { gliss: { to: +5st, cells: 3 } }
```

| Key | Value | Applies to | |
|---|---|---|---|
| `vel` | `0%`–`100%` | a note | Velocity. Default `100%` |
| `nudge` | `±Nms` | a note | Timing offset |
| `gate` | `N%` | a note | Sounding length as a fraction of the written length |
| `roll` | `±Nms` | **a group only** | Offsets members in turn; `+` from the bottom up |
| `gliss` | `{ to: <degree \| ±Nst>, cells: N, curve: linear \| exp }` | note or group | Glissando |

`cells` defaults to the distance to the next onset in the row, and is the one
field that takes a bare number: it counts grid columns, which have no unit. A
degree target slides to that note, an interval target slides by that much — and
on a group every member moves by the same interval, so the two chords need not
have the same number of notes. A note with a `gliss` sounds legato: the
amplitude envelope does not retrigger, or the slide would be two notes.

> The glide itself needs the extended `note_on` of
> [workstreams.md §10](workstreams.md), which is Track B's work. Until that
> lands the destination sounds on time but does not slide into place.

A glissando whose notes actually exist — a harp run — is written as real notes
in the grid instead.

### Addresses

```
<time>[<group>][:<row>]

time  := '*' | <bar> | <bar> '.' <beat> | <bar> '.' <beat> '.' <tick>
group := [a-z]
row   := a row label
```

| Example | Selects |
|---|---|
| `1.1` | Every note on bar 1, beat 1 |
| `1.1a` | Only group `a` there |
| `1.1:b3'` | One note |
| `1.1.3` | Bar 1, beat 1, third tick |
| `*:b3'` | Every note in row `b3'` |
| `*` | Everything |

Bars, beats and ticks are 1-based, and **an address names the row label as
written**, not the resolved pitch. More constraints win: specificity is the time
depth (`*` = 0, bar = 1, beat = 2, tick = 3) plus one for a group and one for a
row, ties going to the entry written later. Resolution is per gesture key, so an
entry that sets only `vel` leaves an inherited `nudge` alone. An address that
names no note is an error rather than something quietly ignored.

## `loop`

The arrangement: which phrase plays on which track.

````markdown
```loop id=groove bars=1 bpm=126
lead: verse-lead
bass: verse-bass
kick: four-floor
```
````

| Attribute | Default | |
|---|---|---|
| `id` | — | |
| `bars` | `1` | |
| `bpm` | `120` | |

Each line binds a track id — a `synth` fence's `id`, resolved to a track index
by fence order — to a phrase id. A phrase repeats to fill the loop, so the loop
length has to be a multiple of the phrase length; an undefined phrase, an
unknown track or a length that does not divide is an error. Two phrases may use
different resolutions on different tracks: they still span the same loop.

The loop always loops. Sequencing several phrases on one track is Stream 2.

## Errors

Errors are reported as `{ line, col, message }` in document coordinates, and
**the audio does not stop**: only the broken fence freezes, keeping its last valid
patch, and everything else keeps playing. Fixing the text resumes it.

This is deliberate. A notation you edit while it is playing has to survive the
half-typed state that exists between two valid ones.
