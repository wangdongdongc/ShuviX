/**
 * web 客户端的手机布局（窄屏，见 useCompactLayout）—— 桌面布局（侧栏 + 对话 + 右侧 / 底部面板）在手机上放不下，
 * 这里把同一批组件换一种排法，桌面的组件只多了几个缺省关闭的参数：
 *
 * - 会话页是两层（2026-11-14，对标 iOS Mail）：顶层是「邮箱」那一层 —— 搜索框，下面收件箱、各 bot、各项目、聊天
 *   各是一张分组卡片里的行，每行带数量与箭头；点一行进那一组的会话列表（标题 + 时间 + 两行摘要，行首只有一列圆点），
 *   顶上是返回、那一组的菜单「⋯」与它的名字，底部的标签栏换成那一组的工具栏（只看未读 · 「N 条会话 · M 条未读」 ·
 *   新对话）。工具栏和「⋯」是列表自己画进这里留的两个槽里的（ProjectSessionGroups 的 `drill`）。进组时压一条
 *   浏览器历史，返回键 / 返回手势退回顶层；对话页是再往上的一层；
 * - 底部四个标签：会话（项目与临时会话，可切到日历）、小组件（卡片列表；点开就地整屏打开）、资料库（Bots / 智能体 /
 *   安全策略 / Hooks / 技能 / 知识库）、设置（分区列表 → 分区；外加智能体监视）；
 * - 打开一个小组件 → 小组件页收起页头与标签栏、应用占满整屏（应用本身还挂在 WidgetPanel 里，回列表不关）；
 *   返回键 / 返回手势回卡片列表（同对话页，打开时压一条浏览器历史）；
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
  ChevronLeft,
  LayoutGrid,
  Library,
  MessagesSquare,
  Search,
  X,
  SquarePen,
  Settings,
  FolderClosed,
  MessageSquare,
  Bot
} from 'lucide-react'
import { ChatHostProvider, getChatApi, useChatHost, useChatStore } from '@shuvix/chat-ui'
import {
  InboxPanel,
  STACKED_SETTINGS_HISTORY_MARK,
  SIDEBAR_VIEW_LABEL_KEYS,
  SidebarViewSwitch,
  useInboxSections,
  type SidebarView,
  useProjects
} from '@shuvix/app-shell'
import { Sidebar } from '../components/sidebar/Sidebar'
import { useSidebarViewStore } from '../stores/sidebarViewStore'
import { CalendarPanel } from '../components/browser/CalendarPanel'
import { WidgetPanel } from '../components/browser/WidgetPanel'
import { useWidgetStore } from '../stores/widgetStore'
import { AgentMonitorPanel } from '../components/browser/AgentMonitorPanel'
import { SettingsPanel } from '../components/settings/SettingsPanel'
import { MobileChatView } from './MobileChatView'
import { BottomSheet } from './BottomSheet'
import { installLongPressContextMenu } from './longPress'
import { usePhoneFontSize } from './phoneFontSize'
import { detailDepthOf } from './detailHistory'
import { useTrackingAdapter } from '../host/useTrackingAdapter'

type MobileTab = 'sessions' | 'widgets' | 'library' | 'settings'

const TABS: { key: MobileTab; labelKey: string; Icon: typeof MessagesSquare }[] = [
  { key: 'sessions', labelKey: 'mobile.tabSessions', Icon: MessagesSquare },
  { key: 'widgets', labelKey: 'mobile.tabWidgets', Icon: LayoutGrid },
  { key: 'library', labelKey: 'mobile.tabLibrary', Icon: Library },
  { key: 'settings', labelKey: 'mobile.tabSettings', Icon: Settings }
]

/** 浏览器历史里标记「这一条是手机布局打开对话时压的」 */
const HISTORY_MARK = 'shuvixMobileChat'
/** 同上，打开小组件时压的 */
const WIDGET_HISTORY_MARK = 'shuvixMobileWidget'
/** 同上，会话页进了某一组（或收件箱）时压的；在它上面再压的对话 / 小组件那一条也带着它 */
const SCOPE_HISTORY_MARK = 'shuvixMobileScope'
/** 同上，资料库页进了某一组（或知识库里的某个库）时压的；值是钻到了第几层 */
const LIBRARY_HISTORY_MARK = 'shuvixMobileLibrary'
/** 会话页第二层里「收件箱」那一页的 key（别的 key 是 ProjectSessionGroups 的组 key） */

