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

// 通用 UI 原子
export { AnimatedCollapse } from './common/AnimatedCollapse'
export { ConfirmDialog } from './common/ConfirmDialog'
export type { ConfirmDialogProps } from './common/ConfirmDialog'
