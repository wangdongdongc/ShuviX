/**
 * 系统提示词的五个段落 —— 每段一个 ShuviX 扩展，沿旧 createAgent 的围栏切开（裁决：Mapping #5 prompt）。
 *
 * | 扩展                            | 段落 key               | 内容                         | 何时选中                        |
 * |---------------------------------|------------------------|------------------------------|---------------------------------|
 * | `shuvix.prompt.persona`         | `persona`              | 冻结的人设（AgentStateDoc）   | 恒选                            |
 * | `shuvix.prompt.instructions`    | `project_instructions` | 指令文件（现解析）            | 档案声明了指令文件清单           |
 * | `shuvix.prompt.project-prompt`  | `project_prompt`       | 项目提示词（现解析）          | 项目感知                        |
 * | `shuvix.prompt.knowledge`       | `knowledge_bases`      | 知识库引导（现解析）          | agent 的工具名单里有 `knowledge` |
 * | `shuvix.prompt.bot`             | `bot_profile`          | bot 人设与记忆（现解析）      | bot 档案上的根 agent            |
 * | `shuvix.prompt.placeholders`    | `placeholders`         | 自动脱敏的占位符怎么用（固定）| 宿主做自动脱敏                  |
 *
 * 几条规矩：
 *  - **逐字节等于旧系统提示词**：全部 `tag: false`（文本原样，durable 不再包标签），段落之间由 pi-ai
 *    以 "\n\n" 拼接 —— 正是旧 createAgent 的 `+= '\n\n' + 围栏`。P1-00 的黄金 fixture 对照。
 *  - **固定次序**：durable 按对话选中的扩展顺序排段落。五个扩展必须按 `PROMPT_EXTENSION_ORDER` 选，
 *    且别的扩展不该再带段落（工具扩展没有段落，排在哪里都不影响）。
 *  - **人设冻结、其余四段是活的**：段落只在有意的状态变化时变（用户改了项目提示词、勾了别的库、
 *    bot 改了自己的记忆……），从不因环境波动而变；变了的那一段在下一次请求里作为 `pi.system` 增量重发。
 *  - **修剪与跳过**：四个活段落的内容一律 trim，纯空白 / null / seam 未实现 → 段落缺席（返回 undefined）。
 *    指令文件也修剪 —— 旧 createAgent 只判真假不修剪，但桌面的解析器本就修剪过，生产输出不变（P1-08 决定）。
 *  - **选中即门**：门在 `promptExtensionsFor`（创建 agent 时按档案定，随锁固定）；段落本身不再判门。
 *    注意 durable 的缺省选择是「全部已安装的扩展」—— 对话必须显式选择（P1-09 上锁时 configure）。
 *  - 段落 key 用模型认得的名字（与围栏标签一致）：支持中途 system 消息的 API 会把增量写成
 *    `Updated system prompt section "project_prompt": …`，key 对模型可见。避开 durable 保留的 `instructions`。
 */
import type { Context } from '@earendil-works/chord'
import type { Message } from '@earendil-works/pi-ai'
import {
  defineExtension,
  section,
  type ConversationId,
  type DocumentReader,
  type Extension,
  type PromptInput,
  type PromptSection
} from '@earendil-works/pi-durable'
import type { AgentKind } from '../../agentProfile/promptVars'
import { KNOWLEDGE_TOOL_NAME } from '../../knowledge/knowledgeTool'
import { BOT_PROFILE_NAME } from '../../subagent/builtinAgents'
import type { InProcessAgentType } from '../../subagent/types'
import { AgentStateDoc, type AgentStateRecord } from '../docs'
import type { BotContextBlocks, PromptHost } from '../seams'
import { fenceInstructionFile, fenceKnowledgeBases, fenceProjectPrompt } from './fences'

// ─────────────────────────── 名字 ───────────────────────────

/** 五个扩展的名字 */
export const PROMPT_EXTENSION = {
  persona: 'shuvix.prompt.persona',
  instructions: 'shuvix.prompt.instructions',
  projectPrompt: 'shuvix.prompt.project-prompt',
  knowledge: 'shuvix.prompt.knowledge',
  bot: 'shuvix.prompt.bot',
  placeholders: 'shuvix.prompt.placeholders'
} as const

export type PromptExtensionId = keyof typeof PROMPT_EXTENSION
export type PromptExtensionName = (typeof PROMPT_EXTENSION)[PromptExtensionId]

