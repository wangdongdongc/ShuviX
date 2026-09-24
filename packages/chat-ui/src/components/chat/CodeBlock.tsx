import { useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Code, FileText } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import { getHostApi } from '../../api/chatApi'
import { useChatStore } from '../../stores/chatStore'
import { sanitizeAuthoredSvg } from '@shuvix/chat-protocol/utils/svgSanitize'
import {
  authoredSvgFrame,
  isSvgComplete,
  svgFenceIsRenderable
} from '@shuvix/chat-protocol/utils/svgFence'
import {
  INTERACTIVE_FENCE_LANG,
  fenceSourceIsClosed
} from '@shuvix/chat-protocol/utils/interactiveFence'
import { ChatHostContext } from '../../host/chatHostContext'
import { MermaidBlock } from './MermaidBlock'
import { InteractiveBlock, InteractiveUnsupportedBlock } from './InteractiveBlock'
import { useMarkdownSource, useMarkdownStreaming } from './markdownStreaming'

/** 手写 SVG 的净化结果缓存（净化是纯函数，同一段源码恒得同一结果）；'' = 判死 */
const authoredSvgCache = new Map<string, string>()
/** 手写 SVG 的视图状态：code → showSource（缺省为图，见 AuthoredSvgBlock） */
const authoredViewState = new Map<string, boolean>()

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

/**
 * 按**名字**判：`.html` 的 artifact 只可能来自认领一块交互图（或 `create` 一个 html），内容什么样
 * 都进沙箱。按内容嗅探反而危险 —— 一段看起来不像 html 的文本落到 `<pre>` 里没事，一段 html 被
 * 当成别的东西也没事，唯一不能发生的是 html 绕开沙箱，而按扩展名判它永远走沙箱。
 */
export const artifactRefIsHtml = (name: string): boolean => /\.html$/i.test(name)

interface HastNode {
  type: string
  value?: string
  children?: HastNode[]
  properties?: Record<string, unknown>
  position?: { start?: { offset?: number }; end?: { offset?: number } }
}

/**
 * 这个代码块的围栏闭合了没有（交互图要等闭合才挂）。消息不在流式中 → 写完了；流式中则按
 * 节点位置把源文本切回来，看最后一行是不是闭合栅栏。拿不到位置或源文本时保守地当没写完 ——
 * 消息写完那一刻流式标志翻成 false，块照样会挂上。
 */
export function codeFenceIsClosed(
  node: HastNode | undefined,
  source: string | null,
  streaming: boolean
): boolean {
  if (!streaming) return true
  const start = node?.position?.start?.offset
  const end = node?.position?.end?.offset
  if (source === null || start === undefined || end === undefined) return false
  return fenceSourceIsClosed(source.slice(start, end))
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
  const streaming = useMarkdownStreaming()
  const source = useMarkdownSource()
  // 可空地读：markdown 也在没有 ChatHostProvider 的地方渲染，那里当作不能跑交互图
  const canRunInteractive = useContext(ChatHostContext)?.interactiveFigures === true

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

  // 交互图：沙箱 iframe 里跑的 HTML/JS，围栏闭合才挂（见 InteractiveBlock）
  if (lang === INTERACTIVE_FENCE_LANG && rawCode) {
    if (!canRunInteractive) return <InteractiveUnsupportedBlock code={rawCode} />
    return <InteractiveBlock code={rawCode} closed={codeFenceIsClosed(node, source, streaming)} />
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

/**
 * 手写 SVG 代码块 → 图，支持图/源码切换。
 *
 * 与 MermaidBlock 的刻意不同：
 *
 * 1. **边写边画，不等写完。** 「渲染」只是一次同步净化（纯函数），开标签一闭合就能出第一帧；
 *    mermaid 要完整源码才能解析，只能等写完。
 * 2. **颜色直接是 token。** 手写 SVG 一律走 --viz-* / --theme-* 取色（见 themes.css 的调色板段与
 *    visual-guide 提示片段），paint 时由 CSS 解析，切主题不必重渲染；mermaid 要具体颜色值，
 *    切主题得重新渲染一遍。
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
  const canRunInteractive = useContext(ChatHostContext)?.interactiveFigures === true
  const sessionId = useChatStore((s) => s.activeSessionId)
  // 取不到宿主通道（扩展端没有 artifact 存储）就直接按「找不到」呈现 —— **派生出来，不写进
  // state**：在 effect 里同步 setState 会触发级联渲染，react-hooks/set-state-in-effect 拦它
  const reader = (getHostApi() as { artifact?: { read: (p: unknown) => Promise<unknown> } } | null)
    ?.artifact?.read
  const canLoad = !!sessionId && !!reader
  const [loaded, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'missing' }
    | { kind: 'ok'; name: string; title: string; content: string }
  >({ kind: 'loading' })
  const state = canLoad ? loaded : ({ kind: 'missing' } as const)

  useEffect(() => {
    let alive = true
    if (!canLoad || !reader) return
    void reader({ sessionId, name })
      .then((r) => {
        if (!alive) return
        const row = r as { name?: string; title: string; content: string } | null
        // 围栏里写的可能是标题而不是文件名（artifact:read 两种都认）：按宿主解析出来的真实文件名走，
        // 否则按标题引用的一件 .html 会落进 <pre> 而不是沙箱
        setState(
          row
            ? { kind: 'ok', name: row.name ?? name, title: row.title, content: row.content }
            : { kind: 'missing' }
        )
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

  // .html 的 artifact 是认领下来的交互图：与 ```interactive 围栏同一个沙箱
  if (state.kind === 'ok' && artifactRefIsHtml(state.name)) {
    return canRunInteractive ? (
      <InteractiveBlock code={state.content} closed title={state.title} />
    ) : (
      <InteractiveUnsupportedBlock code={state.content} />
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
