# Sheliak

Markdownベース作曲システムの第一歩 — Wavetable WASM Synth MVP。

`.md` のコードフェンスに書いたシンセDSLをパースし、Rust製DSPコア (WASM) を
AudioWorklet で駆動してブラウザで音を鳴らす。

- 要件定義: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)
- 統合仕様 (Patch IR / WASM ABI / パラメータレイアウト): [docs/SPEC.md](docs/SPEC.md)
- ノート層仕様 (phrase / loop / 操作セット): [docs/SPEC-NOTES.md](docs/SPEC-NOTES.md)

## ビルドと実行

前提: Rust (`wasm32-unknown-unknown` ターゲット), Node.js 20+

```sh
# 1. DSPコアを WASM にビルドして web/public/dsp.wasm へ配置
./scripts/build-wasm.sh

# 2. フロントエンド
cd web
npm install
npm run dev        # 開発サーバ
npm run build      # プロダクションビルド
```

## テスト

```sh
# DSPコア (決定性 / エイリアス / DC / クリックテスト。ネイティブターゲットで実行)
cargo test --manifest-path dsp/Cargo.toml

# DSLパーサ (vitest)
cd web && npm test
```

## 構成

```
dsp/      Rust DSPコア (wasm32-unknown-unknown, raw export, wasm-bindgen不使用)
web/      Vite + TS: DSLパーサ, AudioWorkletグルー, UI
scripts/  ビルドスクリプト
docs/     要件定義・統合仕様
```
