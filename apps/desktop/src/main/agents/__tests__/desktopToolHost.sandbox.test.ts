/**
 * P1-11 —— 命令沙箱的钉子经 `buildBuiltinTools({ sandboxed })` 交给**真的** BashTool（PIN-03：bash 不再
 * 调 pinSession，钉子随会话级 ToolContext 交进去）。沙箱管理器是 spy（planFor / whyUnconfined /
 * sandboxGloballyActive），命令执行（bgTaskService.runCommand）与安全门是桩，包装器走恒等。
 *
 *  - H11-07 钉成套：全局开关关着也套 —— 描述多受限一段、schema 多越界参数，执行要计划、客体 sandboxed；
 *  - H11-08 钉成不套：全局开关开着也不套 —— 没有越界参数、描述不提沙箱，带越界参数也不要计划；
 *  - H11-13 「没套」的原因：钉成不套的 bash 报 whyUnconfined(s1) 的答案；钉成套的报 unavailable /
 *    escalated、不问 whyUnconfined；win32 的 powershell 恒 unsupported（PIN-04）。
 * H11-09..12（占位与解析规则）用真的沙箱管理器，在 desktopToolHost.sandboxRule.test.ts。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolRegistration } from '@earendil-works/pi-durable'

const mocks = vi.hoisted(() => ({
  enforceCommand: vi.fn(),
  runCommand: vi.fn(),
  planFor: vi.fn(),
  whyUnconfined: vi.fn(),
  sandboxGloballyActive: vi.fn(),
  pinSession: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9', getPath: () => '/tmp/shuvix-h11-sandbox', isPackaged: false }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: { pick: () => undefined, pickSettings: () => undefined }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: { findAllEnabledModels: () => [] } }))
vi.mock('../../services/instruction', () => ({ resolveInstructionContent: vi.fn() }))
vi.mock('../../services/memory', () => ({ resolveProjectMemoryIndex: vi.fn() }))
vi.mock('../../services/knowledge', () => ({ enabledBaseChoices: () => [] }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: vi.fn() } }))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: { broadcast: vi.fn() },
  runtimeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/toolContext', () => ({
  getDesktopSecurityContext: () => ({ enforceCommand: mocks.enforceCommand }),
  getSessionPathGrants: () => ({ grantedWrite: [], grantedRead: [] }),
  sessionDirExtras: () => ({ readWrite: [], readOnly: [] }),
  resolveProjectConfig: () => ({ workingDirectory: '/w', envVars: {} }),
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../services/sandbox', () => ({
  sandboxGloballyActive: mocks.sandboxGloballyActive,
  pinSession: mocks.pinSession,
  planFor: mocks.planFor,
  whyUnconfined: mocks.whyUnconfined
}))
vi.mock('../../services/bgTaskService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/bgTaskService')>()
  return { ...actual, runCommand: mocks.runCommand, runningCount: () => 0, listBgTasks: () => [] }
})
vi.mock('../../services/botService', () => ({ botService: { forSession: () => null } }))
vi.mock('../../utils/toolUtils/fileTime', () => ({ recordRead: vi.fn() }))
vi.mock('../../services/mcpService', () => ({ mcpService: {} }))
vi.mock('../../services/skillService', () => ({ skillService: { findEnabled: () => [] } }))
vi.mock('../../services/skillTool', () => ({ SkillTool: class {} }))
vi.mock('../AgentTool', () => ({ createAgentTool: vi.fn() }))
vi.mock('../../services/wrapToolOutput', () => ({ wrapDurableTool: (tool: object) => tool }))

import { executeTool } from '@shuvix/agent-runtime/tools/testing/invokeTool'
import { BashTool } from '../../tools/bash'
import { PowerShellTool } from '../../tools/powershell'
import { unregisterBuiltinTool } from '../../services/toolRegistry'
import type { SandboxPlan } from '../../services/sandbox'
import { createDesktopToolHost } from '../agentHost'
import { registerStubBuiltins, restorePlatform, setPlatform } from './support/toolHostFixtures'

const PLAN = {
  spec: {},
  env: { TMPDIR: '/private/tmp/shuvix-501/sbx/' },
  wrap: vi.fn(),
  explain: vi.fn()
} as unknown as SandboxPlan

const BASE = 'Execute a bash command in the working directory.'

const settled = (): unknown => ({
  kind: 'settled',
  info: {
    toolCallId: 'tc',
    sessionId: 's1',
    command: 'ls',
    description: 'list',
    cwd: '/w',
    pid: 1,
    logPath: '/x.log',
    status: 'exited',
    exitCode: 0,
    signal: null,
    startedAt: 0,
    endedAt: 1,
    logCapped: false
  },
  output: 'out',
  reason: 'finished'
})

type Schema = { properties: Record<string, unknown>; required?: string[] }

let unregister: () => void

async function shellOf(sandboxed: boolean | undefined, name = 'bash'): Promise<ToolRegistration> {
  const tools = await createDesktopToolHost({ lockOf: () => undefined }).buildBuiltinTools({
    sessionId: 's1',
    ...(sandboxed === undefined ? {} : { sandboxed })
  })
  const tool = tools.find((t) => t.name === name)
  expect(tool, `${name} should be built`).toBeDefined()
  return tool!
}

/** 执行一次，交回 enforceCommand 收到的命令客体 */
async function commandObjectOf(
  tool: ToolRegistration,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  mocks.enforceCommand.mockClear()
  await executeTool(tool, 'tc-1', { command: 'ls', description: 'list', ...params } as never)
  expect(mocks.enforceCommand).toHaveBeenCalledTimes(1)
  return mocks.enforceCommand.mock.calls[0][0] as Record<string, unknown>
}

