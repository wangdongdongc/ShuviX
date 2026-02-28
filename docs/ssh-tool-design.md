# SSH 远程执行工具

新增 `ssh` 工具，让 AI 智能体能通过 SSH 连接远程服务器并像人类一样执行命令、根据输出决定后续操作。

## 架构设计

### 工具参数设计

```typescript
// action: connect / exec / disconnect
{ action: "connect" }          // 无任何凭据参数，host/username/password 全部由用户在 UI 弹窗中填写
{ action: "exec", command: "ls -la /etc", timeout?: 30 }
{ action: "disconnect" }
```

> **核心原则**：大模型参数中不包含 host、username、password 任何字段，全部由用户在渲染端弹窗中输入，经 IPC 直接传给 sshManager。

### 交互流程

1. AI 调用 `ssh({ action: "connect" })`（无任何凭据参数）
2. 弹出凭据输入面板（复用 `UserActionPanel` 模式），用户填写 **host + port + 用户名 + 密码**
3. 凭据经 IPC 直达 sshManager，连接成功/失败状态返回给工具（大模型只看到 "Connected to remote server" 或错误信息）
4. AI 调用 `ssh({ action: "exec", command: "..." })`，弹出审批面板，用户确认后执行
5. 返回 stdout/stderr/exitCode，AI 根据输出决定下一步
6. 最终 AI 调用 `disconnect` 或连接空闲超时自动断开

### 安全策略

- 密码 **仅存内存**，不持久化到 DB / 磁盘
- host、用户名、密码 **全不经过工具参数/返回值**，大模型完全无感知
- 凭据通过 renderer → main 进程 IPC → sshManager，不落日志、不经过工具返回值
- **每条 exec 命令都需用户审批**（复用 `requestApproval` 模式）
- 每个 session 最多一个 SSH 连接
- 空闲超时自动断开（复用 Docker idle timeout 模式）

## 实现步骤

### Step 1: 安装依赖

- `npm install ssh2` + `npm install -D @types/ssh2`（纯 JS SSH 客户端，无需 native rebuild）

### Step 2: SSH 连接管理器

- **新建** `src/main/services/sshManager.ts`
- 类似 `DockerManager`：per-session 连接池 + 空闲超时
- API: `connect(sessionId, host, port, username, password)` / `exec(sessionId, command, timeout, signal)` / `disconnect(sessionId)` / `disconnectAll()`
- 连接状态查询：`getConnection(sessionId)`

### Step 3: SSH 工具实现

- **新建** `src/main/tools/ssh.ts`
- `createSshTool(ctx: ToolContext)` 遵循现有工具模式
- connect 时通过 `ctx.requestSshCredentials` 向渲染端请求凭据
- exec 时使用 sshManager 执行命令，输出截断复用 `truncateTail`

### Step 4: 工具注册（5 处）

按 `/new-tool` checklist：

- `src/main/types/tools.ts` — 加入 `ALL_TOOL_NAMES`（**不加入** `DEFAULT_TOOL_NAMES`，选配）
- `src/main/services/agent.ts` — import + `buildTools.builtinAll` 注册 + ToolContext 增加 `requestSshCredentials` 回调 + `pendingSshCredentials` Map
- `src/main/ipc/agentHandlers.ts` — 新增 `agent:respondToSshCredentials` handler
- `src/main/utils/tools.ts` — `TOOL_PROMPT_REGISTRY` 加 SSH 引导
- `src/main/tools/types.ts` — ToolContext 增加 `requestSshCredentials` 类型

### Step 5: 凭据输入 UI

- `ToolContext` 新增 `requestSshCredentials` 回调（类似 `requestApproval`）
- Agent 事件新增 `ssh_credential_request` 类型
- `src/renderer/src/hooks/useAgentEvents.ts` — 处理 `ssh_credential_request`
- `src/renderer/src/components/chat/UserActionPanel.tsx` — 新增 `SshCredentialContent` 组件（host 输入框、port 输入框默认 22、username 输入框、password 输入框 type=password、连接/取消按钮）
- `src/renderer/src/hooks/useChatActions.ts` — 新增 `handleSshCredentials` 回调
- `src/preload/index.ts` + `index.d.ts` — 新增 `agent:respondToSshCredentials` IPC
- `chatStore.ts` ToolExecution 新增 `pending_ssh_credentials` 状态

### Step 6: ToolCallBlock UI

- `src/renderer/src/components/chat/ToolCallBlock.tsx` — ssh 工具图标 + 参数摘要（`Terminal` icon, 显示 host + command）

### Step 7: i18n

- `zh.json` / `en.json` / `ja.json` 添加：
  - `tool.sshLabel`
  - `toolCall.sshConnecting` / `sshConnected` / `sshDisconnected` / `sshCredentialHint`
  - `ssh.host` / `ssh.username` / `ssh.password` / `ssh.connect` / `ssh.cancel`

### Step 8: Agent 清理

- `agent.ts` 的 `removeAgent` / `invalidateAgent` 中调用 `sshManager.disconnect(sessionId)`
- 应用退出时调用 `sshManager.disconnectAll()`

### Step 9: 编译 + 测试

- `npx tsc --noEmit -p tsconfig.node.json --composite false`
- `npx vitest run`

## 已确认决策

- ✅ 仅密码认证（不保存凭据）
- ✅ host/username/password 全部用户输入，不经过工具参数，大模型完全无感知
- ✅ exec 每次都需用户审批（复用 `requestApproval`）
- ✅ 每 session 单连接
