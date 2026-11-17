/**
 * 设置面板（桌面）—— 独立窗口（分组 Tab）。
 * 外壳复用 @shuvix/app-shell 的 SettingsContainer（注入式 tab）；桌面注入全套 tab。
 * activeTab 仍存 settingsStore，并与 `#settings/<tab>[/<subTab>]` hash 同步。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Settings,
  Layers,
  Activity,
  Info,
  Puzzle,
  Wrench,
  Send,
  Mic,
  Archive,
  Timer,
  Globe
} from 'lucide-react'
import { SettingsContainer, type SettingsTab } from '@shuvix/app-shell'
import { useSettingsStore } from '../../stores/settingsStore'
import { GeneralSettings } from './GeneralSettings'
import { ArchivedSettings } from './ArchivedSettings'
import { ProviderSettings } from './ProviderSettings'
import { MonitorSettings, MONITOR_SUB_TABS, type MonitorSubTab } from './MonitorSettings'
import { AboutSettings } from './AboutSettings'
import { McpSettings } from './McpSettings'
import { NetworkAccessSettings } from './NetworkAccessSettings'
import { ToolSettings } from './ToolSettings'
import { TelegramBotsSettings } from './TelegramBotsSettings'
import { VoiceSettings } from './VoiceSettings'
import { TriggerSettings } from './TriggerSettings'

const VALID_TABS = new Set([
  'general',
  'archived',
  'providers',
  'tools',
  'mcp',
  'network',
  'voice',
  'triggers',
  'telegramBots',
  'monitor',
  'about'
])

/** 解析 `#settings/<tab>[/<subTab>]`（子段目前只有监视器用） */
function parseSettingsHash(): { tab?: string; sub?: string } {
  const match = window.location.hash.match(/^#settings\/(.+)$/)
  if (!match) return {}
  const [tab, sub] = match[1].split('/')
  return VALID_TABS.has(tab) ? { tab, sub } : {}
}

/** 内容滚动容器（保留原各 tab 的滚动行为） */
function Scroll({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex-1 overflow-y-auto">{children}</div>
}

export interface SettingsPanelProps {
  /**
   * 手机布局（web 客户端，窄屏）：分区先排成一列，点进去是那一个分区、头部有返回键（SettingsContainer 的
   * stacked）。缺省 = 桌面的左侧导航
   */
  stacked?: boolean
  /** 排在最后的额外分区（手机布局：智能体监视 —— 桌面上它在右侧面板里） */
  extraTabs?: StackedExtraTab[]
  /** 叠放布局钻到了第几层（0 = 分区列表）：手机壳据此收起标签栏 */
  onStackedDepthChange?: (depth: number) => void
  /**
   * 叠放布局：这个数一变，分区列表行尾的那些词和数重新取一遍。宿主在自己推入的整屏页面（`onOpen` 的那种，不经过
   * 分区）收起时换一个数 —— 那几页里可能改了行尾写的东西（开了几个标签页）
   */
  stackedValuesEpoch?: number
}

/** 手机布局额外的分区；`after` = 排在哪个分区后面（缺省排在最后） */
export type StackedExtraTab = SettingsTab & { after?: string }

/**
 * 叠放布局的分区列表里，行尾那个词或数：开着几家提供商、开着几台 MCP 服务器、远程访问开没开。
 * 列表每次露出来取一次（从分区里改完退回来就是新的）；没取到就不画（上一次取到的也撤掉，不留一个可能过时的数）
 */
function useStackedTabValues(active: boolean, epoch: number): Record<string, React.ReactNode> {
  const { t } = useTranslation()
  const [values, setValues] = useState<Record<string, React.ReactNode>>({})
  useEffect(() => {
    if (!active) return
    let alive = true
    const put = (id: string, value: React.ReactNode): void => {
      if (alive) setValues((prev) => ({ ...prev, [id]: value }))
    }
    void window.api.provider
      .listEnabled()
      .then((list) => put('providers', list.length > 0 ? list.length : undefined))
      .catch(() => put('providers', undefined))
    void window.api.mcp
      .list()
      .then((list) => {
        const on = list.filter((server) => !!server.isEnabled).length
        put('mcp', on > 0 ? on : undefined)
      })
      .catch(() => put('mcp', undefined))
    // 标签页的清单是 admin：这台设备被策略拒了就不写数
    void window.api.browserView
      .listTabs()
      .then((list) =>
        put(
          'browser',
          list.length > 0 ? t('browser.manager.tabCount', { count: list.length }) : undefined
        )
      )
      .catch(() => put('browser', undefined))
    void window.api.network
      .status()
      .then((status) => put('network', status.enabled ? t('mobile.on') : t('mobile.off')))
      .catch(() => put('network', undefined))
    return () => {
      alive = false
    }
  }, [active, epoch, t])
  return values
}

export function SettingsPanel({
  stacked = false,
  extraTabs = [],
  onStackedDepthChange,
  stackedValuesEpoch = 0
}: SettingsPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSettingsTab, setActiveSettingsTab } = useSettingsStore()
  /** 叠放布局里此刻显示的是分区列表（hash 点名了某个分区就直接进去） */
  const [showList, setShowList] = useState(() => !parseSettingsHash().tab)
  const [extraTab, setExtraTab] = useState<string | null>(null)
  const stackedValues = useStackedTabValues(stacked && showList, stackedValuesEpoch)
  // 子 tab 初值直接从 hash 取（惰性初始化，不走 effect）
  const [monitorSubTab, setMonitorSubTab] = useState<MonitorSubTab>(() => {
    const { sub } = parseSettingsHash()
    return sub && MONITOR_SUB_TABS.has(sub) ? (sub as MonitorSubTab) : 'httpLogs'
  })

  useEffect(() => {
    const { tab } = parseSettingsHash()
    if (tab) setActiveSettingsTab(tab as typeof activeSettingsTab)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const tabs: SettingsTab[] = [
    {
      id: 'general',
      group: 'basics',
      label: t('settings.tabGeneral'),
      icon: <Settings size={14} />,
      content: (
        <Scroll>
          <GeneralSettings />
        </Scroll>
      )
    },
    {
      id: 'providers',
      group: 'basics',
      label: t('settings.tabProviders'),
      icon: <Layers size={14} />,
      content: (
        <Scroll>
          <ProviderSettings />
        </Scroll>
      )
    },
    {
      id: 'tools',
      group: 'capabilities',
      label: t('settings.tabTools'),
      icon: <Wrench size={14} />,
      content: <ToolSettings />
    },
    {
      id: 'mcp',
      group: 'capabilities',
      label: t('settings.tabMcp'),
      icon: <Puzzle size={14} />,
      content: (
        <Scroll>
          <McpSettings />
        </Scroll>
      )
    },
    {
      id: 'network',
      group: 'capabilities',
      label: t('settings.tabNetwork'),
      icon: <Globe size={14} />,
      content: (
        <Scroll>
          <NetworkAccessSettings />
        </Scroll>
      )
    },
    {
      id: 'voice',
      group: 'experimental',
      label: t('settings.tabVoice'),
      experimental: 'voice',
      icon: <Mic size={14} />,
      content: (
        <Scroll>
          <VoiceSettings />
        </Scroll>
      )
    },
    {
      id: 'triggers',
      group: 'experimental',
      label: t('settings.tabTriggers'),
      experimental: 'triggers',
      icon: <Timer size={14} />,
      content: (
        <Scroll>
          <TriggerSettings />
        </Scroll>
      )
    },
    {
      id: 'telegramBots',
      group: 'experimental',
      label: t('settings.tabTelegramBots'),
      experimental: 'telegramBots',
      icon: <Send size={14} />,
      content: <TelegramBotsSettings />
    },
    {
      id: 'monitor',
      group: 'maintenance',
      label: t('settings.tabMonitor'),
      icon: <Activity size={14} />,
      content: <MonitorSettings subTab={monitorSubTab} onSubTabChange={setMonitorSubTab} />
    },
    {
      id: 'archived',
      group: 'maintenance',
      label: t('settings.tabArchived'),
      icon: <Archive size={14} />,
      content: <ArchivedSettings />
    },
    {
      id: 'about',
      group: 'about',
      label: t('settings.tabAbout'),
      icon: <Info size={14} />,
      content: (
        <Scroll>
          <AboutSettings
            onViewLog={() => {
              setMonitorSubTab('appLog')
              setActiveSettingsTab('monitor')
            }}
          />
        </Scroll>
      )
    }
  ]

  if (stacked) {
    // 额外的分区：点了名排在谁后面的插到那里，其余排在最后
    const ordered: SettingsTab[] = [...tabs]
    for (const { after, ...tab } of extraTabs) {
      const index = after === undefined ? -1 : ordered.findIndex((entry) => entry.id === after)
      if (index < 0) ordered.push(tab)
      else ordered.splice(index + 1, 0, tab)
    }
    const allTabs = ordered.map((tab) =>
      tab.id in stackedValues ? { ...tab, value: stackedValues[tab.id] } : tab
    )
    return (
      <SettingsContainer
        tabs={allTabs}
        activeTab={extraTab ?? activeSettingsTab}
        onTabChange={(id) => {
          if (extraTabs.some((tab) => tab.id === id)) {
            setExtraTab(id)
          } else {
            setExtraTab(null)
            setActiveSettingsTab(id as typeof activeSettingsTab)
          }
          setShowList(false)
        }}
        title={t('settings.title')}
        stacked={{
          showList,
          onBack: () => setShowList(true),
          onDepthChange: onStackedDepthChange
        }}
      />
    )
  }

  return (
    <SettingsContainer
      tabs={tabs}
      activeTab={activeSettingsTab}
      onTabChange={(id) => setActiveSettingsTab(id as typeof activeSettingsTab)}
      title={t('settings.title')}
      draggableHeader
      macTrafficLights={window.api.app.platform === 'darwin'}
    />
  )
}
