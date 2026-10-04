/**
 * P1-00 golden capture —— 把今天 `createAgentFactory(host).createAgent()` 组装出来的系统提示词冻结成
 * fixture，供 pi-durable 迁移（系统提示词改由若干 section 以 "\n\n" 拼接）逐字节对照。
 *
 * **只在 `SHUVIX_CAPTURE_GOLDEN=1` 时运行并写文件**，平时整组跳过：
 *
 *   SHUVIX_CAPTURE_GOLDEN=1 npx vitest run --root apps/desktop \
 *     packages/agent-runtime/src/agentProfile/__tests__/systemPromptGolden.capture.test.ts
 *
 * 写到 `packages/agent-runtime/src/durable/__tests__/fixtures/system-prompts/<case>.json`（先清掉目录里
 * 旧的 .json，改名的用例不会留下孤儿）。每份 fixture 记三样东西：
 *  - `inputs`：档案（内置 md 原样正文 + 工具 / 指令文件清单 / 项目感知）、fake host 交出的 promptVars
 *    **原值**、四个注入 seam 各自的返回值（或「宿主没实现」）、systemContext；
 *  - `observed`：createAgent 实际交给 promptVars 的 ctx（含归一后的工具名单）、各 seam 收到的实参、
 *    logger 告警；
 *  - `output`（= 交给 HarnessSession 的 systemPrompt）与 `parts`：按 createAgent.ts 的围栏把它拆成
 *    persona（档案正文渲染结果）+ 每一段追加块。捕获时断言 `parts.map(p => p.text).join('\n\n') === output`
 *    —— 拆分是照着已知的围栏函数从输入**重算**的，等式成立才说明拆分与真实输出一致。
 *
 * 系统提示词经 pi-agent-core 0.80 的 AgentHarness 原样发出（`systemPrompt: () => this.systemPrompt`，
 * harness 不再追加任何东西），所以这里记的就是线上发给模型的那一份。HarnessSession 被桩掉只为不必
 * 真的起会话树 —— 提示词在它之前就已组装完毕。
 *
 * 本文件 import 了 createAgent / pi-agent-core：P1-01 切换依赖后它就完成了使命（届时删掉或改写）。
 * 切换后仍要跑的是 `durable/__tests__/systemPromptGolden.test.ts`（只读 fixture）。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { createAgentFactory, type AgentHostAdapter, type CreateAgentParams } from '../createAgent'
import {
  formatLanguageDisplay,
  renderProfileSystemPrompt,
  type PromptVars,
  type PromptVarsCtx
} from '../promptVars'
import { renderVisualCraft, renderVisualGuide } from '../fragments'
import {
  BOT_SPEC,
  CHAT_SPEC,
  CODING_SPEC,
  NOTEBOOK_SPEC,
  WORK_SPEC,
  buildBuiltinProfile,
  type BuiltinProfileSpec
} from '../../subagent/builtinAgents'
import { createInlineMdReader } from '../../subagent/builtinAgents/inlineSources'
import { toInProcessAgentType } from '../../subagent/dispatchTool'
import type { InProcessAgentType, SubAgentModelConfig } from '../../subagent/types'
import { renderBotContext } from '../../bot/botContext'
import { renderKnowledgeGuide } from '../../knowledge/knowledgeGuide'
import { KNOWLEDGE_TOOL_NAME } from '../../knowledge/knowledgeTool'

const CAPTURE = process.env.SHUVIX_CAPTURE_GOLDEN === '1'

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../durable/__tests__/fixtures/system-prompts'
)

// ── HarnessSession 桩：只接住构造参数（systemPrompt 在它之前就组装好了）──
const harness = vi.hoisted(() => ({ constructed: [] as Array<Record<string, unknown>> }))
vi.mock('../../harness/harnessSession', () => ({
  HarnessSession: vi.fn().mockImplementation(function (deps: Record<string, unknown>) {
    harness.constructed.push(deps)
    return {
      deps,
      getThinkingLevel: () => deps.thinkingLevel ?? 'off',
      requestUserInput: vi.fn(),
      // createAgent 把它登记进运行时注册中心：登记时只会 subscribe
      piHarness: { subscribe: () => () => {} }
    }
  })
}))

// ── 固定输入 ──

const ROOT_SID = 'sess-golden-root'
const SUB_AGENT_ID = 'sub-golden-1'
const PROJECT_CWD = '/Users/golden/projects/acme'
const CHAT_CWD = '/Users/golden/Library/Application Support/ShuviX/temp_workspace/sess-golden-root'
/** 派生 agent 的 cwd 为 ''，桌面变量表按 process.cwd() 兜底判 git（打包后的进程 cwd 是 /） */
const PROCESS_CWD = '/'
/** 有 .git 的目录（桌面变量表 `isGitRepo` 的取值依据） */
const GIT_DIRS = new Set([PROJECT_CWD])
const DRAWING_SKILL = 'skill:builtin:drawing'
const MODEL_CFG: SubAgentModelConfig = {
  provider: 'golden-provider',
  model: 'golden-model',
  capabilities: {}
}

