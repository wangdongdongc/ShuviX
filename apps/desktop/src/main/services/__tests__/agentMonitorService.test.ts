/**
 * 智能体监控 · 列表（P3-13-13…17，`agentMonitor:list` → `listAgentRuntimes`）。
 *
 *  13 只列打开着的会话：关着的（LRU 关掉的）、没锁的不列；从不 peek / open；宿主没建过 → []，也不替它建
 *  14 宿主补充：会话标题、根的显示名（档案的 `shuvix-displayName`，空则档案名）；没有 rootSessionExists /
 *     counters；一条会话读失败只跳过它、记一条警告
 *  15 删掉的会话不留孤儿行
 *  16 orderByLineage（纯函数）：按根会话分组、父在子前、兄弟按注意力；父不在的当组顶；有在跑子 agent 的组
 *     排前；血缘成环也每行恰好一次
 *  17 注意力：interrupted 与 idle 同等（不算在跑）
 *
 * 会话宿主是假的（support/fakeSessionHost），每条会话的 `monitorSnapshot()` 交脚本里的行。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMonitorRow } from '@shuvix/agent-runtime'
import type { AgentMonitorEntry } from '@shuvix/chat-protocol/types/agentMonitor'

const state = vi.hoisted(() => ({
  /** undefined = 宿主还没建过 */
  host: undefined as unknown,
  getSessionHost: vi.fn(),
  titles: new Map<string, string>(),
  profiles: new Map<string, { displayName: string }>(),
  providers: new Map<string, string>(),
  warn: vi.fn<(message: string) => void>()
}))

vi.mock('../sessionHost', () => ({
  peekSessionHost: () => state.host,
  getSessionHost: state.getSessionHost
}))
vi.mock('../sessionService', () => ({ sessionService: { getAgentSession: vi.fn() } }))
vi.mock('../../agents/AgentManager', () => ({
  agentManager: { has: vi.fn(() => false), getRuntimeInfo: vi.fn() }
}))
vi.mock('../sessionRecords', () => ({
  sessionRecords: {
    pick: (id: string) => (state.titles.has(id) ? { title: state.titles.get(id) } : undefined)
  }
}))
vi.mock('../agentService', () => ({
  agentService: { getProfile: (name: string) => state.profiles.get(name) }
}))
vi.mock('../../dao/providerDao', () => ({
  providerDao: {
    pick: (id: string) => (state.providers.has(id) ? { name: state.providers.get(id) } : undefined)
  }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: state.warn, error: () => {}, debug: () => {} })
}))

import { SessionClosedError } from '@shuvix/agent-runtime'
import {
  listAgentRuntimes,
  orderByLineage,
  resetAgentMonitorCachesForTests
} from '../agentMonitorService'
import { FakeSessionHost, lockRecord } from './support/fakeSessionHost'

function row(patch: Partial<AgentMonitorRow> = {}): AgentMonitorRow {
  const sessionId = patch.rootSessionId ?? 's1'
  return {
    agentId: sessionId,
    kind: 'root',
    rootSessionId: sessionId,
    depth: 0,
    profileName: 'work',
    conversationId: 1,
    phase: 'idle',
    startedAt: 1,
    lastActivityAt: 1,
    queue: { steer: 0, followUp: 0 },
    model: { provider: 'faux', id: 'faux-1', contextWindow: 1000 },
    thinkingLevel: 'off',
    toolCount: 0,
    contextTokens: 0,
    cache: { input: 0, cacheRead: 0, cacheWrite: 0, reported: false },
    cost: { total: 0 },
    sessionCost: 0,
    ...patch
  }
}

function spawnedRow(agentId: string, patch: Partial<AgentMonitorRow> = {}): AgentMonitorRow {
  return row({
    agentId,
    kind: 'spawned',
    depth: 1,
    parentAgentId: patch.rootSessionId ?? 's1',
    profileName: 'explore',
    displayName: 'Explorer',
    dispatch: 'tool',
    conversationId: 2,
    ...patch
  })
}

