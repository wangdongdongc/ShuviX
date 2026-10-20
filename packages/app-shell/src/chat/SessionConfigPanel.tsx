import {
  getChatApi,
  getSessionChannelApi,
  refreshSessionTools,
  useAppEvent,
  useSessionTools
} from '@shuvix/chat-ui'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { KnowledgeBaseOptionsResult } from '@shuvix/chat-protocol/chatApi'
import type { ToolItem } from '../common/ToolSelectList'
import { ExtensionsSection } from '../settings/ExtensionsSection'
import { KnowledgeBasesSection } from '../settings/KnowledgeBasesSection'
import { SessionAclSection } from './SessionAclSection'

/** Skills 分组标识（tools.list 的 group） */
const SKILLS_GROUP = '__skills__'

export interface SessionConfigPanelProps {
  sessionId: string
  /** 文件访问一节一开始就把来自会话设置的行也摆出来（会话设置弹窗里是；空会话的欢迎页里收着） */
  aclExpanded?: boolean
}

/**
 * 会话的扩展能力勾选 —— 与输入框的工具选择器同一份数据、同一个写入口（useSessionTools）。
 *
 * 勾选只在创建 Agent 时读一次：会话已有运行时就只读 —— 整排条目按禁用态画、组名挂锁，
 * 原因只在悬停时说，不另起一行文字。弹窗可能开在一条
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

  return (
    <ExtensionsSection
      title={t('sessionConfig.extensionsGroup')}
      footer={t('sessionConfig.extensionsDesc')}
      mcpTools={mcpTools}
      skillTools={skillTools}
      enabledTools={enabledTools}
      onChange={(next) => void setEnabledTools(next)}
      readonly={locked}
      readonlyHint={t('sessionConfig.extensionsLocked')}
    />
  )
}

/**
 * 这条会话用哪几个知识库 —— 与扩展能力并排，但**不随 Agent 上锁**：知识库不进工具表，是
 * `knowledge` 工具每次调用时现查的，改完下一次调用就作数。
 *
 * 没设过时**一个都不勾**（缺省就是空的，见 sessionBundle.selectedBaseNames），勾一下就固定成这条
 * 会话自己的那一份。
 * 宿主没有知识库（扩展端）或一个候选都没有时整节不显示。
 */
function SessionKnowledgeBasesSection({
  sessionId
}: {
  sessionId: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<KnowledgeBaseOptionsResult | null>(null)

  const load = useCallback((): void => {
    void getChatApi().knowledge?.baseOptions({ sessionId }).then(setState)
  }, [sessionId])

  useEffect(load, [load])
  // 面板开着的时候就地建了一个库（侧栏的「新建知识库」）—— 候选项跟着长出来，不用关掉再开
  useAppEvent('knowledge.changed', load)

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
 * 三节：扩展能力（这条会话的 MCP / Skill 勾选，Agent 创建之前可改）、知识库、文件访问（会话权限表，见
 * SessionAclSection）。项目指令文件的「读哪些」已整体搬进 agent md 的 `shuvix-instruction-files` 清单
 * （那是 agent 的人格设定，不是每个会话的临时选择），这里不再有对应开关。
 * 既可嵌入到 SessionConfigDialog 弹窗中，也可在空会话时直接居中展示。
 *
 * 视觉：分节标题 + 圆角卡片 + 行式条目（左标题/描述，右控件）。
 *
 * 状态来源：
 * - enabledTools 从 chatStore 的会话设置派生，后端通过 `session.configChanged` 事件触发 store 刷新后自动重渲染；
 * - 权限表由 SessionAclSection 自己现取，同一个事件时重取；
 * - 扩展能力的只读态来自 `agent_created` / `agent_closing` 事件（见 useSessionTools）。
 */
export function SessionConfigPanel({
  sessionId,
  aclExpanded = false
}: SessionConfigPanelProps): React.JSX.Element {
  return (
    <div className="space-y-5">
      {/* 扩展能力 */}
      <SessionExtensionsSection sessionId={sessionId} />

      {/* 知识库（不随 Agent 上锁） */}
      <SessionKnowledgeBasesSection sessionId={sessionId} />

      {/* 文件访问：会话权限表 */}
      <SessionAclSection sessionId={sessionId} defaultExpanded={aclExpanded} />
    </div>
  )
}
