import { memo, useState, useEffect, useRef, useId } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import mermaid from 'mermaid'
import { User, Bot, Copy, Check, Code, FileText, RotateCcw, RefreshCw } from 'lucide-react'

// 初始化 mermaid（暗色主题，禁用自动启动）
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif'
})

/** Mermaid 代码块 → SVG 图表，支持源码/图表切换 */
function MermaidBlock({ code }: { code: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const uniqueId = useId().replace(/:/g, '_')

  useEffect(() => {
    let cancelled = false
    const render = async (): Promise<void> => {
      try {
        const { svg } = await mermaid.render(`mermaid${uniqueId}`, code)
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    }
    render()
    return () => { cancelled = true }
  }, [code, uniqueId])

  if (error) {
    return (
      <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
        <div className="text-[10px] text-orange-400 mb-1">Mermaid 渲染失败</div>
        <pre className="text-[11px] text-text-secondary whitespace-pre-wrap break-words">{code}</pre>
      </div>
    )
  }

  return (
    <div className="my-2 rounded-lg border border-border-primary bg-bg-tertiary/50 overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-primary bg-bg-tertiary/80">
        <span className="text-[10px] text-text-tertiary font-medium">Mermaid</span>
        <button
          onClick={() => setShowSource(!showSource)}
          className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          title={showSource ? '显示图表' : '显示源码'}
        >
          {showSource ? <FileText size={10} /> : <Code size={10} />}
          <span>{showSource ? '图表' : '源码'}</span>
        </button>
      </div>
      {/* 内容区：两个视图始终挂载，CSS 控制显隐，避免切换时丢失已渲染的 SVG */}
      <pre className={`p-3 text-[11px] text-text-secondary whitespace-pre-wrap break-words leading-relaxed font-mono overflow-auto ${showSource ? '' : 'hidden'}`}>{code}</pre>
      <div
        ref={containerRef}
        className={`flex justify-center overflow-auto p-3 bg-white rounded-b-lg [&_svg]:max-w-full ${showSource ? 'hidden' : ''}`}
      />
    </div>
  )
}

interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  metadata?: string | null
  isStreaming?: boolean
  /** 回退到此消息（删除之后的所有消息） */
  onRollback?: () => void
  /** 重新生成此消息（仅助手消息） */
  onRegenerate?: () => void
}

/**
 * 消息气泡 — 渲染用户和助手消息
 * 助手消息使用 Markdown 渲染，支持代码高亮
 */
export const MessageBubble = memo(function MessageBubble({
  role,
  content,
  metadata,
  isStreaming,
  onRollback,
  onRegenerate
}: MessageBubbleProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  const isUser = role === 'user'

  // 从 metadata 解析思考过程
  const thinking = (() => {
    if (!metadata) return null
    try {
      const parsed = JSON.parse(metadata)
      return parsed.thinking || null
    } catch { return null }
  })()

  /** 复制消息内容 */
  const handleCopy = (): void => {
    navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className={`group flex gap-3 px-4 py-3 ${isUser ? '' : 'bg-bg-secondary/30'}`}>
      {/* 头像 */}
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5 ${
          isUser
            ? 'bg-accent/20 text-accent'
            : 'bg-bg-tertiary text-text-secondary'
        }`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>

      {/* 消息内容 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-text-secondary">
            {isUser ? '你' : 'ShiroBot'}
          </span>
          {/* 复制按钮 */}
          {!isStreaming && content && (
            <button
              onClick={handleCopy}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title="复制"
            >
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
            </button>
          )}
          {/* 切换原始文本 / Markdown 渲染 */}
          {!isUser && !isStreaming && content && (
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title={showRaw ? '显示渲染' : '显示源码'}
            >
              {showRaw ? <FileText size={12} /> : <Code size={12} />}
            </button>
          )}
          {/* 回退到此处 */}
          {!isStreaming && onRollback && (
            <button
              onClick={onRollback}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title="回退到此处"
            >
              <RotateCcw size={12} />
            </button>
          )}
          {/* 重新生成 */}
          {!isUser && !isStreaming && onRegenerate && (
            <button
              onClick={onRegenerate}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-tertiary hover:text-text-secondary transition-opacity"
              title="重新生成"
            >
              <RefreshCw size={12} />
            </button>
          )}
        </div>

        {isUser ? (
          /* 用户消息：文本 + 图片 */
          <div>
            {/* 图片展示 */}
            {(() => {
              if (!metadata) return null
              try {
                const parsed = JSON.parse(metadata)
                if (!parsed.images?.length) return null
                return (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {parsed.images.map((img: { preview: string; mimeType: string }, idx: number) => (
                      <img
                        key={idx}
                        src={img.preview}
                        alt={`附图 ${idx + 1}`}
                        className="max-w-[240px] max-h-[180px] rounded-lg border border-border-primary object-contain cursor-pointer hover:opacity-90 transition-opacity"
                        onClick={() => window.api.app.openImage(img.preview)}
                      />
                    ))}
                  </div>
                )
              } catch { return null }
            })()}
            <div className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
              {content}
            </div>
          </div>
        ) : (
          <>
            {/* 思考过程（可折叠） */}
            {thinking && (
              <details className="group mb-2">
                <summary className="cursor-pointer select-none text-xs text-text-tertiary hover:text-text-secondary flex items-center gap-1.5 py-1">
                  <svg className="w-3 h-3 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  <span>已深度思考</span>
                </summary>
                <div className="mt-1 ml-4.5 pl-3 border-l-2 border-purple-500/30 text-xs text-text-tertiary leading-relaxed whitespace-pre-wrap max-h-[300px] overflow-y-auto">
                  {thinking}
                </div>
              </details>
            )}
            {/* 助手消息：Markdown 渲染 / 原始文本 */}
            {showRaw ? (
              <pre className="text-sm text-text-primary whitespace-pre-wrap break-words leading-relaxed font-mono bg-bg-tertiary/50 rounded-lg p-3 border border-border-primary overflow-auto">
                {content}
              </pre>
            ) : (
              <div className="markdown-body text-sm">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight, rehypeRaw]}
                  components={{
                    pre({ node, children, ...props }) {
                      // 从 hast 节点检测 mermaid 代码块
                      const codeNode = node?.children?.[0] as any
                      if (codeNode?.tagName === 'code') {
                        const cls = codeNode.properties?.className
                        const isMermaid = Array.isArray(cls)
                          ? cls.some((c: string) => c === 'language-mermaid')
                          : typeof cls === 'string' && cls.includes('language-mermaid')
                        if (isMermaid) {
                          // 递归提取 hast 节点中的纯文本
                          const extractText = (n: any): string => {
                            if (n.type === 'text') return n.value || ''
                            if (n.children) return n.children.map(extractText).join('')
                            return ''
                          }
                          const code = extractText(codeNode).replace(/\n$/, '')
                          if (code) return <MermaidBlock code={code} />
                        }
                      }
                      return <pre {...props}>{children}</pre>
                    }
                  }}
                >
                  {content}
                </ReactMarkdown>
                {/* 流式输出光标 */}
                {isStreaming && (
                  <span className="inline-block w-2 h-4 ml-0.5 bg-accent/70 animate-pulse rounded-sm" />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
})
