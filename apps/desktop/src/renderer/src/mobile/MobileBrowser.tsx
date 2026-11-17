/**
 * 手机布局的「浏览器」—— 设置页里的一行整屏推入（2026-11-17）：管理运行 ShuviX 的那台电脑上内置浏览器的标签页。
 * 桌面浏览器里远程访问时的管理页（#browser-manager，BrowserTabsManager）是同一件事的另一副样子，判断共用
 * tabsManagerPure.ts。
 *
 * 两页：
 *  - 列表：顶上一行开新标签页（开在后台，不切换那台电脑上正在看的页）；下面一张卡片，一个标签页一行两排（标题，
 *    下面是网站与状态：谁在用、崩了、加载中）；再下面一行进「浏览器设置」。行上没有按钮 —— 点一行进那一页，长按是
 *    刷新 / 关闭。右上角「⋯」刷新列表，底部是数量。
 *  - 一个标签页：大标题是页面标题，下面是地址；谁在用（「查看对话」打开那场对话）；截图（进这一页截一次，可以
 *    重新截）；换个地址、刷新 / 停止、关闭。agent 用着的页，刷新、关闭、换地址先问一声（与管理页同一条）。这一页
 *    没了（被关掉）→ 退回列表。
 *
 * 列表、地址、截图是 admin：这台设备被策略拒了就显示那句话。哪一页开着由 MobileShell 管（它连着浏览器历史）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ChevronRight,
  CircleEllipsis,
  Globe,
  History as HistoryIcon,
  Loader2,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  SlidersHorizontal
} from 'lucide-react'
import { isImeComposing } from '@shuvix/chat-ui'
import { ConfirmDialog, useContextMenu } from '@shuvix/app-shell'
import {
  DEFAULT_SEARCH_ENGINE,
  SEARCH_ENGINE_SETTING,
  resolveOmniboxInput,
  searchEngineOf,
  type SearchEngineId
} from '../components/browser/omnibox'
import { INTERCEPTING_DOT_COLOR, sessionDotColor } from '../components/browser/sessionColor'
import {
  GUARD_COPY,
  needsConfirm,
  reasonOf,
  screenshotWidth,
  sessionNameOf,
  usedByAgent,
  type GuardedRequest,
  type TabRow
} from '../components/browser/tabsManagerPure'
import { MobilePage, pageCard, pageRow, pageRowBase } from './MobilePage'
import { PullDownMenu, type PullDownItem } from './PullDownMenu'
import { hostOfTab } from './browserPure'
import type { BrowserTabsState } from './useBrowserTabs'

/** 一个标签页显示的名字：内部页面是它的名字，否则标题 > 地址 > 「新标签页」 */
function useTabTitle(): (tab: TabRow) => string {
  const { t } = useTranslation()
  return (tab) =>
    tab.internalPage !== undefined
      ? t(`browser.internal.${tab.internalPage}`)
      : tab.title || tab.url || t('browser.untitledTab')
}

/** 跑一个动作：失败的那句话交回来（成功 = null）；之后重新取一次列表 */
async function runAction(
  action: () => Promise<unknown>,
  refused: string,
  reload: () => void
): Promise<string | null> {
  try {
    await action()
    return null
  } catch (error) {
    return reasonOf(error, refused)
  } finally {
    reload()
  }
}

function performRequest(request: GuardedRequest): Promise<unknown> {
  if (request.action === 'navigate') {
    return window.api.browserView.navigate(request.tabId, request.target, 'typed')
  }
  return request.action === 'close'
    ? window.api.browserView.closeTab(request.tabId)
    : window.api.browserView.reload(request.tabId)
}

