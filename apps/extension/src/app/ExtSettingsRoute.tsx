import { useTranslation } from 'react-i18next'
import { Settings, ArrowLeft, Layers, Puzzle, Info, Brain } from 'lucide-react'
import { ChatHostProvider, getChatApi } from '@shuvix/chat-ui'
import {
  SettingsContainer,
  AboutTab,
  McpClientPanel,
  ContextManagementSettings,
  type SettingsTab
} from '@shuvix/app-shell'
import { ExtAppearanceTab } from './settings/ExtAppearanceTab'
import { ExtProviderTab } from './settings/ExtProviderTab'

type ChatHostValue = React.ComponentProps<typeof ChatHostProvider>['value']

/**
 * 扩展设置路由（#settings）—— 对齐桌面 SettingsPanel：注入式 SettingsContainer + 共享 tab。
 * tab 内容全部复用 @shuvix/app-shell 共享组件，仅绑定层（ExtAppearanceTab / ExtProviderTab）落本地。
 */
export function ExtSettingsRoute({
  host,
  route
}: {
  host: ChatHostValue
  route: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const tabs: SettingsTab[] = [
    {
      id: 'appearance',
      label: t('settings.tabGeneral'),
      icon: <Settings size={14} />,
      content: (
        <div className="flex-1 overflow-y-auto">
          <ExtAppearanceTab />
        </div>
      )
    },
    {
      id: 'providers',
      label: t('settings.tabProviders'),
      icon: <Layers size={14} />,
      content: <ExtProviderTab />
    },
    {
      id: 'contextMgmt',
      label: t('settings.tabContextMgmt'),
      icon: <Brain size={14} />,
      // 复用共享上下文管理（系统提示词卡片）；后端经 chatApiAdapter.settings → systemPromptStore
      content: <ContextManagementSettings />
    },
    {
      id: 'mcp',
      label: t('settings.tabMcp'),
      icon: <Puzzle size={14} />,
      content: (
        <div className="flex-1 overflow-y-auto">
          {/* 扩展仅 http（浏览器无法跑本地进程）→ allowStdio:false */}
          <McpClientPanel api={getChatApi().mcp} caps={{ allowStdio: false }} />
        </div>
      )
    },
    {
      id: 'about',
      label: t('settings.tabAbout'),
      icon: <Info size={14} />,
      content: (
        <div className="flex-1 overflow-y-auto">
          {/* 复用共享 AboutTab；扩展不注入 update → 屏蔽自动更新，其余与桌面完全一致 */}
          <AboutTab
            appVersion={chrome.runtime.getManifest().version}
            openExternal={(url) => window.open(url, '_blank', 'noopener')}
          />
        </div>
      )
    }
  ]
  const activeTab = route.replace(/^#settings\/?/, '') || 'appearance'
  return (
    <ChatHostProvider value={host}>
      <div className="h-full flex flex-col bg-bg-primary text-text-primary">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-secondary bg-bg-secondary">
          <button
            onClick={() => {
              window.location.hash = ''
            }}
            className="p-1 rounded hover:bg-bg-hover text-text-secondary hover:text-text-primary"
          >
            <ArrowLeft size={16} />
          </button>
          <span className="text-sm font-medium">{t('settings.title')}</span>
        </div>
        <div className="flex-1 min-h-0">
          <SettingsContainer
            tabs={tabs}
            activeTab={tabs.some((x) => x.id === activeTab) ? activeTab : 'appearance'}
            onTabChange={(id) => {
              window.location.hash = `#settings/${id}`
            }}
            title={t('settings.title')}
          />
        </div>
      </div>
    </ChatHostProvider>
  )
}
