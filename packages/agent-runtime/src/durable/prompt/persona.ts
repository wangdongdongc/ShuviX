/**
 * 人设（persona）—— 系统提示词的第一段：agent 档案的 md 正文，后面跟着档案点名的提示词块
 * （`document` / `drawing` / `environment`，以及跟着 `tool_search` 走的 `extensions`；见 `agentProfile/promptBlocks.ts`）。
 *
 * **它在创建 agent 时冻结**（裁决：Mapping #5 prompt）。块里的日期、平台、shell、工作目录都是
 * 环境波动 —— 每次请求现算会让日期一跨天就整段重发、打穿提供商的提示词缓存。所以这些块只在
 * 创建 agent 那一刻渲染一次，结果写进对话文档 `AgentStateDoc.persona`，persona 段落此后只读它。
 * 跨天这类时间线事件走另一条通道（日期通知条目，见 `dateNotice.ts`），不碰系统提示词。
 *
 * 用法（P1-09 的锁）：先在提交外算好（`computeFrozenAgentPrompt` —— 渲染块可能做 I/O，提交体里
 * 不该等它），再在上锁的同一个提交里 `freezePersona(tx, conversationId, frozen)`。
 *
 * **根 agent 的系统提示词冻结一次、之后不再自己变**（2026-11-06，用户裁决「历史状态不变」）：锁在重启后空闲时、
 * 回退、fork、芯片上的 X 之后都会重建，重建时对话已经有冻结的人设（以及 `sections.ts` 冻结的其余段落）就原样
 * 沿用（{@link reusableFrozenPrompt}），日期、版本、档案正文、CLAUDE.md 改了都不换 —— 否则在不支持中途 system
 * 消息的模型上，升级一次、跨天重启一次，每条会话都要整段重算历史。冻结时记下 `personaKey`（{@link personaKeyOf}：
 * 档案、正文、工具名单、工作目录、提示词块清单 —— 有意的改动）只为**提醒**：此刻算出的摘要不同，界面
 * 告诉用户「档案改过了」，用户点重建（{@link forgetFrozenPrompt} 删掉冻结的那份），下一次上锁才重新渲染，在下一次
 * 请求里作为增量重发。派生 agent 每次都是新对话，不走这一条。
 */
import type { Context } from '@earendil-works/chord'
import type { ConversationId, DocumentReader, Tx } from '@earendil-works/pi-durable'
import {
  composePersona,
  type AgentKind,
  type PromptBlockTexts,
  type PromptBlocksCtx
} from '../../agentProfile/promptBlocks'
import type { InProcessAgentType } from '../../subagent/types'
import type { RuntimeLogger } from '../../types'
import { AgentStateDoc, type AgentStateRecord } from '../docs'

/** 渲染人设：档案正文 + 它点名的块（`composePersona` 同一口径） */
export function renderPersona(
  profile: Pick<InProcessAgentType, 'systemPrompt' | 'promptBlocks'>,
  blocks: PromptBlockTexts
): string {
  return composePersona(profile, blocks)
}

/** 冻结时要用到的宿主 seam */
export interface PersonaHost {
  promptBlocks: (ctx: PromptBlocksCtx) => PromptBlockTexts | Promise<PromptBlockTexts>
  logger?: RuntimeLogger
}

/** 冻结的输入：这个 agent 是谁（身份、归一名单与渲染块用的 cwd 就够） */
export interface PersonaInput {
  kind: AgentKind
  /** root = 会话 id；spawned = agentId */
  sessionId: string
  /** 活段落解析所对着的根会话（root = 自身） */
  rootSessionId: string
  /** 渲染块用的工作目录（root = 会话工作目录；spawned = ''） */
  cwd: string
  /** 归一后的工具名单 —— 块据此决定提哪些能力（与工具解析同一份） */
  toolNames: readonly string[]
  profile: Pick<InProcessAgentType, 'name' | 'systemPrompt' | 'promptBlocks'>
}

/** 冻结进 `AgentStateDoc` 的那几项：人设正文与活段落要用到的 agent 身份 */
export interface FrozenAgentPrompt {
  kind: AgentKind
  profileName: string
  rootSessionId: string
  persona: string
  /** 档案的提示词块清单：独立段落（指令文件、项目提示词）按它选中与解析 */
  promptBlocks: readonly string[]
  /** 根 agent 才有：冻结时的输入摘要（{@link personaKeyOf}）；派生 agent 不写 */
  personaKey?: string
}

