/**
 * P1-00 工具名顺序 golden fixture 的**重放**（P1-11，H11-64…66）—— 旧 agentHost 的 resolveTools 在
 * pi 0.80 上捕获的那十份，经新的桌面 ToolHost + 运行时的锁拼法（`composeAgentTools`）重放：
 *
 *   composeAgentTools({ names, builtin: buildBuiltinTools(...), set: resolveAgentTools(...) }).toolNames
 *     === fixture.output.toolNames
 *
 * 以及旁证：SkillTool 的构造实参、MCP 的连接实参、调用方 id、错误广播都与捕获时一致（H11-64）；按派生出的
 * 锁重建再拼一次，工具名一字不差、一次都不连（H11-65）。
 *
 * 两份派生 agent 的 fixture（H11-66）在 P2-04 接上（docs/pi-durable/p2-04-test-design.md，P2-04-28…31）：
 * 派生请求（根会话 + agentId + canSpawn）经同一个 ToolHost 解析，`next` 用运行时真造的那一个
 * （`resultContractTools`，PIN-08），拼的时候显式带上附加工具；再按派生出的记录重建，工具名不变、一次都不连。
 *
 * 只读 fixture 的常驻自检 `toolOrderGolden.test.ts` 照旧（H11-63）；捕获脚本已删（frozen：0.80 的依赖上才
 * 抓得出来）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationId } from '@earendil-works/pi-durable'

const mocks = vi.hoisted(() => ({
  hasSkills: true,
  skillToolCalls: [] as Array<{ names: string[]; projectPath?: string }>,
  mcp: {} as Record<string, { tools?: string[]; fails?: string } | null>,
  ensure: vi.fn(),
  declarationsOf: vi.fn(),
  registrationsFromDeclarations: vi.fn(),
  broadcast: vi.fn(),
  project: undefined as { path: string } | undefined
}))

vi.mock('../../services/skillTool', () => ({
  SkillTool: class {
    readonly name = 'skill'
    readonly description = 'skill: stub'
    private readonly names: string[]
    constructor(names: string[], projectPath?: string, shelf?: string) {
      this.names = [...names]
      // 按锁重建（shelf 'known'）的那一次不算进「创建时的构造实参」
      if (shelf !== 'known') mocks.skillToolCalls.push({ names: [...names], projectPath })
    }
    get hasSkills(): boolean {
      return mocks.hasSkills
    }
    get skillNames(): string[] {
      return mocks.hasSkills ? [...this.names] : []
    }
  }
}))
vi.mock('../../services/mcpService', () => ({
  mcpService: {
    // 已连上 = 不发 mcp_connecting（捕获时也是这样，那是给占位卡看的，与工具顺序无关）
    statusByName: () => 'connected',
    ensureServerByName: mocks.ensure,
    declarationsOf: mocks.declarationsOf,
    registrationsFromDeclarations: mocks.registrationsFromDeclarations,
    getRegistrationsByServerName: vi.fn()
  }
}))
vi.mock('../../services/skillService', () => ({
  skillService: { findEnabled: () => [], findAll: () => [] }
}))
vi.mock('../../services/wrapToolOutput', () => ({ wrapDurableTool: (tool: object) => tool }))
vi.mock('../AgentTool', () => ({ createAgentTool: () => ({ name: 'agent' }) }))
vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getPath: () => '/tmp/x' } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: {
    pick: () => (mocks.project ? { projectId: 'proj-golden' } : undefined),
    pickSettings: () => undefined
  }
}))
vi.mock('../../dao/projectDao', () => ({
  projectDao: {
    pick: () => (mocks.project ? { name: 'acme', path: mocks.project.path } : undefined)
  }
}))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/instruction', () => ({ resolveInstructionContent: vi.fn() }))
vi.mock('../../services/memory', () => ({ resolveProjectMemoryIndex: vi.fn() }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: mocks.broadcast } }))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: {},
  runtimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: vi.fn(),
  resolveProjectConfig: vi.fn()
}))
vi.mock('../../services/userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../services/sandbox', () => ({ sandboxGloballyActive: () => false }))
vi.mock('../../services/botService', () => ({ botService: { forSession: () => null } }))
vi.mock('../../utils/toolUtils/fileTime', () => ({ recordRead: vi.fn() }))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: () => [] }))

import {
  composeAgentTools,
  type AgentToolSet,
  type LockRecord,
  type McpRegistrationOptions,
  type McpToolDeclaration,
  type SpawnedAgentRecord
} from '@shuvix/agent-runtime'
import type { ToolPlatform } from '@shuvix/chat-protocol/chatApi'
import { registerBuiltinTool, unregisterBuiltinTool } from '../../services/toolRegistry'
import { createDesktopToolHost } from '../agentHost'
import {
  NX,
  S,
  SP_D,
  decl,
  inProcess,
  lockD,
  mcpRegistration,
  profileOf,
  rctx,
  requestD,
  restorePlatform,
  setPlatform,
  stubTool
} from './support/toolHostFixtures'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/tool-order')

/** 捕获时的用例数；少于它说明有 fixture 丢了 */
const MIN_FIXTURES = 10

