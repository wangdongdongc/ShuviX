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
export { ContextManagementSettings } from './settings/ContextManagementSettings'
export { SystemPromptSettings } from './settings/SystemPromptSettings'
export type { SystemPromptSettingsProps } from './settings/SystemPromptSettings'
export { PromptSectionsEditor } from './settings/PromptSectionsEditor'
export type { PromptSectionsEditorProps } from './settings/PromptSectionsEditor'
export { ProjectConfigDialog } from './settings/ProjectConfigDialog'
export type { ProjectConfigDialogProps, ProjectConfigTab } from './settings/ProjectConfigDialog'

// 侧边栏会话列表件（prop 驱动）
export { SessionItem } from './sidebar/SessionItem'
export type { SessionItemProps } from './sidebar/SessionItem'
export { SessionList } from './sidebar/SessionList'
export type { SessionListProps } from './sidebar/SessionList'
export { SessionGroup } from './sidebar/SessionGroup'
export type { SessionGroupProps } from './sidebar/SessionGroup'
export { useSessionDelete } from './sidebar/useSessionDelete'
export type { UseSessionDeleteReturn } from './sidebar/useSessionDelete'
export { useFocusDim } from './sidebar/useFocusDim'
export { SidebarResizeHandle } from './sidebar/SidebarResizeHandle'
export type { SidebarResizeHandleProps } from './sidebar/SidebarResizeHandle'

// 聊天主视图顶栏（prop 驱动 + 能力开关 + 右侧插槽）
export { ChatHeader } from './chat/ChatHeader'
export type { ChatHeaderProps, ChatHeaderCaps } from './chat/ChatHeader'
export { PanelToggleButton } from './chat/PanelToggleButton'
export type { PanelToggleButtonProps } from './chat/PanelToggleButton'

// 右侧面板叶子组件（工作目录文件树 + 子代理）—— 经 getChatApi().files / chat-ui store 取后端，
// 宿主差异走 props（markdown 打开方式、媒体 URL 解析、子会话销毁）
export { FilesPanel } from './files/FilesPanel'
export type { FilesPanelProps } from './files/FilesPanel'
export { MediaUrlProvider, shuvixPreviewResolver } from './files/mediaUrl'
export type { ResolveMediaUrl, MediaSource } from './files/mediaUrl'
export { SubAgentPanel } from './subagent/SubAgentPanel'
export type { SubAgentPanelProps } from './subagent/SubAgentPanel'

// 通用 UI 原子
export { AnimatedCollapse } from './common/AnimatedCollapse'
export { ConfirmDialog } from './common/ConfirmDialog'
export type { ConfirmDialogProps } from './common/ConfirmDialog'

// 欢迎页 + 配置分享对话框（prop 驱动，经 getChatApi().config 取后端）
export { WelcomeView } from './welcome/WelcomeView'
export type { WelcomeViewProps } from './welcome/WelcomeView'
export { ConfigExportDialog } from './welcome/ConfigExportDialog'
export { ConfigImportDialog } from './welcome/ConfigImportDialog'