type Language = 'en' | 'zh'
type ProfileName = 'work' | 'chat' | 'notebook' | 'bot' | 'coding'

const SPECS: Record<ProfileName, BuiltinProfileSpec> = {
  work: WORK_SPEC,
  chat: CHAT_SPEC,
  notebook: NOTEBOOK_SPEC,
  bot: BOT_SPEC,
  coding: CODING_SPEC
}

const INSTRUCTION = {
  filename: 'CLAUDE.md',
  content: [
    '# CLAUDE.md',
    '',
    'Guidance for agents working in the acme repository.',
    '',
    '## Commands',
    '',
    '```bash',
    'npm run test   # unit tests',
    'npm run lint   # must finish with 0 errors',
    '```',
    '',
    '## Conventions',
    '',
    '- TypeScript strict mode everywhere.',
    '- Never commit generated files under `dist/`.'
  ].join('\n')
}

const PROJECT_PROMPT = [
  'This project is the acme billing service.',
  'Answer in English even when the user writes in another language.',
  '',
  'Deployment happens on Fridays only.'
].join('\n')

const KNOWLEDGE_GUIDE = renderKnowledgeGuide([
  { name: 'project', label: "this project's own knowledge base" },
  { name: 'recipes' }
])!

const PROJECT_MEMORY = [
  'Things learned earlier on this project, kept in a retired store — **read-only**: never',
  'write or edit here, put a correction or anything new in the knowledge base instead. Each',
  'entry records what was true when written; verify any code detail against the current code',
  'before relying on it. Before you start work, check whether any entry matches what you are',
  'about to touch — an entry you skipped is a mistake you are about to repeat. Read one with',
  '`read` at /Users/golden/.shuvix/memory/proj-golden/<file>.',
  '',
  '## Always applies',
  '',
  '### `no-friday-hotfix.md` (2026-09-01)',
  'Never merge to main on a Friday afternoon.',
  '',
  '## Index',
  '',
  '- `invoice-rounding.md` (2026-08-20) — when touching invoice totals or currency rounding',
  '- `flaky-e2e.md` — when an e2e spec under e2e/billing fails intermittently'
].join('\n')

const BOT_CONTEXT = renderBotContext({
  name: 'aria',
  displayName: 'Aria',
  file: '/Users/golden/.shuvix/bots/aria.md',
  body: [
    '## Persona',
    '',
    'Aria is a calm, concise research companion. She answers in short paragraphs.',
    '',
    '## Memory',
    '',
    '- The user prefers pnpm in the acme repo.',
    '- The user is based in Lisbon (UTC+0/+1).'
  ].join('\n')
})

const BOT_CONTEXT_EMPTY_BODY = renderBotContext({
  name: 'scout',
  displayName: 'scout',
  file: '/Users/golden/.shuvix/bots/scout.md',
  body: ''
})

// ── 用例 ──

interface InstructionValue {
  filename: string
  content: string
}

/**
 * 四个注入 seam：键缺省 = 宿主**没实现**这个 seam；值 null = 实现了、这次返回 null。
 */
