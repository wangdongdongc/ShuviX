<img src="https://gw.alipayobjects.com/zos/antfincdn/R8sN%24GNdh6/language.svg" width="18"> English | [简体中文](./README.md) | [日本語](./README.ja.md)

<div align="center">

# ShuviX

🤖 Your desktop AI assistant that truly integrates AI into your daily workflow.

<img src="./resources/icon_mini.jpg" width="180" alt="ShuviX Logo">

[![version](https://img.shields.io/badge/version-0.1.0-blue?style=flat-square)](https://github.com/wangdongdongc/ShuviX/releases)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square)](#-build)
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

**ShuviX** is a desktop AI assistant. Connect to mainstream LLMs and operate local files and terminal directly through an agentic toolchain — making AI your true partner.

## ✨ Features

- 🔄 **Multi-model switching** — Connect to mainstream LLMs and switch between them freely
- 🛠️ **Agentic toolchain** — Built-in tools for file I/O, terminal execution, code search, and more
- 📁 **Project sandbox** — Restrict AI access to project directories only; shell commands require user approval before execution
- 🐳 **Docker isolation** — Optionally isolate command execution in Docker containers to protect the host environment
- 💾 **Local-first** — All data stored in local SQLite, your privacy is fully protected

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start dev server
npm run dev
```

## 📦 Build

```bash
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

## 📄 License

This project is open source under the **MIT** license.
