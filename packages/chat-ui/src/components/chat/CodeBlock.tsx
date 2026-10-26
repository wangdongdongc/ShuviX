import { useContext, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Code, FileText } from 'lucide-react'
import { copyToClipboard } from '../../utils/clipboard'
import { getHostApi, getSessionChannelApi } from '../../api/chatApi'
import { useChatStore } from '../../stores/chatStore'
import { sanitizeAuthoredSvg } from '@shuvix/chat-protocol/utils/svgSanitize'
import {
  authoredSvgFrame,
  isSvgComplete,
  svgFenceIsRenderable
} from '@shuvix/chat-protocol/utils/svgFence'
import { MERMAID_FENCE_LANG } from '@shuvix/chat-protocol/utils/mermaidFence'
import { artifactRefName } from '@shuvix/chat-protocol/utils/artifactFence'
import {
  INTERACTIVE_FENCE_LANG,
  fenceSourceIsClosed
} from '@shuvix/chat-protocol/utils/interactiveFence'
import { ChatHostContext } from '../../host/chatHostContext'
import { MermaidBlock } from './MermaidBlock'
import { InteractiveBlock, InteractiveUnsupportedBlock } from './InteractiveBlock'
import { useMarkdownMessageId, useMarkdownSource, useMarkdownStreaming } from './markdownStreaming'
import { FigureExportButton } from '../figure/FigureExportPanel'
import { authoredFigureSource } from '../figure/figureExport'
import { useRestoreForCopy } from '../../hooks/useRedaction'

/** 手写 SVG 的净化结果缓存（净化是纯函数，同一段源码恒得同一结果）；'' = 判死 */
const authoredSvgCache = new Map<string, string>()
/** 手写 SVG 的视图状态：code → showSource（缺省为图，见 AuthoredSvgBlock） */
const authoredViewState = new Map<string, boolean>()

// ```artifact 围栏体 → 名字：与宿主钉版本时同一个取法（chat-protocol artifactFence），从这里转出去
// 是因为单测与调用方一直从 CodeBlock 拿它
export { artifactRefName }

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
 * 这个代码块的围栏闭合了没有（交互图要等闭合才挂；mermaid 闭合前按帧画、闭合后整段画）。
 * 消息不在流式中 → 写完了；流式中则按节点位置把源文本切回来，看最后一行是不是闭合栅栏。拿不到位置或源文本时保守地当没写完 ——
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
  const restore = useRestoreForCopy()
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

  // mermaid：与 ```svg 一样边写边画，但要知道围栏闭合没有 —— 开着时最后一行可能写到一半
  if (lang === MERMAID_FENCE_LANG && rawCode) {
    return <MermaidBlock code={rawCode} closed={codeFenceIsClosed(node, source, streaming)} />
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
    // 复制出去的是界面上看到的样子：脱敏的占位符换回真值
    copyToClipboard(restore(rawCode))
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
 * 与 MermaidBlock 同一条路（pele 的产物也是 token 着色的静态 SVG），差别只在「帧」怎么来：
 *
 * 1. **边写边画，一笔一笔长出来。** 「渲染」只是一次同步净化（纯函数），开标签一闭合就能出
 *    第一帧，之后每一帧只是在后面追加元素；mermaid 每多写完一行就整张重新布局一次。
 * 2. **颜色直接是 token。** 手写 SVG 一律走 --viz-* / --theme-* 取色（见 themes.css 的调色板段与
 *    visual-guide 提示片段），paint 时由 CSS 解析，切主题不必重渲染。
 * 3. **净化用 sanitizeAuthoredSvg 这一档。** 来源是模型直接手写的整段标记 ——
 *    <style>/<foreignObject>/远程地址都必须关掉，理由见 svgSanitize 头注释。
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
  const figureRef = useRef<HTMLDivElement>(null)

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
        className="flex items-center gap-3 px-4 py-1.5"
        style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
      >
        <span className="text-[10px] text-text-tertiary font-medium mr-auto">SVG</span>
        {/* 只导出写完的图：流式中途的一帧是半张图 */}
        {settled && svgHtml && (
          <FigureExportButton
            getSource={() =>
              authoredFigureSource(svgHtml, {
                surface: 'card',
                inheritFrom: () => figureRef.current
              })
            }
          />
        )}
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
          ref={figureRef}
          className="flex justify-center overflow-hidden p-3 [&_svg]:max-w-full [&_svg]:h-auto"
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      )}
    </div>
  )
}

