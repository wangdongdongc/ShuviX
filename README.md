# ShiroBot

桌面 AI 智能体应用，基于 Electron + React + TypeScript 构建，集成 [pi-mono](https://github.com/nicepkg/pi-mono) 生态实现多模型聊天能力。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面运行时 | Electron |
| 前端框架 | React 19 + TypeScript |
| 构建工具 | electron-vite (Vite) |
| 样式方案 | Tailwind CSS v4 |
| 状态管理 | Zustand |
| LLM 集成 | @mariozechner/pi-ai + pi-agent-core |
| 数据持久化 | SQLite (better-sqlite3) |
| 包管理器 | pnpm |

## 项目结构

```
src/
├── main/                          # Electron 主进程
│   ├── index.ts                   # 应用入口，窗口创建，生命周期管理
│   ├── types/
│   │   └── index.ts               # 共享数据类型（Session, Message, Settings）
│   ├── dao/                       # 数据访问层（纯 SQL 操作）
│   │   ├── database.ts            # SQLite 连接管理 + 表结构初始化
│   │   ├── sessionDao.ts          # Session 表 CRUD
│   │   ├── messageDao.ts          # Message 表 CRUD
│   │   └── settingsDao.ts         # Settings 表 CRUD
│   ├── services/                  # 业务逻辑层（编排 DAO，处理业务规则）
│   │   ├── agent.ts               # Agent 服务，封装 pi-agent-core 事件流
│   │   ├── sessionService.ts      # 会话业务（创建、删除时级联清理消息）
│   │   ├── messageService.ts      # 消息业务（添加后自动更新会话时间戳）
│   │   └── settingsService.ts     # 设置业务（读写 API Key、Base URL 等）
│   └── ipc/                       # IPC 通信层（Controller，参数解析 + 委托）
│       ├── handlers.ts            # 统一注册入口
│       ├── agentHandlers.ts       # agent:* 通道
│       ├── sessionHandlers.ts     # session:* 通道
│       ├── messageHandlers.ts     # message:* 通道
│       └── settingsHandlers.ts    # settings:* 通道
│
├── preload/                       # 预加载脚本（安全桥接）
│   ├── index.ts                   # contextBridge 暴露 window.api
│   └── index.d.ts                 # API 类型定义
│
└── renderer/                      # Electron 渲染进程（React 应用）
    ├── index.html                 # HTML 入口
    └── src/
        ├── main.tsx               # React 入口
        ├── App.tsx                # 根组件，布局 + Agent 事件监听
        ├── assets/
        │   └── main.css           # Tailwind v4 + 暗色主题变量
        ├── stores/                # Zustand 状态管理
        │   ├── chatStore.ts       # 聊天状态（会话列表、消息、流式内容）
        │   └── settingsStore.ts   # 设置状态（API Key、Base URL、Provider）
        └── components/            # UI 组件
            ├── Sidebar.tsx        # 侧边栏（会话列表、新建/删除/重命名）
            ├── ChatView.tsx       # 聊天主视图（消息列表 + 空状态引导）
            ├── MessageBubble.tsx  # 消息气泡（Markdown 渲染 + 代码高亮）
            ├── InputArea.tsx      # 输入区（发送/停止，Shift+Enter 换行）
            └── SettingsPanel.tsx  # 设置面板（API Key、Base URL、模型选择）
```

## 架构分层

```
Renderer (React)
  │
  │  window.api.*（IPC 调用）
  ▼
Preload (contextBridge)
  │
  │  ipcRenderer.invoke / ipcRenderer.on
  ▼
IPC Layer (Controller)          ← 参数解析，路由分发
  │
  │  调用 Service 方法
  ▼
Service Layer                   ← 业务逻辑，编排多个 DAO
  │
  ├──▶ DAO Layer                ← 纯数据库操作
  │      └──▶ SQLite (better-sqlite3)
  │
  └──▶ pi-agent-core / pi-ai   ← LLM 调用 + Agent 循环
```

**各层职责**：

- **IPC (Controller)** — 只做 `ipcMain.handle` 注册、参数解构、调用 Service、返回结果。不含业务逻辑。
- **Service** — 编排跨 DAO 操作（如删除会话时级联删消息），处理 ID 生成、时间戳更新等业务规则。
- **DAO** — 一个方法对应一条 SQL，不含任何业务逻辑，不调用其他 DAO。
- **Types** — 所有层共享的数据结构定义，集中管理。

## 数据存储

SQLite 数据库位于：

```
~/Library/Application Support/shirobot/data/shirobot.db
```

包含三张表：`sessions`、`messages`、`settings`。使用 WAL 模式提升并发性能。

## 开发

```bash
# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev

# 类型检查
pnpm typecheck
```

## 构建

```bash
# macOS
pnpm build:mac

# Windows
pnpm build:win

# Linux
pnpm build:linux
```
