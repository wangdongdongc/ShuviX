import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2 } from 'lucide-react'
import { getHostApi, useChatStore, isImeComposing } from '@shuvix/chat-ui'
import { useFocusDim } from '../sidebar/useFocusDim'

/**
 * ChatHeader —— 聊天主视图顶栏（桌面/WebUI/扩展共用）。
 *
 * 共享：容器外壳（含可选窗口拖拽区）+ 会话标题（点击编辑）+ 会话设置按钮。
 * 差异通过 caps 能力开关与 rightActions 插槽表达：
 *   - 桌面把 pin/悬浮/浏览器/侧栏开关等窗口相关簇作为 rightActions 传入；
 *   - 扩展只注入「折叠会话列表」一个按钮。
 * 会话设置弹窗由宿主自渲染（桌面 SessionConfigDialog，扩展自有），本组件只发 onOpenSessionConfig。
 * （Files 面板入口在状态横幅右侧的会话工具栏，不在顶栏 —— 见 StatusBanner 的 trailing 插槽。）
 */
export interface ChatHeaderCaps {
  /** Electron 无边框窗口拖拽区（加 titlebar-drag / titlebar-no-drag 类）。扩展/web 置 false */
  windowDrag?: boolean
  /** 标题点击改名（web/只读宿主置 false） */
  editableTitle?: boolean
  /** 显示会话设置齿轮 */
  sessionConfig?: boolean
  /** macOS 交通灯左侧留白 —— 无边框窗口里顶栏顶到窗口左缘时开启，避免标题被交通灯压住 */
  macTrafficLights?: boolean
}

export interface ChatHeaderProps {
  caps?: ChatHeaderCaps
  /** 点击会话设置齿轮（宿主据此打开自己的弹窗） */
  onOpenSessionConfig?: () => void
  /** 右侧按钮簇（宿主专属：pin/浏览器/侧栏开关 …） */
  rightActions?: React.ReactNode
  /** 顶栏整体高度类（默认 h-8；桌面 macOS 为交通灯留高传 h-10） */
  heightClassName?: string
}

export function ChatHeader({
  caps = {},
  onOpenSessionConfig,
  rightActions,
  heightClassName = 'h-8'
}: ChatHeaderProps): React.JSX.Element {
  const { t } = useTranslation()
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const sessions = useChatStore((s) => s.sessions)
  const sessionTitle = sessions.find((s) => s.id === activeSessionId)?.title || null
  const { dim } = useFocusDim()

  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const drag = caps.windowDrag ? 'titlebar-drag' : ''
  const noDrag = caps.windowDrag ? 'titlebar-no-drag' : ''
  // 交通灯组自窗口左缘 16px 起、宽 52px（三个 12px 按钮 + 两处 8px 间隔）→ 右缘 68px，再留 10px 余量。
  // 与侧边栏的展开/收起同步过渡（duration-200），标题随之平移而非瞬跳
  const leftPad = caps.macTrafficLights ? 'pl-[78px]' : 'pl-2'

  const startEditTitle = (): void => {
    if (!caps.editableTitle || !sessionTitle || !activeSessionId) return
    setDraftTitle(sessionTitle)
    setEditingTitle(true)
    setTimeout(() => titleInputRef.current?.select(), 0)
  }

  const commitEditTitle = async (): Promise<void> => {
    setEditingTitle(false)
    const trimmed = draftTitle.trim()
    if (!trimmed || !activeSessionId || trimmed === sessionTitle) return
    const host = getHostApi()
    if (!host) return // 渠道端只读：不可改标题
    await host.session.updateTitle({ id: activeSessionId, title: trimmed })
    useChatStore.getState().updateSessionTitle(activeSessionId, trimmed)
  }

  return (
    <div
      className={`${drag} flex-shrink-0 flex items-center ${leftPad} pr-2 transition-[opacity,padding] duration-200 ${heightClassName} ${dim ? 'opacity-30 hover:opacity-100' : ''}`}
    >
      {/* 左侧：会话名 + 会话设置 + 工作目录（容器不加 no-drag，剩余空间可拖动窗口） */}
      <div className="flex items-center gap-0.5 min-w-0 flex-1">
        {sessionTitle &&
          (caps.editableTitle && editingTitle ? (
            <input
              ref={titleInputRef}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={() => void commitEditTitle()}
              onKeyDown={(e) => {
                // 输入法组字中的回车是「确认选词」，不能当成提交（中文标题必踩）
                if (isImeComposing(e)) return
                if (e.key === 'Enter') void commitEditTitle()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              className={`${noDrag} bg-transparent text-xs font-medium text-text-primary outline-none border-b border-accent/50 px-2 py-0.5 min-w-0 flex-shrink`}
              autoFocus
            />
          ) : caps.editableTitle ? (
            <button
              onClick={startEditTitle}
              className={`${noDrag} text-xs font-medium text-text-secondary hover:text-text-primary transition-colors px-2 py-0.5 rounded-md hover:bg-bg-hover/50 truncate min-w-0`}
              title={t('common.clickToEdit')}
            >
              {sessionTitle}
            </button>
          ) : (
            <span className="text-xs font-medium text-text-secondary px-2 py-0.5 truncate min-w-0">
              {sessionTitle}
            </span>
          ))}
        {sessionTitle && caps.sessionConfig && (
          <button
            onClick={onOpenSessionConfig}
            className={`${noDrag} p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors flex-shrink-0`}
            title={t('sessionConfig.title')}
          >
            <Settings2 size={12} />
          </button>
        )}
      </div>

      {/* 右侧：宿主专属按钮簇 */}
      {rightActions && (
        <div className={`${noDrag} flex items-center gap-0.5 flex-shrink-0`}>{rightActions}</div>
      )}
    </div>
  )
}