interface ResolverSpec {
  instruction?: InstructionValue | null
  projectPrompt?: string | null
  knowledgeBases?: string | null
  projectMemory?: string | null
}

type PartName =
  | 'persona'
  | 'instructionFile'
  | 'projectPrompt'
  | 'knowledgeBases'
  | 'projectMemory'
  | 'systemContext'

interface GoldenCase {
  name: string
  description: string
  profile: ProfileName
  kind: 'root' | 'spawned'
  language?: Language
  /** 从内置档案的工具清单里去掉这些（模拟用户覆盖档案的形状） */
  dropTools?: readonly string[]
  /** 会话勾选 overlay（root 只收 mcp:/skill:） */
  toolOverlay?: readonly string[]
  /** 作图技能在侧栏被停用（visualGuide / visualCraft 整块消失）；缺省 = 在架 */
  drawingSkillDisabled?: boolean
  /** root 会话的项目名（无项目会话 ''） */
  projectName?: string
  /** root 会话的 notebookPath（非笔记本会话 ''） */
  notebookPath?: string
  /** root 的工作目录（spawned 恒为 ''） */
  cwd?: string
  resolvers: ResolverSpec
  systemContext?: readonly string[]
  /** 这一例预期出现的块（防止输入写错导致某段静悄悄缺席） */
  expectParts: readonly PartName[]
}

const ALL_NULL: ResolverSpec = {
  instruction: null,
  projectPrompt: null,
  knowledgeBases: null,
  projectMemory: null
}

const ALL_CONTENT: ResolverSpec = {
  instruction: INSTRUCTION,
  projectPrompt: PROJECT_PROMPT,
  knowledgeBases: KNOWLEDGE_GUIDE,
  projectMemory: PROJECT_MEMORY
}

const ALL_FENCES: readonly PartName[] = [
  'persona',
  'instructionFile',
  'projectPrompt',
  'knowledgeBases',
  'projectMemory'
]

