# Sheliak — Wavetable WASM Synth MVP: Integration Contract

> format_version: 0.1
> このファイルは **DSPコア (Rust/WASM)** と **Web層 (TS)** の統合契約。両側の実装はこの仕様に厳密に従うこと。
> 要件定義は `docs/REQUIREMENTS.md` を参照。

---

## 1. リポジトリ構成

```
dsp/            Rust DSPコア (cdylib → wasm32-unknown-unknown, rlib → ネイティブテスト)
  src/lib.rs      raw WASM exports (no wasm-bindgen)
  src/params.rs   パラメータブロックのレイアウト定数 (契約ファイル・変更禁止)
  src/...         engine, oscillator, filter, env, lfo, tables, etc.
  tests/          決定性・エイリアス・DCテスト (ネイティブターゲットで実行)
web/            Vite + TypeScript フロントエンド
  public/worklet.js   AudioWorkletProcessor (自己完結・依存なし。バンドラの都合で plain JS)
  src/shared/params.ts  dsp/src/params.rs の鏡像 (契約ファイル・変更禁止)
  src/dsl/        コードフェンス抽出、synth/loop DSLパーサ → Patch IR / Loop IR
  src/audio/      AudioContext 管理、WASMロード、worklet との postMessage
  src/main.ts     UI
scripts/        ビルドスクリプト (wasm → web/public/dsp.wasm へコピー)
```

---

## 2. WASM ABI (raw exports, no wasm-bindgen)

DSPコアは DSL を一切知らない。入力は正規化済みパラメータブロック (f32 配列) とノートイベントのみ。

v0.3 からマルチトラック (最大 MAX_TRACKS=8)。各トラックは独立したパッチ (パラメータブロック
+ ボイス群 + FXチェーン) を持ち、ウェーブテーブルのミップマップは全トラックで共有する。
トラック出力は合算し、マスターで軽いソフトクリップガード (|x| > ~0.95 でのみ作用) をかける。

```
exports:
  memory: WebAssembly.Memory
  init(sample_rate: f32)            // 全状態リセット + テーブル/ミップマップ生成。ここでのみアロケーション可
  params_ptr(track: u32) -> u32     // トラックの f32 × PARAM_COUNT ブロック先頭 (wasmメモリ内オフセット)
  apply_patch(track: u32)           // トラックのパラメータブロックを読み込んで反映 (アロケーションなし)
  note_on(track: u32, note: f32, velocity: f32) // note: MIDIノート番号 (小数可), velocity: 0..1。即時発音
  note_off(track: u32, note: f32)
  all_notes_off()                   // 全トラック高速フェード付き全消音
  process(nframes: u32)             // nframes ≤ 128。out_l/out_r に書き込む
  out_l_ptr() -> u32                // f32 × 128 の出力バッファ (L)
  out_r_ptr() -> u32                // f32 × 128 の出力バッファ (R)
```

- track は 0..MAX_TRACKS-1。範囲外は無視 (panicしない)。
- パッチ未適用のトラックは無音 (OSC無効)。CPUはアクティブなトラック分のみ消費すること。

- **サンプル精度のイベント**: Worklet 側が 128 フレームのレンダークォンタムをイベント境界で分割し、
  `process(n1); note_on(...); process(n2); ...` のように呼ぶ。DSP側にイベントキューは不要。
- `process()` 内でのアロケーション禁止。ボイス・バッファ・テーブルは `init()` で確保。
- `apply_patch()` は再生中に呼ばれる (ホットリロード)。クリックが出ないよう全パラメータを平滑化
  (one-pole, ~5ms)。カットオフとピッチは対数領域 (cents) で平滑化。
- パニックは `panic = "abort"`。

## 3. パラメータブロック レイアウト

`dsp/src/params.rs` と `web/src/shared/params.ts` に同一の定数を定義済み (この2ファイルが正)。
概要:

