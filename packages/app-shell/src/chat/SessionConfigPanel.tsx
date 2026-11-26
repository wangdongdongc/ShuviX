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

export interface SessionConfigPanelProps {
  sessionId: string
  /** 文件访问一节一开始就把来自会话设置的行也摆出来（会话设置弹窗里是；空会话的欢迎页里收着） */
  aclExpanded?: boolean
  /**
   * 只画其中一段（手机布局的会话详情页：每一段各是一页）—— `extensions` = MCP 勾选，`knowledge` = 知识库，
   * `paths` / `sessions` / `widgets` = 权限表的那一种行。缺省 = 整份面板（桌面的弹窗与空会话页）
   */
  section?: SessionConfigSection
}

/** 会话配置里可以单独成页的各段（见 SessionConfigPanelProps.section） */
export type SessionConfigSection = 'extensions' | 'knowledge' | 'paths' | 'sessions' | 'widgets'

/**
 * 会话的扩展能力：MCP 勾选与知识库，与输入框的工具选择器同一份数据、同一个写入口
 * （useSessionTools / useSessionKnowledgeBases）。技能不按会话勾选（2026-10-28）。
 *
 * MCP 的勾选会话已有运行时也能改（2026-10-26）：后端当场重配那个 agent，会打穿提示词缓存的改动
 * 先问一句（确认框由这里挂的 CacheBreakConfirmHost 画，压在弹窗上面）。知识库一行本来就随时可改：知识库
 * 不进工具表，是 `knowledge` 工具每次调用时现查的；没设过时只勾着内置说明书（缺省，见
 * sessionBundle.selectedBaseNames），勾一下就固定成这条会话自己的那一份。
 *
 * 弹窗可能开在一条非当前会话上，所以挂载时自己向后端拉一次勾选，不依赖当前会话
 * 的初始化。两组都没有条目时整节不显示（扩展端落在这里：它没有会话级扩展能力，也没有知识库）。
 */
export function SessionExtensionsSection({
  sessionId,
  only,
  hideTitle = false
}: {
  sessionId: string
  only?: 'mcp' | 'knowledge'
  /** 独立 Tab 页中隐藏卡片标题，避免与 Tab 标签重复 */
  hideTitle?: boolean
}): React.JSX.Element | null {
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
  if (mcpTools.length === 0 && knowledge.options.length === 0) {
    return null
  }
  if (only === 'mcp' && mcpTools.length === 0) return null
  if (only === 'knowledge' && knowledge.options.length === 0) return null

  return (
    <>
      <CacheBreakConfirmHost />
      <ExtensionsSection
        only={only}
        title={
          hideTitle
            ? undefined
            : only === 'knowledge'
              ? t('sessionConfig.knowledgeGroup')
              : t('sessionConfig.extensionsGroup')
        }
        // 只画知识库那一行时不带 MCP 的那段说明
        footer={only === 'knowledge' ? undefined : t('sessionConfig.extensionsDesc')}
        mcpTools={mcpTools}
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
 * 两节：扩展能力（这条会话的 MCP 勾选与知识库，随时可改）、文件访问
 * （会话权限表，见 SessionAclSection）。项目指令文件的「读哪些」已整体搬进 agent md 的 `shuvix-prompt-blocks`（`agents_md` / `claude_md`）
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
  aclExpanded = false,
  section
}: SessionConfigPanelProps): React.JSX.Element {
  if (section === 'extensions' || section === 'knowledge') {
    return (
      <SessionExtensionsSection
        sessionId={sessionId}
        only={section === 'knowledge' ? 'knowledge' : 'mcp'}
      />
    )
  }
  if (section) {
    return <SessionAclSection sessionId={sessionId} defaultExpanded only={section} />
  }
  return (
    <div className="space-y-5">
      {/* 扩展能力（含知识库，后者不随 Agent 上锁） */}
      <SessionExtensionsSection sessionId={sessionId} />

      {/* 文件访问：会话权限表 */}
      <SessionAclSection sessionId={sessionId} defaultExpanded={aclExpanded} />
    </div>
  )
}
