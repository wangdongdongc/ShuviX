import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Camera,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Settings as SettingsIcon,
  Square,
  X,
  History as HistoryIcon
} from 'lucide-react'
import { useAppEvent } from '@shuvix/chat-ui'
import {
  DEFAULT_SEARCH_ENGINE,
  SEARCH_ENGINE_SETTING,
  resolveOmniboxInput,
  searchEngineOf
} from './omnibox'
import { INTERCEPTING_DOT_COLOR, sessionDotColor } from './sessionColor'
import { ConfirmDialog } from '../common/ConfirmDialog'
import type { SearchEngineId } from './omnibox'
import { REMOTE_URL_REFUSED_CODE } from '../../../../shared/browserRemoteUrls'

/** 一个标签页（主进程 listTabs 的一行） */
type TabRow = Awaited<ReturnType<typeof window.api.browserView.listTabs>>[number]

/** 调用失败的那句话（网络客户端被策略拒绝时就是规则的 prompt）；地址被拒（remote_url_refused）换成本地化的说法 */
function reasonOf(error: unknown, refusedText: string): string {
  if ((error as { code?: unknown } | null)?.code === REMOTE_URL_REFUSED_CODE) return refusedText
  return error instanceof Error ? error.message : String(error)
}

/** agent 用着的页上要先问一声的动作；换地址带上要去的地方 */
type GuardedRequest =
  | { tabId: string; action: 'reload' | 'close' }
  | { tabId: string; action: 'navigate'; target: string }
type GuardedAction = GuardedRequest['action']

/** 确认框里每个动作的文案 */
const GUARD_COPY: Record<GuardedAction, { title: string; body: string; confirm: string }> = {
  close: {
    title: 'browser.manager.confirmCloseTitle',
    body: 'browser.manager.confirmCloseBody',
    confirm: 'browser.closeTab'
  },
  reload: {
    title: 'browser.manager.confirmReloadTitle',
    body: 'browser.manager.confirmReloadBody',
    confirm: 'browser.refresh'
  },
  navigate: {
    title: 'browser.manager.confirmNavigateTitle',
    body: 'browser.manager.confirmNavigateBody',
    confirm: 'browser.manager.go'
  }
}

/**
 * 这一页正被 agent 用着：行上写着「正被谁使用」的，或接着 CDP 但还没记下会话的（agent 点出来的新页，它还没动过）。
 * CDP 接入跨轮持久，所以这不等于 agent 此刻正在动作。
 */
function usedByAgent(tab: TabRow): boolean {
  return Boolean(tab.agentSessionId) || tab.cdpAttached
}

/** 这个动作要不要先问：agent 用着才问；崩了的页刷新、换地址不问（它已经什么都做不了，这两样就是恢复），关闭照问 */
function needsConfirm(tab: TabRow, action: GuardedAction): boolean {
  return usedByAgent(tab) && !(action !== 'close' && tab.crashed)
}

/** 行上和确认框里写的会话名：标题，没有就写 id */
function sessionNameOf(tab: TabRow): string | undefined {
  return tab.agentSessionTitle?.trim() || tab.agentSessionId
}

/**
 * 浏览器管理页的「标签页」一节（web 客户端，#browser-manager）：运行 ShuviX 的那台电脑上内置浏览器的全部标签页。
 *
 *  - 列表跟着 `browser.tabsChanged`（主进程把标题、地址、加载、崩溃、agent 接入这些变化合并成这一条推给所有客户端）
 *    重新取 —— 细粒度的 `browser-view:*` 事件只推给那台电脑上的浏览器窗口；
 *  - 新建的页开在后台（不切换那台电脑上正在看的页），换地址走 navigate；能去的地址主进程只认网页、空白页与
 *    `shuvix://` 页，被拒的那句话原样显示；
 *  - 列表、地址是 `admin`（地址里可能带登录令牌）：这台设备被策略拒了，就显示那句话，别的不画；
 *  - agent 用着的页，刷新、关闭和换地址先问一声：操作的人在另一台设备上，agent 正在那页上做的事会被打断。崩了的页
 *    刷新、换地址不问（它已经什么都做不了，这两样就是恢复）。换地址在按「前往」时问，这时才知道要去哪。
 */
