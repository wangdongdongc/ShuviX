import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Bot, Eye, FolderTree, X } from 'lucide-react'
import { useChatStore, useSubAgentCount } from '@shuvix/chat-ui'
import { SubAgentPanel } from '../subagent/SubAgentPanel'
import { usePreviewPanelStore } from '../preview/previewPanelStore'
import { useSessionPanelStore, type SessionPanelTool } from './sessionPanelStore'

/**
 * 会话面板（桌面 / 扩展共用）—— 经 ChatBody 的 sessionToolbar / sessionPanel 插槽注入：
 *
 *   - SessionToolbar：悬浮于正文右上角的胶囊工具栏，仅面板收起时显示（展开后隐藏，
 *     切换/收起入口移交面板头部 tabs）。Files 常驻；Preview 仅在宿主注入（showPreview）
 *     **且存在预览目标**时出现（与 Sub-agent 同款「有内容才显示」语义）；Sub-agent 仅
 *     当前会话有子会话时出现（含数量徽标）。点按展开面板并切到该工具。
 *   - SessionPanel：正文区右侧的悬浮卡片（四周留白 + 圆角 + 边框 + 投影，布局上与对话并排、
 *     对话收缩让位）。头部为工具 tabs（与工具栏同一入口列表），点按切换、X 收起。
 *     装载 Files / Preview / Sub-agent，展开期间各工具均保持挂载、visibility 切换
 *     （保住预览/手风琴等临时 UI 态）；收起时整体卸载（避免后台文件扫描）。
 *
 * 宿主差异经 props / 外层注入：files 内容整体注入（filesContent —— 桌面为 FilesPanel + 桌面
 * caps，扩展为 FSA 权限门控包装）；preview 内容可选注入（previewContent —— 无 app 级右侧
 * 面板的宿主（桌面悬浮窗 / 扩展）注入共享 PreviewPanel；桌面主窗预览在右侧面板，不注入）；
 * 媒体 URL 解析由宿主在外层包 MediaUrlProvider。
 * 状态在共享 useSessionPanelStore（按会话记忆）；宽度持久化由宿主在 store 外接。
 */

/**
 * 展示工具（含兜底）：面板停在 Sub-agent 但子会话已清空（Bot 按钮随之隐藏）→ 回落到 Files；
 * 停在 Preview 但预览目标已关闭（Eye 按钮随之隐藏）→ 同样回落到 Files。
 */
export function useSessionPanelTool(sessionId: string | null): SessionPanelTool | null {
  const openTool = useSessionPanelStore((s) =>
    sessionId ? (s.openBySession[sessionId] ?? null) : null
  )
  const subAgentCount = useSubAgentCount(sessionId)
  const hasPreviewTarget = usePreviewPanelStore((s) => s.target !== null)
  if (openTool === 'subagent' && subAgentCount === 0) return 'files'
  if (openTool === 'preview' && !hasPreviewTarget) return 'files'
  return openTool
}

/**
 * 揭示信号 → 会话面板（宿主常驻组件内调用一次；面板收起时内容未挂载，故须在此消费）：
 *   - subAgentRevealRequest（当前会话注册子智能体）→ 展开并切到 Sub-agent
 *   - filePreviewRequest（仅 previewInPanel=true 的宿主）→ 展开并切到 Preview ——
 *     预览目标本身由宿主经 usePreviewRequestBridge 落入共享 usePreviewPanelStore；
 *     桌面主窗预览在 app 级右侧面板（useRightPanelBridge 揭示），不传此标志。
 * 信号均含单调 nonce，重复触发同样生效。enabled=false 时忽略（如 WebUI / 悬浮占位态）。
 */
export function useSessionPanelReveal(enabled = true, previewInPanel = false): void {
  const subAgentReveal = useChatStore((s) => s.subAgentRevealRequest)
  useEffect(() => {
    if (!enabled || !subAgentReveal) return
    const sid = useChatStore.getState().activeSessionId
    if (sid) useSessionPanelStore.getState().show(sid, 'subagent')
  }, [subAgentReveal, enabled])

  const filePreviewRequest = useChatStore((s) => s.filePreviewRequest)
  useEffect(() => {
    if (!enabled || !previewInPanel || !filePreviewRequest) return
    const sid = useChatStore.getState().activeSessionId
    if (sid) useSessionPanelStore.getState().show(sid, 'preview')
  }, [filePreviewRequest, enabled, previewInPanel])
}

interface SessionPanelToolItem {
  tool: SessionPanelTool
  Icon: typeof FolderTree
  label: string
  badge?: number
}

/**
 * 面板工具入口列表（工具栏胶囊与面板头部 tabs 共用同一来源）：Files 常驻；
 * Preview 仅宿主注入且存在预览目标时出现；Sub-agent 仅有子会话时出现（含数量徽标）。
 */
function useSessionPanelToolItems(
  sessionId: string | null,
  includePreview: boolean
): SessionPanelToolItem[] {
  const { t } = useTranslation()
  const subAgentCount = useSubAgentCount(sessionId)
  const hasPreviewTarget = usePreviewPanelStore((s) => s.target !== null)
  return [
    { tool: 'files', Icon: FolderTree, label: t('panel.files') },
    ...(includePreview && hasPreviewTarget
      ? [{ tool: 'preview' as const, Icon: Eye, label: t('panel.previewTab') }]
      : []),
    ...(subAgentCount > 0
      ? [{ tool: 'subagent' as const, Icon: Bot, label: t('panel.subAgent'), badge: subAgentCount }]
      : [])
  ]
}

