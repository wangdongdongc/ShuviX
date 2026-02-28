# MCP (Model Context Protocol) 集成方案

在 ShuviX 中支持用户配置和使用 MCP Server，将每个 MCP 工具独立桥接为 `AgentTool`，采用 **Server 级 + 工具级混合粒度** 控制，同时支持 **stdio + HTTP** 双传输层。

## 设计决策

**工具粒度：B + C 混合方案**

- **全局 Settings（MCP Tab）**：Server 级开关 — 启用/禁用整个 MCP Server
- **项目设置（ProjectEditDialog）**：工具级勾选 — 从已启用 Server 中挑选需要的工具
- 每个 MCP 工具独立注册为 `AgentTool`，LLM 可直接感知每个工具的 schema

## 现状分析

| 组件                    | 现状                                                                    |
| ----------------------- | ----------------------------------------------------------------------- |
| `AgentTool` 接口        | `{ name, label, description, parameters(TSchema), execute }` — 足够通用 |
| `buildTools()`          | 静态注册 6 个内置工具 (now/bash/read/write/edit/ask)                    |
| `agent.setTools()`      | 支持运行时动态替换工具集                                                |
| `resolveEnabledTools()` | session > project settings > 默认全部（仅内置）                         |
| `tools:list` IPC        | 返回内置工具名 + i18n 标签                                              |
| `ProjectEditDialog`     | 工具勾选框，控制启用/禁用                                               |
| Settings UI             | 4 个 Tab: general / providers / httpLogs / about                        |

## 整体架构

```
┌─ Renderer ─────────────────────────────┐
│  SettingsPanel (新增 MCP Tab)          │
│    └─ McpSettings.tsx                  │
│         · 添加/编辑/删除 MCP Server    │
│         · Server 级启用/禁用开关       │
│         · 查看工具列表 & 连接状态      │
│  ProjectEditDialog                     │
│    └─ 工具列表分组显示                 │
│         · 内置工具（勾选）             │
│         · MCP 工具按 Server 分组（勾选）│
├─ Preload ──────────────────────────────┤
│  api.mcp.* (IPC 桥接)                 │
├─ Main ─────────────────────────────────┤
│  McpService ← 核心                    │
│    ├─ 管理 MCP Server 子进程生命周期   │
│    ├─ 调用 tools/list 发现工具         │
│    ├─ 调用 tools/call 执行工具         │
│    └─ 两层桥接：Server→Tools[]→AgentTool│
│  mcpHandlers.ts (IPC)                  │
│  mcpDao.ts (DB 存储)                   │
│  agent.ts ← buildTools 合并 MCP 工具   │
└────────────────────────────────────────┘
```

## 传输层（Transport）支持

同时支持两种 MCP 传输方式，一步到位：

| 类型      | 配置                       | 适用场景                              |
| --------- | -------------------------- | ------------------------------------- |
| **stdio** | `command` + `args` + `env` | 本地进程：npx / docker / uvx / 二进制 |
| **http**  | `url` + `headers`          | 远程服务：SSE / Streamable HTTP       |

- 用户添加 Server 时选择类型，UI 根据类型显示对应的配置字段
- McpService 根据 `type` 创建 `StdioClientTransport` 或 `SSEClientTransport`

## MCP Server 生命周期

MCP Server 实例是 **应用级单例**，不绑定任何会话，所有会话共享。

```
App 启动                          App 退出
   │                                 │
   ▼                                 ▼
mcpService.connectAll()          mcpService.disconnectAll()
   │  遍历 DB 中 isEnabled=1         │  遍历所有 connections
   │  的 server，逐个 connect         │  逐个 disconnect
   │                                 │  stdio: 杀子进程
   │                                 │  http: 关闭连接
   ▼                                 ▼
┌─────────────────────────────────────────┐
│            运行态（常驻）                │
│                                         │
│  ┌─ Server A (stdio) ──────────────┐   │
│  │  子进程运行中，tools 已发现      │   │
│  │  状态: connected                 │   │
│  └──────────────────────────────────┘   │
│  ┌─ Server B (http) ───────────────┐   │
│  │  SSE 连接保持，tools 已发现      │   │
│  │  状态: connected                 │   │
│  └──────────────────────────────────┘   │
│                                         │
│  触发重连的场景：                        │
│  · Settings 中编辑 server 配置 → 断开旧 + 重连新  │
│  · Settings 中启用 server → connect     │
│  · Settings 中禁用 server → disconnect  │
│  · 用户点击手动重连按钮                  │
│  · stdio 子进程意外退出 → 标记 error     │
└─────────────────────────────────────────┘
```

**关键设计点**：

- **启动时机**：`app.whenReady()` → `registerIpcHandlers()` 之后调用 `mcpService.connectAll()`
- **退出清理**：`app.on('before-quit')` → `mcpService.disconnectAll()`（与 `dockerManager.destroyAll()` 并列）
- **不随会话创建/销毁**：Agent 创建时通过 `mcpService.getAllAgentTools()` 获取当前可用工具，无需管理 MCP 连接
- **进程崩溃处理**：stdio transport 监听子进程 `exit` 事件，标记 `status: 'error'`，UI 显示错误状态 + 重连按钮
- **配置变更**：编辑 server 后自动 `disconnect` + `connect`，工具列表实时更新