| 領域 | ベース | 内容 |
|------|--------|------|
| Global | 0 | POLYPHONY(1-16), GLIDE_S, MASTER_GAIN(linear), SEED(整数値をf32で) |
| Osc A | 8 | ENABLED, TABLE_ID, LEVEL(linear), MORPH(0-1), UNISON(1-7), DETUNE_CENTS, SPREAD(0-1), TUNE_SEMI, TUNE_CENTS, PHASE_RANDOM |
| Osc B | 24 | 同上 |
| Filter | 40 | MODE(0=lp12,1=lp24,2=hp12,3=bp12), CUTOFF_HZ, RES(0-1), DRIVE(0-1), KEYTRACK(0-1) |
| Env amp | 48 | A_S, D_S, S(0-1), R_S (秒) |
| Env filter | 52 | 同上 |
| LFO | 56 | WAVE(0=sine,1=tri,2=saw,3=square), RATE_HZ, PHASE(0-1) |
| Mod slots | 64..95 | 8スロット × [SRC, DST, AMOUNT, 予備] |
| Noise | 96 | ENABLED, LEVEL(linear), COLOR(0=white,1=pink) — ボイス内・フィルタ前でOSCとミックス |
| FX order | 104..111 | エフェクトチェーンの処理順 (エフェクト型ID×8, 0=空)。各型は最大1回 |
| FX params | 112.. | 型ごとに8スロット: base = 112 + (型ID-1)×8。詳細は params.rs / params.ts |

PARAM_COUNT = 192。

**エフェクト型ID**: 1=dist, 2=eq, 3=chorus, 4=phaser, 5=flanger, 6=delay, 7=reverb, 8=mbcomp。
マスターバス (ボイス合算後・ステレオ) に FX order の順で直列適用。
主要パラメータ (詳細・単位は params.rs / params.ts のコメントが正):

| 型 | パラメータ |
|----|-----------|
| dist | DRIVE(0-1), MIX, MODE(0=tanh,1=fold,2=clip), TONE_HZ(ポストLP, 20000=off) |
| eq | LOW_DB, MID_DB, HIGH_DB, MID_FREQ_HZ (低シェルフ120Hz・高シェルフ6kHz固定) |
| chorus | RATE_HZ, DEPTH, MIX |
| phaser | RATE_HZ, DEPTH, FEEDBACK, MIX, STAGES(2-8偶数), CENTER_HZ |
| flanger | RATE_HZ, DEPTH, FEEDBACK, MIX |
| delay | TIME_S(≤2.0), FEEDBACK, MIX, PINGPONG(0/1), TONE_HZ(FB経路LP) |
| reverb | SIZE, DAMP, MIX, PREDELAY_S(≤0.25), WIDTH |
| mbcomp | THRESH_{LOW,MID,HIGH}_DB, RATIO(≥1), ATTACK_S, RELEASE_S, MAKEUP(linear)。クロスオーバー 120Hz/2.5kHz 固定 |

- FXバッファ (ディレイライン・リバーブ等) は `init()` で最大長を確保。`process()` 内アロケーション禁止は不変。
- ノイズは決定性のためシード付きRNG (ボイス/ノートから導出)。pink は白色ノイズのフィルタリングで生成。
- FXのLFO (chorus/phaser/flanger) は `init()` 起点のフリーラン。決定性: init後の同一イベント列で同一出力。

**Modソース enum**: 0=none, 1=env.filter, 2=env.amp, 3=lfo.1, 4=velocity
**Modデスティネーション enum と AMOUNT の単位**:

| DST | 対象 | AMOUNT単位 |
|-----|------|-----------|
| 0 | none | - |
| 1 | filter.cutoff | cents (±) |
| 2 | osc1.morph | 正規化Δ (±1) |
| 3 | osc2.morph | 正規化Δ (±1) |
| 4 | pitch (全osc) | cents (±) |
| 5 | amp (出力ゲイン) | 正規化Δ (±1, 乗算前の加算) |

- LFO のテンポ同期は **TS側で Hz に変換してから** RATE_HZ に書く (BPM変更時は再送)。
- ソース値域: env は 0..1、lfo は -1..1 (バイポーラ)、velocity は 0..1。

## 4. ウェーブテーブル レジストリ

テーブルは Rust 側で `init()` 時にプロシージャル生成 (フレーム長 2048)。TS は名前→IDのマップのみ持つ。

| TABLE_ID | DSL名 | 内容 |
|----------|-------|------|
| 0 | basic/sine | 1フレーム |
| 1 | basic/tri | 1フレーム (加算合成でバンドリミット元波形を作りFFTミップ) |
| 2 | basic/saw | 1フレーム |
| 3 | basic/square | 1フレーム |
| 4 | morph/pwm | 64フレーム: パルス幅 50%→5% |
| 5 | morph/fold | 64フレーム: サインのウェーブフォールド量増加 |

