/**
 * P1-11 —— 桌面 ToolHost 的「真件模式」（Fx-WRAP real）：真包装器（落盘口写到临时 userData 下的
 * tool_results/<sid>/）、真 SkillTool、真派发工具、真 BashTool。替身只到它们的外部依赖为止
 * （mcpService 是 Fx-MCP 的 spy，skillService 给可控的技能表，agentService / AgentManager / sandbox 是桩）。
 *
 *  - H11-17 技能工具的描述恰好列出这一次上架的技能；
 *  - H11-35 创建与重建交出同一组按 agent 的工具（名字、描述、参数、replay、MCP 次序）；
 *  - H11-37 重开时的技能漂移（PIN-13 裁决：锁赢 —— 停用的照列，磁盘上没了的掉出去，工具一直在）；
 *  - H11-41 元数据经原型链透出（从不展开包好的工具）；
 *  - H11-42 落不落盘按每次调用定，同一个实例；
 *  - H11-43 工具自己的上限与策略照用，宿主不覆写。
 *
 * P2-04（docs/pi-durable/p2-04-test-design.md）派生 agent 的真件：
 *  - P2-04-20 派生的创建与重建交出同一组（H11-35 的派生版，含 `next`）；
 *  - P2-04-21 / 22 真 NextTool 经真包装器：details {result} 与 terminate 原样透出，重复 / 不合 schema 的调用；
 *  - P2-04-36（AHS-3）同一根会话下的派生 agent 落不落盘各按自己的工具表，落盘都在根会话目录下；
 *  - 派生记录的技能漂移（H11-37 的派生版）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  Agent,
  ToolDiagnostic,
  ToolExecutionApi,
  ToolRegistration
} from '@earendil-works/pi-durable'

const USER_DATA_DIR = join(tmpdir(), `shuvix-h11-real-${process.pid}-${Date.now()}`)

const mocks = vi.hoisted(() => ({
  statusByName: vi.fn(),
  ensureServerByName: vi.fn(),
  declarationsOf: vi.fn(),
  registrationsFromDeclarations: vi.fn(),
  findEnabled: vi.fn(),
  findAll: vi.fn(),
  pick: vi.fn(),
  sandboxGloballyActive: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9', getPath: () => USER_DATA_DIR, isPackaged: false }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: { pick: mocks.pick, pickSettings: () => undefined }
}))
vi.mock('../../dao/projectDao', () => ({
  projectDao: { pick: () => ({ name: 'Proj', path: '/w/proj', systemPrompt: '' }) }
}))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/instruction', () => ({ resolveInstructionContent: vi.fn() }))
vi.mock('../../services/memory', () => ({ resolveProjectMemoryIndex: vi.fn() }))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: () => [] }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: vi.fn() } }))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: { broadcast: vi.fn() },
  runtimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
/** L1 门交回 undefined = 这次不设门（本组只看包装的输出那一半） */
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: () => undefined,
  getSessionPathGrants: () => ({ grantedWrite: [], grantedRead: [] }),
  sessionDirExtras: () => ({ readWrite: [], readOnly: [] }),
  resolveProjectConfig: () => ({ workingDirectory: '/w/proj', envVars: {} }),
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../services/sandbox', () => ({
  sandboxGloballyActive: mocks.sandboxGloballyActive,
  planFor: () => null,
  whyUnconfined: () => 'disabled'
}))
vi.mock('../../services/botService', () => ({ botService: { forSession: () => null } }))
vi.mock('../../utils/toolUtils/fileTime', () => ({ recordRead: vi.fn() }))
vi.mock('../../utils/toolUtils/ripgrep', () => ({
  rgFiles: async function* () {
    /* 目录采样不在本组射程内 */
  }
}))
vi.mock('../../services/mcpService', () => ({
  mcpService: {
    statusByName: mocks.statusByName,
    ensureServerByName: mocks.ensureServerByName,
    declarationsOf: mocks.declarationsOf,
    registrationsFromDeclarations: mocks.registrationsFromDeclarations,
    getRegistrationsByServerName: vi.fn()
  }
}))
vi.mock('../../services/skillService', () => ({
  skillService: { findEnabled: mocks.findEnabled, findAll: mocks.findAll }
}))
vi.mock('../../services/agentService', () => ({
  agentService: { listAll: () => [], getProfile: () => undefined, loadAgentFromRef: vi.fn() }
}))
vi.mock('../AgentManager', () => ({ agentManager: { runTask: vi.fn() } }))

