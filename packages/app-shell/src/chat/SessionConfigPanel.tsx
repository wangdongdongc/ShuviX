import {
  CacheBreakConfirmHost,
  getSessionChannelApi,
  refreshSessionTools,
  useSessionKnowledgeBases,
  useSessionTools
} from '@shuvix/chat-ui'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToolItem } from '../common/ToolSelectList'
import { ExtensionsSection } from '../settings/ExtensionsSection'
import { SessionAclSection } from './SessionAclSection'

/** Skills 分组标识（tools.list 的 group） */
const SKILLS_GROUP = '__skills__'

export interface SessionConfigPanelProps {
  sessionId: string
  /** 文件访问一节一开始就把来自会话设置的行也摆出来（会话设置弹窗里是；空会话的欢迎页里收着） */
  aclExpanded?: boolean
}

/**
 * 会话的扩展能力：MCP / Skill 勾选与知识库，与输入框的工具选择器同一份数据、同一个写入口
 * （useSessionTools / useSessionKnowledgeBases）。
 *
 * MCP / Skill 的勾选会话已有运行时也能改（2026-10-26）：后端当场重配那个 agent，会打穿提示词缓存的改动
 * 先问一句（确认框由这里挂的 CacheBreakConfirmHost 画，压在弹窗上面）。知识库一行本来就随时可改：知识库
 * 不进工具表，是 `knowledge` 工具每次调用时现查的；没设过时一个都不勾（缺省就是空的，见
 * sessionBundle.selectedBaseNames），勾一下就固定成这条会话自己的那一份。
 *
 * 弹窗可能开在一条非当前会话上，所以挂载时自己向后端拉一次勾选，不依赖当前会话
 * 的初始化。三组都没有条目时整节不显示（扩展端落在这里：它没有会话级扩展能力，也没有知识库）。
 */
function SessionExtensionsSection({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useTranslation()
  const { enabledTools, setEnabledTools } = useSessionTools(sessionId)
  const knowledge = useSessionKnowledgeBases(sessionId)
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
  if (mcpTools.length === 0 && skillTools.length === 0 && knowledge.options.length === 0) {
    return null
  }

  return (
    <>
      <CacheBreakConfirmHost />
      <ExtensionsSection
        title={t('sessionConfig.extensionsGroup')}
        footer={t('sessionConfig.extensionsDesc')}
        mcpTools={mcpTools}
        skillTools={skillTools}
        enabledTools={enabledTools}
        onChange={(next) => void setEnabledTools(next)}
        knowledge={{
          options: knowledge.options,
          selected: knowledge.selected,
          onToggle: knowledge.toggle,
          hint: knowledge.explicit
            ? t('sessionConfig.knowledgeDesc')
            : t('sessionConfig.knowledgeDefault')
        }}
      />
    </>
  )
}

/**
 * 会话配置面板（除会话标题外的所有配置）。
 *
 * 两节：扩展能力（这条会话的 MCP / Skill 勾选与知识库，随时可改）、文件访问
 * （会话权限表，见 SessionAclSection）。项目指令文件的「读哪些」已整体搬进 agent md 的 `shuvix-instruction-files` 清单
 * （那是 agent 的人格设定，不是每个会话的临时选择），这里不再有对应开关。
 * 既可嵌入到 SessionConfigDialog 弹窗中，也可在空会话时直接居中展示。
 *
 * 视觉：分节标题 + 圆角卡片 + 行式条目（左标题/描述，右控件）。
 *
 * 状态来源：
 * - enabledTools 从 chatStore 的会话设置派生，后端通过 `session.configChanged` 事件触发 store 刷新后自动重渲染；
 * - 知识库选择与权限表各自现取（useSessionKnowledgeBases / SessionAclSection），同一个事件时重取；
 */
export function SessionConfigPanel({
  sessionId,
  aclExpanded = false
}: SessionConfigPanelProps): React.JSX.Element {
  return (
    <div className="space-y-5">
      {/* 扩展能力（含知识库，后者不随 Agent 上锁） */}
      <SessionExtensionsSection sessionId={sessionId} />

      {/* 文件访问：会话权限表 */}
      <SessionAclSection sessionId={sessionId} defaultExpanded={aclExpanded} />
    </div>
  )
}
