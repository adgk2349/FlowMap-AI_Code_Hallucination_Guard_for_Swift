# FlowMap

> Swift 向けの AST ベース構造・呼び出しグラフ可視化ツールです。特に AI 支援コーディング環境で、実際のコード構造と依存関係を確認するために作られました。

[English](README.md) · [한국어](README.ko.md)

## FlowMap とは

FlowMap は Swift コードを解析し、ファイル・型・関数・呼び出し関係をグラフとして構築し、VS Code 上で可視化する開発者向けツールです。

たとえば次のような疑問に答えるために使えます。

- この関数は実際にどこから呼ばれているのか
- このファイルを変更するとどこまで影響が広がるのか
- AI が生成したコードは見た目だけ正しくて、実際の依存関係は壊れていないか
- プロジェクト全体の構造を一目で把握できないか

FlowMap はコンパイラの代替ではなく、**実用的なワークスペースレベルの解析・可視化ツール**です。

## 現在の機能

- SwiftSyntax による Swift AST 解析
- ファイル / 型 / 関数グラフ生成
- 同一ファイル内呼び出し + 保守的な cross-file 呼び出しリンク
- 変更グラフ(diff)解析
- 呼び出しグラフに基づく影響範囲解析
- VS Code 可視化モード
  - **Overview** — プロジェクト / フォルダ / ファイル構造
  - **File Detail** — ファイル内部の型 / 関数探索
  - **Calls** — 呼び出しクラスタ探索
- 保存時の自動解析
- 基本的な source-available ライセンス基盤

## なぜ作ったのか

LLM が生成したコードは、それっぽく見えても構造的に正しいとは限りません。

FlowMap はコードの実際の関係を見える化し、単に「もっともらしいコード」ではなく、**本当に繋がっているコードかどうか**を確認しやすくするために作られました。

## スクリーンショット

リポジトリを public にしたあと、ここに実際の画像を追加してください。

### Overview モード

![Overview mode](docs/screenshots/overview.png)

### File Detail モード

![File detail mode](docs/screenshots/file-detail.png)

### Calls モード

![Calls mode](docs/screenshots/calls.png)

## デモ GIF

短いデモ GIF をここに追加してください。

![FlowMap demo](docs/demo/flowmap-demo.gif)

おすすめのデモ手順:

1. Swift ワークスペースを開く
2. **FlowMap: Analyze Workspace** を実行
3. Overview モードを表示
4. File Detail に入る
5. Calls モードへ切り替える
6. ファイル編集後に changed / impact 表示を見せる

## 仕組み

FlowMap は主に 3 層で構成されています。

- **Swift パーサ**: 宣言情報と call-site 情報を抽出
- **Rust エンジン**: グラフ生成、保守的な cross-file 呼び出し解決、diff / impact 計算
- **VS Code 拡張**: Overview / Detail / Calls の表示と更新

## 現バージョンの呼び出し解決範囲

現在の FlowMap は次のような Swift 呼び出しを保守的に解決します。

- `foo()`
- `TypeName.method()`
- `self.method()`

候補が複数あって曖昧な場合は、推測せずにリンクを作りません。

## インストール

### 前提

- 現在の Swift パーサワークフローでは macOS 推奨
- Rust toolchain
- Swift toolchain / Xcode command line tools
- Node.js
- VS Code

### ビルド

リポジトリのルートで:

```bash
cargo build
```

VS Code 拡張ディレクトリで:

```bash
npm install
npm run compile
```

### VS Code で実行

1. VS Code 拡張フォルダを VS Code で開く
2. `F5` で Extension Development Host を起動
3. 新しい VS Code ウィンドウで Swift ワークスペースを開く
4. **FlowMap: Analyze Workspace** を実行
5. **FlowMap Graph** を開く

## ロードマップ

- Swift 解決精度の向上
- extension などの cross-file ケース強化
- 追加言語プラグイン対応
- export / 共有機能の改善
- diff / impact 表示の強化

## ライセンス

FlowMap は現在 source-available モデルを採用しています。

### Swift サポート

- 個人 / 非商用利用: 無料
- 商用 / チーム / 企業利用: ライセンスが必要

### 他言語

今後の追加言語サポートは、別売りの商用プラグインとして提供される可能性があります。

商用利用の問い合わせ先はここに追記してください。

## コントリビューション

Issue と Pull Request を歓迎します。

貢献しやすい領域:

- Swift 解析の edge case
- 呼び出し解決の改善
- グラフレイアウト / 可視化改善
- ドキュメント
- VS Code UX 改善

## ステータス

FlowMap は現在も継続的に進化中です。現時点の公開版は完成済みプラットフォームというより、非常に意欲的に発展中の初期ツールと捉えるのが適切です。

## 公開後に追加するファイル

リポジトリを public にした後、次のファイルを追加してください。

- `docs/screenshots/overview.png`
- `docs/screenshots/file-detail.png`
- `docs/screenshots/calls.png`
- `docs/demo/flowmap-demo.gif`

