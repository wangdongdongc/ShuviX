import { describe, it, expect, vi } from 'vitest'
import {
  clickOp,
  fillOp,
  typeOp,
  navigateOp,
  waitForOp,
  cdpOp,
  eventsOp,
  readPageOp
} from '../cdpOps'
import type { TabCdpSession } from '../attachManager'

interface FakeSession {
  session: TabCdpSession
  commands: Array<{ method: string; params?: Record<string, unknown> }>
  controllerCalls: string[]
}

/** 假 session：记录 CDP 命令序列 + 可编程 controller */
function fakeSession(overrides: Record<string, unknown> = {}): FakeSession {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  const controllerCalls: string[] = []
  const session = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      commands.push({ method, params })
      if (method === 'Page.getNavigationHistory') {
        return { currentIndex: 1, entries: [{ id: 10 }, { id: 11 }, { id: 12 }] }
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: false } }
      }
      return {}
    }),
    controller: {
      resolveCoordinates: vi.fn(async () => ({ x: 5, y: 6 })),
      focusElement: vi.fn(async () => {
        controllerCalls.push('focus')
      }),
      callOnElement: vi.fn(async (_uid: string, fn: string) => {
        controllerCalls.push(fn.includes("value = ''") ? 'clear' : 'change')
      }),
      getNode: vi.fn(() => ({ role: { value: 'button' }, name: { value: 'Submit' } })),
      reset: vi.fn()
    },
    ...overrides
  }
  return { session: session as unknown as TabCdpSession, commands, controllerCalls }
}

