/**
 * 命令工具按平台装配 —— 内置档案同时列 `bash, powershell`，宿主只装配**这台机器上存在**的那一个；
 * 另一个平台的版本与「未知名」走同一条路：静默跳过、不抛。
 *
 * P1-11 起内置工具由 ToolHost 的 `buildBuiltinTools` 一次装齐（会话级，不看档案），按名单挑、定次序
 * 的是运行时的锁（`composeAgentTools`）。所以这里两段一起看：
 *  - B1 名单同时有 bash 与 powershell：darwin / linux 只提供 bash，win32 只提供 powershell；装配出来的
 *       那一个留在它自己在名单里的位置；
 *  - B2 win32 上名单只点了 bash（用户在 macOS 上写的 agent md 拷过来）与一个不存在的名字：只剩 read，不报错。
 *
 * 同一份装配顺带钉住**安全主体的来源**（AH-S1）：工具工厂拿到的是会话级 ctx（sessionId = 根会话，
 * 没有固定的 agent，带 agentOf）；L1 门的主体按**这次调用**经同一个 ctx 现取（withCallAgent）——
 * 有锁时就是锁住的根 agent，派生 agent（审查员这样的 hook agent）的对话上就是它自己（P2-06：宿主经
 * `sessionOf` 问会话的 `agentIdentity(对话)`）。询问点的审查靠这个主体认出「审查员自己在要权限」（防递归）。
 *
 * 注册表用**真的**（过滤的就是 `isToolOnPlatform` 那一条），往里注册的是桩工厂 —— 真工具模块会
 * 拖进 bgTaskService / toolContext。包装器换成记账的恒等桩（记下它收到的 security 解析器）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'

const mocks = vi.hoisted(() => ({
  getDesktopSecurityContext: vi.fn(),
  /** 包装器（恒等桩）每次收到的工具与选项 */
  wraps: [] as Array<{ tool: object; opts: Record<string, unknown> }>
}))

vi.mock('../../services/wrapToolOutput', () => ({
  wrapDurableTool: (tool: object, opts: Record<string, unknown>) => {
    mocks.wraps.push({ tool, opts })
    return tool
  }
}))
vi.mock('../../services/mcpService', () => ({ mcpService: {} }))
vi.mock('../../services/skillTool', () => ({ SkillTool: class {} }))
vi.mock('../../services/skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../AgentTool', () => ({ createAgentTool: () => ({ name: 'agent' }) }))
vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9', getPath: () => '/tmp/x' } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: { pick: () => undefined, pickSettings: () => undefined }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/instruction', () => ({ resolveInstructionContent: vi.fn() }))
vi.mock('../../services/memory', () => ({ resolveProjectMemoryIndex: vi.fn() }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: vi.fn() } }))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: {}
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: mocks.getDesktopSecurityContext,
  resolveProjectConfig: vi.fn()
}))
vi.mock('../../services/userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../services/sandbox', () => ({ sandboxGloballyActive: () => false }))
vi.mock('../../services/botService', () => ({ botService: { forSession: () => null } }))
vi.mock('../../utils/toolUtils/fileTime', () => ({ recordRead: vi.fn() }))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: () => [] }))

import { composeAgentTools } from '@shuvix/agent-runtime'
import type { ToolContext } from '../../services/toolContext'
import { FakeSessionHost } from '../../services/__tests__/support/fakeSessionHost'
import { registerBuiltinTool, unregisterBuiltinTool } from '../../services/toolRegistry'
import { createDesktopToolHost } from '../agentHost'
import {
  lockD,
  registerStubBuiltins,
  restorePlatform,
  setPlatform,
  stubTool
} from './support/toolHostFixtures'

const SID = 'sess-platform-tools'

let fake = new FakeSessionHost()
const host = createDesktopToolHost({ sessionOf: (id) => fake.get(id) })

let unregister: () => void

beforeAll(() => {
  unregister = registerStubBuiltins()
})
afterAll(() => unregister())
afterEach(() => restorePlatform())

/** 装一次内置工具，按名单拼出提供给模型的工具名（名单序） */
async function offeredNames(names: string[]): Promise<string[]> {
  const builtin = await host.buildBuiltinTools({ sessionId: SID, sandboxed: false })
  return composeAgentTools({ names, builtin, set: {} }).toolNames
}

