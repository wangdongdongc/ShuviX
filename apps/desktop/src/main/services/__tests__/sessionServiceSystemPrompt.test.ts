/**
 * sessionService —— 冻结的系统提示词的两个入口（2026-11-06，用户裁决「历史状态不变」）：
 * `systemPromptStatus`（只读：哪几段的来源改了）与 `rebuildSystemPrompt`（删掉冻结的那份，下一条消息重新渲染）。
 *
 * 契约（根 CLAUDE.md「Session extensions」、chat-protocol `systemPromptStatus.ts`）：
 *   DSS-1 status：会话开着 → 就问它（不 peek），运行时的答复原样交回；
 *   DSS-2 status：没开着但存储在 → peek 打开（从不 open / 创建）再问；
 *   DSS-3 status：没有存储 / 旧格式（不是 durable 会话）/ 宿主已封存 → `{frozen:false, stale:[]}`，不碰运行时；
 *   DSS-4 status：peek 失败 → none + 一条 warn（带会话 id）；运行时抛 SessionClosedError（读的途中关了）→ none；
 *         别的错误原样上抛；
 *   DSS-5 rebuild 成功 → 结果原样交回，桌面侧随 agent 的状态（`clearAgentScopedState`：fileTime 的已读记录，
 *         agentSession.ts）恰清一次、按这条会话；没开着就 peek 打开再重建；
 *   DSS-6 rebuild 答 busy → 原样交回，不清任何东西；
 *   DSS-7 rebuild 途中会话关了（SessionClosedError，D8）→ `{success:false, reason:'busy'}`、不清；别的错误原样上抛；
 *         peek 自己失败也原样上抛（与 status 不同：重建是用户点的写操作，界面拿到拒绝会重问一次状态）；
 *   DSS-8 rebuild：没有存储 / 旧格式 → `{success:true}`（本来就没冻结），不碰运行时；`invalidateAgent`（芯片上的 X）
 *         从不顺带重建 —— 只销毁 agent，冻结的提示词不碰。
 *
 * mock 面照抄 sessionServiceReconfigure.test.ts（import 图全换假件、会话运行时换成假宿主），外加可拨的
 * `isDurableSession`（旧格式的会话）与记录 warn 的日志。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { SessionClosedError } from '@shuvix/agent-runtime'
import type { SystemPromptStatus } from '@shuvix/chat-protocol/systemPromptStatus'
import {
  agentSessionSpies,
  fakeHost,
  lockRecord,
  resetFakeHost,
  type FakeDurableSession
} from './support/fakeSessionHost'

const mocks = vi.hoisted(() => ({
  isDurableSession: vi.fn<(sessionId: string) => boolean>(() => true),
  warn: vi.fn<(message: string) => void>()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: vi.fn(),
    pickSettings: vi.fn(),
    updateSettings: vi.fn(),
    insert: vi.fn(),
    findById: vi.fn(),
    deleteById: vi.fn(),
    findChildren: vi.fn(() => []),
    updateProjectId: vi.fn(),
    updateTitle: vi.fn(),
    touchActive: vi.fn()
  }
}))
vi.mock('../../dao/sessionDayPromptDao', () => ({
  sessionDayPromptDao: { deleteBySessionId: vi.fn() }
}))
vi.mock('../sessionDayPromptService', () => ({
  recordUserEntry: vi.fn(),
  recordSessionCreated: vi.fn()
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    findModelsByProvider: vi.fn(() => []),
    findEnabled: vi.fn(() => []),
    findEnabledModels: vi.fn(() => [])
  }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../models', () => ({
  getModelRegistry: vi.fn(),
  providerCredentialPort: { listProviders: vi.fn(() => []) }
}))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  isDurableSession: mocks.isDurableSession,
  readSessionRunConfig: vi.fn(async () => ({})),
  recordSessionModel: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (sid: string) => `/nonexistent/shuvix-unit/tmp/${sid}`,
  getToolResultsBase: () => '/nonexistent/shuvix-unit/tool-results'
}))
vi.mock('../mcpService', () => ({ mcpService: { closeSession: vi.fn() } }))
vi.mock('../toolAggregator', () => ({ filterAvailableTools: vi.fn((tools: string[]) => tools) }))
vi.mock('../acl', () => ({ sessionAcl: { initialize: vi.fn(), deleteSession: vi.fn() } }))
vi.mock('../agentService', () => ({
  agentService: {
    getProfile: vi.fn((name: string) => ({
      name,
      tools: [],
      promptBlocks: []
    }))
  }
}))
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../agentSession', async () =>
  (await import('./support/fakeSessionHost')).agentSessionModuleMock()
)
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../userInputBroker', () => ({ registerUserInputParticipant: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
}))

let sessionService: (typeof import('../sessionService'))['sessionService']

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

const NONE: SystemPromptStatus = { frozen: false, stale: [] }
const STALE: SystemPromptStatus = {
  frozen: true,
  stale: [{ key: 'persona' }, { key: 'claude_md', file: 'CLAUDE.md' }]
}

let seq = 0
let SID = ''

/** 某一笔 warn 里有没有这段字 */
const warned = (text: string): boolean =>
  mocks.warn.mock.calls.some(([message]) => String(message).includes(text))

