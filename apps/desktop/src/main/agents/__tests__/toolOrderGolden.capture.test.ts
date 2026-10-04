/**
 * P1-00 golden capture —— 桌面 `resolveTools`（agentHost.ts 的 resolveDesktopTools）今天交给 agent 的
 * **工具名顺序**，供 pi-durable 迁移（内置工具进 `shuvix.builtin` 扩展、技能 / 派发 / next / MCP 进
 * `shuvix.agent.<conversationId>` 扩展）对照。
 *
 * **只在 `SHUVIX_CAPTURE_GOLDEN=1` 时运行并写文件**，平时整组跳过：
 *
 *   SHUVIX_CAPTURE_GOLDEN=1 npx vitest run --root apps/desktop \
 *     apps/desktop/src/main/agents/__tests__/toolOrderGolden.capture.test.ts
 *
 * 写到 `fixtures/tool-order/<case>.json`（先清掉旧的 .json）。每份记 `inputs`（平台、kind、档案的
 * `shuvix-tools`、会话 overlay、归一后交给 resolveTools 的 `names`、MCP 服务器的工具表 / 连接结果、
 * 技能在不在架、项目路径、extraTools）、`observed`（SkillTool 的构造实参、MCP 的连接 / 取工具调用、
 * 广播、包装器拿到的 spill）与 `output.toolNames`。
 *
 * 脚手架同 platformToolResolution.test.ts：顶掉 `createAgentFactory` 接住 agentHost 交出的适配面；
 * 注册表用**真的**（平台过滤就是 `isToolOnPlatform` 那一条），往里注册与真实注册项同名、同平台声明的
 * 桩工厂（真工具模块会拖进 bgTaskService / toolContext / SQLite）；SkillTool / AgentTool / mcpService
 * 是可观察的桩，包装器走恒等。名单归一（createAgent 的 normalizeToolNames，未导出）在这里照抄一份，
 * 结果作为 `names` 记进 fixture。
 *
 * 本文件 import 了今天的 agentHost：P1-11 重写它之后改写或删掉；切换后仍要跑的是只读 fixture 的
 * `toolOrderGolden.test.ts`。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentHostAdapter, ToolResolveRequest } from '@shuvix/agent-runtime'

const CAPTURE = process.env.SHUVIX_CAPTURE_GOLDEN === '1'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tool-order')

interface McpServerSpec {
  /** 服务器交出的工具（不带 `mcp__<server>__` 前缀） */
  tools?: readonly string[]
  /** 连接失败的错误文本（给了就连不上） */
  fails?: string
}

const mocks = vi.hoisted(() => ({
  host: { value: undefined as AgentHostAdapter | undefined },
  hasSkills: true,
  mcp: {} as Record<string, McpServerSpec>,
  skillToolCalls: [] as Array<{ names: string[]; projectPath?: string }>,
  ensureCalls: [] as unknown[][],
  getToolsCalls: [] as unknown[][],
  broadcasts: [] as unknown[],
  wraps: [] as Array<{ name: string; sessionId: string; spill: unknown }>,
  sessionProject: undefined as { projectId: string } | undefined,
  project: undefined as { name: string; path: string } | undefined
}))

vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return {
    ...actual,
    createAgentFactory: (host: AgentHostAdapter) => {
      mocks.host.value = host
      return { createAgent: vi.fn() }
    }
  }
})

vi.mock('../../services/wrapToolOutput', () => ({
  getOutputStrategy: () => 'middle',
  wrapToolOutput: (
    tool: { name: string },
    sessionId: string,
    _strategy: unknown,
    overrides: { spill?: unknown } | undefined
  ) => {
    mocks.wraps.push({ name: tool.name, sessionId, spill: overrides?.spill })
    return tool
  }
}))
vi.mock('../../services/mcpService', () => ({
  mcpService: {
    // 已连上 = 不发 mcp_connecting（那是给占位卡看的，与工具顺序无关）
    statusByName: () => 'connected',
    ensureServerByName: async (server: string, opts: unknown) => {
      mocks.ensureCalls.push([server, opts])
      const spec = mocks.mcp[server]
      return spec?.fails ? { ok: false, error: spec.fails } : { ok: true }
    },
    getRegistrationsByServerName: (
      server: string,
      sessionId: string,
      opts?: { callerIdOf?: (conversationId: number) => string | undefined }
    ) => {
      // 记成捕获时（P1-00，旧取工具接口的 `{ callerId }` 选项）的形状，fixture 才对得上：
      // P1-05 起调用方 id 按对话现问，这张工具表只属于一个 agent，问根对话（1）就是它
      mocks.getToolsCalls.push([server, sessionId, { callerId: opts?.callerIdOf?.(1) }])
      return (mocks.mcp[server]?.tools ?? []).map((t) => ({ name: `mcp__${server}__${t}` }))
    }
  }
}))
vi.mock('../../services/skillTool', () => ({
  SkillTool: class {
    readonly name = 'skill'
    constructor(names: string[], projectPath?: string) {
      mocks.skillToolCalls.push({ names: [...names], projectPath })
    }
    get hasSkills(): boolean {
      return mocks.hasSkills
    }
  }
}))
vi.mock('../../services/skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../AgentTool', () => ({ createAgentTool: () => ({ name: 'agent' }) }))

vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getPath: () => '/tmp/x' } }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pick: () => mocks.sessionProject, pickSettings: () => undefined }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => mocks.project } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/instruction', () => ({ resolveInstructionContent: vi.fn() }))
vi.mock('../../services/memory', () => ({ resolveProjectMemoryIndex: vi.fn() }))
vi.mock('../../frontend/core', () => ({
  chatFrontendRegistry: { broadcast: (event: unknown) => mocks.broadcasts.push(event) }
}))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: {},
  electronToolResultTransform: vi.fn(),
  runtimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: () => ({ sentinel: 'l1-gate' }),
  resolveProjectConfig: vi.fn()
}))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: () => [] }))

import { buildBuiltinProfiles } from '@shuvix/agent-runtime'
import { createInlineMdReader } from '@shuvix/agent-runtime/builtinAgents/inlineSources'
import type { ToolPlatform } from '@shuvix/chat-protocol/chatApi'
import { registerBuiltinTool, unregisterBuiltinTool } from '../../services/toolRegistry'
import { BASH_PLATFORMS, POWERSHELL_PLATFORMS } from '../../utils/toolUtils/shell'
import '../agentHost'

/**
 * 真实注册项的名字与平台声明（按 tools/allTools.ts 的导入次序；`skill` / `agent` 没有工厂，
 * 不走注册表 —— 由 SkillTool / 派发工具那两条路注入）。顺序本身不影响解析结果（解析按名单走）。
 */
const REGISTERED: { name: string; platforms?: readonly ToolPlatform[] }[] = [
  { name: 'bash', platforms: BASH_PLATFORMS },
  { name: 'powershell', platforms: POWERSHELL_PLATFORMS },
  { name: 'read' },
  { name: 'write' },
  { name: 'edit' },
  { name: 'ask' },
  { name: 'git' },
  { name: 'artifact' },
  { name: 'session' },
  { name: 'knowledge' },
  { name: 'doc_read' },
  { name: 'doc_edit' },
  { name: 'doc_insert' },
  { name: 'ls' },
  { name: 'grep' },
  { name: 'glob' }
]

const MCP_SERVERS: Record<string, McpServerSpec> = {
  ssh: { tools: ['list-hosts', 'exec', 'upload', 'download', 'sync'] },
  context7: { tools: ['resolve-library-id', 'get-library-docs'] },
  browser: { tools: ['list_tabs', 'open_tab', 'navigate', 'snapshot', 'click'] },
  chrome: { tools: ['list_tabs', 'navigate', 'snapshot', 'read_page', 'click'] },
  broken: { fails: 'spawn npx ENOENT' }
}

const ROOT_SID = 'sess-golden-root'
const SUB_AGENT_ID = 'sub-golden-1'
const PROJECT = { name: 'acme', path: '/Users/golden/projects/acme' }

type ProfileName = 'work' | 'chat' | 'coding' | 'bot' | 'notebook' | 'tab'

interface GoldenCase {
  name: string
  description: string
  profile: ProfileName
  kind: 'root' | 'spawned'
  platform: 'darwin' | 'win32'
  toolOverlay?: readonly string[]
  /** spawned 是否还能继续派发（depth < MAX_AGENT_DEPTH） */
  canSpawn?: boolean
  /** 已实例化的附加工具（派发结果契约的 next 等） */
  extraTools?: readonly string[]
  /** 会话属于项目（SkillTool 拿到 projectPath） */
  inProject?: boolean
  /** 这一次有没有技能可给（SkillTool.hasSkills）；缺省 true */
  hasSkills?: boolean
}