- 各テーブルはロード時に FFT で**オクターブごとのミップマップ**生成 (ナイキスト超の倍音を除去)。
- 再生時: 基本周波数からミップレベル選択、隣接レベル間クロスフェード。サンプル間は Hermite 4点、フレーム間は線形。
- 位相アキュムレータは u32 固定小数点。

## 5. Patch IR (TS内部表現)

パーサの出力。`web/src/dsl/ir.ts` で型定義。**Worklet へは IR を送らず**、TS側で IR → f32 パラメータ
ブロック (`Float32Array(PARAM_COUNT)`) に変換して postMessage する。単位変換は全て TS 側:

- dB → linear (`10^(dB/20)`), `%` → 0..1, kHz → Hz, 音楽的時間 (`1/8`, `2bar`, `1.5beat`) → 秒 or Hz (BPMから)
- ピッチ `st`/`c` → semitones/cents
- 未指定フィールドはデフォルト補完し、「展開済みビュー」を JSON で出力できること

デフォルト値 (展開済みビューにも使用):

```
osc:    { table: basic/saw, level: 0dB, morph: 0, unison: 1, detune: 0c, spread: 0, tune: 0st+0c, phase_random: on }
filter: { type: lp12, cutoff: 20000Hz, res: 0, drive: 0, key_track: 0 }
env.amp:    { a: 5ms, d: 200ms, s: 70%, r: 120ms }
env.filter: { a: 2ms, d: 400ms, s: 0%, r: 100ms }
lfo.1:  { wave: tri, rate: 1Hz, phase: 0 }
voice:  { polyphony: 8, glide: 0ms }
seed: 0, master_gain: -6dB 相当 (ヘッドルーム確保のため 0.5)
noise:  { level: -12dB, color: white }   # noise: セクションがある場合のみ有効
fx:     # fx: リストの並び順 = 処理順。各型は最大1回、最大8個
  dist:    { drive: 0.3, mix: 100%, mode: tanh, tone: 20kHz }
  eq:      { low: 0dB, mid: 0dB, high: 0dB, mid_freq: 1kHz }
  chorus:  { rate: 0.8Hz, depth: 30%, mix: 35% }
  phaser:  { rate: 0.4Hz, depth: 70%, feedback: 30%, mix: 40%, stages: 6, center: 800Hz }
  flanger: { rate: 0.25Hz, depth: 60%, feedback: 50%, mix: 35% }
  delay:   { time: 3/16, feedback: 40%, mix: 25%, pingpong: on, tone: 4kHz }
  reverb:  { size: 60%, damp: 50%, mix: 20%, predelay: 20ms, width: 100% }
  comp:    { thresh_low: -24dB, thresh_mid: -24dB, thresh_high: -24dB, ratio: 3,
             attack: 10ms, release: 120ms, makeup: 0dB }

DSL記法 (v0.2 追加):

```yaml
noise: { level: -12dB, color: pink }

fx:
  - { type: dist,   drive: 0.4, mix: 60% }
  - { type: delay,  time: 3/16, feedback: 45%, mix: 25% }
  - { type: reverb, size: 70%, mix: 20% }
```

- `type:` は dist/distortion, eq, chorus, phaser, flanger, delay, reverb, comp/mbcomp を受理
- `osc: []` (空リスト) はオシレータなし = ノイズ専用パッチ (ハイハット等)。`osc:` 省略時は
  従来通りデフォルトの saw 1基
- ドラムはパッチDSLで合成する (専用音源なし)。例: キック = sine + `mod: env.filter → pitch`
  の高速ピッチ落下 + 短い amp env、ハット = `osc: []` + noise + hp12 + 短い decay
- delay の `time` は絶対時間 (`ms`/`s`) と音楽的時間 (`3/16` 等, BPMから換算) の両対応
- `ratio`, `stages` は裸の数値可。EQゲイン・コンプスレッショルドは dB 必須
- ループ記法の和音 `[C3 Eb3 G3]` は v0.1 から対応済み
```

## 6. Worklet プロトコル (postMessage)

Worklet (`web/public/worklet.js`) は自己完結の plain JS。メッセージ:

