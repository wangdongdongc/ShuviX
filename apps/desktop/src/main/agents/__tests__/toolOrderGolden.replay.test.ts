/**
 * P1-00 工具名顺序 golden fixture 的**重放**（P1-11，H11-64…66）—— 旧 agentHost 的 resolveTools 在
 * pi 0.80 上捕获的那十份，经新的桌面 ToolHost + 运行时的锁拼法（`composeAgentTools`）重放：
 *
 *   composeAgentTools({ names, builtin: buildBuiltinTools(...), set: resolveAgentTools(...) }).toolNames
 *     === fixture.output.toolNames
 *
 * 以及旁证：SkillTool 的构造实参、MCP 的连接实参、调用方 id、错误广播都与捕获时一致（H11-64）；按派生出的
 * 锁重建再拼一次，工具名一字不差、一次都不连（H11-65）。两份派生 agent 的 fixture 要等 phase 2（H11-66）。
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
  type LockRecord,
  type McpRegistrationOptions,
  type McpToolDeclaration
} from '@shuvix/agent-runtime'
import type { ToolPlatform } from '@shuvix/chat-protocol/chatApi'
import { registerBuiltinTool, unregisterBuiltinTool } from '../../services/toolRegistry'
import { createDesktopToolHost } from '../agentHost'
import {
  decl,
  inProcess,
  lockD,
  mcpRegistration,
  profileOf,
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

describe('tool-order golden fixtures —— 经新 ToolHost 重放（P1-11）', () => {
  it('H11-66 覆盖：重放的根 agent + 待 phase 2 的派生 agent = 全部 fixture（≥ 10）', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(MIN_FIXTURES)
    expect(roots.length + spawned.length).toBe(fixtures.length)
    expect(roots.length).toBe(8)
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

  for (const fixture of spawned) {
    it.todo(`H11-66 ${fixture.case}：派生 agent 的工具顺序（canSpawn / next）(pi-durable p2)`)
  }
})