const CASES: readonly GoldenCase[] = [
  {
    name: 'work-root-no-injections',
    description: 'work root; every injection seam is implemented and returns null',
    profile: 'work',
    kind: 'root',
    projectName: 'acme',
    resolvers: ALL_NULL,
    expectParts: ['persona']
  },
  {
    name: 'work-root-instruction-file',
    description: 'work root; only the instruction file resolves',
    profile: 'work',
    kind: 'root',
    projectName: 'acme',
    resolvers: { ...ALL_NULL, instruction: INSTRUCTION },
    expectParts: ['persona', 'instructionFile']
  },
  {
    name: 'work-root-project-prompt',
    description: 'work root; only the project prompt resolves',
    profile: 'work',
    kind: 'root',
    projectName: 'acme',
    resolvers: { ...ALL_NULL, projectPrompt: PROJECT_PROMPT },
    expectParts: ['persona', 'projectPrompt']
  },
  {
    name: 'work-root-knowledge-bases',
    description: 'work root; only the knowledge-base guide resolves (profile carries `knowledge`)',
    profile: 'work',
    kind: 'root',
    projectName: 'acme',
    resolvers: { ...ALL_NULL, knowledgeBases: KNOWLEDGE_GUIDE },
    expectParts: ['persona', 'knowledgeBases']
  },
  {
    name: 'work-root-project-memory',
    description: 'work root; only the project memory index resolves',
    profile: 'work',
    kind: 'root',
    projectName: 'acme',
    resolvers: { ...ALL_NULL, projectMemory: PROJECT_MEMORY },
    expectParts: ['persona', 'projectMemory']
  },
  {
    name: 'work-root-all-injections',
    description:
      'work root; all four injections resolve; overlay carries mcp:/skill: plus a builtin name (dropped by normalization)',
    profile: 'work',
    kind: 'root',
    projectName: 'acme',
    toolOverlay: ['mcp:ssh', 'skill:pdf', 'bash', DRAWING_SKILL],
    resolvers: ALL_CONTENT,
    expectParts: ALL_FENCES
  },
  {
    name: 'work-root-without-knowledge-tool',
    description:
      'work root with `knowledge` removed from the profile tools (user override shape); resolveKnowledgeBases returns text but must not be consulted',
    profile: 'work',
    kind: 'root',
    projectName: 'acme',
    dropTools: [KNOWLEDGE_TOOL_NAME],
    resolvers: ALL_CONTENT,
    expectParts: ['persona', 'instructionFile', 'projectPrompt', 'projectMemory']
  },
  {
    name: 'work-root-trim-rules',
    description:
      'work root; instruction content keeps its surrounding whitespace verbatim (createAgent does not trim it — the desktop resolver trims before returning), project prompt / memory are trimmed, a whitespace-only knowledge guide is skipped',
    profile: 'work',
    kind: 'root',
    projectName: 'acme',
    resolvers: {
      instruction: { filename: 'AGENTS.md', content: '\n  # AGENTS.md\n\nUse pnpm.\n\n' },
      projectPrompt: `\n\n  ${PROJECT_PROMPT}  \n\n`,
      knowledgeBases: ' \n\t \n',
      projectMemory: `\n${PROJECT_MEMORY}\n\n`
    },
    expectParts: ['persona', 'instructionFile', 'projectPrompt', 'projectMemory']
  },
  {
    name: 'work-root-zh',
    description: 'work root with the zh profile body and zh visual guide; all four injections',
    profile: 'work',
    kind: 'root',
    language: 'zh',
    projectName: 'acme',
    resolvers: ALL_CONTENT,
    expectParts: ALL_FENCES
  },
  {
    name: 'chat-root-no-injections',
    description: 'chat root (no project, temp workspace); every seam returns null',
    profile: 'chat',
    kind: 'root',
    cwd: CHAT_CWD,
    resolvers: ALL_NULL,
    expectParts: ['persona']
  },
  {
    name: 'chat-root-no-seams',
    description: 'chat root; the host implements none of the four injection seams',
    profile: 'chat',
    kind: 'root',
    cwd: CHAT_CWD,
    resolvers: {},
    expectParts: ['persona']
  },
  {
    name: 'chat-root-instruction-and-knowledge',
    description:
      'chat root; instruction file and knowledge bases resolve, project-derived seams return null (no project)',
    profile: 'chat',
    kind: 'root',
    cwd: CHAT_CWD,
    resolvers: { ...ALL_NULL, instruction: INSTRUCTION, knowledgeBases: KNOWLEDGE_GUIDE },
    expectParts: ['persona', 'instructionFile', 'knowledgeBases']
  },
  {
    name: 'chat-root-drawing-skill-disabled',
    description:
      'chat root with the drawing skill disabled: {{shuvix:visualGuide}} renders empty and its blank lines collapse',
    profile: 'chat',
    kind: 'root',
    cwd: CHAT_CWD,
    drawingSkillDisabled: true,
    resolvers: ALL_NULL,
    expectParts: ['persona']
  },
  {
    name: 'notebook-root-all-resolvers',
    description:
      'notebook root; every seam has content, but notebook declares no instruction files and no `knowledge` tool, so only project prompt + memory land',
    profile: 'notebook',
    kind: 'root',
    projectName: 'acme',
    notebookPath: 'notes/plan.md',
    resolvers: ALL_CONTENT,
    expectParts: ['persona', 'projectPrompt', 'projectMemory']
  },
  {
    name: 'bot-root-bot-profile',
    description: 'bot root; systemContext carries renderBotContext output, every seam returns null',
    profile: 'bot',
    kind: 'root',
    cwd: CHAT_CWD,
    resolvers: ALL_NULL,
    systemContext: [BOT_CONTEXT],
    expectParts: ['persona', 'systemContext']
  },
  {
    name: 'bot-root-all-injections',
    description:
      'bot root in a project; all seams have content (bot declares no instruction files) plus the bot profile block last',
    profile: 'bot',
    kind: 'root',
    projectName: 'acme',
    resolvers: ALL_CONTENT,
    systemContext: [BOT_CONTEXT],
    expectParts: ['persona', 'projectPrompt', 'knowledgeBases', 'projectMemory', 'systemContext']
  },
  {
    name: 'bot-root-empty-body',
    description:
      'bot root; bot md with an empty body and displayName equal to name (fence still present)',
    profile: 'bot',
    kind: 'root',
    cwd: CHAT_CWD,
    resolvers: ALL_NULL,
    systemContext: [BOT_CONTEXT_EMPTY_BODY],
    expectParts: ['persona', 'systemContext']
  },
  {
    name: 'coding-root-all-injections',
    description:
      'coding as the root of a sub-session (session tool agent_profile); all four injections',
    profile: 'coding',
    kind: 'root',
    projectName: 'acme',
    toolOverlay: ['mcp:ssh'],
    resolvers: ALL_CONTENT,
    expectParts: ALL_FENCES
  },
  {
    name: 'coding-spawned-no-injections',
    description: 'coding spawned through the dispatch tool (cwd ""); every seam returns null',
    profile: 'coding',
    kind: 'spawned',
    resolvers: ALL_NULL,
    expectParts: ['persona']
  },
  {
    name: 'coding-spawned-all-injections',
    description:
      'coding spawned; all four injections resolve against the root session (seams get the root session id)',
    profile: 'coding',
    kind: 'spawned',
    resolvers: ALL_CONTENT,
    expectParts: ALL_FENCES
  },
  {
    name: 'coding-spawned-system-context-blocks',
    description:
      'coding spawned with caller systemContext blocks: each block is trimmed, a whitespace-only block is skipped',
    profile: 'coding',
    kind: 'spawned',
    resolvers: ALL_NULL,
    systemContext: [
      '  <caller_note>\nfirst block\n</caller_note>\n',
      '   \n ',
      '<caller_note>second block</caller_note>'
    ],
    expectParts: ['persona', 'systemContext', 'systemContext']
  }
]

