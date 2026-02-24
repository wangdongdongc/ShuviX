# 项目参考目录功能

为项目新增"参考目录"概念：用户可添加额外目录供 AI 读取参考，沙箱模式下参考目录只读。

## 数据存储

复用 `Project.settings` JSON 字段，无需改 DB schema：

```json
{
  "enabledTools": [...],
  "referenceDirs": [
    { "path": "/Users/xxx/docs", "note": "API 文档" },
    { "path": "/Users/xxx/other-repo", "note": "依赖库源码" }
  ]
}
```

## 变更清单

### 1. 类型定义
- **`src/main/types/project.ts`** — `ProjectCreateParams` / `ProjectUpdateParams` 增加 `referenceDirs?: Array<{ path: string; note?: string }>`
- **`src/main/tools/types.ts`** — `ProjectConfig` 增加 `referenceDirs: Array<{ path: string; note?: string }>`，`resolveProjectConfig` 从 settings 解析并填充

### 2. 后端服务
- **`src/main/services/projectService.ts`** — `create()` / `update()` 处理 `referenceDirs`，存入 settings JSON；`KNOWN_PROJECT_FIELDS` 注册新字段
- **`src/main/tools/shuvixProject.ts`** — get/update 支持 `referenceDirs` 字段

### 3. System Prompt 注入
- **`src/main/services/agent.ts`** — 构建 system prompt 时，如果项目有 referenceDirs，追加类似：
  ```
  Reference directories (read-only):
  - /path/to/dir1 — API 文档
  - /path/to/dir2 — 依赖库源码
  ```
- **`src/main/utils/tools.ts`** — `buildToolPrompts` 中扩展 `ToolPromptContext`，传入 referenceDirs 信息，更新 `agent.promptSupplement` 提示 AI 可以读取参考目录但不可写入

### 4. 沙箱路径检查
- **`src/main/tools/types.ts`** — 新增 `isPathWithinReferenceDirs(absolutePath, referenceDirs)` 函数
- **`src/main/tools/read.ts`** — 沙箱检查改为：`isPathWithinWorkspace || isPathWithinReferenceDirs`（允许读参考目录）
- **`src/main/tools/write.ts`** / **`src/main/tools/edit.ts`** — 保持不变（仅允许 workingDirectory）
- **`src/main/tools/bash.ts`** — 保持不变（沙箱靠用户审批，不做路径检查）

### 5. 前端 UI
- **`ProjectCreateDialog.tsx`** / **`ProjectEditDialog.tsx`** — 新增"参考目录"区域：
  - 列表展示已添加的参考目录（路径 + 注释）
  - "添加目录"按钮（调用 `dialog:openDirectory`）
  - 每行可编辑注释、可删除
  - 放在"项目路径"和"System Prompt"之间
- **i18n** — 三语言文件增加 `projectForm.referenceDirs` / `projectForm.referenceDirsHint` / `projectForm.addRefDir` / `projectForm.refDirNote` 等

### 6. IPC 层
- `projectHandlers.ts` 无需改动（已透传 params 给 service）
- `preload/index.d.ts` 无需改动（params 类型通过 `ProjectCreateParams` / `ProjectUpdateParams` 自动同步）

## 沙箱权限矩阵

| 工具 | 工作目录 | 参考目录 | 其他路径 |
|------|---------|---------|---------|
| read | ✅ 读 | ✅ 读 | ❌ |
| write | ✅ 读写 | ❌ | ❌ |
| edit | ✅ 读写 | ❌ | ❌ |
| bash | 审批制 | 审批制 | 审批制 |

## 实现顺序

1. 类型定义 + ProjectConfig 解析
2. projectService 读写 referenceDirs
3. system prompt 注入
4. read 工具沙箱检查扩展
5. 前端 UI（两个 Dialog）
6. i18n
7. shuvix-project 工具扩展