import {
  composeAgentTools,
  type AgentToolSet,
  type AnyTool,
  type LockRecord,
  type McpToolDeclaration,
  type ToolHost
} from '@shuvix/agent-runtime'
import { invokeTool, resultText } from '@shuvix/agent-runtime/tools/testing/invokeTool'
import type { Skill } from '../../types/skill'
import { BashTool } from '../../tools/bash'
import { registerBuiltinTool, unregisterBuiltinTool } from '../../services/toolRegistry'
import { createDesktopToolHost } from '../agentHost'
import {
  MCP_DECLS,
  NX,
  RECORDED,
  SP_D,
  SR_D,
  inProcess,
  lockD,
  mcpRegistration,
  profileOf,
  rctx,
  registerStubBuiltins,
  requestD,
  stubTool
} from './support/toolHostFixtures'

const skill = (name: string): Skill => ({
  name,
  description: `${name} description`,
  content: `${name} body`,
  basePath: `/skills/${name.replace(':', '-')}`,
  isEnabled: true,
  source: name.startsWith('builtin:') ? 'builtin' : 'default',
  dirName: name.startsWith('builtin:') ? 'builtin' : undefined
})

const BIG = Array.from({ length: 3000 }, (_, i) => `L-${String(i).padStart(4, '0')}`).join('\n')

/** 回 BIG 的探针（注册成内置工具 `probe`） */
const probe = (): ToolRegistration => ({
  ...stubTool('probe'),
  execute: async () => ({ content: [{ type: 'text', text: BIG }] })
})

/** 带自己上限与策略的探针（`capped`）：保留开头、至多 10 行 */
const capped = (): ToolRegistration =>
  ({
    ...stubTool('capped'),
    outputMaxLines: 10,
    outputStrategy: 'keep-start',
    execute: async () => ({ content: [{ type: 'text', text: BIG }] })
  }) as unknown as ToolRegistration

/** api.agent 的替身：交出一张只含这些工具名的工具表 */
function agentWith(names: string[]): ToolExecutionApi['agent'] {
  const agent: Agent = {
    thinkingLevel: 'off',
    extensions: [],
    tools: names.map((name) => ({ name }) as unknown as AnyTool),
    sections: []
  }
  return async () => agent
}

const codes = (diagnostics: readonly ToolDiagnostic[] | undefined): (string | undefined)[] =>
  (diagnostics ?? []).map((d) => d.code)

const resultsDir = (sid: string): string => join(USER_DATA_DIR, 'tool_results', sid)

let host: ToolHost
let unregister: () => void

beforeAll(() => {
  // bash.ts 加载即往注册表里注册真 bash：先摘掉，换成 Fx-REG 里那一格（工厂造真 BashTool）
  unregisterBuiltinTool('bash')
  unregister = registerStubBuiltins({ bash: (ctx) => new BashTool(ctx) })
})