/** 每个扩展唯一那一段的 key（与围栏标签同名；对支持中途 system 消息的模型可见） */
export const PROMPT_SECTION_KEY: Record<PromptExtensionId, string> = {
  persona: 'persona',
  instructions: 'project_instructions',
  projectPrompt: 'project_prompt',
  knowledge: 'knowledge_bases',
  bot: 'bot_profile',
  placeholders: 'placeholders'
}

/** 段落扩展名 → 它那一段的 key（冻结的 `AgentStateDoc.sections` 按 key 存） */
export function sectionKeyOf(name: PromptExtensionName): string {
  const id = (Object.keys(PROMPT_EXTENSION) as PromptExtensionId[]).find(
    (candidate) => PROMPT_EXTENSION[candidate] === name
  )
  if (id === undefined) throw new Error(`Not a prompt extension: ${name}`)
  return PROMPT_SECTION_KEY[id]
}

/** 段落的固定次序（= 旧 createAgent 的拼接次序） */
export const PROMPT_EXTENSION_ORDER: readonly PromptExtensionName[] = [
  PROMPT_EXTENSION.persona,
  // 固定文本紧跟冻结的人设：前缀缓存不受后面那几个活段落变化的影响
  PROMPT_EXTENSION.placeholders,
  PROMPT_EXTENSION.instructions,
  PROMPT_EXTENSION.projectPrompt,
  PROMPT_EXTENSION.knowledge,
  PROMPT_EXTENSION.bot
]

// ─────────────────────────── 选择 ───────────────────────────

/** 选择段落要看的那几项 */
export interface PromptSelectionSpec {
  kind: AgentKind
  profile: Pick<InProcessAgentType, 'name' | 'instructionFiles' | 'projectAwareness'>
  /** 归一后的工具名单（档案 + 会话勾选） */
  toolNames: readonly string[]
  /** 宿主做自动脱敏（对话记录里有占位符）—— 由 createPromptExtensions 按宿主配置填 */
  placeholders?: boolean
}

/**
 * 一个对话选中哪几个段落扩展（固定次序）：人设恒选；指令文件 iff 档案清单非空；项目提示词
 * iff 项目感知；知识库 iff 工具名单里有 `knowledge`（库由宿主按会话解析 —— 有项目时恒含项目库 —— 与项目感知无关）；bot iff bot 档案
 * 上的根 agent（人设影响怎么说话、不影响怎么干活 —— 派生 agent 拿不到）。
 */
