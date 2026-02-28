# ShuviX — AI Agent 桌面助手

## 项目概述

ShuviX 是一个基于 Electron 的桌面 AI 助手，支持多模型切换（OpenAI / Anthropic / Google）、内置 Agentic 工具链（文件读写、终端执行、代码搜索等）、项目沙箱隔离、Docker 容器化执行，所有数据本地存储于 SQLite。

## 技术栈

| 层       | 技术                                                         |
| -------- | ------------------------------------------------------------ |
| 框架     | Electron 39 + electron-vite                                  |
| 渲染进程 | React 19 + TypeScript 5.9                                    |
| 样式     | Tailwind CSS 4（`@tailwindcss/vite` 插件）                   |
| 状态管理 | Zustand 5（`useChatStore` + `useSettingsStore`）             |
| 数据库   | better-sqlite3（WAL 模式）                                   |
| AI 核心  | `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`        |
| MCP      | `@modelcontextprotocol/sdk`                                  |
| 包管理   | **npm**（非 pnpm/yarn），`postinstall` 含 `electron-rebuild` |
| i18n     | i18next（中/英/日三语）                                      |
| 图标     | lucide-react                                                 |
| Markdown | react-markdown + remark-gfm + rehype-highlight               |
| 虚拟滚动 | react-virtuoso                                               |

## 目录结构

