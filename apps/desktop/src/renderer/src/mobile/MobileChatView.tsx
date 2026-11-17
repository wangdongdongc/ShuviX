/**
 * 手机布局的对话页 —— 整屏、没有标签栏。与桌面 ChatView 用同一个共享 ChatBody（对话 / 笔记本 / 空态都一样），
 * 只换掉顶栏和会话面板（2026-11-14 照设计稿重排）：
 *
 * - 顶栏三格：左边返回（箭头后面的数字 = 别处还有几条会话在等你 —— 挂着询问或有没看的新回复，同收件箱那个数）；
 *   中间标题 + 一行小字（在哪干活 · 状态：有询问 / 正在回复），点它整屏推入「详情」（MobileSessionDetails，
 *   取代桌面那个居中的会话配置对话框）；右边只有一颗「⋯」；
 * - 「⋯」是一份贴着按钮展开的下拉菜单（PullDownMenu，每项行尾带图标）：文件、后台任务（带数）、产物 | 导出对话、分支会话（形态给才有）| 详情。文件 / 任务 / 产物
 *   各是整屏推入的页面（2026-11-16，此前是底部抽屉）：文件一层文件夹一页，任务与产物是列表页 + 详情页
 *   （MobileFilesPage / MobileTasksPage / MobileArtifactsPage；那一摞记在浏览器历史里，见 panelHistory.ts）。
 *   对话里工具卡上的任务状态、引用块上的「已有新版」被点了，也推入对应的详情页；
 * - 详情那一层连着浏览器历史（detailHistory.ts）：首页一条、子页再一条，返回键 / 返回手势一层一层退；
 * - 状态横幅（SSH / 数据库连接）照旧在对话上方；智能体标记不放 —— 点它是打开右侧面板，手机布局里没有；
 * - 窗口类的按钮（悬浮窗、内置浏览器、侧栏 / 终端 / 右侧面板开关）都没有 —— 手机上没有这些。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronLeft,
  CircleEllipsis,
  FolderOpen,
  GitBranch,
  Info,
  Layers,
  Shapes,
  Share,
  Timer
} from 'lucide-react'
import {
  forkRefusalKey,
  RedactedText,
  selectAllPendingCounts,
  selectSessionForkable,
  selectStreamingSessions,
  useBgTasks,
  useBgTaskStore,
  useChatStore,
  useSessionFork
} from '@shuvix/chat-ui'
import {
  basename,
  ChatBody,
  ConfirmDialog,
  MediaUrlProvider,
  StatusBanner,
  WelcomeView,
  useInboxSections,
  useSessionExport,
  type SessionConfigSection
} from '@shuvix/app-shell'
import { isForkableSessionShape } from '@shuvix/chat-protocol/sessionFork'
import { NotebookSessionView } from '../components/notebook/NotebookSessionView'
import { hostMediaResolver } from '../host/hostMedia'
import {
  DETAIL_DIRECT_MARK,
  DETAIL_HISTORY_MARK,
  detailDirectOf,
  detailPageOf,
  type MobileDetailPage
} from './detailHistory'
import { MobileArtifactDetailPage, MobileArtifactsPage } from './MobileArtifactsPage'
import { MobileEmptyChat } from './MobileEmptyChat'
import { MobileFilesPage } from './MobileFilesPage'
import { MobileTaskDetailPage, MobileTasksPage } from './MobileTasksPage'
import {
  PANEL_HISTORY_MARK,
  artifactKeyOf,
  artifactPage,
  filesDirOf,
  filesPage,
  panelStackOf,
  taskIdOf,
  taskPage
} from './panelHistory'
import { MobileSessionDetails } from './MobileSessionDetails'
import { useSessionLocation } from './useSessionLocation'
import { PullDownMenu, type PullDownItem } from './PullDownMenu'

export function MobileChatView({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const session = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const title = session?.title ?? ''
  const tasks = useBgTasks(activeSessionId)
  // 菜单里「后台任务」后面的数：此刻还在跑的（跑完的留在抽屉里，不算进这个数）
  const runningTasks = tasks.filter((task) => task.status === 'running').length
  const exportSession = useSessionExport()
  const { forkSession, forkError, clearForkError, available: canFork } = useSessionFork()
  const forkable = useChatStore((s) => selectSessionForkable(s, activeSessionId))

  // 小字：在哪干活 · 状态（有询问 > 正在回复；停着就只有位置）
  const location = useSessionLocation(session)
  const asks = useChatStore(selectAllPendingCounts)[activeSessionId ?? ''] ?? 0
  const replying = !!useChatStore(selectStreamingSessions)[activeSessionId ?? '']
  // 只在这一轮还在跑的时候显示（跑完之后没有哪张卡会被拒）
  const unattended =
    useChatStore((st) => !!activeSessionId && st.sessionUnattended?.[activeSessionId] === true) &&
    replying

  // 返回键后面的数字：别处还有几条会话在等你（收件箱那个数，去掉此刻开着的这一条）
  const { waiting, unread } = useInboxSections()
  const others = new Set(
    [...waiting, ...unread].map((item) => item.session.id).filter((id) => id !== activeSessionId)
  ).size

  // 文件 / 后台任务 / 产物那几页：一摞（从对话页往上数），每进一层压一条历史
  const [panel, setPanel] = useState<string[]>([])
  // 详情那一层：哪一页记在浏览器历史里，返回键 / 返回手势退一条就是退一页
  const [detail, setDetail] = useState<MobileDetailPage | null>(null)
  // 这一页是从对话页直接进来的（空对话页的入口行）：下面没有详情首页，返回一步回对话
  const [detailDirect, setDetailDirect] = useState(false)
  useEffect(() => {
    const onPop = (): void => {
      setDetail(detailPageOf(window.history.state))
      setDetailDirect(detailDirectOf(window.history.state))
      setPanel(panelStackOf(window.history.state))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const pushDetail = useCallback((page: MobileDetailPage, direct = false): void => {
    window.history.pushState(
      {
        ...((window.history.state as Record<string, unknown> | null) ?? {}),
        [DETAIL_HISTORY_MARK]: page,
        [DETAIL_DIRECT_MARK]: direct
      },
      ''
    )
    setDetail(page)
    setDetailDirect(direct)
  }, [])
  const backFromDetail = useCallback((): void => {
    if (detailPageOf(window.history.state) !== null) window.history.back()
    else {
      setDetail(null)
      setDetailDirect(false)
    }
  }, [])

  const pushPanel = useCallback((page: string, fromRoot = false): void => {
    const stack = [...(fromRoot ? [] : panelStackOf(window.history.state)), page]
    window.history.pushState(
      {
        ...((window.history.state as Record<string, unknown> | null) ?? {}),
        [PANEL_HISTORY_MARK]: stack
      },
      ''
    )
    setPanel(stack)
  }, [])
  const backFromPanel = useCallback((): void => {
    if (panelStackOf(window.history.state).length > 0) window.history.back()
    else setPanel([])
  }, [])
  /** 这几页全部收起，回到对话页（「在对话中引用」之后、点了一条子会话之后） */
  const closePanel = useCallback((): void => {
    const depth = panelStackOf(window.history.state).length
    // 页面当场收起（不等 popstate）：换了会话时那几页是上一条会话的，留着一拍会让详情页以为自己的任务没了、
    // 再多退一步
    setPanel([])
    if (depth > 0) window.history.go(-depth)
  }, [])
  // 对话里的工具卡行尾状态 / 引用块上的「已有新版」被点了：推入那条任务 / 那件产物的详情页（下面垫着列表页）
  useEffect(
    () =>
      useChatStore.subscribe((next, prev) => {
        // 换了会话（在任务页点了一条子会话）：这几页是上一条会话的，收起
        // （会话没了 —— 删掉了 —— 由外壳连同对话页一起退掉，这里不动）
        if (next.activeSessionId && next.activeSessionId !== prev.activeSessionId) closePanel()
        const sid = next.activeSessionId
        if (!sid) return
        const task = next.taskRevealRequest
        if (task && task !== prev.taskRevealRequest) {
          if (panelStackOf(window.history.state).length > 0) return
          pushPanel('tasks', true)
          // 子会话没有详情页（它是一条真正的会话）：只到列表
          if (useBgTaskStore.getState().tasks[task.taskId]?.kind !== 'sub-session') {
            pushPanel(taskPage(task.taskId))
          }
        }
        const artifact = next.artifactRevealRequest
        if (artifact && artifact !== prev.artifactRevealRequest) {
          if (panelStackOf(window.history.state).length > 0) return
          pushPanel('artifacts', true)
          pushPanel(artifactPage(artifact.sessionId, artifact.name))
        }
      }),
    [pushPanel, closePanel]
  )

  // 「⋯」的下拉菜单：贴着按钮展开（记下按钮此刻在视口里的位置）
  const [menuAnchor, setMenuAnchor] = useState<{ right: number; bottom: number } | null>(null)
  const closeMenu = useCallback((): void => setMenuAnchor(null), [])
  const menuGroups: PullDownItem[][] = [
    [
      { id: 'files', label: t('mobile.files'), icon: <FolderOpen size={19} /> },
      {
        id: 'tasks',
        label: t('mobile.backgroundTasks'),
        icon: <Layers size={19} />,
        count: runningTasks
      },
      { id: 'artifacts', label: t('mobile.artifacts'), icon: <Shapes size={19} /> }
    ],
    [
      // 笔记本会话不提供导出（与侧栏行菜单同一条）；分支只对形态给的会话出现（笔记本、Chrome 标签页会话没有）
      ...(session?.settings.notebookPath
        ? []
        : [{ id: 'export', label: t('mobile.exportChat'), icon: <Share size={19} /> }]),
      ...(canFork && session && isForkableSessionShape(session)
        ? [
            {
              id: 'fork',
              label: t('mobile.forkChat'),
              icon: <GitBranch size={19} />,
              // 拷贝要等这一轮停下：在跑 / 被中断时置灰（与侧栏行菜单同一条）
              disabled: !forkable
            }
          ]
        : [])
    ],
    [{ id: 'details', label: t('mobile.details'), icon: <Info size={19} /> }]
  ]
  const pickMenu = (action: string): void => {
    if (!activeSessionId) return
    if (action === 'files' || action === 'tasks' || action === 'artifacts') pushPanel(action, true)
    if (action === 'export') void exportSession(activeSessionId)
    if (action === 'fork') void forkSession(activeSessionId)
    if (action === 'details') pushDetail('index')
  }

  const header = (
    <div
      data-mobile-chat-header=""
      className="flex h-12 flex-shrink-0 items-center border-b border-border-secondary/40 px-1"
    >
      <div className="flex w-16 flex-shrink-0 items-center">
        <button
          type="button"
          data-mobile-back=""
          onClick={onBack}
          className="flex h-10 items-center rounded-full pl-1.5 pr-2 text-accent active:bg-bg-hover"
          aria-label={
            others > 0
              ? `${t('mobile.back')} · ${t('mobile.othersWaiting', { count: others })}`
              : t('mobile.back')
          }
        >
          <ChevronLeft size={24} aria-hidden="true" />
          {others > 0 && (
            <span data-mobile-back-count="" className="text-[15px] tabular-nums">
              {others}
            </span>
          )}
        </button>
      </div>
      <button
        type="button"
        data-mobile-chat-title=""
        onClick={() => activeSessionId && pushDetail('index')}
        className="flex min-w-0 flex-1 flex-col items-center justify-center self-stretch px-1"
        title={t('mobile.details')}
      >
        <span className="max-w-full truncate text-[15px] font-medium leading-tight text-text-primary">
          {unattended && (
            <Timer
              size={14}
              data-mobile-chat-unattended=""
              aria-label={t('toolCall.unattendedRun')}
              className="mr-1 inline-block align-[-2px] text-warning animate-pulse motion-reduce:animate-none"
            />
          )}
          <RedactedText text={title} />
        </span>
        {activeSessionId && (
          <span
            data-mobile-chat-subtitle=""
            className="max-w-full truncate text-[11px] leading-tight text-text-tertiary"
          >
            {location}
            {location && (asks > 0 || replying) ? ' · ' : ''}
            {asks > 0 ? (
              <span data-mobile-chat-state="waiting" className="text-warning">
                {t('inbox.asks', { count: asks })}
              </span>
            ) : replying ? (
              <span data-mobile-chat-state="replying" className="text-accent">
                {t('inbox.replying')}
              </span>
            ) : null}
          </span>
        )}
      </button>
      <div className="flex w-16 flex-shrink-0 items-center justify-end">
        <button
          type="button"
          data-mobile-chat-menu=""
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMenuAnchor({ right: rect.right, bottom: rect.bottom })
          }}
          aria-haspopup="menu"
          aria-expanded={menuAnchor !== null}
          className="flex h-10 w-10 items-center justify-center rounded-full text-accent active:bg-bg-hover disabled:opacity-40"
          aria-label={t('mobile.moreActions')}
          disabled={!activeSessionId}
        >
          <CircleEllipsis size={23} aria-hidden="true" />
        </button>
      </div>
    </div>
  )

  return (
    <MediaUrlProvider value={hostMediaResolver}>
      <ChatBody
        className="relative flex flex-col h-full"
        header={header}
        banner={activeSessionId ? <StatusBanner sessionId={activeSessionId} /> : undefined}
        welcome={<WelcomeView />}
        renderNotebook={(path, sid) => (
          <NotebookSessionView key={sid} path={path} sessionId={sid} />
        )}
        conversationEmptyState={(sid) => (
          <MobileEmptyChat
            // 换了会话就是另一份（几台 MCP、权限表几行都是按会话取的，上一条的数不能留在这一条上）
            key={sid}
            sessionId={sid}
            onOpenSection={(section) => pushDetail(section, true)}
          />
        )}
        overlays={
          <>
            {detail && activeSessionId && (
              <MobileSessionDetails
                // 换了会话就是另一份详情（名称那一格的草稿不能带过去）
                key={activeSessionId}
                sessionId={activeSessionId}
                page={detail}
                direct={detailDirect}
                onOpenSection={(section: SessionConfigSection) => pushDetail(section)}
                onBack={backFromDetail}
              />
            )}
            {menuAnchor && activeSessionId && (
              <PullDownMenu
                anchor={menuAnchor}
                groups={menuGroups}
                onPick={pickMenu}
                onClose={closeMenu}
              />
            )}
            {forkError && (
              <ConfirmDialog
                title={t('chat.forkFailedTitle')}
                description={t(forkRefusalKey(forkError))}
                confirmText={t('common.close')}
                danger={false}
                onConfirm={clearForkError}
                onCancel={clearForkError}
              />
            )}
            {activeSessionId &&
              panel.map((page, index) => {
                // 一摞都挂着、只露最上面那一页：退回来时下面那一页还在原处（滚动位置、搜索词）
                const top = index === panel.length - 1
                const dir = filesDirOf(page)
                const taskId = taskIdOf(page)
                const artifact = artifactKeyOf(page)
                let content: React.ReactNode = null
                if (dir !== null) {
                  const parent = index > 0 ? filesDirOf(panel[index - 1]) : null
                  content = (
                    <MobileFilesPage
                      sessionId={activeSessionId}
                      dir={dir}
                      backLabel={
                        parent === null
                          ? t('mobile.detailsBack')
                          : parent
                            ? basename(parent)
                            : t('mobile.files')
                      }
                      onBack={backFromPanel}
                      onOpenDir={(next) => pushPanel(filesPage(next))}
                      onMentionInserted={closePanel}
                    />
                  )
                } else if (page === 'tasks') {
                  content = (
                    <MobileTasksPage
                      sessionId={activeSessionId}
                      onBack={backFromPanel}
                      onOpenTask={(id) => pushPanel(taskPage(id))}
                    />
                  )
                } else if (taskId !== null) {
                  content = (
                    <MobileTaskDetailPage
                      sessionId={activeSessionId}
                      taskId={taskId}
                      onBack={backFromPanel}
                    />
                  )
                } else if (page === 'artifacts') {
                  content = (
                    <MobileArtifactsPage
                      sessionId={activeSessionId}
                      onBack={backFromPanel}
                      onOpenArtifact={(a) => pushPanel(artifactPage(a.sessionId, a.name))}
                    />
                  )
                } else if (artifact !== null) {
                  content = (
                    <MobileArtifactDetailPage
                      sessionId={activeSessionId}
                      artifactKey={artifact}
                      onBack={backFromPanel}
                    />
                  )
                }
                return (
                  <div
                    key={`${activeSessionId}:${page}`}
                    data-mobile-panel-layer={page}
                    style={top ? undefined : { display: 'none' }}
                  >
                    {content}
                  </div>
                )
              })}
          </>
        }
      />
    </MediaUrlProvider>
  )
}
