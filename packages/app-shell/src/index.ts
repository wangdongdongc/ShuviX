/**
 * @shuvix/app-shell —— 可复用应用外壳。
 *
 * 宿主无关、prop 驱动：会话列表侧栏 + 注入式设置容器 + 共享设置原子组件 + 主题 token CSS。
 * 桌面（Electron）与 Chrome 扩展共用，差异通过 props / 能力开关表达，状态/持久化由宿主拥有。
 */

// 设置原子组件 + 对话框（零耦合，可直接复用）
export * from './settings/SettingsPrimitives'
export { TabButton } from './settings/TabButton'
export { ProviderIcon } from './settings/ProviderIcons'
export { AddProviderDialog } from './settings/AddProviderDialog'
export { ModelCapabilitiesDialog } from './settings/ModelCapabilitiesDialog'

// 设置外壳 + 共享 tab（prop 驱动 + 能力开关）
export { SettingsContainer } from './settings/SettingsContainer'
export type { SettingsTab, SettingsContainerProps } from './settings/SettingsContainer'
export { AppearanceTab, DARK_THEMES, LIGHT_THEMES } from './settings/AppearanceTab'
export type { AppearanceTabProps, ThemeMode } from './settings/AppearanceTab'
export { AboutTab } from './settings/AboutTab'
export type { AboutTabProps, AboutTabUpdateApi } from './settings/AboutTab'
export { ProviderTab } from './settings/ProviderTab'
export type { ProviderTabProps, ProviderTabApi } from './settings/ProviderTab'
export { ModelDefaultsSettings } from './settings/ModelDefaultsSettings'
export type { ModelDefaultsSettingsProps } from './settings/ModelDefaultsSettings'
export { McpClientPanel } from './settings/McpClientPanel'
export type { McpClientPanelProps, McpApi } from './settings/McpClientPanel'
export { McpServerDialog } from './settings/McpServerDialog'
export type { McpServerDialogData, McpServerDialogInitial } from './settings/McpServerDialog'
export { ProjectInfoForm } from './settings/ProjectInfoForm'
export type { ProjectInfoFormProps } from './settings/ProjectInfoForm'
export { ProjectConfigDialog } from './settings/ProjectConfigDialog'
export type { ProjectConfigDialogProps, ProjectConfigTab } from './settings/ProjectConfigDialog'
export { BuiltinToolsView } from './settings/BuiltinToolsView'
export type { BuiltinToolsViewProps, BuiltinToolsExtraTab } from './settings/BuiltinToolsView'
export { ProjectsSettings } from './settings/ProjectsSettings'
export type { ProjectsSettingsProps } from './settings/ProjectsSettings'

// 侧边栏会话列表件（prop 驱动）
export { SessionItem } from './sidebar/SessionItem'
export type { SessionItemProps } from './sidebar/SessionItem'
export { SessionList } from './sidebar/SessionList'
export type { SessionListProps } from './sidebar/SessionList'
export { SessionGroup } from './sidebar/SessionGroup'
export type { SessionGroupProps } from './sidebar/SessionGroup'
export { ProjectSessionGroups, TEMP_GROUP_KEY } from './sidebar/ProjectSessionGroups'
export type { ProjectSessionGroupsProps } from './sidebar/ProjectSessionGroups'
export { ProjectMemoryFolder } from './sidebar/ProjectMemoryFolder'
export type { ProjectMemoryFolderProps, ProjectMemoryAdapter } from './sidebar/ProjectMemoryFolder'
export { Sidebar } from './sidebar/Sidebar'
export type { SidebarProps, SidebarCaps } from './sidebar/Sidebar'
export { CalendarView } from './sidebar/CalendarView'
export type { CalendarViewProps } from './sidebar/CalendarView'
export { ViewSwitchButton } from './sidebar/ViewSwitchButton'
export type { ViewSwitchButtonProps, SidebarViewMode } from './sidebar/ViewSwitchButton'
export { WikiView } from './sidebar/WikiView'
export type { WikiViewProps } from './sidebar/WikiView'
export { useProjects } from './sidebar/useProjects'
export type { UseProjectsReturn, ProjectRef } from './sidebar/useProjects'
export { useSessionDelete } from './sidebar/useSessionDelete'
export type { UseSessionDeleteReturn } from './sidebar/useSessionDelete'
export { useFocusDim } from './sidebar/useFocusDim'
export { SidebarResizeHandle } from './sidebar/SidebarResizeHandle'
export type { SidebarResizeHandleProps } from './sidebar/SidebarResizeHandle'

