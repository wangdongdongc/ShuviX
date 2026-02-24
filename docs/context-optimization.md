# 上下文优化方案

利用 pi-agent-core 内置的 `transformContext` 钩子，在每次 LLM 调用前自动压缩历史上下文，防止 token 爆炸。

## 问题分析

当前 `agent.state.messages` 无限累积，30 次工具调用的场景下：
- 每次工具结果最大 50KB（`DEFAULT_MAX_BYTES`），但全部保留在上下文中
- 每次 LLM 调用都发送 **全量历史**，input tokens 随轮次线性增长
- 最终单次对话消耗上百万 tokens

## 核心设计

### 1. `transformContext` 钩子（pi-agent-core 原生支持）

```typescript
// agent.d.ts 已声明：
transformContext?: (messages: AgentMessage[], signal?) => Promise<AgentMessage[]>
```

在 `createAgent` 时传入此钩子，每次 LLM 调用前自动执行。**不修改 `agent.state.messages` 原始数据**，仅影响发送给 LLM 的副本。

### 2. 三层压缩策略

第一层、第二层**每次 LLM 调用都执行**（近乎无损）；第三层仅在超过上下文窗口阈值时执行（有损）。

按消息的**倒数位置**（而非 user 消息轮次）判断是否压缩，以适配单条用户消息触发几十次工具调用的 Agent 工作流。

#### 第一层：压缩旧 tool_result（始终执行，高收益）

保留最近 **6 个** `toolResult` 消息的完整内容，其余全部截断为摘要：
- 保留前 3 行 + 末尾 2 行 + `[... 已省略 X 行，原始 Y 字符 ...]`
- 仅压缩 text 内容超过 500 字符的 toolResult
- 对应的 `tool_call` 消息（参数）保持不变

**为什么有效**：工具结果是 token 消耗大户（单个最大 50KB），但 LLM 通常只需要最近几个工具结果来保持连贯性。

#### 第二层：移除旧的 thinking 内容（始终执行）

保留最近 **1 条**含 thinking 的 assistant 消息，其余全部移除 `{ type: 'thinking' }` 块。

**为什么有效**：thinking 内容可能很长（尤其是 extended thinking 模式），但对后续推理没有价值。

#### 第三层：滑动窗口截断（仅超阈值时执行）

如果前两层压缩后仍超过阈值（`contextWindow * 0.75`），保留第一条 user 消息 + 最近 **20 条**消息，从第二条消息开始逐条丢弃直到降到阈值以下。

### 3. Token 估算（js-tiktoken）

引入 `js-tiktoken`（OpenAI 官方纯 JS 实现，~3MB，无原生依赖）：
- 使用 `cl100k_base` 编码器（GPT-4/Claude/Gemini 通用，误差 5-15%）
- 首次加载词表 ~50ms，后续编码万级 token <5ms
- 封装 `countTokens(messages)` 递归遍历 `AgentMessage.content` 累加

阈值 = `model.contextWindow * 0.75`（留 25% 给输出 + system prompt + 安全边际）

## 实现详情

### 文件变更

| 文件 | 变更 |
|---|---|
| `src/main/services/contextManager.ts` | **新建**，实现 `transformContext` + token 估算 + 三层压缩 |
| `src/main/services/agent.ts` | 在 `new Agent({...})` 中传入 `transformContext` 钩子 |

### 关键参数（可配置常量）

```
KEEP_RECENT_TOOL_RESULTS = 6  // 保留最近 6 个 toolResult 不压缩
KEEP_RECENT_THINKING = 1      // 保留最近 1 条 assistant 的 thinking
CONTEXT_RATIO = 0.75           // 上下文窗口使用比例（第三层阈值）
KEEP_RECENT_MESSAGES = 20     // 滑动窗口保留的最近消息条数
SUMMARY_HEAD_LINES = 3        // 压缩后保留的头部行数
SUMMARY_TAIL_LINES = 2        // 压缩后保留的尾部行数
```

## 方案优势

- **零 UI 变更** — 纯后端逻辑
- **对 agent.ts 侵入极小** — 仅新增 1 个构造参数
- **不修改原始消息** — `transformContext` 操作副本，原始 `state.messages` 和 DB 数据不变
- **渐进式降级** — 三层策略逐级生效，优先保留信息完整性
- **利用框架原生能力** — `transformContext` 是 pi-agent-core 官方 API，无 hack
