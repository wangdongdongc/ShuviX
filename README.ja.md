<img src="https://gw.alipayobjects.com/zos/antfincdn/R8sN%24GNdh6/language.svg" width="18"> 日本語 | [简体中文](./README.md) | [English](./README.en.md)

<div align="center">

# ShuviX

🤖 AI を日常のワークフローに統合するデスクトップ AI アシスタント。

<img src="./resources/icon_mini.jpg" width="180" alt="ShuviX Logo">

[![version](https://img.shields.io/badge/version-0.1.0-blue?style=flat-square)](https://github.com/wangdongdongc/ShuviX/releases)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square)](#-ビルド)
[![Electron](https://img.shields.io/badge/Electron-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)

<p>
  <a href="https://github.com/wangdongdongc/ShuviX">
    <img src="https://img.shields.io/badge/GitHub-000000?style=for-the-badge&logo=github&logoColor=white" alt="GitHub" />
  </a>
  <a href="./docs/">
    <img src="https://img.shields.io/badge/Docs-722ED1?style=for-the-badge" alt="Docs" />
  </a>
  <a href="https://github.com/wangdongdongc/ShuviX/releases">
    <img src="https://img.shields.io/badge/Releases-2F54EB?style=for-the-badge" alt="Releases" />
  </a>
  <a href="https://github.com/wangdongdongc/ShuviX/issues">
    <img src="https://img.shields.io/badge/Issues-FA8C16?style=for-the-badge" alt="Issues" />
  </a>
</p>

</div>

**ShuviX** はデスクトップ AI アシスタントです。主要な大規模言語モデルに接続し、エージェントツールチェーンを通じてローカルファイルやターミナルを直接操作できます。AI を真のパートナーにしましょう。

## ✨ 特徴

- 🔄 **マルチモデル切り替え** — 主要な大規模言語モデルに接続し、自由に切り替え可能
- 🛠️ **エージェントツールチェーン** — ファイル読み書き、ターミナル実行、コード検索などのコアツールを内蔵
- 📁 **プロジェクトサンドボックス** — AI のアクセスをプロジェクトディレクトリ内に制限可能。シェルコマンドはユーザーの承認後に実行
- 🐳 **Docker 分離** — コマンド実行を Docker コンテナ内に分離し、ホスト環境を保護するオプション
- 💾 **ローカルファースト** — すべてのデータはローカル SQLite に保存、プライバシーを完全保護

## 🚀 クイックスタート

```bash
# 依存関係のインストール
npm install

# 開発サーバーの起動
npm run dev
```

## 📦 ビルド

```bash
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

## 📄 ライセンス

本プロジェクトは **MIT** ライセンスの下でオープンソースです。
