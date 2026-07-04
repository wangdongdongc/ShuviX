/**
 * 设置面板（桌面）—— 独立窗口（分组 Tab）。
 * 外壳复用 @shuvix/app-shell 的 SettingsContainer（注入式 tab）；桌面注入全套 tab。
 * activeTab 仍存 settingsStore，并与 `#settings/<tab>` hash 同步。
 */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Settings,
  Layers,
  FileText,
  Info,
  Puzzle,
  BookOpen,
  Wrench,
  Share2,
  Mic,
  Brain,
  Webhook,
  FolderClosed
} from 'lucide-react'
import { SettingsContainer, type SettingsTab } from '@shuvix/app-shell'
import { useSettingsStore } from '../../stores/settingsStore'
import { GeneralSettings } from './GeneralSettings'
import { ProjectsSettings } from './ProjectsSettings'
import { ProviderSettings } from './ProviderSettings'
import { HttpLogSettings } from './HttpLogSettings'
import { AboutSettings } from './AboutSettings'
import { McpSettings } from './McpSettings'
import { SkillSettings } from './SkillSettings'
import { HookSettings } from './HookSettings'
import { ToolSettings } from './ToolSettings'
import { BindingsSettings } from './BindingsSettings'
import { VoiceSettings } from './VoiceSettings'
import { ContextManagementSettings, getChannelBindingCaps } from '@shuvix/app-shell'

const VALID_TABS = new Set([
  'general',
  'projects',
  'providers',
  'tools',
  'mcp',
  'skills',
  'hooks',
  'voice',
  'bindings',
  'contextMgmt',
  'httpLogs',
  'about'
])

/** 内容滚动容器（保留原各 tab 的滚动行为） */
function Scroll({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex-1 overflow-y-auto">{children}</div>
}

export function SettingsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSettingsTab, setActiveSettingsTab } = useSettingsStore()

  useEffect(() => {
    const hash = window.location.hash
    const match = hash.match(/^#settings\/(.+)$/)
    if (match && VALID_TABS.has(match[1])) {
      setActiveSettingsTab(match[1] as typeof activeSettingsTab)
    }
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
      id: 'contextMgmt',
      label: t('settings.tabContextMgmt'),
      icon: <Brain size={14} />,
      content: (
        <Scroll>
          <ContextManagementSettings />
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
      id: 'hooks',
      label: t('settings.tabHooks'),
      icon: <Webhook size={14} />,
      content: <HookSettings />
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
      id: 'bindings',
      label: t('settings.tabBindings'),
      icon: <Share2 size={14} />,
      content: (
        <Scroll>
          <BindingsSettings />
        </Scroll>
      )
    },
    {
      id: 'httpLogs',
      label: t('settings.tabHttpLogs'),
      icon: <FileText size={14} />,
      content: (
        <Scroll>
          <HttpLogSettings />
        </Scroll>
      )
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

  // 「会话绑定」Tab 据当前宿主提供的渠道 API 自动显隐：无任何渠道则整页不出现
  const visibleTabs = getChannelBindingCaps().any
    ? tabs
    : tabs.filter((tab) => tab.id !== 'bindings')

  return (
    <SettingsContainer
      tabs={visibleTabs}
      activeTab={activeSettingsTab}
      onTabChange={(id) => setActiveSettingsTab(id as typeof activeSettingsTab)}
      title={t('settings.title')}
      draggableHeader
      macTrafficLights={window.api.app.platform === 'darwin'}
    />
  )
}
