# ShuviX

你的桌面 AI 编程助手。连接主流大模型，通过智能体工具链直接操作本地文件和终端，让 AI 真正融入你的开发工作流。

## 特性

- **多模型自由切换** — 支持
- **智能体工具链** — 内置核心工具
- **项目沙箱** — 可限制 AI 仅访问项目目录内的文件，Shell 命令需经用户审批后执行
- **Docker 隔离** — 可选将命令执行隔离到 Docker 容器中，保护主机环境安全
- **本地优先** — 所有数据存储在本地 SQLite

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

## 构建

```bash
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

## 技术文档

详细的技术架构和设计文档见 [docs/](./docs/) 目录。

## License

MIT
