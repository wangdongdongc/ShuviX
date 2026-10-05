/**
 * P1-11 —— 锁里那枚沙箱钉子怎么定（Fx-SB：**真的**沙箱管理器，经 setSandboxSettingReader 与假后端的
 * 探测驱动，同 services/sandbox/__tests__/manager.test.ts）。管理器把后端与探测结果缓存在模块里，所以每个
 * 用例 resetModules 后重新导入 sandbox / agentHost（bash 也随之重新导入、注册进新的注册表）。
 *
 *  - H11-09 undefined 是占位不是钉子：开关开着时 {sessionId} 造出受限形态的 bash；关掉之后解析报 false，
 *    再按 undefined 重建就是不受限的形态；
 *  - H11-10 解析规则：`sandboxed` = darwin && 开关开 && 探测可用（linux / win32 没有后端）；
 *  - H11-11 每次创建都现定：同一进程同一会话，开 → true、关 → false、再开 → true —— 没有跨创建的钉子缓存；
 *  - H11-12 与名单无关：tab 的名单里没有 bash，沙箱可用时照样报 true（PIN-06）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolHost } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  setting: 'true' as string
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9',
    getPath: () => '/tmp/shuvix-h11-sandbox-rule',
    isPackaged: false
  }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../services/sandbox/backends/seatbelt', () => ({
  createSeatbeltBackend: () => ({
    id: 'fake',
    probe: mocks.probe,
    wrap: vi.fn(),
    startupFailure: vi.fn()
  })
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
  getDesktopSecurityContext: () => undefined,
  getSessionPathGrants: () => ({ grantedWrite: [], grantedRead: [] }),
  sessionDirExtras: () => ({ readWrite: [], readOnly: [] }),
  resolveProjectConfig: () => ({ workingDirectory: '/w', envVars: {} }),
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/userInputBroker', () => ({ requestUserInputFor: vi.fn() }))
vi.mock('../../services/botService', () => ({ botService: { forSession: () => null } }))
vi.mock('../../utils/toolUtils/fileTime', () => ({ recordRead: vi.fn() }))
vi.mock('../../services/mcpService', () => ({
  mcpService: {
    statusByName: () => 'connected',
    ensureServerByName: async () => ({ ok: true }),
    declarationsOf: () => [],
    registrationsFromDeclarations: () => [],
    getRegistrationsByServerName: () => []
  }
}))
vi.mock('../../services/skillService', () => ({
  skillService: { findEnabled: () => [], findAll: () => [] }
}))
vi.mock('../AgentTool', () => ({ createAgentTool: () => ({ name: 'agent' }) }))
vi.mock('../../services/wrapToolOutput', () => ({ wrapDurableTool: (tool: object) => tool }))

import { requestD, restorePlatform, setPlatform } from './support/toolHostFixtures'

interface Loaded {
  host: ToolHost
  setSetting: (value: string) => void
}

/** 一份全新的沙箱管理器 + agentHost + bash（模块级缓存清零） */
async function load(platform: string, available = true): Promise<Loaded> {
  setPlatform(platform)
  mocks.probe.mockReturnValue(
    available ? { available: true } : { available: false, reason: 'nested' }
  )
  vi.resetModules()
  const sandbox = await import('../../services/sandbox')
  sandbox.setSandboxSettingReader(() => mocks.setting)
  await import('../../tools/bash')
  const { createDesktopToolHost } = await import('../agentHost')
  return {
    host: createDesktopToolHost({ sessionOf: () => undefined }),
    setSetting: (value) => {
      mocks.setting = value
    }
  }
}

const resolveSandboxed = async (host: ToolHost, names: readonly string[] = []): Promise<boolean> =>
  (
    await host.resolveAgentTools(requestD({ names: [...names] }), {
      signal: new AbortController().signal
    })
  ).sandboxed

type Schema = { properties: Record<string, unknown> }

async function bashOf(host: ToolHost, sandboxed?: boolean): Promise<Schema> {
  const tools = await host.buildBuiltinTools({
    sessionId: 's1',
    ...(sandboxed === undefined ? {} : { sandboxed })
  })
  const bash = tools.find((t) => t.name === 'bash')
  expect(bash, 'bash should be built on darwin').toBeDefined()
  return bash!.parameters as unknown as Schema
}

beforeEach(() => {
  mocks.setting = 'true'
  mocks.probe.mockReset()
})

afterEach(() => restorePlatform())

describe('沙箱钉子的规则（真管理器）', () => {
  it('H11-09 undefined 是占位：开着 → 受限形态；关掉之后解析报 false，按 undefined 重建就是不受限形态', async () => {
    const { host, setSetting } = await load('darwin')
    expect((await bashOf(host)).properties.dangerouslyDisableSandbox).toBeDefined()
    setSetting('false')
    expect(await resolveSandboxed(host, requestD().names)).toBe(false)
    expect('dangerouslyDisableSandbox' in (await bashOf(host)).properties).toBe(false)
  })

  const MATRIX: Array<[platform: string, enabled: boolean, available: boolean]> = (
    ['darwin', 'linux', 'win32'] as const
  ).flatMap((platform) =>
    [true, false].flatMap((enabled) =>
      [true, false].map((available): [string, boolean, boolean] => [platform, enabled, available])
    )
  )

  it.each(MATRIX)(
    'H11-10 %s 开关=%s 可用=%s：sandboxed = darwin && 开 && 可用',
    async (platform, enabled, available) => {
      const { host, setSetting } = await load(platform, available)
      setSetting(enabled ? 'true' : 'false')
      expect(await resolveSandboxed(host)).toBe(platform === 'darwin' && enabled && available)
    }
  )

  it('H11-11 每次创建现定：开 → true、关 → false、再开 → true（没有跨创建的钉子缓存）', async () => {
    const { host, setSetting } = await load('darwin')
    setSetting('true')
    expect(await resolveSandboxed(host)).toBe(true)
    setSetting('false')
    expect(await resolveSandboxed(host)).toBe(false)
    setSetting('true')
    expect(await resolveSandboxed(host)).toBe(true)
  })

  it('H11-12 与名单无关：tab 的名单（没有 bash）在沙箱可用时照样报 true（PIN-06）', async () => {
    const { host } = await load('darwin')
    expect(await resolveSandboxed(host, ['mcp:chrome', 'ask', 'skill:builtin:drawing'])).toBe(true)
  })
})
