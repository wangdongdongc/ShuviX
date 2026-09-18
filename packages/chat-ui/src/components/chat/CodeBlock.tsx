import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Code, FileText } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import { getHostApi } from '../../api/chatApi'
import { useChatStore } from '../../stores/chatStore'
import { sanitizeAuthoredSvg, sanitizeRenderedSvg } from '@shuvix/chat-protocol/utils/svgSanitize'
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

/** 手写 SVG 的净化结果缓存（净化是纯函数，同一段源码恒得同一结果）；'' = 判死 */
const authoredSvgCache = new Map<string, string>()
/** 手写 SVG 的视图状态：code → showSource（缺省为图，与 mermaid 相反，见 AuthoredSvgBlock） */
const authoredViewState = new Map<string, boolean>()

/** 开标签已闭合 —— 拿到它才知道 viewBox */
const SVG_OPEN_TAG_RE = /<svg\b[^>]*>/i

/** 自闭合根 `<svg …/>`（贪婪的 [^>]* 会回溯，属性值里的 `/` 不会误判成自闭合） */
const SVG_SELF_CLOSING_RE = /<svg\b[^>]*\/>/i

/**
 * 这段源码写完了没有 —— 决定要不要缓存净化结果、以及判死时要不要出错误卡。
 * 自闭合根也算写完：它永远等不到 `</svg>`，不认的话会永久停在一张空图卡上。
 */
const isSvgComplete = (code: string): boolean =>
  /<\/svg\s*>/i.test(code) || SVG_SELF_CLOSING_RE.test(code)

/**
 * 流式期间可渲染的那一帧 —— 不可渲染时返回 null。
 *
 * **图是一笔一笔画出来的，这是刻意的**：源码逐字符流进来，每一帧都画，用户就看着图长出来。
 * 这不是省下来的复杂度，是这条载体最好的一点 —— 一次性的图本该像在被画，而不是先给你一屏
 * path 数据、末尾再啪地换成成品。
 *
 * 但「每一帧都画」只有卡在对的边界上才成立，两处会抽：
 *
 *  1. **`viewBox` 还没写完**（`<svg viewBox="0 0 32`）—— 属性不完整等于没有 viewBox，
 *     整张图先按错的比例画一遍，等属性写全再跳一次。所以门开在**开标签闭合**那一刻，
 *     不是第一个字符。附带的好处比避开跳变更大：viewBox 一确定，卡片的宽高比就定了，
 *     于是从第一帧起高度就不再变 —— 整个流式过程零布局位移。
 *  2. **尾部半截的元素**（`<rect x="10" y=`）—— 切到最后一个完整标签为止，补上 `</svg>`
 *     交给解析器收尾；没闭合的 `<g>` 它自己会补。于是每一帧都是结构完整的一张图。
 *
 * 判定是 code 的纯函数，不需要知道当前是否正在流式输出：开标签未闭合就落回普通代码块，
 * 于是「模型写坏了、开标签都没写完」也停在源码可见的状态。
 */
export function authoredSvgFrame(code: string): string | null {
  const open = SVG_OPEN_TAG_RE.exec(code)
  if (!open) return null
  if (isSvgComplete(code)) return code // 已完成：整段交出去
  const cut = code.lastIndexOf('>')
  // 至少要含整个开标签；恰好只有开标签时这一帧是张空图 —— 正是用来占住位置的第一帧
  if (cut < open.index + open[0].length - 1) return null
  return `${code.slice(0, cut + 1)}</svg>`
}

/**
 * 该围栏要不要按图渲染 —— 分发判定，导出以便单测（组件本身要 DOM，判定不要）。
 * 大小写敏感与 mermaid 那档保持一致：提示词教的是小写，两档在这点上不该有分歧。
 */
export const svgFenceIsRenderable = (lang: string, code: string): boolean =>
  lang === 'svg' && authoredSvgFrame(code) !== null

/**
 * ```artifact 围栏体 → 要展示的那件 artifact 的名字；不是引用围栏、或围栏体是空的就 null。
 *
 * 只取**第一行**：围栏里只该有一个名字（对话里留下的是一行名字，不是几 KB 源码），多出来的
 * 行是模型把说明写进了围栏。空体不渲染引用 —— 流式期间围栏刚开、名字还没写出来时也走这条，
 * 否则会先闪一张「找不到」卡。大小写敏感与 ```svg 那档一致（提示词教的是小写）。
 *
 * 组件本身要 DOM，判定不要 —— 所以和 svgFenceIsRenderable 一样单独导出。
 */
