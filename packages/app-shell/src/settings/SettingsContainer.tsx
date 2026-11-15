/**
 * SettingsContainer —— 注入式设置面板外壳（宿主无关）。
 *
 * 只负责「头部 + 左侧 tab 导航 + 右侧内容槽」的外观；tab 列表、当前 tab、内容均由宿主注入。
 * 桌面注入全套 tab（general/providers/…），扩展只注入 [外观, 提供商]。
 *
 * 不读 store / window.api；activeTab 受控（宿主用 settingsStore / hash / chrome.storage）。唯一的状态是叠放布局的
 * 第二层（分区里开着的那一项，见 stackedSettings.tsx）—— 它只决定顶栏怎么写。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ExperimentalFeature } from '@shuvix/chat-protocol/experimentalFeatures'
import { ExperimentalTag } from '../common/ExperimentalTag'
import { TabButton } from './TabButton'
import { StackedSettingsProvider, type StackedSubPage } from './stackedSettings'
import { useStackedHistory } from './useStackedHistory'

export interface SettingsTab {
  id: string
  label: string
  icon?: ReactNode
  /** 实验功能：导航里文案后缀一枚「实验」小标签（见 chat-protocol EXPERIMENTAL_FEATURES） */
  experimental?: ExperimentalFeature
  /** 该 tab 的内容（宿主自行决定是否包滚动容器） */
  content: ReactNode
  /**
   * 叠放布局的分区列表里它在哪一张分组卡片上：相同 `group` 的分区收进同一张卡片，卡片按各组第一次出现的先后排。
   * 不给 = 自己一张。桌面的左侧导航不看它
   */
  group?: string
  /** 叠放布局的分区列表里行尾的一个词或数（几家提供商、开没开）；不给不画 */
  value?: ReactNode
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
  stacked?: {
    showList: boolean
    onBack: () => void
    /** 此刻钻到了第几层（0 = 分区列表，1 = 某个分区，2 = 分区里的一项）：宿主据此收起自己的标签栏 */
    onDepthChange?: (depth: number) => void
  }
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
  // 叠放布局的层数（列表 0 / 分区 1 / 分区里的一项 2）：报给宿主，并接到浏览器历史上（返回手势一层一层退）
  const depth = !stacked || stacked.showList ? 0 : subPage ? 2 : 1
  const onDepthChange = stacked?.onDepthChange
  useEffect(() => {
    onDepthChange?.(depth)
  }, [depth, onDepthChange])
  useStackedHistory(!!stacked, depth, (target) => {
    if (target < 2 && subPage) subPage.onBack()
    if (target < 1) stacked?.onBack()
  })
  if (stacked) {
    // 分区按 group 收进卡片（相同 group 一张，没有 group 的自己一张），卡片按各组第一次出现的先后排
    const cards: SettingsTab[][] = []
    const cardOf = new Map<string, SettingsTab[]>()
    for (const tab of tabs) {
      const existing = tab.group === undefined ? undefined : cardOf.get(tab.group)
      if (existing) {
        existing.push(tab)
        continue
      }
      const card = [tab]
      cards.push(card)
      if (tab.group !== undefined) cardOf.set(tab.group, card)
    }
    return (
      <div className="h-full bg-bg-primary flex flex-col" data-settings-stacked="">
        {stacked.showList ? (
          <>
            <div className="flex flex-shrink-0 items-center pl-5 pr-2 pt-3 pb-2">
              <h1 className="min-w-0 flex-1 truncate text-[28px] font-bold leading-9 tracking-tight text-text-primary">
                {title}
              </h1>
            </div>
            <div data-settings-nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-6 pt-1">
              {cards.map((card) => (
                <div
                  key={card[0].id}
                  data-settings-nav-card=""
                  className="overflow-hidden rounded-xl bg-bg-secondary"
                >
                  {card.map((tab, index) => (
                    <button
                      key={tab.id}
                      type="button"
                      data-settings-tab={tab.id}
                      onClick={() => onTabChange(tab.id)}
                      className="flex w-full items-stretch gap-3 pl-4 text-left text-[16px] text-text-primary active:bg-bg-hover"
                    >
                      <span className="flex flex-shrink-0 items-center text-accent [&>svg]:h-[19px] [&>svg]:w-[19px]">
                        {tab.icon}
                      </span>
                      {/* 行与行之间的细线从标签起头（图标那一列不画） */}
                      <span
                        className={`flex min-h-[44px] min-w-0 flex-1 items-center gap-2 pr-3 ${
                          index > 0 ? 'border-t border-border-secondary/50' : ''
                        }`}
                      >
                        <span data-tab-label="" className="min-w-0 truncate">
                          {tab.label}
                        </span>
                        {tab.experimental && <ExperimentalTag feature={tab.experimental} />}
                        <span className="ml-auto flex flex-shrink-0 items-center gap-1 text-text-tertiary">
                          {tab.value !== undefined && tab.value !== null && (
                            <span data-settings-tab-value="" className="text-[15px] tabular-nums">
                              {tab.value}
                            </span>
                          )}
                          <ChevronRight size={16} aria-hidden="true" />
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            {/* 与手机上别的推入页同一副顶栏：返回（写着上一层的名字）在上，这一层的名字是大标题 */}
            <div className="flex flex-shrink-0 items-center px-2 pt-2">
              <button
                type="button"
                data-settings-back=""
                data-settings-level={subPage ? 'item' : 'section'}
                onClick={subPage ? subPage.onBack : stacked.onBack}
                className="flex h-9 max-w-[70%] items-center gap-0.5 rounded-full pl-1 pr-3 text-[16px] text-accent active:bg-bg-hover"
                aria-label={subPage ? active?.label : title}
              >
                <ChevronLeft size={22} className="flex-shrink-0" aria-hidden="true" />
                <span className="truncate">{subPage ? active?.label : title}</span>
              </button>
            </div>
            <h1
              data-settings-heading=""
              className="flex-shrink-0 truncate px-5 pt-3 pb-2 text-[28px] font-bold leading-9 tracking-tight text-text-primary"
            >
              {subPage ? subPage.title : active?.label}
            </h1>
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
