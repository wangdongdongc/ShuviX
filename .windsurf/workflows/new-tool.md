---
description: 新建工具时的开发检查清单，确保不遗漏沙箱、referenceDirs、i18n、UI 等特性
---

# 新建工具检查清单

每次新建 `src/main/tools/<toolName>.ts` 时，按以下步骤逐一确认：

## 1. 沙箱路径越界检查

所有涉及文件系统路径的工具，execute 内必须调用统一的沙箱守卫函数（定义在 `src/main/tools/types.ts`）：

**只读工具**（read、ls、grep、glob 等）— 允许 workspace + referenceDirs：
```typescript
import { resolveProjectConfig, assertSandboxRead, type ToolContext } from './types'

assertSandboxRead(config, absolutePath, params.path)
```

**写入工具**（write、edit 等）— 仅允许 workspace，referenceDirs 不可写：
```typescript
import { resolveProjectConfig, assertSandboxWrite, type ToolContext } from './types'

assertSandboxWrite(config, absolutePath, params.path)
```

**关键点：**
- 不要手写 `if (config.sandboxEnabled && ...)` 判断，统一使用 `assertSandboxRead` / `assertSandboxWrite`
- 第三个参数 `displayPath` 可选，用于错误消息中展示用户传入的原始路径
- 新增测试 mock 时需在 `vi.mock('../types')` 中导出 `assertSandboxRead: () => {}` 和 `assertSandboxWrite: () => {}`

## 2. 注册点（共 5 处）

- [ ] `src/main/types/tools.ts` — `ALL_TOOL_NAMES` 和 `DEFAULT_TOOL_NAMES`
- [ ] `src/main/services/agent.ts` — import + `buildTools` 的 `builtinAll` 对象
- [ ] `src/main/ipc/agentHandlers.ts` — `tools:list` 的 `labelMap`
- [ ] `src/main/utils/tools.ts` — 如需 system prompt 追加文本，在 `TOOL_PROMPT_REGISTRY` 添加条目
- [ ] i18n 三语言文件（`zh.json`、`en.json`、`ja.json`）— 添加 `tool.<name>Label`

## 3. UI 参数摘要

`src/renderer/src/components/chat/ToolCallBlock.tsx` 的 switch 语句中添加 case：
- 选择合适的 lucide-react 图标
- 提取关键参数作为 detail 摘要（如 path、pattern 等）

## 4. 工具描述规范

- description 使用英文（直接传给 LLM）
- label 使用 `t('tool.<name>Label')` 多语言
- 参数 description 也使用英文

## 5. 其他必查项

- [ ] `signal?.aborted` 检查（execute 开头）
- [ ] `resolveToCwd` 路径解析（处理 `~`、相对路径）
- [ ] 目录/文件存在性验证
- [ ] 错误消息使用 `t()` i18n key
- [ ] TypeScript 编译通过：`npx tsc --noEmit -p tsconfig.node.json --composite false`
- [ ] 单元测试：`npx vitest run`