```
src/
├── main/                    # Electron 主进程
│   ├── index.ts             # 入口：窗口创建、菜单、IPC 注册、服务启动
│   ├── dao/                 # 数据访问层（better-sqlite3 封装）
│   │   ├── database.ts      # DB 连接管理、建表、迁移、种子数据
│   │   ├── sessionDao.ts    # 会话 CRUD
│   │   ├── messageDao.ts    # 消息 CRUD
│   │   ├── projectDao.ts    # 项目 CRUD
│   │   ├── providerDao.ts   # 模型提供商 + 模型 CRUD
│   │   ├── settingsDao.ts   # K-V 设置表
│   │   ├── mcpDao.ts        # MCP Server 配置
│   │   └── httpLogDao.ts    # HTTP 请求日志
│   ├── services/            # 业务逻辑层
│   │   ├── agent.ts         # ★ 核心：Agent 实例管理、消息转换、指令文件注入、事件转发
│   │   ├── sessionService.ts
│   │   ├── messageService.ts
│   │   ├── projectService.ts
│   │   ├── providerService.ts   # 提供商管理 + LiteLLM 能力补充
│   │   ├── litellmService.ts    # 远程拉取模型能力数据
│   │   ├── contextManager.ts    # 上下文窗口管理
│   │   ├── dockerManager.ts     # Docker 容器生命周期管理
│   │   ├── mcpService.ts        # MCP Server 连接管理 + 工具注册
│   │   ├── skillService.ts      # 自定义 Skill（Markdown 脚本）管理
│   │   ├── settingsService.ts
│   │   ├── httpLogService.ts
│   │   ├── providerCompat.ts    # 自定义提供商兼容层
│   │   └── storage.ts           # 路径常量
│   ├── ipc/                 # IPC 处理器（主进程侧）
│   │   ├── handlers.ts      # 统一注册入口
│   │   ├── agentHandlers.ts
│   │   ├── sessionHandlers.ts
│   │   ├── messageHandlers.ts
│   │   ├── projectHandlers.ts
│   │   ├── providerHandlers.ts
│   │   ├── settingsHandlers.ts
│   │   ├── mcpHandlers.ts
│   │   ├── skillHandlers.ts
│   │   └── httpLogHandlers.ts
│   ├── tools/               # Agent 工具实现
│   │   ├── types.ts         # ToolContext、ProjectConfig、沙箱路径检查
│   │   ├── bash.ts          # 终端命令执行（沙箱审批 + Docker 隔离）
│   │   ├── read.ts          # 文件/目录读取
│   │   ├── write.ts         # 文件写入
│   │   ├── edit.ts          # 精确文本替换编辑
│   │   ├── ask.ts           # 向用户提问（选项式交互）
│   │   ├── shuvixProject.ts # 读写项目配置
│   │   ├── shuvixSetting.ts # 读写全局设置
│   │   ├── skill.ts         # 自定义 Skill 执行
│   │   └── utils/           # 工具辅助（diff、路径、shell、截断）
│   ├── types/               # 主进程类型定义（按模块拆分）
│   ├── utils/               # 工具函数（paths、tools 注册表）
│   ├── logger.ts            # 日志（electron-log）
│   ├── perf.ts              # 性能打点
│   └── i18n.ts              # 主进程 i18n
├── preload/
│   ├── index.ts             # contextBridge 暴露 window.api
│   └── index.d.ts           # ★ 前后端 API 契约类型定义（ShuviXAPI）
├── renderer/src/            # React 渲染进程
│   ├── App.tsx              # 入口组件（主窗口 / 设置窗口路由）
│   ├── main.tsx             # React 挂载点
│   ├── stores/
│   │   ├── chatStore.ts     # ★ 聊天状态 store（会话、消息、流式、工具执行、错误）
│   │   └── settingsStore.ts # 设置/模型/提供商 store
│   ├── hooks/
│   │   ├── useAppInit.ts    # 应用级初始化（设置、提供商、会话列表）
│   │   ├── useSessionInit.ts # 会话级初始化（消息加载、Agent init、元信息同步）
│   │   ├── useAgentEvents.ts # Agent 流式事件分发
│   │   ├── useChatActions.ts # 聊天操作（发送、重试、回滚、删除等）
│   │   ├── useSessionMeta.ts # 会话元信息（projectPath、指令文件状态）
│   │   ├── useImageUpload.ts # 图片拖拽/粘贴上传
│   │   ├── useClickOutside.ts
│   │   └── useDialogClose.ts
│   ├── components/
│   │   ├── chat/            # 聊天区组件
│   │   │   ├── ChatView.tsx       # 消息列表 + 虚拟滚动
│   │   │   ├── InputArea.tsx      # 输入框 + 发送按钮 + 模型/工具/思考选择器
│   │   │   ├── MessageBubble.tsx  # 消息气泡（Markdown 渲染）
│   │   │   ├── MessageRenderer.tsx # 单条消息渲染（含工具调用）
│   │   │   ├── StreamingFooter.tsx # 流式输出 + 加载指示 + 错误展示
│   │   │   ├── ToolCallBlock.tsx  # 工具调用折叠面板
│   │   │   ├── UserActionPanel.tsx # ask 提问 / bash 审批浮层
│   │   │   ├── ModelPicker.tsx    # 模型切换下拉
│   │   │   ├── ThinkingPicker.tsx # 思考深度切换
│   │   │   ├── ToolPicker.tsx     # 工具启用/禁用
│   │   │   ├── CodeBlock.tsx      # 代码高亮 + 复制
│   │   │   └── WelcomeView.tsx    # 空会话欢迎页
│   │   ├── sidebar/         # 侧边栏
│   │   │   ├── Sidebar.tsx           # 会话列表 + 项目分组
│   │   │   ├── ProjectCreateDialog.tsx
│   │   │   └── ProjectEditDialog.tsx
│   │   ├── settings/        # 设置面板
│   │   │   ├── SettingsPanel.tsx     # Tab 切换容器
│   │   │   ├── GeneralSettings.tsx
│   │   │   ├── ProviderSettings.tsx
│   │   │   ├── McpSettings.tsx
│   │   │   ├── SkillSettings.tsx
│   │   │   ├── HttpLogSettings.tsx
│   │   │   ├── AboutSettings.tsx
│   │   │   ├── PayloadViewer.tsx
│   │   │   └── TabButton.tsx
│   │   └── common/          # 通用组件
│   ├── i18n.ts              # 渲染进程 i18n 初始化
│   └── utils/
└── shared/
    └── i18n/locales/        # 翻译文件（zh.json / en.json / ja.json）
```

## 架构关键概念

### 进程通信

前后端通过 Electron IPC 通信，API 契约定义在 `src/preload/index.d.ts`（`ShuviXAPI` 接口）。渲染进程通过 `window.api.*` 调用主进程服务。

Agent 流式事件通过 `window.api.agent.onEvent` 监听，事件类型包括：
`text_delta` / `thinking_delta` / `agent_start` / `agent_end` / `tool_start` / `tool_end` / `tool_approval_request` / `user_input_request` / `error` / `docker_event`