const historyHas = (mark: string): boolean =>
  Boolean((window.history.state as Record<string, unknown> | null)?.[mark])

/** 当前这条历史上某个记号的数值（没有 = 0） */
const historyNumber = (mark: string): number => {
  const value = (window.history.state as Record<string, unknown> | null)?.[mark]
  return typeof value === 'number' ? value : 0
}

/**
 * 设置页此刻钻到第几层的记号（app-shell useStackedHistory 压的）：在它上面再压对话 / 小组件那一条时照样带上 ——
 * 退回来落在这一条上，设置还该停在那个分区里
 */
const settingsMarkHere = (): Record<string, number> => {
  const depth = historyNumber(STACKED_SETTINGS_HISTORY_MARK)
  return depth > 0 ? { [STACKED_SETTINGS_HISTORY_MARK]: depth } : {}
}

const headerIcon =
  'h-10 w-10 flex items-center justify-center rounded-full text-text-secondary active:bg-bg-hover'

/**
 * 专注模式在手机布局里关掉：它把没在用的侧栏淡化、鼠标移上去才恢复 —— 手机没有「移上去」，列表会一直是灰的。
 * 字号换成这台设备自己的（phoneFontSize.ts）：代码块等读 ChatHost 的 fontSize，正文读外壳上的 --app-font-size。
 * 控件密度是 touch：输入卡片的工具行、模型 / 扩展选择器换成手指的尺寸（选择器从底部抽屉打开）
 */
