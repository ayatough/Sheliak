# The road to a grand piano

A brief for whoever picks this up next — an agent or a human. It records
where the instrument stands, what the author's ears said, why it still does
not sound like a grand piano, and the ordered work that closes the gap. Each
workstream below is written to be assignable on its own: context, the change,
where it lives, and how to know it worked.

## Where things stand

`piano/` is a physically modelled piano as a native CLAP instrument. Modal
strings (1–3 per key plus a polarisation bank on bass singles, stiff-string
inharmonicity, Railsback stretch), a nonlinear felt hammer integrated against
the string during contact, dampers with a pedal, an 88-entry measured voicing
table. **Verified**: 24 offline tests (determinism, tuning vs theory, decay,
pedal, boundedness), clap-validator 0.4.1 fully green (35 passed, 0 failed,
9 skipped for undeclared extensions), plays end-to-end under
`sheliak-render --clap-instrument` and loads in any CLAP DAW.

Read `piano/README.md` first — build, the tuning-knob table, and the
edit → listen → `--retrim` → test loop. Read `AGENTS.md` at the repository
root before changing anything; its rules (English everywhere, no allocation
in `process()`, determinism, do not weaken tests, the full gate) apply here.

**The listening loop is the process.** The agent cannot hear. Every
iteration must end with a rendered WAV (`examples/render_wav.rs`,
`examples/bass_demo.rs`, or a new passage) sent to the author, and the
author's words — "sounds like a bass", "sounds like a harpsichord" — are the
measurement. Both of those verdicts mapped cleanly onto physics (missing
radiation rolloff; too-slow treble-partial decay) and were fixed as such.
Expect the next verdicts to do the same. Keep iterations small: one
mechanism per round, so the author can hear what changed.

## What the ears said so far

1. *"Bass sounds like an electric bass"* → fixed: soundboard radiation
   rolloff below 180 Hz, polarisation bank on single strings.
2. *"Now it sounds like a harpsichord"* → fixed: treble partials decayed an
   order too slowly (`sigma2` ×3), soundboard rolloff above 1.5 kHz.
3. *"Quality is still low; is it the missing hammer knock?"* → **open, and
   the author is right.** The strike transient is pure string vibration;
   every percussive noise component of a real strike is absent. This is
   workstream 1.

## Workstreams, in order of audible payoff

### 1. The strike noise — key knock, shank thunk, soundboard thump

The single biggest gap. A real note is *strike noise + string tone*; we
synthesise only the tone, so the onset reads as a pluck.

- Add a deterministic broadband transient at note-on: a short noise burst
  (seeded per key from `keys.rs::jitter` — **no RNG**, determinism is
  non-negotiable), lowpassed and shaped per register (bass thump ~2–6 ms,
  darker; treble knock shorter, brighter), level scaling with hammer
  velocity **faster than** the string tone does (knock dominates at ff,
  nearly vanishes at pp).
- Route it through the same radiation/body path as the strings so it sits
  *inside* the instrument, not on top of it.
- Where: a small addition to `Voice::setup`/`process` in
  `src/model.rs`; a `Knock` level parameter (append a new id — ids are a
  contract, never renumber).
- Verify: determinism and click tests still green; a new test asserting the
  transient's decay (< 20 ms to −40 dB) and its absence at velocity ≈ 0.
  Then the author listens.

### 2. A soundboard that is a resonator, not a filter

Currently two shelving corners (`RADIATION_HZ`, `SOUNDBOARD_HZ`) stand in
for the soundboard. A real board adds body resonances (a modal cluster
roughly 50–400 Hz, density increasing upward) and couples the strike into a
diffuse, stereo-wide body response.

- Cheapest honest version: a fixed bank of ~24–48 damped modes (the same
  magic-circle resonator the strings already use) fed by the summed bridge
  force, with slightly different mode weights left/right for width. All
  allocation in `Piano::new`.
- Alternative: a short (~50–150 ms) synthetic IR convolved at the output —
  heavier, harder to keep deterministic across block sizes; prefer the
  modal bank.
- Verify: DC/click/determinism tests; a spectral test that the 100–400 Hz
  region of a struck note gained energy relative to before. Ears decide the
  amount.

