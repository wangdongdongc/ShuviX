import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Code, FileText } from 'lucide-react'
import mermaid from 'mermaid'

// 初始化 mermaid（暗色主题，禁用自动启动）
mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  securityLevel: 'loose',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif'
})

// 模块级缓存：组件频繁重挂载时保持 SVG 渲染结果和视图状态
const mermaidSvgCache = new Map<string, string>()
const mermaidViewState = new Map<string, boolean>() // code → showSource
let mermaidIdCounter = 0

/** 代码块容器 — 带语言标签和复制按钮 */
export function CodeBlock({ node, children, ...props }: any): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  // 从 hast 节点提取语言名称
  const codeNode = node?.children?.[0] as any
  const cls = codeNode?.properties?.className
  const lang = (() => {
    if (!cls) return ''
    const arr = Array.isArray(cls) ? cls : [cls]
    const match = arr.find((c: string) => c.startsWith('language-'))
    return match ? match.replace('language-', '') : ''
  })()

  // 递归提取 hast 节点中的纯文本（用于复制）
  const extractText = (n: any): string => {
    if (n.type === 'text') return n.value || ''
    if (n.children) return n.children.map(extractText).join('')
    return ''
  }
  const rawCode = codeNode ? extractText(codeNode).replace(/\n$/, '') : ''

  // 检测 mermaid
  if (lang === 'mermaid' && rawCode) {
    return <MermaidBlock code={rawCode} />
  }

  const handleCopy = (): void => {
    navigator.clipboard.writeText(rawCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative group/code my-2">
      {/* 语言标签 + 复制按钮 */}
      <div className="flex items-center justify-between px-3 py-1 text-[10px] text-text-tertiary border border-border-primary border-b-0 rounded-t-lg bg-bg-tertiary/80">
        <span className="font-medium uppercase tracking-wider">{lang || 'code'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 hover:text-text-secondary transition-colors"
        >
          {copied ? <Check size={10} className="text-success" /> : <Copy size={10} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre {...props}>
        {children}
      </pre>
    </div>
  )
}

/** Mermaid 代码块 → SVG 图表，支持源码/图表切换（懒渲染） */
function MermaidBlock({ code }: { code: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [svgHtml, setSvgHtml] = useState<string | null>(mermaidSvgCache.get(code) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [showSource, _setShowSource] = useState(mermaidViewState.get(code) ?? true)
  const [rendering, setRendering] = useState(false)

  // 包装 setShowSource，同步写入模块级缓存
  const setShowSource = (v: boolean): void => {
    mermaidViewState.set(code, v)
    _setShowSource(v)
  }

  // 点击"图表"按钮时触发渲染
  const handleToggle = async (): Promise<void> => {
    if (!showSource) {
      setShowSource(true)
      return
    }
    // 首次切换到图表视图时渲染
    if (!svgHtml && !error) {
      setRendering(true)
      try {
        const id = `mermaid_${mermaidIdCounter++}`
        const { svg } = await mermaid.render(id, code)
        mermaidSvgCache.set(code, svg)
        setSvgHtml(svg)
      } catch (e) {
        setError(String(e))
      } finally {
        setRendering(false)
      }
    }
    setShowSource(false)
  }

  if (error) {
    return (
      <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
        <div className="text-[10px] text-orange-400 mb-1">{t('message.mermaidFailed')}</div>
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
          onClick={handleToggle}
          disabled={rendering}
          className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors disabled:opacity-50"
          title={showSource ? t('message.showDiagram') : t('message.source')}
        >
          {showSource ? <FileText size={10} /> : <Code size={10} />}
          <span>{rendering ? t('message.rendering') : showSource ? t('message.diagram') : t('message.source')}</span>
        </button>
      </div>
      {showSource ? (
        <pre className="p-3 text-[11px] text-text-secondary whitespace-pre-wrap break-words leading-relaxed font-mono overflow-auto">{code}</pre>
      ) : (
        <div
          className="flex justify-center overflow-auto p-3 bg-white rounded-b-lg [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svgHtml || '' }}
        />
      )}
    </div>
  )
}