const CASES: readonly GoldenCase[] = [
  {
    name: 'work-root-darwin',
    description:
      'work root on macOS with two MCP servers and a user skill ticked (the drawing skill in the overlay dedupes against the profile)',
    profile: 'work',
    kind: 'root',
    platform: 'darwin',
    inProject: true,
    toolOverlay: ['mcp:context7', 'mcp:ssh', 'skill:pdf', 'skill:builtin:drawing']
  },
  {
    name: 'work-root-win32',
    description: 'same selection on Windows: powershell takes bash’s slot in the list',
    profile: 'work',
    kind: 'root',
    platform: 'win32',
    inProject: true,
    toolOverlay: ['mcp:context7', 'mcp:ssh', 'skill:pdf', 'skill:builtin:drawing']
  },
  {
    name: 'chat-root-darwin',
    description: 'chat root (no project) with the app browser and a user skill ticked',
    profile: 'chat',
    kind: 'root',
    platform: 'darwin',
    toolOverlay: ['mcp:browser', 'skill:pdf']
  },
  {
    name: 'coding-root-darwin',
    description: 'coding as a sub-session root, inheriting the parent’s ssh tick',
    profile: 'coding',
    kind: 'root',
    platform: 'darwin',
    inProject: true,
    toolOverlay: ['mcp:ssh']
  },
  {
    name: 'coding-spawned-darwin',
    description: 'coding spawned through the dispatch tool, still allowed to dispatch',
    profile: 'coding',
    kind: 'spawned',
    platform: 'darwin',
    inProject: true,
    canSpawn: true
  },
  {
    name: 'coding-spawned-depth-limit-with-next',
    description:
      'coding spawned at the depth limit (no `agent`) with the result-contract `next` as an extra tool (appended last)',
    profile: 'coding',
    kind: 'spawned',
    platform: 'darwin',
    inProject: true,
    canSpawn: false,
    extraTools: ['next']
  },
  {
    name: 'bot-root-darwin',
    description:
      'bot root: builtin names in the overlay (bash, write) are dropped by normalization, mcp:ssh is added',
    profile: 'bot',
    kind: 'root',
    platform: 'darwin',
    toolOverlay: ['mcp:ssh', 'bash', 'write']
  },
  {
    name: 'notebook-root-darwin',
    description: 'notebook root with a user skill ticked',
    profile: 'notebook',
    kind: 'root',
    platform: 'darwin',
    inProject: true,
    toolOverlay: ['skill:pdf']
  },
  {
    name: 'tab-root-darwin',
    description:
      'Chrome tab session root: profile declares mcp:chrome; no `read`, so tool output is not spilled',
    profile: 'tab',
    kind: 'root',
    platform: 'darwin'
  },
  {
    name: 'work-root-mcp-failure-no-skills',
    description:
      'work root: one MCP server fails to connect (skipped, error broadcast) and no skill is available (no `skill` tool)',
    profile: 'work',
    kind: 'root',
    platform: 'darwin',
    inProject: true,
    hasSkills: false,
    toolOverlay: ['mcp:broken', 'mcp:ssh']
  }
]

const PROFILES = new Map(
  buildBuiltinProfiles({
    language: 'en',
    widgetsRoot: '/Users/golden/.shuvix/widgets',
    readMd: createInlineMdReader()
  }).map((p) => [p.name, p])
)

const isSessionScopedTool = (name: string): boolean =>
  name.startsWith('mcp:') || name.startsWith('skill:')

/** createAgent.ts normalizeToolNames 的照抄（未导出） */
function normalizeToolNames(
  kind: 'root' | 'spawned',
  profileTools: readonly string[],
  overlay: readonly string[]
): string[] {
  const added = kind === 'root' ? overlay.filter(isSessionScopedTool) : overlay
  return [...new Set([...profileTools, ...added])]
}

const REAL_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM_DESC, value: platform })
}

