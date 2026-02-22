import { useState, useMemo } from 'react'
import { ChevronRight, ChevronDown, Image, Wrench, MessageSquare, Bot, User, Settings, Code } from 'lucide-react'

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
          {open ? <ChevronDown size={10} className="text-text-tertiary" /> : <ChevronRight size={10} className="text-text-tertiary" />}
        </span>
        <span className="flex-shrink-0 mt-0.5">{icon}</span>
        <span className={`flex-shrink-0 text-[10px] font-semibold uppercase mt-px ${labelColor}`}>{label}</span>
        {badge}
        <span className="flex-1 min-w-0 text-[11px] text-text-secondary truncate">{summary}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-[52px]">
          {children}
        </div>
      )}
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
function extractSummary(content: unknown): { text: string; hasImage: boolean; hasToolCall: boolean } {
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
function extractToolCallsSummary(toolCalls: any[]): string {
  return toolCalls.map((tc) => {
    const name = tc.function?.name || tc.name || '?'
    return `→ ${name}(...)`
  }).join(', ')
}

/** 渲染消息的完整内容 */
function MessageContent({ content, toolCalls, toolCallId, name }: { content: unknown; toolCalls?: any[]; toolCallId?: string; name?: string }): React.JSX.Element {
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
        <pre className="text-[11px] text-text-primary whitespace-pre-wrap break-words leading-relaxed">{content}</pre>
      ) : Array.isArray(content) ? (
        content.map((block: any, i: number) => (
          <ContentBlock key={i} block={block} />
        ))
      ) : content !== null && content !== undefined ? (
        <pre className="text-[11px] text-text-primary whitespace-pre-wrap break-words leading-relaxed">{JSON.stringify(content, null, 2)}</pre>
      ) : null}
      {/* tool_calls 部分 */}
      {toolCalls && toolCalls.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-text-tertiary font-medium">tool_calls:</div>
          {toolCalls.map((tc: any, i: number) => (
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
function ContentBlock({ block }: { block: any }): React.JSX.Element {
  if (block.type === 'text') {
    return (
      <pre className="text-[11px] text-text-primary whitespace-pre-wrap break-words leading-relaxed">{block.text}</pre>
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
            <span>图片 ({Math.round(url.length / 1024)}KB base64)</span>
          </div>
          <img src={url} alt="图片" className="max-w-[200px] max-h-[150px] rounded-md border border-border-primary object-contain" />
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
          <span>图片 ({block.media_type || block.mimeType || 'image'})</span>
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
  // 其他类型 fallback
  return (
    <pre className="text-[10px] text-text-tertiary whitespace-pre-wrap break-words">{JSON.stringify(block, null, 2)}</pre>
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
function ToolItem({ tool }: { tool: any }): React.JSX.Element {
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
      {fn.parameters && (
        <pre className="text-[10px] text-text-secondary whitespace-pre-wrap break-words bg-bg-tertiary rounded-md p-2">
          {JSON.stringify(fn.parameters, null, 2)}
        </pre>
      )}
      {!fn.parameters && desc && (
        <div className="text-[11px] text-text-secondary">{desc}</div>
      )}
    </CollapsibleItem>
  )
}

/**
 * HTTP 日志 Payload 结构化查看器
 * 将 JSON 请求体解析为可折叠的结构化视图
 */
export function PayloadViewer({ payload }: { payload: string }): React.JSX.Element {
  const [showRaw, setShowRaw] = useState(false)

  const parsed = useMemo(() => {
    try {
      return JSON.parse(payload)
    } catch {
      return null
    }
  }, [payload])

  // 解析失败，回退到原始文本
  if (!parsed || typeof parsed !== 'object') {
    return (
      <pre className="w-full min-h-[260px] rounded-lg border border-border-primary bg-bg-tertiary p-3 text-[11px] leading-relaxed text-text-primary overflow-auto whitespace-pre-wrap break-words">
        {payload}
      </pre>
    )
  }

  const messages: any[] = parsed.messages || []
  const tools: any[] = parsed.tools || []
  // Anthropic 格式的 system 字段
  const systemBlocks: any[] = parsed.system
    ? (typeof parsed.system === 'string' ? [{ role: 'system', content: parsed.system }] : [{ role: 'system', content: parsed.system }])
    : []
  const allMessages = [...systemBlocks, ...messages]

  if (showRaw) {
    return (
      <div className="space-y-2">
        <button
          onClick={() => setShowRaw(false)}
          className="text-[11px] text-accent hover:text-accent-hover transition-colors"
        >
          ← 返回结构化视图
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
      <Section title="基本参数">
        <BasicParams data={parsed} />
      </Section>

      {/* 消息列表 */}
      <Section title="消息列表" count={allMessages.length} defaultOpen>
        {allMessages.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-text-tertiary">无消息</div>
        ) : (
          allMessages.map((msg: any, i: number) => {
            const role = msg.role || 'unknown'
            const { text, hasImage, hasToolCall } = extractSummary(msg.content)
            const toolCallsSummary = msg.tool_calls ? extractToolCallsSummary(msg.tool_calls) : ''
            const summary = toolCallsSummary || truncate(text || '(空)', 80)

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
                        <Image size={9} /> 图片
                      </span>
                    )}
                    {(hasToolCall || msg.tool_calls) && (
                      <span className="flex-shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] bg-orange-500/15 text-orange-400">
                        <Wrench size={9} /> 工具
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
                />
              </CollapsibleItem>
            )
          })
        )}
      </Section>

      {/* 工具定义 */}
      {tools.length > 0 && (
        <Section title="工具定义" count={tools.length}>
          {tools.map((tool: any, i: number) => (
            <ToolItem key={i} tool={tool} />
          ))}
        </Section>
      )}

      {/* 原始 JSON 切换 */}
      <button
        onClick={() => setShowRaw(true)}
        className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors"
      >
        查看原始 JSON →
      </button>
    </div>
  )
}
