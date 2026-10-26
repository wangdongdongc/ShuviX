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
  Timer
} from 'lucide-react'
import { SettingsContainer, type SettingsTab } from '@shuvix/app-shell'
import { useSettingsStore } from '../../stores/settingsStore'
import { GeneralSettings } from './GeneralSettings'
import { ArchivedSettings } from './ArchivedSettings'
import { ProviderSettings } from './ProviderSettings'
import { MonitorSettings, MONITOR_SUB_TABS, type MonitorSubTab } from './MonitorSettings'
import { AboutSettings } from './AboutSettings'
import { McpSettings } from './McpSettings'
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
  extraTabs?: SettingsTab[]
}

export function SettingsPanel({
  stacked = false,
  extraTabs = []
}: SettingsPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSettingsTab, setActiveSettingsTab } = useSettingsStore()
  /** 叠放布局里此刻显示的是分区列表（hash 点名了某个分区就直接进去） */
  const [showList, setShowList] = useState(() => !parseSettingsHash().tab)
  const [extraTab, setExtraTab] = useState<string | null>(null)
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
      label: t('settings.tabTools'),
      icon: <Wrench size={14} />,
      content: <ToolSettings />
    },
    {
      id: 'mcp',
      label: t('settings.tabMcp'),
      icon: <Puzzle size={14} />,
      content: (
        <Scroll>
          <McpSettings />
        </Scroll>
      )
    },
    {
      id: 'voice',
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
      label: t('settings.tabTelegramBots'),
      experimental: 'telegramBots',
      icon: <Send size={14} />,
      content: <TelegramBotsSettings />
    },
    {
      id: 'monitor',
      label: t('settings.tabMonitor'),
      icon: <Activity size={14} />,
      content: <MonitorSettings subTab={monitorSubTab} onSubTabChange={setMonitorSubTab} />
    },
    {
      id: 'archived',
      label: t('settings.tabArchived'),
      icon: <Archive size={14} />,
      content: <ArchivedSettings />
    },
    {
      id: 'about',
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
    const allTabs = [...tabs, ...extraTabs]
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
        stacked={{ showList, onBack: () => setShowList(true) }}
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
