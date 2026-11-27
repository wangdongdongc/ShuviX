/**
 * Codemode Phase 2 · 桌面宿主接线（CM2-HOST-01..02）：
 *
 *   - CM2-HOST-01：`wrapDurableTool` 包装带 `callers: ['tools']` 的 `McpToolRegistration` 后经原型链保留 `callers: ['tools']`
 *   - CM2-HOST-02：`buildSessionHostDeps` 现读 `session.codemode` 与 `session.codemodeMcpOnly`，仅严格 `'true'` 返回 `true`
 */
import { arr, bool, obj, str, unsafe } from '@earendil-works/pi-schema'
import type { AnyTool, McpToolRegistration, SecurityContext } from '@shuvix/agent-runtime'
import { invokeTool } from '@shuvix/agent-runtime/tools/testing/invokeTool'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settingsGet: vi.fn<(key: string) => string | undefined>(),
  sandbox: { tag: 'fake-sandbox' },
  toolHost: {
    buildBuiltinTools: () => [],
    resolveAgentTools: async () => ({ sandboxed: false }),
    rebuildAgentTools: () => ({})
  },
  registry: { models: { tag: 'models' }, modelRefOf: () => undefined },
  port: { listProviders: () => [] }
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shuvix-codemode-wiring-test', isPackaged: false },
  BrowserWindow: class {},
  nativeImage: { createFromBuffer: vi.fn() },
  session: {}
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../dao/database', () => ({
  BaseDao: class {},
  databaseManager: { getDb: () => ({}) }
}))
vi.mock('../../services/shellParserService', () => ({
  shellParser: { ensureReady: vi.fn(async () => {}) }
}))
vi.mock('../../services/settingsService', () => ({
  settingsService: { get: mocks.settingsGet }
}))
vi.mock('../../services/codemode/sandbox', () => ({
  CODEMODE_ENABLED_KEY: 'session.codemode',
  CODEMODE_MCP_ONLY_KEY: 'session.codemodeMcpOnly',
  getCodemodeSandbox: () => mocks.sandbox
}))
vi.mock('../../agents/agentHost', () => ({
  createDesktopToolHost: () => mocks.toolHost,
  desktopPromptHost: {},
  desktopPromptBlocks: () => ({}),
  resolveProfileModelSpec: () => null
}))
vi.mock('../../services/models', () => ({
  getModelRegistry: () => mocks.registry,
  providerCredentialPort: mocks.port
}))
vi.mock('../../services/agentRuntimeAdapters', () => ({
  electronEventSink: { broadcast: () => {} }
}))
vi.mock('../../services/sessionService', () => ({
  sessionService: { resolveAgentConfig: vi.fn() }
}))
vi.mock('../../services/sessionMirror', () => ({ writeSessionMirror: vi.fn() }))
vi.mock('../../services/sessionRecords', () => ({
  sessionRecords: { isEphemeral: () => false, pickSettings: () => undefined }
}))
vi.mock('../../services/sessionStorage', () => ({
  openSessionStorage: vi.fn(),
  sessionStorageExists: vi.fn(() => false),
  deleteSessionStorage: vi.fn()
}))
vi.mock('../../services/sessionSignals', () => ({ installSessionSignals: vi.fn() }))
vi.mock('../../services/taskRegistry', () => ({ taskRegistry: { runningCount: () => 0 } }))
vi.mock('../../services/nativeImageProcessor', () => ({
  createElectronImageProcessor: () => ({})
}))
vi.mock('../../services/redaction/keys', () => ({
  placeholderSigner: {},
  redactionVault: {}
}))
vi.mock('../../services/redactionPolicySeam', () => ({ redactionDecision: vi.fn() }))
vi.mock('../../frontend/sync/syncWiring', () => ({
  peekSyncHub: () => undefined,
  sessionHostHooks: { opened: vi.fn(), closed: vi.fn() }
}))

import { wrapDurableTool } from '../../services/wrapToolOutput'
import { buildSessionHostDeps } from '../../services/sessionHost'

beforeEach(() => {
  mocks.settingsGet.mockReset()
})