/** agent 用着的页上要先问的那一句（刷新 / 关闭 / 换地址） */
function GuardDialog({
  request,
  tab,
  onConfirm,
  onCancel
}: {
  request: GuardedRequest
  tab: TabRow
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const session = sessionNameOf(tab)
  return (
    <ConfirmDialog
      title={t(GUARD_COPY[request.action].title)}
      description={
        <div className="space-y-1" data-browser-tab-agent-confirm={request.action}>
          <p className="break-words">
            {session ? t('browser.infobar.using', { session }) : t('browser.infobar.usingUnknown')}
          </p>
          <p>{t(GUARD_COPY[request.action].body)}</p>
          {request.action === 'navigate' && (
            <p
              className="line-clamp-3 break-all font-mono text-text-primary"
              data-browser-tab-confirm-target=""
            >
              {request.target}
            </p>
          )}
        </div>
      }
      confirmText={t(GUARD_COPY[request.action].confirm)}
      cancelText={t('browser.manager.cancel')}
      danger={request.action === 'close'}
      autoFocusConfirm={request.action === 'navigate'}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}

function ErrorCard({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      data-mobile-browser-error=""
      className="flex items-start gap-2 rounded-xl bg-error/10 px-4 py-3 text-[14px] text-error"
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {t('browser.manager.actionFailed', { reason: text })}
      </span>
    </div>
  )
}

/** 行首那一格：内部页面的图标 / 加载中 / 崩了 / 地球；agent 接着的页右下角一颗它那场会话的色点 */
function TabIcon({ tab }: { tab: TabRow }): React.JSX.Element {
  const props = { size: 20, 'aria-hidden': true } as const
  return (
    <span className="relative shrink-0 text-text-tertiary">
      {tab.internalPage === 'settings' ? (
        <SettingsIcon {...props} />
      ) : tab.internalPage === 'history' ? (
        <HistoryIcon {...props} />
      ) : tab.crashed ? (
        <AlertTriangle {...props} className="text-error" />
      ) : tab.loading ? (
        <Loader2 {...props} className="animate-spin" />
      ) : (
        <Globe {...props} />
      )}
      {usedByAgent(tab) && (
        <span
          data-tab-agent-dot=""
          className="absolute -bottom-0.5 -right-0.5 h-[9px] w-[9px] rounded-full ring-2 ring-bg-secondary"
          style={{
            background:
              tab.cdpIntercepting || !tab.agentSessionId
                ? INTERCEPTING_DOT_COLOR
                : sessionDotColor(tab.agentSessionId)
          }}
        />
      )}
    </span>
  )
}

export interface MobileBrowserTabsPageProps {
  state: BrowserTabsState
  /** 那台电脑在无头运行 */
  headless: boolean
  /** 这一页此刻在最上面（从浏览器设置退回来时重新读一遍搜索引擎：那里可能改过） */
  active: boolean
  onBack: () => void
  onOpenTab: (tabId: string) => void
  onOpenSettings: () => void
}

export function MobileBrowserTabsPage({
  state,
  headless,
  active,
  onBack,
  onOpenTab,
  onOpenSettings
}: MobileBrowserTabsPageProps): React.JSX.Element {
  const { t } = useTranslation()
  const { tabs, listError, reload } = state
  const titleOf = useTabTitle()
  const showContextMenu = useContextMenu()
  const [newUrl, setNewUrl] = useState('')
  const [opening, setOpening] = useState(false)
  const [engine, setEngine] = useState<SearchEngineId>(DEFAULT_SEARCH_ENGINE)
  const [actionError, setActionError] = useState<string | null>(null)
  const [guarded, setGuarded] = useState<GuardedRequest | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<{ right: number; bottom: number } | null>(null)
  const refused = t('browser.manager.remoteUrlRefused')

  useEffect(() => {
    if (!active) return
    void window.api.settings
      .getAll()
      .then((settings) => setEngine(searchEngineOf(settings[SEARCH_ENGINE_SETTING])))
      .catch(() => undefined)
  }, [active])

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setActionError(null)
    const failed = await runAction(action, refused, reload)
    setActionError(failed)
    return failed === null
  }

  const openNew = async (): Promise<void> => {
    if (opening) return
    const target = resolveOmniboxInput(newUrl, engine)
    setOpening(true)
    const ok = await run(() =>
      target === null
        ? window.api.browserView.createTab()
        : window.api.browserView.createTab(target, 'typed')
    )
    setOpening(false)
    if (ok) setNewUrl('')
  }

  const request = (next: GuardedRequest): void => {
    const tab = tabs?.find((row) => row.id === next.tabId)
    if (tab && needsConfirm(tab, next.action)) setGuarded(next)
    else void run(() => performRequest(next))
  }

  // 确认框问的理由不在了（那页没了、agent 不用了、页面崩了）：不再问
  const guardedTab = guarded
    ? tabs?.find((tab) => tab.id === guarded.tabId && needsConfirm(tab, guarded.action))
    : undefined
  // 理由没了就把这一问丢掉（渲染时改 state：React 会立刻重画）—— 不然理由回来时确认框会自己再弹出来
  if (guarded && tabs !== null && !guardedTab) setGuarded(null)

  const menuGroups: PullDownItem[][] = [
    [
      {
        id: 'refresh',
        label: t('browser.manager.refreshList'),
        icon: <RefreshCw size={18} aria-hidden="true" />
      }
    ]
  ]

  const secondLine = (tab: TabRow): { text: string; tone: 'error' | 'muted' } => {
    const host = hostOfTab(tab)
    const session = sessionNameOf(tab)
    if (tab.crashed) {
      return {
        text: [host, t('browser.manager.crashed')].filter(Boolean).join(' · '),
        tone: 'error'
      }
    }
    const status = session
      ? t('browser.tabUsedBy', { session })
      : tab.cdpAttached
        ? t('browser.infobar.usingUnknown')
        : tab.loading
          ? t('browser.manager.loading')
          : ''
    return { text: [host, status].filter(Boolean).join(' · '), tone: 'muted' }
  }

  return (
    <MobilePage
      kind="browser-tabs"
      backLabel={t('mobile.tabSettings')}
      onBack={onBack}
      title={t('browser.manager.title')}
      actions={
        <button
          type="button"
          data-mobile-browser-menu=""
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMenuAnchor({ right: rect.right, bottom: rect.bottom })
          }}
          aria-label={t('mobile.moreActions')}
          aria-haspopup="menu"
          aria-expanded={menuAnchor !== null}
          className="flex h-10 w-10 items-center justify-center rounded-full text-accent active:bg-bg-hover"
        >
          <CircleEllipsis size={22} aria-hidden="true" />
        </button>
      }
      toolbar={
        <span data-mobile-browser-count="">
          {tabs && !listError ? t('browser.manager.tabCount', { count: tabs.length }) : ''}
        </span>
      }
      bodyClassName="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-6 pt-1"
    >
      <p data-mobile-browser-note="" className="px-4 text-[13px] leading-snug text-text-tertiary">
        {headless ? t('browser.manager.headlessNote') : t('browser.manager.remoteNote')}
      </p>

      <div>
        <form
          data-mobile-browser-new-tab=""
          className={pageCard}
          onSubmit={(e) => {
            e.preventDefault()
            void openNew()
          }}
        >
          <div className={`${pageRowBase} text-text-primary`}>
            <Plus size={18} className="shrink-0 text-text-tertiary" aria-hidden="true" />
            <input
              data-mobile-browser-new-tab-input=""
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder={t('browser.manager.newTabPlaceholder')}
              aria-label={t('browser.manager.newTabPlaceholder')}
              inputMode="url"
              enterKeyHint="go"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-text-tertiary"
            />
            <button
              type="submit"
              data-mobile-browser-new-tab-open=""
              disabled={opening}
              className="flex shrink-0 items-center gap-1 text-accent disabled:opacity-50"
            >
              {opening && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {t('browser.manager.open')}
            </button>
          </div>
        </form>
        <p className="px-4 pt-1.5 text-[13px] leading-snug text-text-tertiary">
          {t('browser.manager.openedRemotely')}
        </p>
      </div>

      {actionError && <ErrorCard text={actionError} />}

      {listError ? (
        <p
          data-mobile-browser-denied=""
          className="rounded-xl bg-bg-secondary px-4 py-3 text-[15px] text-text-secondary"
        >
          {t('browser.manager.notAllowed', { reason: listError })}
        </p>
      ) : tabs === null ? (
        <div className="flex items-center justify-center gap-2 py-8 text-[14px] text-text-tertiary">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          {t('common.loading')}
        </div>
      ) : tabs.length === 0 ? (
        <p
          data-mobile-browser-empty=""
          className="px-4 py-8 text-center text-[14px] text-text-tertiary"
        >
          {t('browser.manager.noTabs')}
        </p>
      ) : (
        <div className={pageCard} data-mobile-browser-tabs="">
          {tabs.map((tab) => {
            const second = secondLine(tab)
            return (
              <button
                key={tab.id}
                type="button"
                data-mobile-browser-tab={tab.id}
                data-tab-crashed={tab.crashed ? 'true' : undefined}
                data-tab-loading={tab.loading ? 'true' : undefined}
                data-tab-agent={tab.agentSessionId}
                onClick={() => onOpenTab(tab.id)}
                onContextMenu={(e) =>
                  void showContextMenu(
                    e,
                    [
                      { id: 'reload', label: t('browser.refresh') },
                      { id: 'close', label: t('browser.closeTab') }
                    ],
                    (action) => {
                      if (action === 'reload' || action === 'close') {
                        request({ tabId: tab.id, action })
                      }
                    }
                  )
                }
                className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2 text-left active:bg-bg-hover"
              >
                <TabIcon tab={tab} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px] text-text-primary">
                    {titleOf(tab)}
                  </span>
                  {second.text && (
                    <span
                      data-tab-meta=""
                      className={`block truncate text-[13px] ${
                        second.tone === 'error' ? 'text-error' : 'text-text-tertiary'
                      }`}
                    >
                      {second.text}
                    </span>
                  )}
                </span>
                <ChevronRight
                  size={16}
                  className="shrink-0 text-text-tertiary"
                  aria-hidden="true"
                />
              </button>
            )
          })}
        </div>
      )}

      <div className={pageCard}>
        <button
          type="button"
          data-mobile-browser-open-settings=""
          onClick={onOpenSettings}
          className={`${pageRow} active:bg-bg-hover`}
        >
          <SlidersHorizontal size={19} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{t('mobile.browserSettings')}</span>
          <ChevronRight size={16} className="shrink-0 text-text-tertiary" aria-hidden="true" />
        </button>
      </div>

      {menuAnchor && (
        <PullDownMenu
          anchor={menuAnchor}
          groups={menuGroups}
          onPick={(id) => {
            if (id === 'refresh') reload()
          }}
          onClose={() => setMenuAnchor(null)}
        />
      )}
      {guarded && guardedTab && (
        <GuardDialog
          request={guarded}
          tab={guardedTab}
          onConfirm={() => {
            setGuarded(null)
            void run(() => performRequest(guarded))
          }}
          onCancel={() => setGuarded(null)}
        />
      )}
    </MobilePage>
  )
}

