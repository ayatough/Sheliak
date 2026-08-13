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

**Owns** `web/src/dsl/`, `web/src/gui/`, `web/src/defaultDoc.ts`, `docs/syntax.md`.
**Does not touch** `dsp/`, `web/public/worklet.js`, `docs/architecture.md`.

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
| `CHANGELOG.md` | both | Append-only, but still a conflict if edited at the same moment |
| this file | whoever finishes a track | Move its status line |

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
