# ShuviX 技术架构

## 概述

ShuviX 是一个桌面 AI 智能体应用，基于 Electron + React + TypeScript 构建，集成 pi-agent-core 实现多模型 Agent 能力。支持多提供商/多模型切换、工具调用、项目沙箱、Docker 隔离等特性。

## 技术栈

| 层级       | 技术                                |
| ---------- | ----------------------------------- |
| 桌面运行时 | Electron                            |
| 前端框架   | React 19 + TypeScript               |
| 构建工具   | electron-vite (Vite)                |
| 样式方案   | Tailwind CSS v4                     |
| 状态管理   | Zustand                             |
| LLM 集成   | @mariozechner/pi-ai + pi-agent-core |
| 数据持久化 | SQLite (better-sqlite3)             |
| 国际化     | i18next（zh / en / ja）             |
| 包管理器   | npm                                 |

## 项目结构

```
src/
├── main/                              # Electron 主进程
│   ├── index.ts                       # 应用入口，窗口管理
│   ├── i18n.ts                        # 主进程国际化
│   ├── types/                         # 共享类型定义
│   │   ├── session.ts / message.ts    # 会话 / 消息类型
│   │   ├── provider.ts               # 提供商 / 模型类型
│   │   └── agent.ts                  # Agent 参数类型
│   ├── dao/                           # 数据访问层
│   │   ├── database.ts               # SQLite 连接 + 表结构
│   │   ├── sessionDao.ts             # 会话 CRUD
│   │   ├── messageDao.ts             # 消息 CRUD
│   │   ├── projectDao.ts             # 项目 CRUD
│   │   ├── providerDao.ts            # 提供商 / 模型 CRUD
│   │   ├── settingsDao.ts            # 设置 KV 存储
│   │   └── httpLogDao.ts             # API 请求日志
│   ├── services/                      # 业务逻辑层
│   │   ├── agent.ts                  # Agent 服务（核心）
│   │   ├── dockerManager.ts          # Docker 容器管理
│   │   ├── litellmService.ts         # LiteLLM 模型发现
│   │   ├── providerService.ts        # 提供商管理
│   │   ├── sessionService.ts         # 会话业务
│   │   ├── messageService.ts         # 消息业务
│   │   ├── projectService.ts         # 项目业务
│   │   └── providerCompat.ts         # 自定义提供商兼容层
│   ├── tools/                         # Agent 工具集
│   │   ├── now.ts                    # 获取当前时间
│   │   ├── bash.ts                   # Shell 命令执行
│   │   ├── read.ts                   # 文件读取（含富文本转换）
│   │   ├── write.ts                  # 文件写入
│   │   ├── edit.ts                   # 文件编辑（精确替换）
│   │   └── types.ts                  # 工具上下文 / 项目配置
│   └── ipc/                           # IPC 通信层
│       ├── handlers.ts               # 统一注册入口
│       ├── agentHandlers.ts          # agent:* 通道
│       ├── sessionHandlers.ts        # session:* 通道
│       └── ...                       # 其他模块通道
│
├── preload/                           # 预加载脚本
│   ├── index.ts                      # contextBridge → window.api
│   └── index.d.ts                    # API 类型定义
│
├── renderer/                          # 渲染进程（React）
│   └── src/
│       ├── App.tsx                   # 根组件 + Agent 事件监听
│       ├── stores/
│       │   ├── chatStore.ts          # 聊天状态
│       │   └── settingsStore.ts      # 设置状态
│       └── components/
│           ├── Sidebar.tsx           # 侧边栏（会话 / 项目管理）
│           ├── ChatView.tsx          # 聊天主视图
│           ├── MessageBubble.tsx     # 消息气泡（Markdown 渲染）
│           ├── InputArea.tsx         # 输入区（模型切换 / 图片上传）
│           ├── ToolCallBlock.tsx     # 工具调用展示（含审批 UI）
│           ├── PayloadViewer.tsx     # API 请求日志查看器
│           ├── ProjectCreateDialog.tsx  # 新建项目
│           ├── ProjectEditDialog.tsx    # 编辑项目
│           └── SettingsPanel.tsx     # 设置面板
│
└── shared/                            # 前后端共享
    └── i18n/locales/                 # 国际化资源
        ├── zh.json / en.json / ja.json
```

## 架构分层

```
Renderer (React + Zustand)
  │  window.api.*
  ▼
Preload (contextBridge)
  │  ipcRenderer.invoke / on
  ▼
IPC Layer                    ← 参数解析，路由分发
  │
  ▼
Service Layer                ← 业务逻辑，编排 DAO + 外部服务
  │
  ├──▶ DAO Layer             ← 纯 SQL 操作 → SQLite
  ├──▶ Agent (pi-agent-core) ← LLM 调用 + 工具循环
  └──▶ Docker Manager        ← 可选容器隔离
```

**分层原则**：

- **IPC** — 只做参数解构和路由，不含业务逻辑
- **Service** — 编排跨 DAO 操作，处理业务规则
- **DAO** — 一方法一 SQL，不调用其他 DAO
- **Tools** — 通过 `ToolContext` 获取运行时上下文，支持沙箱模式

## 核心特性

### Agent 工具集

内置 5 个工具，覆盖编码场景：

| 工具    | 功能                                                     |
| ------- | -------------------------------------------------------- |
| `now`   | 获取当前系统时间                                         |
| `bash`  | 执行 Shell 命令（沙箱模式下需审批）                      |
| `read`  | 读取文件（支持 PDF/Office/HTML 等富文本自动转 Markdown） |
| `write` | 创建 / 覆写文件                                          |
| `edit`  | 精确文本替换                                             |

### 文件读取能力

`read` 工具通过 markitdown-ts + word-extractor 支持多种格式：

- **Markdown 转换**：PDF、DOCX、XLSX、PPTX、HTML、IPYNB、ZIP
- **纯文本提取**：DOC（旧版 Word）
- **二进制检测**：已知二进制格式直接拒绝 + 未知格式 NULL 字节检测

详见 [read-tool-file-extraction.md](./read-tool-file-extraction.md)

### 沙箱模式

项目级安全沙箱：

- `read`/`write`/`edit` — 路径越界检查，禁止访问工作区外文件
- `bash` — 内联审批卡片，用户点击允许/拒绝
- 临时会话自动开启沙箱，工作目录隔离

详见 [sandbox-mode-design.md](./sandbox-mode-design.md)

### 多提供商支持

- 内置 OpenAI / Anthropic / Google / DeepSeek / 月之暗面 等主流提供商
- 通过 LiteLLM 自动发现模型能力（vision / reasoning / function calling）
- 支持自定义提供商（兼容 OpenAI API 协议）
- 会话级模型切换，不同会话可用不同模型

### Docker 隔离（可选）

可为项目配置 Docker 容器，bash 命令在容器内执行，实现完全隔离。

## 数据存储

SQLite 数据库路径：`~/Library/Application Support/shuvix/data/shuvix.db`

核心表：`sessions`、`messages`、`projects`、`providers`、`provider_models`、`settings`、`http_logs`

使用 WAL 模式，每个会话独立维护 provider/model 字段。

## 开发

```bash
npm install       # 安装依赖
npm run dev        # 启动开发服务器
npm run typecheck  # 类型检查
```

## 构建

```bash
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```