afterAll(() => {
  unregister()
  rmSync(USER_DATA_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  mocks.statusByName.mockReset().mockReturnValue('connected')
  mocks.ensureServerByName.mockReset().mockResolvedValue({ ok: true })
  mocks.declarationsOf
    .mockReset()
    .mockImplementation((server: string) => (MCP_DECLS[server] ?? []).map((d) => ({ ...d })))
  mocks.registrationsFromDeclarations
    .mockReset()
    .mockImplementation((server: string, _sid: string, decls: readonly McpToolDeclaration[]) =>
      decls.map((d) => mcpRegistration(server, d))
    )
  const shelf = [skill('builtin:drawing'), skill('pdf'), skill('other')]
  mocks.findEnabled.mockReset().mockReturnValue(shelf)
  mocks.findAll.mockReset().mockReturnValue(shelf)
  mocks.pick.mockReset().mockReturnValue({ projectId: 'p1' })
  mocks.sandboxGloballyActive.mockReset().mockReturnValue(false)
  host = createDesktopToolHost({ sessionOf: () => undefined })
})

/** 从一份解析结果派生锁记录（运行时的拼法 + 解析出来的声明 / 技能） */
async function lockFrom(names: readonly string[]): Promise<{
  lock: LockRecord
  resolved: Awaited<ReturnType<ToolHost['resolveAgentTools']>>
}> {
  const resolved = await host.resolveAgentTools(requestD({ names }), {
    signal: new AbortController().signal
  })
  const builtin = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: resolved.sandboxed })
  const composed = composeAgentTools({ names, builtin, set: resolved })
  const mcp: LockRecord['mcp'] = {}
  for (const entry of resolved.mcp ?? []) mcp[entry.server] = [...entry.declarations]
  return {
    resolved,
    lock: lockD({
      toolNames: composed.toolNames,
      mcp,
      skills: [...(resolved.skills ?? [])],
      sandboxed: resolved.sandboxed
    })
  }
}

describe('技能工具', () => {
  it('H11-17 描述恰好列出这一次上架的技能（名单 ∩ 在架，在架次序）：没有 other、没有 ghost；skills 同序', async () => {
    const resolved = await host.resolveAgentTools(
      requestD({ names: ['skill:builtin:drawing', 'skill:pdf', 'skill:ghost'] }),
      { signal: new AbortController().signal }
    )
    const description = resolved.skill!.description
    expect(description).toContain('<name>builtin:drawing</name>')
    expect(description).toContain('<name>pdf</name>')
    expect(description).not.toContain('other')
    expect(description).not.toContain('ghost')
    const listed = [...description.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1])
    expect(resolved.skills).toEqual(listed)
  })

  it('H11-37 重开时的漂移（PIN-13：锁赢）：停用了的照列；磁盘上没了的掉出去；技能工具一直在，空了照实说没有', async () => {
    const lock = lockD({ skills: ['builtin:drawing', 'pdf'] })

    // 停用：pdf 不在 findEnabled 里了，但还在磁盘上（findAll）—— 锁住的 agent 照旧带着它
    mocks.findEnabled.mockReturnValue([skill('builtin:drawing')])
    const disabled = (await host.rebuildAgentTools(lock, { sessionId: 's1' })).skill!
    expect(disabled.description).toContain('<name>builtin:drawing</name>')
    expect(disabled.description).toContain('<name>pdf</name>')

    // 删掉：pdf 磁盘上也没了 → 从索引里掉出去
    mocks.findAll.mockReturnValue([skill('builtin:drawing')])
    const deleted = (await host.rebuildAgentTools(lock, { sessionId: 's1' })).skill!
    expect(deleted.description).toContain('<name>builtin:drawing</name>')
    expect(deleted.description).not.toContain('<name>pdf</name>')

    // 全没了：工具仍在（工具表不因重开而变），货架照实说没有
    mocks.findAll.mockReturnValue([])
    const empty = (await host.rebuildAgentTools(lock, { sessionId: 's1' })).skill
    expect(empty?.name).toBe('skill')
    expect(empty?.description).toContain('No skills are currently available')
  })
})