beforeAll(() => {
  // bash.ts / powershell.ts 加载即注册真条目：先摘掉，换成 Fx-REG 那两格（工厂造真工具）
  unregisterBuiltinTool('bash')
  unregisterBuiltinTool('powershell')
  unregister = registerStubBuiltins({
    bash: (ctx) => new BashTool(ctx),
    powershell: (ctx) => new PowerShellTool(ctx)
  })
})

afterAll(() => unregister())

beforeEach(() => {
  setPlatform('darwin')
  mocks.enforceCommand.mockReset().mockResolvedValue({ status: 'allowed' })
  mocks.runCommand.mockReset().mockResolvedValue(settled())
  mocks.planFor.mockReset().mockReturnValue(PLAN)
  mocks.whyUnconfined.mockReset().mockReturnValue('disabled')
  mocks.sandboxGloballyActive.mockReset().mockReturnValue(false)
  mocks.pinSession.mockReset().mockReturnValue(false)
})

afterEach(() => restorePlatform())

describe('沙箱钉子 → 真 BashTool', () => {
  it('H11-07 钉成套赢过全局开关（关着）：描述 = 基础 + 受限一段，schema 有可选的越界参数；执行要一次计划、客体 sandboxed', async () => {
    const bash = await shellOf(true)
    expect(bash.description.startsWith(BASE)).toBe(true)
    expect(bash.description).toContain('confined in a sandbox')
    const schema = bash.parameters as unknown as Schema
    expect(schema.properties.dangerouslyDisableSandbox).toBeDefined()
    expect(schema.required ?? []).not.toContain('dangerouslyDisableSandbox')

    const object = await commandObjectOf(bash)
    expect(mocks.planFor).toHaveBeenCalledTimes(1)
    expect(object.sandboxed).toBe(true)
    expect(mocks.pinSession).not.toHaveBeenCalled()
  })

  it('H11-08 钉成不套赢过全局开关（开着）：没有越界参数、描述不提沙箱；带着越界参数执行也不要计划、不标 unsandboxed', async () => {
    mocks.sandboxGloballyActive.mockReturnValue(true)
    const bash = await shellOf(false)
    const schema = bash.parameters as unknown as Schema
    expect('dangerouslyDisableSandbox' in schema.properties).toBe(false)
    expect(bash.description).not.toMatch(/sandbox/i)

    const object = await commandObjectOf(bash, { dangerouslyDisableSandbox: true })
    expect(mocks.planFor).not.toHaveBeenCalled()
    expect(object.sandboxed).toBeUndefined()
    const opts = mocks.enforceCommand.mock.calls[0][1] as Record<string, unknown>
    expect(opts.unsandboxed).toBeUndefined()
    expect(mocks.pinSession).not.toHaveBeenCalled()
  })

  it.each(['unsupported', 'disabled', 'unavailable'] as const)(
    'H11-13 钉成不套的 bash 报 whyUnconfined(s1) 的答案（%s）',
    async (reason) => {
      mocks.whyUnconfined.mockReturnValue(reason)
      const object = await commandObjectOf(await shellOf(false))
      expect(object.unconfinedReason).toBe(reason)
      expect(mocks.whyUnconfined.mock.calls).toEqual([['s1']])
    }
  )

  it('H11-13 钉成套：计划为 null → unavailable；申请越界 → escalated；都不问 whyUnconfined', async () => {
    const bash = await shellOf(true)
    mocks.planFor.mockReturnValue(null)
    expect((await commandObjectOf(bash)).unconfinedReason).toBe('unavailable')
    mocks.planFor.mockReturnValue(PLAN)
    expect(
      (await commandObjectOf(bash, { dangerouslyDisableSandbox: true })).unconfinedReason
    ).toBe('escalated')
    expect(mocks.whyUnconfined).not.toHaveBeenCalled()
  })

  it('H11-13 win32 的 powershell：恒 unsupported，不问 whyUnconfined', async () => {
    setPlatform('win32')
    const ps = await shellOf(true, 'powershell')
    const object = await commandObjectOf(ps)
    expect(object.unconfinedReason).toBe('unsupported')
    expect(mocks.whyUnconfined).not.toHaveBeenCalled()
  })
})
