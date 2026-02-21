# 沙箱模式技术设计

## 背景

为项目引入沙箱模式（Sandbox Mode），限制工具调用的访问范围，防止智能体越权操作。

## 功能概述

- **开启沙箱**时：`read`/`write`/`edit` 工具不能访问项目工作目录外的文件；`bash` 命令需要用户审批后才能执行
- **关闭沙箱**时：所有工具不受限制，直接执行
- **临时会话**：固定使用 `temp_workspace/<sessionId>` 作为工作目录，沙箱始终开启

## 架构设计

### 数据层

- `projects` 表新增 `sandboxEnabled` 列（INTEGER，默认 1）
- DB 迁移：为已有项目自动添加该列
- `ProjectConfig` 类型包含 `sandboxEnabled` 和 `workingDirectory`

### 工具层

#### 路径越界检查（read/write/edit）

```typescript
if (config.sandboxEnabled && !isPathWithinWorkspace(absolutePath, config.workingDirectory)) {
  throw new Error('沙箱模式：禁止访问工作区外的路径')
}
```

`isPathWithinWorkspace` 使用 `path.resolve` + `startsWith` 判断。

#### bash 审批逻辑

沙箱模式下 bash 工具通过 `requestApproval` 回调请求用户审批：

```
bash execute → sandboxEnabled? → requestApproval(toolCallId, command) → Promise<boolean>
  → approved: 执行命令
  → denied: throw Error
```

#### resolveProjectConfig

根据 `sessionId` 动态查询项目配置：
- 有项目：从数据库读取 `sandboxEnabled` 和项目路径
- 临时会话：`sandboxEnabled = true`，工作目录为 `temp_workspace/<sessionId>`

### Agent 层

- `AgentService` 维护 `pendingApprovals: Map<toolCallId, { resolve }>`
- `requestApproval` 回调创建 Promise，存入 map，发送 IPC 事件到渲染进程
- `approveToolCall(toolCallId, approved)` 从 map 取出并 resolve

### IPC 通信

#### 审批请求（main → renderer）

`tool_start` 事件携带 `approvalRequired` 标记（避免额外事件的 race condition）：

```typescript
{
  type: 'tool_start',
  sessionId, toolCallId, toolName, toolArgs,
  approvalRequired: boolean  // bash + sandboxEnabled 时为 true
}
```

#### 审批响应（renderer → main）

```typescript
ipcMain.handle('agent:approveToolCall', (_, { toolCallId, approved }) => { ... })
```

### 前端

#### chatStore

`ToolExecution.status` 新增 `'pending_approval'` 状态。

#### ToolCallBlock 组件

根据 status 显示不同 UI：

| 状态 | 图标 | 颜色 | UI |
|------|------|------|-----|
| `running` | 旋转 Loader | 蓝色 | 工具名 + 参数摘要 |
| `done` | Check | 绿色 | 工具名 + 结果 |
| `error` | X | 红色 | 工具名 + 错误信息 |
| `pending_approval` | ShieldCheck | 黄色 | 命令内容 + 允许/拒绝按钮 |

#### 项目对话框

`ProjectCreateDialog` 和 `ProjectEditDialog` 各增加沙箱模式开关（默认开启）。

### 错误状态显示

所有工具的错误场景从 `return { content: [...] }` 改为 `throw new Error(...)`，让 pi-agent-core 自动标记 `isError: true`，前端根据该标记显示红色错误状态。

### 边界处理

- **临时会话删除**：清理 `temp_workspace/<sessionId>` 目录
- **abort**：取消所有 pending 审批（resolve(false)）
- **DB 迁移**：ALTER TABLE 为已有 projects 添加 sandboxEnabled 列

## 涉及文件

| 层 | 文件 |
|----|------|
| 数据层 | `database.ts`, `project.ts`, `projectDao.ts`, `projectService.ts` |
| 工具层 | `tools/types.ts`, `tools/bash.ts`, `tools/read.ts`, `tools/write.ts`, `tools/edit.ts` |
| Agent | `services/agent.ts` |
| IPC | `ipc/agentHandlers.ts` |
| 前端 | `App.tsx`, `ChatView.tsx`, `ToolCallBlock.tsx`, `chatStore.ts` |
| 对话框 | `ProjectCreateDialog.tsx`, `ProjectEditDialog.tsx` |
| i18n | `zh.json`, `en.json`, `ja.json` |
| 类型 | `types/agent.ts`, `preload.d.ts` |

## 关键修复记录

### 审批 UI 不显示

**现象**：开启沙箱后 bash 执行停住，但看不到审批 UI。

**根因**：`tool_approval_request` 事件在 `tool_start` 之前到达渲染进程，此时 `ToolExecution` 尚未创建，`updateToolExecution` 找不到目标。

**修复**：将 `approvalRequired` 标记直接嵌入 `tool_start` 事件，渲染进程在创建 `ToolExecution` 时即设置 `pending_approval` 状态，消除 race condition。