export function MobileShell(): React.JSX.Element {
  const host = useChatHost()
  const fontSize = usePhoneFontSize()
  const value = useMemo(
    () => ({
      ...host,
      appearance: { ...host.appearance, focusMode: false, fontSize },
      density: 'touch' as const
    }),
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
  // 会话页顶层的三种视图（与桌面侧栏同一个切换、同一份记忆）：分组列表 / 收件箱 / 日历。收件箱与日历头一次切到
  // 才挂，之后一直挂着、只切显示
  const view = useSidebarViewStore((st) => st.view)
  const setView = useSidebarViewStore((st) => st.setView)
  const [viewsMounted, setViewsMounted] = useState<ReadonlySet<SidebarView>>(() => new Set([view]))
  if (!viewsMounted.has(view)) setViewsMounted(new Set([...viewsMounted, view]))
  const { waiting, unread } = useInboxSections()
  const [newChatOpen, setNewChatOpen] = useState(false)
  /** 会话页的第二层：正在看的那一组（或收件箱）；null = 顶层 */
  const [scope, setScope] = useState<{ key: string; label: string } | null>(null)
  const scopeRef = useRef(false)
  /** 顶层的搜索词（按标题找会话） */
  const [query, setQuery] = useState('')
  /** 第二层留给列表的两个槽：顶栏右边的「⋯」和底部的工具栏（列表经 portal 画进来） */
  const [menuSlot, setMenuSlot] = useState<HTMLElement | null>(null)
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null)
  /** 资料库页往下钻的那几层（空 = 顶层）：某一组，知识库再多一层某个库 */
  const [libraryStack, setLibraryStack] = useState<Array<{ key: string; label: string }>>([])
  const libraryDepthRef = useRef(0)
  const [libraryMenuSlot, setLibraryMenuSlot] = useState<HTMLElement | null>(null)
  const [libraryToolbarSlot, setLibraryToolbarSlot] = useState<HTMLElement | null>(null)
  /** 设置页钻到了第几层（0 = 分区列表）：进了某个分区，标签栏收起 */
  const [settingsDepth, setSettingsDepth] = useState(0)
  const { projects } = useProjects()
  const fontSize = usePhoneFontSize()
  const widgetApp = useWidgetStore((s) => s.foregroundApp)
  const widgetAppOpen = tab === 'widgets' && widgetApp !== null

  // 长按 = 右键（只在手机布局里装）
  useEffect(() => installLongPressContextMenu(document), [])

  const openChat = useCallback((): void => {
    if (chatOpenRef.current) return
    chatOpenRef.current = true
    window.history.pushState(
      {
        [HISTORY_MARK]: true, // 在第二层上面再压的这一条也带上它的标记：退回来落在这一条上，第二层还该开着
        ...(scopeRef.current ? { [SCOPE_HISTORY_MARK]: true } : {}),
        ...(libraryDepthRef.current > 0 ? { [LIBRARY_HISTORY_MARK]: libraryDepthRef.current } : {}),
        ...settingsMarkHere()
      },
      ''
    )
    setChatOpen(true)
  }, [])

  const openScope = useCallback((key: string, label: string): void => {
    if (!scopeRef.current) {
      scopeRef.current = true
      window.history.pushState({ [SCOPE_HISTORY_MARK]: true }, '')
    }
    setScope({ key, label })
  }, [])

  /** 资料库往下钻一层（某一组；知识库那一页里再点一个库）：压一条历史，带着下面那几层的记号 */
  const openLibrary = useCallback((key: string, label: string): void => {
    const depth = libraryDepthRef.current + 1
    libraryDepthRef.current = depth
    window.history.pushState(
      {
        ...((window.history.state as Record<string, unknown> | null) ?? {}),
        [LIBRARY_HISTORY_MARK]: depth
      },
      ''
    )
    setLibraryStack((stack) => [...stack, { key, label }])
  }, [])

  /** 资料库那一页的返回键：退掉那一层压的历史（popstate 再收起一层），与返回手势同一条路 */
  const backInLibrary = useCallback((): void => {
    if (libraryDepthRef.current === 0) return
    if (historyNumber(LIBRARY_HISTORY_MARK) === libraryDepthRef.current) {
      window.history.back()
    } else {
      libraryDepthRef.current -= 1
      setLibraryStack((stack) => stack.slice(0, -1))
    }
  }, [])

  /** 第二层的返回键：退掉进组时压的那条历史（popstate 再回顶层），与返回手势同一条路 */
  const closeScope = useCallback((): void => {
    if (!scopeRef.current) return
    if (historyHas(SCOPE_HISTORY_MARK)) {
      window.history.back()
    } else {
      scopeRef.current = false
      setScope(null)
    }
  }, [])

  /** 返回键：退掉打开对话时压的那条历史（popstate 再收起对话页），与手机的返回手势同一条路 */
  const closeChat = useCallback((): void => {
    if (!chatOpenRef.current) return
    if (historyHas(HISTORY_MARK)) {
      // 对话页上面还开着详情（会话在详情里被删掉）：连那几条一起退掉，落在打开对话之前的那一条上
      window.history.go(-(1 + detailDepthOf(window.history.state)))
    } else {
      chatOpenRef.current = false
      setChatOpen(false)
    }
  }, [])

  useEffect(() => {
    // 重新加载时对话页 / 小组件开着：那条标记过的历史还在，但页面已经不在 —— 摘掉标记，免得之后要多退一次
    if (
      historyHas(HISTORY_MARK) ||
      historyHas(WIDGET_HISTORY_MARK) ||
      historyHas(SCOPE_HISTORY_MARK) ||
      historyHas(LIBRARY_HISTORY_MARK)
    ) {
      window.history.replaceState(null, '')
    }
    const onPop = (): void => {
      // 退回到的那一条还带着标记（比如页面里一个 #锚点 的前进 / 后退）：那一层还该开着
      if (chatOpenRef.current && !historyHas(HISTORY_MARK)) {
        chatOpenRef.current = false
        setChatOpen(false)
      }
      if (scopeRef.current && !historyHas(SCOPE_HISTORY_MARK)) {
        scopeRef.current = false
        setScope(null)
      }
      // 资料库：退回到的那一条说它在第几层，比此刻浅就收到那一层
      const libraryDepth = historyNumber(LIBRARY_HISTORY_MARK)
      if (libraryDepth < libraryDepthRef.current) {
        libraryDepthRef.current = libraryDepth
        setLibraryStack((stack) => stack.slice(0, libraryDepth))
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // 小组件：打开（卡片）压一条历史；顶栏的返回（goHome）退掉它；返回手势退掉它 → 回卡片列表
  useEffect(() => {
    const onPop = (): void => {
      if (useWidgetStore.getState().foregroundApp === null) return
      if (historyHas(WIDGET_HISTORY_MARK)) return
      useWidgetStore.getState().goHome()
    }
    window.addEventListener('popstate', onPop)
    const off = useWidgetStore.subscribe((state, prev) => {
      if (state.foregroundApp === prev.foregroundApp) return
      if (prev.foregroundApp === null) {
        window.history.pushState(
          {
            [WIDGET_HISTORY_MARK]: true, // 在第二层上面再压的这一条也带上它的标记：退回来落在这一条上，第二层还该开着
            ...(scopeRef.current ? { [SCOPE_HISTORY_MARK]: true } : {}),
            ...(libraryDepthRef.current > 0
              ? { [LIBRARY_HISTORY_MARK]: libraryDepthRef.current }
              : {}),
            ...settingsMarkHere()
          },
          ''
        )
      } else if (state.foregroundApp === null && historyHas(WIDGET_HISTORY_MARK)) {
        window.history.back()
      }
    })
    return () => {
      window.removeEventListener('popstate', onPop)
      off()
    }
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

  /** 收件箱里点一行：选中它并推入对话页（点的是此刻已经活跃的那一条也推） */
  const openFromInbox = useCallback(
    (id: string): void => {
      useChatStore.getState().setActiveSessionId(id)
      openChat()
    },
    [openChat]
  )
  // 交给侧栏的两层导航
  const drill = useMemo(
    () => ({
      scope: scope?.key ?? null,
      onOpen: openScope,
      query,
      menuSlot,
      toolbarSlot
    }),
    [scope, openScope, query, menuSlot, toolbarSlot]
  )
  /** 正在看某一组的会话列表：底部是那一组的工具栏，标签栏收起 */
  const groupOpen = tab === 'sessions' && scope !== null
  /** 推入的页面不带标签栏：只有四个顶层页面有（会话页的某一组、设置的分区页、资料库的分组页）。收件箱与日历是
   *  会话页顶层的两种视图，不是推入的页面，标签栏留着 */
  const libraryPage = libraryStack.length > 0 ? libraryStack[libraryStack.length - 1] : null
  const libraryOpen = tab === 'library' && libraryPage !== null
  const libraryDrill = useMemo(
    () => ({
      scope: libraryPage?.key ?? null,
      onOpen: openLibrary,
      menuSlot: libraryMenuSlot,
      toolbarSlot: libraryToolbarSlot
    }),
    [libraryPage, openLibrary, libraryMenuSlot, libraryToolbarSlot]
  )
  const pushedPageOpen =
    (tab === 'sessions' && scope !== null) ||
    libraryOpen ||
    (tab === 'settings' && settingsDepth > 0)
  // 跟踪项在收件箱里（资料库不再有它的入口）
  const trackingAdapter = useTrackingAdapter(openFromInbox)

  // 顶层的顶栏：视图切换（会话 / 收件箱 / 日历）与新建。进了某一组，新建在底部的工具栏里，顶栏右边是那一组的「⋯」
  const sessionsActions = (
    <>
      <SidebarViewSwitch
        value={view}
        onChange={setView}
        inboxAlert={waiting.length > 0}
        inboxCount={waiting.length + unread.length}
        size="touch"
        className="mr-1"
      />
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
              {scope ? (
                <>
                  {/* 第二层的顶栏：返回（写着上一层的名字）在上，那一组的名字是大标题 */}
                  <div className="flex items-center pl-2 pr-2 pt-2 flex-shrink-0">
                    <button
                      type="button"
                      data-mobile-scope-back=""
                      onClick={closeScope}
                      className="flex h-9 items-center gap-0.5 rounded-full pl-1 pr-3 text-[16px] text-accent active:bg-bg-hover"
                    >
                      <ChevronLeft size={22} aria-hidden="true" />
                      <span>{t('mobile.tabSessions')}</span>
                    </button>
                    {/* 那一组的菜单「⋯」：列表画进来 */}
                    <div ref={setMenuSlot} data-mobile-scope-menu-slot="" className="ml-auto" />
                  </div>
                  <div data-mobile-scope-title="">{pageTitle(scope.label)}</div>
                </>
              ) : (
                <>
                  {/* 大标题跟着视图走：会话 / 收件箱 / 日历 */}
                  <div data-mobile-view-title={view}>
                    {pageTitle(
                      view === 'sessions'
                        ? t('mobile.tabSessions')
                        : t(SIDEBAR_VIEW_LABEL_KEYS[view]),
                      sessionsActions
                    )}
                  </div>
                  {/* 搜索（只有分组列表那种视图有）：按标题找会话，列表就地换成结果 */}
                  {view === 'sessions' && (
                    <div className="flex flex-shrink-0 items-center gap-2 px-3 pb-3">
                      <label className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] bg-bg-secondary px-2.5 text-text-tertiary">
                        <Search size={16} aria-hidden="true" className="shrink-0" />
                        <input
                          data-mobile-search=""
                          type="search"
                          enterKeyHint="search"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder={t('mobile.search')}
                          aria-label={t('mobile.search')}
                          className="min-w-0 flex-1 appearance-none bg-transparent text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:hidden"
                        />
                        {query && (
                          <button
                            type="button"
                            data-mobile-search-clear=""
                            onClick={() => setQuery('')}
                            aria-label={t('mobile.cancel')}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-hover text-text-secondary"
                          >
                            <X size={14} aria-hidden="true" />
                          </button>
                        )}
                      </label>
                    </div>
                  )}
                </>
              )}
              {/* 列表与日历都挂着、只切显示：切回列表时项目的展开状态与滚动位置都还在。列表就是桌面的侧栏，
                  只是密度换成手指的那一档（Sidebar mode="sessions" → density touch） */}
              <div className="flex-1 min-h-0 relative" data-mobile-list="">
                <div
                  className="absolute inset-0"
                  style={view !== 'sessions' && !scope ? { display: 'none' } : undefined}
                >
                  <Sidebar mode="sessions" onOpenSession={openChat} drill={drill} />
                </div>
                {viewsMounted.has('inbox') && (
                  // 收件箱视图：桌面侧栏里那同一个组件，字号按手机放大
                  <div
                    className="absolute inset-0"
                    data-mobile-inbox=""
                    data-mobile-scale=""
                    style={view === 'inbox' && !scope ? undefined : { display: 'none' }}
                  >
                    <InboxPanel tracking={trackingAdapter} onSelectSession={openFromInbox} />
                  </div>
                )}
                {viewsMounted.has('calendar') && (
                  <div
                    className="absolute inset-0"
                    data-mobile-scale=""
                    data-sidebar-density="touch"
                    style={view === 'calendar' && !scope ? undefined : { display: 'none' }}
                  >
                    <CalendarPanel mobile onOpenSession={openChat} />
                  </div>
                )}
              </div>
            </section>
          )}
          {visited.has('widgets') && (
            <section
              data-mobile-page="widgets"
              data-mobile-scale=""
              data-widget-app-open={widgetAppOpen ? '' : undefined}
              className={`absolute inset-0 flex flex-col ${
                widgetAppOpen ? 'pb-[env(safe-area-inset-bottom)]' : ''
              }`}
              style={tab === 'widgets' ? undefined : { display: 'none' }}
            >
              {/* 应用开着：没有页头（应用自己的顶栏有返回），标签栏也收起（见下）—— 应用占满整屏 */}
              {!widgetAppOpen && pageTitle(t('mobile.tabWidgets'))}
              <div className="flex-1 min-h-0">
                <WidgetPanel mobile />
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
              {libraryPage ? (
                <>
                  {/* 推入页的顶栏：返回写着上一层的名字，右边是这一组的菜单「⋯」（列表画进来） */}
                  <div className="flex items-center pl-2 pr-2 pt-2 flex-shrink-0">
                    <button
                      type="button"
                      data-mobile-library-back=""
                      onClick={backInLibrary}
                      className="flex h-9 max-w-[70%] items-center gap-0.5 rounded-full pl-1 pr-3 text-[16px] text-accent active:bg-bg-hover"
                    >
                      <ChevronLeft size={22} className="flex-shrink-0" aria-hidden="true" />
                      <span className="truncate">
                        {libraryStack.length > 1
                          ? libraryStack[libraryStack.length - 2].label
                          : t('mobile.tabLibrary')}
                      </span>
                    </button>
                    <div
                      ref={setLibraryMenuSlot}
                      data-mobile-library-menu-slot=""
                      className="ml-auto"
                    />
                  </div>
                  <div data-mobile-library-title="">{pageTitle(libraryPage.label)}</div>
                </>
              ) : (
                pageTitle(t('mobile.tabLibrary'))
              )}
              <div className="flex-1 min-h-0">
                <Sidebar mode="library" onOpenSession={openChat} libraryDrill={libraryDrill} />
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
                onStackedDepthChange={setSettingsDepth}
                extraTabs={[
                  {
                    id: 'agents',
                    // 与监视器、已归档同一张卡片
                    group: 'maintenance',
                    label: t('panel.agents'),
                    icon: <Bot size={14} />,
                    content: <AgentMonitorPanel active={tab === 'settings' && !chatOpen} />
                  }
                ]}
              />
            </section>
          )}
        </div>

        {/* 某一组的会话列表开着：底部是那一组的工具栏（列表画进这个槽里），标签栏收起 —— 回到顶层才换页 */}
        <div
          ref={setToolbarSlot}
          data-mobile-scope-toolbar-slot=""
          className="flex-shrink-0 border-t border-border-secondary/60 bg-bg-secondary/80 pb-[env(safe-area-inset-bottom)]"
          style={groupOpen ? undefined : { display: 'none' }}
        />
        {/* 资料库某一组的那一页：底部是它的工具栏（数量 · 新建），同样由列表画进这个槽里 */}
        <div
          ref={setLibraryToolbarSlot}
          data-mobile-library-toolbar-slot=""
          className="flex-shrink-0 border-t border-border-secondary/60 bg-bg-secondary/80 pb-[env(safe-area-inset-bottom)]"
          style={libraryOpen ? undefined : { display: 'none' }}
        />
        {/* 底部标签栏：只有四个顶层页面有 —— 小组件整屏开着、或任何一页推入的页面开着时收起 */}
        <nav
          data-mobile-tabbar=""
          className="flex-shrink-0 flex border-t border-border-secondary/60 bg-bg-secondary/80 pb-[env(safe-area-inset-bottom)]"
          style={widgetAppOpen || pushedPageOpen ? { display: 'none' } : undefined}
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
