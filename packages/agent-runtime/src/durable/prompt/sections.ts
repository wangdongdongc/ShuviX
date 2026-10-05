/**
 * 系统提示词的六个段落 —— 每段一个 ShuviX 扩展，沿旧 createAgent 的围栏切开（裁决：Mapping #5 prompt）。
 *
 * | 扩展                            | 段落 key               | 内容                         | 何时选中                        |
 * |---------------------------------|------------------------|------------------------------|---------------------------------|
 * | `shuvix.prompt.persona`         | `persona`              | 冻结的人设（AgentStateDoc）   | 恒选                            |
 * | `shuvix.prompt.instructions`    | `project_instructions` | 指令文件（现解析）            | 档案声明了指令文件清单           |
 * | `shuvix.prompt.project-prompt`  | `project_prompt`       | 项目提示词（现解析）          | 项目感知                        |
 * | `shuvix.prompt.knowledge`       | `knowledge_bases`      | 知识库引导（现解析）          | agent 的工具名单里有 `knowledge` |
 * | `shuvix.prompt.memory`          | `project_memory`       | 旧项目记忆索引（现解析）      | 项目感知                        |
 * | `shuvix.prompt.bot`             | `bot_profile`          | bot 人设与记忆（现解析）      | bot 档案上的根 agent            |
 *
 * 几条规矩：
 *  - **逐字节等于旧系统提示词**：全部 `tag: false`（文本原样，durable 不再包标签），段落之间由 pi-ai
 *    以 "\n\n" 拼接 —— 正是旧 createAgent 的 `+= '\n\n' + 围栏`。P1-00 的黄金 fixture 对照。
 *  - **固定次序**：durable 按对话选中的扩展顺序排段落。六个扩展必须按 `PROMPT_EXTENSION_ORDER` 选，
 *    且别的扩展不该再带段落（工具扩展没有段落，排在哪里都不影响）。
 *  - **人设冻结、其余五段是活的**：段落只在有意的状态变化时变（用户改了项目提示词、勾了别的库、
 *    bot 改了自己的记忆……），从不因环境波动而变；变了的那一段在下一次请求里作为 `pi.system` 增量重发。
 *  - **修剪与跳过**：五个活段落的内容一律 trim，纯空白 / null / seam 未实现 → 段落缺席（返回 undefined）。
 *    指令文件也修剪 —— 旧 createAgent 只判真假不修剪，但桌面的解析器本就修剪过，生产输出不变（P1-08 决定）。
 *  - **选中即门**：门在 `promptExtensionsFor`（创建 agent 时按档案定，随锁固定）；段落本身不再判门。
 *    注意 durable 的缺省选择是「全部已安装的扩展」—— 对话必须显式选择（P1-09 上锁时 configure）。
 *  - 段落 key 用模型认得的名字（与围栏标签一致）：支持中途 system 消息的 API 会把增量写成
 *    `Updated system prompt section "project_prompt": …`，key 对模型可见。避开 durable 保留的 `instructions`。
 */
import type { Context } from '@earendil-works/chord'
import {
  defineExtension,
  section,
  type ConversationId,
  type DocumentReader,
  type Extension,
  type PromptInput
} from '@earendil-works/pi-durable'
import type { AgentKind } from '../../agentProfile/promptVars'
import { KNOWLEDGE_TOOL_NAME } from '../../knowledge/knowledgeTool'
import { BOT_PROFILE_NAME } from '../../subagent/builtinAgents'
import type { InProcessAgentType } from '../../subagent/types'
import { AgentStateDoc, type AgentStateRecord } from '../docs'
import type { BotContextBlocks, PromptHost } from '../seams'
import {
  fenceInstructionFile,
  fenceKnowledgeBases,
  fenceProjectMemory,
  fenceProjectPrompt
} from './fences'

// ─────────────────────────── 名字 ───────────────────────────

/** 六个扩展的名字 */
export const PROMPT_EXTENSION = {
  persona: 'shuvix.prompt.persona',
  instructions: 'shuvix.prompt.instructions',
  projectPrompt: 'shuvix.prompt.project-prompt',
  knowledge: 'shuvix.prompt.knowledge',
  memory: 'shuvix.prompt.memory',
  bot: 'shuvix.prompt.bot'
} as const

export type PromptExtensionId = keyof typeof PROMPT_EXTENSION
export type PromptExtensionName = (typeof PROMPT_EXTENSION)[PromptExtensionId]

