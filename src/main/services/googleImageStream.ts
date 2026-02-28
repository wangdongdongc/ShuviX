/**
 * Google Gemini 流式函数 — 支持图片输出（inlineData）
 *
 * pi-ai SDK 的 streamGoogle 只处理 text / functionCall，静默丢弃 inlineData。
 * 本文件复用 pi-ai 导出的零件，仅在流处理层补充 inlineData 支持。
 *
 * 当 pi-ai 原生支持 inlineData 后，可删除此文件并回退到 streamSimple。
 */

import { GoogleGenAI } from '@google/genai'
import type { Content, HttpOptions, Part } from '@google/genai'
import type {
  Model,
  Api,
  Context,
  SimpleStreamOptions,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
  StopReason,
  ThinkingBudgets
} from '@mariozechner/pi-ai'
import {
  convertMessages,
  convertTools,
  isThinkingPart,
  retainThoughtSignature,
  mapStopReason,
  mapToolChoice
} from '@mariozechner/pi-ai/dist/providers/google-shared.js'
import {
  buildBaseOptions,
  clampReasoning
} from '@mariozechner/pi-ai/dist/providers/simple-options.js'
import { AssistantMessageEventStream } from '@mariozechner/pi-ai/dist/utils/event-stream.js'
import { calculateCost } from '@mariozechner/pi-ai/dist/models.js'

// Counter for generating unique tool call IDs (mirrors pi-ai implementation)
let toolCallCounter = 0

interface ThinkingOptions {
  enabled: boolean
  level?: string
  budgetTokens?: number
}

interface GoogleStreamOptions extends SimpleStreamOptions {
  thinking?: ThinkingOptions
  toolChoice?: string
  onPayload?: (payload: unknown) => void
}

type OutputContentBlock = TextContent | ThinkingContent | ImageContent | ToolCall

interface OutputMessage extends Omit<AssistantMessage, 'content' | 'stopReason'> {
  content: OutputContentBlock[]
  stopReason: StopReason
  errorMessage?: string
  _images: Array<{ data: string; mimeType: string }>
}

interface TextBlock {
  type: 'text'
  text: string
  textSignature?: string
}

interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
}

type CurrentBlock = TextBlock | ThinkingBlock

/** 剥离未配对 Unicode 代理对（与 pi-ai 内部 sanitizeSurrogates 等效） */
function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
}

/** 创建 Google GenAI 客户端（与 pi-ai 内部 createClient 等效） */
function createClient(
  model: Model<Api>,
  apiKey: string,
  optionsHeaders?: Record<string, string>
): GoogleGenAI {
  const httpOptions: HttpOptions = {}
  if (model.baseUrl) {
    httpOptions.baseUrl = model.baseUrl
    httpOptions.apiVersion = '' // baseUrl already includes version path
  }
  if (model.headers || optionsHeaders) {
    httpOptions.headers = { ...model.headers, ...optionsHeaders }
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined
  })
}

/**
 * 将 assistant 生成的图片注入到 Google API 的 contents 中。
 *
 * pi-ai 的 convertMessages 不处理 assistant content 中的 ImageContent 块，
 * 且当 assistant 消息仅含 ImageContent（无 text / thinking / toolCall）时，
 * convertMessages 不会产生对应的 model 条目（parts 为空被跳过）。
 *
 * 本函数同时处理两种情况：
 *   1. model 条目存在但缺少 inlineData → 向已有条目追加
 *   2. model 条目完全缺失（纯图片回复）→ 在正确位置插入新 model 条目
 *
 * 算法：并行遍历 agentMessages 与 contents，根据消息角色同步推进两个指针。
 * user / toolResult 消息对应 contents 中的 user 条目（推进 contentIdx）；
 * assistant 消息对应 model 条目（若缺失且有图片则 splice 插入）。
 */