interface ToolOrderFixture {
  case: string
  inputs: {
    platform: string
    kind: 'root' | 'spawned'
    rootSessionId: string
    selfSessionId: string
    /** 派生 agent 还能不能再派生（只有 spawned 的 fixture 带） */
    canSpawn?: boolean
    profile: string
    names: string[]
    extraTools: string[]
    projectPath: string | null
    skillsAvailable: boolean
    mcpServers: Record<string, { tools?: string[]; fails?: string } | null>
    registeredBuiltins: Array<{ name: string; platforms: string[] | null }>
  }
  observed: {
    skillToolConstructed: Array<{ names: string[]; projectPath?: string }>
    mcpEnsureCalls: unknown[][]
    mcpGetToolsCalls: Array<[string, string, { callerId?: string }]>
    broadcasts: Array<{ type: string; sessionId: string }>
  }
  output: { toolNames: string[] }
}

const fixtures: ToolOrderFixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf-8')) as ToolOrderFixture)

const roots = fixtures.filter((f) => f.inputs.kind === 'root')
const spawned = fixtures.filter((f) => f.inputs.kind === 'spawned')

let registered: string[] = []

/** 按 fixture 的输入布置：注册表、平台、技能在不在架、MCP 服务器、项目 */
function arrange(fixture: ToolOrderFixture): void {
  const { inputs } = fixture
  for (const r of inputs.registeredBuiltins) {
    registerBuiltinTool({
      name: r.name,
      group: 'general',
      platforms: (r.platforms ?? undefined) as readonly ToolPlatform[] | undefined,
      getLabel: () => r.name,
      getHint: () => r.name,
      factory: () => stubTool(r.name)
    })
    registered.push(r.name)
  }
  setPlatform(inputs.platform)
  mocks.hasSkills = inputs.skillsAvailable
  mocks.mcp = inputs.mcpServers
  mocks.project = inputs.projectPath ? { path: inputs.projectPath } : undefined
}

beforeEach(() => {
  mocks.skillToolCalls.length = 0
  mocks.broadcast.mockReset()
  mocks.ensure.mockReset().mockImplementation(async (server: string) => {
    const spec = mocks.mcp[server]
    return spec?.fails ? { ok: false, error: spec.fails } : { ok: true }
  })
  mocks.declarationsOf
    .mockReset()
    .mockImplementation((server: string) =>
      (mocks.mcp[server]?.tools ?? []).map((name) => decl(name, false))
    )
  mocks.registrationsFromDeclarations
    .mockReset()
    .mockImplementation((server: string, _sid: string, decls: readonly McpToolDeclaration[]) =>
      decls.map((d) => mcpRegistration(server, d))
    )
})

afterEach(() => {
  for (const name of registered) unregisterBuiltinTool(name)
  registered = []
  restorePlatform()
})

const host = createDesktopToolHost({ sessionOf: () => undefined })

