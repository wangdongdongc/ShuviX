import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Code, Play, RotateCcw } from 'lucide-react'
import {
  SANDBOX_THEME_TOKENS,
  buildSandboxDocument,
  clampSandboxHeight,
  parseSandboxMessage
} from '@shuvix/chat-protocol/utils/interactiveFence'
import { useChatStore } from '../../stores/chatStore'
import { useThemeId } from './useThemeId'

/**
 * ```interactive 围栏 → 沙箱里跑的一块交互图（也给 `.html` 的 artifact 引用用）。
 *
 * 隔离的全部理由在 chat-protocol 的 interactiveFence.ts 头注释；这里只守两条组件层的约定：
 *
 *  1. **`sandbox` 恰好是 `allow-scripts`。** 多一个 allow-same-origin，iframe 就与宿主同源、
 *     一行 `parent.api` 拿到全部 IPC；多一个 allow-popups / allow-top-navigation，它就能把窗口
 *     带走或开新窗口。这个属性值是整道边界里唯一写在组件里的一环。
 *  2. **只认这个 iframe 发来的消息**（`event.source` 比对），形状再过 parseSandboxMessage。
 *     同一页上可能有好几块交互图，还有 PDF / widget 的 iframe。
 *
 * 围栏没闭合之前不挂：半截脚本跑起来只会报错（闭合由 CodeBlock 按源文本判定后传进来）。
 * 颜色在挂载时写进 srcdoc，所以切主题会整块重载 —— 块内状态（滑块位置）随之归零，换来的是
 * 模型不必处理主题变化。
 */

/** 挂上之后、第一次高度上报之前的高度（上报通常在第一帧内就到） */
const INITIAL_HEIGHT = 120

/** 视图状态：源码 → 是否在看源码（虚拟列表频繁重挂载时保持） */
const viewState = new Map<string, boolean>()

/** 按主题 id 缓存宿主上的 token 原值 —— 同一主题下每块交互图读到的是同一份 */
const themeTokenCache = new Map<string, { tokens: Record<string, string>; colorScheme: string }>()

function hostTheme(themeId: string): { tokens: Record<string, string>; colorScheme: string } {
  const hit = themeTokenCache.get(themeId)
  if (hit) return hit
  const root = getComputedStyle(document.documentElement)
  const tokens: Record<string, string> = {}
  for (const name of SANDBOX_THEME_TOKENS) {
    const value = root.getPropertyValue(name).trim()
    if (value) tokens[name] = value
  }
  const theme = { tokens, colorScheme: root.colorScheme || 'normal' }
  themeTokenCache.set(themeId, theme)
  return theme
}

/** sendPrompt 的落点：填进输入框；已有草稿就另起一行接在后面，不覆盖用户正在写的东西 */
function fillComposer(text: string): void {
  const { inputText, setInputText } = useChatStore.getState()
  setInputText(inputText.trim() ? `${inputText.replace(/\s+$/, '')}\n${text}` : text)
}

export function InteractiveBlock({
  code,
  closed,
  title
}: {
  code: string
  /** 围栏已闭合（或消息已写完）—— 之前只显示占位 */
  closed: boolean
  /** 工具栏上的名字（artifact 引用给它的标题；围栏缺省「交互图」） */
  title?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const themeId = useThemeId()
  const [showSource, _setShowSource] = useState(viewState.get(code) ?? false)
  const [height, setHeight] = useState(INITIAL_HEIGHT)
  /** 「重新运行」：换一个 key 让 iframe 重挂载，块内状态归零 */
  const [run, setRun] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)

  const setShowSource = (v: boolean): void => {
    viewState.set(code, v)
    _setShowSource(v)
  }

  const theme = hostTheme(themeId)
  const srcDoc = useMemo(
    () => (closed ? buildSandboxDocument({ body: code, ...theme }) : ''),
    [closed, code, theme]
  )

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const win = frameRef.current?.contentWindow
      if (!win || event.source !== win) return
      const msg = parseSandboxMessage(event.data)
      if (!msg) return
      if (msg.type === 'resize') setHeight(clampSandboxHeight(msg.height))
      else fillComposer(msg.text)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const lines = code.split('\n').length

  return (
    <div
      data-interactive-figure
      className="my-2 rounded-lg overflow-hidden"
      style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
    >
      <div
        className="flex items-center justify-between gap-2 px-4 py-1.5"
        style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
      >
        <span className="text-[10px] text-text-tertiary font-medium truncate">
          {title ?? t('message.interactive')}
        </span>
        {closed && (
          <div className="flex items-center gap-3 flex-shrink-0">
            {!showSource && (
              <button
                data-interactive-rerun
                onClick={() => setRun((n) => n + 1)}
                className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
                title={t('message.interactiveRerun')}
              >
                <RotateCcw size={10} />
                <span>{t('message.interactiveRerun')}</span>
              </button>
            )}
            <button
              data-interactive-toggle
              onClick={() => setShowSource(!showSource)}
              className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
              title={showSource ? t('message.interactive') : t('message.source')}
            >
              {showSource ? <Play size={10} /> : <Code size={10} />}
              <span>{showSource ? t('message.interactive') : t('message.source')}</span>
            </button>
          </div>
        )}
      </div>
      {!closed ? (
        <div data-interactive-pending className="px-4 py-3 text-[11px] text-text-tertiary">
          {t('message.interactiveBuilding', { lines })}
        </div>
      ) : showSource ? (
        <pre className="p-3 text-[11px] text-text-secondary whitespace-pre-wrap break-words leading-relaxed font-mono overflow-auto">
          {code}
        </pre>
      ) : (
        <iframe
          key={`${themeId}\u0000${run}`}
          ref={frameRef}
          // 边界本身 —— 见组件头注释第 1 条。只能是这一个值
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          title={title ?? t('message.interactiveFrameTitle')}
          referrerPolicy="no-referrer"
          className="block w-full border-0 bg-transparent"
          style={{ height }}
        />
      )}
    </div>
  )
}

/** 宿主不能运行交互图（Chrome 扩展）：源码照常可见，另说一句它在哪儿能跑 */
export function InteractiveUnsupportedBlock({ code }: { code: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      data-interactive-unsupported
      className="my-2 rounded-lg overflow-hidden"
      style={{ background: 'color-mix(in srgb, var(--color-bg-tertiary) 60%, transparent)' }}
    >
      <div className="px-4 py-1.5 text-[10px] text-text-tertiary">
        {t('message.interactiveDesktopOnly')}
      </div>
      <pre className="p-3 text-[11px] text-text-secondary whitespace-pre-wrap break-words leading-relaxed font-mono overflow-auto">
        {code}
      </pre>
    </div>
  )
}
