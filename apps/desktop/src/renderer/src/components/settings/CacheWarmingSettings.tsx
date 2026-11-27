/**
 * Prompt Cache 后台保活实验开关（设置 → 通用）：
 *  - `session.cacheWarming`：`'true'` 时在长对话等待慢工具、审批卡片或用户回复期间，
 *    于缓存 TTL 到期前静默发 1-token 续期请求（仅在预期净省 ≥ $0.05 时触发；缺省关）。
 *
 * 开关由主进程在每次请求完成时现读，改动对下一次模型请求立即生效。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExperimentalTag } from '@shuvix/app-shell'
import { SettingsRow, SettingsSection, Toggle } from './SettingsPrimitives'

const ENABLED_KEY = 'session.cacheWarming'

export function CacheWarmingSettings(): React.JSX.Element | null {
  const { t } = useTranslation()
  // 读到之前不画：避免开关先闪一下默认态再跳成真实值
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.settings
      .get(ENABLED_KEY)
      .then((raw) => {
        if (alive) setEnabled(raw === 'true')
      })
      .catch(() => {
        if (alive) setEnabled(false)
      })
    return () => {
      alive = false
    }
  }, [])

  if (enabled === null) return null

  const toggle = (): void => {
    const next = !enabled
    setEnabled(next)
    void window.api.settings.set({ key: ENABLED_KEY, value: String(next) })
  }

  return (
    <div className="px-5 pb-5" data-cache-warming-settings>
      <SettingsSection
        title={
          <span className="inline-flex items-center gap-1.5">
            {t('settings.cacheWarmingSection')}
            <ExperimentalTag feature="cacheWarming" />
          </span>
        }
        description={t('settings.cacheWarmingSectionHint')}
      >
        <div data-cache-warming-row="enabled">
          <SettingsRow
            title={t('settings.cacheWarmingEnabled')}
            description={t('settings.cacheWarmingEnabledHint')}
            control={<Toggle on={enabled} onClick={toggle} />}
          />
        </div>
      </SettingsSection>
    </div>
  )
}
