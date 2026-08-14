# Workstreams

The plan of record: work that has been accepted and thought through, with the
reasoning behind it. Issues are the inbox; this file is what survived a decision.
The longer arc is in [roadmap.md](roadmap.md).

---

# Stream 1 — The note layer

**Status:** both tracks have landed. Track A is the notation — `phrase`
grids, groups and the detail cascade, described in [syntax.md](syntax.md).
Track B is the note-event ABI a written `gliss` needs in order to actually
slide. What is left of this stream is whatever the two turn up in use.

## Why

The current `loop` fence carries every track's notes inline:

```
lead: [C4 Eb4 G4] ~ ~ ~ | ~ ~ ~ ~ | ...
bass: .  .  C2 .        | ...
```

That was the right shape for finding out whether the engine could make a sound,
and it is a dead end for writing music. Three things it cannot do:

1. **Show the shape of a line.** A list of note names has no contour. You cannot
   see a melody in it, which is most of what reading music is for.
2. **Reuse a phrase.** The same figure in two sections is two copies, and editing
   one leaves the other behind. Composition is mostly repetition with small
   changes; a notation that cannot express "the same, but" forces copy-paste and
   then rots.
3. **Carry expression.** Velocity, timing, note length and articulation have
   nowhere to live.

The replacement splits the layer in two.

| Fence | Role |
|---|---|
| `phrase` | The notes. An ASCII grid: rows are pitches, columns are time, plus a block of expression detail |
| `loop` | The arrangement. Which phrase plays on which track |

## Design principles

- **ASCII only.** No box-drawing characters, block glyphs or braille. GitHub's
  file view and a language model both have to read and write this without the
  alignment coming apart; decorative rendering is the renderer's job.
- **Constrain the operations, not the data.** Rather than inventing a notation
  that can express any state a piano roll could reach, define a finite set of
  editing operations and let the notation express exactly what they can produce
  (§7). This is what makes round-trip correctness a testable property (§8) rather
  than a claim.
- **Do not write down anything that can be derived.** Redundant information in a
  source file gets a chance to lie.
- **One notation.** There is no short form for monophonic lines: a percussion
  track's grid is a single row, so unifying costs nothing in length.

## Splitting the work

**Two agents can work on this stream at once, and no more than two.** Everything
on the notation side hangs off the parser and the canonical form, so a second
agent there is blocked until they land and then merges against a moving target.
The DSP side shares no file with them at all.