type ShotState =
  | { kind: 'loading' }
  | { kind: 'shown'; src: string; at: number }
  | { kind: 'empty' }
  | { kind: 'failed'; reason: string }

/** 一个标签页的截图：进这一页截一次，「重新截图」再截；不自动刷新 */
function TabScreenshot({ tabId }: { tabId: string }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<ShotState>({ kind: 'loading' })
  /** 每截一次加一；离开（卸载）也加一 —— 晚回来的结果对不上就不写 */
  const seq = useRef(0)
  const refused = t('browser.manager.remoteUrlRefused')

  const capture = useCallback(
    async (mine: number): Promise<void> => {
      try {
        const src = await window.api.browserView.capture(tabId, screenshotWidth())
        if (mine !== seq.current) return
        setState(src ? { kind: 'shown', src, at: Date.now() } : { kind: 'empty' })
      } catch (error) {
        if (mine !== seq.current) return
        setState({ kind: 'failed', reason: reasonOf(error, refused) })
      }
    },
    [tabId, refused]
  )

  useEffect(() => {
    const counter = seq
    void capture(++counter.current)
    return () => {
      counter.current++
    }
  }, [capture])

  const retake = (): void => {
    setState({ kind: 'loading' })
    void capture(++seq.current)
  }

  return (
    <div className={pageCard} data-mobile-browser-screenshot={state.kind}>
      {state.kind === 'shown' ? (
        <img
          src={state.src}
          alt={t('browser.manager.screenshotAlt')}
          draggable={false}
          data-mobile-browser-screenshot-image=""
          className="block h-auto w-full bg-bg-tertiary"
        />
      ) : (
        <div className="flex min-h-[120px] items-center justify-center gap-2 px-4 py-6 text-center text-[14px] text-text-tertiary">
          {state.kind === 'loading' ? (
            <>
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              {t('browser.manager.screenshotLoading')}
            </>
          ) : state.kind === 'empty' ? (
            t('browser.manager.screenshotEmpty')
          ) : (
            <span className="text-error">
              {t('browser.manager.screenshotFailed', { reason: state.reason })}
            </span>
          )}
        </div>
      )}
      <div className={`${pageRowBase} text-[13px] text-text-tertiary`}>
        <span className="min-w-0 flex-1 truncate">
          {state.kind === 'shown'
            ? t('browser.manager.screenshotTakenAt', {
                time: new Date(state.at).toLocaleTimeString(i18n.language, {
                  hour: '2-digit',
                  minute: '2-digit'
                })
              })
            : t('browser.manager.screenshotNote')}
        </span>
        <button
          type="button"
          data-mobile-browser-screenshot-retake=""
          onClick={retake}
          disabled={state.kind === 'loading'}
          className="shrink-0 text-[15px] text-accent disabled:opacity-50"
        >
          {t('browser.manager.retakeScreenshot')}
        </button>
      </div>
    </div>
  )
}

