// The document the editor starts with. Kept out of main.ts so the fence
// backticks stay readable.

const F = '```';

export const DEFAULT_DOC = `# Sheliak — スケッチ

テキストを編集すると 150ms 後に再コンパイルされ、再生を止めずに反映されます。
エラー時は直前の有効なパッチで鳴り続けます。

${F}synth id=lead seed=42
osc:
  - { table: basic/saw,    level: 0dB,  morph: 0%,  unison: 7, detune: 22c, spread: 80% }
  - { table: basic/square, level: -8dB, morph: 30%, tune: -12st }

filter: { type: lp12, cutoff: 800Hz, res: 0.3, drive: 0.2, key_track: 50% }

env:
  amp:    { a: 5ms,  d: 200ms, s: 70%,  r: 120ms }
  filter: { a: 2ms,  d: 400ms, s: 0%,   r: 100ms }

lfo:
  1: { wave: tri, rate: 1/4, phase: 0% }

mod:
  - { from: env.filter, to: filter.cutoff, amount: +2400c }
  - { from: lfo.1,      to: osc.1.morph,   amount: 25% }

voice: { polyphony: 8, glide: 0ms }
${F}

${F}loop id=demo bars=2 bpm=124
lead: C3 . Eb3 . | G3 ~ ~ . | Bb3 . . . | C4 ~ ~ ~
${F}
`;
