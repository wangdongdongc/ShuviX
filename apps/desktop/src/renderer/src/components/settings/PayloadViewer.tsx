import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  ChevronDown,
  Image,
  Wrench,
  MessageSquare,
  Bot,
  User,
  Settings,
  Code
} from 'lucide-react'

interface ContentBlock {
  type?: string
  text?: string
  image_url?: { url?: string }
  media_type?: string
  mimeType?: string
  data?: string
  functionCall?: { name?: string; args?: unknown; arguments?: unknown }
  functionResponse?: { name?: string; response?: unknown }
  name?: string
  arguments?: unknown
  [key: string]: unknown
}

interface ToolCallEntry {
  function?: { name?: string; arguments?: unknown }
  name?: string
  arguments?: unknown
  args?: unknown
  [key: string]: unknown
}

interface NormalizedMessage {
  role: string
  content?: unknown
  tool_calls?: ToolCallEntry[]
  tool_call_id?: string
  name?: string
  [key: string]: unknown
}

interface ToolDefinition {
  function?: {
    name?: string
    description?: string
    parameters?: unknown
  }
  name?: string
  description?: string
  parameters?: unknown
  [key: string]: unknown
}

interface GeminiPart {
  text?: string
  inlineData?: { mimeType?: string; data?: string }
  functionCall?: { name?: string; args?: unknown }
  functionResponse?: { name?: string; response?: unknown }
}

interface GeminiContent {
  role?: string
  parts?: GeminiPart[]
}

interface GeminiConfig {
  systemInstruction?: string | { parts?: Array<{ text?: string }> }
  tools?: Array<{
    functionDeclarations?: Array<{ name?: string; description?: string; parameters?: unknown }>
  }>
  [key: string]: unknown
}

interface ResponseData {
  content?: ContentBlock[]
  images?: Array<{ data: string; mimeType: string }>
  [key: string]: unknown
}

/** 内容块（tool_use / tool_result / thinking 等）的统一卡片底色 */
const CARD_GRAY = 'rounded-lg border border-border-secondary/50 bg-bg-tertiary/30 p-2'

/** 计算值编码为 UTF-8 后的字节数（payload 实际传输尺寸） */
const byteEncoder = new TextEncoder()
function byteSize(value: unknown): number {
  if (value === null || value === undefined) return 0
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  return byteEncoder.encode(s).length
}

/** 格式化字节数为易读形式 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * 体积条 —— 按本请求内最大条目归一。把「谁把上下文撑爆了」从读数字变成看形状，
 * 这正是这份日志存在的理由（请求体是全量快照，逐步落盘让库 O(N²) 膨胀）。
 */
function SizeBar({ ratio, large }: { ratio: number; large: boolean }): React.JSX.Element {
  return (
    <span className="shrink-0 w-[84px] h-[3px] rounded-full bg-bg-hover overflow-hidden">
      <span
        className={`block h-full rounded-full ${large ? 'bg-error' : 'bg-text-tertiary/60'}`}
        style={{ width: `${Math.max(2, Math.round(ratio * 100))}%` }}
      />
    </span>
  )
}

/**
 * 展开区里的一行 —— 消息与工具定义共用同一套行文法：
 * 箭头 · 图标 · 标签 · 体积条 · 字节 · 摘要 · 徽章；就地展开，不再套 Section/卡片。
 * label 自带宽度与配色（角色是定宽大写，工具名是等宽），行文法才对得齐。
 */