describe('创建与重建', () => {
  it('H11-35 创建与重建交出同一组：agent / skill / 每件 MCP 工具名字、描述、参数（JSON）、replay 都相同，MCP 次序相同', async () => {
    const names = requestD().names
    const { lock, resolved } = await lockFrom(names)
    const rebuilt = await host.rebuildAgentTools(lock, { sessionId: 's1' })

    const shape = (tool: ToolRegistration | undefined): unknown =>
      tool === undefined
        ? undefined
        : {
            name: tool.name,
            description: tool.description,
            parameters: JSON.parse(JSON.stringify(tool.parameters)),
            replay: tool.replay
          }
    expect(shape(rebuilt.agent)).toEqual(shape(resolved.agent))
    expect(shape(rebuilt.agent)).toBeDefined()
    expect(shape(rebuilt.skill)).toEqual(shape(resolved.skill))
    expect(shape(rebuilt.skill)).toBeDefined()
    expect(rebuilt.mcp?.map((m) => m.server)).toEqual(resolved.mcp?.map((m) => m.server))
    expect(rebuilt.mcp!.flatMap((m) => m.tools).map(shape)).toEqual(
      resolved.mcp!.flatMap((m) => m.tools).map(shape)
    )
  })
})

describe('包装：元数据与落盘', () => {
  it('H11-41 元数据经原型链透出：派发工具的 class getter 描述、SkillTool 的描述与参数、MCP 的 mcpMeta / label / replay、read 的 safe、钉住的 bash 的越界参数；execute 是自有属性，outputLimits 在包装层上', async () => {
    const builtin = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: true })
    const resolved = await host.resolveAgentTools(requestD(), {
      signal: new AbortController().signal
    })

    const agent = resolved.agent!
    const rawAgent = Object.getPrototypeOf(Object.getPrototypeOf(agent)) as ToolRegistration
    expect(agent.description.length).toBeGreaterThan(0)
    expect(agent.description).toBe(rawAgent.description)

    const skillTool = resolved.skill!
    const rawSkill = Object.getPrototypeOf(Object.getPrototypeOf(skillTool)) as ToolRegistration
    expect(skillTool.description).toBe(rawSkill.description)
    expect(skillTool.parameters).toBe(rawSkill.parameters)

    const mcp = resolved.mcp![1].tools[0] as ToolRegistration & {
      mcpMeta?: unknown
      label?: string
    }
    expect(mcp.mcpMeta).toEqual({ server: 'ssh', tool: 'list-hosts', trusted: true })
    expect(mcp.label).toBe('list-hosts tool')
    expect(mcp.replay).toBe('unsafe')

    expect(builtin.find((t) => t.name === 'read')!.replay).toBe('safe')
    const bash = builtin.find((t) => t.name === 'bash')!
    expect(
      (bash.parameters as { properties: Record<string, unknown> }).properties
        .dangerouslyDisableSandbox
    ).toBeDefined()

    for (const tool of [agent, skillTool, mcp, bash]) {
      expect(Object.prototype.hasOwnProperty.call(tool, 'execute')).toBe(true)
      // 包装分两层（门在外、输出内核在里）：outputLimits 是内核那一层的自有属性
      const core = Object.getPrototypeOf(tool) as object
      expect(Object.prototype.hasOwnProperty.call(core, 'outputLimits')).toBe(true)
      expect(tool.outputLimits).toBeDefined()
    }
  })

  it('H11-42 落不落盘按每次调用的 agent 工具表定、同一个实例：有 read → spilled（全文在 tool_results/s1/<callId>）；没有 → truncated、没有文件；mcp__read__fetch 不算 read；扩展工具同样落在 s1 下', async () => {
    const unregisterProbe = registerProbe()
    try {
      const builtin = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
      const tool = builtin.find((t) => t.name === 'probe')!

      const spilled = await invokeTool(tool, {} as never, {
        callId: 'h11-42-a',
        api: { agent: agentWith(['read', 'probe']) }
      })
      expect(codes(spilled.result.diagnostics)).toEqual(['spilled'])
      expect(readFileSync(join(resultsDir('s1'), 'h11-42-a.txt'), 'utf-8')).toBe(BIG)

      const truncated = await invokeTool(tool, {} as never, {
        callId: 'h11-42-b',
        api: { agent: agentWith(['probe']) }
      })
      expect(codes(truncated.result.diagnostics)).toEqual(['truncated'])
      expect(existsSync(join(resultsDir('s1'), 'h11-42-b.txt'))).toBe(false)

      const lookalike = await invokeTool(tool, {} as never, {
        callId: 'h11-42-c',
        api: { agent: agentWith(['mcp__read__fetch', 'skill', 'probe']) }
      })
      expect(codes(lookalike.result.diagnostics)).toEqual(['truncated'])
      expect(existsSync(join(resultsDir('s1'), 'h11-42-c.txt'))).toBe(false)

      // 扩展工具（附加工具这一格）同一套包装、同一个会话目录
      const resolved = await host.resolveAgentTools(
        requestD({ names: [], extraTools: [probe()] }),
        {
          signal: new AbortController().signal
        }
      )
      const extra = resolved.extraTools![0]
      const extraRun = await invokeTool(extra, {} as never, {
        callId: 'h11-42-d',
        api: { agent: agentWith(['read', 'probe']) }
      })
      expect(codes(extraRun.result.diagnostics)).toEqual(['spilled'])
      expect(existsSync(join(resultsDir('s1'), 'h11-42-d.txt'))).toBe(true)
    } finally {
      unregisterProbe()
    }
  })

  it('P2-04-36（AHS-3）同一根会话下派生的 titler（只有 session）不落盘、explore（有 read）落盘 —— 各按自己的工具表，落盘都在根会话 s1 下；共用的内置 probe 也是同一个分法', async () => {
    const signal = new AbortController().signal
    const titler = await host.resolveAgentTools(
      SR_D({
        profile: inProcess(profileOf('titler')),
        names: ['session'],
        canSpawn: false,
        selfSessionId: 'sub-t1',
        agentId: 'sub-t1',
        extraTools: [probe()]
      }),
      { signal }
    )
    const explore = await host.resolveAgentTools(
      SR_D({
        profile: inProcess(profileOf('explore')),
        names: ['read', 'ls', 'grep', 'glob'],
        canSpawn: false,
        selfSessionId: 'sub-e1',
        agentId: 'sub-e1',
        extraTools: [probe()]
      }),
      { signal }
    )
    const TITLER_TABLE = ['session', 'probe']
    const EXPLORE_TABLE = ['read', 'ls', 'grep', 'glob', 'probe']

    const t = await invokeTool(titler.extraTools![0], {} as never, {
      callId: 'ahs3-t',
      api: { agent: agentWith(TITLER_TABLE) }
    })
    expect(codes(t.result.diagnostics)).toEqual(['truncated'])
    expect(existsSync(join(resultsDir('s1'), 'ahs3-t.txt'))).toBe(false)
    expect(existsSync(resultsDir('sub-t1'))).toBe(false)

    const e = await invokeTool(explore.extraTools![0], {} as never, {
      callId: 'ahs3-e',
      api: { agent: agentWith(EXPLORE_TABLE) }
    })
    expect(codes(e.result.diagnostics)).toEqual(['spilled'])
    expect(readFileSync(join(resultsDir('s1'), 'ahs3-e.txt'), 'utf-8')).toBe(BIG)
    expect(existsSync(resultsDir('sub-e1'))).toBe(false)

    // 会话级装配的内置 probe：同一个实例在两张表下分得一样
    const unregisterProbe = registerProbe()
    try {
      const builtin = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
      const shared = builtin.find((tool) => tool.name === 'probe')!
      const bt = await invokeTool(shared, {} as never, {
        callId: 'ahs3-bt',
        api: { agent: agentWith(TITLER_TABLE) }
      })
      const be = await invokeTool(shared, {} as never, {
        callId: 'ahs3-be',
        api: { agent: agentWith(EXPLORE_TABLE) }
      })
      expect(codes(bt.result.diagnostics)).toEqual(['truncated'])
      expect(codes(be.result.diagnostics)).toEqual(['spilled'])
      expect(existsSync(join(resultsDir('s1'), 'ahs3-bt.txt'))).toBe(false)
      expect(existsSync(join(resultsDir('s1'), 'ahs3-be.txt'))).toBe(true)
    } finally {
      unregisterProbe()
    }
  })

  it('H11-43 工具自己的上限与策略照用（宿主不覆写）：保留开头、至多 10 行；没声明的拿缺省上限与 middle', async () => {
    const unregisterProbe = registerProbe()
    try {
      const builtin = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: false })
      const own = await invokeTool(builtin.find((t) => t.name === 'capped')!, {} as never, {
        callId: 'h11-43-a',
        api: { agent: agentWith(['capped']) }
      })
      const ownLines = resultText(own.result).split('\n')
      expect(ownLines.length).toBeLessThanOrEqual(10)
      expect(ownLines[0]).toBe('L-0000')

      const plain = await invokeTool(builtin.find((t) => t.name === 'probe')!, {} as never, {
        callId: 'h11-43-b',
        api: { agent: agentWith(['probe']) }
      })
      const text = resultText(plain.result)
      // middle：头尾都留着，中间被截掉
      expect(text).toContain('L-0000')
      expect(text).toContain('L-2999')
      expect(text).not.toContain('L-1500')
      expect(text.split('\n').length).toBeGreaterThan(10)
    } finally {
      unregisterProbe()
    }
  })
})