### 3. Sympathetic resonance

With the pedal down, every string is undamped and the whole instrument
answers — much of the "grand piano in a room" impression. Full coupling is
O(n²); the standard approximation is one feedback path: a fraction of the
output bus injected into every open (undamped) voice's modes, gain kept
well under the stability margin.

- Where: `Piano::process`, after the voice loop; inject next block (one
  block of latency in the coupling is inaudible and keeps it causal).
- Verify: with pedal down, strike-and-release of one key must leave a
  measurable, decaying halo (new test); energy must stay bounded (extend
  `hammering_every_key_at_once_stays_bounded` with pedal down).

### 4. Felt with memory — Stulov, and the treble lobes

The Hunt–Crossley loss factor (`0.5 * hammer.vh`) tamed but did not remove
the treble contact-alignment lobes; the voicing table absorbs the residue
statically, at the cost of per-key pp/mf unevenness in the top octave.
Stulov's hysteretic felt (stiffness with a relaxation memory integral)
smooths the force pulse physically and should shrink the lobes at the
source. Afterwards, re-measure (`--retrim`) and expect to *reduce* the
table's spread — that is the success metric, alongside the ears.

### 5. Data-driven voicing — the Pianoteq lever

Hand-set anchor curves in `keys.rs` are guesses refined by two listening
rounds. The systematic route: fit them to real recordings.

- Build an analysis example (`examples/analyze.rs`): given a WAV of a
  single note (the author can record any reference piano note by note —
  even a phone recording of an acoustic piano works), extract per-partial
  frequencies (→ fit `b`, stretch), decay rates early/late (→ fit
  `sigma0`/`sigma2`, detune from the beat period), and the spectral
  envelope (→ strike position, soundboard corners).
- Emit the fitted anchors in the exact form `keys.rs` holds, like
  `--retrim` already does for the trim table. Fit a handful of reference
  keys, interpolate the rest — the same shape the code already has.
- This turns "tune it like Pianoteq" from taste into measurement, and it is
  the workstream with the highest ceiling.

### 6. Smaller, real, later

Una corda and sostenuto (CC 67/66 + parameters); half-pedalling (map CC 64
continuously onto damper sigma); repedalling catch; duplex scaling; CLAP
note expression for per-note dynamics; `NOTE_END` events to the host so
polyphonic-modulation hosts (Bitwig) reclaim voices; a `.wclap` build of
this crate so the piano plays in the browser too (`wclap/` and
`scripts/build-wclap.sh` are the worked example — the model already meets
the constraints: single-threaded, allocation-free processing, no clock).

## Rules of engagement (learned the hard way)

- One mechanism per iteration, WAV to the author every time, and never
  claim an audible result — say what was verified and what was not.
- After any level-shifting change:
  `cargo run --release --example levels -- --retrim`, paste over
  `OUTPUT_TRIM`, and keep `cargo test` green — thresholds in
  `tests/model.rs` are the safety net, not the enemy.
- Run clap-validator after ABI-adjacent changes (build it from
  free-audio/clap-validator; needs recent stable Rust). It caught a real
  spec violation (missing `rescan` after state load) that no local test saw.
- Check exit codes directly — a `cmd | tail` pipeline once swallowed a
  clippy failure and it reached the branch.
- The work happens on `claude/physical-piano-clap-plugin-sk7nz2` unless the
  author says otherwise. Full gate before every push (`AGENTS.md`).

## References

- Chaigne & Askenfelt, *Numerical simulations of piano strings* I–II (1994)
  — the string/hammer model and measured parameters this code started from.
- Stulov, *Hysteretic model of the grand piano hammer felt* (1995) — WS 4.
- Bank et al., *Physics-based sound synthesis of the piano* (2003) and
  Bank & Chabassier, *Model-based digital pianos* (IEEE SPM 2019) — the
  modal approach, soundboard coupling, and a map of everything here.
- Xie, *Physical Modeling of Piano Sound* (arXiv:2409.03481, 2024) — full
  3D offline model; the reference for couplings when in doubt, not a
  real-time blueprint.
