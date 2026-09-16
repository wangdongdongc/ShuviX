import {
  getChatApi,
  getSessionChannelApi,
  refreshSessionTools,
  useChatStore,
  useSessionTools
} from '@shuvix/chat-ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert, X } from 'lucide-react'
import type { KnowledgeBaseOptionsResult } from '@shuvix/chat-protocol/chatApi'
import type { ToolItem } from '../common/ToolSelectList'
import { ExtensionsSection } from '../settings/ExtensionsSection'
import { KnowledgeBasesSection } from '../settings/KnowledgeBasesSection'
import { SettingsSection, SettingsRow, Toggle } from '../settings/SettingsPrimitives'

/** Skills 分组标识（tools.list 的 group） */
const SKILLS_GROUP = '__skills__'

export interface SessionConfigPanelProps {
  sessionId: string
}

/**
 * 会话的扩展能力勾选 —— 与输入框的工具选择器同一份数据、同一个写入口（useSessionTools）。
 *
 * 勾选只在创建 Agent 时读一次：会话已有运行时就只读，卡片下方写明原因。弹窗可能开在一条
 * 非当前会话上，所以挂载时自己向后端拉一次「运行时是否已存在 + 勾选」，不依赖当前会话的初始化。
 * 一个 MCP / skill 都没有时整节不显示（扩展端也落在这里：它没有会话级扩展能力）。
 */
function SessionExtensionsSection({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const { enabledTools, locked, setEnabledTools } = useSessionTools(sessionId)
  const [tools, setTools] = useState<ToolItem[]>([])

  useEffect(() => {
    let alive = true
    void getSessionChannelApi()
      .tools.list(sessionId)
      .then((list) => {
        if (alive) setTools(list)
      })
    void refreshSessionTools(sessionId)
    return () => {
      alive = false
    }
  }, [sessionId])

  const mcpTools = tools.filter((tool) => tool.group?.startsWith('mcp:'))
  const skillTools = tools.filter((tool) => tool.group === SKILLS_GROUP)
  if (mcpTools.length === 0 && skillTools.length === 0) return null

  const toggle = (name: string): void => {
    void setEnabledTools(
      enabledTools.includes(name) ? enabledTools.filter((n) => n !== name) : [...enabledTools, name]
    )
  }

  return (
    <ExtensionsSection
      title={t('sessionConfig.extensionsGroup')}
      footer={locked ? t('sessionConfig.extensionsLocked') : t('sessionConfig.extensionsDesc')}
      mcpTools={mcpTools}
      skillTools={skillTools}
      enabledTools={enabledTools}
      onToggle={toggle}
      readonly={locked}
    />
  )
}

/**
 * 这条会话用哪几个知识库 —— 与扩展能力并排，但**不随 Agent 上锁**：知识库不进工具表，是
 * `knowledge` 工具每次调用时现查的，改完下一次调用就作数。
 *
 * 没设过时勾的是回落出来的缺省（全部用户库 +（属于项目时）项目库），动一下就固定成这条会话自己的。
 * 宿主没有知识库（扩展端）或一个候选都没有时整节不显示。
 */
function SessionKnowledgeBasesSection({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<KnowledgeBaseOptionsResult | null>(null)

  useEffect(() => {
    let alive = true
    void getChatApi()
      .knowledge?.baseOptions({ sessionId })
      .then((r) => {
        if (alive) setState(r)
      })
    return () => {
      alive = false
    }
  }, [sessionId])

  if (!state || state.options.length === 0) return null

  const toggle = (name: string): void => {
    const next = state.selected.includes(name)
      ? state.selected.filter((n) => n !== name)
      : [...state.selected, name]
    // 乐观更新：这条写入没有锁，不会被拒；失败也只是下次打开时回到真实值
    setState({ ...state, selected: next, explicit: true })
    void getChatApi().session.updateKnowledgeBases({ id: sessionId, knowledgeBases: next })
  }

  return (
    <KnowledgeBasesSection
      title={t('sessionConfig.knowledgeGroup')}
      footer={
        state.explicit ? t('sessionConfig.knowledgeDesc') : t('sessionConfig.knowledgeDefault')
      }
      options={state.options}
      selected={state.selected}
      onToggle={toggle}
    />
  )
}

/**
 * 会话配置面板（除会话标题外的所有配置）。
 *
 * 两节：扩展能力（这条会话的 MCP / Skill 勾选，Agent 创建之前可改）与命令询问。项目指令文件的
 * 「读哪些」已整体搬进 agent md 的 `shuvix-instruction-files` 清单（那是 agent 的人格设定，
 * 不是每个会话的临时选择），这里不再有对应开关。
 * 既可嵌入到 SessionConfigDialog 弹窗中，也可在空会话时直接居中展示。
 *
 * 视觉：分节标题 + 圆角卡片 + 行式条目（左标题/描述，右控件）。
 *
 * 状态来源：
 * - autoAllow / allowList / enabledTools 从 chatStore 的会话设置派生，
 *   后端通过 `session.configChanged` 事件触发 store 刷新后自动重渲染；
 * - 扩展能力的只读态来自 `agent_created` / `agent_closing` 事件（见 useSessionTools）。
 */
export function SessionConfigPanel({ sessionId }: SessionConfigPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const session = useChatStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const autoAllow = session?.settings.autoAllow === true
  const allowList = session?.settings.allowList ?? []

  const handleToggleAutoAllow = async (): Promise<void> => {
    const next = !autoAllow
    await getChatApi().session.updateAutoAllow({ id: sessionId, autoAllow: next })
    useChatStore.getState().updateSessionSettings(sessionId, { autoAllow: next })
  }

  /** 允许列表仅含路径条目（`Read(...)`/`Write(...)`）：命令类工具逐条询问，无模式记忆 */
  const handleRemoveAllowEntry = async (entry: string): Promise<void> => {
    await getChatApi().session.removeAllowListEntry({ id: sessionId, entry })
    const next = allowList.filter((e) => e !== entry)
    useChatStore.getState().updateSessionSettings(sessionId, { allowList: next })
  }

  return (
    <div className="space-y-5">
      {/* 扩展能力 */}
      <SessionExtensionsSection sessionId={sessionId} />

      {/* 知识库（不随 Agent 上锁） */}
      <SessionKnowledgeBasesSection sessionId={sessionId} />

      {/* 命令询问 */}
      <SettingsSection title={t('sessionConfig.commandGroup')}>
        <SettingsRow
          title={t('sessionConfig.autoAllow')}
          description={t('sessionConfig.autoAllowDesc')}
          control={
            <Toggle on={autoAllow} color="amber" onClick={() => void handleToggleAutoAllow()} />
          }
        />
        {autoAllow && (
          <div className="flex items-start gap-2 px-4 py-2.5 bg-amber-500/[0.06]">
            <TriangleAlert size={12} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              {t('chat.autoAllowWarning')}
            </p>
          </div>
        )}
        {!autoAllow && allowList.length > 0 && (
          <div className="px-4 py-3">
            <div className="text-[11px] text-text-tertiary mb-1.5">
              {t('sessionConfig.allowListTitle')}
            </div>
            <div className="flex flex-col gap-1">
              {allowList.map((entry) => (
                <div
                  key={entry}
                  title={entry}
                  className="group flex items-center gap-1.5 px-2 py-1 rounded bg-bg-tertiary/60"
                >
                  <span className="flex-1 truncate text-[11px] font-mono text-text-secondary">
                    {entry}
                  </span>
                  <button
                    onClick={() => void handleRemoveAllowEntry(entry)}
                    className="text-text-tertiary hover:text-red-500 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
