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

/** 可折叠区块 */
function Section({
  title,
  count,
  defaultOpen = false,
  children
}: {
  title: string
  count?: number
  defaultOpen?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-border-primary rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-text-primary bg-bg-tertiary hover:bg-bg-hover transition-colors"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{title}</span>
        {count !== undefined && (
          <span className="ml-1 text-[10px] text-text-tertiary font-normal">({count})</span>
        )}
      </button>
      {open && <div className="border-t border-border-primary">{children}</div>}
    </div>
  )
}

/** 单条可折叠项（消息 / 工具定义） */
function CollapsibleItem({
  icon,
  label,
  labelColor,
  summary,
  badge,
  children
}: {
  icon: React.ReactNode
  label: string
  labelColor: string
  summary: string
  badge?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-border-primary last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-bg-hover/50 transition-colors"
      >
        <span className="flex-shrink-0 mt-0.5">
          {open ? (
            <ChevronDown size={10} className="text-text-tertiary" />
          ) : (
            <ChevronRight size={10} className="text-text-tertiary" />
          )}
        </span>
        <span className="flex-shrink-0 mt-0.5">{icon}</span>
        <span className={`flex-shrink-0 text-[10px] font-semibold uppercase mt-px ${labelColor}`}>
          {label}
        </span>
        {badge}
        <span className="flex-1 min-w-0 text-[11px] text-text-secondary truncate">{summary}</span>
      </button>
      {open && <div className="px-3 pb-3 pl-[52px]">{children}</div>}
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
    if (block.type === 'text' && block.text) {
      text += block.text + ' '
    } else if (block.type === 'image_url' || block.type === 'image') {
      hasImage = true
    } else if (block.type === 'tool_call' || block.type === 'toolCall') {
      hasToolCall = true
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
            <div key={i} className="bg-bg-tertiary rounded-md p-2">
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
  if (block.type === 'text') {
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
      <div className="bg-bg-tertiary rounded-md p-2">
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
      <div className="bg-bg-tertiary rounded-md p-2">
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
  // 其他类型 fallback
  return (
    <pre className="text-[10px] text-text-tertiary whitespace-pre-wrap break-words">
      {JSON.stringify(block, null, 2)}
    </pre>
  )
}

/** 渲染基本参数（排除 messages 和 tools） */
function BasicParams({ data }: { data: Record<string, unknown> }): React.JSX.Element {
  const filtered = Object.entries(data).filter(
    ([key]) => key !== 'messages' && key !== 'tools' && key !== 'system'
  )
  return (
    <div className="px-3 py-2 space-y-1">
      {filtered.map(([key, value]) => (
        <div key={key} className="flex items-start gap-2 text-[11px]">
          <span className="flex-shrink-0 text-text-tertiary font-mono w-[160px]">{key}</span>
          <span className="text-text-primary break-all">
            {typeof value === 'object' ? JSON.stringify(value) : String(value)}
          </span>
        </div>
      ))}
    </div>
  )
}

/** 渲染单个工具定义 */
function ToolItem({ tool }: { tool: ToolDefinition }): React.JSX.Element {
  const fn = tool.function || tool
  const name = fn.name || '?'
  const desc = fn.description || ''
  return (
    <CollapsibleItem
      icon={<Code size={12} className="text-orange-400" />}
      label={name}
      labelColor="text-orange-400"
      summary={truncate(desc, 60)}
    >
      <div className="space-y-2">
        {desc && <div className="text-[11px] text-text-secondary leading-relaxed">{desc}</div>}
        {fn.parameters != null && (
          <pre className="text-[10px] text-text-secondary whitespace-pre-wrap break-words bg-bg-tertiary rounded-md p-2">
            {JSON.stringify(fn.parameters, null, 2)}
          </pre>
        )}
      </div>
    </CollapsibleItem>
  )
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

/** AI 响应内容区块 */
function ResponseSection({
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
    <Section title={t('settings.payloadResponse')} defaultOpen>
      {/* 文本内容 */}
      {textBlocks.length > 0 && (
        <div className="px-3 py-2 space-y-1.5">
          {textBlocks.map((block: ContentBlock, i: number) => (
            <pre
              key={i}
              className="text-[11px] text-text-primary whitespace-pre-wrap break-words leading-relaxed"
            >
              {block.text}
            </pre>
          ))}
        </div>
      )}
      {/* 工具调用 */}
      {toolCalls.length > 0 && (
        <div className="px-3 py-2 space-y-1.5">
          <div className="text-[10px] text-text-tertiary font-medium">tool_calls:</div>
          {toolCalls.map((tc: ContentBlock, i: number) => (
            <div key={i} className="bg-bg-tertiary rounded-md p-2">
              <div className="text-[11px] text-orange-400 font-medium">{tc.name || '?'}</div>
              <pre className="mt-1 text-[10px] text-text-secondary whitespace-pre-wrap break-words">
                {JSON.stringify(tc.arguments, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
      {/* AI 生成的图片 */}
      {images.length > 0 && (
        <div className="px-3 py-2 space-y-2">
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
        </div>
      )}
      {/* 空响应 */}
      {textBlocks.length === 0 && toolCalls.length === 0 && images.length === 0 && (
        <div className="px-3 py-2 text-[11px] text-text-tertiary">{t('settings.payloadEmpty')}</div>
      )}
    </Section>
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

  const parsed = useMemo(() => {
    try {
      const raw = JSON.parse(payload)
      // 检测 Google Gemini 格式并归一化
      const isGoogleFormat = Array.isArray(raw.contents) || raw.config?.systemInstruction
      return isGoogleFormat ? normalizeGooglePayload(raw) : raw
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

  return (
    <div className="space-y-2">
      {/* 基本参数 */}
      <Section title={t('settings.payloadBasicParams')}>
        <BasicParams data={parsed} />
      </Section>

      {/* 消息列表 */}
      <Section title={t('settings.payloadMessages')} count={allMessages.length} defaultOpen>
        {allMessages.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-text-tertiary">
            {t('settings.payloadNoMessages')}
          </div>
        ) : (
          allMessages.map((msg: NormalizedMessage, i: number) => {
            const role = msg.role || 'unknown'
            const { text, hasImage, hasToolCall } = extractSummary(msg.content)
            const toolCallsSummary = msg.tool_calls ? extractToolCallsSummary(msg.tool_calls) : ''
            const summary = toolCallsSummary || truncate(text || t('settings.payloadEmpty'), 80)

            return (
              <CollapsibleItem
                key={i}
                icon={roleIcon(role)}
                label={role}
                labelColor={roleLabelColor(role)}
                summary={summary}
                badge={
                  <>
                    {hasImage && (
                      <span className="flex-shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] bg-purple-500/15 text-purple-400">
                        <Image size={9} /> {t('settings.payloadImage')}
                      </span>
                    )}
                    {(hasToolCall || msg.tool_calls) && (
                      <span className="flex-shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] bg-orange-500/15 text-orange-400">
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
              </CollapsibleItem>
            )
          })
        )}
      </Section>

      {/* 工具定义 */}
      {tools.length > 0 && (
        <Section title={t('settings.payloadToolDefs')} count={tools.length}>
          {tools.map((tool: ToolDefinition, i: number) => (
            <ToolItem key={i} tool={tool} />
          ))}
        </Section>
      )}

      {/* AI 响应内容 */}
      {parsedResponse && <ResponseSection data={parsedResponse} t={t} />}

      {/* 原始 JSON 切换 */}
      <button
        onClick={() => setShowRaw(true)}
        className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
      >
        {t('settings.payloadViewRawJson')}
      </button>
    </div>
  )
}