function entry(patch: Partial<AgentMonitorEntry> = {}): AgentMonitorEntry {
  const {
    conversationId: _conversationId,
    displayName,
    ...rest
  } = row(patch as Partial<AgentMonitorRow>)
  return { ...rest, displayName: displayName ?? 'x', ...patch } as AgentMonitorEntry
}

let host: FakeSessionHost

beforeEach(() => {
  host = new FakeSessionHost()
  state.host = host
  state.getSessionHost.mockReset()
  state.titles.clear()
  state.profiles.clear()
  state.providers.clear()
  state.warn.mockReset()
  resetAgentMonitorCachesForTests()
})

describe('P3-13 listAgentRuntimes', () => {
  it('P3-13-13 only open sessions: closed (storage only) and unlocked are not listed; no peek / open', async () => {
    host.put('s1', { lock: lockRecord(), monitorRows: [row(), spawnedRow('sub-a')] })
    host.storages.add('s2') // 存储在、锁着，但被 LRU 关掉了
    host.put('s3') // 开着、没锁：monitorSnapshot 答 []
    const list = await listAgentRuntimes()
    expect(list.map((e) => e.agentId)).toEqual(['s1', 'sub-a'])
    expect(list.every((e) => e.rootSessionId === 's1')).toBe(true)
    expect(host.callsOf('peek')).toEqual([])
    expect(host.callsOf('open')).toEqual([])
    expect(host.get('s3')!.callsOf('monitorSnapshot')).toHaveLength(1)
  })

  it('P3-13-13 no session host built yet → [] and none is built', async () => {
    state.host = undefined
    expect(await listAgentRuntimes()).toEqual([])
    expect(state.getSessionHost).not.toHaveBeenCalled()
  })

  it('P3-13-14 host enrichment: the session title; root displayName from the profile (empty → profileName); custom provider ids become names; no removed fields', async () => {
    state.titles.set('s1', 'Session One')
    state.titles.set('s2', 'Session Two')
    state.profiles.set('work', { displayName: 'Work Persona' })
    state.profiles.set('chat', { displayName: '' })
    state.providers.set('uuid-1', 'My Provider')
    host.put('s1', {
      monitorRows: [
        row({ model: { provider: 'uuid-1', id: 'm', contextWindow: 1 } }),
        spawnedRow('sub-a', { displayName: 'Explorer' })
      ]
    })
    host.put('s2', { monitorRows: [row({ rootSessionId: 's2', profileName: 'chat' })] })
    const list = await listAgentRuntimes()
    const s1 = list.find((e) => e.agentId === 's1')!
    expect(s1.rootSessionTitle).toBe('Session One')
    expect(s1.displayName).toBe('Work Persona')
    expect(s1.model).toEqual({ provider: 'My Provider', id: 'm', contextWindow: 1 })
    expect(list.find((e) => e.agentId === 'sub-a')).toMatchObject({
      displayName: 'Explorer',
      rootSessionTitle: 'Session One'
    })
    const s2 = list.find((e) => e.agentId === 's2')!
    expect(s2.displayName).toBe('chat')
    expect(s2.rootSessionTitle).toBe('Session Two')
    expect(s2.model.provider).toBe('faux')
    for (const e of list) {
      expect('counters' in e).toBe(false)
      expect('rootSessionExists' in e).toBe(false)
      expect('conversationId' in e).toBe(false)
    }
  })

  it('P3-13-14 a session that throws is skipped with one warning; a closed one silently; the others are listed', async () => {
    host.put('s1', { monitorError: new Error('disk on fire') })
    host.put('s2', { monitorRows: [row({ rootSessionId: 's2' })] })
    host.put('s3', { monitorError: new SessionClosedError('s3') })
    const list = await listAgentRuntimes()
    expect(list.map((e) => e.agentId)).toEqual(['s2'])
    expect(state.warn).toHaveBeenCalledTimes(1)
    expect(state.warn.mock.calls[0]![0]).toContain('s1')
    expect(state.warn.mock.calls[0]![0]).toContain('disk on fire')
  })

  it('P3-13-15 deleting a session leaves no row of it behind', async () => {
    host.put('s1', { monitorRows: [row(), spawnedRow('sub-a')] })
    host.put('s2', { monitorRows: [row({ rootSessionId: 's2' })] })
    expect((await listAgentRuntimes()).some((e) => e.rootSessionId === 's1')).toBe(true)
    await host.delete('s1')
    const list = await listAgentRuntimes()
    expect(list.some((e) => e.rootSessionId === 's1')).toBe(false)
    expect(list.map((e) => e.agentId)).toEqual(['s2'])
  })
})