```
main → worklet:
  { type: 'load-wasm', bytes: ArrayBuffer }            // worklet内で同期コンパイル+インスタンス化。
                                                       // Module転送はChromeがCOOP/COEPなしでは黙って落とすため不可
  { type: 'patch', track: number, params: Float32Array } // PARAM_COUNT個。wasmメモリに書いて apply_patch(track)
  { type: 'clear-tracks', keep: number }               // track >= keep を無効化 (パッチ削除時)
  { type: 'loop', loop: LoopIR | null }                // null = 停止。次のループ境界を待たず即時差し替え可
  { type: 'transport', playing: boolean }
worklet → main:
  { type: 'ready' }                                    // instance初期化完了 (init(sampleRate)呼び出し済み)
  { type: 'position', samples: number, loopLen: number } // 任意 (UI表示用, ~10Hzスロットル)
```

### Loop IR

```ts
interface LoopIR {
  lengthSamples: number;             // ループ全長 (サンプル)
  events: LoopEvent[];               // offsetSamples 昇順
}
interface LoopEvent {
  offsetSamples: number;             // ループ先頭からのオフセット
  track: number;                     // 0..MAX_TRACKS-1
  kind: 0 | 1;                       // 0 = noteOn, 1 = noteOff
  note: number;                      // MIDIノート番号
  velocity: number;                  // 0..1 (noteOnのみ)
}
```

- **トラック割り当て (v0.3)**: ドキュメント内の ```synth フェンスの出現順がトラックインデックス
  (0..7)。loop フェンスの各行 `id: ...` は同名の synth id に紐付く。未知の id への行はエラー。
  8トラック超のフェンスはエラー。各行のセル数/拍は行ごとに独立に推定 (16セル×1小節=16分音符)。
- 小節/BPM→サンプル変換は **TS側** (`sampleRate` は AudioContext から取得、ハードコード禁止)。
- Worklet はサンプルカウンタでループ位置を管理し、`counter % lengthSamples` でイベントを
  サンプル精度でディスパッチ (レンダークォンタムをイベント境界で分割して process を呼ぶ)。
- `setTimeout`/`setInterval` によるスケジューリング禁止。

## 7. DSL 仕様

要件定義 §3 の通り。パーサ要件:

- コードフェンス info string: ` ```synth id=lead seed=42 ` / ` ```loop id=demo bars=2 bpm=124 `
- 本文は YAMLサブセット (トップレベル `key:`、ネスト1段、フロー記法 `{...}` `[...]`、`- ` リスト)
- **裸の数値はエラー** (0-1 正規化値を明示許可するフィールド除く: res, drive, morph, spread, key_track, s, phase, level系は単位必須)
- エラーは `{ line, col, message }` で返す。エラー時は直前の有効なパッチを維持 (Glicol方式)
- ループ記法: `lead: C3 . Eb3 . | G3 ~ ~ .` — `.`=休符, `~`=タイ, `|`=拍区切り (視覚用・パースでは無視可),
  セル数は `bars * 4 * cellsPerBeat` に自動フィット (1拍のセル数は要素数から推定: 総セル数/(bars*4))。
  `[C3 Eb3 G3]` の和音は対応する (単一セル扱い)。ノート名: `C-1`〜`G9`, `#`/`b` 対応。
- ノート長: 次のノート/休符まで (`~` で延長)。ノートオフはセル末尾 - 1サンプル。

## 8. 検証 (dsp/tests/)

ネイティブターゲット (`cargo test`) で DSP コアをオフライン実行:

1. **決定性**: 同一パッチ+シードで2回レンダリング → バイト単位一致
2. **エイリアス**: saw を高音域 (C7) で鳴らし FFT → 倍音以外のピークが基本波比 -60dB 以下
3. **DC/レベル**: 出力の DC オフセット ~0、ピーク ≤ 1.0
4. **クリック**: note_on/off、apply_patch 急変時にサンプル間差分が閾値以下

## 9. ビルド

- `scripts/build-wasm.sh`: `cargo build --release --target wasm32-unknown-unknown` +
  `RUSTFLAGS="-C target-feature=+simd128"` → `web/public/dsp.wasm` へコピー
- web: `npm run dev` / `npm run build` (Vite)。wasm は `fetch('/dsp.wasm')` (メインスレッド) →
  バイト列を postMessage (transfer) で worklet へ → worklet 内で同期コンパイル。
- `AudioContext` 生成/`resume()` はユーザージェスチャ内。サンプルレートはハードコードしない。
