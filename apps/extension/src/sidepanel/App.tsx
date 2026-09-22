import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChatHostProvider,
  Conversation,
  useAgentEvents,
  useAppEvent,
  useModelCatalogSync,
  useSessionInit,
  type ChatHostValue
} from '@shuvix/chat-ui'
import { ContextMenuProvider } from '@shuvix/app-shell/contextmenu/ContextMenuProvider'
import type { ChromePanelAppearance } from '@shuvix/chat-protocol/chromeBridge'
import type { PanelLinkState } from '../shared/panelLink'
import type { PanelLink } from './panelLink'
import { StatusView } from './StatusView'
import { TabChips } from './TabChips'
import { applyAppearance, DEFAULT_APPEARANCE } from './appearance'
import i18n, { resolveLocale } from './i18n'

function useLinkState(link: PanelLink): PanelLinkState {
  const [state, setState] = useState<PanelLinkState>(link.state)
  useEffect(() => link.onState(setState), [link])
  return state
}

/** 会话级 hook 的宿主（须在 ChatHostProvider 之下）。渠道模式：模型目录留空但放行初始化时序 */
function SessionRuntime({ sessionId }: { sessionId: string }): null {
  useSessionInit(sessionId)
  useAgentEvents()
  useModelCatalogSync()
  return null
}

/** 外观跟着桌面：连上就取，桌面设置一改就重取 */
function useDesktopAppearance(link: PanelLink, ready: boolean): ChromePanelAppearance {
  const [appearance, setAppearance] = useState<ChromePanelAppearance>(DEFAULT_APPEARANCE)
  const refresh = useCallback(() => {
    void link
      .request('panel.appearance', {})
      .then((a) => setAppearance(a))
      .catch(() => {})
  }, [link])
  useEffect(() => {
    if (ready) refresh()
  }, [ready, refresh])
  // 桌面那边改了外观 / 语言
  useAppEvent('settings.changed', refresh)
  useEffect(() => {
    applyAppearance(appearance)
    const lang = resolveLocale(appearance.language)
    if (i18n.language !== lang) void i18n.changeLanguage(lang)
  }, [appearance])
  useEffect(() => {
    if (appearance.theme !== 'system') return
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onChange = (): void => applyAppearance(appearance)
    media?.addEventListener('change', onChange)
    return () => media?.removeEventListener('change', onChange)
  }, [appearance])
  return appearance
}

function PanelWelcome(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="text-[15px] font-medium text-text-primary">{t('chromePanel.emptyTitle')}</div>
      <div className="text-[12px] leading-relaxed text-text-secondary">
        {t('chromePanel.emptyHint')}
      </div>
    </div>
  )
}

/**
 * 侧边栏根组件：连上桌面 → 取（没有就建）挂在这个标签页上的会话 → 对话界面。
 * 连不上时整屏说明为什么、用户该做什么（StatusView）。
 */
export function App({ link }: { link: PanelLink }): React.JSX.Element {
  const state = useLinkState(link)
  const ready = state === 'ready'
  const appearance = useDesktopAppearance(link, ready)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [activeProvider, setActiveProvider] = useState('')
  const [activeModel, setActiveModel] = useState('')

  // 连上（含重连之后）就去要会话：桌面按标签页找回同一条，并把这条连接重新绑成它的前端
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setOpenError(null)
    void (async () => {
      const tab = await chrome.tabs.get(link.tabId).catch(() => null)
      try {
        const { sessionId: id } = await link.request('tabSession.open', {
          tabId: link.tabId,
          title: tab?.title
        })
        if (!cancelled) setSessionId(id)
      } catch (err) {
        if (!cancelled) setOpenError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [ready, link, attempt])

  const host = useMemo<ChatHostValue>(
    () => ({
      appearance: {
        theme: appearance.theme,
        darkTheme: appearance.darkTheme,
        lightTheme: appearance.lightTheme,
        fontSize: appearance.fontSize,
        focusMode: appearance.focusMode
      },
      // 渠道模式没有模型切换（宿主管理界面随 getHostApi() 为空自动隐藏）；只镜像会话当前模型
      models: { activeProvider, activeModel, setActiveProvider, setActiveModel }
    }),
    [appearance, activeProvider, activeModel]
  )

  if (!ready) return <StatusView state={state} />
  if (openError) {
    return <StatusView state="error" error={openError} onRetry={() => setAttempt((n) => n + 1)} />
  }
  if (!sessionId) return <StatusView state="opening" />

  return (
    <ChatHostProvider value={host}>
      <ContextMenuProvider>
        <SessionRuntime sessionId={sessionId} />
        <div className="h-full flex flex-col bg-bg-primary text-text-primary">
          <div className="relative flex-1 min-h-0 flex flex-col">
            <Conversation
              sessionId={sessionId}
              emptyState={<PanelWelcome />}
              inputTop={<TabChips attachedTabId={link.tabId} />}
            />
          </div>
        </div>
      </ContextMenuProvider>
    </ChatHostProvider>
  )
}