/** 让假会话的这两个方法之一抛错 */
function failWith(
  session: FakeDurableSession,
  method: 'systemPromptStatus' | 'rebuildSystemPrompt',
  error: unknown
): void {
  vi.spyOn(session, method).mockImplementation(async () => {
    throw error
  })
}

beforeEach(() => {
  seq += 1
  SID = `sp-${seq}`
  mocks.isDurableSession.mockReset().mockReturnValue(true)
  mocks.warn.mockReset()
  agentSessionSpies.clearAgentScopedState.mockReset()
  resetFakeHost()
})

// ─── systemPromptStatus ─────────────────────────────────────────────────────

describe('DSS-1..4 systemPromptStatus', () => {
  it('DSS-1 会话开着 → 问它一次，答复原样交回；不 peek、不 open', async () => {
    const session = fakeHost.put(SID, { promptStatus: STALE })
    await expect(sessionService.systemPromptStatus(SID)).resolves.toBe(STALE)
    expect(session.callsOf('systemPromptStatus')).toHaveLength(1)
    expect(fakeHost.callsOf('peek')).toEqual([])
    expect(fakeHost.callsOf('open')).toEqual([])
    // 只读：不销毁、不重建
    expect(session.callsOf('destroyAgent')).toEqual([])
    expect(session.callsOf('rebuildSystemPrompt')).toEqual([])
  })

  it('DSS-2 没开着但存储在 → peek 打开（从不 open）再问', async () => {
    fakeHost.storages.add(SID)
    fakeHost.configure = (session) => {
      session.promptStatus = STALE
    }
    await expect(sessionService.systemPromptStatus(SID)).resolves.toEqual(STALE)
    expect(fakeHost.callsOf('peek')).toEqual([SID])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.get(SID)!.callsOf('systemPromptStatus')).toHaveLength(1)
  })

  it('DSS-3 没有存储 → none，不打开任何会话', async () => {
    await expect(sessionService.systemPromptStatus(SID)).resolves.toEqual(NONE)
    expect(fakeHost.callsOf('peek')).toEqual([SID])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.sessions.size).toBe(0)
  })

  it('DSS-3 旧格式（不是 durable 会话）→ none，连 peek 都不调；宿主已封存 → none', async () => {
    mocks.isDurableSession.mockReturnValue(false)
    fakeHost.storages.add(SID)
    await expect(sessionService.systemPromptStatus(SID)).resolves.toEqual(NONE)
    expect(mocks.isDurableSession).toHaveBeenCalledWith(SID)
    expect(fakeHost.callsOf('peek')).toEqual([])

    mocks.isDurableSession.mockReturnValue(true)
    fakeHost.sealed = true
    await expect(sessionService.systemPromptStatus(SID)).resolves.toEqual(NONE)
    expect(fakeHost.sessions.size).toBe(0)
  })

  it('DSS-4 peek 失败 → none + 一条带会话 id 的 warn（不上抛）', async () => {
    vi.spyOn(fakeHost, 'peek').mockRejectedValue(new Error('disk on fire'))
    await expect(sessionService.systemPromptStatus(SID)).resolves.toEqual(NONE)
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    expect(warned(SID)).toBe(true)
    expect(warned('disk on fire')).toBe(true)
  })

  it('DSS-4 读的途中会话关了（SessionClosedError）→ none、不记 warn', async () => {
    const session = fakeHost.put(SID)
    failWith(session, 'systemPromptStatus', new SessionClosedError(SID))
    await expect(sessionService.systemPromptStatus(SID)).resolves.toEqual(NONE)
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  it('DSS-4 别的错误 → 原样上抛', async () => {
    const session = fakeHost.put(SID)
    failWith(session, 'systemPromptStatus', new Error('compare exploded'))
    await expect(sessionService.systemPromptStatus(SID)).rejects.toThrow('compare exploded')
  })
})

// ─── rebuildSystemPrompt ────────────────────────────────────────────────────