// ── 围栏：照抄 createAgent.ts 的四个围栏函数（拆分据此重算，再与真实输出对等式）──

const fenceInstructionFile = (filename: string, content: string): string =>
  `<project_instructions file="${filename}">\n${content}\n</project_instructions>`
const fenceProjectPrompt = (text: string): string => `<project_prompt>\n${text}\n</project_prompt>`
const fenceProjectMemory = (text: string): string => `<project_memory>\n${text}\n</project_memory>`
const fenceKnowledgeBases = (text: string): string =>
  `<knowledge_bases>\n${text}\n</knowledge_bases>`

interface Part {
  name: PartName
  text: string
}

/** 按 createAgent 的规则（门、trim、固定次序）从输入重算每一段追加块 */
function expectedAppendedParts(
  profile: InProcessAgentType,
  resolvers: ResolverSpec,
  systemContext: readonly string[]
): Part[] {
  const parts: Part[] = []
  if (profile.instructionFiles?.length && resolvers.instruction?.content) {
    parts.push({
      name: 'instructionFile',
      text: fenceInstructionFile(resolvers.instruction.filename, resolvers.instruction.content)
    })
  }
  if (profile.projectAwareness) {
    const text = resolvers.projectPrompt?.trim()
    if (text) parts.push({ name: 'projectPrompt', text: fenceProjectPrompt(text) })
  }
  if (profile.tools.includes(KNOWLEDGE_TOOL_NAME)) {
    const text = resolvers.knowledgeBases?.trim()
    if (text) parts.push({ name: 'knowledgeBases', text: fenceKnowledgeBases(text) })
  }
  if (profile.projectAwareness) {
    const text = resolvers.projectMemory?.trim()
    if (text) parts.push({ name: 'projectMemory', text: fenceProjectMemory(text) })
  }
  for (const block of systemContext) {
    const text = block.trim()
    if (text) parts.push({ name: 'systemContext', text })
  }
  return parts
}

