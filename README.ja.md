# FlowMap

> Swift コードの構造と呼び出し関係をグラフ分析するツールです。AI が生成したコード変更の検証に特に役立ちます。

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

![Overview mode](docs/screenshots/overview.png)

### File Detail モード

![File detail mode](docs/screenshots/file-detail.png)

### Calls モード

![Calls mode](docs/screenshots/calls.png)

## デモ

![FlowMap demo](docs/demo/flowmap-demo.gif)

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

## ライセンス

FlowMap は source-available モデルで提供されています。

**Swift サポート**
- 個人・非商用利用: 無料
- 商用 / チーム / 企業利用: ライセンスが必要

**他言語対応**
今後の追加言語サポートは、別売りの商用プラグインとして提供される可能性があります。

商用利用のお問い合わせ: *(連絡先をここに追記してください)*

## ロードマップ

- Swift 呼び出し解決の精度向上
- extension やプロトコルを含む cross-file ケースの強化
- 追加言語サポート
- diff / impact 可視化の改善
- export / 共有機能の強化

## コントリビューション

Issue と Pull Request を歓迎します。

貢献しやすい領域:

- Swift 解析の edge case
- 呼び出し解決の改善
- グラフレイアウト / 可視化改善
- ドキュメント
- VS Code UX 改善

## ステータス

FlowMap は継続的に進化しています。現バージョンは完成済みプラットフォームではなく、初期段階の実用ツールです。フィードバックと貢献を歓迎します。
