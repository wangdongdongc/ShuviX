/**
 * 自动审查开关（设置 → 通用 → 安全）—— 询问卡片弹出之前，先由审查 agent 替用户回答
 * （设计稿 docs/permission-review-design.md §11）。
 *
 * 开关是主进程现读的 `security.autoReview`：缺省开，只有字面 'false' 才关（与 sandbox.enabled 同一
 * 约定），下一次询问即生效，不必新开会话。审查员的规则本身是两份 md —— 侧栏「智能体」里的
 * 权限审查员、「Hooks」里的自动审查 —— 说明里点名它们，这里不另开入口。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsRow, SettingsSection, Toggle } from './SettingsPrimitives'

const AUTO_REVIEW_KEY = 'security.autoReview'

export function AutoReviewSettings(): React.JSX.Element {
  const { t } = useTranslation()
  // 读到之前按缺省（开）画，免得开关先闪一下「关」
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    let alive = true
    void window.api.settings.get(AUTO_REVIEW_KEY).then((value: string | undefined) => {
      if (alive) setEnabled(value?.trim() !== 'false')
    })
    return () => {
      alive = false
    }
  }, [])

  const toggle = (): void => {
    const next = !enabled
    setEnabled(next)
    void window.api.settings.set({ key: AUTO_REVIEW_KEY, value: String(next) })
  }

  return (
    <div className="mt-4" data-auto-review-settings>
      <SettingsSection title={t('settings.securitySection')}>
        <SettingsRow
          title={t('settings.autoReview')}
          description={t('settings.autoReviewHint')}
          control={<Toggle on={enabled} onClick={toggle} />}
        />
      </SettingsSection>
    </div>
  )
}