async function replay(fixture: ToolOrderFixture): Promise<{
  toolNames: string[]
  lock: LockRecord
}> {
  const { inputs } = fixture
  const builtin = await host.buildBuiltinTools({
    sessionId: inputs.rootSessionId,
    sandboxed: false
  })
  const resolved = await host.resolveAgentTools(
    requestD({
      sessionId: inputs.rootSessionId,
      rootSessionId: inputs.rootSessionId,
      selfSessionId: inputs.selfSessionId,
      profile: inProcess(profileOf(inputs.profile)),
      names: inputs.names
    }),
    { signal: new AbortController().signal }
  )
  const composed = composeAgentTools({ names: inputs.names, builtin, set: resolved })
  const mcp: LockRecord['mcp'] = {}
  for (const entry of resolved.mcp ?? []) mcp[entry.server] = [...entry.declarations]
  const lock = lockD({
    profileName: inputs.profile,
    toolNames: composed.toolNames,
    mcp,
    skills: [...(resolved.skills ?? [])],
    sandboxed: resolved.sandboxed
  })
  return { toolNames: composed.toolNames, lock }
}

/** 派生 agent 的重放：派生请求解析 → 显式带附加工具拼 → 派生出记录（P2-04-28…30） */
async function replaySpawned(fixture: ToolOrderFixture): Promise<{
  toolNames: string[]
  resolved: AgentToolSet
  record: SpawnedAgentRecord
}> {
  const { inputs } = fixture
  const builtin = await host.buildBuiltinTools({ sessionId: inputs.rootSessionId, sandboxed: false })
  const withNext = inputs.extraTools.includes('next')
  const resolved = await host.resolveAgentTools(
    requestD({
      kind: 'spawned',
      sessionId: inputs.rootSessionId,
      rootSessionId: inputs.rootSessionId,
      selfSessionId: inputs.selfSessionId,
      agentId: inputs.selfSessionId,
      canSpawn: inputs.canSpawn,
      profile: inProcess(profileOf(inputs.profile)),
      names: inputs.names,
      // fixture 只记了名字：`next` 用运行时真造的那一个（PIN-08）
      extraTools: inputs.extraTools.map((name) => (name === 'next' ? NX() : stubTool(name)))
    }),
    { signal: new AbortController().signal }
  )
  const composed = composeAgentTools({
    names: inputs.names,
    builtin,
    set: resolved,
    extraTools: resolved.extraTools
  })
  const mcp: LockRecord['mcp'] = {}
  for (const entry of resolved.mcp ?? []) mcp[entry.server] = [...entry.declarations]
  const record = SP_D({
    profileName: inputs.profile,
    toolNames: composed.toolNames,
    skills: [...(resolved.skills ?? [])],
    mcp,
    sandboxed: resolved.sandboxed,
    agentId: inputs.selfSessionId,
    canSpawn: inputs.canSpawn === true,
    ...(withNext ? { resultContract: { schema: S } } : {})
  })
  if (!withNext) delete record.resultContract
  return { toolNames: composed.toolNames, resolved, record }
}

/** 两份派生 fixture 的用例编号 */
const SPAWNED_IDS: Record<string, string> = {
  'coding-spawned-darwin': 'P2-04-28',
  'coding-spawned-depth-limit-with-next': 'P2-04-29'
}