/** 会话工具栏胶囊（悬浮于正文右上角）—— 面板收起时的工具入口；展开后隐藏（切换入口移交面板头部 tabs） */
export function SessionToolbar({
  sessionId,
  showPreview = false
}: {
  sessionId: string | null
  /** 是否显示 Preview 工具入口（与 SessionPanel 的 previewContent 注入配套） */
  showPreview?: boolean
}): React.JSX.Element | null {
  const openTool = useSessionPanelTool(sessionId)
  const tools = useSessionPanelToolItems(sessionId, showPreview)
  if (!sessionId || openTool) return null

  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-lg border border-border-secondary/60 bg-bg-primary/75 backdrop-blur-md shadow-sm">
      {tools.map(({ tool, Icon, label, badge }) => (
        <button
          key={tool}
          onClick={() => useSessionPanelStore.getState().toggle(sessionId, tool)}
          className="flex items-center p-1 rounded-md transition-colors text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50"
          title={label}
        >
          <Icon size={14} />
          {badge !== undefined && badge > 0 && (
            <span className="ml-0.5 text-[10px] tabular-nums">{badge}</span>
          )}
        </button>
      ))}
    </div>
  )
}

export interface SessionPanelProps {
  sessionId: string | null
  /** Files 工具的内容（宿主装配：桌面 FilesPanel + 桌面 caps；扩展 FSA 权限门控 + FilesPanel） */
  filesContent: ReactNode
  /** Preview 工具的内容（可选注入：桌面悬浮窗 / 扩展传共享 PreviewPanel；桌面主窗不传 —— 预览在右侧面板） */
  previewContent?: ReactNode
}

/** 会话面板卡片本体 —— 收起（或无会话）时渲染 null */
export function SessionPanel({
  sessionId,
  filesContent,
  previewContent
}: SessionPanelProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const rawTool = useSessionPanelTool(sessionId)
  const width = useSessionPanelStore((s) => s.width)
  const toolItems = useSessionPanelToolItems(sessionId, previewContent !== undefined)
  if (!sessionId || !rawTool) return null

  // 兜底：面板停在 Preview 但宿主未注入 previewContent（不该发生）→ 回落到 Files
  const tool = rawTool === 'preview' && !previewContent ? 'files' : rawTool

  return (
    // 外层：占位列（宽度参与 flex 布局），左/右/下留白让卡片「悬浮」；上留白略小使其贴近顶栏工具区
    <div
      className="relative flex-shrink-0 min-w-[200px] max-w-[calc(100%-320px)] pl-1 pr-2.5 pt-1 pb-2.5"
      style={{ width }}
    >
      <ResizeHandle />
      {/* 卡片本体：圆角 + 边框 + 投影；overflow-hidden 让内部内容随圆角裁切 */}
      <div className="flex flex-col h-full rounded-xl border border-border-secondary/60 bg-bg-secondary shadow-lg overflow-hidden">
        <div className="flex-shrink-0 flex items-center justify-between gap-1 px-1.5 h-9 border-b border-border-secondary/30">
          {/* 头部 tabs：与工具栏同一入口列表；点按切换工具（当前工具展示图标+文字，其余仅图标） */}
          <div className="flex items-center gap-0.5 min-w-0">
            {toolItems.map(({ tool: itemTool, Icon, label, badge }) => {
              const active = itemTool === tool
              return (
                <button
                  key={itemTool}
                  onClick={() => useSessionPanelStore.getState().show(sessionId, itemTool)}
                  className={`flex items-center gap-1 px-1.5 h-6 rounded-md text-xs font-medium transition-colors min-w-0 ${
                    active
                      ? 'text-accent bg-accent/10'
                      : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50'
                  }`}
                  title={label}
                >
                  <Icon size={13} className="flex-shrink-0" />
                  {active && <span className="truncate">{label}</span>}
                  {badge !== undefined && badge > 0 && (
                    <span className="text-[10px] tabular-nums">{badge}</span>
                  )}
                </button>
              )
            })}
          </div>
          <button
            onClick={() => useSessionPanelStore.getState().close(sessionId)}
            className="p-1 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50 transition-colors flex-shrink-0"
            title={t('common.close')}
          >
            <X size={13} />
          </button>
        </div>
        {/* 内容区 —— 各工具共存，visibility 切换 */}
        <div className="flex-1 min-h-0 relative">
          <div
            className="absolute inset-0"
            style={tool === 'files' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }}
          >
            {filesContent}
          </div>
          {previewContent !== undefined && (
            <div
              className="absolute inset-0"
              style={
                tool === 'preview' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
              }
            >
              {previewContent}
            </div>
          )}
          <div
            className="absolute inset-0"
            style={
              tool === 'subagent' ? undefined : { visibility: 'hidden', pointerEvents: 'none' }
            }
          >
            <SubAgentPanel />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 占位列左缘拖拽条 —— 向左拖增宽（面板贴对话区右侧）。
 * 命中区盖住卡片左侧留白带（无可见高亮，仅 col-resize 光标提示），
 * 宽度经共享 store 钳制；持久化由宿主外接。
 */
function ResizeHandle(): React.JSX.Element {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: useSessionPanelStore.getState().width }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: MouseEvent): void => {
      if (!dragRef.current) return
      const delta = dragRef.current.startX - ev.clientX
      useSessionPanelStore.getState().setWidth(dragRef.current.startW + delta)
    }
    const onUp = (): void => {
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  return (
    <div
      className="absolute inset-y-2 -left-[2px] w-[8px] cursor-col-resize z-20"
      onMouseDown={onMouseDown}
    />
  )
}
