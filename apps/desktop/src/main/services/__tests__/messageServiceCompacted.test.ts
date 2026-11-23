/**
 * `messageService.listCompacted` —— 压缩前的历史（只读回看）的桌面读取口（契约见 CLAUDE.md「Context management」）。
 *
 *   M-1 新格式会话：只 peek，交回 `DurableSession.compactedMessages(compactionId)` 的结果；没有那条 → []
 *   M-2 旧格式（harness-v3-jsonl）会话 → []，宿主从不参与（不 peek、不 open）
 *   M-3 没有存储（peek 答 undefined）→ []，从不 open / 创建
 *   M-4 句柄恰好在两步之间被关掉（SessionClosedError）→ 再窥视一次；第二次仍关着 → 原样拒绝；别的错误不重试
 *
 * 宿主是 support/fakeSessionHost 的假宿主；旧格式判断（legacySession）与它的依赖顶成可控的替身。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionClosedError } from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'

const legacy = vi.hoisted(() => ({ ids: new Set<string>() }))

vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../legacySession', () => ({
  isLegacySession: (sessionId: string) => legacy.ids.has(sessionId)
}))
vi.mock('../sessionStorage', () => ({ readLegacyTranscript: () => undefined }))
vi.mock('../sessionMirror', () => ({
  mirroredAgentLocked: () => false,
  writeSessionMirror: vi.fn()
}))
vi.mock('../sessionRecords', () => ({
  sessionRecords: { pick: () => undefined, updateStorageKind: vi.fn() }
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))

import { fakeHost, resetFakeHost, type FakeDurableSession } from './support/fakeSessionHost'
import { messageService } from '../messageService'

const msg = (id: string, content: string): ChatMessage => ({
  id,
  sessionId: 's1',
  role: 'user',
  type: 'text',
  content,
  model: '',
  createdAt: 0,
  metadata: null
})

beforeEach(() => {
  resetFakeHost()
  legacy.ids.clear()
})

describe('messageService.listCompacted', () => {
  it('M-1 peeks and returns compactedMessages(compactionId); an unknown id → []', async () => {
    const segment = [msg('2', 'u1'), msg('3', 'a1')]
    const session = fakeHost.put('s1')
    session.compacted.set('9', segment)
    expect(await messageService.listCompacted('s1', '9')).toStrictEqual(segment)
    expect(session.calls.filter((c) => c[0] === 'compactedMessages')).toEqual([
      ['compactedMessages', '9']
    ])
    expect(await messageService.listCompacted('s1', '42')).toEqual([])
    expect(fakeHost.callsOf('peek')).toEqual(['s1', 's1'])
    expect(fakeHost.callsOf('open')).toEqual([])
  })

  it('M-1 a stored but not-yet-open session is peeked open (not created) and asked', async () => {
    fakeHost.storages.add('s1')
    fakeHost.configure = (session) => session.compacted.set('9', [msg('2', 'u1')])
    expect(await messageService.listCompacted('s1', '9')).toStrictEqual([msg('2', 'u1')])
    expect(fakeHost.callsOf('open')).toEqual([])
  })

  it('M-2 a legacy session → [] and the host is never asked', async () => {
    legacy.ids.add('old')
    fakeHost.put('old').compacted.set('9', [msg('2', 'u1')])
    fakeHost.calls.length = 0
    expect(await messageService.listCompacted('old', '9')).toEqual([])
    expect(fakeHost.calls).toEqual([])
    expect(fakeHost.get('old')!.calls.some((c) => c[0] === 'compactedMessages')).toBe(false)
  })

  it('M-3 no storage → [] without opening or creating anything', async () => {
    expect(await messageService.listCompacted('nope', '9')).toEqual([])
    expect(fakeHost.callsOf('peek')).toEqual(['nope'])
    expect(fakeHost.callsOf('open')).toEqual([])
    expect(fakeHost.storages.has('nope')).toBe(false)
  })

  it('M-3 a sealed host → []', async () => {
    fakeHost.put('s1').compacted.set('9', [msg('2', 'u1')])
    fakeHost.sealed = true
    expect(await messageService.listCompacted('s1', '9')).toEqual([])
  })

  it('M-4 closed between peek and read → peeks again once and returns the reopened answer', async () => {
    const first = fakeHost.put('s1')
    first.compactedMessages = async () => {
      fakeHost.sessions.delete('s1')
      throw new SessionClosedError('s1')
    }
    fakeHost.configure = (session: FakeDurableSession) =>
      session.compacted.set('9', [msg('2', 'again')])
    expect(await messageService.listCompacted('s1', '9')).toStrictEqual([msg('2', 'again')])
    expect(fakeHost.callsOf('peek')).toEqual(['s1', 's1'])
  })

  it('M-4 still closed on the second try → rejects with SessionClosedError; other errors are not retried', async () => {
    const closed = new SessionClosedError('s1')
    fakeHost.configure = (session) => {
      session.compactedMessages = async () => {
        throw closed
      }
    }
    fakeHost.storages.add('s1')
    fakeHost.put('s1')
    await expect(messageService.listCompacted('s1', '9')).rejects.toBe(closed)
    expect(fakeHost.callsOf('peek')).toEqual(['s1', 's1'])

    resetFakeHost()
    const boom = new Error('boom')
    fakeHost.put('s1').compactedMessages = async () => {
      throw boom
    }
    await expect(messageService.listCompacted('s1', '9')).rejects.toBe(boom)
    expect(fakeHost.callsOf('peek')).toEqual(['s1'])
  })
})