If you were handed a track letter, the table below is your brief and the rest of
this document is your specification. Both tracks push to `main` and run the full
gate first — see [AGENTS.md](../AGENTS.md#definition-of-done).

### Track A — the note layer — done

**Owns** `web/src/dsl/`, `web/src/gui/`, `web/src/main.ts`, `web/src/style.css`,
`web/index.html`, `web/src/defaultDoc.ts`, `docs/syntax.md`.
**Does not touch** `dsp/`, `web/public/worklet.js`, `docs/architecture.md`.

> This list was originally `web/src/gui/` alone, which was wrong: the editor
> spans `main.ts`, `style.css` and `index.html` too, and Track A had to change
> all three. No harm came of it — Track B touched none of them — but an
> ownership boundary drawn one directory too narrow is a boundary that will be
> crossed silently. It is corrected here rather than in hindsight next time.

Land in this order. A step is finished when its criterion holds, not when the
code exists.

| # | Step | Finished when |
|---|---|---|
| A1 | `web/src/dsl/phrase.ts` — grid and detail parser | The fence in §2 parses into rows, onsets, lengths and groups; every grid and address error in §9 is reported with a line and column; a canonical document re-renders to itself byte for byte |
| A2 | `format.ts` — grid canonicalization | `format(format(x)) == format(x)` over generated input (§8 invariant 2); row order, group tags (§3), the ruler comment and label alignment all follow §3; one structure has exactly one spelling |
| A3 | `edit.ts` — fixed-width cell spans | Replacing one cell changes exactly one character and leaves every other byte identical; a detail entry can be inserted, replaced and removed surgically |
| A4 | `ops.ts` — the operation set (§7) | All fifteen operations implemented and total; the commutativity property test passes over generated documents and operation sequences (§8 invariant 1); `note.movePitch` and `note.moveTime` rewrite the detail addresses that name the note they moved (§7 rule 4) |
| A5 | `loop.ts` — phrase references | A `loop` fence resolves phrase ids to Loop IR; the `loop` errors in §9 are reported; the track index still comes from `synth` fence order, and multi-track playback is unchanged |
| A6 | `gui/sequencer.ts`, `gui/view.ts` — grid projection | The sequencer renders a phrase grid, every gesture goes through `ops.ts`, and no GUI state exists that the document does not |
| A7 | `defaultDoc.ts`, `docs/syntax.md` | The default document uses `phrase` fences and still renders — the wasm end-to-end test is the check — and `syntax.md` describes what runs rather than what is planned |

**A1 and A2 are the foundation.** Nothing above them is worth writing until
`format(format(x)) == format(x)` passes: every later step assumes it can produce
canonical text, and an operation that emits a second valid spelling of the same
structure makes invariant 1 untestable.

### Track B — note events — **landed**

**Owns** `dsp/src/lib.rs`, `dsp/src/voice.rs`, `dsp/src/engine.rs`,
`web/public/worklet.js`, and the ABI section of `docs/architecture.md`.
**Does not touch** `web/src/`.

Track B owns the worklet as well as the Rust, because the worklet is `note_on`'s
only caller: splitting the two across agents lands a broken `main`.

Finished when:

- `note_on(track, note, velocity, glide_s, legato)` is exported, with
  `glide_s < 0` meaning "use the patch's `voice.glide`" and `legato != 0`
  suppressing the amplitude-envelope retrigger (§10)
- the worklet passes `-1` and `0`, so **today's audio is bit-identical**: the
  determinism check in `dsp/tests/verify.rs` and the wasm end-to-end test in
  `web/src/integration.test.ts` produce the same samples as before the change.
  This is the criterion that matters — the change is only safe if it is inaudible
  until something asks for it
- a new offline check: a legato `note_on` during a sounding note changes pitch
  without restarting the envelope and without a click, in the shape of the
  existing click test
- the ABI block in `docs/architecture.md` matches the exports

**Track B can land before Track A starts**, and should. Nothing in it waits on
the notation, and having it in place means `gliss` is implementable the moment
A4 exists.

It has landed. Two notes for whoever wires `gliss` up on the TS side:

- **Legato is monophonic per track.** It bends the newest sounding, unreleased
  voice; the ABI has no room to say *which* note is sliding. A chord-wide
  `gliss` (§4) therefore needs either one legato event per member with the
  members separated in time, or an ABI that names the source note — pick that
  fight when A4 is written, not before.
- **A legato note-on keeps the sounding voice's velocity**, because velocity
  scales the per-sample gain and feeds the mod matrix, so moving it mid-note
  would step both. The slide inherits the expression of the note it left.

### Crossings

| File | Owner | |
|---|---|---|
| `web/src/dsl/compile.ts` | Track A | |
| `docs/architecture.md` | Track B, ABI section only | Track A leaves it alone |
| `docs/syntax.md` | Track A | |
| `README.md` | Track A | The status list and the example fences follow the notation. Unowned the first time round, which is how it nearly went stale |
| `web/src/integration.test.ts` | Track B | It mirrors `worklet.js`, so it belongs with whoever changes an export — not with whoever owns the directory it sits in |
| `CHANGELOG.md` | both | Append-only, but still a conflict if edited at the same moment |
| this file | whoever finishes a track | Move its status line |

**A mirror belongs to the thing it mirrors, not to its directory.**
`web/src/integration.test.ts` drives the wasm "the same way `worklet.js` does",
and it sat inside `web/src/`, which Track B was told to leave alone — so the
worklet moved to five arguments and its mirror kept calling three. Nothing broke,
because the missing arguments arrive as `0` and every patch here has `glide: 0ms`;
a patch with a real glide would have made the test and the app disagree in
silence. When splitting the next stream, look for the files that exist to agree
with something else and give them to that something.

## 1. Terms

| Term | Meaning |
|---|---|
| Phrase | One `phrase` fence: one track's notes over one to a few bars |
| Row | One line of the grid — one pitch, or one percussion voice |
| Cell | One character. The unit of time |
| Onset | The cell where a note starts |
| Group | The notes sharing an onset *and* a glyph. The unit of a chord |
| Address | A coordinate naming a note or group from the detail block (§5) |
| Gesture | An expression entry: `vel`, `nudge`, `gate`, `roll`, `gliss` |

## 2. The `phrase` fence

````markdown
```phrase id=verse-lead key=C scale=minor res=1/16 bars=1
grid:
  #     1...2...3...4...
  5'   |a---....o---....|
  b3'  |a---............|
  1    |b-------....o---|

detail:
  1.1a   : { roll: +12ms }
  1.1:1  : { vel: 90% }
```
````

### Attributes

| Attribute | Required | Default | |
|---|---|---|---|
| `id` | yes | — | Unique in the document; `loop` refers to it |
| `key` | | `C` | Tonic pitch class |
| `scale` | | `major` | `major`, `minor`, the five other modes, or `chromatic` |
| `res` | | `1/16` | Grid resolution; sets cells per beat |
| `bars` | | `1` | |

`res=1/16` gives 4 cells a beat, `1/8` gives 2, `1/12` gives 3 (triplet eighths),
`1/32` gives 8. Total cells are `bars × 4 × cellsPerBeat`, and every row must be
that long. Meter is 4/4 for now; variable meter arrives with frontmatter.

### The grid

```
  <row label>  |<cells>|
```

- The cell run opens and closes with `|`; interior `|` are bar lines, visual only
- **Bar lines must fall in the same column on every row**, or it is an error
- A line starting with `#` is a comment. The formatter emits the beat ruler as one

#### Row labels

The spelling decides the namespace. **A phrase may not mix namespaces.**

| Kind | Spelling | Examples | Resolves via |
|---|---|---|---|
| Scale degree | digit, or lowercase `b`/`#` then a digit | `1`, `b3`, `#4`, `5'`, `b7,` | `key` and `scale` |
| Absolute pitch | **uppercase** note letter, accidental, octave | `C4`, `Eb2`, `F#5` | itself |
| Percussion | any other identifier | `kick`, `sd`, `hh` | the kit mapping |

**Case is significant**: `b3` is a minor third, `B3` is the note B in octave 3.
That rule is the whole of the disambiguation, and it is easy to get wrong when
implementing.

Octave marks apply to degrees only: `'` up, `,` down, repeatable. Under
`scale=chromatic`, degrees 1–12 are the twelve semitones.

Canonical row order is **highest resolved pitch first**. Percussion rows have no
natural order, so they keep the order they were written in. A duplicate row label
is an error.

#### Cells

| Glyph | |
|---|---|
| `.` | Rest |
| `-` | The previous note continuing |
| `a`–`z` | An onset. The letter is the group tag; `o` is the conventional default |
| `\|` | Bar line, visual only |

A note lasts its onset cell plus the following `-` run; note-off lands one sample
before the end, as it does today. A `-` with no onset before it is an error.

### 3. Groups

> **Same onset and same glyph = one group. A solo note is a group of one.**

```
  5'   |a---....o---....|
  b3'  |a---............|
  1    |b-------....o---|
```

On beat 1, group `a` is `{5', b3'}` — a chord — and group `b` is `{1}`, an
independent voice starting at the same instant. On beat 3 there is one note, so
`o`.

A single rule covers both cases, which is why there is no separate "solo" concept.
It also means group membership is the one structural fact that cannot be derived
from anything else, and therefore the one thing worth spending a glyph on. (An
earlier draft marked "this note has a detail entry" in the grid too; that is
derivable from the detail block, so it was dropped.)

- **A group is confined to one onset.** Groups that span time are a different
  mechanism — phrase reuse and section inheritance — and conflating them breaks
  both.
- **A group does not affect rendering.** The audio changes only when a detail
  entry targets the group (§8, invariant 3). This is what makes MIDI interop
  degrade cleanly: MIDI has no grouping, so an import is all groups of one, and
  dropping the tags on export changes nothing anyone can hear.

**Canonical form.** If every note at an onset is one group, the glyph is `o`.
Otherwise assign `a`, `b`, `c` … from the top row down. Tags mean nothing across
columns, so no consistency is required between them. The same structure therefore
always produces the same text.

## 4. The `detail` block

A flow map keyed by address. Optional.

```
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
| `gliss` | below | note or group | Glissando |

```
gliss: { to: <degree | ±Nst>, cells: <integer>, curve: linear | exp }
```

A degree target slides to that note; an interval target slides by that much, which
is also how a fall or a scoop — a bend with no destination — is written. Applied
to a group, **every member moves by the same interval**, so the two chords need
not have the same number of notes. `cells` defaults to the distance to the next
onset. A note with a `gliss` sounds legato: the amplitude envelope does not
retrigger, or the slide would be two notes rather than one.

Units follow [syntax.md](syntax.md): a bare number is an error, except `cells`.

A glissando whose notes actually exist — a harp run — is written as real notes in
the grid instead, generated by the `note.insertRun` operation along the scale.

## 5. Addresses and the cascade

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
| `1.1.3` | Bar 1, beat 1, third tick (1-based) |
| `*:b3'` | Every note in row `b3'` |
| `1` | Every note in bar 1 |
| `*` | Everything |

Bars, beats and ticks are 1-based. **An address names the row label as written**,
not the resolved pitch, so inheriting a phrase with a different `key` does not
break it.

Specificity is the number of constraints:

```
specificity = (time depth: * = 0, bar = 1, beat = 2, tick = 3)
            + (group given: +1)
            + (row given: +1)
```

Higher wins; ties go to the entry written later. Resolution is per gesture key, so
an entry that sets only `vel` leaves an inherited `nudge` alone.

Because there is a cascade, the **expanded view** applies to phrases as it already
does to patches: for every note, the final `vel`, `nudge`, `gate` and `gliss`, and
**which entry won**. Without it the values cannot be traced.

## 6. `loop` as the arrangement layer

````markdown
```loop id=groove bars=1 bpm=126
lead: verse-lead
bass: verse-bass
kick: four-floor
```
````

Each line binds a track id — a `synth` fence's `id`, resolved to a track index by
fence order, as today — to a phrase id. A phrase repeats to fill the loop; a loop
length that is not a multiple of the phrase length is an error, as is an undefined
phrase or an unknown track.

Sequencing several phrases on one track, and the section hierarchy above it, are
Stream 2.

## 7. The operation set

Everything reachable from the GUI or an agent is in this table. A state not
produced by one of these does not appear in the text.

| Operation | Arguments | Text touched |
|---|---|---|
| `note.add` | row, onset, length | one row, `length` characters |
| `note.remove` | address | one row, `length` characters → `.` |
| `note.movePitch` | address, new row | two rows |
| `note.moveTime` | address, new onset | one row |
| `note.resize` | address, new length | one row |
| `note.insertRun` | from row, to row, onset, cells | several rows, generated along the scale |
| `group.merge` | addresses at one onset | tag characters in one column |
| `group.detach` | address | one character |
| `row.add` | row label | one line inserted |
| `row.remove` | row label | one line removed (empty rows only) |
| `detail.set` | address, key, value | one detail entry |
| `detail.clear` | address, key | one detail entry |
| `phrase.transpose` | ±N degrees or semitones | the row labels |
| `phrase.setKey` | key, scale | one attribute token |
| `loop.bind` | track, phrase id | one line |

Rules:

1. **Every operation emits canonical form.** Its result equals applying the
   formatter.
2. **Every operation is total.** An input it cannot apply fails explicitly rather
   than applying halfway.
3. **An operation touches nothing outside its target span.** Comments, prose and
   other rows survive byte-for-byte, as `web/src/dsl/edit.ts` already guarantees.
4. `note.movePitch` and `note.moveTime` rewrite the addresses of any detail entry
   naming that note, in the same edit.
5. Unreachable by construction: an unquantized onset, a note with no row, two
   notes of the same row at one onset.

**The same set is the agent API.** A model editing a song calls these rather than
rewriting text, so the invariants below hold on the write path too.

## 8. Invariants

| # | Invariant | How it is checked |
|---|---|---|
| 1 | **Commutativity**: `parse(applyText(doc, op)) ≡ applyModel(parse(doc), op)` | Property test over generated documents and operation sequences |
| 2 | **Canonical form is idempotent**: `format(format(x)) == format(x)` | Same |
| 3 | **Groups are inert**: collapsing every tag to `o` leaves the Loop IR unchanged, unless a detail entry targets a group | Compare Loop IR |
| 4 | **Locality**: no operation changes a byte outside its target span | Inspect the diff range |
| 5 | **Determinism**: same document and seed, bit-identical output | `dsp/tests/verify.rs`, already in place |

Invariant 1 is the project's central claim — that the GUI and the text are the
same thing — stated as something a test can fail. It is only expressible because
the operation set is finite. It belongs beside `web/src/dsl/edit.test.ts`.

## 9. Errors

A parse error keeps the last valid state playing, as everywhere else, and reports
`{ line, col, message }` in document coordinates.

| Area | Condition |
|---|---|
| Grid | Row length is not `bars × 4 × cellsPerBeat` |
| | Bar lines are not in the same column on every row |
| | A `-` with no onset before it |
| | Duplicate row label |
| | Mixed namespaces — a degree row and a percussion row together |
| | Unknown row label |
| Address | Names a note or group that does not exist — **an orphan, never silently ignored** |
| | Malformed |
| Gesture | `roll` applied to something that is not a group |
| | A bare number where a unit is required |
| `loop` | Undefined phrase id, or unknown track id |
| | Loop length is not a multiple of the phrase length |
| Fence | Duplicate or missing `id` |

## 10. What the DSP core needs

`gliss` requires a glide time and a legato flag per note event. The current export

```
note_on(track: u32, note: f32, velocity: f32)
```

becomes

```
note_on(track: u32, note: f32, velocity: f32, glide_s: f32, legato: u32)
```

with `glide_s < 0` meaning "use the patch's `voice.glide`", preserving today's
behaviour, and `legato != 0` suppressing the amplitude-envelope retrigger. **The
parameter block layout does not change.**

`nudge`, `roll` and `gate` fold into Loop IR offsets on the TypeScript side and
need nothing from Rust. `curve: exp` maps onto glide time; a general per-note
pitch automation source is explicitly not being added.

## 11. Migration

The note layer is replaced; the sound engine is untouched.

| File | Effect |
|---|---|
| `web/src/dsl/loop.ts` | Cell tokenizing removed, replaced by phrase reference resolution |
| `web/src/dsl/phrase.ts` | **New.** Grid and detail parser |
| `web/src/dsl/ops.ts` | **New.** The operation set (§7) |
| `web/src/gui/sequencer.ts` | Projection of one loop line → projection of a grid |
| `web/src/dsl/edit.ts` | Fixed-width cell spans added; simpler than the existing YAML span resolution |
| `web/src/dsl/format.ts` | Grid canonicalization: row order, tags, ruler, alignment |
| `web/src/defaultDoc.ts` | Rewritten |
| `dsp/src/{lib,voice,engine}.rs` | `note_on` arguments and legato (§10) |
| `fences.ts`, `yamlite.ts`, `synth.ts`, `fx.ts`, `units.ts`, `params.*` | **Unchanged** |

A sensible order to build it in: the parser and the formatter first, with
`format(format(x)) == format(x)` passing before anything else is written on top.

---

# Stream 2 — Song structure

Not specified yet; see the [roadmap](roadmap.md#next--structure) for the shape.
Frontmatter as the song header comes first, because `key` and `scale` inheritance
depends on it and every day it is postponed makes it a larger breaking change.

---

# Stream 3 — Plugins

**Status:** Track A is under way — the effect boundary (§5), the descriptors
(§6) and the panel built from them (A1–A3) have landed, along with a test that
makes the two halves of the parameter contract check each other. None of it
commits the project to a plugin format; all of it is worth having anyway. A4 is
next and §12 decides it in advance. The CLAP-facing work (§8, §9) has not
started.

## Why

The engine is fixed. Six wavetables, one filter, eight effects — every sound
Sheliak can make is a sound somebody compiled into it. That ceiling is fine while
the notation is what is being proved, and it becomes the reason people leave once
the notation works.

The obvious answer is to write more effects. It is the wrong answer at this
scale: the marginal effect costs a file in `dsp/src/fx/`, a type id in
`fx/mod.rs`, two entries in the hand-maintained parameter contract, a parser in
`dsl/fx.ts`, a panel schema in `gui/schema.ts`, and two documentation tables —
**eight files across two languages for one effect**, all of it merge-contended.
Meanwhile the master chain still runs one instance of each type on one bus,
because that is what a fixed layout can express.

The real answer is to let the sound come from outside. [CLAP](https://github.com/free-audio/clap)
is the format to bet on, for reasons in §2, and the position this stream takes is
the one the [roadmap](roadmap.md#non-goals-that-shape-the-design) already stated:

> **No binary project file, ever.** If a thing cannot be written as text, it is a
> referenced dependency, not part of the song.

A plugin is a referenced dependency. The document owns the wiring, the notes and
the parameters; the plugin's interior is a black box Sheliak does not model, does
not serialize, and does not pretend to understand.

## Design principles

- **Parameters, never state blobs.** A plugin is addressed through its declared
  parameters and nothing else (§3). This costs real functionality and is still
  correct: the alternative ends with base64 in the document, and a song that
  cannot be diffed is a song Sheliak had no reason to hold.
- **One plugin shape.** A built-in effect and a hosted plugin present the same
  interface to the notation, or the notation grows two dialects and the GUI grows
  two code paths. The built-ins move onto the plugin interface first; hosting is
  what gets added afterwards.
- **Reproducibility is declared, not assumed.** Determinism is a non-negotiable
  for the engine and cannot be one for third-party code (§4). A document says
  which guarantee it is claiming rather than leaving the guarantee to erode
  quietly.
- **The DSP core still does not know the DSL, and does not become a host.**
  Hosting sits above the core. `dsp/` remains a thing that could itself be
  compiled as a plugin — that property is worth more than the convenience of
  putting the host inside it.
- **Nothing lands that changes today's audio.** Every step through §6 is finished
  only when `dsp/tests/verify.rs` and `web/src/integration.test.ts` produce the
  same samples as before it. This is the criterion Track B of Stream 1 was held
  to and it is the reason that stream was safe.

## 1. Where CLAP can and cannot run

A native `.clap` is a dynamic library that a host `dlopen`s. **A browser cannot
load one, and no amount of design changes that.** Commercial plugins ship as
x86/ARM binaries; they are not reachable from the page Sheliak runs in.

There is a second target. [web-clap](https://github.com/free-audio/web-clap) is a
draft from the CLAP project itself for CLAP compiled to `wasm32`: a `.wclap`
bundle whose `module.wasm` exports `clap_entry`, imports or exports its memory,
and exports exactly one growable function table, distributed as a `.tar.gz`.
[Signalsmith's browser host](https://github.com/Signalsmith-Audio/wasm-clap-browserhost)
is a working proof of concept — it fetches and compiles the wasm and drives it
from an `AudioWorkletProcessor`, with a C++ host layer keeping the CLAP structs
out of JavaScript. CLAP 1.2.7 added a draft `webview` extension so a plugin can
carry a GUI the browser can actually show.

That is very close to what `web/public/worklet.js` already is. The distance is
not architectural; it is the CLAP host implementation.

| | Native `.clap` | `.wclap` |
|---|---|---|
| Commercial plugins available today | Effectively all of them | Almost none |
| Runs in Sheliak's browser build | Never | Yes, with a host in the worklet |
| Ecosystem maturity | Stable since 2022 | Draft, moving |
| Preserves "open the URL and it plays" | No | Yes |

Neither is a substitute for the other, which is why §8 and §9 are separate tracks
rather than alternatives to choose between.

## 2. Why CLAP and not VST3 or LV2

- **Licensing.** CLAP is an MIT-licensed C ABI with no SDK agreement to sign.
  VST3's dual GPL/proprietary licence cannot be reconciled with an MIT project
  that expects contributors to build it. This alone decides it.
- **The event model already matches.** CLAP events are sample-accurate, and the
  worklet already splits the 128-frame render quantum at event boundaries and
  calls `process(n1); note_on(...); process(n2)`. There is no queue to build and
  no timing model to reconcile.
- **Parameters are enumerable.** `clap_plugin_params` reports a stable `u32` id,
  name, range and default per parameter. The notation surface and the parameter
  panel can be *generated* from that, which is the same mechanism §6 needs for
  the built-ins. Hand-written schemas stop being the way effects are described.
- **Note expressions fit the phrase model.** CLAP carries per-note modulation,
  which is the shape the detail cascade (§4–§5 of Stream 1) already produces.
  Sheliak's per-note glide and legato map onto it more naturally than onto MIDI 1.0.

## 3. What does not fit: plugin state

`clap_plugin_state` is an opaque binary stream. Most plugins keep things there
that no parameter describes — loaded samples, drawn curves, internal routing —
so "read the parameters" and "capture the plugin's state" are not the same
operation. Two positions are available:

| | Consequence |
|---|---|
| **(a) Parameters only** | Text-complete, diffable, reviewable. Some plugin features are simply unreachable from Sheliak |
| (b) Embed the state blob | Every feature reachable. The document acquires an opaque base64 region and stops being a document |

**Take (a), and write it down as a rule rather than a limitation to apologize
for.** Sheliak drives a plugin's parameters. It does not save a plugin's state,
does not restore one, and a plugin whose sound depends on state the parameters do
not cover is a plugin Sheliak represents incompletely. A user who needs (b) needs
a conventional DAW, and that is a coherent thing to tell them.

The corollary is a loading rule: a hosted plugin is instantiated, its parameters
are set from the document, and nothing else is applied. There is no restore path,
so there is no way for an undocumented state to leak into a render.

## 4. Reproducibility classes

Non-negotiable 5 says the same document and seed produce bit-identical audio.
Third-party code cannot be held to that: plugins use unseeded RNGs, read clocks,
dispatch on CPU features, and treat denormals differently between builds.
`dsp/tests/verify.rs` cannot see inside them.

So the guarantee gets graded, and the document declares which grade it is
claiming in frontmatter:

| Class | Meaning | Golden audio hash |
|---|---|---|
| `engine` | Built-in engine only. Non-negotiable 5 applies in full | Meaningful **against a named engine build** — see §9: two builds of the same source agree to one LSB, not to the byte |
| `pinned` | External plugins, resolved through a lockfile | Meaningful only against the same lockfile on a comparable build |
| `unpinned` | External plugins, unresolved | None. The document plays; it does not reproduce |

**This is the same problem as samples**, which the roadmap already plans to make
"pinned dependencies, referenced by URL and hash in a lockfile". Design the
lockfile once, for both. Doing plugins first and samples later means designing it
twice and reconciling the halves.

Two things follow that are easy to miss:

- The class is **derived, not written by hand**. It is a function of what the
  document references, so it cannot lie. Writing `engine` on a document that
  loads a plugin is an error, not a claim.
- "Rendered previews on a pull request" and "golden audio hashes" in the roadmap
  are only unconditionally true for `engine`. That is worth stating before those
  features are built on the assumption that every song is checkable.
- **Even `engine` pins a build, not a version.** The native renderer and the
  wasm one disagree by a single least-significant bit on effects that use
  transcendental functions (§9). A hash is a property of the document *and* the
  binary that rendered it, and CI has to compare like with like.

## 5. The internal plugin boundary

**No CLAP is involved in this section.** It is the prerequisite, and it is the
part with the clearest standalone payoff.

Today an effect is a type id in a fixed layout. `FX_PARAMS_BASE = 112` with
`FX_PARAMS_STRIDE = 8` and eight types occupies indices 112–175 of a
`PARAM_COUNT = 192` block: **sixteen floats of headroom in the entire parameter
contract**, with the ninth effect type being the one that does not fit. The
chain also runs on the master bus only, at most one instance per type, because a
fixed slot per type cannot express two reverbs.

The target is that an effect *declares itself* — an id, a display name, and its
parameters with ranges, units and defaults — and that both the Rust chain and the
TypeScript side read that declaration instead of restating it. Concretely:

- `dsp/src/fx/mod.rs` dispatches over registered effects rather than a hardcoded
  `match` on ids 1–8
- the parameter region for effects becomes variable-length and instance-based,
  not `(type_id - 1) * 8`
- `web/src/dsl/fx.ts` and `web/src/gui/schema.ts` stop enumerating effects by
  hand; the panel is generated from descriptors, which is what `schema.ts`
  already does for synth fields and does not yet do for FX
- an effect becomes addressable per track and more than once

Effect type ids remain append-only and the existing eight keep their ids — the
change is how a type is described, not what the types are.

## 6. Parameter descriptors, and not making the contract worse

The contract is already written twice by hand, and AGENTS.md says so three times
because it is the failure that does not announce itself. A descriptor format
naively added on both sides makes it three.

**This section originally said to declare the descriptors in Rust and generate
the TypeScript. That was wrong, and building it is what showed why.** A
descriptor carries a DSL key, a unit and a default; non-negotiable 1 says a
string, a field name or a unit conversion inside `dsp/` is a bug. Putting the
descriptors in the crate would have broken the rule the whole stream exists to
respect, in the file that respects it most carefully.

**The descriptors live in `web/src/dsl/fx.ts`, and the Rust side keeps its
numbers.** `FX_DESCRIPTORS` gives each effect its id, its accepted spellings,
and per parameter the DSL key, the IR field, the block offset, the unit, the
default and the editable range. Everything that used to be a per-effect table is
computed from it: the type ids, the alias map, the allowed keys, the defaults,
the flattening into the parameter block, the expanded view, and the parameter
panel. An effect in `dsp/src/fx/` still reads a number at an offset and never
learns it was written `-6dB`.

Generation turned out to be the wrong tool for the other half too. What was
wanted was not a generated file but the guarantee that the two halves agree, and
a test gives that without a build step, a committed artifact or a staleness
check: `web/src/shared/params.contract.test.ts` reads `params.rs`, compares
every constant against `params.ts`, and fails by name. It covers the synth
parameters as well, which generation scoped to the effects would not have.

The remaining duplication is deliberate. The IR interfaces (`DistIR` and the
rest) stay hand-written, because they are what makes `field` in a descriptor a
compile-time error when it is misspelled — a generated type could not check the
thing that generated it.

## 7. The `fx` fence, generalized

The notation should not be able to tell a built-in from a plugin except by the
id. Sketch, not a specification:

```
fx: [reverb, plugin:com.example.tape]

plugin:com.example.tape:
  drive: 40%
  bias:  0.3
```

**Only one piece of this has landed, and deliberately so: the namespace is
reserved.** `:` in an effect type is rejected with a message that says Sheliak
does not host plugins yet, rather than listing the eight built-ins the writer
was not looking for. That much is worth doing now because it is a promise about
spelling — a built-in added later can never collide with a plugin id — and
un-reserving it afterwards would be a breaking change.

The rest waited for a host on purpose — notation for loading something that
cannot be loaded has never been executed, so the parameter names, the resolution
to CLAP's parameter ids and the failure paths would all have been guesses.
**That host now exists** (§9), so §7 is unblocked and the next piece of it can be
written against Dragonfly Reverb and LSP rather than against an idea. The first
question it has to answer is the one the host left open: a plugin currently runs
at its defaults, because the fence cannot yet name a parameter.

Rules that follow from the rest of this document:

- **Namespaced ids.** Built-ins keep their bare names; external plugins are
  namespaced so a plugin can never shadow an engine effect. **Reserved.**
- **Parameters are written by name, resolved to CLAP's stable `u32` ids** at
  load. A renamed parameter must fail loudly rather than silently landing on a
  neighbouring id.
- **A missing or unresolvable plugin is a parse error routed through
  `web/src/dsl/errors.ts`** — the last valid patch keeps playing and the fence
  freezes. It must not silence the song and must not fall back to a bypass, which
  would make a broken document sound like a working one.
- **Bare numbers stay a parse error.** A plugin's parameter has a unit or it is a
  normalized ratio; CLAP's parameter info carries enough to choose one at import
  time.

## 8. Hosting `.wclap` in the browser

The host lives with the worklet, not in `dsp/`. Ordering matters more than
technique here: **compile one of Sheliak's own effects to a `.wclap` and run it
through the host before any third-party binary is involved.** It makes the ABI
testable against a known-good reference, offline, with an existing determinism
check to compare against — a third-party plugin as the first test subject leaves
you debugging two unknowns at once.

Three risks worth knowing before starting:

- **Shared memory collides with a decision already made.** The draft allows a
  module to *import* its memory, which must be shared — and `SharedArrayBuffer`
  needs COOP/COEP, which Sheliak deliberately avoids because it breaks embedding
  and because posting a compiled `Module` to the worklet silently fails without
  it. **Sheliak can host only WCLAPs that export their own memory.** Confirm this
  against the draft before building on it; if the draft moves to requiring shared
  memory, this track stops and the native path (§9) is the whole answer.
- **The WASI surface is thin.** The reference host implements "the very basics"
  and 32-bit only. Expect to implement enough WASI to keep plugins from trapping,
  and expect that to be where the time goes.
- **The draft is a draft.** It will move. Do not spread CLAP structure
  assumptions across the codebase; keep them behind one module so a spec change
  is one file.

## 9. The native render path

Independent of §8, and the only route to commercial plugins in the foreseeable
future.

```
web/src/dsl/  ->  Patch IR (JSON)  ->  native renderer  ->  .wav
                                        clack-host + dsp as an rlib
```

This is cheaper than it looks, because both ends already exist. `dsp` is built as
an `rlib` as well as a `cdylib` specifically so it runs on the native target, and
the Patch IR is already required to be dumpable as JSON — "a patch should never
depend on a value you cannot see". **The parser does not have to move to Rust for
this**, which is what makes the path affordable now rather than after a rewrite.
[clack](https://github.com/prokopyl/clack) is the Rust CLAP host binding, and is
the only functional option.

**The first half has landed.** `render/` is a native crate that takes a render
job — the flat parameter block per track, the loop's events in samples, and how
long to render — and writes a WAV. `sheliak render <song.md> --emit-job <job>`
produces one, which keeps the parser where it is: the job is the same content
`worklet.js` receives over `postMessage`, so nothing about Markdown crosses into
Rust. `clack-host` on top is what remains.

### The two builds are not bit-identical, and it is one bit

Worth knowing before anything is built on top of it, because it bears on §4.
`scripts/check-render-parity.sh` renders a document both ways and compares.
On the FX stress document, 6% of samples differ and **every single difference is
one LSB at 16 bits — about -90 dBFS**. A track with no effects at all is
byte-for-byte identical.

The divergence is in the effect chain, which is where `tanh`, `exp` and `sin`
are, and the two builds reach different implementations of them; the wasm one is
also compiled with `+simd128`. So the arithmetic differs in the last place or
two, and it shows up only where a sample was already sitting on a rounding
boundary.

Two consequences:

- **A golden audio hash pins an engine build, not an engine version.** §4's
  `engine` class has to say which build produced the hash, or CI will compare a
  native render against a browser hash and call a working song broken. This is a
  smaller claim than "determinism holds" and it is the true one.
- **Determinism itself is untouched.** The same document, seed and *build* still
  produce identical bytes — that is what `verify.rs` and the wasm end-to-end
  test assert, and both still pass. What does not hold is bit-identity across
  two different compilations of the same source, which was never promised and is
  now measured rather than assumed.

Making them agree exactly would mean pinning the transcendental functions — a
shared software libm rather than each target's own. That is a real piece of work
and it should be a decision, not a side effect of wanting previews.

### It hosts a real plugin

`--clap <bundle.clap>` runs the finished mix through a CLAP plugin.
`--list-clap` prints what a bundle carries. Checked against two unrelated
vendors, both installed from apt on the development container:

| Plugin | Result |
|---|---|
| Dragonfly Hall Reverb (`michaelwillis.dragonfly.hall`) | loads, activates, processes; 95% of samples changed |
| LSP Limiter Stereo (`in.lsp-plug.limiter_stereo`), from a bundle of 176 | same, and picked out of the bundle by id |

Three things that came out of doing it rather than planning it:

- **Both plugins render bit-identically across runs.** The format guarantees
  nothing of the sort — a plugin may read a clock or use an unseeded RNG, and no
  host can stop it — so this is a measurement, and `render/tests/clap.rs` keeps
  making it. That is exactly the evidence §4's `pinned` class needs: it says a
  render is reproducible against *that build of that plugin*, and for these two
  it actually is.
- **Loading is `unsafe`, and correctly so.** `PluginEntry::load` runs an
  initialiser from a binary outside this repository. clack marks it unsafe
  because no wrapper can make it otherwise, and that is worth keeping visible
  rather than wrapping away: hosting a plugin is a decision about trust, not
  only about audio.
- **Parameters are untouched, so plugins run at their defaults.** There is
  nowhere to write them down yet; §7's fence is what fixes that, and it is now
  unblocked — it can be written against a plugin that really loads instead of
  against a guess.

Latency is not compensated. For a reverb that is nothing; for a look-ahead
limiter it is audible, and it belongs with the notation rather than here.

Offline rendering first, not live playback:

- commercial plugins exist natively today, so this path delivers the actual
  request while §8 waits for an ecosystem
- it lands on the roadmap's "rendered previews on a pull request" rather than
  beside it
- an offline renderer has no realtime constraint, so a badly behaved plugin
  costs a slow render instead of a dropout
- it does not fork the project into two live hosts to maintain

The browser stays canonical for playing and editing. A render that used plugins
carries class `pinned` (§4) and says so.

## 10. The export direction

Everything above points inward: other people's plugins, running inside Sheliak.
The arrow reverses cheaply, and it is worth writing down before someone concludes
it was never considered.

**A Sheliak patch can be compiled into a plugin other hosts can load.** After A2
the pieces are already there — `dsp` is compiled to wasm today, effects describe
their own parameters, and a patch is a fully expanded IR that dumps as JSON. A
`synth` fence plus the engine plus a parameter mapping is, structurally, a
`.wclap`; producing a native `.clap` from the same core is the same exercise
against a different target, since `dsp` builds for the native target already.

It is worth more than the effort suggests:

- **It answers the lock-in question.** A text format that only its own editor can
  play is a format people are right to be wary of. "The sound you wrote in
  Markdown loads in your DAW" removes that objection without compromising
  anything in the notation.
- **It costs the reproducibility classes nothing.** An exported plugin is output,
  not a referenced dependency, so §4 does not apply to it. The arrow pointing out
  is free in a way the arrow pointing in is not.
- **It does not depend on a draft holding still.** If web-clap moves, an exporter
  goes stale; it does not break the app.
- **Track D produces most of it as a by-product.** D's first deliverable is one of
  Sheliak's own effects compiled to a `.wclap` and round-tripped — that is the
  exporter with a smaller subject.

Treat it as a follow-on to D rather than a track of its own, and do not let it
start before A4: exporting a patch whose parameter layout is about to change means
building the exporter twice.

### Not this: translating native binaries

Recorded as rejected so it is not re-proposed. Running an unmodified commercial
`.clap` in the browser would mean dynamic binary translation of x86 — which does
exist, as CheerpX and WebVM demonstrate, and which has no place here:

- DBT compiles new traces **while the code runs**. Inside `process()` that
  allocates and takes unbounded time — non-negotiable 2 and the render deadline,
  broken on every block.
- Moving it off the audio thread adds buffering latency and gives up live
  playing. And for a non-realtime render the emulator is pointless: the native
  path (§9) runs the same plugin directly and far faster.
- The case where it would help and the case where it could work do not overlap.
- Commercial plugins commonly forbid it by licence and gate themselves behind
  online or dongle activation that a sandbox cannot satisfy.
- It makes determinism worse, not better.

"Commercial plugins in the browser" is not a hard problem waiting for effort. It
is a request that conflicts with constraints this project chose deliberately, and
§9 is the honest answer to it.

## 11. Order and dependencies

| Phase | Depends on | Can start now |
|---|---|---|
| §5 internal plugin boundary | — | Yes |
| §6 descriptors and generation | §5 | With §5 |
| §4 reproducibility classes and lockfile | Stream 2 frontmatter | Design now, land with frontmatter |
| §7 generalized `fx` fence | §5, §6 | After |
| §9 native render path | §5 (for the plugin interface); nothing else | **landed**: renders natively and hosts a CLAP plugin |
| §8 `.wclap` host in the browser | §5, §7 | After |
| §10 exporting a patch as a plugin | A4 (the layout must have stopped moving) | After |

§5 and §6 are unconditional: they pay for themselves in the cost of the ninth
effect, whether or not a single external plugin is ever loaded. §9 shares almost
no files with anything and can run alongside from day one. §10 is the only item
here that survives web-clap being abandoned.

## 12. A4, decided before it is written

A1–A3 said "decide the open question about per-instance blocks in prose, merged,
before the code". This is that, and thinking it through moved the difficulty:
**the offsets are the easy half and the memory is the hard one.**

### The offsets

Today the region is per *type*: `FX_PARAMS_BASE + (type_id - 1) * FX_PARAMS_STRIDE`,
112–175 of a 192-float block. It cannot hold a ninth type and it cannot hold two
reverbs, because a type has exactly one home.

**Make the region per *slot* instead: `FX_SLOT_BASE + slot * FX_SLOT_STRIDE`,
with the slot's type still in `FX_ORDER_BASE[slot]`.** Eight slots at a stride of
eight is 64 floats — exactly what the per-type region costs now, so the block
does not grow. A ninth type stops being a layout question entirely: a type id is
just a number written in an order slot. Two reverbs become two slots.

This is a small change and the contract test plus the bit-identical render cover
it. It is not the whole of A4.

### The memory

A per-slot block means a per-slot *instance*, and that is where it gets
expensive. Today each track holds one of each type, allocated once in `init()`.
If any slot can be any type, the options are:

| | Cost |
|---|---|
| One of every type in every slot | 8 slots × 8 types × 8 tracks. A 2-second stereo delay line alone makes this absurd |
| One instance per slot that can become any type | 8 slots × the largest variant × 8 tracks. Possibly several times today's footprint |
| Keep one instance per type, let it appear in several slots | Cheap, and a lie: the two "reverbs" would share one tail |
| Allocate on demand | Forbidden. `init()` is the only place that may allocate |

**The numbers now exist.** `dsp/tests/footprint.rs` measures them; run it with
`cargo test --test footprint -- --nocapture`. At 96 kHz, which is the worst case
a browser is likely to hand us:

| Effect | Heap held |
|---|---|
| dist, eq, phaser, mbcomp | **nothing** — fixed arrays, all of it in the struct |
| flanger | 9 KiB |
| chorus | 12 KiB |
| reverb | 455 KiB |
| delay | 1500 KiB |
| one chain (one of each) | 1978 KiB |
| the whole `MultiEngine`, 8 tracks | 21.4 MiB |

So a per-slot instance able to become any type costs 8 x 1500 KiB = 11.7 MiB per
track, 94 MiB across eight tracks — against 15 MiB for the chains today. Six
times, for two reverbs.

**And the measurement points at a better option than the four in the table.**
Half the effects allocate nothing at all; the entire cost is delay lines and
comb banks, in four types. A per-slot design does not have to give every slot a
delay line — it can give every slot a *place to put one* and bound how many
delay-class effects a track may hold, which is a policy the notation can state
and the parser can enforce. That is worth designing before accepting a sixfold
footprint or giving up on duplicates.

### So A4 splits in two

- **A4a — per-slot blocks.** The offset change above, keeping one instance per
  type for now. Removes the `PARAM_COUNT` wall at the ninth effect. Cheap,
  verifiable, no memory question. **Landed.** One consequence was not obvious
  from the armchair and is worth carrying forward: the slot *is* the address, so
  reordering a chain moves its parameters. The writing side rebuilds the whole
  block every compile, so it costs nothing there — but a test that permuted
  `FX_ORDER` over one shared set of blocks was expressing something the layout
  no longer supports, and had to be rebuilt rather than patched.
- **A4b — duplicate instances of a type.** The measurement is done and lives in
  `dsp/tests/footprint.rs`; what is left is the decision it informs, and the
  bounded-delay-lines idea above is the first thing to cost out.

Splitting them matters because A4a unblocks the thing this stream is for —
effects that are not the eight compiled in — while A4b only buys two reverbs.

### What none of it solves

A CLAP plugin has as many parameters as it likes, commonly dozens. **No stride
holds that**, so hosted plugins do not put their parameters in the fixed block
at all; §8 and §9 need a variable-length region sized at `init()`, or a separate
buffer. That is a different mechanism from A4 and it should not be smuggled into
it. A4 is about making the *built-in* set open-ended; the plugin transport is
its own design, and §7's notation is deliberately silent on where the numbers
travel.

## Splitting the work

Four tracks. **A and C can run concurrently from the start; B waits on Stream 2's
frontmatter; D waits on A.** Do not put two agents inside Track A — it is the
parameter contract, and that is the file pair AGENTS.md names as the contention
hotspot.

### Where the difficulty is

Two kinds of hard, and they want different handling. Some steps are **large** —
they take a long time and you find out when they fail. Others are **silent** —
small diffs whose failure mode is green tests and wrong audio. With no ears in
the loop, the silent ones are the dangerous ones.

| | Hard because | Handling |
|---|---|---|
| D / §8 | Largest. A CLAP host, inside a bundler-free worklet, plus a WASI shim, against a moving draft — and it can be invalidated before a line is written | Settle the shared-memory question first. Do not start it as anyone's first task here |
| **A4** | **Silent.** It moves the parameter contract, which AGENTS.md names as the one change that breaks without failing | Decide the open question about per-instance blocks **in prose, merged, before the code** |
| §4 / B | Silent, and mostly a design argument rather than an implementation | Write the classes down and get them agreed before touching frontmatter |
| C, second half | Large, but unconstrained — no realtime deadline, no worklet, and clack does the unsafe parts | Ordinary work. Land the first half before it |
| A1–A3, A5 | Neither. Bit-identical audio is a real check, so a mistake announces itself | Ordinary work |
| **C, first half** | Neither, and it shares no file with any other track | **The right first task.** It also proves the IR is an interchange format rather than an internal type |

### Track A — the effect plugin boundary (§5, §6, §7)

**Owns** `dsp/src/fx/`, `dsp/src/params.rs`, `web/src/shared/params.ts`,
`web/src/dsl/fx.ts`, `web/src/gui/schema.ts`, the descriptor generation script,
the FX tables in `docs/architecture.md`, the `fx` section of `docs/syntax.md`.
**Does not touch** `web/public/worklet.js`, `dsp/src/{engine,voice,oscillator}.rs`,
`web/src/dsl/phrase.ts`.

| # | Step | Finished when | |
|---|---|---|---|
| A1 | The chain dispatches over a registry | `Effect` is a trait, `Fx` holds `[Box<dyn Effect>; FX_TYPE_COUNT]`, and the four per-type `match`es are loops; **audio is bit-identical** | **landed** |
| A2 | The effect set described once | `FX_DESCRIPTORS` in `dsl/fx.ts` drives the type ids, aliases, allowed keys, defaults, block flattening and expanded view; audio and the expanded view are byte-identical | **landed** |
| A2b | The contract checks itself | `params.contract.test.ts` compares every constant in `params.rs` against `params.ts` and fails by name | **landed** |
| A3 | Panel from descriptors | `gui/schema.ts` builds FX controls from descriptors; the built panel is byte-identical to what the hand-written specs produced | **landed** |
| A4a | Blocks addressed by chain slot | `base = FX_SLOT_BASE + slot * FX_SLOT_STRIDE`; a type id is a name rather than an address, so a ninth effect needs no room reserved; audio bit-identical | **landed** |
| A4b | Two instances of one type | Duplicates stop being dropped. Blocked on measuring per-effect memory first — see §12 | **next** |
| A5 | Per-track effects | — | landed before this stream: the chain belongs to the track it is written in |

**A1 was the gate**, and the bit-identical criterion is what made the rest safe
to attempt: a three-track document with all eight effects in one chain, a second
chain reordered with one effect at `mix: 0%`, and a third track with no chain,
rendered to WAV before and after every step. Keep using it for A4 — it is the
only check that sees a parameter landing one slot over.

### Track B — reproducibility classes and the lockfile (§4)

**Owns** the frontmatter fields for engine version and dependencies, the lockfile
format, `docs/syntax.md`'s frontmatter section, `docs/architecture.md`'s
determinism section. **Does not touch** `dsp/`, `web/src/gui/`.

Coordinate with Stream 2 before starting: frontmatter is Stream 2's first
deliverable and this track adds fields to it. **Design the lockfile for samples
and plugins together** — that is the whole point of doing it here.

Finished when a document's class is derived from what it references and cannot be
overridden by hand; a `pinned` document names every external dependency with a
hash; and the determinism check states which class it is asserting.

### Track C — the native render path (§9)

**Owns** `render/`, `web/src/cli/job.ts`, `scripts/check-render-parity.sh`.
**Does not touch** `web/src/gui/`, `web/public/worklet.js`, `dsp/src/fx/`.

The only track that shares essentially no file with the others.

**First half landed**: `render job -> dsp rlib -> .wav`, with no plugins at all,
checked against the browser's output by `scripts/check-render-parity.sh`. It
proved the interchange format is real, and it turned up the one-LSB divergence
in §9 that §4 now has to account for.

One correction to what this said before: the boundary is **not** the Patch IR.
The IR is the parser's output and still carries names and units; what the
renderer needs is the flat parameter block, which is what the worklet gets and
what the engine reads. Sending the IR would have put a second consumer of the
notation's shape in Rust — exactly the thing §9 exists to avoid.

What remains is `clack-host` on top.

### Track D — the `.wclap` host (§8), and the exporter (§10)

**Owns** `web/public/worklet.js`, `web/src/audio/`, the host module, the WCLAP
build recipe and the patch exporter.
**Does not touch** `web/src/dsl/`, `dsp/src/`.

Starts after A4. First deliverable is one of Sheliak's own effects compiled to a
`.wclap` and round-tripped through the host with output matching the built-in
version — not a third-party plugin. Confirm the shared-memory question in §8
before writing code; it can invalidate the track.

The build recipe that first deliverable needs — clang against the wasi-sdk
sysroot, `libclang_rt.builtins-wasm32.a`, the WCLAP export conventions — is a
few dozen lines of build configuration, not a compiler. It is also most of what
§10's exporter requires, so land the two together: the exporter is the same
recipe pointed at a whole patch instead of one effect. **If §8 is invalidated by
the shared-memory question, §10 survives it** — exporting does not depend on
Sheliak being able to host anything — and this track becomes the exporter alone.

### Crossings

| File | Owner | |
|---|---|---|
| `dsp/src/params.rs` + `web/src/shared/params.ts` | Track A, exclusively | The pair moves together; no other track edits either |
| `web/src/defaultDoc.ts` | Track A | Every track wants a line in it; route requests through A |
| `docs/architecture.md` | A owns the FX and parameter tables, B owns determinism | Disjoint sections, one file — coordinate the commit |
| `web/src/integration.test.ts` | Track D | It mirrors `worklet.js`. A mirror belongs to the thing it mirrors |
| `web/src/dsl/errors.ts` | Track A | §7's failure path |
| `CHANGELOG.md` | all | Append-only, still a conflict if simultaneous |
| this file | whoever finishes a track | Move its status line |

## Open questions

Not decided, and each of these is a place where the design above could be wrong:

- **Does the draft permit a WCLAP that never imports shared memory?** §8 depends
  on it, and Sheliak's no-COOP/COEP decision is not negotiable in the other
  direction — embedding matters more than plugin hosting.
- **Does a plugin instance get its own parameter block, or a shared arena?** A4
  needs an answer and the answer shapes how much of the flat-block model survives.
- **What is the sample-rate story for the native renderer?** The browser takes
  the rate from the `AudioContext`; an offline render picks one, and a plugin may
  sound different at 44.1 kHz than at 48 kHz, which makes the rate part of what a
  lockfile has to pin.
- **Is `unpinned` allowed to exist at all?** Permitting it is honest about what
  people will do; forbidding it keeps every Sheliak document reproducible by
  construction. This is a values question, not a technical one.
- **Does a hosted instrument (not just an effect) belong in this stream?** CLAP
  instruments would replace the synth engine per track rather than post-process
  it, which touches voice allocation and `note_on` rather than the FX chain.
  Assume not, until the effect path works.