export interface MobileBrowserTabPageProps {
  state: BrowserTabsState
  tabId: string
  onBack: () => void
  /** 「查看对话」：打开用着这一页的那场对话 */
  onOpenSession: (sessionId: string) => void
}

export function MobileBrowserTabPage({
  state,
  tabId,
  onBack,
  onOpenSession
}: MobileBrowserTabPageProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const { tabs, listError, reload } = state
  const titleOf = useTabTitle()
  const tab = tabs?.find((row) => row.id === tabId)
  const [actionError, setActionError] = useState<string | null>(null)
  const [guarded, setGuarded] = useState<GuardedRequest | null>(null)
  /** 正在改地址：输入框里的字（null = 没在改） */
  const [address, setAddress] = useState<string | null>(null)
  const [engine, setEngine] = useState<SearchEngineId>(DEFAULT_SEARCH_ENGINE)
  const addressInput = useRef<HTMLInputElement>(null)
  const refused = t('browser.manager.remoteUrlRefused')

  useEffect(() => {
    void window.api.settings
      .getAll()
      .then((settings) => setEngine(searchEngineOf(settings[SEARCH_ENGINE_SETTING])))
      .catch(() => undefined)
  }, [])

  // 清单到了、里面却没有这一页（被关掉了）：退回列表。清单还没到不算
  const gone = tabs !== null && !tab
  useEffect(() => {
    if (gone) onBack()
  }, [gone, onBack])
  if (!tab) {
    // 被关掉了：上面那个 effect 正在退回列表，这一帧不画
    if (tabs !== null) return null
    // 清单还没到（从对话页退回来、这一摞刚重新挂上），或这台设备看不了标签页：照样有返回键，说明在等什么
    return (
      <MobilePage
        kind="browser-tab"
        backLabel={t('browser.manager.title')}
        onBack={onBack}
        title={t('browser.manager.title')}
      >
        {listError ? (
          <p
            data-mobile-browser-denied=""
            className="rounded-xl bg-bg-secondary px-4 py-3 text-[15px] text-text-secondary"
          >
            {t('browser.manager.notAllowed', { reason: listError })}
          </p>
        ) : (
          <div
            data-mobile-browser-tab-loading=""
            className="flex items-center justify-center gap-2 py-8 text-[14px] text-text-tertiary"
          >
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            {t('common.loading')}
          </div>
        )}
      </MobilePage>
    )
  }
  // 确认框问的理由没了（agent 不用了、页面崩了）：把这一问丢掉，理由回来时不自己再弹
  if (guarded && !needsConfirm(tab, guarded.action)) setGuarded(null)

  const perform = async (request: GuardedRequest): Promise<void> => {
    setActionError(null)
    const failed = await runAction(() => performRequest(request), refused, reload)
    setActionError(failed)
    if (request.action !== 'navigate') return
    // 去成了才收起输入框；失败了字留着
    if (failed === null) setAddress(null)
    else addressInput.current?.focus()
  }

  const request = (next: GuardedRequest): void => {
    if (needsConfirm(tab, next.action)) setGuarded(next)
    else void perform(next)
  }

  const submitAddress = (): void => {
    if (address === null) return
    const target = resolveOmniboxInput(address, engine)
    if (target === null) {
      setAddress(null)
      return
    }
    request({ tabId, action: 'navigate', target })
  }

  const stop = async (): Promise<void> => {
    setActionError(null)
    setActionError(await runAction(() => window.api.browserView.stop(tabId), refused, reload))
  }

  const session = sessionNameOf(tab)
  const internal = tab.internalPage !== undefined
  const showGuard = guarded !== null && needsConfirm(tab, guarded.action)

  return (
    <MobilePage
      kind="browser-tab"
      backLabel={t('browser.manager.title')}
      onBack={onBack}
      title={titleOf(tab)}
      subtitle={
        internal ? undefined : (
          <span data-mobile-browser-tab-url="" className="font-mono">
            {tab.url || 'about:blank'}
          </span>
        )
      }
      bodyClassName="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-6 pt-1"
    >
      <div data-mobile-browser-tab-detail={tab.id} className="space-y-4">
        {actionError && <ErrorCard text={actionError} />}

        {(tab.crashed || usedByAgent(tab)) && (
          <div className={pageCard} data-mobile-browser-tab-status="">
            {tab.crashed && (
              <div className={`${pageRowBase} text-error`} data-mobile-browser-tab-crashed="">
                <AlertTriangle size={18} className="shrink-0" aria-hidden="true" />
                {t('browser.manager.crashed')}
              </div>
            )}
            {usedByAgent(tab) && (
              <div className={`${pageRow} py-2`} data-mobile-browser-tab-agent="">
                <span
                  className="h-[9px] w-[9px] shrink-0 rounded-full"
                  style={{
                    background:
                      tab.cdpIntercepting || !tab.agentSessionId
                        ? INTERCEPTING_DOT_COLOR
                        : sessionDotColor(tab.agentSessionId)
                  }}
                />
                <span className="min-w-0 flex-1 text-[15px] leading-snug">
                  {tab.cdpIntercepting
                    ? session
                      ? t('browser.infobar.intercepting', { session })
                      : t('browser.infobar.interceptingUnknown')
                    : session
                      ? t('browser.infobar.using', { session })
                      : t('browser.infobar.usingUnknown')}
                </span>
                {tab.agentSessionId && (
                  <button
                    type="button"
                    data-mobile-browser-tab-open-session=""
                    onClick={() => onOpenSession(tab.agentSessionId as string)}
                    className="shrink-0 text-[15px] text-accent"
                  >
                    {t('browser.infobar.openSession')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {!internal && <TabScreenshot tabId={tab.id} />}

        <div className={pageCard}>
          {!internal &&
            (address === null ? (
              <button
                type="button"
                data-mobile-browser-tab-edit=""
                onClick={() => setAddress(tab.url)}
                className={`${pageRow} active:bg-bg-hover`}
              >
                {t('browser.manager.changeAddress')}
              </button>
            ) : (
              <form
                className={`${pageRowBase} text-text-primary`}
                onSubmit={(e) => {
                  e.preventDefault()
                  submitAddress()
                }}
              >
                <input
                  ref={addressInput}
                  autoFocus
                  data-mobile-browser-tab-address=""
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  onKeyDown={(e) => {
                    if (isImeComposing(e)) return
                    // 确认框开着时 Esc 是取消确认框，输入框和里面的字留着
                    if (e.key === 'Escape' && !showGuard) setAddress(null)
                  }}
                  aria-label={t('browser.manager.changeAddress')}
                  inputMode="url"
                  enterKeyHint="go"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="min-w-0 flex-1 bg-transparent font-mono text-[15px] outline-none"
                />
                <button
                  type="submit"
                  data-mobile-browser-tab-go=""
                  className="shrink-0 text-accent"
                >
                  {t('browser.manager.go')}
                </button>
                <button
                  type="button"
                  data-mobile-browser-tab-cancel=""
                  onClick={() => {
                    setAddress(null)
                    setGuarded((cur) => (cur?.action === 'navigate' ? null : cur))
                  }}
                  className="shrink-0 text-text-secondary"
                >
                  {t('browser.manager.cancel')}
                </button>
              </form>
            ))}
          {tab.loading ? (
            <button
              type="button"
              data-mobile-browser-tab-stop=""
              onClick={() => void stop()}
              className={`${pageRow} active:bg-bg-hover`}
            >
              {t('browser.stop')}
            </button>
          ) : (
            <button
              type="button"
              data-mobile-browser-tab-reload=""
              onClick={() => request({ tabId, action: 'reload' })}
              className={`${pageRow} active:bg-bg-hover`}
            >
              {t('browser.refresh')}
            </button>
          )}
        </div>

        <div className={pageCard}>
          <button
            type="button"
            data-mobile-browser-tab-close=""
            onClick={() => request({ tabId, action: 'close' })}
            className={`${pageRowBase} text-error active:bg-bg-hover`}
          >
            {t('browser.closeTab')}
          </button>
        </div>
      </div>

      {guarded && showGuard && (
        <GuardDialog
          request={guarded}
          tab={tab}
          onConfirm={() => {
            setGuarded(null)
            void perform(guarded)
          }}
          onCancel={() => {
            setGuarded(null)
            addressInput.current?.focus()
          }}
        />
      )}
    </MobilePage>
  )
}