export function artifactRefName(lang: string, code: string): string | null {
  if (lang !== 'artifact') return null
  const first = code.trim().split('\n')[0].trim()
  return first || null
}

/**
 * 取到的内容要不要按 SVG 内联（否则落 `<pre>` 源码分支）。
 *
 * 判定卡在「第一个非空白字符就是 `<svg`」：于是以 `<?xml …?>` 声明开头的 SVG 会落到文本
 * 分支 —— **这是现状，钉住它**，别让人以为带 XML 声明的图也会被画出来。
 */
export const artifactRefIsSvg = (content: string): boolean => /^\s*<svg\b/i.test(content)

interface HastNode {
  type: string
  value?: string
  children?: HastNode[]
  properties?: Record<string, unknown>
}

/** 代码块容器 — 带复制按钮 */
export function CodeBlock({
  node,
  children,
  ...props
}: {
  node?: HastNode
  children?: React.ReactNode
  [key: string]: unknown
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  // 从 hast 节点提取语言名称
  const codeNode = node?.children?.[0] as HastNode | undefined
  const cls = codeNode?.properties?.className
  const lang = (() => {
    if (!cls) return ''
    const arr = Array.isArray(cls) ? cls : [cls]
    const match = arr.find((c: string) => c.startsWith('language-'))
    return match ? match.replace('language-', '') : ''
  })()

  // 递归提取 hast 节点中的纯文本（用于复制）
  const extractText = (n: HastNode): string => {
    if (n.type === 'text') return n.value || ''
    if (n.children) return n.children.map(extractText).join('')
    return ''
  }
  const rawCode = codeNode ? extractText(codeNode).replace(/\n$/, '') : ''

  // 检测 mermaid
  if (lang === 'mermaid' && rawCode) {
    return <MermaidBlock code={rawCode} />
  }

  // 手写 SVG 图：开标签一闭合就开始逐帧画，之前落到下方的普通代码块（见 authoredSvgFrame）
  if (svgFenceIsRenderable(lang, rawCode)) {
    return <AuthoredSvgBlock code={rawCode} />
  }

  // 会话 Artifact 的引用：围栏里只有一个名字，内容现取（见 ArtifactRefBlock）
  const artifactName = artifactRefName(lang, rawCode)
  if (artifactName) {
    return <ArtifactRefBlock name={artifactName} />
  }

  const handleCopy = (): void => {
    copyToClipboard(rawCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative group/code my-2">
      {/* 右上角悬浮:只有复制按钮,常态完全隐藏,指到代码块才出现(边框同时显形)。
          语言标签和两枚胶囊底色随代码块改成描边一起去掉了 —— 块本身空了之后,
          带底色的角标反而成了框里最实的东西。lang 仍用于 mermaid 判定。
          focus-visible 也显形:opacity-0 的按钮仍可被 Tab 聚焦,不然键盘用户
          会停在一个看不见的控件上。 */}
      <button
        onClick={handleCopy}
        className="absolute top-1.5 right-1.5 z-10 p-0.5 text-text-tertiary opacity-0 hover:text-text-secondary group-hover/code:opacity-100 focus-visible:opacity-100 transition"
        title={copied ? 'Copied' : 'Copy'}
      >
        {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
      </button>
      <pre {...props}>{children}</pre>
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
        // 净化后再入缓存/注入 —— 图表源码来自智能体输出（可能受提示注入影响），而下方是
        // dangerouslySetInnerHTML 直入特权渲染进程。mermaid 的 click href 指令会带出
        // javascript: 锚点，本行是把它挡在 DOM 之外的地方。
        const clean = sanitizeRenderedSvg(svg)
        if (!clean) throw new Error('SVG sanitization failed') // 失败关闭，走下方 error 分支
        mermaidSvgCache.set(code, clean)
        setSvgHtml(clean)
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
        <pre className="text-[11px] text-text-secondary whitespace-pre-wrap break-words">
          {code}
        </pre>
      </div>
    )
  }

  return (
    <div
      className="my-2 rounded-lg overflow-hidden"
      style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
    >
      {/* 工具栏 */}
      <div
        className="flex items-center justify-between px-4 py-1.5"
        style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
      >
        <span className="text-[10px] text-text-tertiary font-medium">Mermaid</span>
        <button
          onClick={handleToggle}
          disabled={rendering}
          className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors disabled:opacity-50"
          title={showSource ? t('message.showDiagram') : t('message.source')}
        >
          {showSource ? <FileText size={10} /> : <Code size={10} />}
          <span>
            {rendering
              ? t('message.rendering')
              : showSource
                ? t('message.diagram')
                : t('message.source')}
          </span>
        </button>
      </div>
      {showSource ? (
        <pre className="p-3 text-[11px] text-text-secondary whitespace-pre-wrap break-words leading-relaxed font-mono overflow-auto">
          {code}
        </pre>
      ) : (
        <div
          className="flex justify-center overflow-auto p-3 bg-white rounded-b-lg [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svgHtml || '' }}
        />
      )}
    </div>
  )
}

/**
 * 手写 SVG 代码块 → 图，支持图/源码切换。
 *
 * 与 MermaidBlock 的三处刻意不同：
 *
 * 1. **缺省显示图，不是源码。** mermaid 缺省显示源码是因为渲染要异步加载一个重库、
 *    值得等用户点一下；这里的「渲染」只是一次同步净化（纯函数、已缓存），而且这张图
 *    本身就是模型要说的那句话 —— 让它默认折叠成一屏 path 数据是把话藏起来。
 * 2. **底色用主题面，不是写死白底。** mermaid 用的是它自己 default 主题的浅色产物，
 *    所以外面得铺白底才不割裂；手写 SVG 一律走 --viz-* / --theme-* token 取色
 *    （见 themes.css 的调色板段与 visual-guide 提示片段），写死白底会让它在深色主题下
 *    变成白框里的浅色字。图直接坐在主题底色上，明暗由 color-scheme 带着 light-dark() 解析。
 * 3. **净化用 sanitizeAuthoredSvg 这一档。** 来源是模型直接手写的整段标记，不是渲染器
 *    的产物 —— <style>/<foreignObject>/远程地址都必须关掉，理由见 svgSanitize 头注释。
 *
 * 失败关闭：净化返回空串（找不到 <svg> 根，或整段被剥空）即判死，绝不注入未经检查的标记 ——
 * 与 mermaid 同策。但**错误卡只在完成态出**：流式中间帧偶尔会被判死（此刻恰好只写到一个
 * 被禁元素），那不是失败、只是还没写完，在那儿闪一下红边框比先不渲染更糟。
 */
function AuthoredSvgBlock({ code }: { code: string }): React.JSX.Element {
  const { t } = useTranslation()
  // 净化是同步纯函数：首帧即出图，无 rendering 态。
  // **只有完成态进缓存**：流式期间每一帧都是一个新字符串，缓存下来就是一条会话涨一串
  // 中间产物。单帧净化是一次几 KB 的 DOMParser 解析（实测亚毫秒），而上游的流式增量本身
  // 已按 rAF 批过，所以照帧算不需要额外节流。
  const frame = authoredSvgFrame(code)
  const settled = frame !== null && isSvgComplete(code)
  const svgHtml = (() => {
    if (frame === null) return ''
    if (!settled) return sanitizeAuthoredSvg(frame)
    const cached = authoredSvgCache.get(code)
    if (cached !== undefined) return cached
    const clean = sanitizeAuthoredSvg(frame)
    authoredSvgCache.set(code, clean)
    return clean
  })()
  const [showSource, _setShowSource] = useState(authoredViewState.get(code) ?? false)

  const setShowSource = (v: boolean): void => {
    authoredViewState.set(code, v)
    _setShowSource(v)
  }

  // 错误卡只在**完成态**出。流式中间帧偶尔会被判死（例如此刻只写到一个被禁元素），
  // 那不是失败、只是还没写完 —— 在那里闪一下红边框比不渲染更糟。
  if (!svgHtml && settled) {
    return (
      <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
        <div className="text-[10px] text-orange-400 mb-1">{t('message.svgFailed')}</div>
        <pre className="text-[11px] text-text-secondary whitespace-pre-wrap break-words">
          {code}
        </pre>
      </div>
    )
  }

  return (
    <div
      className="my-2 rounded-lg overflow-hidden"
      style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
    >
      <div
        className="flex items-center justify-between px-4 py-1.5"
        style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
      >
        <span className="text-[10px] text-text-tertiary font-medium">SVG</span>
        <button
          onClick={() => setShowSource(!showSource)}
          className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          title={showSource ? t('message.showDiagram') : t('message.source')}
        >
          {showSource ? <FileText size={10} /> : <Code size={10} />}
          <span>{showSource ? t('message.diagram') : t('message.source')}</span>
        </button>
      </div>
      {showSource ? (
        <pre className="p-3 text-[11px] text-text-secondary whitespace-pre-wrap break-words leading-relaxed font-mono overflow-auto">
          {code}
        </pre>
      ) : (
        /* overflow-hidden 而非 auto：图按 viewBox 自适应宽度（提示片段要求必须带 viewBox、
           不写死 width/height），超出的部分是画错了而不是该滚动的内容；同时它也是
           「图里的东西跑不出这张卡」的兜底围栏。 */
        <div
          className="flex justify-center overflow-hidden p-3 [&_svg]:max-w-full [&_svg]:h-auto"
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      )}
    </div>
  )
}

/**
 * ```artifact 引用围栏 —— 正文里指名一件会话 Artifact，渲染它**当前**的内容。
 *
 * 这是「对话只持有引用」的落点：转写里留下的是一行名字，不是几 KB 源码。图改过之后
 * 再发一条同名引用就展示新版，而修改本身是 `edit` 的一个小 diff —— 不必把整张图重画。
 *
 * 为什么不走 `<img>` 取内容：SVG 经 `<img>` 加载是一份**独立文档**，`var(--viz-1)` 解析不到，
 * 整套 token 配色当场失效。所以必须取文本内联进宿主 DOM —— 也因此必须过 sanitizeAuthoredSvg，
 * 与 ```svg 围栏同一道闸（内容虽已落盘，来源仍是模型手写）。
 *
 * 只在桌面端成立：扩展没有 artifact 存储，取不到就显示「找不到」而不是空白。
 */
function ArtifactRefBlock({ name }: { name: string }): React.JSX.Element {
  const { t } = useTranslation()
  const sessionId = useChatStore((s) => s.activeSessionId)
  // 取不到宿主通道（扩展端没有 artifact 存储）就直接按「找不到」呈现 —— **派生出来，不写进
  // state**：在 effect 里同步 setState 会触发级联渲染，react-hooks/set-state-in-effect 拦它
  const reader = (getHostApi() as { artifact?: { read: (p: unknown) => Promise<unknown> } } | null)
    ?.artifact?.read
  const canLoad = !!sessionId && !!reader
  const [loaded, setState] = useState<
    { kind: 'loading' } | { kind: 'missing' } | { kind: 'ok'; title: string; content: string }
  >({ kind: 'loading' })
  const state = canLoad ? loaded : ({ kind: 'missing' } as const)

  useEffect(() => {
    let alive = true
    if (!canLoad || !reader) return
    void reader({ sessionId, name })
      .then((r) => {
        if (!alive) return
        const row = r as { title: string; content: string } | null
        setState(row ? { kind: 'ok', title: row.title, content: row.content } : { kind: 'missing' })
      })
      .catch(() => alive && setState({ kind: 'missing' }))
    return () => {
      alive = false
    }
  }, [canLoad, reader, sessionId, name])

  if (state.kind === 'missing') {
    return (
      <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
        <div className="text-[10px] text-orange-400">{t('message.artifactMissing', { name })}</div>
      </div>
    )
  }

  const svgHtml =
    state.kind === 'ok' && artifactRefIsSvg(state.content) ? sanitizeAuthoredSvg(state.content) : ''

  return (
    <div
      className="my-2 rounded-lg overflow-hidden"
      style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
    >
      <div
        className="flex items-center justify-between px-4 py-1.5"
        style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
      >
        <span className="text-[10px] text-text-tertiary font-medium truncate">
          {state.kind === 'ok' ? state.title : name}
        </span>
      </div>
      {state.kind === 'loading' ? (
        <div className="p-3 text-[11px] text-text-tertiary">{t('message.rendering')}</div>
      ) : svgHtml ? (
        <div
          className="flex justify-center overflow-hidden p-3 [&_svg]:max-w-full [&_svg]:h-auto"
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      ) : (
        <pre className="p-3 text-[11px] text-text-secondary whitespace-pre-wrap break-words leading-relaxed font-mono overflow-auto">
          {state.content}
        </pre>
      )}
    </div>
  )
}