/**
 * ```artifact 引用围栏 —— 正文里指名一件会话 Artifact，渲染**它所在那条回复写下时**的那一版。
 *
 * 这是「对话只持有引用」的落点：转写里留下的是一行名字，不是几 KB 源码。图改过之后再发一条同名引用
 * 就展示新版，而修改本身是 `edit` 的一个小 diff —— 不必把整张图重画。旧回复里的引用不跟着变：宿主在
 * 每条回复写完时钉住它引用的那一份（桌面 `services/artifacts/pins.ts`），这里带着回复的消息 id 去取。
 * 没钉过的（功能上线前的回复、流式中）照当前内容显示，并标出「当前版本」。
 *
 * 为什么不走 `<img>` 取内容：SVG 经 `<img>` 加载是一份**独立文档**，`var(--viz-1)` 解析不到，
 * 整套 token 配色当场失效。所以必须取文本内联进宿主 DOM —— 也因此必须过 sanitizeAuthoredSvg，
 * 与 ```svg 围栏同一道闸（内容虽已落盘，来源仍是模型手写）。
 *
 * 只在桌面端成立：扩展没有 artifact 存储，取不到就显示「找不到」而不是空白。
 */
function ArtifactRefBlock({ name }: { name: string }): React.JSX.Element {
  const sessionId = useChatStore((s) => s.activeSessionId)
  const messageId = useMarkdownMessageId()
  const streaming = useMarkdownStreaming()
  return (
    <ArtifactPreview
      sessionId={sessionId}
      name={name}
      messageId={streaming ? null : messageId}
      followChanges
    />
  )
}

type ArtifactLoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | {
      kind: 'ok'
      /** 产物所在的会话（宿主没说就是所问的那场） */
      owner: string
      name: string
      title: string
      content: string
      pinned: boolean
      latest: boolean
    }

/**
 * 一件会话 Artifact 的渲染（引用围栏与会话面板「产物」页共用）：svg 内联、`.html` 进交互图沙箱、
 * 其余显示源码。`sessionId` 是去哪场会话找（`artifact:read` 还会往下找一层子会话）。
 *
 *  - `messageId`：引用所在那条回复 —— 给了就取那条回复钉住的那一版，并在标题栏标出它与当前的关系：
 *    钉下的那一版之后又被改过 →「已有新版」（点它在会话面板的产物页里亮出这件）；没钉过 →「当前版本」。
 *  - `followChanges`：`artifacts.changed` 一来就重取（钉住的内容不变，但「已有新版」要跟上；没钉的
 *    要跟上新内容；回复落定后钉才写下，也靠这一下换成钉住的那一版）。面板那边换 key 重挂，不用它。
 *  - `hideTitle`：面板那一行已经写着标题，展开的预览里不再重复（svg 的导出按钮、版本标记照留）。
 */