export function BrowserTabsManager({
  headless,
  compact
}: {
  headless: boolean
  compact: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [tabs, setTabs] = useState<TabRow[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [newUrl, setNewUrl] = useState('')
  const [opening, setOpening] = useState(false)
  const [engine, setEngine] = useState<SearchEngineId>(DEFAULT_SEARCH_ENGINE)
  /** 正在改地址的那一页，和输入框里的字 */
  const [editing, setEditing] = useState<{ tabId: string; text: string } | null>(null)
  /** 正看着截图的那一页（一次只开一张；点开才截，不自动刷新） */
  const [shotTabId, setShotTabId] = useState<string | null>(null)
  /** 等用户确认的那个动作（agent 用着的页才有） */
  const [guarded, setGuarded] = useState<GuardedRequest | null>(null)
  const loadSeq = useRef(0)
  /** 正在改地址的输入框（确认框取消、换地址失败之后把焦点还给它） */
  const addressInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const list = await window.api.browserView.listTabs()
      if (seq !== loadSeq.current) return
      setTabs(list)
      setListError(null)
      // 截图开着的那页没了（关掉了、成了内部页面）：收起，回来时也不自己再截 —— 截图只在用户点开时截
      setShotTabId((cur) =>
        cur !== null && list.some((tab) => tab.id === cur && tab.internalPage === undefined)
          ? cur
          : null
      )
      // 确认框问的理由不在了（那页没了、agent 不用了、页面崩了）：收起，之后也不自己再弹
      setGuarded((cur) =>
        cur && list.some((tab) => tab.id === cur.tabId && needsConfirm(tab, cur.action))
          ? cur
          : null
      )
    } catch (error) {
      if (seq !== loadSeq.current) return
      setListError(reasonOf(error, t('browser.manager.remoteUrlRefused')))
      setShotTabId(null)
      setGuarded(null)
    }
  }, [t])

  useEffect(() => {
    void load()
    void window.api.settings
      .getAll()
      .then((settings) => setEngine(searchEngineOf(settings[SEARCH_ENGINE_SETTING])))
      .catch(() => undefined)
  }, [load])

  useAppEvent('browser.tabsChanged', () => void load())

  /** 跑一个动作：失败的话显示在列表上方；之后重新取一次列表（事件也会来，这里不等它） */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setActionError(null)
    try {
      await action()
      return true
    } catch (error) {
      setActionError(reasonOf(error, t('browser.manager.remoteUrlRefused')))
      return false
    } finally {
      void load()
    }
  }

  const perform = async (request: GuardedRequest): Promise<void> => {
    const { tabId } = request
    if (request.action === 'navigate') {
      // 去成了才收起输入框；失败了字留着，错误显示在上面
      const go = (): Promise<unknown> =>
        window.api.browserView.navigate(tabId, request.target, 'typed')
      if (await run(go)) setEditing((cur) => (cur?.tabId === tabId ? null : cur))
      else addressInput.current?.focus()
    } else if (request.action === 'close') {
      await run(() => window.api.browserView.closeTab(tabId))
    } else {
      await run(() => window.api.browserView.reload(tabId))
    }
  }

  /** 刷新 / 关闭 / 换地址：agent 用着就先问，否则直接做 */
  const requestAction = (request: GuardedRequest): void => {
    const tab = tabs?.find((row) => row.id === request.tabId)
    if (tab && needsConfirm(tab, request.action)) setGuarded(request)
    else void perform(request)
  }

  const openNew = async (): Promise<void> => {
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

  /** 收起输入框；确认框要是在问这次换地址，一起收（不然用户放弃了，点确认还是会去） */
  const closeEditor = (): void => {
    setEditing(null)
    setGuarded((cur) => (cur?.action === 'navigate' ? null : cur))
  }

  const submitEdit = (): void => {
    if (!editing) return
    const target = resolveOmniboxInput(editing.text, engine)
    if (target === null) {
      closeEditor()
      return
    }
    requestAction({ tabId: editing.tabId, action: 'navigate', target })
  }

  /** 「查看对话」：把这个标签页带回聊天页、切到那条会话（web 上 openSessionWithDraft 的本地实现） */
  const openSession = (sessionId: string): void => {
    void window.api.app.openSessionWithDraft({ sessionId, draft: '' })
  }

  const guardedTab = guarded && tabs?.find((tab) => tab.id === guarded.tabId)
  const guardedSession = guardedTab ? sessionNameOf(guardedTab) : undefined

  const iconBtn =
    'p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-bg-hover/60 transition-colors disabled:opacity-40'

  return (
    <div className="absolute inset-0 overflow-y-auto" data-browser-tabs-manager>
      <div className={`mx-auto max-w-[760px] space-y-3 ${compact ? 'px-3 py-3' : 'px-6 py-5'}`}>
        <p className="text-[11px] text-text-tertiary leading-relaxed" data-browser-manager-note>
          {headless ? t('browser.manager.headlessNote') : t('browser.manager.remoteNote')}
        </p>

        {/* 新建标签页（开在后台） */}
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void openNew()
          }}
          data-browser-new-tab-form
        >
          <label className="flex-1 min-w-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-bg-secondary border border-border-secondary/40 focus-within:border-accent/50">
            <Plus size={12} className="text-text-tertiary flex-shrink-0" />
            <input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder={t('browser.manager.newTabPlaceholder')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full min-w-0 bg-transparent text-[12px] outline-none placeholder:text-text-tertiary"
              data-browser-new-tab-input
            />
          </label>
          <button
            type="submit"
            disabled={opening}
            className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-md text-[12px] border border-border-secondary/60 text-text-secondary hover:bg-bg-hover/60 transition-colors disabled:opacity-50"
            data-browser-new-tab-open
          >
            {opening && <Loader2 size={11} className="animate-spin" />}
            {t('browser.manager.open')}
          </button>
        </form>
        <p className="text-[11px] text-text-tertiary">{t('browser.manager.openedRemotely')}</p>

        {actionError && (
          <div
            className="flex items-start gap-2 px-3 py-2 rounded-md bg-error/5 text-[11px] text-error"
            data-browser-manager-error
          >
            <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
            <span className="min-w-0 break-words">
              {t('browser.manager.actionFailed', { reason: actionError })}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <h2
            className="text-[12px] font-medium text-text-secondary"
            data-browser-tab-count={tabs?.length ?? ''}
          >
            {tabs
              ? t('browser.manager.tabCount', { count: tabs.length })
              : t('browser.manager.tabs')}
          </h2>
          <button
            onClick={() => void load()}
            className={iconBtn}
            title={t('browser.manager.refreshList')}
            aria-label={t('browser.manager.refreshList')}
            data-browser-tabs-reload-list
          >
            <RotateCw size={12} />
          </button>
        </div>

        {listError ? (
          <p
            className="px-3 py-3 rounded-md bg-bg-secondary text-[12px] text-text-secondary"
            data-browser-tabs-denied
          >
            {t('browser.manager.notAllowed', { reason: listError })}
          </p>
        ) : tabs === null ? (
          <div className="flex items-center gap-2 px-1 py-3 text-text-tertiary">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-[11px]">{t('common.loading')}</span>
          </div>
        ) : tabs.length === 0 ? (
          <p
            className="px-1 py-4 text-center text-[11px] text-text-tertiary"
            data-browser-tabs-empty
          >
            {t('browser.manager.noTabs')}
          </p>
        ) : (
          <ul className="rounded-lg border border-border-secondary/40 divide-y divide-border-secondary/30 overflow-hidden">
            {tabs.map((tab) => {
              const title =
                tab.internalPage !== undefined
                  ? t(`browser.internal.${tab.internalPage}`)
                  : tab.title || tab.url || t('browser.untitledTab')
              const isEditing = editing?.tabId === tab.id
              return (
                <li
                  key={tab.id}
                  className="px-3 py-2.5 bg-bg-primary"
                  data-browser-manager-tab={tab.id}
                  data-tab-crashed={tab.crashed ? 'true' : undefined}
                  data-tab-loading={tab.loading ? 'true' : undefined}
                  data-tab-agent={tab.agentSessionId}
                >
                  <div className="flex items-start gap-2.5">
                    <span className="relative mt-0.5 flex-shrink-0 text-text-tertiary">
                      {tab.internalPage === 'settings' ? (
                        <SettingsIcon size={14} />
                      ) : tab.internalPage === 'history' ? (
                        <HistoryIcon size={14} />
                      ) : tab.loading ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Globe size={14} />
                      )}
                      {tab.cdpAttached && tab.agentSessionId && (
                        <span
                          className="absolute -right-0.5 -bottom-0.5 w-[7px] h-[7px] rounded-full ring-2 ring-bg-primary"
                          style={{
                            background: tab.cdpIntercepting
                              ? INTERCEPTING_DOT_COLOR
                              : sessionDotColor(tab.agentSessionId)
                          }}
                        />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12px] text-text-primary truncate" title={title}>
                        {title}
                      </div>
                      {isEditing ? (
                        <form
                          className="mt-1 flex items-center gap-1.5"
                          onSubmit={(e) => {
                            e.preventDefault()
                            submitEdit()
                          }}
                        >
                          <input
                            ref={addressInput}
                            autoFocus
                            value={editing.text}
                            onChange={(e) => setEditing({ tabId: tab.id, text: e.target.value })}
                            onKeyDown={(e) => {
                              // 确认框开着时 Esc 是取消确认框，输入框和里面的字留着
                              if (e.key === 'Escape' && !guarded) closeEditor()
                            }}
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            className="flex-1 min-w-0 px-2 py-1 rounded bg-bg-secondary border border-border-secondary/50 focus:border-accent/50 text-[11px] font-mono outline-none"
                            data-browser-tab-address-input
                          />
                          <button
                            type="submit"
                            className="px-2 py-1 rounded text-[11px] text-accent hover:bg-accent/10"
                            data-browser-tab-address-go
                          >
                            {t('browser.manager.go')}
                          </button>
                          <button
                            type="button"
                            onClick={closeEditor}
                            className="px-2 py-1 rounded text-[11px] text-text-tertiary hover:text-text-secondary"
                          >
                            {t('browser.manager.cancel')}
                          </button>
                        </form>
                      ) : (
                        <div
                          className="text-[11px] font-mono text-text-tertiary truncate"
                          title={tab.url}
                          data-browser-tab-url
                        >
                          {tab.url || 'about:blank'}
                        </div>
                      )}
                      {(tab.crashed || usedByAgent(tab) || tab.cdpIntercepting) && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                          {tab.crashed && (
                            <span className="text-error" data-browser-tab-crashed>
                              {t('browser.manager.crashed')}
                            </span>
                          )}
                          {tab.agentSessionId && (
                            <span className="flex items-center gap-1 text-text-secondary min-w-0">
                              <span className="truncate">
                                {t('browser.tabUsedBy', { session: sessionNameOf(tab) })}
                              </span>
                              <button
                                onClick={() => openSession(tab.agentSessionId as string)}
                                className="flex-shrink-0 text-accent hover:underline"
                                data-browser-tab-open-session
                              >
                                {t('browser.infobar.openSession')}
                              </button>
                            </span>
                          )}
                          {!tab.agentSessionId && tab.cdpAttached && (
                            <span className="text-text-secondary" data-browser-tab-agent-unknown>
                              {t('browser.infobar.usingUnknown')}
                            </span>
                          )}
                          {tab.cdpIntercepting && (
                            <span className="text-amber-600 dark:text-amber-400">
                              {t('browser.manager.intercepting')}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex-shrink-0 flex items-center gap-0.5">
                      {tab.internalPage === undefined && (
                        <button
                          onClick={() => setShotTabId((cur) => (cur === tab.id ? null : tab.id))}
                          className={`${iconBtn} ${shotTabId === tab.id ? 'text-accent hover:text-accent' : ''}`}
                          title={
                            shotTabId === tab.id
                              ? t('browser.manager.hideScreenshot')
                              : t('browser.manager.showScreenshot')
                          }
                          aria-label={
                            shotTabId === tab.id
                              ? t('browser.manager.hideScreenshot')
                              : t('browser.manager.showScreenshot')
                          }
                          aria-expanded={shotTabId === tab.id}
                          data-browser-tab-screenshot-toggle
                        >
                          <Camera size={12} />
                        </button>
                      )}
                      {tab.internalPage === undefined && !isEditing && (
                        <button
                          onClick={() => setEditing({ tabId: tab.id, text: tab.url })}
                          className={iconBtn}
                          title={t('browser.manager.changeAddress')}
                          aria-label={t('browser.manager.changeAddress')}
                          data-browser-tab-edit
                        >
                          <Pencil size={12} />
                        </button>
                      )}
                      {tab.loading ? (
                        <button
                          onClick={() => void run(() => window.api.browserView.stop(tab.id))}
                          className={iconBtn}
                          title={t('browser.stop')}
                          aria-label={t('browser.stop')}
                          data-browser-tab-stop
                        >
                          <Square size={11} />
                        </button>
                      ) : (
                        <button
                          onClick={() => requestAction({ tabId: tab.id, action: 'reload' })}
                          className={`${iconBtn} ${tab.crashed ? 'text-error hover:text-error' : ''}`}
                          title={t('browser.refresh')}
                          aria-label={t('browser.refresh')}
                          data-browser-tab-reload
                        >
                          <RotateCw size={12} />
                        </button>
                      )}
                      <button
                        onClick={() => requestAction({ tabId: tab.id, action: 'close' })}
                        className={iconBtn}
                        title={t('browser.closeTab')}
                        aria-label={t('browser.closeTab')}
                        data-browser-tab-close
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                  {shotTabId === tab.id && tab.internalPage === undefined && (
                    <TabScreenshot tabId={tab.id} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {guarded && guardedTab && (
        <ConfirmDialog
          title={t(GUARD_COPY[guarded.action].title)}
          description={
            <div className="space-y-1" data-browser-tab-agent-confirm={guarded.action}>
              <p className="break-words">
                {guardedSession
                  ? t('browser.infobar.using', { session: guardedSession })
                  : t('browser.infobar.usingUnknown')}
              </p>
              <p>{t(GUARD_COPY[guarded.action].body)}</p>
              {guarded.action === 'navigate' && (
                <p
                  className="font-mono break-all line-clamp-3 text-text-primary"
                  title={guarded.target}
                  data-browser-tab-confirm-target
                >
                  {guarded.target}
                </p>
              )}
            </div>
          }
          confirmText={t(GUARD_COPY[guarded.action].confirm)}
          cancelText={t('browser.manager.cancel')}
          danger={guarded.action === 'close'}
          autoFocusConfirm={guarded.action === 'navigate'}
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
    </div>
  )
}

/** 截图要的宽度（CSS px × 设备像素比，至多 1280 —— 主进程只缩不放） */
function screenshotWidth(): number {
  const ratio = typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : 1
  return Math.min(1280, Math.round(720 * Math.max(1, ratio)))
}

/**
 * 一个标签页的截图（P2，2026-11-01）：用户点开那一行才截、点「重新截图」才再截 —— 不自动刷新、不给所有行生成缩略图。
 * 截图就是「看到网页」（登录后的页面内容都在上面），所以 `browser-view:capture` 是 admin，被策略拒了就显示那句话；
 * 显示本地文件的页主进程不给截（remote_url_refused）。截到的是空的（还在加载、渲染进程崩了）照实说。
 */
function TabScreenshot({ tabId }: { tabId: string }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'shown'; src: string; at: number }
    | { kind: 'empty' }
    | { kind: 'failed'; error: unknown }
  >({ kind: 'loading' })
  /** 每截一次加一；收起（卸载）也加一 —— 晚回来的结果对不上就不写 state */
  const seq = useRef(0)

  /** 截一次并把结果写进 state（调之前 state 已是 loading） */
  const capture = useCallback(
    async (mine: number): Promise<void> => {
      try {
        const src = await window.api.browserView.capture(tabId, screenshotWidth())
        if (mine !== seq.current) return
        setState(src ? { kind: 'shown', src, at: Date.now() } : { kind: 'empty' })
      } catch (error) {
        if (mine !== seq.current) return
        setState({ kind: 'failed', error })
      }
    },
    [tabId]
  )

  // 点开这一行：截一次（初始 state 就是 loading）
  useEffect(() => {
    const counter = seq
    void capture(++counter.current)
    return () => {
      counter.current++
    }
  }, [capture])

  /** 「重新截图」 */
  const retake = (): void => {
    setState({ kind: 'loading' })
    void capture(++seq.current)
  }

  return (
    <div className="mt-2 ml-6 space-y-1.5" data-browser-tab-screenshot={state.kind}>
      <div className="flex items-center gap-2 text-[11px] text-text-tertiary">
        <span className="min-w-0 flex-1 truncate">
          {state.kind === 'shown'
            ? t('browser.manager.screenshotTakenAt', {
                time: new Date(state.at).toLocaleTimeString(i18n.language)
              })
            : t('browser.manager.screenshotNote')}
        </span>
        <button
          onClick={retake}
          disabled={state.kind === 'loading'}
          className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-text-secondary hover:bg-bg-hover/60 disabled:opacity-50"
          data-browser-tab-screenshot-retake
        >
          <RotateCw size={10} />
          {t('browser.manager.retakeScreenshot')}
        </button>
      </div>
      {state.kind === 'loading' ? (
        <div className="flex items-center gap-2 py-6 justify-center text-text-tertiary">
          <Loader2 size={12} className="animate-spin" />
          <span className="text-[11px]">{t('browser.manager.screenshotLoading')}</span>
        </div>
      ) : state.kind === 'shown' ? (
        <img
          src={state.src}
          alt={t('browser.manager.screenshotAlt')}
          draggable={false}
          className="block w-full h-auto rounded-md border border-border-secondary/40 bg-bg-secondary"
          data-browser-tab-screenshot-image
        />
      ) : state.kind === 'empty' ? (
        <p className="py-3 text-[11px] text-text-tertiary" data-browser-tab-screenshot-empty>
          {t('browser.manager.screenshotEmpty')}
        </p>
      ) : (
        <p className="py-3 text-[11px] text-error" data-browser-tab-screenshot-failed>
          {t('browser.manager.screenshotFailed', {
            reason: reasonOf(state.error, t('browser.manager.remoteUrlRefused'))
          })}
        </p>
      )}
    </div>
  )
}
