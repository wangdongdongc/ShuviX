# Google Gemini 图片输出支持方案

Google Gemini 的图片生成模型（如 gemini-2.0-flash）会在响应中通过 `part.inlineData` 返回 base64 图片。但 pi-ai SDK 的 `streamGoogle` 函数只处理 `part.text` 和 `part.functionCall`，静默丢弃了 `inlineData`。

由于不能修改 pi-ai SDK，方案是：**用框架自己导出的零件组装一个补充版 Google 流函数**，仅在 `streamFn` 层替换 Google 的流处理，框架其余部分（Agent 编排、工具执行、上下文管理）完全不动。

## 核心思路

```
pi-ai SDK 零件（convertMessages, convertTools, mapStopReason, ...）
      ↓ 复用
自定义 streamGoogleWithImages()  ← 增加 part.inlineData 处理
      ↓ 替换
agent.ts streamFn 回调  ← 仅 Google API 走自定义流，其余不变
      ↓ 新增 image_data 事件
前端 store + 组件  ← 流式 + 持久化图片渲染
```

## 改动概览

### 1. 依赖声明

`package.json` 添加 `@google/genai` 为直接依赖（原为 pi-ai 的传递依赖），确保版本稳定。

### 2. 自定义 Google 流函数

**文件：** `src/main/services/googleImageStream.ts`（新建）

基于 pi-ai 导出的零件，编写支持图片的 Google 流函数：

- 复用 `convertMessages`, `convertTools`, `isThinkingPart`, `retainThoughtSignature`, `mapStopReason`, `mapToolChoice`（from `@mariozechner/pi-ai/dist/providers/google-shared.js`）
- 复用 `buildBaseOptions`, `clampReasoning`（from `@mariozechner/pi-ai/dist/providers/simple-options.js`）
- 复用 `AssistantMessageEventStream`（from `@mariozechner/pi-ai/dist/utils/event-stream.js`）
- 复用 `calculateCost`（from `@mariozechner/pi-ai/dist/models.js`）
- 使用 `@google/genai` 的 `GoogleGenAI` 创建客户端

**与原版 streamGoogle 的差异：**

1. `buildParams` 中增加 `generationConfig.responseModalities = ['TEXT', 'IMAGE']`，通知 Gemini 可以返回图片
2. 流式循环中增加 `part.inlineData` 处理分支，将图片数据存入 `output._images` 附加字段
3. 内部函数 `createClient`、`buildParams`、`sanitizeSurrogates` 从 pi-ai 源码中复刻（未导出）

**导出函数：**

```ts
export function streamGoogleWithImages(model, context, options): AssistantMessageEventStream
export function streamSimpleGoogleWithImages(model, context, options): AssistantMessageEventStream
```

### 3. Agent 服务改造

**文件：** `src/main/services/agent.ts`

**streamFn 回调**：检测 Google API，使用自定义流代替 `streamSimple`：

```ts
streamFn: (streamModel, context, options) => {
  // ...resolve apiKey, build streamOpts...
  if (streamModel.api === 'google-generative-ai') {
    return streamSimpleGoogleWithImages(streamModel, context, streamOpts)
  }
  return streamSimple(streamModel, context, streamOpts)
}
```

**streamBuffers 扩展**：类型从 `{ content: string; thinking: string }` 扩展为 `{ content: string; thinking: string; images: Array<{ data: string; mimeType: string }> }`。

**message_end 事件处理**：从 `AssistantMessage._images` 中提取图片数据，缓存到 `streamBuffer.images`，并通过 `image_data` IPC 事件实时推送到前端。

**persistStreamBuffer**：将 images 写入 `metadata.images`，格式与用户图片一致（`data:mimeType;base64,...`）。

**AgentStreamEvent 类型**：新增 `image_data` 事件类型。

### 4. 前端 Store 扩展

**文件：** `src/renderer/src/stores/chatStore.ts`

- `SessionStreamState` 新增 `images: Array<{ data: string; mimeType: string }>`
- 新增 action：`appendStreamingImage(sessionId, image)` — 追加流式图片
- `clearStreamingContent`、`finishStreaming`：同时清空 images
- 新增 selector：`selectStreamingImages`

### 5. 事件分发

**文件：** `src/renderer/src/hooks/useAgentEvents.ts`

处理新的 `image_data` 事件：

```ts
case 'image_data':
  if (event.data) {
    store.appendStreamingImage(sid, JSON.parse(event.data))
  }
  break
```

### 6. 消息气泡渲染

**文件：** `src/renderer/src/components/chat/MessageBubble.tsx`

- 新增 `streamingImages` prop，用于流式阶段实时渲染
- 在助手消息区域渲染两种图片来源：
  - **持久化图片**（`!isStreaming && parsedMeta?.images`）：页面刷新后从 metadata 加载
  - **流式图片**（`isStreaming && streamingImages`）：生成期间实时推送

### 7. 流式底部区域

**文件：** `src/renderer/src/components/chat/StreamingFooter.tsx`

- 引入 `selectStreamingImages`，传递给 `MessageBubble`
- 显示条件扩展：`streamingContent || streamingThinking || streamingImages.length > 0`

**文件：** `src/renderer/src/components/chat/ChatView.tsx`

- 引入 `selectStreamingImages` 加入自动滚动触发依赖

## 数据流

```
Google API 返回 part.inlineData
    ↓
streamGoogleWithImages 收集到 output._images
    ↓
message_end → agent.ts 提取 _images
    ↓ 实时推送                     ↓ 缓冲
image_data IPC event         streamBuffer.images
    ↓                              ↓
useAgentEvents               persistStreamBuffer
    ↓                              ↓
appendStreamingImage         metadata.images (SQLite)
    ↓                              ↓
StreamingFooter 实时渲染      MessageBubble 持久渲染
```

## 文件清单

| 文件 | 操作 |
|------|------|
| `package.json` | 添加 `@google/genai` 依赖 |
| `src/main/services/googleImageStream.ts` | 新建 |
| `src/main/services/agent.ts` | 修改 streamFn / streamBuffers / forwardEvent / persistStreamBuffer / AgentStreamEvent |
| `src/renderer/src/stores/chatStore.ts` | 扩展 SessionStreamState / 新增 action + selector |
| `src/renderer/src/hooks/useAgentEvents.ts` | 处理 image_data 事件 |
| `src/renderer/src/components/chat/MessageBubble.tsx` | 新增 streamingImages prop + 助手图片渲染 |
| `src/renderer/src/components/chat/StreamingFooter.tsx` | 传递 streamingImages，扩展显示条件 |
| `src/renderer/src/components/chat/ChatView.tsx` | streamingImages 加入滚动依赖 |

## 未来兼容

当 pi-ai 原生支持 `inlineData` 后（`streamGoogle` 处理图片、`AssistantMessage.content` 包含 `ImageContent`），只需：

1. 删除 `googleImageStream.ts`
2. 在 `streamFn` 中移除 Google 分支，回归 `streamSimple`
3. 其余前端渲染逻辑保留

## 验证方式

1. 使用 Google 内置提供商，选择 `gemini-2.0-flash` 模型
2. 发送图片生成请求（如"画一只猫"）
3. 确认：流式期间图片实时出现，完成后图片持久化在消息中
4. 刷新页面 / 重新打开会话，确认图片仍然展示（从 metadata 加载）
5. 确认非 Google 模型不受影响（仍走 `streamSimple`）
