/**
 * DefaultChatGateway 的运行时资源两件事 —— 会话状态条上的 `db` 一条，以及它的「断开」按钮；外加
 * `listTools` 里内置 database server 那一行。
 *
 *   GW-1  getRuntimeStatuses：`db` 一条就是连接池的 runtimeStatus（标签由连接池一处拼，
 *         「+N」与库名都在那里）；连接池说没有就没有 —— 网关不再自己拿 getConnectionInfo 拼；
 *   GW-2  destroyRuntime(sid, 'db')：没连着 → 什么都不做、答 false；连着 → 先断开、等断开落定，
 *         再广播 `status: null`，答 true；
 *   GW-1c / GW-2d  ssh：每台连着的主机一条 `ssh:<alias>`，与 db 并列；`ssh:<alias>` 的断开按钮断的是
 *         那一台，等断开落定再广播 null —— 本来就没连着（master 空闲到点已退出）也照样收掉胶囊；
 *   GW-1d getRuntimeStatuses 是异步的：ssh 那一份可能要读用户的 ssh 配置（不能同步挂住主进程），
 *         网关**等它落定**再交出结果 —— 把一个 Promise 当对象并进去，ssh 胶囊就静默地没了；
 *   GW-3  listTools：`mcp:database` 行是内置的（isBuiltin），且没有任何一个基座档案声明它 ——
 *         它是会话里勾的能力，不是谁的默认（档案取真的内置 md，四种形态外加 coding）。
 *
 * 外加会话模型与运行时的写入口（ML-U-2..6）：
 *   ML-U-2/3/4  setModel（2026-10-26 起锁住的 agent 当场重配，RD-7）：整件交给 sessionService.setModel（恰一次、
 *               只三个参数），它答什么就答什么、等它落定才答、它 reject 就 reject；网关自己既不判运行时
 *               （hasAgentRuntime）也不写设置（recordSessionModel）；
 *   RD-7        previewAgentChange：(sessionId, change) 原样交给 sessionService.previewAgentChange，结果原样交回；
 *   ML-U-5      setThinkingLevel：会话设置恒写；会话开着再现场交给它（锁着但没开着 → peek 再给，D10-50）；
 *   ML-U-6      destroyAgent：invalidateAgent 恰一次、等它落定才 resolve；不清消息、不断 db、不广播。
 *
 * mock 骨架照抄 chatGatewayListTools.test.ts（网关的 import 图带 SQLite / electron / 全部工具）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { RuntimeStatus } from '@shuvix/chat-protocol/events'

const mocks = vi.hoisted(() => ({
  runtimeStatus: vi.fn(),
  getConnectionInfo: vi.fn(),
  disconnect: vi.fn(),
  broadcast: vi.fn(),
  resolveAgentProfileName: vi.fn(),
  getProfile: vi.fn(),
  hasAgentRuntime: vi.fn<(sessionId: string) => boolean>(),
  setModel: vi.fn<(sessionId: string, provider: string, model: string) => Promise<boolean>>(),
  previewAgentChange: vi.fn<(sessionId: string, change: unknown) => Promise<unknown>>(),
  invalidateAgent: vi.fn<(sessionId: string) => Promise<void>>(),
  getAgentSession: vi.fn(),
  peekAgentSession: vi.fn(),
  resolveRunConfig: vi.fn(),
  recordSessionModel:
    vi.fn<(sessionId: string, provider: string, model: string) => Promise<void>>(),
  recordSessionThinkingLevel: vi.fn<(sessionId: string, level: string) => Promise<void>>(),
  messageClear: vi.fn(),
  sshRuntimeStatuses: vi.fn<(sessionId: string) => Promise<Record<string, RuntimeStatus>>>(),
  sshDisconnectRuntime:
    vi.fn<(sessionId: string, runtimeId: string) => Promise<boolean> | undefined>(),
  respondToUserInput: vi.fn<(requestId: string, response: unknown, meta?: unknown) => boolean>(),
  mcpInfos: [] as Array<Record<string, unknown>>,
  builtinNames: ['read', 'bash'] as string[]
}))

vi.mock('../../../tools/allTools', () => ({}))
vi.mock('../../../services/toolRegistry', () => {
  const registry = {
    getBuiltinToolEntries: () =>
      mocks.builtinNames.map((name) => ({
        name,
        group: 'general' as const,
        getLabel: () => name,
        getHint: () => `${name} hint`
      }))
  }
  // 平台特定工具（bash / powershell）按平台过滤后的那份；本组的桩都不声明平台
  return { ...registry, getPlatformBuiltinToolEntries: registry.getBuiltinToolEntries }
})
vi.mock('../../../services/sessionService', () => ({
  sessionService: {
    ensureAgentSession: vi.fn(),
    getAgentSession: mocks.getAgentSession,
    peekAgentSession: mocks.peekAgentSession,
    resolveRunConfig: mocks.resolveRunConfig,
    resolveAgentProfileName: mocks.resolveAgentProfileName,
    hasAgentRuntime: mocks.hasAgentRuntime,
    setModel: mocks.setModel,
    previewAgentChange: mocks.previewAgentChange,
    invalidateAgent: mocks.invalidateAgent
  }
}))
vi.mock('../../../services/messageService', () => ({
  messageService: { clear: mocks.messageClear }
}))
vi.mock('../../../services/sessionStorage', () => ({
  recordSessionModel: mocks.recordSessionModel,
  recordSessionThinkingLevel: mocks.recordSessionThinkingLevel
}))
vi.mock('../../../services/userInputBroker', () => ({
  respondToUserInput: mocks.respondToUserInput
}))
vi.mock('../../../services/builtinMcp/dbConnections', () => ({
  dbManager: {
    runtimeStatus: mocks.runtimeStatus,
    getConnectionInfo: mocks.getConnectionInfo,
    disconnect: mocks.disconnect
  }
}))
// 不 mock 的话，状态条快照会去读这台机器真实的 ~/.ssh/config 与 /tmp 下的 control socket
vi.mock('../../../services/builtinMcp/sshServer', () => ({
  sshRuntimeStatuses: mocks.sshRuntimeStatuses,
  sshDisconnectRuntime: mocks.sshDisconnectRuntime
}))
vi.mock('../../../services/mcpService', () => ({
  mcpService: { getAllToolInfos: () => mocks.mcpInfos }
}))
vi.mock('../../../services/skillService', () => ({
  skillService: { findEnabled: () => [] }
}))
vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: { findById: () => ({ id: 's1', projectId: null }), touchActive: vi.fn() }
}))
vi.mock('../../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../../../services/agentService', () => ({
  agentService: { getProfile: mocks.getProfile }
}))
vi.mock('../ChatFrontendRegistry', () => ({ chatFrontendRegistry: { broadcast: mocks.broadcast } }))
vi.mock('../../../services/sessionDayPromptService', () => ({
  recordUserEntry: vi.fn()
}))

import { buildBuiltinProfiles } from '@shuvix/agent-runtime'
import { createInlineMdReader } from '@shuvix/agent-runtime/builtinAgents/inlineSources'
import { setRedactionPolicy } from '../../../services/redactionPolicySeam'

let chatGateway: (typeof import('../DefaultChatGateway'))['chatGateway']

beforeAll(async () => {
  ;({ chatGateway } = await import('../DefaultChatGateway'))
})

const SID = 's1'
const STATUS: RuntimeStatus = {
  label: 'postgresql hr +1',
  icon: 'Database',
  color: '#f59e0b',
  description: 'db.example'
}
const INFO = { host: 'db.example', database: 'hr', dbType: 'postgresql', username: 'alice' }

beforeEach(() => {
  for (const fn of [
    mocks.runtimeStatus,
    mocks.getConnectionInfo,
    mocks.disconnect,
    mocks.broadcast,
    mocks.resolveAgentProfileName,
    mocks.getProfile,
    mocks.hasAgentRuntime,
    mocks.setModel,
    mocks.previewAgentChange,
    mocks.invalidateAgent,
    mocks.getAgentSession,
    mocks.recordSessionModel,
    mocks.recordSessionThinkingLevel,
    mocks.messageClear,
    mocks.sshRuntimeStatuses,
    mocks.sshDisconnectRuntime
  ]) {
    fn.mockReset()
  }
  mocks.sshRuntimeStatuses.mockResolvedValue({})
  // 与真件同一口径：不是 `ssh:` 开头的运行时一律答 undefined（不归它管）
  mocks.sshDisconnectRuntime.mockReturnValue(undefined)
  mocks.disconnect.mockResolvedValue(undefined)
  mocks.hasAgentRuntime.mockReturnValue(false)
  mocks.setModel.mockResolvedValue(true)
  mocks.invalidateAgent.mockResolvedValue(undefined)
  mocks.getAgentSession.mockReturnValue(undefined)
  mocks.recordSessionModel.mockResolvedValue(undefined)
  mocks.recordSessionThinkingLevel.mockResolvedValue(undefined)
  mocks.mcpInfos = []
  mocks.builtinNames = ['read', 'bash']
})

describe('DefaultChatGateway.getRuntimeStatuses —— 状态条上的 db 一条', () => {
  it('GW-1a 连接池有 runtimeStatus → 原样作为 db 一条', async () => {
    mocks.runtimeStatus.mockReturnValue(STATUS)

    await expect(chatGateway.getRuntimeStatuses(SID)).resolves.toEqual({ db: STATUS })
    expect(mocks.runtimeStatus).toHaveBeenCalledWith(SID)
  })

  it('GW-1b 连接池说没有 → 空对象（即便 getConnectionInfo 还答得出东西，也不自己拼一条）', async () => {
    mocks.runtimeStatus.mockReturnValue(undefined)
    mocks.getConnectionInfo.mockReturnValue(INFO)

    await expect(chatGateway.getRuntimeStatuses(SID)).resolves.toEqual({})
  })

  it('GW-1c 连着的每台 ssh 主机各一条 ssh:<alias>，与 db 并列', async () => {
    const web: RuntimeStatus = { label: 'web', icon: 'Terminal', color: '#38bdf8' }
    const api: RuntimeStatus = { label: 'api', icon: 'Terminal', color: '#38bdf8' }
    mocks.runtimeStatus.mockReturnValue(STATUS)
    mocks.sshRuntimeStatuses.mockResolvedValue({ 'ssh:web': web, 'ssh:api': api })

    await expect(chatGateway.getRuntimeStatuses(SID)).resolves.toEqual({
      db: STATUS,
      'ssh:web': web,
      'ssh:api': api
    })
    expect(mocks.sshRuntimeStatuses).toHaveBeenCalledWith(SID)
  })

  it('GW-1d 异步：返回 Promise，等 ssh 那一份落定才交出结果（形状同上）', async () => {
    const web: RuntimeStatus = { label: 'web', icon: 'Terminal', color: '#38bdf8' }
    let release!: (v: Record<string, RuntimeStatus>) => void
    mocks.runtimeStatus.mockReturnValue(STATUS)
    mocks.sshRuntimeStatuses.mockReturnValue(new Promise((r) => (release = r)))

    const pending = chatGateway.getRuntimeStatuses(SID)
    expect(pending).toBeInstanceOf(Promise)
    let settled = false
    void pending.then(() => (settled = true))
    await new Promise((r) => setImmediate(r))
    // ssh 还没答：网关不先交一份缺了 ssh 的结果
    expect(settled).toBe(false)

    release({ 'ssh:web': web })
    await expect(pending).resolves.toEqual({ db: STATUS, 'ssh:web': web })
  })
})

describe('DefaultChatGateway.destroyRuntime(sid, "db") —— 状态条上的断开按钮', () => {
  it('GW-2a 本来没连着 → 答 false：不断开、不广播', async () => {
    mocks.getConnectionInfo.mockReturnValue(undefined)

    await expect(chatGateway.destroyRuntime(SID, 'db')).resolves.toEqual({ success: false })
    expect(mocks.disconnect).not.toHaveBeenCalled()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('GW-2b 连着 → 断开本会话的全部连接，等断开落定之后才广播 status:null，答 true', async () => {
    mocks.getConnectionInfo.mockReturnValue(INFO)
    let finish!: () => void
    mocks.disconnect.mockReturnValue(new Promise<void>((r) => (finish = r)))

    const pending = chatGateway.destroyRuntime(SID, 'db')
    await Promise.resolve()
    expect(mocks.disconnect).toHaveBeenCalledWith(SID)
    // 断开还没落定：状态条不能先一步说「没了」
    expect(mocks.broadcast).not.toHaveBeenCalled()

    finish()
    await expect(pending).resolves.toEqual({ success: true })
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.broadcast).toHaveBeenCalledTimes(1)
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: 'runtime_event',
      sessionId: SID,
      runtimeId: 'db',
      status: null
    })
  })

  it('GW-2d ssh:<alias> → 断开那一台，等断开落定再广播它的 status:null，答 true；不碰 db 连接池', async () => {
    let finish!: (wasConnected: boolean) => void
    mocks.sshDisconnectRuntime.mockImplementation((_sid, id) =>
      id.startsWith('ssh:') ? new Promise<boolean>((r) => (finish = r)) : undefined
    )

    const pending = chatGateway.destroyRuntime(SID, 'ssh:web')
    await Promise.resolve()
    expect(mocks.sshDisconnectRuntime).toHaveBeenCalledWith(SID, 'ssh:web')
    expect(mocks.broadcast).not.toHaveBeenCalled()

    // 本来就没连着（master 空闲到点已自己退出）：胶囊照样收掉
    finish(false)
    await expect(pending).resolves.toEqual({ success: true })
    expect(mocks.broadcast).toHaveBeenCalledTimes(1)
    expect(mocks.broadcast).toHaveBeenCalledWith({
      type: 'runtime_event',
      sessionId: SID,
      runtimeId: 'ssh:web',
      status: null
    })
    expect(mocks.getConnectionInfo).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
  })

  it('GW-2c 不认识的运行时 → 答 false，不碰连接池', async () => {
    await expect(chatGateway.destroyRuntime(SID, 'nope')).resolves.toEqual({ success: false })
    expect(mocks.getConnectionInfo).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
})

describe('DefaultChatGateway.listTools —— 内置 database server 那一行', () => {
  const readMd = createInlineMdReader()

  it.each(['en', 'zh', 'ja'])(
    'GW-3 (%s) 五个基座档案（work / chat / notebook / bot / coding）都不声明 mcp:database；那一行是内置的、没有 declaredBy；退役的 database 工具不是谁的默认',
    (language) => {
      const profiles = buildBuiltinProfiles({ language, readMd })
      mocks.getProfile.mockImplementation((name: string) => profiles.find((p) => p.name === name))
      mocks.mcpInfos = [
        {
          name: 'mcp:database',
          label: 'database',
          group: 'mcp:database',
          serverStatus: 'disconnected',
          isBuiltin: true
        }
      ]
      // 就算注册表里还残留着一个叫 database 的内置工具，也没有哪个基座会默认勾上它
      mocks.builtinNames = ['read', 'bash', 'database']

      for (const form of ['work', 'chat', 'notebook', 'bot', 'coding']) {
        mocks.resolveAgentProfileName.mockReturnValue(form)
        expect(
          profiles.some((p) => p.name === form),
          `${form} 档案存在`
        ).toBe(true)

        const rows = chatGateway.listTools(SID)
        const row = rows.find((r) => r.name === 'mcp:database')
        expect(row, form).toMatchObject({ name: 'mcp:database', isBuiltin: true })
        expect(row?.declaredBy, form).toBeUndefined()
        expect(rows.find((r) => r.name === 'database')?.defaultEnabled, form).toBe(false)
      }
    }
  )
})

// ─── 会话模型与运行时（ML-U-2..6） ──────────────────────────────────────────

describe('DefaultChatGateway.setModel —— 整件交给 sessionService.setModel（RD-7）', () => {
  it.each<[boolean]>([[true], [false]])(
    'ML-U-2 sessionService.setModel 恰一次（只这三个参数），它答什么就答什么（%s）；网关自己不判运行时、不写设置、不广播',
    async (answer) => {
      mocks.setModel.mockResolvedValue(answer)

      await expect(chatGateway.setModel(SID, 'prov', 'model-b')).resolves.toBe(answer)
      expect(mocks.setModel).toHaveBeenCalledTimes(1)
      expect(mocks.setModel.mock.calls[0]).toEqual([SID, 'prov', 'model-b'])
      expect(mocks.hasAgentRuntime).not.toHaveBeenCalled()
      expect(mocks.recordSessionModel).not.toHaveBeenCalled()
      expect(mocks.getAgentSession).not.toHaveBeenCalled()
      expect(mocks.broadcast).not.toHaveBeenCalled()
    }
  )

  it('ML-U-2 写入与重配落定之前不答：sessionService.setModel 挂着时 setModel 也挂着', async () => {
    let finish!: (accepted: boolean) => void
    mocks.setModel.mockReturnValue(new Promise<boolean>((r) => (finish = r)))
    let settled = false
    const pending = chatGateway.setModel(SID, 'prov', 'model-b').then((v) => {
      settled = true
      return v
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    finish(true)
    await expect(pending).resolves.toBe(true)
  })

  it('ML-U-3 锁住的 agent 用不了这个模型（sessionService 答 false）→ 答 false：网关不另写、不碰运行时', async () => {
    mocks.setModel.mockResolvedValue(false)
    mocks.hasAgentRuntime.mockReturnValue(true)

    await expect(chatGateway.setModel(SID, 'prov', 'model-b')).resolves.toBe(false)
    expect(mocks.recordSessionModel).not.toHaveBeenCalled()
    expect(mocks.getAgentSession).not.toHaveBeenCalled()
    expect(mocks.invalidateAgent).not.toHaveBeenCalled()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('ML-U-4 sessionService.setModel 失败 → setModel reject（错误原样上交，不吞成 false）', async () => {
    mocks.setModel.mockRejectedValue(new Error('settings write failed'))

    await expect(chatGateway.setModel(SID, 'prov', 'model-b')).rejects.toThrow(
      'settings write failed'
    )
  })
})

describe('DefaultChatGateway.previewAgentChange —— 原样交给 sessionService（RD-7）', () => {
  it('RD-7 (sessionId, change) 原样交出、结果原样交回；只这一次调用，网关不写也不判运行时', async () => {
    const verdict = { locked: true, cache: 'lost', reasons: ['model'], promptTokens: 4200 }
    mocks.previewAgentChange.mockResolvedValue(verdict)
    const change = { enabledTools: ['mcp:a'], provider: 'prov', model: 'model-b' }

    await expect(chatGateway.previewAgentChange(SID, change)).resolves.toBe(verdict)
    expect(mocks.previewAgentChange.mock.calls).toEqual([[SID, change]])
    expect(mocks.previewAgentChange.mock.calls[0][1]).toBe(change)
    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(mocks.recordSessionModel).not.toHaveBeenCalled()
    expect(mocks.hasAgentRuntime).not.toHaveBeenCalled()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('RD-7 sessionService.previewAgentChange reject → 原样 reject', async () => {
    mocks.previewAgentChange.mockRejectedValue(new Error('catalog exploded'))
    await expect(chatGateway.previewAgentChange(SID, {})).rejects.toThrow('catalog exploded')
  })
})

describe('DefaultChatGateway.setThinkingLevel —— 运行期照样可改', () => {
  it('ML-U-5 会话开着 → 设置照写，并现场交给它的 setThinkingLevel', async () => {
    const agent = { setThinkingLevel: vi.fn().mockResolvedValue(undefined) }
    mocks.getAgentSession.mockReturnValue(agent)
    mocks.hasAgentRuntime.mockReturnValue(true)

    await chatGateway.setThinkingLevel(SID, 'high')
    expect(mocks.getAgentSession).toHaveBeenCalledWith(SID)
    expect(agent.setThinkingLevel).toHaveBeenCalledTimes(1)
    expect(agent.setThinkingLevel).toHaveBeenCalledWith('high')
    // 会话设置是事实源：下一次创建 agent、选择器都读它
    expect(mocks.recordSessionThinkingLevel.mock.calls).toEqual([[SID, 'high']])
  })

  it('ML-U-5 没有运行时 → 只写会话设置', async () => {
    mocks.getAgentSession.mockReturnValue(undefined)

    await chatGateway.setThinkingLevel(SID, 'low')
    expect(mocks.recordSessionThinkingLevel).toHaveBeenCalledTimes(1)
    expect(mocks.recordSessionThinkingLevel.mock.calls[0]).toEqual([SID, 'low'])
  })
})

describe('DefaultChatGateway.destroyAgent —— 销毁运行时，会话与会话级资源都留着', () => {
  it('ML-U-6 invalidateAgent 恰一次，等它落定才 resolve；不清消息、不断 db、不广播', async () => {
    let finish!: () => void
    mocks.invalidateAgent.mockReturnValue(new Promise<void>((r) => (finish = r)))

    let settled = false
    const pending = chatGateway.destroyAgent(SID).then(() => {
      settled = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.invalidateAgent).toHaveBeenCalledTimes(1)
    expect(mocks.invalidateAgent).toHaveBeenCalledWith(SID)
    // 关停还没落定：调用方（胶囊上的 X）此刻重拉监控只会看到旧运行时
    expect(settled).toBe(false)

    finish()
    await pending
    expect(settled).toBe(true)
    expect(mocks.invalidateAgent).toHaveBeenCalledTimes(1)
    expect(mocks.messageClear).not.toHaveBeenCalled()
    expect(mocks.disconnect).not.toHaveBeenCalled()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
})

describe('P3-08-45 DefaultChatGateway.respondToInput —— 没人认领什么都不广播', () => {
  it('broker 认领 → true；没人认领 → false；两种都不广播，答题方原样交给 broker', () => {
    const response = { kind: 'ask' as const, allowed: true }
    mocks.respondToUserInput.mockReset().mockReturnValueOnce(true).mockReturnValueOnce(false)
    expect(chatGateway.respondToInput(SID, 'r1', response, { clientId: 'ipc:3' })).toBe(true)
    expect(chatGateway.respondToInput(SID, 'r2', response)).toBe(false)
    expect(mocks.respondToUserInput.mock.calls).toEqual([
      ['r1', response, { clientId: 'ipc:3' }],
      ['r2', response, undefined]
    ])
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })
})

describe('自动脱敏：resolveRedactions', () => {
  const KEY = '{{API_KEY_k3v7x2mq}}'
  const SEALED = '{{SECRET_aaaaaaaa}}'
  const items: Record<string, { category: string; rule: string; value?: string }> = {
    [KEY]: { category: 'API_KEY', rule: 'sk-key', value: 'sk-real' },
    [SEALED]: { category: 'SECRET', rule: 'secret-field' }
  }
  const sessionWith = (redaction: unknown, lock?: unknown): unknown => ({
    durable: { redaction, lock }
  })
  const table = { get: (p: string) => items[p] }

  beforeEach(() => {
    mocks.getAgentSession.mockReset()
    mocks.peekAgentSession.mockReset()
    mocks.resolveRunConfig.mockReset()
    mocks.resolveRunConfig.mockResolvedValue(null)
  })

  it('RR-1 打开着的会话：有真值的带真值、解不开的只有类别、表里没有的不出现；不是标准写法的不问', async () => {
    mocks.getAgentSession.mockReturnValue(sessionWith({ table: async () => table }))
    const result = await chatGateway.resolveRedactions(SID, [
      KEY,
      SEALED,
      '{{TOKEN_bbbbbbbb}}',
      '{{ API_KEY_k3v7x2mq }}',
      42 as unknown as string
    ])
    expect(result).toEqual({
      [KEY]: { category: 'API_KEY', value: 'sk-real', disclosed: false },
      [SEALED]: { category: 'SECRET' }
    })
    expect(mocks.peekAgentSession).not.toHaveBeenCalled()
  })

  it('RR-2 没开着就 peek；peek 不到 / 会话没有脱敏 / 什么都没问 → 空', async () => {
    mocks.getAgentSession.mockReturnValue(undefined)
    mocks.peekAgentSession.mockResolvedValue(sessionWith({ table: async () => table }))
    expect(await chatGateway.resolveRedactions(SID, [KEY])).toEqual({
      [KEY]: { category: 'API_KEY', value: 'sk-real', disclosed: false }
    })
    mocks.peekAgentSession.mockResolvedValue(undefined)
    expect(await chatGateway.resolveRedactions(SID, [KEY])).toEqual({})
    mocks.peekAgentSession.mockResolvedValue(sessionWith(undefined))
    expect(await chatGateway.resolveRedactions(SID, [KEY])).toEqual({})
    mocks.peekAgentSession.mockClear()
    expect(await chatGateway.resolveRedactions(SID, [])).toEqual({})
    expect(mocks.peekAgentSession).not.toHaveBeenCalled()
  })

  it('RR-3 模型收到的是不是真值：按会话锁住的模型、与出口同一份判定；没有锁按设定的模型，也没有就当占位符', async () => {
    const seen: unknown[] = []
    setRedactionPolicy((request) => {
      seen.push(request)
      return request.provider === 'home'
        ? { applies: false, disclose: () => 'redact' }
        : {
            applies: true,
            disclose: ({ category }) => (category === 'API_KEY' ? 'redact' : 'send')
          }
    })
    const withLock = (provider: string): unknown =>
      sessionWith({ table: async () => table }, { model: { provider, modelId: 'm1' } })
    mocks.getAgentSession.mockReturnValue(withLock('cloud'))
    expect((await chatGateway.resolveRedactions(SID, [KEY]))[KEY]?.disclosed).toBe(false)
    expect(seen).toEqual([{ sessionId: SID, provider: 'cloud', model: 'm1' }])
    mocks.getAgentSession.mockReturnValue(withLock('home'))
    expect((await chatGateway.resolveRedactions(SID, [KEY]))[KEY]?.disclosed).toBe(true)
    // 没有锁（这次启动后还没跑过）：按会话设定的模型判
    mocks.getAgentSession.mockReturnValue(sessionWith({ table: async () => table }))
    expect((await chatGateway.resolveRedactions(SID, [KEY]))[KEY]?.disclosed).toBe(false)
    mocks.resolveRunConfig.mockResolvedValue({
      model: { provider: 'home', model: 'm2', capabilities: {} },
      thinkingLevel: 'off'
    })
    expect((await chatGateway.resolveRedactions(SID, [KEY]))[KEY]?.disclosed).toBe(true)
    expect(seen.at(-1)).toEqual({ sessionId: SID, provider: 'home', model: 'm2' })
    mocks.resolveRunConfig.mockRejectedValue(new Error('gone'))
    expect((await chatGateway.resolveRedactions(SID, [KEY]))[KEY]?.disclosed).toBe(false)
    setRedactionPolicy((request) => {
      throw new Error(`no policy for ${request.sessionId}`)
    })
    mocks.getAgentSession.mockReturnValue(withLock('cloud'))
    // 判定抛错：当作收到的是占位符，真值照样交回
    expect(await chatGateway.resolveRedactions(SID, [KEY])).toEqual({
      [KEY]: { category: 'API_KEY', value: 'sk-real', disclosed: false }
    })
  })
})
