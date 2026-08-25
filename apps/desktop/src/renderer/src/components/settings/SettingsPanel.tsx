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
  BookOpen,
  Bot,
  Wrench,
  Send,
  Mic,
  FolderClosed,
  Shield
} from 'lucide-react'
import { SettingsContainer, type SettingsTab } from '@shuvix/app-shell'
import { useSettingsStore } from '../../stores/settingsStore'
import { GeneralSettings } from './GeneralSettings'
import { ProjectsSettings } from './ProjectsSettings'
import { ProviderSettings } from './ProviderSettings'
import { MonitorSettings, MONITOR_SUB_TABS, type MonitorSubTab } from './MonitorSettings'
import { AboutSettings } from './AboutSettings'
import { McpSettings } from './McpSettings'
import { SkillSettings } from './SkillSettings'
import { ToolSettings } from './ToolSettings'
import { AgentSettings } from './AgentSettings'
import { PolicySettings } from './PolicySettings'
import { TelegramBotsSettings } from './TelegramBotsSettings'
import { VoiceSettings } from './VoiceSettings'

const VALID_TABS = new Set([
  'general',
  'projects',
  'providers',
  'agents',
  'policies',
  'tools',
  'mcp',
  'skills',
  'voice',
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

export function SettingsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSettingsTab, setActiveSettingsTab } = useSettingsStore()
  // 子 tab 初值直接从 hash 取（惰性初始化，不走 effect）
  const [monitorSubTab, setMonitorSubTab] = useState<MonitorSubTab>(() => {
    const { sub } = parseSettingsHash()
    return sub && MONITOR_SUB_TABS.has(sub) ? (sub as MonitorSubTab) : 'agents'
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
      id: 'projects',
      label: t('settings.tabProjects'),
      icon: <FolderClosed size={14} />,
      content: <ProjectsSettings />
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
      id: 'agents',
      label: t('settings.tabAgents'),
      icon: <Bot size={14} />,
      content: <AgentSettings />
    },
    {
      id: 'policies',
      label: t('settings.tabPolicies'),
      icon: <Shield size={14} />,
      content: <PolicySettings />
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
      content: <McpSettings />
    },
    {
      id: 'skills',
      label: t('settings.tabSkills'),
      icon: <BookOpen size={14} />,
      content: (
        <Scroll>
          <SkillSettings />
        </Scroll>
      )
    },
    {
      id: 'voice',
      label: t('settings.tabVoice'),
      icon: <Mic size={14} />,
      content: (
        <Scroll>
          <VoiceSettings />
        </Scroll>
      )
    },
    {
      id: 'telegramBots',
      label: t('settings.tabTelegramBots'),
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
      id: 'about',
      label: t('settings.tabAbout'),
      icon: <Info size={14} />,
      content: (
        <Scroll>
          <AboutSettings />
        </Scroll>
      )
    }
  ]

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
