/**
 * SettingsContainer —— 注入式设置面板外壳（宿主无关）。
 *
 * 只负责「头部 + 左侧 tab 导航 + 右侧内容槽」的外观；tab 列表、当前 tab、内容均由宿主注入。
 * 桌面注入全套 tab（general/providers/…），扩展只注入 [外观, 提供商]。
 *
 * 不持有状态、不读 store / window.api；activeTab 受控（宿主用 settingsStore / hash / chrome.storage）。
 */
import type { ReactNode } from 'react'
import { TabButton } from './TabButton'

export interface SettingsTab {
  id: string
  label: string
  icon?: ReactNode
  /** 该 tab 的内容（宿主自行决定是否包滚动容器） */
  content: ReactNode
}

export interface SettingsContainerProps {
  tabs: SettingsTab[]
  activeTab: string
  onTabChange: (id: string) => void
  title: string
  /** 头部加窗口拖拽区 class（桌面独立窗口用；扩展整页不需要） */
  draggableHeader?: boolean
  /** macOS 交通灯顶部留白（桌面用） */
  macTrafficLights?: boolean
}

export function SettingsContainer({
  tabs,
  activeTab,
  onTabChange,
  title,
  draggableHeader = false,
  macTrafficLights = false
}: SettingsContainerProps): React.JSX.Element {
  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0]
  return (
    <div className="h-full bg-bg-primary flex flex-col">
      <div
        className={`${draggableHeader ? 'titlebar-drag ' : ''}flex items-center px-6 pb-4 border-b border-border-secondary bg-bg-secondary ${
          macTrafficLights ? 'pt-10' : 'pt-4'
        }`}
      >
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="w-[180px] flex-shrink-0 border-r border-border-secondary py-4 px-3 space-y-1 bg-bg-secondary overflow-y-auto">
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              icon={tab.icon}
              label={tab.label}
              active={active?.id === tab.id}
              onClick={() => onTabChange(tab.id)}
            />
          ))}
        </div>

        <div className="flex-1 min-w-0 flex flex-col">{active?.content}</div>
      </div>
    </div>
  )
}
