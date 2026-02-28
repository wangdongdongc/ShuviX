# opencode edit/write 工具调研方案

> 调研时间：2025-02-25
> 来源：`/Users/WDD/Workbench/AIGC/opencode/packages/opencode/src/tool/write.ts` 和 `edit.ts`

---

## 一、opencode WriteTool 核心流程

```
1. 解析路径（绝对/相对回退）
2. 检查文件是否存在 → 存在则读取旧内容 + FileTime.assert()
3. 生成 diff → ctx.ask({ permission: "edit", diff }) 让用户审批
4. Filesystem.write() 写入
5. Bus 广播文件编辑/监听事件
6. FileTime.read() 更新读取时间
7. LSP.touchFile() + LSP.diagnostics() → 将类型/语法错误反馈给 AI
```

## 二、opencode EditTool 核心流程

```
1. 参数校验（oldString ≠ newString）
2. FileTime.withLock() 包裹整个操作
3. oldString 为空 → 视为创建新文件
4. oldString 非空 → FileTime.assert() → 读旧内容 → replace() 多级容错匹配
5. 生成 diff → ctx.ask() 审批
6. 写入 → 广播事件
7. FileTime.read() 更新
8. 计算 diff 统计（additions/deletions）→ Snapshot.FileDiff
9. LSP 诊断反馈（仅当前文件错误）
```

## 三、多级 Replacer 容错链（核心亮点）

opencode 的 `replace()` 按优先级依次尝试 9 种匹配策略，大幅降低 AI 编辑失败率：

| 序号 | Replacer                         | 策略说明                                                                        |
| ---- | -------------------------------- | ------------------------------------------------------------------------------- |
| 1    | **SimpleReplacer**               | 精确匹配（直接返回 oldString）                                                  |
| 2    | **LineTrimmedReplacer**          | 逐行 trim 后匹配，找到后返回原始行内容                                          |
| 3    | **BlockAnchorReplacer**          | 首尾行作为锚点，中间行用 Levenshtein 相似度评分；单候选阈值 0.0，多候选阈值 0.3 |
| 4    | **WhitespaceNormalizedReplacer** | 所有空白归一化为单个空格后匹配；支持子串匹配和多行                              |
| 5    | **IndentationFlexibleReplacer**  | 去除最小公共缩进后匹配（缩进无关）                                              |
| 6    | **EscapeNormalizedReplacer**     | 转义字符归一化（`\n`→换行等）后匹配                                             |
| 7    | **TrimmedBoundaryReplacer**      | 前后空白 trim 后匹配                                                            |
| 8    | **ContextAwareReplacer**         | 首尾锚点 + 中间行 50% 匹配率阈值                                                |
| 9    | **MultiOccurrenceReplacer**      | 多次出现精确匹配（配合 replaceAll）                                             |

**匹配逻辑**：

- 遍历 Replacer 链，每个 Replacer 是 Generator，yield 候选匹配
- 找到唯一匹配（`indexOf === lastIndexOf`）即替换
- 多个匹配 → 跳到下一个 Replacer
- 全部 Replacer 都未找到唯一匹配 → 抛错

## 四、与 shirobot 现状对比

| 特性                        | opencode                        | shirobot                     | 差距      |
| --------------------------- | ------------------------------- | ---------------------------- | --------- |
| **多级 Replacer 容错链**    | 9 种策略链式容错                | `fuzzyFindText` 单一模糊匹配 | ⭐⭐⭐    |
| **LSP 诊断反馈**            | 写入后反馈类型/语法错误给 AI    | ❌ 无                        | ⭐⭐⭐    |
| **写前 diff 审批**          | `ctx.ask({ permission, diff })` | ❌ 无                        | ⭐⭐⭐    |
| **`replaceAll` 参数**       | ✅ 批量替换                     | ❌ 仅唯一匹配                | ⭐⭐      |
| **FileTime 防覆盖**         | ✅                              | ✅ 已实现                    | ✅ 已对齐 |
| **文件写锁**                | `FileTime.withLock`             | ✅ `withFileLock`            | ✅ 已对齐 |
| **diff 输出 trimDiff**      | 去除公共缩进减少 token          | ❌ 完整 diff                 | ⭐        |
| **Snapshot (before/after)** | 记录 additions/deletions        | ❌                           | ⭐        |
| **oldString 为空=新建**     | ✅                              | ❌                           | ⭐        |

## 五、建议实施优先级

### P0（高价值、直接提升编辑成功率）

#### 1. 多级 Replacer 容错链

- **价值**：AI 经常搞错缩进、空白、转义字符，9 级容错可大幅减少编辑失败
- **工作量**：~300 行核心逻辑 + 测试
- **依赖**：无外部依赖
- **建议**：可直接从 opencode 移植，放在 `src/main/tools/utils/replacer.ts`
- **注意**：Generator 模式需适配到现有 edit 工具的 `fuzzyFindText`

#### 2. LSP 诊断反馈

- **价值**：形成"写→检→修"闭环，AI 可自动修复类型错误
- **工作量**：大（需集成 LSP client，或利用 IDE 现有 LSP）
- **依赖**：需要 LSP 基础设施
- **建议**：可先做轻量版（调用 `tsc --noEmit` 或 `eslint`），后续再接 LSP

### P1（中等价值）

#### 3. 写前 diff 审批

- **价值**：危险操作用户可审查，增强安全感
- **工作量**：中等（需前端 UI 配合展示 diff）
- **依赖**：前端 diff 查看器组件
- **建议**：可先实现后端 ask 机制，前端逐步跟进

#### 4. `replaceAll` 参数

- **价值**：批量重命名变量等场景
- **工作量**：~20 行
- **建议**：简单，随 Replacer 链一起实现

### P2（锦上添花）

#### 5. `trimDiff` 去除公共缩进

- **工作量**：~30 行
- **建议**：减少 diff 输出 token，对嵌套代码效果明显

#### 6. Snapshot (before/after + additions/deletions)

- **工作量**：中等
- **建议**：为后续撤销/历史功能打基础

#### 7. oldString 为空视为新建文件

- **工作量**：~10 行
- **建议**：让 edit 工具兼具 write 能力

---

## 六、参考文件路径

- opencode write: `opencode/packages/opencode/src/tool/write.ts`
- opencode edit: `opencode/packages/opencode/src/tool/edit.ts`
- opencode FileTime: `opencode/packages/opencode/src/file/time.ts`
- opencode Filesystem: `opencode/packages/opencode/src/util/filesystem.ts`
- opencode LSP: `opencode/packages/opencode/src/lsp/index.ts`
- shirobot edit: `src/main/tools/edit.ts`
- shirobot write: `src/main/tools/write.ts`
- shirobot fileTime: `src/main/tools/utils/fileTime.ts`
