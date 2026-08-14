<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/brand/sheliak-banner-dark.svg">
  <img alt="Sheliak — songs that live in your repository" src="../../assets/brand/sheliak-banner-light.svg">
</picture>

# Sheliak（日本語）

> このディレクトリは日本語話者向けの補助資料です。**正式なドキュメントは英語版**で、
> 内容が食い違う場合は英語版が正です。
>
> [README](../../README.md) · [記法](../syntax.md) · [アーキテクチャ](../architecture.md) · [開発ガイド](../development.md) · [ロードマップ](../roadmap.md) · [作業ストリーム](../workstreams.md) · [エージェント向け](../../AGENTS.md) · [ブランド](../../assets/brand/README.md)

## 一言でいうと

**リポジトリの中で暮らす曲。** シンセのパッチとノートを Markdown のコードフェンスに書くと、
WebAssembly にコンパイルされた Rust 製 DSP コアがブラウザで鳴らします。編集は再生を止めずに
反映され、同じドキュメントと同じシードからはどの環境でもビット単位で同じ音が出ます。

DAW はプロジェクトファイルが不透明なバイナリで、差分も取れずマージもレビューもできません。
一方テキストベースの音楽言語は差分が取れますが、それは*プログラム*であって、状態はインタプリタ
の側にあり、GUI で回したノブの行き先がありません。Sheliak はその両方を狙っています。
**ドキュメントが状態の全体**であり、隠れたモデルは存在しません。

## 動かす

**公開版: <https://ayatough.github.io/Sheliak/>** — インストール不要でブラウザから
そのまま鳴らせます。`main` で CI が通ったあとに自動で更新されます。

手元で動かす場合は Rust（`wasm32-unknown-unknown` ターゲット）と Node.js 20 以降が必要です。

```bash
./scripts/build-wasm.sh     # DSPコア → web/public/dsp.wasm
cd web && npm install
npm run dev
```

テスト:

```bash
cargo test --manifest-path dsp/Cargo.toml   # 決定性・エイリアス・DC・クリック
cd web && npm test                          # パーサ・GUI・wasm 結合テスト
```

## このディレクトリの中身

英語版が整備される前に日本語で書かれた設計資料です。翻訳ではなく原文なので、
細部は英語版のほうが新しい場合があります。

| ファイル | 内容 | 英語版 |
|---|---|---|
| [architecture.md](architecture.md) | 統合仕様（WASM ABI・パラメータレイアウト・Worklet プロトコル） | [../architecture.md](../architecture.md) |
| [requirements.md](requirements.md) | MVP の要件定義（ゴール・非ゴール・DSP 要件） | [../roadmap.md](../roadmap.md) |
| [notation.md](notation.md) | ノート層の再設計（phrase グリッド・グループ・カスケード・操作セット） | [../workstreams.md](../workstreams.md) |

## 開発の進め方

`main` が作業ブランチです。作者ひとりと AI アシスタントで開発しているため、プルリクエストを
待つ第二の読み手がおらず、ブランチに置いておくと唯一の実質的なレビュー——デプロイされたアプリ
を開いて再生ボタンを押すこと——が遅れるだけだからです。

ただし品質ゲート（Rust のテスト・clippy・フォーマット・wasm ビルド・型チェック・web のテスト）は
`main` への push でも毎回走ります。`main` が作業ブランチであることは、壊れていてよいという意味
ではなく、いつ変わってもおかしくないという意味です。

詳細は [CONTRIBUTING.md](../../CONTRIBUTING.md) と [AGENTS.md](../../AGENTS.md) を参照してください。
