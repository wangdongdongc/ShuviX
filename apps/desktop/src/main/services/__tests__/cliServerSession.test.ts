/**
 * cliServer 认会话 —— CLI 报来的会话 id 要有配对的会话 key（cliSession.ts）才算数。（组件的命令 —— 含按会话判
 * 写入目标的 `widget.export` —— 随 `shuvix widget` 一起删掉了，组件的操作经 `widget` 工具，见 tools/widget.ts。）
 *
 * 请求走真的 processRequest（假 socket 收回话；token 直接设进实例，不起 socket）。会话 key 用真的
 * cliSession（本进程随机密钥的 HMAC）。
 *
 *   CS-1  id + 配对的 key → handler 拿到这个会话 id
 *   CS-2  只报 id、key 不对、拿别的会话的 key、key 不是字符串 → handler 拿到 undefined（不算任何会话）
 *   CS-3  只有 key 没有 id → undefined
 *   CS-4  key 按会话不同、同一进程里稳定；verifiedCliSession 对空 id 一律 undefined
 *   CS-7  组件的命令不在了（`widget.*` → unknown command）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../bgTaskService', () => ({ stopBgTaskByAgent: vi.fn() }))
vi.mock('../policyCheck', () => ({ runPolicyCheck: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import { cliServer } from '../cliServer'
import { cliSessionKey, verifiedCliSession } from '../cliSession'

type Handler = (params: Record<string, unknown>, sessionId: string | undefined) => Promise<unknown>
const internals = cliServer as unknown as {
  token: string
  handlers: Map<string, Handler>
  processRequest(line: string, sock: { end(data: string): void }): Promise<void>
}

/** 发一条请求，回 { success, data, error } */
async function send(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  let out = ''
  await internals.processRequest(JSON.stringify({ token: 'tok', ...payload }), {
    end: (data) => (out = data)
  })
  return JSON.parse(out) as Record<string, unknown>
}

const seen: Array<string | undefined> = []

beforeEach(() => {
  internals.token = 'tok'
  seen.length = 0
  internals.handlers.set('test.session', async (_p, sid) => {
    seen.push(sid)
    return sid ?? null
  })
})

describe('cliServer 认会话', () => {
  it('CS-1 id + 配对的 key → handler 拿到会话 id', async () => {
    const r = await send({
      command: 'test.session',
      sessionId: 's1',
      sessionKey: cliSessionKey('s1')
    })
    expect(r).toEqual({ success: true, data: 's1' })
    expect(seen).toEqual(['s1'])
  })

  it.each([
    ['只报 id', { sessionId: 's1' }],
    ['key 不对', { sessionId: 's1', sessionKey: 'deadbeef' }],
    ['拿别的会话的 key', { sessionId: 's1', sessionKey: cliSessionKey('s2') }],
    ['key 不是字符串', { sessionId: 's1', sessionKey: 42 }],
    ['key 长度不同', { sessionId: 's1', sessionKey: cliSessionKey('s1') + '0' }]
  ])('CS-2 %s → 不算任何会话', async (_label, extra) => {
    const r = await send({ command: 'test.session', ...extra })
    expect(r).toEqual({ success: true, data: null })
    expect(seen).toEqual([undefined])
  })

  it('CS-3 只有 key 没有 id → 不算任何会话', async () => {
    await send({ command: 'test.session', sessionKey: cliSessionKey('') })
    expect(seen).toEqual([undefined])
  })

  it('CS-4 key 按会话不同、同一进程里稳定；空 id 一律 undefined', () => {
    expect(cliSessionKey('a')).toBe(cliSessionKey('a'))
    expect(cliSessionKey('a')).not.toBe(cliSessionKey('b'))
    expect(cliSessionKey('a')).toMatch(/^[0-9a-f]{64}$/)
    expect(verifiedCliSession('', cliSessionKey(''))).toBeUndefined()
    expect(verifiedCliSession(undefined, cliSessionKey('a'))).toBeUndefined()
    expect(verifiedCliSession('a', cliSessionKey('a'))).toBe('a')
  })
})

describe('组件的命令', () => {
  it.each(['widget.init', 'widget.build', 'widget.export', 'widget.db-query', 'widget.call'])(
    'CS-7 %s 不在了 → unknown command',
    async (command) => {
      const r = await send({ command, params: { id: 'my-widget' } })
      expect(r.success).toBe(false)
      expect(String(r.error)).toMatch(/unknown/i)
    }
  )
})
