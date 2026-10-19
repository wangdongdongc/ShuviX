/**
 * web 客户端的手机布局（窄屏，见 useCompactLayout）—— 桌面布局（侧栏 + 对话 + 右侧 / 底部面板）在手机上放不下，
 * 这里把同一批组件换一种排法，桌面的组件只多了几个缺省关闭的参数：
 *
 * - 底部四个标签：会话（项目与临时会话，可切到日历）、小组件（主屏；点开总在新页面）、资料库（Bots / 智能体 /
 *   安全策略 / Hooks / 技能 / 知识库）、设置（分区列表 → 分区；外加智能体监视）；
 * - 打开一个会话（从哪儿打开都算：列表、日历、资料库里的笔记、新建）→ 对话页整屏推入，标签栏收起；返回键 /
 *   手机的返回手势回到列表（打开时压一条浏览器历史，返回就是 history.back）；
 * - 终端、悬浮窗、内置浏览器窗口在手机上没有；
 * - 长按 = 右键（longPress.ts），侧栏行、图标、条目的菜单照常可用。
 *
 * 各标签第一次切到才挂载，之后一直挂着（切回来还在原来的滚动位置）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CalendarDays,
  LayoutGrid,
  Library,
  List,
  MessagesSquare,
  SquarePen,
  Settings,
  FolderClosed,
  MessageSquare,
  Bot
} from 'lucide-react'
import { ChatHostProvider, getChatApi, useChatHost, useChatStore } from '@shuvix/chat-ui'
import { useProjects } from '@shuvix/app-shell'
import { Sidebar } from '../components/sidebar/Sidebar'
import { CalendarPanel } from '../components/browser/CalendarPanel'
import { WidgetPanel } from '../components/browser/WidgetPanel'
import { AgentMonitorPanel } from '../components/browser/AgentMonitorPanel'
import { SettingsPanel } from '../components/settings/SettingsPanel'
import { MobileChatView } from './MobileChatView'
import { BottomSheet } from './BottomSheet'
import { installLongPressContextMenu } from './longPress'
import { usePhoneFontSize } from './phoneFontSize'

type MobileTab = 'sessions' | 'widgets' | 'library' | 'settings'

const TABS: { key: MobileTab; labelKey: string; Icon: typeof MessagesSquare }[] = [
  { key: 'sessions', labelKey: 'mobile.tabSessions', Icon: MessagesSquare },
  { key: 'widgets', labelKey: 'mobile.tabWidgets', Icon: LayoutGrid },
  { key: 'library', labelKey: 'mobile.tabLibrary', Icon: Library },
  { key: 'settings', labelKey: 'mobile.tabSettings', Icon: Settings }
]

/** 浏览器历史里标记「这一条是手机布局打开对话时压的」 */
const HISTORY_MARK = 'shuvixMobileChat'

const headerIcon =
  'h-10 w-10 flex items-center justify-center rounded-full text-text-secondary active:bg-bg-hover'

/**
 * 专注模式在手机布局里关掉：它把没在用的侧栏淡化、鼠标移上去才恢复 —— 手机没有「移上去」，列表会一直是灰的。
 * 字号换成这台设备自己的（phoneFontSize.ts）：代码块等读 ChatHost 的 fontSize，正文读外壳上的 --app-font-size
 */
export function MobileShell(): React.JSX.Element {
  const host = useChatHost()
  const fontSize = usePhoneFontSize()
  const value = useMemo(
    () => ({ ...host, appearance: { ...host.appearance, focusMode: false, fontSize } }),
    [host, fontSize]
  )
  return (
    <ChatHostProvider value={value}>
      <MobileShellBody />
    </ChatHostProvider>
  )
}