describe('DSS-5..8 rebuildSystemPrompt', () => {
  it('DSS-5 开着、有锁 → 交给运行时一次，{success:true} 原样交回；随 agent 的桌面状态（fileTime）恰清一次', async () => {
    const session = fakeHost.put(SID, { lock: lockRecord() })
    const result = await sessionService.rebuildSystemPrompt(SID)
    expect(result).toEqual({ success: true })
    expect(session.callsOf('rebuildSystemPrompt')).toHaveLength(1)
    expect(agentSessionSpies.clearAgentScopedState.mock.calls).toEqual([[SID]])
    // 重建由运行时自己销毁 agent：门面不另调 destroyAgent
    expect(session.callsOf('destroyAgent')).toEqual([])
    expect(session.lock).toBeUndefined()
    expect(fakeHost.callsOf('peek')).toEqual([])
  })

  it('DSS-5 没开着但存储在 → peek 打开再重建（从不 open）', async () => {
    fakeHost.storages.add(SID)
    await expect(sessionService.rebuildSystemPrompt(SID)).resolves.toEqual({ success: true })
    expect(fakeHost.callsOf('peek')).toEqual([SID])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.get(SID)!.callsOf('rebuildSystemPrompt')).toHaveLength(1)
    expect(agentSessionSpies.clearAgentScopedState.mock.calls).toEqual([[SID]])
  })

  it('DSS-6 运行时答 busy → 原样交回，不清任何东西', async () => {
    const busy = { success: false, reason: 'busy' } as const
    const session = fakeHost.put(SID, { lock: lockRecord(), rebuildResult: busy })
    await expect(sessionService.rebuildSystemPrompt(SID)).resolves.toEqual(busy)
    expect(session.callsOf('rebuildSystemPrompt')).toHaveLength(1)
    expect(agentSessionSpies.clearAgentScopedState).not.toHaveBeenCalled()
    expect(session.lock).toBeDefined()
  })

  it('DSS-7 重建途中会话关了（SessionClosedError）→ 当忙：{success:false, reason:busy}，不清', async () => {
    const session = fakeHost.put(SID, { lock: lockRecord() })
    failWith(session, 'rebuildSystemPrompt', new SessionClosedError(SID))
    await expect(sessionService.rebuildSystemPrompt(SID)).resolves.toEqual({
      success: false,
      reason: 'busy'
    })
    expect(agentSessionSpies.clearAgentScopedState).not.toHaveBeenCalled()
  })

  it('DSS-7 别的错误原样上抛、不清；peek 自己失败也原样上抛', async () => {
    const session = fakeHost.put(SID, { lock: lockRecord() })
    failWith(session, 'rebuildSystemPrompt', new Error('commit exploded'))
    await expect(sessionService.rebuildSystemPrompt(SID)).rejects.toThrow('commit exploded')
    expect(agentSessionSpies.clearAgentScopedState).not.toHaveBeenCalled()

    const other = `${SID}-closed`
    vi.spyOn(fakeHost, 'peek').mockRejectedValue(new Error('disk on fire'))
    await expect(sessionService.rebuildSystemPrompt(other)).rejects.toThrow('disk on fire')
    expect(agentSessionSpies.clearAgentScopedState).not.toHaveBeenCalled()
  })

  it('DSS-8 没有存储 / 旧格式 → {success:true}（本来就没冻结），不碰运行时、不清', async () => {
    await expect(sessionService.rebuildSystemPrompt(SID)).resolves.toEqual({ success: true })
    expect(fakeHost.sessions.size).toBe(0)
    expect(fakeHost.callsOf('open')).toEqual([])

    mocks.isDurableSession.mockReturnValue(false)
    fakeHost.storages.add(SID)
    await expect(sessionService.rebuildSystemPrompt(SID)).resolves.toEqual({ success: true })
    expect(fakeHost.sessions.size).toBe(0)
    expect(agentSessionSpies.clearAgentScopedState).not.toHaveBeenCalled()
  })

  it('DSS-8 invalidateAgent（芯片上的 X）只销毁 agent：从不顺带重建系统提示词', async () => {
    const session = fakeHost.put(SID, { lock: lockRecord() })
    const rebuild = vi.spyOn(session, 'rebuildSystemPrompt')
    await sessionService.invalidateAgent(SID)
    expect(session.callsOf('destroyAgent')).toHaveLength(1)
    expect(rebuild).not.toHaveBeenCalled()
    expect(session.callsOf('rebuildSystemPrompt')).toEqual([])
    expect(agentSessionSpies.clearAgentScopedState.mock.calls).toEqual([[SID]])

    // 没开着、存储在：peek 打开那一条同样只销毁
    const closed = `${SID}-b`
    fakeHost.storages.add(closed)
    await sessionService.invalidateAgent(closed)
    const peeked = fakeHost.get(closed)!
    expect(peeked.callsOf('destroyAgent')).toHaveLength(1)
    expect(peeked.callsOf('rebuildSystemPrompt')).toEqual([])
  })
})