function injectModelImages(agentMessages: Message[], contents: Content[]): void {
  // 图片数据（含可选的 thoughtSignature，用于 Gemini 3 thinking 模式校验）
  type ImgData = { mimeType: string; data: string; thoughtSignature?: string }

  // 收集每条 assistant 消息中的 ImageContent 块（保持出现顺序）
  const assistantImgs: Array<ImgData[]> = []
  for (const msg of agentMessages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      assistantImgs.push(
        (msg.content as Array<TextContent | ThinkingContent | ImageContent | ToolCall>)
          .filter((b): b is ImageContent => b.type === 'image' && 'data' in b && !!b.data)
          .map((b) => {
            const ext = b as ImageContent & { thoughtSignature?: string }
            return {
              mimeType: b.mimeType,
              data: b.data,
              ...(ext.thoughtSignature && { thoughtSignature: ext.thoughtSignature })
            }
          })
      )
    }
  }
  if (assistantImgs.every((a) => a.length === 0)) return

  /** 构建注入用的 Part（始终携带 thoughtSignature：有真实签名用真实签名，否则用旁路值）
   *  Gemini 3 thinking 模式要求所有 model part 包含 thoughtSignature，
   *  对于历史图片或未捕获签名的场景使用官方旁路值跳过校验。 */
  const buildImgPart = (img: ImgData): Part => ({
    inlineData: { mimeType: img.mimeType, data: img.data },
    thoughtSignature: img.thoughtSignature || 'skip_thought_signature_validator'
  })

  // 并行遍历 agentMessages 和 contents
  let ci = 0 // contents 索引
  let ai = 0 // assistantImgs 索引

  for (const msg of agentMessages) {
    if (msg.role === 'assistant') {
      const imgs = assistantImgs[ai]
      if (ci < contents.length && contents[ci].role === 'model') {
        // model 条目存在 → 注入图片（如尚未包含 inlineData）
        if (imgs.length > 0) {
          const entry = contents[ci]
          const alreadyHas = (entry.parts || []).some((p: Part) => p.inlineData)
          if (!alreadyHas) {
            entry.parts = entry.parts || []
            for (const img of imgs) {
              entry.parts.push(buildImgPart(img))
            }
          }
        }
        ci++
      } else if (imgs.length > 0) {
        // model 条目缺失（convertMessages 因 parts 为空而跳过）→ 插入新条目
        contents.splice(ci, 0, { role: 'model', parts: imgs.map(buildImgPart) })
        ci++
      }
      // 无 model 条目且无图片 → 不做任何操作（空 assistant 消息）
      ai++
    } else {
      // user / toolResult → 对应 contents 中的 user 条目
      // 仅当当前条目不是 model 时推进（避免跳过下一条 assistant 的 model 条目；
      // 连续 toolResult 合并为单条 user 条目时，第二条会自然停在 model 边界）
      if (ci < contents.length && contents[ci].role !== 'model') {
        ci++
      }
    }
  }
}

/** 构建 Google API 请求参数（与 pi-ai 内部 buildParams 等效，增加 responseModalities） */
function buildParams(
  model: Model<Api>,
  context: Context,
  options: GoogleStreamOptions = {}
): { model: string; contents: Content[]; config: Record<string, unknown> } {
  const contents = convertMessages(model as Model<'google-generative-ai'>, context)
  // 补充注入 assistant 生成的图片到 model 条目（convertMessages 可能未处理 image 块）
  injectModelImages(context.messages || [], contents)
  const generationConfig: Record<string, unknown> = {}
  if (options.temperature !== undefined) {
    generationConfig.temperature = options.temperature
  }
  if (options.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = options.maxTokens
  }

  // 开启图片输出能力：通知 Gemini 可以返回图片
  generationConfig.responseModalities = ['TEXT', 'IMAGE']

  const config: Record<string, unknown> = {
    ...(Object.keys(generationConfig).length > 0 && generationConfig),
    ...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
    ...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) })
  }
  if (context.tools && context.tools.length > 0 && options.toolChoice) {
    config.toolConfig = {
      functionCallingConfig: {
        mode: mapToolChoice(options.toolChoice)
      }
    }
  } else {
    config.toolConfig = undefined
  }
  if (options.thinking?.enabled && (model as Model<Api> & { reasoning?: boolean }).reasoning) {
    const thinkingConfig: Record<string, unknown> = { includeThoughts: true }
    if (options.thinking.level !== undefined) {
      thinkingConfig.thinkingLevel = options.thinking.level
    } else if (options.thinking.budgetTokens !== undefined) {
      thinkingConfig.thinkingBudget = options.thinking.budgetTokens
    }
    config.thinkingConfig = thinkingConfig
  }
  if (options.signal) {
    if (options.signal.aborted) {
      throw new Error('Request aborted')
    }
    config.abortSignal = options.signal
  }
  return { model: model.id, contents, config }
}

/**
 * 支持图片输出的 Google 流函数
 * 在 pi-ai 的 streamGoogle 基础上增加 part.inlineData 处理
 */
