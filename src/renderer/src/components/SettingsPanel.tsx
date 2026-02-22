import { useTranslation } from 'react-i18next'
import { Settings, Layers, FileText, Info } from 'lucide-react'
import { useSettingsStore } from '../stores/settingsStore'
import { TabButton } from './settings/TabButton'
import { GeneralSettings } from './settings/GeneralSettings'
import { ProviderSettings } from './settings/ProviderSettings'
import { HttpLogSettings } from './settings/HttpLogSettings'
import { AboutSettings } from './settings/AboutSettings'

/**
 * 设置面板 — 独立窗口（分组 Tab）
 * 通用设置 + 提供商管理 + HTTP 日志
 */
export function SettingsPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { activeSettingsTab, setActiveSettingsTab } = useSettingsStore()

  return (
    <div className="h-full bg-bg-primary flex flex-col">
      {/* 头部拖拽区（macOS 为交通灯留出顶部空间） */}
      <div className={`titlebar-drag flex items-center px-6 pb-4 border-b border-border-secondary bg-bg-secondary ${window.api.app.platform === 'darwin' ? 'pt-10' : 'pt-4'}`}>
        <h2 className="text-base font-semibold text-text-primary">{t('settings.title')}</h2>
      </div>

      {/* Tab + 内容 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧导航 */}
        <div className="w-[180px] flex-shrink-0 border-r border-border-secondary py-4 px-3 space-y-1 bg-bg-secondary">
          <TabButton
            icon={<Settings size={14} />}
            label={t('settings.tabGeneral')}
            active={activeSettingsTab === 'general'}
            onClick={() => setActiveSettingsTab('general')}
          />
          <TabButton
            icon={<Layers size={14} />}
            label={t('settings.tabProviders')}
            active={activeSettingsTab === 'providers'}
            onClick={() => setActiveSettingsTab('providers')}
          />
          <TabButton
            icon={<FileText size={14} />}
            label={t('settings.tabHttpLogs')}
            active={activeSettingsTab === 'httpLogs'}
            onClick={() => setActiveSettingsTab('httpLogs')}
          />
          <TabButton
            icon={<Info size={14} />}
            label={t('settings.tabAbout')}
            active={activeSettingsTab === 'about'}
            onClick={() => setActiveSettingsTab('about')}
          />
        </div>

        {/* 右侧内容区 */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {activeSettingsTab === 'general' && <GeneralSettings />}
          {activeSettingsTab === 'providers' && <ProviderSettings />}
          {activeSettingsTab === 'httpLogs' && <HttpLogSettings />}
          {activeSettingsTab === 'about' && <AboutSettings />}
        </div>
      </div>
    </div>
  )
}
