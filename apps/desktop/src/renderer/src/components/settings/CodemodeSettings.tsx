/**
 * 代码模式实验开关（设置 → 通用）：
 *  - `session.codemode`：为新创建的 root agent 启用持久化 QuickJS 代码模式（Phase 1，缺省关）
 *  - `session.codemodeMcpOnly`：启用代码模式时，将 MCP 工具标为 `callers: ['tools']`，仅在代码模式内通过
 *    `tools.*` 调用，不注入模型原生工具 Schema（Phase 2，缺省关）
 *
 * 两个开关均由主进程在创建 agent 时现读并钉进锁记录，改动对新建的对话或重建的智能体生效。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExperimentalTag } from '@shuvix/app-shell'
import { SettingsRow, SettingsSection, Toggle } from './SettingsPrimitives'

const ENABLED_KEY = 'session.codemode'
const MCP_ONLY_KEY = 'session.codemodeMcpOnly'

export function CodemodeSettings(): React.JSX.Element | null {
  const { t } = useTranslation()
  // 读到之前不画：避免开关先闪一下默认态再跳成真实值
  const [state, setState] = useState<{ enabled: boolean; mcpOnly: boolean } | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([window.api.settings.get(ENABLED_KEY), window.api.settings.get(MCP_ONLY_KEY)])
      .then(([enabledRaw, mcpOnlyRaw]) => {
        if (!alive) return
        setState({
          enabled: enabledRaw === 'true',
          mcpOnly: mcpOnlyRaw === 'true'
        })
      })
      .catch(() => {
        if (alive) setState({ enabled: false, mcpOnly: false })
      })
    return () => {
      alive = false
    }
  }, [])

  if (!state) return null

  const toggleEnabled = (): void => {
    const next = !state.enabled
    setState({ ...state, enabled: next })
    void window.api.settings.set({ key: ENABLED_KEY, value: String(next) })
  }

  const toggleMcpOnly = (): void => {
    const next = !state.mcpOnly
    setState({ ...state, mcpOnly: next })
    void window.api.settings.set({ key: MCP_ONLY_KEY, value: String(next) })
  }

  return (
    <div className="px-5 pb-5" data-codemode-settings>
      <SettingsSection
        title={
          <span className="inline-flex items-center gap-1.5">
            {t('settings.codemodeSection')}
            <ExperimentalTag feature="codemode" />
          </span>
        }
        description={t('settings.codemodeSectionHint')}
      >
        <div data-codemode-row="enabled">
          <SettingsRow
            title={t('settings.codemodeEnabled')}
            description={t('settings.codemodeEnabledHint')}
            control={<Toggle on={state.enabled} onClick={toggleEnabled} />}
          />
        </div>
        {state.enabled && (
          <div data-codemode-row="mcpOnly">
            <SettingsRow
              title={t('settings.codemodeMcpOnly')}
              description={t('settings.codemodeMcpOnlyHint')}
              control={<Toggle on={state.mcpOnly} onClick={toggleMcpOnly} />}
            />
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
