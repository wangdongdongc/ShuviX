/**
 * 命令沙箱开关（设置 → LLM 工具 → bash 子页，经 BuiltinToolsView 的 renderToolExtra 挂在
 * 工具卡片下面）。只在平台有后端时出现（今天只有 macOS）。
 *
 * 开关是主进程现读的 `sandbox.enabled`，但生效单位是**会话运行时**：bash 工具构造时按会话固定
 * 「套不套沙箱」（工具参数与说明随之而定），所以改动对新建的对话生效 —— 行尾的提示说的就是这个。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsRow, SettingsSection, Toggle } from './SettingsPrimitives'

const ENABLED_KEY = 'sandbox.enabled'

type SandboxStatus = Awaited<ReturnType<typeof window.api.settings.sandboxStatus>>

export function SandboxSettings(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [status, setStatus] = useState<SandboxStatus | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.settings.sandboxStatus().then((next) => {
      if (alive) setStatus(next)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!status?.supported) return null

  const toggle = (): void => {
    const next = !status.enabled
    setStatus({ ...status, enabled: next })
    void window.api.settings.set({ key: ENABLED_KEY, value: String(next) })
  }

  // 原因来自 sandbox-exec 的 stderr：拼接而不是插值（i18next 的 {{var}} 会被值里的占位符劫持）
  const subtitle = status.available
    ? t('settings.sandboxAvailable')
    : t('settings.sandboxUnavailable') + (status.reason ?? '')

  return (
    <div className="mt-4" data-sandbox-settings>
      <SettingsSection
        title={t('settings.sandboxSection')}
        description={t('settings.sandboxSectionHint')}
      >
        <SettingsRow
          title={t('settings.sandboxEnabled')}
          description={t('settings.sandboxEnabledHint')}
          subtitle={subtitle}
          control={<Toggle on={status.enabled} onClick={toggle} disabled={!status.available} />}
        />
      </SettingsSection>
    </div>
  )
}
