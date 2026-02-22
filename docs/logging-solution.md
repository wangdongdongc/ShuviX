# ShuviX 桌面应用日志方案

引入 `electron-log` 替换全部 `console.xxx`，实现分级日志、文件轮转、统一格式，开发/生产环境均可追溯。

## 现状

- 主进程 9 个文件共 46 处 `console.log/warn/error`，无日志级别、无文件输出、无轮转
- 已有 `[Tag]` 前缀约定：`[Agent]`、`[MCP]`、`[LiteLLM]`、`[Tool: bash]` 等
- 渲染进程无 console 调用（无需处理）

## 方案：electron-log

**选型理由**：Electron 生态标准日志库，零配置即可写文件，支持 main/renderer 双进程、日志轮转、自定义格式。

### 文件变更清单

| # | 文件 | 动作 |
|---|------|------|
| 1 | `package.json` | `npm install electron-log` |
| 2 | `src/main/logger.ts` | **新建** — 初始化 electron-log，配置格式/轮转/级别，导出带 tag 的 `createLogger(tag)` 工厂函数 |
| 3 | `src/main/services/agent.ts` | 替换 19 处 `console.xxx` → `log.xxx` |
| 4 | `src/main/services/litellmService.ts` | 替换 9 处 |
| 5 | `src/main/services/mcpService.ts` | 替换 9 处 |
| 6 | `src/main/services/dockerManager.ts` | 替换 3 处 |
| 7 | `src/main/tools/bash.ts` | 替换 2 处 |
| 8 | `src/main/tools/edit.ts` | 替换 1 处 |
| 9 | `src/main/tools/read.ts` | 替换 1 处 |
| 10 | `src/main/tools/write.ts` | 替换 1 处 |
| 11 | `src/main/index.ts` | 替换 1 处 + 引入 logger 初始化 |

### logger.ts 设计

```typescript
import log from 'electron-log/main'

// 日志文件位置：{userData}/logs/shuvix.log（electron-log 默认）
// 文件轮转：单文件 5MB，保留 3 份历史
log.transports.file.maxSize = 5 * 1024 * 1024
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
log.transports.console.format = '[{h}:{i}:{s}] [{level}] {text}'

// 生产环境不输出 debug
if (process.env.NODE_ENV === 'production') {
  log.transports.console.level = 'warn'
}

/** 创建带模块标签的 logger */
export function createLogger(tag: string) {
  return log.scope(tag)  // electron-log 内置 scope 功能
}

export default log
```

### 使用方式

```typescript
// src/main/services/agent.ts
import { createLogger } from '../logger'
const log = createLogger('Agent')

// 之前：console.log(`[Agent] 创建 model=${model}`)
// 之后：log.info(`创建 model=${model}`)

// 之前：console.error(`[Agent] 流式错误: ${msg}`)
// 之后：log.error(`流式错误: ${msg}`)
```

### 日志级别映射

| 原调用 | 新调用 | 说明 |
|--------|--------|------|
| `console.log` | `log.info` | 常规信息 |
| `console.warn` | `log.warn` | 警告 |
| `console.error` | `log.error` | 错误 |

### 日志文件位置

- **macOS**: `~/Library/Logs/ShuviX/main.log`
- **Windows**: `%USERPROFILE%\AppData\Roaming\ShuviX\logs\main.log`
- **Linux**: `~/.config/ShuviX/logs/main.log`

### 实施步骤

1. 安装 `electron-log`
2. 新建 `src/main/logger.ts`
3. 逐文件替换 `console.xxx`（按匹配数从多到少）
4. typecheck 验证
