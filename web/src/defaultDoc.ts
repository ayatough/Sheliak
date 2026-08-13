// The document the editor starts with. Kept out of main.ts so the fence
// backticks stay readable.
//
// Each ```synth fence is one track, in order of appearance; the loop fence's
// lines bind to them by id.

const F = '```';

export const DEFAULT_DOC = `# Sheliak — a four-track groove

Edit the text and it recompiles 150 ms later, without stopping playback.
The order the synth fences appear in is the track index (0..7); each loop line
binds to the fence with the same id. A fence that fails to parse keeps playing
its last valid patch, and only that fence freezes.

${F}synth id=lead seed=42
osc:
  - { table: basic/saw,    level: -3dB,  morph: 0%,  unison: 5, detune: 18c, spread: 80% }
  - { table: basic/square, level: -12dB, morph: 30%, tune: -12st }

filter: { type: lp12, cutoff: 900Hz, res: 0.28, drive: 0.15, key_track: 40% }

env:
  amp:    { a: 8ms, d: 220ms, s: 65%, r: 180ms }
  filter: { a: 2ms, d: 380ms, s: 10%, r: 140ms }

lfo:
  1: { wave: tri, rate: 1/4, phase: 0% }

mod:
  - { from: env.filter, to: filter.cutoff, amount: +2600c }
  - { from: lfo.1,      to: osc.1.morph,   amount: 20% }

fx:
  - { type: reverb, size: 65%, damp: 55%, mix: 16%, predelay: 18ms, width: 100% }
  - { type: comp,   thresh_low: -20dB, thresh_mid: -18dB, thresh_high: -22dB, ratio: 3, attack: 12ms, release: 140ms, makeup: 0dB }

voice: { polyphony: 6, glide: 0ms }
${F}

${F}synth id=bass seed=7
osc:
  - { table: basic/saw,    level: -2dB,  unison: 2, detune: 8c, spread: 25% }
  - { table: basic/square, level: -10dB, tune: -12st }

filter: { type: lp24, cutoff: 420Hz, res: 0.2, drive: 0.35, key_track: 30% }

env:
  amp:    { a: 2ms, d: 140ms, s: 55%, r: 90ms }
  filter: { a: 1ms, d: 120ms, s: 0%,  r: 80ms }

mod:
  - { from: env.filter, to: filter.cutoff, amount: +1800c }

voice: { polyphony: 2, glide: 0ms }
${F}

${F}synth id=kick seed=1
osc:
  - { table: basic/sine, level: 0dB }

# env.filter routed to pitch drops three octaves in 55 ms = a kick's attack
filter: { type: lp12, cutoff: 6kHz, res: 0.1, drive: 0.35, key_track: 0% }

env:
  amp:    { a: 1ms, d: 150ms, s: 0%, r: 60ms }
  filter: { a: 0ms, d: 55ms,  s: 0%, r: 55ms }

mod:
  - { from: env.filter, to: pitch, amount: +3600c }

voice: { polyphony: 2, glide: 0ms }
${F}

${F}synth id=hat seed=3
# osc: [] = no oscillator at all. A noise-only patch, which is how hats are made
osc: []

noise: { level: -6dB, color: white }

filter: { type: hp12, cutoff: 8kHz, res: 0.15, drive: 0%, key_track: 0% }

env:
  amp:    { a: 1ms, d: 40ms, s: 0%, r: 30ms }
  filter: { a: 1ms, d: 30ms, s: 0%, r: 30ms }

voice: { polyphony: 3, glide: 0ms }
${F}

${F}loop id=groove bars=1 bpm=126
lead: [C4 Eb4 G4] ~ ~ ~ | ~ ~ ~ ~ | [Bb3 D4 F4] ~ ~ ~ | ~ ~ ~ ~
bass: .  .  C2 .        | .  .  C2 .  | .  .  Eb2 .    | .  .  Bb1 .
kick: C1 .  .  .        | C1 .  .  .  | C1 .  .  .     | C1 .  .  .
hat:  .  F#4 . F#4      | . F#4 . F#4 | . F#4 . F#4    | . F#4 . F#4
${F}
`;
