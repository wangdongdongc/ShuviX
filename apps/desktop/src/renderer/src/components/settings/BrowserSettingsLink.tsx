import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { SettingsSection, SettingsRow } from './SettingsPrimitives'

/**
 * MCP 设置里内置 `browser` 那一行的展开区：浏览器的设置（搜索引擎、网站数据、证书）2026-10-16 搬进了
 * 浏览器窗口自己的设置页（shuvix://settings，照 Chrome 的 chrome://settings）—— 它们讲的是浏览器本身，
 * 不是 agent 的能力。这里只留一个入口：开浏览器窗口并打开设置页。
 */
export function BrowserSettingsLink(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex-1 px-5 py-5" data-browser-settings-link>
      <SettingsSection title={t('settings.toolBrowserMovedTitle')}>
        <SettingsRow
          title={t('settings.toolBrowserMovedRow')}
          description={t('settings.toolBrowserMovedDesc')}
          control={
            <button
              onClick={() => void window.api.browserView.openSettings()}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-text-secondary border border-border-secondary/60 hover:bg-bg-hover/50 transition-colors"
              data-open-browser-settings
            >
              <ExternalLink size={11} />
              {t('settings.toolBrowserMovedOpen')}
            </button>
          }
        />
      </SettingsSection>
    </div>
  )
}
