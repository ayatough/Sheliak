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
そのまま鳴らせます。これは**最新リリース**（タグ）のビルドです。`main` の先端は
**<https://ayatough.github.io/Sheliak/next/>** に「作業中」と明示して並べて公開され、
検索エンジンには `noindex` を返します。どちらも CI が緑になってからデプロイされます。

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

コマンドライン。clone も Rust ツールチェーンも不要で、Node.js 20 以降だけ:

```bash
curl -fsSL https://raw.githubusercontent.com/ayatough/Sheliak/main/scripts/install.sh | sh

sheliak new song.md      # 音が鳴る最小の曲を書き出す
sheliak check song.md    # ブラウザと同じ compile() で検査し、行:列 で報告
```

`~/.local/bin` に入り、DSP コアとアプリも一緒に置かれるので全コマンドが動きます。
**取得先の Release が必要で、まだ1つもありません** — 最初のタグを打つまでは
`npx github:ayatough/Sheliak`（`new` / `check` / `fmt` は動きますが、エンジンを
同梱していないので `render` と `serve` は動きません）か、作業コピーを使ってください。

tarball は全プラットフォーム共通で1つです。CLI は JavaScript バンドル、`dsp.wasm` は
wasm、アプリは静的ファイルで、プラットフォーム依存の部分がないためです。

作業コピーからは `npm install && npm link` でも同じコマンドが入ります。
`npm install -g <git url>` だけは動きません（グローバルインストールでは npm が
`prepare` の前に依存を入れないため）。

`fmt` は phrase グリッドを正規化します。ビート定規・行順・グループタグ・小節線・
ラベル幅はすべて**導出**されるので、手書きの定規がグリッドと食い違うことがなくなります。
phrase の外（散文・synth フェンス・コメント・整列）はバイト単位でそのまま残ります。
`--check` は書き込まず、変わる箇所があれば非ゼロで終了します（`cargo fmt --check` と同じ用途）。

`render` はループを WAV に書き出します。ブラウザと同じ wasm・同じサンプル精度の
スケジューリングを使うので、鳴っていたものがそのままファイルになります:

```bash
sheliak render song.md -o song.wav --loops 4 --tail 2s
sheliak render song.md --stems          # song.wav ＋ song.lead.wav / song.bass.wav …
```

`--stems`（パラアウト）はトラックごとに1ファイル書き出します。各トラック自身の
エフェクトチェーンを通した後・合算する前でタップしているので、**ステムの総和は
ミックスと完全に一致**します（16bit ファイルでは各々を独立に丸めるため最下位ビット
1つ以内、浮動小数点ではサンプル単位で厳密に一致。テストで固定しています）。

インストール版は DSP コアを同梱しています。作業コピーからは先に
`./scripts/build-wasm.sh`（cargo の成果物なので npm では作れません）が必要です。

`serve` はコピペを消すコマンドです。自分のファイルを開いた状態でアプリが立ち上がり、
**エディタで保存すると再生を止めずに鳴り直し**、GUI（ステップシーケンサ・パラメータパネル）の
操作は同じファイルに書き戻されます。曲が住んでいる場所がブラウザのタブではなくファイルになります。

```bash
sheliak serve song.md          # http://localhost:4321
```

ビルド済みのアプリを素の HTTP サーバで配ります（バンドラもリポジトリも不要）。
インストール版はそれを同梱しています。作業コピーからは `cd web && npm run build`、
あるいは `./scripts/sheliak` が自動でビルドします。

作業コピー内では `./scripts/sheliak` が編集中のソースを使い、古ければ自動で再ビルドします。

`new` は `synth` フェンス1つ・`phrase` 1つ・両者を結ぶ `loop` だけを書きます。既存の
ファイルを上書きすることはありません。`check` はエラーがあれば非ゼロで終了するので CI に
かけられ、コンパイルが通っても鳴らないもの——どの `loop` 行にも束ねられていないトラックと、
どこからも参照されない `phrase`——は警告として報告します。

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