/** 53 位的字符串摘要（cyrb53）：只用来判断「输入变没变」，不是安全用途；运行时不依赖 Node 的 crypto */
function digest(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** 摘要要看的那几项（上锁时与比对时各自凑齐；`toolNames` 是档案 + 会话勾选归一后的名单） */
export type PersonaKeyInput = Pick<PersonaInput, 'kind' | 'cwd' | 'toolNames'> & {
  profile: Pick<InProcessAgentType, 'name' | 'systemPrompt' | 'promptBlocks'>
}

/**
 * 人设的输入摘要 —— 只收**有意的**改动：档案名、种类、正文（用户改了 md、换了界面语言、升级换了内置 md）、
 * 归一后的工具名单（不含 `mcp:`，按集合）、工作目录、提示词块清单。日期、版本、系统、shell 这些块里的
 * 值故意不在里面：它们天天变，提醒就成了噪音（跨天由日期通知告诉模型）。技能货架也不在：人设只看作图技能在不在，
 * 算整个货架的话，启用随便哪个技能都会让每条会话报「档案改过了」。只用来提醒用户，从不据此自动重新渲染。
 */
export function personaKeyOf(input: PersonaKeyInput): string {
  return `v2:${digest(
    JSON.stringify([
      input.kind,
      input.profile.name,
      input.profile.systemPrompt,
      // `mcp:` 条目不算：人设不按它们变（块只看内置工具与技能），会话里中途勾一台 MCP 是活的重配
      [...new Set(input.toolNames.filter((name) => !name.startsWith('mcp:')))].sort(),
      input.cwd,
      // 清单是集合：按集合算，写的顺序不同不算改动
      [...new Set(input.profile.promptBlocks ?? [])].sort()
    ])
  )}`
}

/**
 * 存着的冻结记录能不能原样沿用：有人设、种类对得上 → 交回人设正文与提示词块清单（可以直接再冻结一遍，文本不变）；
 * 否则 undefined（调用方渲染）。**不看摘要，也不看档案名**：摘要变了、档案换了（临时会话挪进项目，chat → work）
 * 都只提醒，不重新渲染。身份（种类、档案名、根会话 id）按这次的输入写：fork 拷来的记录写着源会话的根会话 id，
 * 活段落要按 fork 自己的会话解析。存着的摘要原样留着（旧记录没有摘要 → 记下 `currentKey`，此后按它比对）。
 */
export function reusableFrozenPrompt(
  stored: AgentStateRecord | undefined,
  input: PersonaInput,
  currentKey: string
): FrozenAgentPrompt | undefined {
  if (stored === undefined || stored.persona === undefined) return undefined
  if (stored.kind !== input.kind) return undefined
  return {
    kind: input.kind,
    profileName: input.profile.name,
    rootSessionId: input.rootSessionId,
    persona: stored.persona,
    // 旧记录没存清单（2026-11-13 之前）→ 用档案此刻的，两个指令文件的去重才判得对
    promptBlocks: [...(stored.promptBlocks ?? input.profile.promptBlocks ?? [])],
    personaKey: stored.personaKey ?? currentKey
  }
}

/** 现渲染各块、拼出人设，打包成待冻结的记录（在提交之外调用） */
export async function computeFrozenAgentPrompt(
  host: PersonaHost,
  input: PersonaInput
): Promise<FrozenAgentPrompt> {
  const blocks = await host.promptBlocks({
    sessionId: input.sessionId,
    rootSessionId: input.rootSessionId,
    kind: input.kind,
    cwd: input.cwd,
    toolNames: input.toolNames
  })
  return {
    kind: input.kind,
    profileName: input.profile.name,
    rootSessionId: input.rootSessionId,
    persona: renderPersona(input.profile, blocks),
    promptBlocks: [...(input.profile.promptBlocks ?? [])]
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
  state.promptBlocks = [...frozen.promptBlocks]
  if (frozen.personaKey === undefined) delete state.personaKey
  else state.personaKey = frozen.personaKey
}

/** 在调用方的提交里冻结其余段落（`sections.ts` 的 `renderSections` 渲染的那份，段落 key → 文本 / `null`） */
export async function freezeSections(
  tx: Tx,
  conversationId: ConversationId,
  sections: Readonly<Record<string, string | null>>,
  unfrozen: readonly string[] = []
): Promise<void> {
  const state = await tx.doc(AgentStateDoc, conversationId)
  state.sections = { ...sections }
  if (unfrozen.length > 0) state.unfrozenSections = [...unfrozen]
  else delete state.unfrozenSections
}

/**
 * 用户点了「重建系统提示词」：删掉这个对话冻结的人设、摘要与其余段落，下一次上锁按此刻的来源重新渲染。身份字段
 * （种类、档案名、根会话 id、提示词块清单）与日期记录留着。调用方保证此刻没有锁（没有锁就没有请求读人设）。
 */
export async function forgetFrozenPrompt(tx: Tx, conversationId: ConversationId): Promise<void> {
  const state = await tx.doc(AgentStateDoc, conversationId)
  delete state.persona
  delete state.personaKey
  delete state.sections
  delete state.unfrozenSections
}

/** 读一个对话已冻结的人设（没冻结 → undefined） */
export async function frozenPersonaOf(
  read: DocumentReader,
  conversationId: ConversationId,
  context: Context
): Promise<string | undefined> {
  return (await read.snapshot(AgentStateDoc, conversationId, context))?.persona
}