/** 把 probe / capped 两个探针注册成内置工具；交回反注册 */
function registerProbe(): () => void {
  for (const [name, make] of [
    ['probe', probe],
    ['capped', capped]
  ] as const) {
    registerBuiltinTool({
      name,
      group: 'general',
      getLabel: () => name,
      getHint: () => name,
      factory: () => make()
    })
  }
  return () => {
    unregisterBuiltinTool('probe')
    unregisterBuiltinTool('capped')
  }
}

// ─── 派生 agent（P2-04） ─────────────────────────────────────────────────

/** 一个工具在模型眼里的样子（名字、描述、参数 JSON、replay） */
const shapeOf = (tool: ToolRegistration | undefined): unknown =>
  tool === undefined
    ? undefined
    : {
        name: tool.name,
        description: tool.description,
        parameters: JSON.parse(JSON.stringify(tool.parameters)),
        replay: tool.replay
      }

describe('派生 agent：创建与重建', () => {
  it('P2-04-20 派生的创建与重建交出同一组（H11-35 的派生版）：agent / skill / 每件 MCP / next 的样子相同、MCP 次序相同；重建拼出的工具名 = 记录的；重建不连', async () => {
    const signal = new AbortController().signal
    const request = SR_D({ extraTools: [NX()] })
    const resolved = await host.resolveAgentTools(request, { signal })
    const builtin = await host.buildBuiltinTools({ sessionId: 's1', sandboxed: resolved.sandboxed })
    const composed = composeAgentTools({
      names: request.names,
      builtin,
      set: resolved,
      extraTools: resolved.extraTools
    })
    const record = SP_D({
      toolNames: composed.toolNames,
      skills: [...(resolved.skills ?? [])],
      mcp: { context7: [...resolved.mcp![0].declarations] }
    })
    const ensureCalls = mocks.ensureServerByName.mock.calls.length
    const rebuilt: AgentToolSet = await host.rebuildAgentTools(record, rctx(record))

    for (const pick of [
      (set: AgentToolSet) => set.agent,
      (set: AgentToolSet) => set.skill,
      (set: AgentToolSet) => set.extraTools?.[0]
    ]) {
      expect(shapeOf(pick(rebuilt))).toBeDefined()
      expect(shapeOf(pick(rebuilt))).toEqual(shapeOf(pick(resolved)))
    }
    expect(rebuilt.extraTools?.[0].name).toBe('next')
    expect(rebuilt.mcp?.map((m) => m.server)).toEqual(resolved.mcp?.map((m) => m.server))
    expect(rebuilt.mcp!.flatMap((m) => m.tools).map(shapeOf)).toEqual(
      resolved.mcp!.flatMap((m) => m.tools).map(shapeOf)
    )
    expect(
      composeAgentTools({
        names: request.names,
        builtin,
        set: rebuilt,
        extraTools: rebuilt.extraTools
      }).toolNames
    ).toEqual(record.toolNames)
    expect(mocks.ensureServerByName.mock.calls.length).toBe(ensureCalls)
  })

  it('派生记录的技能漂移（H11-37 的派生版，锁赢）：停用了的照列；磁盘上没了的掉出去；技能工具一直在，空了照实说没有', async () => {
    const record = SP_D({ skills: ['builtin:drawing', 'pdf'] })

    mocks.findEnabled.mockReturnValue([skill('builtin:drawing')])
    const disabled = (await host.rebuildAgentTools(record, rctx(record))).skill!
    expect(disabled.description).toContain('<name>builtin:drawing</name>')
    expect(disabled.description).toContain('<name>pdf</name>')

    mocks.findAll.mockReturnValue([skill('builtin:drawing')])
    const deleted = (await host.rebuildAgentTools(record, rctx(record))).skill!
    expect(deleted.description).toContain('<name>builtin:drawing</name>')
    expect(deleted.description).not.toContain('<name>pdf</name>')

    mocks.findAll.mockReturnValue([])
    const empty = (await host.rebuildAgentTools(record, rctx(record))).skill
    expect(empty?.name).toBe('skill')
    expect(empty?.description).toContain('No skills are currently available')
  })
})