describe('tool-order golden fixtures —— 经新 ToolHost 重放（P1-11）', () => {
  it('P2-04-31（改写 H11-66 覆盖）：重放的根 agent（8）+ 重放的派生 agent（2）= 全部 fixture（≥ 10）；本文件不再留 todo', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(MIN_FIXTURES)
    expect(roots.length).toBe(8)
    expect(spawned.length).toBe(2)
    expect(roots.length + spawned.length).toBe(fixtures.length)
    expect(Object.keys(SPAWNED_IDS).sort()).toEqual(spawned.map((f) => f.case).sort())
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf-8')
    expect(source).not.toContain(['it', 'todo('].join('.'))
  })

  it.each(roots.map((f) => [f.case, f] as const))(
    'H11-64 %s：拼出来的工具名 = 捕获的；SkillTool / MCP 连接 / 调用方 id / 错误广播与捕获时一致',
    async (_name, fixture) => {
      arrange(fixture)
      const { toolNames } = await replay(fixture)
      expect(toolNames).toEqual(fixture.output.toolNames)

      expect(mocks.skillToolCalls).toEqual(
        fixture.observed.skillToolConstructed.map((c) => ({
          names: c.names,
          projectPath: c.projectPath ?? undefined
        }))
      )
      expect(mocks.ensure.mock.calls).toEqual(fixture.observed.mcpEnsureCalls)

      const registrations = mocks.registrationsFromDeclarations.mock.calls
      expect(registrations).toHaveLength(fixture.observed.mcpGetToolsCalls.length)
      fixture.observed.mcpGetToolsCalls.forEach(([server, sessionId, { callerId }], i) => {
        const [gotServer, gotSession, , opts] = registrations[i] as [
          string,
          string,
          unknown,
          McpRegistrationOptions
        ]
        expect([gotServer, gotSession]).toEqual([server, sessionId])
        // 根对话（1）上问调用方 id —— 捕获时那张工具表只属于根 agent
        expect(opts.callerIdOf?.(1 as ConversationId)).toBe(callerId)
      })

      expect(
        mocks.broadcast.mock.calls.map(([e]) => ({ type: e.type, sessionId: e.sessionId }))
      ).toEqual(fixture.observed.broadcasts)
    }
  )

  it.each(roots.map((f) => [f.case, f] as const))(
    'H11-65 %s：按派生出的锁重建再拼，工具名一字不差，一次都不连',
    async (_name, fixture) => {
      arrange(fixture)
      const { toolNames, lock } = await replay(fixture)
      mocks.ensure.mockClear()
      const builtin = await host.buildBuiltinTools({
        sessionId: fixture.inputs.rootSessionId,
        sandboxed: lock.sandboxed
      })
      const rebuilt = await host.rebuildAgentTools(lock, {
        sessionId: fixture.inputs.rootSessionId
      })
      expect(
        composeAgentTools({ names: fixture.inputs.names, builtin, set: rebuilt }).toolNames
      ).toEqual(toolNames)
      expect(mocks.ensure).not.toHaveBeenCalled()
    }
  )

  it.each(spawned.map((f) => [SPAWNED_IDS[f.case], f.case, f] as const))(
    '%s H11-66 %s：派生 agent 拼出来的工具名 = 捕获的（agent 看 canSpawn、next 排最后）；SkillTool / MCP / 广播与捕获时一致',
    async (_id, _name, fixture) => {
      arrange(fixture)
      const { toolNames, resolved } = await replaySpawned(fixture)
      expect(toolNames).toEqual(fixture.output.toolNames)
      expect('agent' in resolved).toBe(fixture.inputs.canSpawn === true)
      expect(mocks.skillToolCalls).toEqual(
        fixture.observed.skillToolConstructed.map((c) => ({
          names: c.names,
          projectPath: c.projectPath ?? undefined
        }))
      )
      expect(mocks.ensure.mock.calls).toEqual(fixture.observed.mcpEnsureCalls)
      expect(mocks.registrationsFromDeclarations.mock.calls).toHaveLength(
        fixture.observed.mcpGetToolsCalls.length
      )
      expect(
        mocks.broadcast.mock.calls.map(([e]) => ({ type: e.type, sessionId: e.sessionId }))
      ).toEqual(fixture.observed.broadcasts)
    }
  )

  it.each(spawned.map((f) => [f.case, f] as const))(
    'P2-04-30 %s：按派生出的记录重建再拼（附加工具来自 rctx），工具名一字不差，一次都不连',
    async (_name, fixture) => {
      arrange(fixture)
      const { toolNames, record } = await replaySpawned(fixture)
      mocks.ensure.mockClear()
      const builtin = await host.buildBuiltinTools({
        sessionId: fixture.inputs.rootSessionId,
        sandboxed: record.sandboxed
      })
      const rebuilt = await host.rebuildAgentTools(record, {
        ...rctx(record),
        sessionId: fixture.inputs.rootSessionId
      })
      expect(
        composeAgentTools({
          names: fixture.inputs.names,
          builtin,
          set: rebuilt,
          extraTools: rebuilt.extraTools
        }).toolNames
      ).toEqual(toolNames)
      expect(mocks.ensure).not.toHaveBeenCalled()
    }
  )
})