### 状态管理

两个 Zustand store：

- **`useChatStore`**（`chatStore.ts`）— 聊天核心状态
  - 所有会话列表 `sessions`、活跃会话 `activeSessionId`、当前消息 `messages`
  - 按 sessionId 隔离的流式状态 `sessionStreams`、工具执行 `sessionToolExecutions`、错误 `sessionErrors`
  - UI 通过**派生选择器**（`selectStreamingContent` / `selectIsStreaming` / `selectToolExecutions` / `selectError` 等）从 map 读取当前活跃会话状态，无镜像字段
  - 模型能力、输入状态、会话元信息（`projectPath`、`enabledTools`、`agentMdLoaded`、`claudeMdLoaded`）

- **`useSettingsStore`**（`settingsStore.ts`）— 设置 + 模型提供商
  - 提供商列表、可用模型、当前选择的 provider/model
  - 主题、字体大小、系统提示词
  - 配置元数据（用于审批弹窗展示字段说明）

### 初始化流程

由三个 hook 依次承担（在 `App.tsx` 中组合）：

1. **`useAppInit()`** — 应用级：加载设置 → 加载提供商/模型 → 加载会话列表 → 通知主进程显示窗口
2. **`useSessionInit(activeSessionId)`** — 会话级：加载消息 → `agent.init` → 同步模型信息/元信息到 store。使用 `cancelled` 标记防止快速切换时过期数据覆写
3. **`useAgentEvents()`** — 事件分发：监听 Agent 流式事件，写入按 sessionId 隔离的 store

### 工具系统

内置工具：`bash` / `read` / `write` / `edit` / `ask` / `shuvix-project` / `shuvix-setting`

扩展工具：

- **MCP 工具**：通过 MCP Server 动态注册，key 格式 `mcp__<serverName>__<toolName>`
- **Skill 工具**：用户自定义 Markdown 脚本，key 格式 `skill:<name>`

工具启用优先级：session 级覆盖 > project settings > 默认（核心内置工具）

### 指令文件

- **AGENTS.MD**：项目根目录的指令文件，创建 Agent 时自动读取并注入 system prompt（兼容 `AGENT.md`）
- 加载状态通过 `agent.init` 返回，前端展示在输入区底部

### 沙箱与安全

- 项目模式：工具操作限制在项目目录内，bash 命令需用户审批
- Docker 隔离：可选将命令执行隔离到 Docker 容器
- 临时会话：使用 `~/ShuviX/tmp/<sessionId>` 作为工作目录，强制开启沙箱
- 参考目录：沙箱模式下可配置只读参考目录

## 开发命令

```bash
npm install          # 安装依赖（含 electron-rebuild）
npm run dev          # 启动开发服务器（HMR）
npm run typecheck    # TypeScript 类型检查（node + web）
npm run lint         # ESLint 检查
npm run format       # Prettier 格式化
npm run build:mac    # 构建 macOS 安装包
npm run build:win    # 构建 Windows 安装包
npm run build:linux  # 构建 Linux 安装包
```

## 代码规范

- **注释语言**：使用中文
- **格式化**：Prettier — 单引号、无分号、100 字符行宽、无尾逗号
- **TypeScript**：严格模式，两套 tsconfig（`tsconfig.node.json` 主进程 + preload，`tsconfig.web.json` 渲染进程）
- **路径别名**：渲染进程中 `@renderer/*` → `src/renderer/src/*`
- **类型导入**：主进程类型通过 `src/main/types/index.ts` 统一导出，preload 引用后在渲染进程中可见
- **ID 生成**：使用 UUID v7（时间排序）

## 数据库

SQLite，WAL 模式，数据目录 `{userData}/data/shuvix.db`。

核心表：`sessions` / `messages` / `settings` / `providers` / `provider_models` / `projects` / `mcp_servers` / `http_logs`

DAO 层使用 `better-sqlite3` 同步 API，包裹在 `databaseManager` 单例中。

## 窗口管理

- **主窗口**：侧边栏 + 聊天区，macOS 使用 `hiddenInset` 标题栏
- **设置窗口**：独立 BrowserWindow，加载同一渲染入口 + `#settings` hash 区分
- 设置窗口关闭时通过 `app:settings-changed` 事件通知主窗口刷新