describe('派生 agent：next 经真包装器', () => {
  /** 创建（解析时的 extraTools）与重建（rctx）两条路上包好的 next */
  async function wrappedNext(): Promise<{ resolved: ToolRegistration; rebuilt: ToolRegistration }> {
    const resolved = await host.resolveAgentTools(SR_D({ extraTools: [NX()] }), {
      signal: new AbortController().signal
    })
    const rebuilt = await host.rebuildAgentTools(SP_D(), rctx(SP_D()))
    return { resolved: resolved.extraTools![0], rebuilt: rebuilt.extraTools![0] }
  }

  it('P2-04-21 两条路上都成功：details 恰为 {result}、control {terminate}、文字 RECORDED；不是错误、没有诊断、不落盘', async () => {
    const { resolved, rebuilt } = await wrappedNext()
    for (const next of [resolved, rebuilt]) {
      const { result } = await invokeTool(next, { title: 'Fix login bug' } as never, {
        callId: 'n-1',
        api: { agent: agentWith(['read', 'next']) }
      })
      expect(result.details).toStrictEqual({ result: { title: 'Fix login bug' } })
      expect(result.control).toStrictEqual({ terminate: true })
      expect(resultText(result)).toBe(RECORDED)
      expect(result.isError).toBeUndefined()
      expect(result.diagnostics).toBeUndefined()
      expect(existsSync(join(resultsDir('s1'), 'n-1.txt'))).toBe(false)
    }
  })

  it('P2-04-22 重复与不合 schema：同一实例第二次 → already recorded + terminate、没有 details；新实例传 {} → isError、没有 details / control；之后合规的那次照常捕获', async () => {
    const api = { agent: agentWith(['read', 'next']) }
    const { resolved: first } = await wrappedNext()
    await invokeTool(first, { title: 'first' } as never, { callId: 'n-d1', api })
    const { result: again } = await invokeTool(first, { title: 'second' } as never, {
      callId: 'n-d2',
      api
    })
    expect(resultText(again)).toContain('already recorded')
    expect(again.control).toStrictEqual({ terminate: true })
    expect(again.details).toBeUndefined()
    expect('details' in again).toBe(false)

    const { resolved: fresh } = await wrappedNext()
    const { result: invalid } = await invokeTool(fresh, {} as never, { callId: 'n-i1', api })
    expect(invalid.isError).toBe(true)
    expect('details' in invalid).toBe(false)
    expect('control' in invalid).toBe(false)

    const { result: ok } = await invokeTool(fresh, { title: 'ok' } as never, {
      callId: 'n-i2',
      api
    })
    expect(ok.details).toStrictEqual({ result: { title: 'ok' } })
  })
})