## 工具命名规则

MCP 工具名采用 `mcp:<serverName>:<toolName>` 格式，例如：

- `mcp:filesystem:read_file`
- `mcp:github:create_issue`

与内置工具（`bash`, `read`, `write` 等）命名空间隔离，无冲突。

## 实现步骤

### 1. 数据层：`mcp_servers` 表 + DAO

**新增 DB 表**（在 `database.ts` migrate 中添加）：

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,         -- 显示名称（也用于工具名前缀），如 "filesystem"
  type TEXT NOT NULL DEFAULT 'stdio', -- 传输类型：'stdio' | 'http'
  -- stdio 类型字段
  command TEXT NOT NULL DEFAULT '',    -- 启动命令，如 "npx"
  args TEXT NOT NULL DEFAULT '[]',    -- JSON 数组，如 ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
  env TEXT NOT NULL DEFAULT '{}',     -- JSON 环境变量
  -- http 类型字段
  url TEXT NOT NULL DEFAULT '',       -- 远程 URL，如 "https://mcp.example.com/sse"
  headers TEXT NOT NULL DEFAULT '{}', -- JSON 请求头（如 Authorization）
  -- 通用字段
  isEnabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
```

**新文件** `src/main/dao/mcpDao.ts`：标准 CRUD。

### 2. 核心服务：McpService

**新文件** `src/main/services/mcpService.ts`

**依赖**：`@modelcontextprotocol/sdk`（MCP 官方 TypeScript SDK）

**关键职责**：

```typescript
class McpService {
  // 每个 server 维护一个连接实例
  private connections: Map<
    serverId,
    {
      client: Client
      transport: StdioClientTransport | SSEClientTransport // 根据 type 选择
      tools: McpDiscoveredTool[] // tools/list 返回的原始工具
      status: 'connected' | 'disconnected' | 'error'
      error?: string
    }
  >

  /** 连接 MCP Server（根据 type 自动选择 stdio/http transport），调用 tools/list 发现工具 */
  async connect(serverId: string): Promise<void>
  // 内部逻辑：
  //   type === 'stdio' → new StdioClientTransport({ command, args, env })
  //   type === 'http'  → new SSEClientTransport(new URL(url), { headers })

  /** 断开并关闭子进程 */
  async disconnect(serverId: string): Promise<void>

  /** 获取某个 server 发现的工具列表（原始 MCP 格式） */
  getServerTools(serverId: string): McpDiscoveredTool[]

  /** 调用 MCP 工具 */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult>

  /** ---- 桥接层（两层结构） ---- */

  /** 将单个 MCP 工具转为 AgentTool */
  private mcpToolToAgentTool(
    serverId: string,
    serverName: string,
    mcpTool: McpDiscoveredTool
  ): AgentTool

  /** 将单个 Server 的所有工具转为 AgentTool[] */
  serverToAgentTools(serverId: string): AgentTool[]

  /** 获取所有已连接 Server 的全部 AgentTool（flat 数组） */
  getAllAgentTools(): AgentTool[]

  /** 启动所有 isEnabled 的 server */
  async connectAll(): Promise<void>

  /** 关闭所有 */
  async disconnectAll(): Promise<void>

  /** 获取连接状态 */
  getStatus(serverId: string): 'connected' | 'disconnected' | 'error'
}
```

**两层桥接设计**：

```typescript
// 第一层：单个 MCP 工具 → AgentTool
private mcpToolToAgentTool(serverId: string, serverName: string, mcpTool: McpDiscoveredTool): AgentTool {
  return {
    name: `mcp:${serverName}:${mcpTool.name}`,   // 带命名空间前缀
    label: `${serverName}: ${mcpTool.name}`,
    description: mcpTool.description ?? '',
    parameters: jsonSchemaToTypebox(mcpTool.inputSchema),
    execute: async (toolCallId, params) => {
      const result = await this.callTool(serverId, mcpTool.name, params)
      return {
        content: result.content.map(c => ({ type: 'text', text: c.text ?? JSON.stringify(c) })),
        details: { server: serverName, tool: mcpTool.name }
      }
    }
  }
}

// 第二层：单个 Server → AgentTool[]
serverToAgentTools(serverId: string): AgentTool[] {
  const conn = this.connections.get(serverId)
  if (!conn || conn.status !== 'connected') return []
  const server = mcpDao.findById(serverId)
  return conn.tools.map(t => this.mcpToolToAgentTool(serverId, server.name, t))
}