describe('clickOp', () => {
  it('mouseMoved → mousePressed → mouseReleased，回显节点描述', async () => {
    const { session, commands } = fakeSession()
    const out = await clickOp(session, 'e7')
    const mouseEvents = commands
      .filter((c) => c.method === 'Input.dispatchMouseEvent')
      .map((c) => c.params?.type)
    expect(mouseEvents).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    const pressed = commands.find(
      (c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed'
    )
    expect(pressed?.params).toMatchObject({ x: 5, y: 6, button: 'left', clickCount: 1 })
    expect(out.text).toContain('button "Submit"')
  })

  it('点击后 URL 变化 → 提示重新 snapshot', async () => {
    let call = 0
    const urls = ['https://a.com/', 'https://a.com/next']
    const { session } = fakeSession({
      send: vi.fn(async (method: string) => {
        if (method === 'Runtime.evaluate') return { result: { value: urls[call++] } }
        return {}
      })
    })
    const out = await clickOp(session, 'e7')
    expect(out.text).toContain('URL changed to https://a.com/next')
    expect(out.text).toContain('snapshot')
  })
})

describe('fillOp', () => {
  it('配方回归：focus → 清空(input) → insertText → change', async () => {
    const { session, commands, controllerCalls } = fakeSession()
    await fillOp(session, 'e7', 'hello')
    expect(controllerCalls).toEqual(['focus', 'clear', 'change'])
    const insert = commands.find((c) => c.method === 'Input.insertText')
    expect(insert?.params).toEqual({ text: 'hello' })
    // clear 必须发生在 insertText 之前（controller 调用与命令交错，由顺序数组保证）
  })
})

describe('typeOp', () => {
  it('无 uid 不 focus；submitKey 触发按键', async () => {
    const { session, commands, controllerCalls } = fakeSession()
    await typeOp(session, 'query', undefined, 'Enter')
    expect(controllerCalls).not.toContain('focus')
    expect(commands.some((c) => c.method === 'Input.insertText')).toBe(true)
    const keyEvents = commands.filter((c) => c.method === 'Input.dispatchKeyEvent')
    expect(keyEvents.length).toBe(2) // Enter keyDown + keyUp
  })
})

describe('navigateOp', () => {
  it('goto：Page.navigate + reset uid', async () => {
    const { session, commands } = fakeSession()
    const out = await navigateOp(session, 'goto', 'https://a.com')
    expect(commands.some((c) => c.method === 'Page.navigate')).toBe(true)
    expect((session.controller.reset as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    expect(out.details?.url).toBe('https://a.com')
  })

  it('goto 缺 url → 业务错误不抛异常', async () => {
    const { session } = fakeSession()
    const out = await navigateOp(session, 'goto')
    expect(out.details?.error).toBeTruthy()
  })

  it('back：navigateToHistoryEntry(currentIndex-1)', async () => {
    const { session, commands } = fakeSession()
    await navigateOp(session, 'back')
    const nav = commands.find((c) => c.method === 'Page.navigateToHistoryEntry')
    expect(nav?.params).toEqual({ entryId: 10 })
  })

  it('reload：Page.reload + reset uid', async () => {
    const { session, commands } = fakeSession()
    await navigateOp(session, 'reload')
    expect(commands.some((c) => c.method === 'Page.reload')).toBe(true)
    expect((session.controller.reset as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })
})

describe('waitForOp', () => {
  it('超时返回业务错误（不抛异常）', async () => {
    const { session } = fakeSession()
    const out = await waitForOp(session, 'missing', 600)
    expect(out.text).toContain('Timeout')
    expect(out.details?.error).toBe('timeout')
  })

  it('特殊字符经 JSON.stringify 完整转义（引号/换行不破坏表达式）', async () => {
    const { session, commands } = fakeSession()
    await waitForOp(session, `it's "quoted"\nline2`, 600)
    const evals = commands.filter((c) => c.method === 'Runtime.evaluate')
    const expr = String(evals[0]?.params?.expression)
    expect(expr).toContain(JSON.stringify(`it's "quoted"\nline2`))
    // 表达式必须是合法 JS：不能包含裸换行
    expect(expr).not.toContain('\n')
  })

  it('signal aborted → 提前返回 aborted 业务错误', async () => {
    const { session } = fakeSession()
    const controller = new AbortController()
    controller.abort()
    const out = await waitForOp(session, 'x', 600, controller.signal)
    expect(out.details?.error).toBe('aborted')
  })
})

describe('cdpOp', () => {
  it('解析 uid 宏后发送命令', async () => {
    const { session, commands } = fakeSession()
    await cdpOp(session, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: { $uidX: 'e7' },
      y: { $uidY: 'e7' }
    })
    const cmd = commands.find((c) => c.method === 'Input.dispatchMouseEvent')
    expect(cmd?.params).toEqual({ type: 'mouseMoved', x: 5, y: 6 })
  })

  it('getResponseBody base64 自动解码', async () => {
    const { session } = fakeSession({
      send: vi.fn(async () => ({
        body: Buffer.from('{"ok":true}').toString('base64'),
        base64Encoded: true
      }))
    })
    const out = await cdpOp(session, 'Network.getResponseBody', { requestId: 'r1' })
    // 解码成功：body 变为明文 JSON（stringify 后内引号转义），base64Encoded 翻为 false
    expect(out.text).toContain('ok')
    expect(out.text).toContain('"base64Encoded": false')
  })

  it('大结果落盘（spill）返回路径而非内联', async () => {
    const big = { blob: 'x'.repeat(20_000) }
    const { session } = fakeSession({ send: vi.fn(async () => big) })
    const spill = vi.fn(async () => '/tmp/cdp-1.json')
    const out = await cdpOp(session, 'DOMSnapshot.captureSnapshot', {}, spill)
    expect(spill).toHaveBeenCalled()
    expect(out.text).toContain('/tmp/cdp-1.json')
    expect(out.details?.spilled).toBe('/tmp/cdp-1.json')
  })

  it('无 spill 时大结果内联截断并标注', async () => {
    const big = { blob: 'x'.repeat(20_000) }
    const { session } = fakeSession({ send: vi.fn(async () => big) })
    const out = await cdpOp(session, 'DOMSnapshot.captureSnapshot', {})
    expect(out.text).toContain('truncated')
    expect(out.details?.truncated).toBe(true)
  })

  it('命令抛错 → 业务错误（不抛异常）', async () => {
    const { session } = fakeSession({
      send: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    const out = await cdpOp(session, 'CSS.getMatchedStylesForNode', { nodeId: 1 })
    expect(out.details?.error).toBe('boom')
  })
})

describe('eventsOp', () => {
  it('空缓冲返回 nextSeq 提示', async () => {
    const { session } = fakeSession({
      getEvents: () => ({ entries: [], nextSeq: 0 })
    })
    const out = await eventsOp(session, {})
    expect(out.text).toContain('No buffered events')
    expect(out.details?.nextSeq).toBe(0)
  })

  it('有事件时逐条渲染 + 回传 nextSeq', async () => {
    const { session } = fakeSession({
      getEvents: () => ({
        entries: [{ seq: 5, method: 'Network.responseReceived', params: { requestId: 'r1' } }],
        nextSeq: 5
      })
    })
    const out = await eventsOp(session, { event: 'Network.responseReceived' })
    expect(out.text).toContain('#5 Network.responseReceived')
    expect(out.details?.nextSeq).toBe(5)
  })
})

describe('readPageOp', () => {
  it('走 CDP Runtime.evaluate 抽取（而非宿主的 executeJavaScript），returnByValue', async () => {
    const { session } = fakeSession({
      send: vi.fn(async (method: string) => {
        if (method === 'Runtime.evaluate') {
          return {
            result: {
              value: { title: 'Doc', url: 'https://a.com/x', html: '<h1>Hi</h1><p>body</p>' }
            }
          }
        }
        return {}
      })
    })
    const out = await readPageOp(session)
    const evals = (session.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => c[0] === 'Runtime.evaluate'
    )
    expect(evals).toHaveLength(1)
    expect(evals[0][1]).toMatchObject({ returnByValue: true })
    expect(String((evals[0][1] as { expression: string }).expression)).toContain('cloneNode')
    expect(out.text).toContain('Page: Doc')
    expect(out.text).toContain('URL: https://a.com/x')
    expect(out.text).toContain('# Hi')
  })

  it('页面抛异常 → 回错误文本 + details.error，不抛', async () => {
    const { session } = fakeSession({
      send: vi.fn(async () => ({
        result: {},
        exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: boom' } }
      }))
    })
    const out = await readPageOp(session)
    expect(out.text).toContain('TypeError: boom')
    expect(out.details?.error).toBe('TypeError: boom')
  })
})