function loadProfile(c: GoldenCase): InProcessAgentType {
  const built = buildBuiltinProfile(SPECS[c.profile], {
    language: c.language ?? 'en',
    readMd: createInlineMdReader()
  })
  if (!built) throw new Error(`builtin profile "${c.profile}" did not build`)
  const profile = toInProcessAgentType(built)
  if (c.dropTools?.length) {
    profile.tools = profile.tools.filter((t) => !c.dropTools!.includes(t))
  }
  return profile
}

/** 桌面 desktopPromptVars 的形状（apps/desktop/src/main/agents/agentHost.ts），标量取固定值 */
function promptVarsFor(c: GoldenCase, ctx: PromptVarsCtx): PromptVars {
  const language = c.language ?? 'en'
  const visual = {
    drawingSkill: !c.drawingSkillDisabled && ctx.toolNames.includes(DRAWING_SKILL),
    artifact: ctx.toolNames.includes('artifact'),
    // 桌面：只有根 agent 的回复显示成对话（且不是 Chrome 标签页会话）
    interactive: ctx.kind === 'root'
  }
  const gitCwd = ctx.cwd || PROCESS_CWD
  return {
    workingDirectory: ctx.cwd,
    isGitRepo: GIT_DIRS.has(gitCwd) ? 'Yes' : 'No',
    platform: 'darwin',
    shell: 'bash',
    shellTool: 'bash',
    os: 'Darwin 25.0.0',
    date: '2026-10-04',
    language: formatLanguageDisplay(language),
    appVersion: '0.9.0-golden',
    visualGuide: renderVisualGuide(language, visual),
    visualCraft: renderVisualCraft(language, visual),
    projectName: c.projectName ?? '',
    ...(ctx.kind === 'root' ? { notebookPath: c.notebookPath ?? '' } : {})
  }
}

interface Capture {
  promptVarsCtx?: PromptVarsCtx
  promptVars?: PromptVars
  resolverCalls: Record<string, unknown[]>
  warnings: string[]
}

function makeHost(c: GoldenCase, capture: Capture): AgentHostAdapter {
  const record =
    <A extends unknown[], R>(name: string, value: R) =>
    (...args: A): R => {
      capture.resolverCalls[name] = args.map((a) => (Array.isArray(a) ? [...a] : a))
      return value
    }
  const r = c.resolvers
  const host: AgentHostAdapter = {
    resolveTools: async () => [],
    promptVars: (ctx) => {
      const vars = promptVarsFor(c, ctx)
      capture.promptVarsCtx = { ...ctx, toolNames: [...ctx.toolNames] }
      capture.promptVars = vars
      return vars
    },
    buildModel: (cfg) => ({ provider: cfg.provider, id: cfg.model }) as unknown as Model<Api>,
    getApiKey: () => undefined,
    openSessionTree: async () => ({}) as Session,
    eventSink: { broadcast: () => {}, hasUserInputCapability: () => true },
    logger: {
      info: () => {},
      warn: (msg) => capture.warnings.push(`warn: ${msg}`),
      error: (msg) => capture.warnings.push(`error: ${msg}`)
    }
  }
  if (r.instruction !== undefined)
    host.resolveInstruction = record('resolveInstruction', r.instruction)
  if (r.projectPrompt !== undefined)
    host.resolveProjectPrompt = record('resolveProjectPrompt', r.projectPrompt)
  if (r.knowledgeBases !== undefined)
    host.resolveKnowledgeBases = record('resolveKnowledgeBases', r.knowledgeBases)
  if (r.projectMemory !== undefined)
    host.resolveProjectMemory = record('resolveProjectMemory', r.projectMemory)
  return host
}

function resolverInputs(r: ResolverSpec): Record<string, unknown> {
  const one = (implemented: boolean, value: unknown): unknown =>
    implemented ? { implemented: true, returns: value } : { implemented: false }
  return {
    resolveInstruction: one(r.instruction !== undefined, r.instruction ?? null),
    resolveProjectPrompt: one(r.projectPrompt !== undefined, r.projectPrompt ?? null),
    resolveKnowledgeBases: one(r.knowledgeBases !== undefined, r.knowledgeBases ?? null),
    resolveProjectMemory: one(r.projectMemory !== undefined, r.projectMemory ?? null)
  }
}