export function streamGoogleWithImages(
  model: Model<Api>,
  context: Context,
  options?: GoogleStreamOptions
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream()

  ;(async () => {
    const output: OutputMessage = {
      role: 'assistant',
      content: [],
      api: 'google-generative-ai',
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'stop',
      timestamp: Date.now(),
      _images: [] as Array<{ data: string; mimeType: string; thoughtSignature?: string }>
    }

    try {
      const apiKey = options?.apiKey || process.env.GEMINI_API_KEY || ''
      const client = createClient(model, apiKey, options?.headers)
      const params = buildParams(model, context, options)
      options?.onPayload?.(params)

      const googleStream = await client.models.generateContentStream(params)
      stream.push({
        type: 'start',
        partial: output as unknown as AssistantMessage
      } as AssistantMessageEvent)

      let currentBlock: CurrentBlock | null = null
      const blocks = output.content
      const blockIndex = (): number => blocks.length - 1

      for await (const chunk of googleStream) {
        const candidate = chunk.candidates?.[0]
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            // ─── 处理 inlineData（图片输出）─────────────────────────
            if (part.inlineData) {
              // 结束当前文本/思考块
              if (currentBlock) {
                if (currentBlock.type === 'text') {
                  stream.push({
                    type: 'text_end',
                    contentIndex: blockIndex(),
                    content: currentBlock.text,
                    partial: output as unknown as AssistantMessage
                  } as AssistantMessageEvent)
                } else {
                  stream.push({
                    type: 'thinking_end',
                    contentIndex: blockIndex(),
                    content: currentBlock.thinking,
                    partial: output as unknown as AssistantMessage
                  } as AssistantMessageEvent)
                }
                currentBlock = null
              }
              // 收集图片数据（含 thoughtSignature，用于后续注入时满足 Gemini 3 校验）
              const imgMime = part.inlineData.mimeType || 'image/png'
              const imgData = part.inlineData.data || ''
              const imgThoughtSig = part.thoughtSignature
              output._images.push({ data: imgData, mimeType: imgMime, ...(imgThoughtSig && { thoughtSignature: imgThoughtSig }) })
              // 同时写入 content，以便后续轮次 convertMessages 能包含图片上下文
              output.content.push({ type: 'image', data: imgData, mimeType: imgMime })
              continue
            }

            // ─── 处理文本 / 思考（与 pi-ai 原始逻辑一致）─────────────
            if (part.text !== undefined) {
              const isThinking = isThinkingPart(part)
              if (
                !currentBlock ||
                (isThinking && currentBlock.type !== 'thinking') ||
                (!isThinking && currentBlock.type !== 'text')
              ) {
                if (currentBlock) {
                  if (currentBlock.type === 'text') {
                    stream.push({
                      type: 'text_end',
                      contentIndex: blocks.length - 1,
                      content: currentBlock.text,
                      partial: output as unknown as AssistantMessage
                    } as AssistantMessageEvent)
                  } else {
                    stream.push({
                      type: 'thinking_end',
                      contentIndex: blockIndex(),
                      content: currentBlock.thinking,
                      partial: output as unknown as AssistantMessage
                    } as AssistantMessageEvent)
                  }
                }
                if (isThinking) {
                  currentBlock = { type: 'thinking', thinking: '', thinkingSignature: undefined }
                  output.content.push(currentBlock)
                  stream.push({
                    type: 'thinking_start',
                    contentIndex: blockIndex(),
                    partial: output as unknown as AssistantMessage
                  } as AssistantMessageEvent)
                } else {
                  currentBlock = { type: 'text', text: '' }
                  output.content.push(currentBlock)
                  stream.push({
                    type: 'text_start',
                    contentIndex: blockIndex(),
                    partial: output as unknown as AssistantMessage
                  } as AssistantMessageEvent)
                }
              }
              if (currentBlock.type === 'thinking') {
                currentBlock.thinking += part.text
                currentBlock.thinkingSignature = retainThoughtSignature(
                  currentBlock.thinkingSignature,
                  part.thoughtSignature
                )
                stream.push({
                  type: 'thinking_delta',
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output as unknown as AssistantMessage
                } as AssistantMessageEvent)
              } else {
                currentBlock.text += part.text
                currentBlock.textSignature = retainThoughtSignature(
                  currentBlock.textSignature,
                  part.thoughtSignature
                )
                stream.push({
                  type: 'text_delta',
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output as unknown as AssistantMessage
                } as AssistantMessageEvent)
              }
            }

            // ─── 处理工具调用（与 pi-ai 原始逻辑一致）─────────────
            if (part.functionCall) {
              if (currentBlock) {
                if (currentBlock.type === 'text') {
                  stream.push({
                    type: 'text_end',
                    contentIndex: blockIndex(),
                    content: currentBlock.text,
                    partial: output as unknown as AssistantMessage
                  } as AssistantMessageEvent)
                } else {
                  stream.push({
                    type: 'thinking_end',
                    contentIndex: blockIndex(),
                    content: currentBlock.thinking,
                    partial: output as unknown as AssistantMessage
                  } as AssistantMessageEvent)
                }
                currentBlock = null
              }
              const providedId = part.functionCall.id
              const needsNewId =
                !providedId ||
                output.content.some(
                  (b: OutputContentBlock) =>
                    b.type === 'toolCall' && (b as ToolCall).id === providedId
                )
              const toolCallId = needsNewId
                ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
                : providedId
              const toolCall: ToolCall = {
                type: 'toolCall',
                id: toolCallId!,
                name: part.functionCall.name || '',
                arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
                ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature })
              }
              output.content.push(toolCall)
              stream.push({
                type: 'toolcall_start',
                contentIndex: blockIndex(),
                partial: output as unknown as AssistantMessage
              } as AssistantMessageEvent)
              stream.push({
                type: 'toolcall_delta',
                contentIndex: blockIndex(),
                delta: JSON.stringify(toolCall.arguments),
                partial: output as unknown as AssistantMessage
              } as AssistantMessageEvent)
              stream.push({
                type: 'toolcall_end',
                contentIndex: blockIndex(),
                toolCall,
                partial: output as unknown as AssistantMessage
              } as AssistantMessageEvent)
            }
          }
        }
        if (candidate?.finishReason) {
          output.stopReason = mapStopReason(candidate.finishReason)
          if (output.content.some((b: OutputContentBlock) => b.type === 'toolCall')) {
            output.stopReason = 'toolUse'
          }
        }
        if (chunk.usageMetadata) {
          const um = chunk.usageMetadata
          output.usage = {
            input: um.promptTokenCount || 0,
            output: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
            cacheRead: um.cachedContentTokenCount || 0,
            cacheWrite: 0,
            totalTokens: um.totalTokenCount || 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
          calculateCost(model, output.usage)
        }
      }

      // 结束最后一个块
      if (currentBlock) {
        if (currentBlock.type === 'text') {
          stream.push({
            type: 'text_end',
            contentIndex: blockIndex(),
            content: currentBlock.text,
            partial: output as unknown as AssistantMessage
          } as AssistantMessageEvent)
        } else {
          stream.push({
            type: 'thinking_end',
            contentIndex: blockIndex(),
            content: currentBlock.thinking,
            partial: output as unknown as AssistantMessage
          } as AssistantMessageEvent)
        }
      }

      if (options?.signal?.aborted) {
        throw new Error('Request was aborted')
      }
      if (output.stopReason === 'aborted' || output.stopReason === 'error') {
        throw new Error('An unknown error occurred')
      }

      stream.push({
        type: 'done',
        reason: output.stopReason,
        message: output as unknown as AssistantMessage
      } as AssistantMessageEvent)
      stream.end()
    } catch (error: unknown) {
      for (const block of output.content) {
        if ('index' in block) {
          delete (block as Record<string, unknown>).index
        }
      }
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error)
      stream.push({
        type: 'error',
        reason: output.stopReason as 'aborted' | 'error',
        error: output as unknown as AssistantMessage
      } as AssistantMessageEvent)
      stream.end()
    }
  })()

  return stream
}

