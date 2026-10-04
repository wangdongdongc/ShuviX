/**
 * 人设（persona）—— 系统提示词的第一段：agent 档案的 md 正文，`{{shuvix:*}}` 占位符经宿主变量表替换。
 *
 * **它在创建 agent 时冻结**（裁决：Mapping #5 prompt）。正文里的日期、平台、shell、工作目录都是
 * 环境波动 —— 每次请求现算会让日期一跨天就整段重发、打穿提供商的提示词缓存。所以变量表只在
 * 创建 agent 那一刻求值一次，结果写进对话文档 `AgentStateDoc.persona`，persona 段落此后只读它。
 * 跨天这类时间线事件走另一条通道（日期通知条目，见 `dateNotice.ts`），不碰系统提示词。
 *
 * 用法（P1-09 的锁）：先在提交外算好（`computeFrozenAgentPrompt` —— 变量表可能做 I/O，提交体里
 * 不该等它），再在上锁的同一个提交里 `freezePersona(tx, conversationId, frozen)`。销毁 agent 之后
 * 重新创建 = 重新冻结，persona 段落在下一次请求里作为增量重发。
 *
 * 文本口径与旧 `renderProfileSystemPrompt` 逐字节一致：替换 → 整段 `\n{3,}` 收敛成 `\n\n` → trim
 * （P1-00 黄金 fixture 的 `persona` 段即由此对照）。
 */
import type { Context } from '@earendil-works/chord'
import type { ConversationId, DocumentReader, Tx } from '@earendil-works/pi-durable'
import {
  renderProfileSystemPrompt,
  type AgentKind,
  type PromptVars,
  type PromptVarsCtx
} from '../../agentProfile/promptVars'
import type { InProcessAgentType } from '../../subagent/types'
import type { RuntimeLogger } from '../../types'
import { AgentStateDoc } from '../docs'

/** 渲染人设：档案正文 + 变量表（`renderProfileSystemPrompt` 同一口径） */
export function renderPersona(
  profile: Pick<InProcessAgentType, 'systemPrompt'>,
  vars: PromptVars,
  logger?: RuntimeLogger
): string {
  return renderProfileSystemPrompt(profile, vars, logger)
}

/** 冻结时要用到的宿主 seam（`AgentSpecHost` 的子集） */
export interface PersonaHost {
  promptVars: (ctx: PromptVarsCtx) => PromptVars | Promise<PromptVars>
  logger?: RuntimeLogger
}

/** 冻结的输入：这个 agent 是谁（`AgentSpec` + 创建参数里的 cwd 就够） */
export interface PersonaInput {
  kind: AgentKind
  /** root = 会话 id；spawned = agentId */
  sessionId: string
  /** 活段落解析所对着的根会话（root = 自身） */
  rootSessionId: string
  /** 变量表的工作目录（root = 会话工作目录；spawned = ''） */
  cwd: string
  /** 归一后的工具名单 —— 变量表据此决定提哪些能力（与工具解析同一份） */
  toolNames: readonly string[]
  profile: Pick<InProcessAgentType, 'name' | 'systemPrompt' | 'instructionFiles'>
}

/** 冻结进 `AgentStateDoc` 的那几项：人设正文与活段落要用到的 agent 身份 */
export interface FrozenAgentPrompt {
  kind: AgentKind
  profileName: string
  rootSessionId: string
  persona: string
  instructionFiles: readonly string[]
}

/** 现算变量表、渲染人设，打包成待冻结的记录（在提交之外调用） */
export async function computeFrozenAgentPrompt(
  host: PersonaHost,
  input: PersonaInput
): Promise<FrozenAgentPrompt> {
  const vars = await host.promptVars({
    sessionId: input.sessionId,
    kind: input.kind,
    cwd: input.cwd,
    toolNames: input.toolNames
  })
  return {
    kind: input.kind,
    profileName: input.profile.name,
    rootSessionId: input.rootSessionId,
    persona: renderPersona(input.profile, vars, host.logger),
    instructionFiles: [...(input.profile.instructionFiles ?? [])]
  }
}

/**
 * 在调用方的提交里把人设与 agent 身份写进该对话的 `AgentStateDoc`（P1-09 在上锁的同一个提交里调用）。
 * 其余字段（`lastAnnouncedDate` 等）原样保留。
 */
export async function freezePersona(
  tx: Tx,
  conversationId: ConversationId,
  frozen: FrozenAgentPrompt
): Promise<void> {
  const state = await tx.doc(AgentStateDoc, conversationId)
  state.kind = frozen.kind
  state.profileName = frozen.profileName
  state.rootSessionId = frozen.rootSessionId
  state.persona = frozen.persona
  state.instructionFiles = [...frozen.instructionFiles]
}

/** 读一个对话已冻结的人设（没冻结 → undefined） */
export async function frozenPersonaOf(
  read: DocumentReader,
  conversationId: ConversationId,
  context: Context
): Promise<string | undefined> {
  return (await read.snapshot(AgentStateDoc, conversationId, context))?.persona
}