/** 每个扩展唯一那一段的 key（与围栏标签同名；对支持中途 system 消息的模型可见） */
export const PROMPT_SECTION_KEY: Record<PromptExtensionId, string> = {
  persona: 'persona',
  instructions: 'project_instructions',
  projectPrompt: 'project_prompt',
  knowledge: 'knowledge_bases',
  memory: 'project_memory',
  bot: 'bot_profile'
}

/** 段落的固定次序（= 旧 createAgent 的拼接次序） */
export const PROMPT_EXTENSION_ORDER: readonly PromptExtensionName[] = [
  PROMPT_EXTENSION.persona,
  PROMPT_EXTENSION.instructions,
  PROMPT_EXTENSION.projectPrompt,
  PROMPT_EXTENSION.knowledge,
  PROMPT_EXTENSION.memory,
  PROMPT_EXTENSION.bot
]

// ─────────────────────────── 选择 ───────────────────────────

/** 选择段落要看的那几项 */
export interface PromptSelectionSpec {
  kind: AgentKind
  profile: Pick<InProcessAgentType, 'name' | 'instructionFiles' | 'projectAwareness'>
  /** 归一后的工具名单（档案 + 会话勾选） */
  toolNames: readonly string[]
}

/**
 * 一个对话选中哪几个段落扩展（固定次序）：人设恒选；指令文件 iff 档案清单非空；项目提示词与项目记忆
 * iff 项目感知；知识库 iff 工具名单里有 `knowledge`（库是按会话选的，与项目感知无关）；bot iff bot 档案
 * 上的根 agent（人设影响怎么说话、不影响怎么干活 —— 派生 agent 拿不到）。
 */
export function promptExtensionsFor(spec: PromptSelectionSpec): PromptExtensionName[] {
  const { profile } = spec
  const selected = new Set<PromptExtensionName>([PROMPT_EXTENSION.persona])
  if ((profile.instructionFiles?.length ?? 0) > 0) selected.add(PROMPT_EXTENSION.instructions)
  if (profile.projectAwareness) {
    selected.add(PROMPT_EXTENSION.projectPrompt)
    selected.add(PROMPT_EXTENSION.memory)
  }
  if (spec.toolNames.includes(KNOWLEDGE_TOOL_NAME)) selected.add(PROMPT_EXTENSION.knowledge)
  if (spec.kind === 'root' && profile.name === BOT_PROFILE_NAME) selected.add(PROMPT_EXTENSION.bot)
  return PROMPT_EXTENSION_ORDER.filter((name) => selected.has(name))
}

// ─────────────────────────── 文本规则（纯函数） ───────────────────────────

/** 修剪；纯空白 / 缺省 → undefined */
function trimmed(text: string | null | undefined): string | undefined {
  const value = text?.trim()
  return value ? value : undefined
}

/** 指令文件段落：内容修剪后为空 → 缺席；否则 `<project_instructions file="…">` 围栏 */
export function instructionSectionText(
  resolved: { filename: string; content: string } | null | undefined
): string | undefined {
  if (!resolved) return undefined
  const content = trimmed(resolved.content)
  return content === undefined ? undefined : fenceInstructionFile(resolved.filename, content)
}

/** 单段文本 + 围栏：修剪后为空 → 缺席 */
export function fencedSectionText(
  text: string | null | undefined,
  fence: (text: string) => string
): string | undefined {
  const value = trimmed(text)
  return value === undefined ? undefined : fence(value)
}

/** bot 段落：每块修剪、空白块跳过、块间空一行；一块都不剩 → 缺席 */
export function botSectionText(blocks: BotContextBlocks): string | undefined {
  const list = typeof blocks === 'string' ? [blocks] : (blocks ?? [])
  const kept = list.map((block) => block.trim()).filter((block) => block.length > 0)
  return kept.length === 0 ? undefined : kept.join('\n\n')
}

// ─────────────────────────── 段落 ───────────────────────────

/** 对话缺冻结的人设（agent 没创建）：persona 段落报告它，其余活段落静默缺席 */
export class PersonaNotFrozenError extends Error {
  constructor(readonly conversationId: ConversationId) {
    super(`Conversation ${conversationId} has no frozen persona (its agent was not created)`)
    this.name = 'PersonaNotFrozenError'
  }
}

async function agentStateOf(
  read: DocumentReader,
  conversationId: ConversationId,
  context: Context
): Promise<Readonly<AgentStateRecord> | undefined> {
  return read.snapshot(AgentStateDoc, conversationId, context)
}

