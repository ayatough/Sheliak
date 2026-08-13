# Syntax

The notation as it exists today. A redesign of the note layer is accepted and
written down in [workstreams.md](workstreams.md); this file describes what
actually runs.

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

A song is a Markdown document. Two info strings are recognized:

````markdown
```synth id=lead seed=42
```loop id=demo bars=2 bpm=124
````

Everything else in the document — headings, paragraphs, other code blocks — is
ignored, so a song file can carry its own prose.

The body of a fence is a YAML subset: top-level `key:`, one level of nesting, flow
maps `{ ... }`, flow sequences `[ ... ]`, and `- ` lists. `#` starts a comment.

## `synth`

Each ```` ```synth ```` fence is one track. Their order in the document is the
track index, `0` to `7`.

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
up to 8. The chain runs on the master bus after the tracks are summed.

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

## `loop`

| Attribute | Default | |
|---|---|---|
| `id` | — | |
| `bars` | `1` | |
| `bpm` | `120` | |

```markdown
```loop id=groove bars=1 bpm=126
lead: [C4 Eb4 G4] ~ ~ ~ | ~ ~ ~ ~ | [Bb3 D4 F4] ~ ~ ~ | ~ ~ ~ ~
bass: .  .  C2 .        | .  .  C2 .  | .  .  Eb2 .   | .  .  Bb1 .
kick: C1 .  .  .        | C1 .  .  .  | C1 .  .  .    | C1 .  .  .
```
```

Each line is `<track id>: <cells>`, bound to the `synth` fence with that id. An
unknown id is an error.

| Token | |
|---|---|
| `C4`, `Eb2`, `F#5` | A note. `C-1` to `G9`, `#` and `b` |
| `.` | Rest |
| `~` | Tie — extends the previous cell |
| `[C3 Eb3 G3]` | A chord, in one cell |
| `\|` | Visual separator, ignored for timing |

**The subdivision is inferred per line**, as `cells / (bars * 4)`, so lines in the
same fence may have different resolutions. A note lasts until the next note or
rest; note-off lands one sample before the end of its cell.

The loop always loops. Velocity is fixed for now.

## Errors

Errors are reported as `{ line, col, message }` in document coordinates, and
**the audio does not stop**: only the broken fence freezes, keeping its last valid
patch, and everything else keeps playing. Fixing the text resumes it.

This is deliberate. A notation you edit while it is playing has to survive the
half-typed state that exists between two valid ones.