async function captureCase(c: GoldenCase): Promise<Record<string, unknown>> {
  const profile = PROFILES.get(c.profile)
  if (!profile) throw new Error(`builtin profile "${c.profile}" did not build`)
  mocks.hasSkills = c.hasSkills ?? true
  mocks.mcp = MCP_SERVERS
  mocks.skillToolCalls.length = 0
  mocks.ensureCalls.length = 0
  mocks.getToolsCalls.length = 0
  mocks.broadcasts.length = 0
  mocks.wraps.length = 0
  mocks.sessionProject = c.inProject ? { projectId: 'proj-golden' } : undefined
  mocks.project = c.inProject ? PROJECT : undefined
  setPlatform(c.platform)

  // spawned 没有选择器也没有会话设置：overlay 恒为空
  const overlay = c.kind === 'root' ? (c.toolOverlay ?? []) : []
  const names = normalizeToolNames(c.kind, profile.tools, overlay)
  const selfSessionId = c.kind === 'root' ? ROOT_SID : SUB_AGENT_ID
  const extraTools = (c.extraTools ?? []).map((name) => ({ name }))

  const host = mocks.host.value
  expect(host, 'agentHost should hand its adapter to createAgentFactory').toBeDefined()
  const tools = await host!.resolveTools({
    kind: c.kind,
    rootSessionId: ROOT_SID,
    selfSessionId,
    profile: { name: profile.name } as ToolResolveRequest['profile'],
    names,
    getModelConfig: () => ({
      provider: 'golden-provider',
      model: 'golden-model',
      capabilities: {}
    }),
    spawn:
      c.kind === 'spawned'
        ? {
            agentId: SUB_AGENT_ID,
            depth: 1,
            parentAgentId: ROOT_SID,
            rootSessionId: ROOT_SID,
            modelConfig: { provider: 'golden-provider', model: 'golden-model', capabilities: {} },
            canSpawn: c.canSpawn ?? true
          }
        : undefined,
    extraTools: extraTools.length
      ? (extraTools as unknown as ToolResolveRequest['extraTools'])
      : undefined
  })
  const toolNames = tools.map((tool) => (tool as { name: string }).name)

  // 每个交出去的工具都过了一次包装器，且 spill 恒为「名单里有 read」
  expect(mocks.wraps.map((w) => w.name)).toEqual(toolNames)
  const spill = names.includes('read')
  for (const wrap of mocks.wraps) {
    expect(wrap.spill).toBe(spill)
    expect(wrap.sessionId).toBe(ROOT_SID)
  }

  const usedServers = names.filter((n) => n.startsWith('mcp:')).map((n) => n.slice(4))
  return {
    case: c.name,
    description: c.description,
    capturedFrom:
      'apps/desktop agentHost resolveTools (resolveDesktopTools) on the pi 0.80.10 AgentHarness runtime (P1-00, before the pi-durable cutover)',
    inputs: {
      platform: c.platform,
      kind: c.kind,
      rootSessionId: ROOT_SID,
      selfSessionId,
      canSpawn: c.kind === 'spawned' ? (c.canSpawn ?? true) : null,
      profile: c.profile,
      profileTools: profile.tools,
      toolOverlay: overlay,
      names,
      extraTools: c.extraTools ?? [],
      projectPath: c.inProject ? PROJECT.path : null,
      skillsAvailable: c.hasSkills ?? true,
      mcpServers: Object.fromEntries(usedServers.map((s) => [s, MCP_SERVERS[s] ?? null])),
      registeredBuiltins: REGISTERED.map((r) => ({
        name: r.name,
        platforms: r.platforms ? [...r.platforms] : null
      }))
    },
    // 快照：这些数组在下一例开头会被清空复用
    observed: structuredClone({
      skillToolConstructed: mocks.skillToolCalls,
      mcpEnsureCalls: mocks.ensureCalls,
      mcpGetToolsCalls: mocks.getToolsCalls,
      broadcasts: mocks.broadcasts,
      spill
    }),
    output: { toolNames }
  }
}

describe.skipIf(!CAPTURE)('P1-00 tool-order golden capture (SHUVIX_CAPTURE_GOLDEN=1)', () => {
  beforeAll(() => {
    for (const r of REGISTERED) {
      registerBuiltinTool({
        name: r.name,
        group: 'general',
        platforms: r.platforms,
        getLabel: () => r.name,
        getHint: () => r.name,
        factory: () => ({ name: r.name })
      })
    }
  })

  afterAll(() => {
    for (const r of REGISTERED) unregisterBuiltinTool(r.name)
    Object.defineProperty(process, 'platform', REAL_PLATFORM_DESC)
  })

  it('case names are unique and file-safe', () => {
    const names = CASES.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z0-9-]+$/)
  })

  it('captures every case and writes the fixtures', async () => {
    const fixtures: Array<[string, Record<string, unknown>]> = []
    for (const c of CASES) fixtures.push([c.name, await captureCase(c)])
    Object.defineProperty(process, 'platform', REAL_PLATFORM_DESC)

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
