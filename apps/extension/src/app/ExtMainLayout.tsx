import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatHostProvider, useChatStore, getChatApi } from '@shuvix/chat-ui'
import {
  WelcomeView,
  ChatBody,
  PanelToggleButton,
  SidebarResizeHandle,
  ContextMenuProvider,
  useSessionDelete,
  SessionConfigDialog,
  StatusBanner,
  usePanelStore,
  useSidebarStore
} from '@shuvix/app-shell'
import i18n from './i18n'
import { SessionRuntime } from './SessionRuntime'
import { ExtSidebar } from './ExtSidebar'
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from './sidebarStore'
import { PANEL_MIN_WIDTH, PANEL_MAX_WIDTH } from './panelStore'
import { RightPanel } from './RightPanel'
import { ExtNotebookSession } from './ExtNotebookSession'

type ChatHostValue = React.ComponentProps<typeof ChatHostProvider>['value']

/** 刷新会话列表到 chatStore（供共享侧栏 SessionGroup 渲染） */
async function refreshSessions(): Promise<void> {
  const sessions = await getChatApi().session.list()
  useChatStore.getState().setSessions(sessions)
}

/**
 * 扩展主界面布局 —— 对齐桌面：侧栏（ExtSidebar）+ 共享 <ChatBody> 正文 + 右侧面板（文件/子代理）。
 * 拥有会话运行时（SessionRuntime）、会话/项目装载与右面板自动切 Tab 的副作用。
 */
