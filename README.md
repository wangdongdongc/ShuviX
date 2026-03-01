<img src="https://gw.alipayobjects.com/zos/antfincdn/R8sN%24GNdh6/language.svg" width="18"> 简体中文 | [English](./README.en.md) | [日本語](./README.ja.md)

<div align="center">

# ShuviX

🤖 你的桌面 AI 助手，让 AI 真正融入你的日常工作。

<img src="./resources/icon_mini.jpg" width="180" alt="ShuviX Logo">

[![version](https://img.shields.io/badge/version-0.1.0-blue?style=flat-square)](https://github.com/wangdongdongc/ShuviX/releases)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square)](#-构建)
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

**ShuviX** 是一款桌面端 AI 助手。连接主流大模型，通过智能体工具链直接操作本地文件和终端，让 AI 成为你的真正搭档。

## ✨ 特性

- 🔄 **多模型自由切换** — 支持接入主流大语言模型，随时切换
- 🛠️ **智能体工具链** — 内置文件读写、终端执行、代码搜索等核心工具
- 📁 **项目沙箱** — 可限制 AI 仅访问项目目录内的文件，Shell 命令需经用户审批后执行
- 🐳 **Docker 隔离** — 可选将命令执行隔离到 Docker 容器中，保护主机环境安全
- 💾 **本地优先** — 所有数据存储在本地 SQLite，隐私无忧

## 🖼️ 界面预览

> 提供简洁的对话界面，集成 Markdown 渲染、代码高亮与工具调用可视化，让每一次交互都清晰可控。

<div align="center">
<img src="./resources/shuivx-demo-basic.jpeg" width="680" alt="ShuviX 界面预览">
</div>

## 🚀 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

## 📦 构建

```bash
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

## 📄 License

本项目基于 **MIT** 许可证开源。