describe('内置工具 —— 命令工具按平台二选一', () => {
  it.each(['darwin', 'linux'])(
    'B1 — %s：名单里 bash 与 powershell 都有 → 只提供 bash，不抛',
    async (platform) => {
      setPlatform(platform)
      expect(await offeredNames(['read', 'bash', 'powershell'])).toEqual(['read', 'bash'])
    }
  )

  it('B1 — win32：名单里 bash 与 powershell 都有 → 只提供 powershell，不抛', async () => {
    setPlatform('win32')
    expect(await offeredNames(['read', 'bash', 'powershell'])).toEqual(['read', 'powershell'])
  })

  it('B1 — 名单里两者的先后不影响结果：装配出来的那一个留在它自己在名单里的位置', async () => {
    setPlatform('win32')
    expect(await offeredNames(['powershell', 'read', 'bash'])).toEqual(['powershell', 'read'])
    setPlatform('darwin')
    expect(await offeredNames(['powershell', 'read', 'bash'])).toEqual(['read', 'bash'])
  })

  it('B2 — win32 上名单只点了 bash（另一台机器写的 agent md）与一个不存在的名字 → 只剩 read，不报错', async () => {
    setPlatform('win32')
    await expect(offeredNames(['read', 'bash', 'nonexistent'])).resolves.toEqual(['read'])
  })
})

describe('内置工具 —— 工厂的 ctx 与 L1 门的主体', () => {
  const PROBE = 'ctx-probe'
  /** 桩工厂收到的 ctx（按构造顺序） */
  const seen: ToolContext[] = []
  const SECURITY = { sentinel: 'l1-gate' }

  beforeAll(() => {
    registerBuiltinTool({
      name: PROBE,
      group: 'general',
      getLabel: () => PROBE,
      getHint: () => PROBE,
      factory: (ctx) => {
        seen.push(ctx)
        return stubTool(PROBE)
      }
    })
  })
  afterAll(() => unregisterBuiltinTool(PROBE))

  beforeEach(() => {
    seen.length = 0
    mocks.wraps.length = 0
    fake = new FakeSessionHost()
    mocks.getDesktopSecurityContext.mockReset().mockReturnValue(SECURITY)
  })

  it('AH-S1 root（work）：工厂拿到会话级 ctx（sessionId = 根会话、没有固定 agent、带 agentOf）；门的主体按调用经同一个 ctx 现取 —— 有锁时是锁住的 work / root', async () => {
    await host.buildBuiltinTools({ sessionId: SID, sandboxed: false })
    expect(seen).toHaveLength(1)
    const [ctx] = seen
    expect(ctx.sessionId).toBe(SID)
    expect(ctx.agent).toBeUndefined()
    expect(ctx.agentOf).toBeTypeOf('function')

    const wrap = mocks.wraps.find((w) => (w.tool as { name: string }).name === PROBE)!
    const security = wrap.opts.security as (api: ToolExecutionApi, context: Context) => unknown
    expect(security).toBeTypeOf('function')

    fake.put(SID, { lock: lockD() })
    const gate = security({ conversationId: 1 } as ToolExecutionApi, {} as Context)
    expect(gate).toBe(SECURITY)
    const subjectCtx = mocks.getDesktopSecurityContext.mock.calls[0][0] as ToolContext
    // 同一个会话级 ctx（成员同一引用），身份换成了这次调用的 agent
    expect(subjectCtx.sessionId).toBe(SID)
    expect(subjectCtx.requestUserInput).toBe(ctx.requestUserInput)
    expect(subjectCtx.agentOf).toBe(ctx.agentOf)
    expect(subjectCtx.agent).toMatchObject({ profileName: 'work', kind: 'root' })
  })

  it('AH-S1 spawned（permission-reviewer）/ P2-06-19：门的主体报审查员自己的档案名与 spawned（防递归）；根那一行照旧', async () => {
    fake.put(SID, { lock: lockD() }).identities.set(3, {
      profileName: 'permission-reviewer',
      kind: 'spawned',
      callerId: 'sub-r1',
      getModelConfig: () => ({ provider: 'anthropic', model: 'claude-haiku-4-5', capabilities: {} })
    })
    await host.buildBuiltinTools({ sessionId: SID, sandboxed: false })
    const [ctx] = seen
    const wrap = mocks.wraps.find((w) => (w.tool as { name: string }).name === PROBE)!
    const security = wrap.opts.security as (api: ToolExecutionApi, context: Context) => unknown

    expect(security({ conversationId: 3 } as ToolExecutionApi, {} as Context)).toBe(SECURITY)
    const reviewerCtx = mocks.getDesktopSecurityContext.mock.calls[0][0] as ToolContext
    expect(reviewerCtx.sessionId).toBe(SID)
    expect(reviewerCtx.requestUserInput).toBe(ctx.requestUserInput)
    expect(reviewerCtx.agentOf).toBe(ctx.agentOf)
    expect(reviewerCtx.agent).toMatchObject({
      profileName: 'permission-reviewer',
      kind: 'spawned',
      callerId: 'sub-r1'
    })

    security({ conversationId: 1 } as ToolExecutionApi, {} as Context)
    const rootCtx = mocks.getDesktopSecurityContext.mock.calls[1][0] as ToolContext
    expect(rootCtx.agent).toMatchObject({ profileName: 'work', kind: 'root' })
  })
})