export function ExtMainLayout({ host }: { host: ChatHostValue }): React.JSX.Element {
  const { t } = useTranslation()
  const [sessionId, setSessionId] = useState<string | null>(null)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const setActiveSessionId = useChatStore((s) => s.setActiveSessionId)
  const isOpen = useSidebarStore((s) => s.isOpen)
  const width = useSidebarStore((s) => s.width)
  const [resizing, setResizing] = useState(false)
  const panelOpen = usePanelStore((s) => s.isOpen)
  const panelWidth = usePanelStore((s) => s.width)
  const [panelResizing, setPanelResizing] = useState(false)
  const [showSessionConfig, setShowSessionConfig] = useState(false)

  // 启动仅加载会话列表，不自动选中 —— 无活跃会话时显示欢迎页（与桌面一致）。
  // 首次发送由 InputArea 自动创建临时会话；API Key 在「设置 → 提供商」配置。
  useEffect(() => {
    void refreshSessions()
  }, [])

  // 跟随 chatStore 活跃会话（侧栏点击切换）
  useEffect(() => {
    setSessionId(activeSessionId)
  }, [activeSessionId])

  // 笔记本 [[wiki-link]] 点击 → 打开右侧 Files 面板（FilesPanel 自身订阅 filePreviewRequest 打开预览）
  const filePreviewRequest = useChatStore((s) => s.filePreviewRequest)
  useEffect(() => {
    if (filePreviewRequest) usePanelStore.getState().showTab('files')
  }, [filePreviewRequest])

  // 子智能体启动（含笔记本每次发送）→ 自动打开右侧「子智能体」Tab（共享信号，事件检测在 useAgentEvents）
  const subAgentRevealRequest = useChatStore((s) => s.subAgentRevealRequest)
  useEffect(() => {
    if (subAgentRevealRequest) usePanelStore.getState().showTab('subagent')
  }, [subAgentRevealRequest])

  // 工具渲染配置（read/write/edit/ask 复用桌面定义 + 浏览器工具）；随语言切换重解析
  useEffect(() => {
    void getChatApi()
      .tools.presentations()
      .then((p) => useChatStore.getState().setToolPresentations(p))
  }, [i18n.language])

  const handleNew = useCallback(
    async (projectId?: string | null) => {
      const s = await getChatApi().session.create({ projectId: projectId ?? null })
      await refreshSessions()
      setActiveSessionId(s.id)
    },
    [setActiveSessionId]
  )

  // 删除会话全流程走共享 useSessionDelete（含消息时弹共享 ConfirmDialog），与桌面同一套
  const { requestDelete: handleDelete, deleteDialog } = useSessionDelete()

  return (
    <ChatHostProvider value={host}>
      <ContextMenuProvider>
        <SessionRuntime sessionId={sessionId} />
        <div className="h-full flex bg-bg-primary text-text-primary">
          {/* 折叠：宽度归 0；拖宽：宿主 sidebarStore（chrome.storage 持久化）。
            内层定宽避免折叠动画期内容被挤压回流。 */}
          <div
            className={`flex-shrink-0 overflow-hidden ${resizing ? '' : 'transition-[width] duration-200 ease-in-out'}`}
            style={{ width: isOpen ? width : 0 }}
          >
            {/* 不加 border-r：分隔线由下方 SidebarResizeHandle(w-px) 提供，与桌面一致，避免双线显宽 */}
            <div className="h-full" style={{ width }}>
              <ExtSidebar
                onNew={handleNew}
                onDelete={handleDelete}
                onOpenSettings={() => {
                  window.location.hash = '#settings'
                }}
              />
            </div>
          </div>
          {isOpen && (
            <SidebarResizeHandle
              width={width}
              min={SIDEBAR_MIN_WIDTH}
              max={SIDEBAR_MAX_WIDTH}
              onResize={(w) => useSidebarStore.getState().setWidth(w)}
              onResizeStart={() => setResizing(true)}
              onResizeEnd={() => setResizing(false)}
            />
          )}
          {/* 共享 <ChatBody>：顶栏 + 欢迎/笔记本/对话三态。Conversation 是 Fragment（messages flex-1
            + InputArea），故根容器须 flex 列 + 定高 + relative（压缩遮罩 absolute inset-0 定位到对话区）。
            笔记本传相对 notebookPath，后端按 sessionId 解析工作目录句柄，切换项目时不依赖全局 projectPath。 */}
          <ChatBody
            className="relative flex-1 min-w-0 flex flex-col min-h-0"
            headerCaps={{ editableTitle: true, sessionConfig: true }}
            onOpenSessionConfig={() => setShowSessionConfig(true)}
            banner={
              // 运行时/分享/审批状态横幅（复用 app-shell；扩展仅免审批项会出现，余项按能力自隐）
              activeSessionId ? <StatusBanner sessionId={activeSessionId} /> : undefined
            }
            overlays={
              // 会话配置弹窗：复用 app-shell 共享组件；绑定分节据宿主能力自动显隐
              showSessionConfig && activeSessionId ? (
                <SessionConfigDialog
                  sessionId={activeSessionId}
                  onClose={() => setShowSessionConfig(false)}
                />
              ) : undefined
            }
            rightActions={
              <>
                {/* 折叠会话列表 + 切换右侧面板 —— 复用共享按钮，样式与桌面一致 */}
                <PanelToggleButton
                  side="left"
                  open={isOpen}
                  onClick={() => useSidebarStore.getState().toggle()}
                  title={t('sidebar.title')}
                />
                <PanelToggleButton
                  side="right"
                  open={panelOpen}
                  onClick={() => usePanelStore.getState().toggle()}
                  title={t('panel.files')}
                />
              </>
            }
            welcome={<WelcomeView enableConfigShare />}
            renderNotebook={(path, sid) => (
              <ExtNotebookSession key={sid} path={path} sessionId={sid} />
            )}
          />
          {/* 右侧面板（文件 / 子代理）：手柄在左侧，向左拖变宽(invert) */}
          {panelOpen && (
            <SidebarResizeHandle
              width={panelWidth}
              min={PANEL_MIN_WIDTH}
              max={PANEL_MAX_WIDTH}
              invert
              onResize={(w) => usePanelStore.getState().setWidth(w)}
              onResizeStart={() => setPanelResizing(true)}
              onResizeEnd={() => setPanelResizing(false)}
            />
          )}
          <div
            className={`flex-shrink-0 overflow-hidden ${panelResizing ? '' : 'transition-[width] duration-200 ease-in-out'}`}
            style={{ width: panelOpen ? panelWidth : 0 }}
          >
            <div className="h-full" style={{ width: panelWidth }}>
              <RightPanel />
            </div>
          </div>
        </div>
        {deleteDialog}
      </ContextMenuProvider>
    </ChatHostProvider>
  )
}