// 聊天主视图顶栏（prop 驱动 + 能力开关 + 右侧插槽）
export { ChatHeader } from './chat/ChatHeader'
export type { ChatHeaderProps, ChatHeaderCaps } from './chat/ChatHeader'
// 聊天主视图正文外壳（顶栏 + 欢迎/笔记本/对话三态 + 横幅/浮层/占位插槽）
export { ChatBody } from './chat/ChatBody'
export type { ChatBodyProps } from './chat/ChatBody'
// 运行时/分享/询问状态横幅（按宿主能力自动显隐）—— 桌面/扩展共用，作为 ChatBody 的 banner 插槽
export { StatusBanner } from './chat/StatusBanner'
export type { StatusBannerProps } from './chat/StatusBanner'
// 会话配置面板 + 弹窗
export { SessionConfigPanel } from './chat/SessionConfigPanel'
export type { SessionConfigPanelProps } from './chat/SessionConfigPanel'
export { SessionConfigDialog } from './chat/SessionConfigDialog'
export type { SessionConfigDialogProps } from './chat/SessionConfigDialog'
// 会话渠道绑定能力探测（设置页 + 会话设置共用单一来源）
export { PanelToggleButton } from './chat/PanelToggleButton'
export type { PanelToggleButtonProps } from './chat/PanelToggleButton'
// 右侧面板标签栏（统一标签样式；标签集合/激活态由宿主注入）—— 桌面/扩展共用
export { PanelTabBar } from './panel/PanelTabBar'
export type { PanelTabBarProps, PanelTabItem } from './panel/PanelTabBar'
// 右侧面板共享视图状态（isOpen/activeTab/width）—— 持久化/边界/原生同步由各宿主在 store 外接
export { usePanelStore } from './panel/panelStore'
export type { PanelStoreState } from './panel/panelStore'
// 会话面板（聊天区内悬浮卡片：Files/Sub-agent）—— 状态按会话记忆；宽度持久化由宿主外接
export {
  useSessionPanelStore,
  SESSION_PANEL_MIN_W,
  SESSION_PANEL_MAX_W
} from './panel/sessionPanelStore'
export type { SessionPanelTool, SessionPanelStoreState } from './panel/sessionPanelStore'
export {
  SessionPanel,
  SessionToolbar,
  useSessionPanelTool,
  useSessionPanelReveal
} from './panel/SessionPanel'
export type { SessionPanelProps } from './panel/SessionPanel'
// 侧边栏共享视图状态（isOpen/width）—— 持久化/边界由各宿主在 store 外接（桌面 isResizing 留宿主外层）
export { useSidebarStore } from './sidebar/sidebarStore'
export type { SidebarStoreState } from './sidebar/sidebarStore'

// 右侧面板叶子组件（工作目录文件树 + 子代理）—— 经 getChatApi().files / chat-ui store 取后端，
// 宿主差异走 props（markdown 打开方式、媒体 URL 解析、子会话销毁）
export { FilesPanel } from './files/FilesPanel'
export type { FilesPanelProps } from './files/FilesPanel'
// mediaUrl seam 已下沉到 chat-ui（工具卡片也要用，而 chat-ui 是下层包）；这里透传，宿主 import 点不变
export { MediaUrlProvider, shuvixPreviewResolver, useResolveMediaUrl } from '@shuvix/chat-ui'
export type { ResolveMediaUrl, MediaSource } from '@shuvix/chat-ui'

// 独立预览面板（会话无关）：store + 桥 + 面板/覆盖层两种露出形态
export {
  usePreviewPanelStore,
  usePreviewRequestBridge,
  type PreviewTarget
} from './preview/previewPanelStore'
export { PreviewPanel, type PreviewPanelProps } from './preview/PreviewPanel'
// 宿主无关路径工具（不依赖 node:path）——供宿主拼接笔记本绑定路径 / 求相对路径复用
export { extOf, basename, joinPath, relativize } from './files/paths'

// 笔记本会话中间区视图（md live-preview 编辑器）—— 宿主无关，文件 IO 经 getChatApi().files，
// 图片内嵌经 MediaUrlProvider，主题/外链/右键/平台经 caps 注入
export { NotebookView } from './notebook/NotebookView'
export type { NotebookViewProps } from './notebook/NotebookView'
export { NotebookSession } from './notebook/NotebookSession'
export type { NotebookSessionProps } from './notebook/NotebookSession'
export { useCreateNotebook } from './notebook/useCreateNotebook'
export { EFFECT_CLASS as POLICY_EFFECT_CLASS } from './notebook/frontmatterCard'
export { LivePreviewEditor } from './notebook/LivePreviewEditor'
export type {
  LivePreviewEditorHandle,
  LivePreviewEditorProps,
  NotebookCaps,
  SaveStatus
} from './notebook/LivePreviewEditor'

export { SubAgentPanel } from './subagent/SubAgentPanel'

// 右键菜单（共享配置 + 注入式渲染器：桌面原生 / 扩展 DOM）
export {
  ContextMenuProvider,
  useContextMenu,
  usePopupContextMenu
} from './contextmenu/ContextMenuProvider'
export type {
  ContextMenuRenderer,
  ContextMenuPosition,
  ShowContextMenu
} from './contextmenu/ContextMenuProvider'
export { ContextMenuPopup } from './contextmenu/ContextMenuPopup'
export type { ContextMenuPopupProps } from './contextmenu/ContextMenuPopup'

// 通用 UI 原子
export { AnimatedCollapse } from './common/AnimatedCollapse'
export { ConfirmDialog } from './common/ConfirmDialog'
export type { ConfirmDialogProps } from './common/ConfirmDialog'

// 欢迎页 + 配置分享对话框（prop 驱动，经 getChatApi().config 取后端）
export { WelcomeView } from './welcome/WelcomeView'
export type { WelcomeViewProps } from './welcome/WelcomeView'
export { ConfigExportDialog } from './welcome/ConfigExportDialog'
export { ConfigImportDialog } from './welcome/ConfigImportDialog'