export function ArtifactPreview({
  sessionId,
  name,
  messageId = null,
  followChanges = false,
  hideTitle = false
}: {
  sessionId: string | null
  name: string
  messageId?: string | null
  followChanges?: boolean
  hideTitle?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const canRunInteractive = useContext(ChatHostContext)?.interactiveFigures === true
  // 取不到宿主通道（扩展端没有 artifact 存储）就直接按「找不到」呈现 —— **派生出来，不写进
  // state**：在 effect 里同步 setState 会触发级联渲染，react-hooks/set-state-in-effect 拦它
  const reader = getHostApi()?.artifact?.read
  const canLoad = !!sessionId && !!reader
  const figureRef = useRef<HTMLDivElement>(null)
  const [loaded, setState] = useState<ArtifactLoadState>({ kind: 'loading' })
  const state = canLoad ? loaded : ({ kind: 'missing' } as const)
  // 重取的计数：artifacts.changed 一来就加一（effect 依赖它）。只有引用块订阅；宿主没有事件通道
  // （测试、只读嵌入）就不跟 —— 那里也不会有新版
  const [revision, setRevision] = useState(0)
  // 产物所在的会话（取回来才知道）：子会话的产物记了新版，事件点的是子会话
  const ownerRef = useRef<string | null>(null)
  useEffect(() => {
    ownerRef.current = loaded.kind === 'ok' ? loaded.owner : null
  }, [loaded])
  useEffect(() => {
    if (!followChanges) return
    let off: unknown
    try {
      off = getSessionChannelApi().events.subscribe((event) => {
        if (event.type !== 'artifacts.changed') return
        // 只认点到自己的：所问的会话，或产物所在的会话（子会话的）；不带会话的（重连）一律重取
        const ids = event.sessionIds
        if (!ids || ids.some((id) => id === sessionId || id === ownerRef.current)) {
          setRevision((r) => r + 1)
        }
      })
    } catch {
      return
    }
    return typeof off === 'function' ? (off as () => void) : undefined
  }, [followChanges, sessionId])

  useEffect(() => {
    let alive = true
    if (!canLoad || !reader) return
    void reader({ sessionId, name, ...(messageId ? { messageId } : {}) })
      .then((row) => {
        if (!alive) return
        // 围栏里写的可能是标题而不是文件名（artifact:read 两种都认）：按宿主解析出来的真实文件名走，
        // 否则按标题引用的一件 .html 会落进 <pre> 而不是沙箱
        const next: ArtifactLoadState = row
          ? {
              kind: 'ok',
              owner: row.sessionId ?? sessionId,
              name: row.name ?? name,
              title: row.title,
              content: row.content,
              pinned: row.pinned === true,
              latest: row.latest !== false
            }
          : { kind: 'missing' }
        // 重取回来的一模一样就不换 state：交互图的沙箱不该因为别的产物记了一版就整块重载
        setState((prev) => (sameLoadState(prev, next) ? prev : next))
      })
      .catch(() => alive && setState({ kind: 'missing' }))
    return () => {
      alive = false
    }
  }, [canLoad, reader, sessionId, name, messageId, revision])

  if (state.kind === 'missing') {
    return (
      <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
        <div className="text-[10px] text-orange-400">{t('message.artifactMissing', { name })}</div>
      </div>
    )
  }

  // 版本标记：只有引用（带着回复的消息 id）才有「当时那一版」可说
  const versionMark =
    state.kind === 'ok' && messageId ? (
      state.pinned && !state.latest ? (
        <button
          data-artifact-newer=""
          onClick={() => useChatStore.getState().revealArtifact(state.owner, state.name)}
          className="flex-shrink-0 text-[10px] text-accent hover:underline"
          title={t('message.artifactNewerHint')}
        >
          {t('message.artifactNewer')}
        </button>
      ) : !state.pinned ? (
        <span
          data-artifact-unpinned=""
          className="flex-shrink-0 text-[10px] text-text-tertiary"
          title={t('message.artifactUnpinnedHint')}
        >
          {t('message.artifactUnpinned')}
        </span>
      ) : null
    ) : null

  // .html 的 artifact 是认领下来的交互图：与 ```interactive 围栏同一个沙箱（它有自己的标题栏，
  // 版本标记放在它上面一行）
  if (state.kind === 'ok' && artifactRefIsHtml(state.name)) {
    return (
      <>
        {versionMark && <div className="flex justify-end -mb-1 mt-2">{versionMark}</div>}
        {canRunInteractive ? (
          <InteractiveBlock code={state.content} closed title={state.title} />
        ) : (
          <InteractiveUnsupportedBlock code={state.content} />
        )}
      </>
    )
  }

  const svgHtml =
    state.kind === 'ok' && artifactRefIsSvg(state.content) ? sanitizeAuthoredSvg(state.content) : ''

  const showExport = state.kind === 'ok' && !!svgHtml
  return (
    <div
      className="my-2 rounded-lg overflow-hidden"
      style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
    >
      {(!hideTitle || showExport || versionMark) && (
        <div
          className="flex items-center gap-3 px-4 py-1.5"
          style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
        >
          <span className="text-[10px] text-text-tertiary font-medium truncate mr-auto">
            {hideTitle ? '' : state.kind === 'ok' ? state.title : name}
          </span>
          {versionMark}
          {showExport && (
            <FigureExportButton
              getSource={() =>
                authoredFigureSource(svgHtml, {
                  // 产物有标题：比图里的 aria-label 更像用户认得的名字
                  name: state.title || null,
                  surface: 'card',
                  inheritFrom: () => figureRef.current
                })
              }
            />
          )}
        </div>
      )}
      {state.kind === 'loading' ? (
        <div className="p-3 text-[11px] text-text-tertiary">{t('message.rendering')}</div>
      ) : svgHtml ? (
        <div
          ref={figureRef}
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

function sameLoadState(a: ArtifactLoadState, b: ArtifactLoadState): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind !== 'ok' || b.kind !== 'ok') return true
  return (
    a.owner === b.owner &&
    a.name === b.name &&
    a.title === b.title &&
    a.content === b.content &&
    a.pinned === b.pinned &&
    a.latest === b.latest
  )
}
