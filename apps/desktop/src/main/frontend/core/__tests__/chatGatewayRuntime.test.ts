/**
 * DefaultChatGateway 的运行时资源两件事 —— 会话状态条上的 `db` 一条，以及它的「断开」按钮；外加
 * `listTools` 里内置 database server 那一行。
 *
 *   GW-1  getRuntimeStatuses：`db` 一条就是连接池的 runtimeStatus（标签由连接池一处拼，
 *         「+N」与库名都在那里）；连接池说没有就没有 —— 网关不再自己拿 getConnectionInfo 拼；
 *   GW-2  destroyRuntime(sid, 'db')：没连着 → 什么都不做、答 false；连着 → 先断开、等断开落定，
 *         再广播 `status: null`，答 true；
 *   GW-3  listTools：`mcp:database` 行是内置的（isBuiltin），且没有任何一个基座档案声明它 ——
 *         它是会话里勾的能力，不是谁的默认（档案取真的内置 md，四种形态外加 coding）。
 *
 * 外加会话模型与运行时的写入口（ML-U-2..6）：
 *   ML-U-2/3/4  setModel：没有运行时 → 往会话树追加 model_change（恰一次、只三个参数）、答 true；
 *               有运行时（含创建中 / 关停中，即 hasAgentRuntime）→ 什么也不写、不碰运行时、不广播、
 *               答 false；追加失败 → reject；
 *   ML-U-5      setThinkingLevel：有活运行时交给它（不写树），没有直接写树；
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
  invalidateAgent: vi.fn<(sessionId: string) => Promise<void>>(),
  getAgentSession: vi.fn(),
  appendModelChange: vi.fn<(sessionId: string, provider: string, model: string) => Promise<void>>(),
  appendThinkingLevelChange: vi.fn<(sessionId: string, level: string) => Promise<void>>(),
  messageClear: vi.fn(),
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
    resolveAgentProfileName: mocks.resolveAgentProfileName,
    hasAgentRuntime: mocks.hasAgentRuntime,
    invalidateAgent: mocks.invalidateAgent
  }
}))
vi.mock('../../../services/messageService', () => ({
  messageService: { clear: mocks.messageClear }
}))
vi.mock('../../../services/sessionStorage', () => ({
  appendModelChange: mocks.appendModelChange,
  appendThinkingLevelChange: mocks.appendThinkingLevelChange
}))
vi.mock('../../../services/userInputBroker', () => ({ respondToUserInput: vi.fn() }))
vi.mock('../../../services/builtinMcp/dbConnections', () => ({
  dbManager: {
    runtimeStatus: mocks.runtimeStatus,
    getConnectionInfo: mocks.getConnectionInfo,
    disconnect: mocks.disconnect
  }
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
  recordUserPrompt: vi.fn(),
  recordFromUserMessageEvent: vi.fn()
}))

import { buildBuiltinProfiles } from '@shuvix/agent-runtime'
import { createInlineMdReader } from '@shuvix/agent-runtime/builtinAgents/inlineSources'

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
    mocks.invalidateAgent,
    mocks.getAgentSession,
    mocks.appendModelChange,
    mocks.appendThinkingLevelChange,
    mocks.messageClear
  ]) {
    fn.mockReset()
  }
  mocks.disconnect.mockResolvedValue(undefined)
  mocks.hasAgentRuntime.mockReturnValue(false)
  mocks.invalidateAgent.mockResolvedValue(undefined)
  mocks.getAgentSession.mockReturnValue(undefined)
  mocks.appendModelChange.mockResolvedValue(undefined)
  mocks.appendThinkingLevelChange.mockResolvedValue(undefined)
  mocks.mcpInfos = []
  mocks.builtinNames = ['read', 'bash']
})

describe('DefaultChatGateway.getRuntimeStatuses —— 状态条上的 db 一条', () => {
  it('GW-1a 连接池有 runtimeStatus → 原样作为 db 一条', () => {
    mocks.runtimeStatus.mockReturnValue(STATUS)

    expect(chatGateway.getRuntimeStatuses(SID)).toEqual({ db: STATUS })
    expect(mocks.runtimeStatus).toHaveBeenCalledWith(SID)
  })

  it('GW-1b 连接池说没有 → 空对象（即便 getConnectionInfo 还答得出东西，也不自己拼一条）', () => {
    mocks.runtimeStatus.mockReturnValue(undefined)
    mocks.getConnectionInfo.mockReturnValue(INFO)

    expect(chatGateway.getRuntimeStatuses(SID)).toEqual({})
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
      const profiles = buildBuiltinProfiles({ language, widgetsRoot: '/w', readMd })
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

describe('DefaultChatGateway.setModel —— 只在没有运行时的时候写', () => {
  it('ML-U-2 没有运行时 → 往会话树追加 model_change 恰一次（只这三个参数），答 true', async () => {
    mocks.hasAgentRuntime.mockReturnValue(false)

    await expect(chatGateway.setModel(SID, 'prov', 'model-b')).resolves.toBe(true)
    expect(mocks.hasAgentRuntime).toHaveBeenCalledWith(SID)
    expect(mocks.appendModelChange).toHaveBeenCalledTimes(1)
    expect(mocks.appendModelChange.mock.calls[0]).toEqual([SID, 'prov', 'model-b'])
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('ML-U-2 写入落定之前不答：追加挂着时 setModel 也挂着', async () => {
    let finish!: () => void
    mocks.appendModelChange.mockReturnValue(new Promise<void>((r) => (finish = r)))
    let settled = false
    const pending = chatGateway.setModel(SID, 'prov', 'model-b').then((v) => {
      settled = true
      return v
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    await expect(pending).resolves.toBe(true)
  })

  it('ML-U-3 有运行时（含创建中 / 关停中）→ 答 false：不写树、不取运行时、不广播', async () => {
    mocks.hasAgentRuntime.mockReturnValue(true)

    await expect(chatGateway.setModel(SID, 'prov', 'model-b')).resolves.toBe(false)
    expect(mocks.appendModelChange).not.toHaveBeenCalled()
    expect(mocks.getAgentSession).not.toHaveBeenCalled()
    expect(mocks.invalidateAgent).not.toHaveBeenCalled()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('ML-U-4 追加 model_change 失败 → setModel reject（错误原样上交，不吞成 false）', async () => {
    mocks.appendModelChange.mockRejectedValue(new Error('tree write failed'))

    await expect(chatGateway.setModel(SID, 'prov', 'model-b')).rejects.toThrow('tree write failed')
  })
})

describe('DefaultChatGateway.setThinkingLevel —— 运行期照样可改', () => {
  it('ML-U-5 有活运行时 → 交给它的 setThinkingLevel，不直接写树', async () => {
    const agent = { setThinkingLevel: vi.fn().mockResolvedValue(undefined) }
    mocks.getAgentSession.mockReturnValue(agent)
    mocks.hasAgentRuntime.mockReturnValue(true)

    await chatGateway.setThinkingLevel(SID, 'high')
    expect(mocks.getAgentSession).toHaveBeenCalledWith(SID)
    expect(agent.setThinkingLevel).toHaveBeenCalledTimes(1)
    expect(agent.setThinkingLevel).toHaveBeenCalledWith('high')
    expect(mocks.appendThinkingLevelChange).not.toHaveBeenCalled()
  })

  it('ML-U-5 没有运行时 → 直接往会话树追加 thinking_level_change', async () => {
    mocks.getAgentSession.mockReturnValue(undefined)

    await chatGateway.setThinkingLevel(SID, 'low')
    expect(mocks.appendThinkingLevelChange).toHaveBeenCalledTimes(1)
    expect(mocks.appendThinkingLevelChange.mock.calls[0]).toEqual([SID, 'low'])
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