describe('P3-13-16 orderByLineage', () => {
  it('P3-13-16 groups by root session, parent before children, siblings by attention', () => {
    const ordered = orderByLineage([
      entry({
        agentId: 'b-old',
        kind: 'spawned',
        parentAgentId: 's1',
        depth: 1,
        lastActivityAt: 5
      }),
      entry({ agentId: 's2', rootSessionId: 's2', lastActivityAt: 50 }),
      entry({
        agentId: 'b-new',
        kind: 'spawned',
        parentAgentId: 's1',
        depth: 1,
        lastActivityAt: 9
      }),
      entry({ agentId: 'c', kind: 'spawned', parentAgentId: 'b-old', depth: 2, lastActivityAt: 1 }),
      entry({ agentId: 's1', lastActivityAt: 10 })
    ])
    expect(ordered.map((e) => e.agentId)).toEqual(['s2', 's1', 'b-new', 'b-old', 'c'])
  })

  it('P3-13-16 a row whose parent is absent tops its group (root destroyed and unlocked)', () => {
    const ordered = orderByLineage([
      entry({ agentId: 'x', kind: 'spawned', parentAgentId: 's1', depth: 1, lastActivityAt: 3 }),
      entry({ agentId: 'y', kind: 'spawned', parentAgentId: 'x', depth: 2, lastActivityAt: 9 }),
      entry({ agentId: 'z', kind: 'spawned', parentAgentId: 's1', depth: 1, lastActivityAt: 7 })
    ])
    expect(ordered.map((e) => e.agentId)).toEqual(['z', 'x', 'y'])
  })

  it('P3-13-16 a group with a busy child sorts before an idle group', () => {
    const ordered = orderByLineage([
      entry({ agentId: 's1', lastActivityAt: 100 }),
      entry({ agentId: 's2', rootSessionId: 's2', lastActivityAt: 1 }),
      entry({
        agentId: 'busy',
        rootSessionId: 's2',
        kind: 'spawned',
        parentAgentId: 's2',
        depth: 1,
        phase: 'turn',
        lastActivityAt: 2
      })
    ])
    expect(ordered.map((e) => e.agentId)).toEqual(['s2', 'busy', 's1'])
  })

  it('P3-13-16 a lineage cycle still outputs every row exactly once', () => {
    const ordered = orderByLineage([
      entry({ agentId: 'p', kind: 'spawned', parentAgentId: 'q', depth: 1, lastActivityAt: 1 }),
      entry({ agentId: 'q', kind: 'spawned', parentAgentId: 'p', depth: 1, lastActivityAt: 2 }),
      entry({ agentId: 's1', lastActivityAt: 3 })
    ])
    expect(ordered.map((e) => e.agentId).sort()).toEqual(['p', 'q', 's1'])
    expect(ordered).toHaveLength(3)
  })
})

describe('P3-13-17 attention', () => {
  it("P3-13-17 'interrupted' sorts like idle, not like running; turn and compaction count as running", () => {
    const ordered = orderByLineage([
      entry({ agentId: 'idle-new', rootSessionId: 'a', phase: 'idle', lastActivityAt: 30 }),
      entry({ agentId: 'int-old', rootSessionId: 'b', phase: 'interrupted', lastActivityAt: 10 }),
      entry({ agentId: 'int-new', rootSessionId: 'c', phase: 'interrupted', lastActivityAt: 40 }),
      entry({ agentId: 'turn-old', rootSessionId: 'd', phase: 'turn', lastActivityAt: 1 }),
      entry({ agentId: 'comp', rootSessionId: 'e', phase: 'compaction', lastActivityAt: 2 })
    ])
    expect(ordered.map((e) => e.agentId)).toEqual([
      'comp',
      'turn-old',
      'int-new',
      'idle-new',
      'int-old'
    ])
  })
})
