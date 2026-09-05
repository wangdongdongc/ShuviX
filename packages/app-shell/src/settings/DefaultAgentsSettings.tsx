/**
 * DefaultAgentsSettings —— 通用设置里的「默认智能体」配置（桌面/扩展单一来源）。
 *
 * 两个选择器对应两种会话形态：归属项目的新会话从「默认项目智能体」起步（缺省 `default`
 * ——确认需求、把具体的活儿交给 coding 子会话、验收结果），不归属任何项目的新会话从
 * 「默认聊天智能体」起步（缺省 `chat` ——握全套内置工具、自己把活干完）。
 *
 * 只影响**新会话**：档案在会话创建那一刻定型并写进会话设置，之后由输入框的档案选择器
 * （`/<agentName>`）接管。改这里不会动任何已存在的会话——档案是粘性的。
 *
 * 候选来自宿主的「可切换档案」列表（与输入框选择器同源：声明了会话感知的档案 +
 * default / chat 两个基座）。档案是纯 md 驱动的，用户随时可能删掉一份：存着的值不在
 * 列表里时保留成一个额外选项如实显示，而不是静默改选别的——后端遇到这种值会回落基座。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProfileSummary } from '@shuvix/chat-protocol/chatApi'
import {
  CHAT_PROFILE_NAME,
  DEFAULT_CHAT_AGENT_KEY,
  DEFAULT_PROFILE_NAME,
  DEFAULT_PROJECT_AGENT_KEY
} from '@shuvix/chat-protocol/agentProfile'
import { SettingsSection, SettingsRow, InlineSelect } from './SettingsPrimitives'

export interface DefaultAgentsSettingsProps {
  /** 可切换的会话档案（宿主 `session.listAgentProfiles`） */
  loadProfiles: () => Promise<AgentProfileSummary[]>
  /** 读设置值（宿主 `settings.get`） */
  getSetting: (key: string) => Promise<string | undefined>
  /** 写设置值（宿主 `settings.set`） */
  setSetting: (key: string, value: string) => void
}

export function DefaultAgentsSettings({
  loadProfiles,
  getSetting,
  setSetting
}: DefaultAgentsSettingsProps): React.JSX.Element {
  const { t } = useTranslation()
  const [profiles, setProfiles] = useState<AgentProfileSummary[]>([])
  const [values, setValues] = useState({
    project: DEFAULT_PROFILE_NAME,
    chat: CHAT_PROFILE_NAME
  })

  useEffect(() => {
    void loadProfiles().then(setProfiles)
    void Promise.all([
      getSetting(DEFAULT_PROJECT_AGENT_KEY),
      getSetting(DEFAULT_CHAT_AGENT_KEY)
    ]).then(([project, chat]) =>
      setValues({
        project: project?.trim() || DEFAULT_PROFILE_NAME,
        chat: chat?.trim() || CHAT_PROFILE_NAME
      })
    )
  }, [loadProfiles, getSetting])

  const pick = useCallback(
    (which: 'project' | 'chat', name: string): void => {
      setValues((v) => ({ ...v, [which]: name }))
      setSetting(which === 'project' ? DEFAULT_PROJECT_AGENT_KEY : DEFAULT_CHAT_AGENT_KEY, name)
    },
    [setSetting]
  )

  /** 选项：可切换档案；存着的值已不在列表里时(档案被删)补一条同名项如实显示 */
  const options = (current: string): React.JSX.Element[] => {
    const rows = profiles.some((p) => p.name === current)
      ? profiles
      : [{ name: current, displayName: current } as AgentProfileSummary, ...profiles]
    return rows.map((p) => (
      <option key={p.name} value={p.name}>
        {p.displayName || p.name}
      </option>
    ))
  }

  return (
    <div className="px-5 pb-5 space-y-5">
      <SettingsSection
        title={t('settings.defaultAgentGroup')}
        description={t('settings.defaultAgentGroupDesc')}
      >
        <SettingsRow
          title={t('settings.defaultProjectAgentRow')}
          description={t('settings.defaultProjectAgentDesc')}
          control={
            <InlineSelect value={values.project} onChange={(v) => pick('project', v)}>
              {options(values.project)}
            </InlineSelect>
          }
        />
        <SettingsRow
          title={t('settings.defaultChatAgentRow')}
          description={t('settings.defaultChatAgentDesc')}
          control={
            <InlineSelect value={values.chat} onChange={(v) => pick('chat', v)}>
              {options(values.chat)}
            </InlineSelect>
          }
        />
      </SettingsSection>
    </div>
  )
}