export function promptExtensionsFor(spec: PromptSelectionSpec): PromptExtensionName[] {
  const { profile } = spec
  const selected = new Set<PromptExtensionName>([PROMPT_EXTENSION.persona])
  if (spec.placeholders === true) selected.add(PROMPT_EXTENSION.placeholders)
  if ((profile.instructionFiles?.length ?? 0) > 0) selected.add(PROMPT_EXTENSION.instructions)
  if (profile.projectAwareness) selected.add(PROMPT_EXTENSION.projectPrompt)
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

/** 一个活段落现解析时要的那几项（段落回调与冻结时的渲染共用） */
export interface LiveSectionInput {
  rootSessionId: string
  /** agent 的工作目录（`pi.agent.cwd`；根 agent = 会话工作目录） */
  cwd: string
  /** 冻结在 AgentStateDoc 里的指令文件清单 */
  instructionFiles: readonly string[]
  /** 只是拿来比对（不进提示词），见 `PromptRenderOptions.compare` */
  compare?: boolean
}

type LiveRender = (input: LiveSectionInput) => string | undefined | Promise<string | undefined>

/**
 * 段落回调：对话冻结了这一段（`AgentStateDoc.sections` 里有这个 key）→ 只读存着的文本，不再现解析（2026-11-06，
 * 「历史状态不变」：改了来源，这个对话的系统提示词照旧，用户点重建才换）；没冻结（旧对话、派生 agent）→ 照旧现解析
 * （取冻结的根会话 id，没有 → 段落缺席）。
 */
function frozenOrLive(key: string, render: LiveRender) {
  return async (input: PromptInput, context: Context): Promise<string | undefined> => {
    const state = await agentStateOf(input.read, input.conversationId, context)
    const frozen = state?.sections
    if (frozen !== undefined && Object.prototype.hasOwnProperty.call(frozen, key)) {
      return frozen[key] ?? undefined
    }
    const rootSessionId = state?.rootSessionId
    if (state === undefined || !rootSessionId) return undefined
    return render({
      rootSessionId,
      cwd: input.agent.cwd ?? '',
      instructionFiles: state.instructionFiles ?? []
    })
  }
}

/** 冻结（或比对）时渲染的那几段：选中的段落扩展名 + 现解析的输入 */
export interface RenderSectionsSpec extends LiveSectionInput {
  names: readonly PromptExtensionName[]
  /**
   * 某一段的宿主 seam 抛错：这一段不进结果（冻结时 = 这次不冻结它，下一次上锁再试；比对时 = 不算变也不算没变），
   * 其余照常。缺省 = 静默跳过
   */
  onError?: (key: string, error: unknown) => void
}

export interface PromptExtensions {
  /** 全部六个，固定次序（全部装进注册表） */
  readonly all: readonly Extension[]
  /** 按名取 */
  get(name: PromptExtensionName): Extension
  /** 一个对话该选中的那几个（`promptExtensionsFor` 的扩展对象版，固定次序） */
  select(spec: PromptSelectionSpec): Extension[]
  /**
   * 按此刻的来源渲染选中的段落（人设除外 —— 它由 `persona.ts` 冻结）：段落 key → 文本（`null` = 缺席）。上锁时
   * 冻结用它，提醒用户「来源改了」时比对也用它 —— 与段落回调现解析是同一套函数，所以两边逐字节一致。
   */
  renderSections(spec: RenderSectionsSpec): Promise<Record<string, string | null>>
  /** 这几段冻结的文本与此刻的来源一致：转告宿主（`PromptHost.noteSectionsCurrent`），没实现 = 无操作 */
  noteSectionsCurrent(rootSessionId: string, keys: readonly string[]): void
}

/**
 * 自动脱敏的占位符（docs/auto-redaction-design.md §13）—— 模型自己不可能知道的那一点：占位符背后的值在这台电脑上是真的，
 * 工具执行前换回真值，所以按占位符搜文件、写命令都对；去「看」值本身（打印、逐字节导出、编码）会把它带出去。
 * 演练一（真模型）里没有这一段时，agent 在文件里 grep `EMAIL_` 找不到，转而用 `od -c` 逐字节看，邮箱就这样逐字发了出去。
 * 例子刻意不写成标准形状（`{{REDACTED_API_KEY_…}}`）：一个看着像真占位符的例子会被模型照抄进工具参数，还原时查不到就拦下。
 * 「不是模板变量、不要猜」：`{{…}}` 像没填的模板变量，用户看到 agent 常花 token 猜它是什么、去别处找它（2026-10-26）。
 */
export const PLACEHOLDER_NOTE = [
  'Text such as {{REDACTED_API_KEY_…}} (a category and eight letters or digits) in this conversation is a placeholder for a secret or personal value that ShuviX redacted from you.',
  'It is not a template variable to fill in and not a fault in a file or an output: on this computer the value is real — in files and in command output — and ShuviX puts it back into your tool arguments before a tool runs.',
  "Write the placeholder exactly wherever you mean the value: in commands, file contents, edit text and searches (`grep -c '{{REDACTED_EMAIL_…}}' app.log` with the placeholder written out counts the real address).",
  'In bash, PowerShell and ssh commands put it bare or inside quotes, as you would the value: ShuviX escapes the real value for that spot, so do not escape it yourself.',
  'Do not guess what it stands for, look for it elsewhere or ask for it, and do not try to see the value itself — no printing, byte dumps or encodings of it; when a task needs a fact about it, such as its length, let a command work it out.'
].join(' ')

/** 以宿主 seam 构造段落扩展；`placeholders` = 这个宿主的会话做自动脱敏（占位符那一段才有内容） */
export function createPromptExtensions(
  host: PromptHost,
  opts: { placeholders?: boolean } = {}
): PromptExtensions {
  // 人设之外的每一段：现解析的渲染函数（段落回调与 renderSections 共用）
  const renders = new Map<PromptExtensionName, LiveRender>([
    [
      PROMPT_EXTENSION.placeholders,
      () =>
        opts.placeholders === true
          ? `<placeholders>\n${PLACEHOLDER_NOTE}\n</placeholders>`
          : undefined
    ],
    [
      PROMPT_EXTENSION.instructions,
      async ({ rootSessionId, cwd, instructionFiles }) => {
        if (!host.resolveInstruction || instructionFiles.length === 0) return undefined
        return instructionSectionText(
          await host.resolveInstruction(rootSessionId, cwd, [...instructionFiles])
        )
      }
    ],
    [
      PROMPT_EXTENSION.projectPrompt,
      async ({ rootSessionId }) =>
        host.resolveProjectPrompt
          ? fencedSectionText(await host.resolveProjectPrompt(rootSessionId), fenceProjectPrompt)
          : undefined
    ],
    [
      PROMPT_EXTENSION.knowledge,
      async ({ rootSessionId }) =>
        host.resolveKnowledgeBases
          ? fencedSectionText(await host.resolveKnowledgeBases(rootSessionId), fenceKnowledgeBases)
          : undefined
    ],
    [
      PROMPT_EXTENSION.bot,
      async ({ rootSessionId, compare }) =>
        host.resolveBotContext
          ? botSectionText(
              await host.resolveBotContext(
                rootSessionId,
                compare === true ? { compare } : undefined
              )
            )
          : undefined
    ]
  ])

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

  const liveExtension = (id: Exclude<PromptExtensionId, 'persona'>): Extension => {
    const name = PROMPT_EXTENSION[id]
    const key = PROMPT_SECTION_KEY[id]
    return defineExtension({
      name,
      sections: [section(key, frozenOrLive(key, renders.get(name)!), { tag: false })]
    })
  }

  const byName = new Map<PromptExtensionName, Extension>([
    [PROMPT_EXTENSION.persona, persona],
    [PROMPT_EXTENSION.placeholders, liveExtension('placeholders')],
    [PROMPT_EXTENSION.instructions, liveExtension('instructions')],
    [PROMPT_EXTENSION.projectPrompt, liveExtension('projectPrompt')],
    [PROMPT_EXTENSION.knowledge, liveExtension('knowledge')],
    [PROMPT_EXTENSION.bot, liveExtension('bot')]
  ])
  const get = (name: PromptExtensionName): Extension => byName.get(name)!
  return {
    all: PROMPT_EXTENSION_ORDER.map(get),
    get,
    select: (spec) =>
      promptExtensionsFor({ ...spec, placeholders: opts.placeholders === true }).map(get),
    renderSections: async (spec) => {
      const out: Record<string, string | null> = {}
      for (const name of spec.names) {
        const render = renders.get(name)
        if (render === undefined) continue
        const key = sectionKeyOf(name)
        try {
          out[key] = (await render(spec)) ?? null
        } catch (error) {
          spec.onError?.(key, error)
        }
      }
      return out
    },
    noteSectionsCurrent: (rootSessionId, keys) => {
      if (keys.length > 0) host.noteSectionsCurrent?.(rootSessionId, keys)
    }
  }
}

// ─────────────────────────── 只读渲染（P3-06，agentInfo） ───────────────────────────

/**
 * 重放 system 消息里的段落（durable `replaySections` 的同一口径，它不从包根导出）：按次序原地设值、
 * `null` 删掉、删了再加排到末尾。
 */
export function replaySections(messages: readonly Message[]): Map<string, string> {
  const shown = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'system' || message.sections === undefined) continue
    for (const [key, value] of Object.entries(message.sections)) {
      if (value === null) shown.delete(key)
      else shown.set(key, value)
    }
  }
  return shown
}

