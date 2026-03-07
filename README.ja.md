> **Public Beta お知らせ（2026年3月8日）:** FlowMap は Public Beta 段階です。ライセンス検証は現在ローカル/開発用プレビューであり、本番向けサーバー側の強制検証は未実装です。

# FlowMap

> Swift コードの構造と呼び出し関係をグラフ分析するツールです。AI が生成したコード変更の検証に特に役立ちます。

[![CI](https://github.com/adgk2349/FlowMap/actions/workflows/ci.yml/badge.svg)](https://github.com/adgk2349/FlowMap/actions/workflows/ci.yml)

[English](README.md) · [한국어](README.ko.md)

## FlowMap とは

FlowMap は Swift コードを解析し、ファイル・型・関数・呼び出し関係をワークスペース全体のグラフとして構築し、VS Code 上で視覚的に探索できる開発者ツールです。

たとえば次のような疑問に答えるために使えます。

- この関数は実際にどこから呼ばれているのか
- このファイルを変更するとどこまで影響が広がるのか
- AI が生成したコードは見た目上は正しそうだが、実際の構造は問題ないか
- このプロジェクト全体はどのような構成になっているのか

FlowMap はコンパイラの代替ではありません。実際のコード構造をワークスペースレベルで見える化し、関係を直接確認できる実用的な解析ツールです。

## こんな方に

- AI 支援コーディングツールを使っていて、何が実際に変わったかを確認したい開発者
- 慣れていない Swift コードベースをレビューするエンジニア
- ビルドなしに Swift プロジェクトの全体構造を把握したい方

## 現在の機能

- SwiftSyntax による Swift AST 解析
- ファイル / 型 / 関数グラフ生成
- 同一ファイル内呼び出し + 保守的なワークスペース全体の cross-file 呼び出しリンク
- 変更ファイル単位のグラフ diff
- 呼び出しエッジに基づく影響範囲解析
- VS Code 可視化 3 モード:
  - **Overview** — プロジェクト / フォルダ / ファイル構造
  - **File Detail** — ファイル内の型・関数探索
  - **Calls** — 呼び出しクラスタ探索
- 保存時の自動再解析

## スクリーンショット

### Overview モード

![Overview mode](docs/screenshots/overview.jpg)

### File Detail モード

![File detail mode](docs/screenshots/file-detail.jpg)

### Calls モード

![Calls mode](docs/screenshots/calls.jpg)

## インストール

### 前提条件

- macOS（Swift パーサの実行に必要）
- Rust toolchain（[rustup.rs](https://rustup.rs)）
- Swift toolchain / Xcode command line tools
- Node.js v20 以上
- VS Code

### ビルド

**1. リポジトリをクローン**

```bash
git clone https://github.com/adgk2349/FlowMap.git
cd FlowMap
```

**2. Rust エンジンをビルド**

```bash
cargo build
```

**3. Swift パーサをビルド**

```bash
cd parsers/swift-ast
swift build -c release
cd ../..
```

**4. VS Code 拡張をコンパイル**

```bash
cd editor/vscode
npm install
npm run compile
cd ../..
```

### VS Code で実行

1. `editor/vscode` フォルダを VS Code で開く
2. `F5` で Extension Development Host を起動
3. 新しい VS Code ウィンドウで Swift ワークスペースを開く
4. コマンドパレットから **FlowMap: Analyze Workspace** を実行する（`Cmd+Shift+P`）
5. **FlowMap Graph** パネルを開く

## 使い方

1. VS Code で Swift ワークスペースを開く
2. コマンドパレットから **FlowMap: Analyze Workspace** を実行する
3. グラフを探索する:
   - **Overview** — プロジェクト全体の構造を俯瞰
   - **File Detail** — ファイルをクリックして型・関数を詳しく探索
   - **Calls** — 呼び出しクラスタと関数のつながりを追跡
4. ファイルを保存すると自動的に再解析される

## 検証方法

FlowMap には、実際の Git コミットペアをリプレイし、graph diff の検出方向が期待どおりかを確認する自動検証が含まれています。

- コミットリプレイ runner: `scripts/run_commit_replay.mjs`
- シナリオ runner（合成回帰セット）: `scripts/run_sample_scenarios.mjs`
- リプレイ要約 builder: `scripts/build_replay_summary.mjs`
- 詳細検証レポート builder: `scripts/build_validation_detail.mjs`

例:

```bash
node scripts/run_commit_replay.mjs \
  --repo /path/to/swift-repo \
  --count 100 \
  --report reports/replay-100.json
```

現在の統合検証アウトプット:

- `reports/replay-validation-bundle.md`
- `reports/replay-validation-bundle.json`
- `reports/sample-scenarios-report.json`
- `reports/public-beta-validation-detail.md`
- `reports/public-beta-validation-detail.json`

最新の統合メトリクス（`reports/replay-validation-bundle.md`）:

- コミットペア総数: 209
- TP / TN / FP / FN: 106 / 97 / 0 / 6
- Non-Swift FP Rate: 0%
- Swift Detection Rate: 94.64%
- Overall Match Rate: 97.13%

最新シナリオ回帰検証（`reports/sample-scenarios-report.json`）:

- シナリオ数: 60
- Passed / Failed: 60 / 0
- FP / FN 合計: 0 / 0

Public Beta 詳細検証（`reports/public-beta-validation-detail.md`）:

- 非パスケースをコミット単位で記録
- Public beta gate: PASS

## ライセンス

FlowMap は現在 **Public Beta** 段階です。

最終的なライセンス条件（商用条件を含む）は、ベータ終了後に告知します。

それまでは著者がすべての権利を保持し、Public Beta の評価目的での利用のみ許可されます。

商用利用または再配布については: adgk2349b@gmail.com

## ロードマップ

- Swift 呼び出し解決の精度向上
- extension やプロトコルを含む cross-file ケースの強化
- 追加言語サポート
- diff / impact 可視化の改善
- export / 共有機能の強化

## コントリビューション

Issue と Pull Request を歓迎します。

- コントリビューションガイド: [CONTRIBUTING.md](CONTRIBUTING.md)
- 初回向けタスク一覧: [docs/good-first-issues.md](docs/good-first-issues.md)
- Issue / PR は `.github` のテンプレートを利用してください

貢献しやすい領域:

- Swift 解析の edge case
- 呼び出し解決の改善
- グラフレイアウト / 可視化改善
- ドキュメント
- VS Code UX 改善

## ステータス

FlowMap は現在 **Public Beta** です。

- コアのグラフ/差分パイプラインは外部テスト可能な安定度に到達しています。
- 検証成果物は `reports/` に公開し、透明性を確保しています。
- Swift 呼び出し解決の一部 edge case は継続改善中です。