function DisclosureRow({
  icon,
  label,
  size,
  ratio,
  large,
  summary,
  badge,
  children
}: {
  icon: React.ReactNode
  label: React.ReactNode
  size: number
  ratio: number
  large: boolean
  summary: string
  badge?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-border-secondary/30 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2 px-1 py-1.5 text-left transition-colors ${
          open ? 'bg-bg-hover/30' : 'hover:bg-bg-hover/40'
        }`}
      >
        <span className="shrink-0 w-3 inline-flex justify-center text-text-tertiary">
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </span>
        <span className="shrink-0 inline-flex items-center">{icon}</span>
        {label}
        <SizeBar ratio={ratio} large={large} />
        <span
          className={`shrink-0 w-[54px] text-right text-[10px] tabular-nums ${
            large ? 'text-error' : 'text-text-tertiary'
          }`}
        >
          {formatBytes(size)}
        </span>
        <span className="flex-1 min-w-0 text-[11px] text-text-secondary truncate">{summary}</span>
        {badge}
      </button>
      {open && <div className="pl-6 pr-1 pb-3 pt-1">{children}</div>}
    </div>
  )
}

/** 角色图标 */
function roleIcon(role: string): React.ReactNode {
  const size = 12
  switch (role) {
    case 'system':
    case 'developer':
      return <Settings size={size} className="text-yellow-400" />
    case 'user':
      return <User size={size} className="text-blue-400" />
    case 'assistant':
      return <Bot size={size} className="text-green-400" />
    case 'tool':
      return <Wrench size={size} className="text-orange-400" />
    default:
      return <MessageSquare size={size} className="text-text-tertiary" />
  }
}

/** 角色标签颜色 */
function roleLabelColor(role: string): string {
  switch (role) {
    case 'system':
    case 'developer':
      return 'text-yellow-400'
    case 'user':
      return 'text-blue-400'
    case 'assistant':
      return 'text-green-400'
    case 'tool':
      return 'text-orange-400'
    default:
      return 'text-text-tertiary'
  }
}

/** 截断文本 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '…'
}

/** 从 content 中提取摘要文本 */
function extractSummary(content: unknown): {
  text: string
  hasImage: boolean
  hasToolCall: boolean
} {
  if (typeof content === 'string') {
    return { text: content.replace(/\n/g, ' '), hasImage: false, hasToolCall: false }
  }
  if (!Array.isArray(content)) {
    return { text: JSON.stringify(content), hasImage: false, hasToolCall: false }
  }

  let text = ''
  let hasImage = false
  let hasToolCall = false

  for (const block of content) {
    if ((block.type === 'text' || block.type === 'input_text') && block.text) {
      text += block.text + ' '
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      text += block.thinking + ' '
    } else if (
      block.type === 'image_url' ||
      block.type === 'image' ||
      block.type === 'input_image'
    ) {
      hasImage = true
    } else if (
      block.type === 'tool_call' ||
      block.type === 'toolCall' ||
      block.type === 'tool_use'
    ) {
      hasToolCall = true
      const name = (block.name as string) || '?'
      text += `→ ${name}(...) `
    } else if (block.type === 'tool_result') {
      hasToolCall = true
      const c = block.content
      if (typeof c === 'string') {
        text += c + ' '
      } else if (Array.isArray(c)) {
        for (const sub of c as ContentBlock[]) {
          if (sub.type === 'text' && sub.text) text += sub.text + ' '
        }
      }
    }
  }

  return { text: text.replace(/\n/g, ' ').trim(), hasImage, hasToolCall }
}

/** 提取 tool_calls 摘要 */
function extractToolCallsSummary(toolCalls: ToolCallEntry[]): string {
  return toolCalls
    .map((tc) => {
      const name = tc.function?.name || tc.name || '?'
      return `→ ${name}(...)`
    })
    .join(', ')
}

/** 渲染消息的完整内容 */
function MessageContent({
  content,
  toolCalls,
  toolCallId,
  name,
  t
}: {
  content: unknown
  toolCalls?: ToolCallEntry[]
  toolCallId?: string
  name?: string
  t: (key: string) => string
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      {/* tool result 的 tool_call_id */}
      {toolCallId && (
        <div className="text-[10px] text-text-tertiary">
          tool_call_id: <code className="bg-bg-tertiary px-1 py-0.5 rounded">{toolCallId}</code>
        </div>
      )}
      {name && (
        <div className="text-[10px] text-text-tertiary">
          name: <code className="bg-bg-tertiary px-1 py-0.5 rounded">{name}</code>
        </div>
      )}
      {/* content 部分 */}
      {typeof content === 'string' ? (
        <pre className="text-[11px] text-text-primary whitespace-pre-wrap break-words leading-relaxed">
          {content}
        </pre>
      ) : Array.isArray(content) ? (
        content.map((block: ContentBlock, i: number) => (
          <ContentBlockView key={i} block={block} t={t} />
        ))
      ) : content !== null && content !== undefined ? (
        <pre className="text-[11px] text-text-primary whitespace-pre-wrap break-words leading-relaxed">
          {JSON.stringify(content, null, 2)}
        </pre>
      ) : null}
      {/* tool_calls 部分 */}
      {toolCalls && toolCalls.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-text-tertiary font-medium">tool_calls:</div>
          {toolCalls.map((tc: ToolCallEntry, i: number) => (
            <div key={i} className={CARD_GRAY}>
              <div className="text-[11px] text-orange-400 font-medium">
                {tc.function?.name || tc.name || '?'}
              </div>
              <pre className="mt-1 text-[10px] text-text-secondary whitespace-pre-wrap break-words">
                {JSON.stringify(tc.function?.arguments || tc.arguments || tc.args, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 渲染单个 content block */
function ContentBlockView({
  block,
  t
}: {
  block: ContentBlock
  t: (key: string) => string
}): React.JSX.Element {
  if (block.type === 'text' || block.type === 'input_text') {
    return (
      <pre className="text-[11px] text-text-primary whitespace-pre-wrap break-words leading-relaxed">
        {block.text}
      </pre>
    )
  }
  if (block.type === 'image_url') {
    const url = block.image_url?.url || ''
    // 检测是否为 base64 data URL
    if (url.startsWith('data:image/')) {
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-1 text-[10px] text-purple-400">
            <Image size={10} />
            <span>
              {t('settings.payloadImage')} ({Math.round(url.length / 1024)}KB base64)
            </span>
          </div>
          <img
            src={url}
            alt="图片"
            className="max-w-[200px] max-h-[150px] rounded-md border border-border-primary object-contain"
          />
        </div>
      )
    }
    return (
      <div className="flex items-center gap-1 text-[10px] text-purple-400">
        <Image size={10} />
        <span className="break-all">{truncate(url, 100)}</span>
      </div>
    )
  }
  if (block.type === 'image') {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1 text-[10px] text-purple-400">
          <Image size={10} />
          <span>
            {t('settings.payloadImage')} ({block.media_type || block.mimeType || 'image'})
          </span>
        </div>
        {block.data && (
          <img
            src={`data:${block.media_type || block.mimeType || 'image/png'};base64,${block.data}`}
            alt="图片"
            className="max-w-[200px] max-h-[150px] rounded-md border border-border-primary object-contain"
          />
        )}
      </div>
    )
  }
  // Google Gemini: functionCall block
  if (block.type === 'functionCall' || block.functionCall) {
    const fc = block.functionCall || block
    return (
      <div className={CARD_GRAY}>
        <div className="text-[11px] text-orange-400 font-medium">{fc.name || '?'}</div>
        <pre className="mt-1 text-[10px] text-text-secondary whitespace-pre-wrap break-words">
          {JSON.stringify(fc.args || fc.arguments, null, 2)}
        </pre>
      </div>
    )
  }
  // Google Gemini: functionResponse block
  if (block.type === 'functionResponse' || block.functionResponse) {
    const fr = block.functionResponse || block
    return (
      <div className={CARD_GRAY}>
        <div className="text-[11px] text-green-400 font-medium">
          {'← '}
          {fr.name || '?'}
        </div>
        <pre className="mt-1 text-[10px] text-text-secondary whitespace-pre-wrap break-words">
          {JSON.stringify(fr.response, null, 2)}
        </pre>
      </div>
    )
  }
  // Anthropic: thinking block
  if (block.type === 'thinking') {
    return (
      <div className={CARD_GRAY}>
        <div className="text-[10px] text-purple-400 font-medium mb-1">thinking</div>
        <pre className="text-[11px] text-text-secondary whitespace-pre-wrap break-words leading-relaxed">
          {(block.thinking as string) || ''}
        </pre>
      </div>
    )
  }
  // Anthropic: tool_use block
  if (block.type === 'tool_use') {
    return (
      <div className={CARD_GRAY}>
        <div className="text-[11px] text-orange-400 font-medium">
          → {(block.name as string) || '?'}
          {block.id ? (
            <span className="ml-1 text-[10px] text-text-tertiary">({String(block.id)})</span>
          ) : null}
        </div>
        <pre className="mt-1 text-[10px] text-text-secondary whitespace-pre-wrap break-words">
          {JSON.stringify(block.input ?? block.arguments, null, 2)}
        </pre>
      </div>
    )
  }
  // Anthropic: tool_result block
  if (block.type === 'tool_result') {
    const c = block.content
    const isError = block.is_error === true
    return (
      <div className={CARD_GRAY}>
        <div className={`text-[11px] font-medium ${isError ? 'text-red-400' : 'text-green-400'}`}>
          ← tool_result
          {block.tool_use_id ? (
            <span className="ml-1 text-[10px] text-text-tertiary">
              ({String(block.tool_use_id)})
            </span>
          ) : null}
          {isError && <span className="ml-1 text-[10px] text-red-400">error</span>}
        </div>
        {typeof c === 'string' ? (
          <pre className="mt-1 text-[10px] text-text-secondary whitespace-pre-wrap break-words">
            {c}
          </pre>
        ) : Array.isArray(c) ? (
          <div className="mt-1 space-y-1">
            {(c as ContentBlock[]).map((sub, i) => (
              <ContentBlockView key={i} block={sub} t={t} />
            ))}
          </div>
        ) : (
          <pre className="mt-1 text-[10px] text-text-secondary whitespace-pre-wrap break-words">
            {JSON.stringify(c, null, 2)}
          </pre>
        )}
      </div>
    )
  }
  // 其他类型 fallback
  return (
    <pre className="text-[10px] text-text-tertiary whitespace-pre-wrap break-words">
      {JSON.stringify(block, null, 2)}
    </pre>
  )
}

/** 请求参数 —— 一行 chips，取代原先整块折叠的「基本参数」 */
function ParamChips({ data }: { data: Record<string, unknown> }): React.JSX.Element | null {
  const entries = Object.entries(data).filter(
    ([key]) => key !== 'messages' && key !== 'tools' && key !== 'system' && key !== 'input'
  )
  if (entries.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([key, value]) => (
        <span
          key={key}
          className="inline-flex items-center gap-1 rounded-md border border-border-secondary/50 px-1.5 py-0.5 text-[10px] font-mono"
        >
          <span className="text-text-tertiary">{key}</span>
          <span className="text-text-secondary break-all">
            {truncate(typeof value === 'object' ? JSON.stringify(value) : String(value), 40)}
          </span>
        </span>
      ))}
    </div>
  )
}

/** 单个工具定义（与消息同一套行文法） */
function ToolRow({ tool, maxSize }: { tool: ToolDefinition; maxSize: number }): React.JSX.Element {
  const fn = tool.function || tool
  const name = fn.name || '?'
  const desc = fn.description || ''
  const size = byteSize(tool)
  return (
    <DisclosureRow
      icon={<Code size={12} className="text-orange-400" />}
      label={
        <span className="shrink-0 w-[120px] text-[10px] font-mono text-orange-400 truncate">
          {name}
        </span>
      }
      size={size}
      ratio={size / Math.max(1, maxSize)}
      large={false}
      summary={truncate(desc, 80)}
    >
      <div className="space-y-2">
        {desc && <div className="text-[11px] text-text-secondary leading-relaxed">{desc}</div>}
        {fn.parameters != null && (
          <pre className="text-[10px] text-text-secondary whitespace-pre-wrap break-words bg-bg-tertiary rounded-md p-2">
            {JSON.stringify(fn.parameters, null, 2)}
          </pre>
        )}
      </div>
    </DisclosureRow>
  )
}

/**
 * 将 OpenAI Responses API 格式（input 数组）归一化为标准 messages 结构。
 * GPT-5.x 等新模型使用 `input` 代替 `messages`，content block 使用 `input_text` 等类型。
 */
function normalizeOpenAIResponsesPayload(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'input') {
      result[key] = value
    }
  }

  const input = raw.input as Array<Record<string, unknown>> | undefined
  if (input) {
    const messages: NormalizedMessage[] = []
    let pendingToolCalls: ToolCallEntry[] = []

    /** 将累积的 function_call 打包为一条 assistant 消息 */
    const flushToolCalls = (): void => {
      if (pendingToolCalls.length > 0) {
        messages.push({ role: 'assistant', tool_calls: pendingToolCalls })
        pendingToolCalls = []
      }
    }

    /** 归一化 content 块中的类型（input_text → text 等） */
    const normalizeContent = (content: unknown): unknown => {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return content
      return (content as ContentBlock[]).map((block) => {
        if (block.type === 'input_text') return { type: 'text', text: block.text }
        if (block.type === 'input_image') {
          return {
            type: 'image_url',
            image_url: { url: (block as Record<string, unknown>).image_url || '' }
          }
        }
        if (block.type === 'input_audio') return { type: 'text', text: '[audio]' }
        return block
      })
    }

    for (const item of input) {
      const itemType = item.type as string | undefined

      if (itemType === 'function_call') {
        // 累积工具调用
        let args = item.arguments
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args)
          } catch {
            /* keep raw string */
          }
        }
        pendingToolCalls.push({
          function: { name: item.name as string, arguments: args }
        })
      } else if (itemType === 'function_call_output') {
        // 先 flush 累积的工具调用，再添加工具结果
        flushToolCalls()
        messages.push({
          role: 'tool',
          tool_call_id: (item.call_id as string) || undefined,
          content: (item.output as string) || ''
        })
      } else if (item.role) {
        // 普通消息（developer / user / assistant）
        flushToolCalls()
        const msg: NormalizedMessage = { role: item.role as string }
        msg.content = normalizeContent(item.content)
        messages.push(msg)
      } else {
        // 其他类型（reasoning 等）跳过或作为 assistant 消息展示
        flushToolCalls()
        if (itemType) {
          messages.push({ role: 'assistant', content: `[${itemType}]` })
        }
      }
    }

    flushToolCalls()
    result.messages = messages
  }

  return result
}

/**
 * 将 Google Gemini 格式的 payload 归一化为 OpenAI/Anthropic 兼容结构，
 * 使现有的 Messages / Tools / BasicParams 渲染逻辑可以复用。
 */
function normalizeGooglePayload(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  // 保留除 contents / config 以外的顶层字段（如 model）
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'contents' && key !== 'config') {
      result[key] = value
    }
  }

  // 将 config 内非特殊字段提升到顶层
  const config = (raw.config || {}) as GeminiConfig
  const configReservedKeys = new Set(['systemInstruction', 'tools'])
  for (const [key, value] of Object.entries(config)) {
    if (!configReservedKeys.has(key)) {
      result[key] = value
    }
  }

  // ---- 消息归一化 ----
  const messages: NormalizedMessage[] = []

  const sysInstr = config.systemInstruction
  if (sysInstr) {
    let sysText: string
    if (typeof sysInstr === 'string') {
      sysText = sysInstr
    } else {
      const parts: Array<{ text?: string }> = sysInstr.parts || []
      sysText = parts
        .map((p: { text?: string }) => p.text || '')
        .filter(Boolean)
        .join('\n')
    }
    if (sysText) {
      messages.push({ role: 'system', content: sysText })
    }
  }

  for (const item of (raw.contents || []) as GeminiContent[]) {
    const role = item.role === 'model' ? 'assistant' : item.role || 'user'
    const parts: GeminiPart[] = item.parts || []

    const contentBlocks: ContentBlock[] = []
    const toolCalls: ToolCallEntry[] = []
    const toolResponses: Array<{ name?: string; response?: unknown }> = []

    for (const part of parts) {
      if (part.text !== undefined) {
        contentBlocks.push({ type: 'text', text: part.text })
      } else if (part.inlineData) {
        contentBlocks.push({
          type: 'image',
          mimeType: part.inlineData.mimeType,
          data: part.inlineData.data
        })
      } else if (part.functionCall) {
        toolCalls.push({
          function: {
            name: part.functionCall.name,
            arguments: part.functionCall.args
          }
        })
      } else if (part.functionResponse) {
        toolResponses.push(part.functionResponse)
      }
    }

    for (const resp of toolResponses) {
      messages.push({
        role: 'tool',
        name: resp.name,
        content:
          typeof resp.response === 'string' ? resp.response : JSON.stringify(resp.response, null, 2)
      })
    }

    if (contentBlocks.length > 0 || toolCalls.length > 0) {
      const msg: NormalizedMessage = { role }
      if (
        contentBlocks.length === 1 &&
        contentBlocks[0].type === 'text' &&
        toolCalls.length === 0
      ) {
        msg.content = contentBlocks[0].text
      } else if (contentBlocks.length > 0) {
        msg.content = contentBlocks
      }
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls
      }
      messages.push(msg)
    }

    if (contentBlocks.length === 0 && toolCalls.length === 0 && toolResponses.length === 0) {
      messages.push({ role, content: '' })
    }
  }

  result.messages = messages

  // ---- 工具定义归一化 ----
  const tools: ToolDefinition[] = []
  for (const group of config.tools || []) {
    for (const decl of group.functionDeclarations || []) {
      tools.push({
        function: {
          name: decl.name,
          description: decl.description,
          parameters: decl.parameters
        }
      })
    }
  }
  if (tools.length > 0) {
    result.tools = tools
  }

  return result
}

/** AI 响应内容（原先套在「响应」Section 里，现在由次要入口就地展开） */
function ResponseBody({
  data,
  t
}: {
  data: ResponseData
  t: (key: string) => string
}): React.JSX.Element {
  const content: ContentBlock[] = data.content || []
  const images: Array<{ data: string; mimeType: string }> = data.images || []
  const textBlocks = content.filter((b: ContentBlock) => b.type === 'text' && b.text)
  const toolCalls = content.filter((b: ContentBlock) => b.type === 'toolCall')

  return (
    <div className="space-y-1.5">
      {textBlocks.map((block: ContentBlock, i: number) => (
        <pre
          key={i}
          className="text-[11px] text-text-primary whitespace-pre-wrap break-words leading-relaxed"
        >
          {block.text}
        </pre>
      ))}

      {toolCalls.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-text-tertiary font-medium">tool_calls:</div>
          {toolCalls.map((tc: ContentBlock, i: number) => (
            <div key={i} className={CARD_GRAY}>
              <div className="text-[11px] text-orange-400 font-medium">{tc.name || '?'}</div>
              <pre className="mt-1 text-[10px] text-text-secondary whitespace-pre-wrap break-words">
                {JSON.stringify(tc.arguments, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}

      {images.map((img, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center gap-1 text-[10px] text-purple-400">
            <Image size={10} />
            <span>
              {t('settings.payloadImage')} ({img.mimeType || 'image'})
            </span>
          </div>
          <img
            src={`data:${img.mimeType || 'image/png'};base64,${img.data}`}
            alt="AI generated"
            className="max-w-[300px] max-h-[300px] rounded-md border border-border-primary object-contain"
          />
        </div>
      ))}

      {textBlocks.length === 0 && toolCalls.length === 0 && images.length === 0 && (
        <div className="text-[11px] text-text-tertiary">{t('settings.payloadEmpty')}</div>
      )}
    </div>
  )
}

/**
 * HTTP 日志 Payload 结构化查看器
 * 将 JSON 请求体解析为可折叠的结构化视图
 */
export function PayloadViewer({
  payload,
  response
}: {
  payload: string
  response?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)
  // 次要入口同时只开一个（工具定义与响应都可能很长）
  const [extra, setExtra] = useState<'tools' | 'response' | null>(null)

  const parsed = useMemo(() => {
    try {
      const raw = JSON.parse(payload)
      // 检测 Google Gemini 格式并归一化
      const isGoogleFormat = Array.isArray(raw.contents) || raw.config?.systemInstruction
      if (isGoogleFormat) return normalizeGooglePayload(raw)
      // 检测 OpenAI Responses API 格式（input 数组代替 messages）
      const isResponsesFormat = Array.isArray(raw.input) && !raw.messages
      if (isResponsesFormat) return normalizeOpenAIResponsesPayload(raw)
      return raw
    } catch {
      return null
    }
  }, [payload])

  const parsedResponse = useMemo(() => {
    if (!response) return null
    try {
      return JSON.parse(response)
    } catch {
      return null
    }
  }, [response])

  // 解析失败，回退到原始文本
  if (!parsed || typeof parsed !== 'object') {
    return (
      <pre className="w-full min-h-[260px] rounded-lg border border-border-primary bg-bg-tertiary p-3 text-[11px] leading-relaxed text-text-primary overflow-auto whitespace-pre-wrap break-words">
        {payload}
      </pre>
    )
  }

  const messages = (parsed.messages || []) as NormalizedMessage[]
  const tools = (parsed.tools || []) as ToolDefinition[]
  const systemBlocks: NormalizedMessage[] = parsed.system
    ? typeof parsed.system === 'string'
      ? [{ role: 'system', content: parsed.system }]
      : [{ role: 'system', content: parsed.system }]
    : []
  const allMessages = [...systemBlocks, ...messages]

  if (showRaw) {
    return (
      <div className="space-y-2">
        <button
          onClick={() => setShowRaw(false)}
          className="text-[11px] text-accent hover:text-accent-hover transition-colors"
        >
          {t('settings.payloadBackToStructured')}
        </button>
        <pre className="w-full min-h-[260px] rounded-lg border border-border-primary bg-bg-tertiary p-3 text-[11px] leading-relaxed text-text-primary overflow-auto whitespace-pre-wrap break-words">
          {payload}
        </pre>
      </div>
    )
  }

  const messageSizes = allMessages.map((m) => byteSize(m))
  const messagesTotal = messageSizes.reduce((a, b) => a + b, 0)
  const maxMessageSize = Math.max(1, ...messageSizes)
  const toolSizes = tools.map((tool) => byteSize(tool))
  const toolsTotal = toolSizes.reduce((a, b) => a + b, 0)
  const maxToolSize = Math.max(1, ...toolSizes)

  return (
    <div className="space-y-3">
      {/* 请求参数 */}
      <ParamChips data={parsed} />

      {/* 消息 —— 直接铺成行，不再套 Section */}
      <div>
        <div className="flex items-center gap-1.5 px-1 pb-1 text-[10px] text-text-tertiary">
          <span>{t('settings.payloadMessages')}</span>
          <span className="tabular-nums">({allMessages.length})</span>
          <span className="opacity-40">·</span>
          <span className="tabular-nums">{formatBytes(messagesTotal)}</span>
        </div>
        <div className="border-t border-border-secondary/30">
          {allMessages.length === 0 ? (
            <div className="px-1 py-2 text-[11px] text-text-tertiary">
              {t('settings.payloadNoMessages')}
            </div>
          ) : (
            allMessages.map((msg: NormalizedMessage, i: number) => {
              const role = msg.role || 'unknown'
              const { text, hasImage, hasToolCall } = extractSummary(msg.content)
              const toolCallsSummary = msg.tool_calls ? extractToolCallsSummary(msg.tool_calls) : ''
              const summary = toolCallsSummary || truncate(text || t('settings.payloadEmpty'), 120)
              const size = messageSizes[i]
              // 相对最大消息 ≥50% 的视为"异常大"，条与字节一起标红帮助定位
              const large = size / maxMessageSize >= 0.5 && size >= 10 * 1024

              return (
                <DisclosureRow
                  key={i}
                  icon={roleIcon(role)}
                  label={
                    <span
                      className={`shrink-0 w-[64px] text-[10px] font-semibold uppercase truncate ${roleLabelColor(role)}`}
                    >
                      {role}
                    </span>
                  }
                  size={size}
                  ratio={size / maxMessageSize}
                  large={large}
                  summary={summary}
                  badge={
                    <>
                      {hasImage && (
                        <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] bg-purple-500/15 text-purple-400">
                          <Image size={9} /> {t('settings.payloadImage')}
                        </span>
                      )}
                      {(hasToolCall || msg.tool_calls) && (
                        <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] bg-orange-500/15 text-orange-400">
                          <Wrench size={9} /> {t('settings.payloadTool')}
                        </span>
                      )}
                    </>
                  }
                >
                  <MessageContent
                    content={msg.content}
                    toolCalls={msg.tool_calls}
                    toolCallId={msg.tool_call_id}
                    name={msg.name}
                    t={t}
                  />
                </DisclosureRow>
              )
            })
          )}
        </div>
      </div>

      {/* 次要入口：工具定义 / 响应 / 原始 JSON —— 一行，点开就地展开 */}
      <div className="flex items-center gap-3 flex-wrap text-[11px]">
        {tools.length > 0 && (
          <ExtraEntry
            active={extra === 'tools'}
            onClick={() => setExtra(extra === 'tools' ? null : 'tools')}
          >
            {t('settings.payloadToolDefs')} ({tools.length}) · {formatBytes(toolsTotal)}
          </ExtraEntry>
        )}
        {parsedResponse && (
          <ExtraEntry
            active={extra === 'response'}
            onClick={() => setExtra(extra === 'response' ? null : 'response')}
          >
            {t('settings.payloadResponse')}
          </ExtraEntry>
        )}
        <ExtraEntry active={false} onClick={() => setShowRaw(true)}>
          {t('settings.payloadViewRawJson')}
        </ExtraEntry>
      </div>

      {extra === 'tools' && (
        <div className="border-t border-border-secondary/30">
          {tools.map((tool: ToolDefinition, i: number) => (
            <ToolRow key={i} tool={tool} maxSize={maxToolSize} />
          ))}
        </div>
      )}
      {extra === 'response' && parsedResponse && (
        <div className="border-t border-border-secondary/30 pt-2">
          <ResponseBody data={parsedResponse} t={t} />
        </div>
      )}
    </div>
  )
}

/** 次要入口按钮（工具定义 / 响应 / 原始 JSON） */
function ExtraEntry({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`transition-colors ${
        active ? 'text-accent' : 'text-text-tertiary hover:text-text-secondary'
      }`}
    >
      {children}
    </button>
  )
}