/** Gemini 3 思考级别映射（与 pi-ai 内部逻辑一致） */
function getGemini3ThinkingLevel(effort: string, model: Model<Api>): string {
  if (model.id.includes('3-pro')) {
    switch (effort) {
      case 'minimal':
      case 'low':
        return 'LOW'
      case 'medium':
      case 'high':
        return 'HIGH'
    }
  }
  switch (effort) {
    case 'minimal':
      return 'MINIMAL'
    case 'low':
      return 'LOW'
    case 'medium':
      return 'MEDIUM'
    case 'high':
      return 'HIGH'
  }
  return 'MEDIUM'
}

/** Google 思考预算（与 pi-ai 内部逻辑一致） */
function getGoogleBudget(
  model: Model<Api>,
  effort: string,
  customBudgets?: ThinkingBudgets
): number {
  if (customBudgets?.[effort] !== undefined) {
    return customBudgets[effort]
  }
  if (model.id.includes('2.5-pro')) {
    const budgets: Record<string, number> = { minimal: 128, low: 2048, medium: 8192, high: 32768 }
    return budgets[effort] ?? -1
  }
  if (model.id.includes('2.5-flash')) {
    const budgets: Record<string, number> = { minimal: 128, low: 2048, medium: 8192, high: 24576 }
    return budgets[effort] ?? -1
  }
  return -1
}

/**
 * Simple 模式的 Google 图片流函数（对标 pi-ai 的 streamSimpleGoogle）
 * 处理 reasoning 配置后委托给 streamGoogleWithImages
 */
export function streamSimpleGoogleWithImages(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const apiKey = options?.apiKey || process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`)
  }
  const base = buildBaseOptions(model, options, apiKey)
  if (!options?.reasoning) {
    return streamGoogleWithImages(model, context, { ...base, thinking: { enabled: false } })
  }
  const effort = clampReasoning(options.reasoning)
  if (model.id.includes('3-pro') || model.id.includes('3-flash')) {
    return streamGoogleWithImages(model, context, {
      ...base,
      thinking: {
        enabled: true,
        level: getGemini3ThinkingLevel(effort!, model)
      }
    })
  }
  return streamGoogleWithImages(model, context, {
    ...base,
    thinking: {
      enabled: true,
      budgetTokens: getGoogleBudget(model, effort!, options.thinkingBudgets)
    }
  })
}