async function captureCase(c: GoldenCase): Promise<Record<string, unknown>> {
  harness.constructed.length = 0
  const profile = loadProfile(c)
  const capture: Capture = { resolverCalls: {}, warnings: [] }
  const host = makeHost(c, capture)
  const params: CreateAgentParams =
    c.kind === 'root'
      ? {
          kind: 'root',
          sessionId: ROOT_SID,
          profile,
          model: MODEL_CFG,
          thinkingLevel: 'medium',
          cwd: c.cwd ?? PROJECT_CWD,
          toolOverlay: c.toolOverlay ?? [],
          systemContext: c.systemContext
        }
      : {
          kind: 'spawned',
          sessionId: SUB_AGENT_ID,
          profile,
          model: MODEL_CFG,
          thinkingLevel: 'off',
          cwd: '',
          spawn: {
            agentId: SUB_AGENT_ID,
            depth: 1,
            parentAgentId: ROOT_SID,
            rootSessionId: ROOT_SID,
            modelConfig: MODEL_CFG,
            canSpawn: true
          },
          spawnHelpers: {},
          systemContext: c.systemContext
        }

  const created = await createAgentFactory(host).createAgent(params)
  created.dispose()
  const output = created.systemPrompt

  // 交给 harness 的就是这一份
  expect(harness.constructed).toHaveLength(1)
  expect(harness.constructed[0].systemPrompt).toBe(output)

  // persona = 档案正文经变量表渲染；之后每段按围栏重算
  expect(capture.promptVars, 'promptVars must be consulted exactly once').toBeDefined()
  const persona = renderProfileSystemPrompt(profile, capture.promptVars!)
  const parts: Part[] = [
    { name: 'persona', text: persona },
    ...expectedAppendedParts(profile, c.resolvers, c.systemContext ?? [])
  ]
  expect(parts.map((p) => p.name)).toEqual(c.expectParts)
  expect(parts.map((p) => p.text).join('\n\n')).toBe(output)
  expect(capture.warnings, 'no unknown placeholders in builtin bodies').toEqual([])

  return {
    case: c.name,
    description: c.description,
    capturedFrom:
      'createAgentFactory(fakeHost).createAgent() on @earendil-works/pi-agent-core 0.80.10 (P1-00, before the pi-durable cutover)',
    inputs: {
      kind: c.kind,
      sessionId: params.sessionId,
      rootSessionId: ROOT_SID,
      cwd: params.cwd,
      language: c.language ?? 'en',
      profile: {
        name: profile.name,
        displayName: profile.displayName,
        tools: profile.tools,
        droppedTools: c.dropTools ?? [],
        instructionFiles: profile.instructionFiles ?? [],
        projectAwareness: profile.projectAwareness ?? false,
        systemPrompt: profile.systemPrompt
      },
      toolOverlay: c.toolOverlay ?? [],
      promptVars: capture.promptVars,
      resolvers: resolverInputs(c.resolvers),
      systemContext: c.systemContext ?? []
    },
    observed: {
      promptVarsCtx: capture.promptVarsCtx,
      resolverCalls: capture.resolverCalls,
      warnings: capture.warnings
    },
    output,
    parts
  }
}

describe.skipIf(!CAPTURE)('P1-00 system prompt golden capture (SHUVIX_CAPTURE_GOLDEN=1)', () => {
  it('case names are unique and file-safe', () => {
    const names = CASES.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]+$/)
  })

  it('captures every case and writes the fixtures', async () => {
    const fixtures: Array<[string, Record<string, unknown>]> = []
    for (const c of CASES) fixtures.push([c.name, await captureCase(c)])

    mkdirSync(FIXTURE_DIR, { recursive: true })
    for (const file of readdirSync(FIXTURE_DIR)) {
      if (file.endsWith('.json')) rmSync(join(FIXTURE_DIR, file))
    }
    for (const [name, fixture] of fixtures) {
      writeFileSync(join(FIXTURE_DIR, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`)
    }
    expect(readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'))).toHaveLength(CASES.length)
  })
})
