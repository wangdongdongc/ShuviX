/**
 * SettingsContainer —— 注入式设置面板外壳（宿主无关）。
 *
 * 只负责「头部 + 左侧 tab 导航 + 右侧内容槽」的外观；tab 列表、当前 tab、内容均由宿主注入。
 * 桌面注入全套 tab（general/providers/…），扩展只注入 [外观, 提供商]。
 *
 * 不读 store / window.api；activeTab 受控（宿主用 settingsStore / hash / chrome.storage）。唯一的状态是叠放布局的
 * 第二层（分区里开着的那一项，见 stackedSettings.tsx）—— 它只决定顶栏怎么写。
 */
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ExperimentalFeature } from '@shuvix/chat-protocol/experimentalFeatures'
import { ExperimentalTag } from '../common/ExperimentalTag'
import { TabButton } from './TabButton'
import { StackedSettingsProvider, type StackedSubPage } from './stackedSettings'

export interface SettingsTab {
  id: string
  label: string
  icon?: ReactNode
  /** 实验功能：导航里文案后缀一枚「实验」小标签（见 chat-protocol EXPERIMENTAL_FEATURES） */
  experimental?: ExperimentalFeature
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
  /**
   * 叠放布局（web 客户端的手机布局）：先是一列分区（`showList`），点一项进去，头部换成返回键 + 分区名
   * （`onBack` 回到那一列）。缺省 = 左侧 tab 导航 + 右侧内容（桌面与扩展）
   */
  stacked?: { showList: boolean; onBack: () => void }
}

export function SettingsContainer({
  tabs,
  activeTab,
  onTabChange,
  title,
  draggableHeader = false,
  macTrafficLights = false,
  stacked
}: SettingsContainerProps): React.JSX.Element {
  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0]
  // 叠放布局的第二层：分区自己开着一项的详情时，顶栏写「‹ <分区名>」+ 这一项（分区经 useStackedSubPage 报上来）
  const [subPage, setSubPage] = useState<StackedSubPage | null>(null)
  const stackedValue = useMemo(() => ({ setSubPage }), [])
  if (stacked) {
    return (
      <div className="h-full bg-bg-primary flex flex-col" data-settings-stacked="">
        {stacked.showList ? (
          <>
            <div className="flex items-center px-4 pt-3 pb-2">
              <h2 className="text-xl font-semibold text-text-primary">{title}</h2>
            </div>
            <div data-settings-nav className="flex-1 overflow-y-auto pb-4">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  data-settings-tab={tab.id}
                  onClick={() => onTabChange(tab.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-[15px] text-text-primary border-b border-border-secondary/40 active:bg-bg-hover"
                >
                  <span className="text-text-tertiary flex-shrink-0">{tab.icon}</span>
                  <span className="flex-1 min-w-0 text-left truncate">{tab.label}</span>
                  {tab.experimental && <ExperimentalTag feature={tab.experimental} />}
                  <ChevronRight size={16} className="text-text-tertiary flex-shrink-0" />
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1 px-1 h-11 border-b border-border-secondary/40 flex-shrink-0">
              <button
                type="button"
                data-settings-back=""
                data-settings-level={subPage ? 'item' : 'section'}
                onClick={subPage ? subPage.onBack : stacked.onBack}
                className="flex items-center gap-0.5 h-9 pl-1 pr-2 rounded-md text-text-secondary active:bg-bg-hover max-w-[40%]"
                aria-label={subPage ? active?.label : title}
              >
                <ChevronLeft size={20} className="flex-shrink-0" />
                <span className="text-[13px] truncate">{subPage ? active?.label : title}</span>
              </button>
              <span
                data-settings-heading=""
                className="flex-1 min-w-0 truncate text-center text-[15px] font-medium text-text-primary pr-16"
              >
                {subPage ? subPage.title : active?.label}
              </span>
            </div>
            <div className="flex-1 min-h-0 flex flex-col">
              <StackedSettingsProvider value={stackedValue}>
                {active?.content}
              </StackedSettingsProvider>
            </div>
          </>
        )}
      </div>
    )
  }
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
        {/*
         * 192px 是英文「Telegram Bots」+ Beta 标签放得下的宽度（180px 时差约 6px，文案会被截断）；
         * data-settings-nav 是 e2e 认这一列的锚点，别再按宽度类名认
         */}
        <div
          data-settings-nav
          className="w-48 flex-shrink-0 border-r border-border-secondary py-4 px-3 space-y-1 bg-bg-secondary overflow-y-auto"
        >
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              icon={tab.icon}
              label={tab.label}
              experimental={tab.experimental}
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