describe('Codemode Phase 2 · 桌面宿主接线', () => {
  it('CM2-HOST-01 wrapDurableTool 包装带 callers: ["tools"] 的 McpToolRegistration 后经原型链保留 callers', () => {
    const reg: McpToolRegistration = {
      name: 'mcp__srv__ping',
      label: 'srv / ping',
      description: 'Ping remote server',
      parameters: unsafe<Record<string, unknown>>({ type: 'object', properties: {} }),
      replay: 'unsafe',
      callers: ['tools'],
      mcpMeta: { server: 'srv', tool: 'ping', trusted: false },
      execute: async () => ({ output: [{ type: 'text', text: 'pong' }] })
    }

    const wrapped = wrapDurableTool(reg, { sessionId: 's1', spill: false })

    expect(wrapped.callers).toEqual(['tools'])
    expect(Object.prototype.hasOwnProperty.call(wrapped, 'callers')).toBe(false)
    expect(wrapped.name).toBe('mcp__srv__ping')
    expect((wrapped as McpToolRegistration).mcpMeta).toEqual(reg.mcpMeta)
  })

  it('CM2-HOST-02 buildSessionHostDeps 现读 session.codemode 与 session.codemodeMcpOnly，仅严格等于 "true" 时返回 true', () => {
    const store = new Map<string, string | undefined>()
    mocks.settingsGet.mockImplementation((key) => store.get(key))

    const deps = buildSessionHostDeps({}, () => undefined)
    expect(deps.codemode).toBeDefined()
    expect(deps.codemode?.isEnabled).toBeTypeOf('function')
    expect(deps.codemode?.mcpToolsOnly).toBeTypeOf('function')

    const nonTrueValues: Array<string | undefined> = [undefined, 'false', '1', '', 'TRUE']

    // session.codemode
    for (const val of nonTrueValues) {
      store.set('session.codemode', val)
      expect(deps.codemode!.isEnabled!(), `session.codemode=${String(val)}`).toBe(false)
    }
    store.set('session.codemode', 'true')
    expect(deps.codemode!.isEnabled!()).toBe(true)
    // 现读：再改回 false 立刻生效
    store.set('session.codemode', 'false')
    expect(deps.codemode!.isEnabled!()).toBe(false)

    // session.codemodeMcpOnly
    for (const val of nonTrueValues) {
      store.set('session.codemodeMcpOnly', val)
      expect(deps.codemode!.mcpToolsOnly!(), `session.codemodeMcpOnly=${String(val)}`).toBe(false)
    }
    store.set('session.codemodeMcpOnly', 'true')
    expect(deps.codemode!.mcpToolsOnly!()).toBe(true)
    // 现读：再改回 undefined 立刻生效
    store.set('session.codemodeMcpOnly', undefined)
    expect(deps.codemode!.mcpToolsOnly!()).toBe(false)

    // 确认只读了预期的两个设置键
    expect(mocks.settingsGet).toHaveBeenCalledWith('session.codemode')
    expect(mocks.settingsGet).toHaveBeenCalledWith('session.codemodeMcpOnly')
  })

  it('SO-04 wrapDurableTool 桌面双层包装原型链保留 structuredOutputSchema；正常执行保留 structuredOutput，被 L1 安全门拦截时不带 structuredOutput', async () => {
    const schema = obj({ files: arr(str()), truncated: bool() })
    const payload = { files: ['a.ts'], truncated: false }
    const tool: AnyTool = {
      name: 'ls_probe',
      label: 'ls probe',
      description: 'Structured probe',
      parameters: obj({}),
      replay: 'safe',
      structuredOutputSchema: schema,
      execute: async () => ({
        output: [{ type: 'text', text: 'a.ts' }],
        structuredOutput: payload
      })
    } as unknown as AnyTool

    // 1) 原型链保留 structuredOutputSchema（两层 Object.create 都不覆盖为 own 属性）
    const wrapped = wrapDurableTool(tool, { sessionId: 's-so04', spill: false })
    expect(wrapped.structuredOutputSchema).toBe(schema)
    expect(Object.prototype.hasOwnProperty.call(wrapped, 'structuredOutputSchema')).toBe(false)

    // 2) 正常执行保留 structuredOutput
    const ok = (await invokeTool(wrapped, {} as never)).result
    expect(ok.isError).toBeUndefined()
    expect((ok as { structuredOutput?: unknown }).structuredOutput).toEqual(payload)

    // 3) 被 L1 安全门拒绝（deny 抛错）时不带 structuredOutput
    const denySecurity = {
      enforceInvocation: vi.fn(async () => {
        throw new Error('denied by policy')
      })
    } as unknown as SecurityContext
    const denied = (
      await invokeTool(
        wrapDurableTool(tool, { sessionId: 's-so04', spill: false, security: denySecurity }),
        {} as never
      )
    ).result
    expect(denied.isError).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(denied, 'structuredOutput')).toBe(false)

    // 4) 被 L1 安全门转为反馈（feedback）时也不带 structuredOutput
    const feedbackSecurity = {
      enforceInvocation: vi.fn(async () => ({
        status: 'feedback' as const,
        text: 'use glob instead'
      }))
    } as unknown as SecurityContext
    const feedback = (
      await invokeTool(
        wrapDurableTool(tool, { sessionId: 's-so04', spill: false, security: feedbackSecurity }),
        {} as never
      )
    ).result
    expect(feedback.isError).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(feedback, 'structuredOutput')).toBe(false)
  })

  it('CW-D01 buildSessionHostDeps 现读 session.cacheWarming，仅严格等于 "true" 返回 true，其余返回 false', () => {
    const store = new Map<string, string | undefined>()
    mocks.settingsGet.mockImplementation((key) => store.get(key))

    const deps = buildSessionHostDeps({}, () => undefined)
    expect(deps.cacheWarming).toBeDefined()
    expect(deps.cacheWarming?.isEnabled).toBeTypeOf('function')

    const nonTrueValues: Array<string | undefined> = [undefined, 'false', '1', '', 'TRUE', ' true ']
    for (const val of nonTrueValues) {
      store.set('session.cacheWarming', val)
      expect(deps.cacheWarming!.isEnabled(), `session.cacheWarming=${String(val)}`).toBe(false)
    }

    store.set('session.cacheWarming', 'true')
    expect(deps.cacheWarming!.isEnabled()).toBe(true)

    // 现读：改回 false 立刻生效
    store.set('session.cacheWarming', 'false')
    expect(deps.cacheWarming!.isEnabled()).toBe(false)

    expect(mocks.settingsGet).toHaveBeenCalledWith('session.cacheWarming')
  })
})
