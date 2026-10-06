/**
 * 智能体监控 · 详情（P3-06-33，`agentMonitor:detail` → `getAgentRuntimeDetail`）：agentId 是打开着、锁着的会话 id
 * → 根的快照（真门面读锁所在对话的 `agentInfo`）；路由认得的 agentId → 路由的快照。不认识的、打开着但没锁的
 * （从不 createAgent）、关着的（从不打开 / peek）→ null。
 *
 * P3-13-18（PIN-06）：派生 agent 先按打开着的会话的 agent 目录（`spawnedRecords()`）找 —— 路由的索引里没有它
 * （重开过的会话、新的路由）也能读到它的 `agentInfo`，且从不装扩展；找不到再问路由。
 *
 * sessionService 与路由是替身；门面是真的 `AgentSession`，底下是假会话（support/fakeSessionHost）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'

const state = vi.hoisted(() => ({
  open: new Map<string, unknown>(),
  router: {
    has: vi.fn<(agentId: string) => boolean>(),
    getRuntimeInfo: vi.fn<(agentId: string) => Promise<unknown>>()
  },
  service: {
    getAgentSession: vi.fn<(sessionId: string) => unknown>(),
    ensureAgentSession: vi.fn(),
    peekAgentSession: vi.fn()
  }
}))

vi.mock('../sessionService', () => ({ sessionService: state.service }))
vi.mock('../../agents/AgentManager', () => ({ agentManager: state.router }))
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../hookService', () => ({
  hookTriggers: { fire: vi.fn() },
  hookService: { abortSessionRuns: vi.fn() }
}))
vi.mock('../sessionDayPromptService', () => ({ recordPromptAdmitted: vi.fn() }))
vi.mock('../sessionRecords', () => ({ sessionRecords: { pick: () => undefined } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: { pick: () => undefined } }))
vi.mock('../agentService', () => ({ agentService: { getProfile: () => undefined } }))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: async () => null,
  isDefaultTitle: () => false
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({ clearSession: vi.fn() }))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { AgentSession } from '../agentSession'
import { getAgentRuntimeDetail } from '../agentMonitorService'
import type { SpawnedAgentRecord } from '@shuvix/agent-runtime'
import { FakeDurableSession, lockRecord, resetFakeHost } from './support/fakeSessionHost'

function info(systemPrompt: string): AgentRuntimeInfo {
  return {
    systemPrompt,
    model: {
      provider: 'faux',
      id: 'faux-1',
      name: 'faux-1',
      api: 'faux',
      contextWindow: 1,
      maxTokens: 1,
      reasoning: false,
      input: []
    },
    thinkingLevel: 'off',
    tools: [],
    messageCount: 0,
    isStreaming: false
  }
}

/** 一条打开着的会话（真门面 + 假会话） */
function openSession(
  sessionId: string,
  patch: Partial<FakeDurableSession> = {}
): FakeDurableSession {
  const durable = Object.assign(new FakeDurableSession(sessionId), patch)
  state.open.set(sessionId, AgentSession.of(durable))
  return durable
}

beforeEach(() => {
  state.open.clear()
  state.service.getAgentSession.mockReset().mockImplementation((id) => state.open.get(id))
  state.service.ensureAgentSession.mockReset()
  state.service.peekAgentSession.mockReset()
  state.router.has.mockReset().mockReturnValue(false)
  state.router.getRuntimeInfo.mockReset().mockResolvedValue(null)
})

describe('P3-06-33 getAgentRuntimeDetail', () => {
  it('P3-06-33 an open, locked session id → the root info (the lock conversation)', async () => {
    const durable = openSession('s1', { lock: lockRecord({ conversationId: 2 as never }) })
    durable.infos.set(2, info('root of s1'))
    expect(await getAgentRuntimeDetail('s1')).toEqual(info('root of s1'))
    expect(durable.callsOf('agentInfo')).toEqual([['agentInfo', 2]])
    expect(state.router.getRuntimeInfo).not.toHaveBeenCalled()
  })

  it('P3-06-33 a spawned agentId (router.has) → the router info', async () => {
    state.router.has.mockImplementation((id) => id === 'sub-a1')
    state.router.getRuntimeInfo.mockResolvedValue(info('spawned'))
    expect(await getAgentRuntimeDetail('sub-a1')).toEqual(info('spawned'))
    expect(state.router.getRuntimeInfo).toHaveBeenCalledWith('sub-a1')
  })

  it('P3-06-33 unknown / open but unlocked (no createAgent) / closed (never opened) → null', async () => {
    expect(await getAgentRuntimeDetail('nobody')).toBeNull()
    expect(state.router.getRuntimeInfo).not.toHaveBeenCalled()

    const unlocked = openSession('s2')
    expect(await getAgentRuntimeDetail('s2')).toBeNull()
    expect(unlocked.callsOf('createAgent')).toEqual([])
    expect(unlocked.callsOf('agentInfo')).toEqual([])

    expect(await getAgentRuntimeDetail('s3')).toBeNull()
    expect(state.service.ensureAgentSession).not.toHaveBeenCalled()
    expect(state.service.peekAgentSession).not.toHaveBeenCalled()
  })
})

describe('P3-13-18 getAgentRuntimeDetail resolves spawned agents without the router (PIN-06)', () => {
  function spawnedRecord(patch: Partial<SpawnedAgentRecord>): SpawnedAgentRecord {
    return {
      ...lockRecord({ conversationId: 3 as never, kind: 'spawned' }),
      kind: 'spawned',
      agentId: 'sub-a',
      depth: 1,
      canSpawn: false,
      dispatch: 'tool',
      parentConversationId: 1 as never,
      ownerTaskId: 7 as never,
      displayName: 'Explorer',
      description: '',
      ...patch
    } as SpawnedAgentRecord
  }

  it("P3-13-18 an idle spawned child the router does not know → the open session's agentInfo of its conversation; no ensureInstalled", async () => {
    const host = resetFakeHost()
    const durable = host.put('s1', {
      lock: lockRecord(),
      spawned: [spawnedRecord({ agentId: 'sub-a', conversationId: 3 as never })]
    })
    durable.infos.set(3, info('child'))
    expect(await getAgentRuntimeDetail('sub-a')).toEqual(info('child'))
    expect(durable.callsOf('agentInfo')).toEqual([['agentInfo', 3]])
    expect(durable.callsOf('agents.ensureInstalled')).toEqual([])
    expect(state.router.has).not.toHaveBeenCalled()
    expect(host.callsOf('peek')).toEqual([])
    expect(host.callsOf('open')).toEqual([])
  })

  it('P3-13-18 not in any open directory → falls back to the router; a closed session is never opened', async () => {
    const host = resetFakeHost()
    host.put('s1', { lock: lockRecord(), spawned: [spawnedRecord({ agentId: 'sub-other' })] })
    host.storages.add('s9')
    state.router.has.mockImplementation((id) => id === 'sub-z')
    state.router.getRuntimeInfo.mockResolvedValue(info('router'))
    expect(await getAgentRuntimeDetail('sub-z')).toEqual(info('router'))
    expect(await getAgentRuntimeDetail('sub-unknown')).toBeNull()
    expect(host.callsOf('peek')).toEqual([])
    expect(host.callsOf('open')).toEqual([])
  })
})