/** 活段落：取冻结的根会话 id（没冻结 → undefined，段落缺席）再调宿主 */
function liveSection(
  render: (
    rootSessionId: string,
    input: PromptInput,
    state: Readonly<AgentStateRecord>
  ) => string | undefined | Promise<string | undefined>
) {
  return async (input: PromptInput, context: Context): Promise<string | undefined> => {
    const state = await agentStateOf(input.read, input.conversationId, context)
    const rootSessionId = state?.rootSessionId
    if (state === undefined || !rootSessionId) return undefined
    return render(rootSessionId, input, state)
  }
}

export interface PromptExtensions {
  /** 全部六个，固定次序（全部装进注册表） */
  readonly all: readonly Extension[]
  /** 按名取 */
  get(name: PromptExtensionName): Extension
  /** 一个对话该选中的那几个（`promptExtensionsFor` 的扩展对象版，固定次序） */
  select(spec: PromptSelectionSpec): Extension[]
}

/** 以宿主 seam 构造六个段落扩展 */
export function createPromptExtensions(host: PromptHost): PromptExtensions {
  const persona = defineExtension({
    name: PROMPT_EXTENSION.persona,
    sections: [
      section(
        PROMPT_SECTION_KEY.persona,
        async (input, context) => {
          const text = (await agentStateOf(input.read, input.conversationId, context))?.persona
          if (text === undefined) throw new PersonaNotFrozenError(input.conversationId)
          return text.length > 0 ? text : undefined
        },
        { tag: false }
      )
    ]
  })

  const instructions = defineExtension({
    name: PROMPT_EXTENSION.instructions,
    sections: [
      section(
        PROMPT_SECTION_KEY.instructions,
        liveSection(async (rootSessionId, input, state) => {
          const files = state.instructionFiles ?? []
          if (!host.resolveInstruction || files.length === 0) return undefined
          return instructionSectionText(
            await host.resolveInstruction(rootSessionId, input.agent.cwd ?? '', files)
          )
        }),
        { tag: false }
      )
    ]
  })

  const projectPrompt = defineExtension({
    name: PROMPT_EXTENSION.projectPrompt,
    sections: [
      section(
        PROMPT_SECTION_KEY.projectPrompt,
        liveSection(async (rootSessionId) =>
          host.resolveProjectPrompt
            ? fencedSectionText(await host.resolveProjectPrompt(rootSessionId), fenceProjectPrompt)
            : undefined
        ),
        { tag: false }
      )
    ]
  })

  const knowledge = defineExtension({
    name: PROMPT_EXTENSION.knowledge,
    sections: [
      section(
        PROMPT_SECTION_KEY.knowledge,
        liveSection(async (rootSessionId) =>
          host.resolveKnowledgeBases
            ? fencedSectionText(
                await host.resolveKnowledgeBases(rootSessionId),
                fenceKnowledgeBases
              )
            : undefined
        ),
        { tag: false }
      )
    ]
  })

  const memory = defineExtension({
    name: PROMPT_EXTENSION.memory,
    sections: [
      section(
        PROMPT_SECTION_KEY.memory,
        liveSection(async (rootSessionId) =>
          host.resolveProjectMemory
            ? fencedSectionText(await host.resolveProjectMemory(rootSessionId), fenceProjectMemory)
            : undefined
        ),
        { tag: false }
      )
    ]
  })

  const bot = defineExtension({
    name: PROMPT_EXTENSION.bot,
    sections: [
      section(
        PROMPT_SECTION_KEY.bot,
        liveSection(async (rootSessionId) =>
          host.resolveBotContext
            ? botSectionText(await host.resolveBotContext(rootSessionId))
            : undefined
        ),
        { tag: false }
      )
    ]
  })

  const byName = new Map<PromptExtensionName, Extension>([
    [PROMPT_EXTENSION.persona, persona],
    [PROMPT_EXTENSION.instructions, instructions],
    [PROMPT_EXTENSION.projectPrompt, projectPrompt],
    [PROMPT_EXTENSION.knowledge, knowledge],
    [PROMPT_EXTENSION.memory, memory],
    [PROMPT_EXTENSION.bot, bot]
  ])
  const get = (name: PromptExtensionName): Extension => byName.get(name)!
  return {
    all: PROMPT_EXTENSION_ORDER.map(get),
    get,
    select: (spec) => promptExtensionsFor(spec).map(get)
  }
}
