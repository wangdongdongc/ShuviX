/**
 * 手机布局的对话页 —— 整屏、没有标签栏。与桌面 ChatView 用同一个共享 ChatBody（对话 / 笔记本 / 空态都一样），
 * 只换掉顶栏和会话面板：
 *
 * - 顶栏：返回（回会话列表）、标题（点它打开会话设置）、文件、任务；
 * - 桌面上浮在对话右边的会话面板（文件 / 任务）在这里是底部抽屉；
 * - 状态横幅（SSH / 数据库连接）照旧在对话上方；智能体标记不放 —— 点它是打开右侧面板，手机布局里没有
 *   （与桌面悬浮窗同一条产品决议）；
 * - 窗口类的按钮（悬浮窗、内置浏览器、侧栏 / 终端 / 右侧面板开关）都没有 —— 手机上没有这些。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, FolderOpen, Layers } from 'lucide-react'
import { RedactedText, useBgTasks, useChatStore } from '@shuvix/chat-ui'
import {
  BgTaskPanel,
  ChatBody,
  FilesPanel,
  MediaUrlProvider,
  SessionConfigDialog,
  StatusBanner,
  WelcomeView
} from '@shuvix/app-shell'
import { EmptySessionHint } from '../components/chat/WelcomeView'
import { NotebookSessionView } from '../components/notebook/NotebookSessionView'
import { hostMediaResolver } from '../host/hostMedia'
import { BottomSheet } from './BottomSheet'

const iconButton =
  'h-10 w-10 flex items-center justify-center rounded-full text-text-secondary active:bg-bg-hover flex-shrink-0'

export function MobileChatView({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const title = useChatStore((s) => s.sessions.find((x) => x.id === s.activeSessionId)?.title ?? '')
  const [sheet, setSheet] = useState<'files' | 'tasks' | null>(null)
  const taskCount = useBgTasks(activeSessionId).length
  const [showSessionConfig, setShowSessionConfig] = useState(false)

  const header = (
    <div
      data-mobile-chat-header=""
      className="flex-shrink-0 flex items-center gap-1 h-12 px-1 border-b border-border-secondary/40"
    >
      <button
        type="button"
        data-mobile-back=""
        onClick={onBack}
        className={iconButton}
        aria-label={t('mobile.back')}
      >
        <ChevronLeft size={24} />
      </button>
      <button
        type="button"
        data-mobile-chat-title=""
        onClick={() => activeSessionId && setShowSessionConfig(true)}
        className="flex-1 min-w-0 truncate px-1 text-[15px] font-medium text-text-primary text-center"
        title={t('sessionConfig.title')}
      >
        <RedactedText text={title} />
      </button>
      <button
        type="button"
        data-mobile-files=""
        onClick={() => setSheet('files')}
        className={iconButton}
        aria-label={t('mobile.files')}
        disabled={!activeSessionId}
      >
        <FolderOpen size={19} />
      </button>
      <button
        type="button"
        data-mobile-tasks=""
        onClick={() => setSheet('tasks')}
        className={iconButton}
        aria-label={t('mobile.tasks')}
        disabled={!activeSessionId}
      >
        <Layers size={19} />
      </button>
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
        conversationEmptyState={(sid) => <EmptySessionHint sessionId={sid} />}
        overlays={
          <>
            {showSessionConfig && activeSessionId && (
              <SessionConfigDialog
                sessionId={activeSessionId}
                onClose={() => setShowSessionConfig(false)}
              />
            )}
            <BottomSheet
              open={sheet !== null && !!activeSessionId}
              onClose={() => setSheet(null)}
              title={sheet === 'files' ? t('mobile.files') : t('mobile.tasks')}
              tall
            >
              {sheet === 'files' ? (
                <FilesPanel
                  onOpenFolder={(p) => void window.api.app.openFolder(p)}
                  // 引用插进输入框之后收起抽屉，让人看见它（「在文件夹中显示」在手机上只会弹一张服务端路径卡，
                  // 与「复制路径」重复，故不注入 onRevealPath）
                  onMentionInserted={() => setSheet(null)}
                />
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {taskCount > 0 ? (
                    <BgTaskPanel sessionId={activeSessionId} />
                  ) : (
                    <div
                      data-mobile-tasks-empty=""
                      className="px-4 py-10 text-center text-[13px] text-text-tertiary"
                    >
                      {t('mobile.noTasks')}
                    </div>
                  )}
                </div>
              )}
            </BottomSheet>
          </>
        }
      />
    </MediaUrlProvider>
  )
}