function MobileShellBody(): React.JSX.Element {
  const { t } = useTranslation()
  const [tab, setTab] = useState<MobileTab>('sessions')
  const [visited, setVisited] = useState<Set<MobileTab>>(() => new Set(['sessions']))
  const [chatOpen, setChatOpen] = useState(false)
  const chatOpenRef = useRef(false)
  const [calendar, setCalendar] = useState(false)
  const [calendarMounted, setCalendarMounted] = useState(false)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const { projects } = useProjects()
  const fontSize = usePhoneFontSize()

  // 长按 = 右键（只在手机布局里装）
  useEffect(() => installLongPressContextMenu(document), [])

  const openChat = useCallback((): void => {
    if (chatOpenRef.current) return
    chatOpenRef.current = true
    window.history.pushState({ [HISTORY_MARK]: true }, '')
    setChatOpen(true)
  }, [])

  /** 返回键：退掉打开对话时压的那条历史（popstate 再收起对话页），与手机的返回手势同一条路 */
  const closeChat = useCallback((): void => {
    if (!chatOpenRef.current) return
    if ((window.history.state as Record<string, unknown> | null)?.[HISTORY_MARK]) {
      window.history.back()
    } else {
      chatOpenRef.current = false
      setChatOpen(false)
    }
  }, [])

  useEffect(() => {
    // 重新加载时对话页开着：那条标记过的历史还在，但对话页已经不在 —— 摘掉标记，免得之后要多退一次
    if ((window.history.state as Record<string, unknown> | null)?.[HISTORY_MARK]) {
      window.history.replaceState(null, '')
    }
    const onPop = (): void => {
      if (!chatOpenRef.current) return
      // 退回到的那一条还带着标记（比如页面里一个 #锚点 的前进 / 后退）：对话页还该开着
      if ((window.history.state as Record<string, unknown> | null)?.[HISTORY_MARK]) return
      chatOpenRef.current = false
      setChatOpen(false)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // 活跃会话变了（从任何地方打开 / 新建）→ 推入对话页；会话没了（删掉了）→ 收起
  useEffect(
    () =>
      useChatStore.subscribe((state, prev) => {
        if (state.activeSessionId === prev.activeSessionId) return
        if (state.activeSessionId) openChat()
        else closeChat()
      }),
    [openChat, closeChat]
  )

  const selectTab = (key: MobileTab): void => {
    setTab(key)
    setVisited((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
  }

  /** 新建会话：临时会话或某个项目下；建好即成为活跃会话，对话页随之推入 */
  const createChat = async (projectId: string | null): Promise<void> => {
    setNewChatOpen(false)
    try {
      const session = await getChatApi().session.create({ projectId })
      useChatStore.getState().setSessions(await getChatApi().session.list())
      useChatStore.getState().setActiveSessionId(session.id)
    } catch {
      // 连接断了之类：什么都没建成，留在列表上（连接状态由 WebStatusLayer 提示）
    }
  }

  const sessionsActions = (
    <>
      <button
        type="button"
        data-mobile-calendar-toggle=""
        className={headerIcon}
        onClick={() => {
          setCalendar((v) => !v)
          setCalendarMounted(true)
        }}
        aria-label={calendar ? t('mobile.list') : t('mobile.calendar')}
      >
        {calendar ? <List size={21} /> : <CalendarDays size={21} />}
      </button>
      <button
        type="button"
        data-mobile-new-chat=""
        className={headerIcon}
        onClick={() => setNewChatOpen(true)}
        aria-label={t('mobile.newChat')}
      >
        <SquarePen size={20} />
      </button>
    </>
  )

  const pageTitle = (label: string, actions?: React.ReactNode): React.JSX.Element => (
    <div className="flex items-center gap-1 pl-5 pr-2 pt-3 pb-2 flex-shrink-0">
      <h1 className="flex-1 min-w-0 truncate text-[28px] leading-9 font-bold tracking-tight text-text-primary">
        {label}
      </h1>
      {actions}
    </div>
  )

  return (
    <div
      data-mobile-shell=""
      className="relative h-[100dvh] w-full overflow-hidden bg-bg-primary text-text-primary"
      style={{ '--app-font-size': `${fontSize}px` } as React.CSSProperties}
    >
      {/* 标签页（对话页推入时藏起来但不卸载：回来还在原处） */}
      <div
        className="absolute inset-0 flex flex-col pt-[env(safe-area-inset-top)]"
        style={chatOpen ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
        aria-hidden={chatOpen}
      >
        <div className="flex-1 min-h-0 relative">
          {visited.has('sessions') && (
            <section
              data-mobile-page="sessions"
              className="absolute inset-0 flex flex-col"
              style={tab === 'sessions' ? undefined : { display: 'none' }}
            >
              {pageTitle(t('mobile.tabSessions'), sessionsActions)}
              {/* 列表与日历都挂着、只切显示：切回列表时项目的展开状态与滚动位置都还在。列表就是桌面的侧栏，
                  只是密度换成手指的那一档（Sidebar mode="sessions" → density touch） */}
              <div className="flex-1 min-h-0 relative" data-mobile-list="">
                <div
                  className="absolute inset-0"
                  style={calendar ? { display: 'none' } : undefined}
                >
                  <Sidebar mode="sessions" onOpenSession={openChat} />
                </div>
                {calendarMounted && (
                  <div
                    className="absolute inset-0"
                    data-mobile-scale=""
                    data-sidebar-density="touch"
                    style={calendar ? undefined : { display: 'none' }}
                  >
                    <CalendarPanel onOpenSession={openChat} />
                  </div>
                )}
              </div>
            </section>
          )}
          {visited.has('widgets') && (
            <section
              data-mobile-page="widgets"
              data-mobile-scale=""
              className="absolute inset-0 flex flex-col"
              style={tab === 'widgets' ? undefined : { display: 'none' }}
            >
              {pageTitle(t('mobile.tabWidgets'))}
              <div className="flex-1 min-h-0">
                <WidgetPanel launchInNewPage />
              </div>
            </section>
          )}
          {visited.has('library') && (
            <section
              data-mobile-page="library"
              data-mobile-scale=""
              className="absolute inset-0 flex flex-col"
              style={tab === 'library' ? undefined : { display: 'none' }}
            >
              {pageTitle(t('mobile.tabLibrary'))}
              <div className="flex-1 min-h-0">
                <Sidebar mode="library" onOpenSession={openChat} />
              </div>
            </section>
          )}
          {visited.has('settings') && (
            <section
              data-mobile-page="settings"
              data-mobile-scale=""
              className="absolute inset-0 flex flex-col"
              style={tab === 'settings' ? undefined : { display: 'none' }}
            >
              <SettingsPanel
                stacked
                extraTabs={[
                  {
                    id: 'agents',
                    label: t('panel.agents'),
                    icon: <Bot size={14} />,
                    content: <AgentMonitorPanel active={tab === 'settings' && !chatOpen} />
                  }
                ]}
              />
            </section>
          )}
        </div>

        {/* 底部标签栏 */}
        <nav
          data-mobile-tabbar=""
          className="flex-shrink-0 flex border-t border-border-secondary/60 bg-bg-secondary/80 pb-[env(safe-area-inset-bottom)]"
        >
          {TABS.map(({ key, labelKey, Icon }) => (
            <button
              key={key}
              type="button"
              data-mobile-tab={key}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => selectTab(key)}
              className={`flex-1 flex flex-col items-center gap-0.5 pt-1.5 pb-1 text-[11px] ${
                tab === key ? 'text-accent' : 'text-text-tertiary'
              }`}
            >
              <Icon size={21} />
              <span>{t(labelKey)}</span>
            </button>
          ))}
        </nav>

        <BottomSheet
          open={newChatOpen}
          onClose={() => setNewChatOpen(false)}
          title={t('mobile.newChatIn')}
        >
          <div className="overflow-y-auto pb-2" data-mobile-new-chat-sheet="">
            <button
              type="button"
              data-mobile-new-chat-target=""
              onClick={() => void createChat(null)}
              className="w-full flex items-center gap-3 px-4 py-3 text-[15px] text-text-primary active:bg-bg-hover border-b border-border-secondary/40"
            >
              <MessageSquare size={18} className="text-text-tertiary" />
              <span className="flex-1 text-left">{t('mobile.tempChat')}</span>
            </button>
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                data-mobile-new-chat-target={p.id}
                onClick={() => void createChat(p.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-[15px] text-text-primary active:bg-bg-hover border-b border-border-secondary/40"
              >
                <FolderClosed size={18} className="text-text-tertiary" />
                <span className="flex-1 min-w-0 truncate text-left">{p.name}</span>
              </button>
            ))}
          </div>
        </BottomSheet>
      </div>

      {/* 对话页：整屏推入 */}
      {chatOpen && (
        <div
          data-mobile-page="chat"
          data-mobile-scale=""
          className="absolute inset-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] bg-bg-primary"
        >
          <MobileChatView onBack={closeChat} />
        </div>
      )}
    </div>
  )
}