/**
 * 按 durable 准备请求时的同一口径渲染一个 agent 的系统提示词（P3-06 PIN-07：**下一次请求**会带的那份）：
 * 逐段渲染（`undefined` 缺席；`tag: false` 原样，否则 `<key>\n…\n</key>`）；一段抛错 → 保留它此刻已显示
 * 的文本（没有就缺席）并 `report`，从不拒绝。段落之间以 "\n\n" 拼接、跳过空段 —— 正是 durable 补上增量
 * 之后 pi-ai `getCurrentSystemPrompt` 读到的那份（ShuviX 的 system 消息 `content` 恒为空）。
 * 纯读：只经 `input.read` 读文档，不写任何东西。
 */
export async function renderSystemPrompt(
  sections: readonly PromptSection[],
  input: PromptInput,
  shown: ReadonlyMap<string, string>,
  report: (key: string, error: unknown) => void,
  context: Context
): Promise<string> {
  const desired = new Map<string, string>()
  for (const entry of sections) {
    let text: string | undefined
    try {
      text = await entry.render(input, context)
    } catch (error) {
      report(entry.key, error)
      const kept = shown.get(entry.key)
      if (kept !== undefined) desired.set(entry.key, kept)
      continue
    }
    if (text === undefined) continue
    desired.set(entry.key, entry.tag === false ? text : `<${entry.key}>\n${text}\n</${entry.key}>`)
  }
  return [...desired.values()].filter((part) => part.length > 0).join('\n\n')
}
