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
  <a href="https://github.com/wangdongdongc/ShuviX/releases/latest">
    <img src="https://img.shields.io/badge/Download-Latest-13B84A?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjEgMTV2NGEyIDIgMCAwIDEtMiAySDVhMiAyIDAgMCAxLTItMnYtNCIvPjxwb2x5bGluZSBwb2ludHM9IjcgMTAgMTIgMTUgMTcgMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNSIgeDI9IjEyIiB5Mj0iMyIvPjwvc3ZnPg==&logoColor=white" alt="Download" />
  </a>
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

## 🖼️ Preview

> A clean conversational interface with Markdown rendering, syntax highlighting, and tool call visualization — every interaction is clear and controllable.

<div align="center">
<img src="./resources/shuivx-demo-basic.jpeg" width="680" alt="ShuviX Preview">
</div>

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