// 合并所有 Server
getAllAgentTools(): AgentTool[] {
  return [...this.connections.keys()].flatMap(id => this.serverToAgentTools(id))
}
```

### 3. 集成到 Agent 工具链

**修改** `src/main/services/agent.ts` — `buildTools()` 合并逻辑：

```typescript
function buildTools(ctx: ToolContext, enabledTools: string[]): AgentTool<any>[] {
  // 内置工具（不变）
  const builtinAll: Record<string, AgentTool<any>> = {
    now: createNowTool(),
    bash: createBashTool(ctx),
    read: createReadTool(ctx),
    write: createWriteTool(ctx),
    edit: createEditTool(ctx),
    ask: createAskTool(ctx)
  }
  // MCP 工具（动态），key = "mcp:serverName:toolName"
  const mcpAll: Record<string, AgentTool<any>> = {}
  for (const tool of mcpService.getAllAgentTools()) {
    mcpAll[tool.name] = tool
  }
  // 合并后按 enabledTools 过滤
  const all = { ...builtinAll, ...mcpAll }
  return enabledTools.filter((name) => name in all).map((name) => all[name])
}
```

**修改** `src/main/utils/tools.ts`：

- `ALL_TOOL_NAMES` 保持为内置工具常量
- 新增 `getAllToolNames()` 动态函数 = 内置 + MCP 工具名
- `resolveEnabledTools()` 默认值改为 `getAllToolNames()`（包含 MCP）

**修改** `src/main/ipc/agentHandlers.ts` — `tools:list`：

- 返回值同时包含内置工具和 MCP 工具
- MCP 工具额外携带 `group: serverName` 字段供 UI 分组

### 4. IPC 层

**新文件** `src/main/ipc/mcpHandlers.ts`：

```typescript
ipcMain.handle('mcp:list') // 列出所有配置的 MCP Server（含状态）
ipcMain.handle('mcp:add') // 添加 MCP Server
ipcMain.handle('mcp:update') // 更新配置
ipcMain.handle('mcp:delete') // 删除
ipcMain.handle('mcp:connect') // 手动连接
ipcMain.handle('mcp:disconnect') // 手动断开
ipcMain.handle('mcp:getTools') // 获取指定 server 已发现的工具列表
```

**修改** `handlers.ts`：注册 `registerMcpHandlers()`
**修改** `preload/index.ts`：添加 `api.mcp.*`

### 5. Settings UI：MCP 管理页

**新文件** `src/renderer/src/components/settings/McpSettings.tsx`

功能：

- 列表展示已配置的 MCP Server（名称、命令、状态指示灯🟢🔴）
- 添加/编辑对话框：
  - **通用**：name
  - **类型选择**：stdio / http（切换后显示对应配置字段）
  - **stdio**：command, args, env
  - **http**：url, headers
- Server 级启用/禁用开关（控制是否连接）
- 展开查看该 server 提供的工具列表（只读）

**修改** `SettingsPanel.tsx`：新增 MCP Tab

### 6. ProjectEditDialog：MCP 工具分组勾选

**修改** `ProjectEditDialog.tsx`：

- `tools:list` IPC 返回带 `group` 字段的工具列表
- 工具勾选区分两组：
  - **内置工具**（现有的 checkbox 列表）
  - **MCP 工具**（按 Server 名称分组，每组可折叠，逐个工具勾选）

### 7. Token 开销缓解

- **Server 级开关**：不用的 Server 直接关闭，零开销
- **项目级工具勾选**：只启用项目实际需要的 MCP 工具
- **分组展示**：UI 中按 Server 分组，清晰展示工具数量

## 涉及文件

| 操作     | 文件                                                           |
| -------- | -------------------------------------------------------------- |
| **新建** | `src/main/dao/mcpDao.ts`                                       |
| **新建** | `src/main/services/mcpService.ts`                              |
| **新建** | `src/main/ipc/mcpHandlers.ts`                                  |
| **新建** | `src/renderer/src/components/settings/McpSettings.tsx`         |
| **修改** | `src/main/dao/database.ts` — 新增 `mcp_servers` 表             |
| **修改** | `src/main/services/agent.ts` — `buildTools` 合并 MCP 工具      |
| **修改** | `src/main/utils/tools.ts` — 动态工具列表                       |
| **修改** | `src/main/ipc/handlers.ts` — 注册 MCP handlers                 |
| **修改** | `src/main/ipc/agentHandlers.ts` — `tools:list` 返回 MCP 工具   |
| **修改** | `src/preload/index.ts` — 添加 `api.mcp.*`                      |
| **修改** | `src/renderer/src/components/SettingsPanel.tsx` — 新增 Tab     |
| **修改** | `src/renderer/src/components/ProjectEditDialog.tsx` — 分组显示 |
| **修改** | `src/shared/i18n/locales/*.json` — MCP 相关文案                |
| **修改** | `package.json` — 新增 `@modelcontextprotocol/sdk`              |

## 新增依赖

```json
{
  "@modelcontextprotocol/sdk": "^1.x"
}
```

## 实施顺序

1. **Phase 1 — 后端核心**：DB 表 → mcpDao → McpService → IPC handlers（可独立测试）
2. **Phase 2 — Agent 集成**：buildTools 合并 → tools:list 扩展 → enabledTools 兼容
3. **Phase 3 — 前端 UI**：McpSettings Tab → ProjectEditDialog 扩展
4. **Phase 4 — i18n + 打磨**：中/英/日文案 → 错误处理 → 状态反馈
