import { describe, it, expect, vi } from 'vitest'
import { CdpAttachManager, type CdpTabTransport } from '../attachManager'

type EventListener = (method: string, params: Record<string, unknown>) => void

interface FakeTransport {
  transport: CdpTabTransport
  commands: Array<{ method: string; params?: Record<string, unknown> }>
  emit: (method: string, params: Record<string, unknown>) => void
  hasListener: () => boolean
}

/** 假 transport：记录命令、可注入 CDP 事件 */
function fakeTransport(): FakeTransport {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  let listener: EventListener | null = null
  const transport: CdpTabTransport = {
    sendCommand: vi.fn(async (method, params) => {
      commands.push({ method, params })
      return {} as never
    }),
    onEvent: (fn) => {
      listener = fn
      return () => {
        listener = null
      }
    },
    detach: vi.fn(async () => {})
  }
  return {
    transport,
    commands,
    emit: (method: string, params: Record<string, unknown>) => listener?.(method, params),
    hasListener: () => listener != null
  }
}

describe('CdpAttachManager', () => {
  it('懒 attach + 缓存：同 tab 只 attach 一次', async () => {
    const ft = fakeTransport()
    const attach = vi.fn(async () => ft.transport)
    const manager = new CdpAttachManager({ attach })

    const s1 = await manager.session('t1')
    const s2 = await manager.session('t1')
    expect(s1).toBe(s2)
    expect(attach).toHaveBeenCalledTimes(1)
    expect(manager.isAttached('t1')).toBe(true)
  })

  it('并发 session() 共享同一次 attach', async () => {
    const ft = fakeTransport()
    const attach = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10))
      return ft.transport
    })
    const manager = new CdpAttachManager({ attach })

    const [s1, s2] = await Promise.all([manager.session('t1'), manager.session('t1')])
    expect(s1).toBe(s2)
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('detach 调 transport.detach 并清缓存', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    await manager.session('t1')
    await manager.detach('t1')
    expect(ft.transport.detach).toHaveBeenCalledTimes(1)
    expect(manager.isAttached('t1')).toBe(false)
    expect(ft.hasListener()).toBe(false)
  })

  it('handleExternalDetach 只清本地状态，不调 transport.detach', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    await manager.session('t1')
    manager.handleExternalDetach('t1')
    expect(ft.transport.detach).not.toHaveBeenCalled()
    expect(manager.isAttached('t1')).toBe(false)
  })

  it('detachAll 释放全部 tab', async () => {
    const ft1 = fakeTransport()
    const ft2 = fakeTransport()
    const transports: Record<string, CdpTabTransport> = { t1: ft1.transport, t2: ft2.transport }
    const manager = new CdpAttachManager({ attach: async (tabId) => transports[tabId] })
    await manager.session('t1')
    await manager.session('t2')
    await manager.detachAll()
    expect(ft1.transport.detach).toHaveBeenCalled()
    expect(ft2.transport.detach).toHaveBeenCalled()
    expect(manager.isAttached('t1')).toBe(false)
    expect(manager.isAttached('t2')).toBe(false)
  })
})

describe('TabCdpSession 网络/控制台缓冲', () => {
  it('network 事件按 requestId 聚合状态与大小', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')

    await session.enableNetworkCapture()
    expect(ft.commands.some((c) => c.method === 'Network.enable')).toBe(true)

    ft.emit('Network.requestWillBeSent', {
      requestId: 'r1',
      request: { url: 'https://a.com/x', method: 'GET' },
      timestamp: 1
    })
    ft.emit('Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200, mimeType: 'text/html' }
    })
    ft.emit('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 1024 })

    const entries = session.getNetworkRequests()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      url: 'https://a.com/x',
      method: 'GET',
      status: 200,
      completed: true,
      failed: false,
      size: 1024
    })
  })

  it('console 事件（consoleAPICalled + exceptionThrown）入缓冲', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    await session.enableConsoleCapture()

    ft.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'hello' }],
      timestamp: 1
    })
    ft.emit('Runtime.exceptionThrown', {
      exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } },
      timestamp: 2
    })

    const entries = session.getConsoleMessages()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ type: 'log', text: 'hello' })
    expect(entries[1]).toMatchObject({ type: 'error', text: 'Error: boom' })
  })

  it('disposeLocal 清空缓冲并退订事件', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    await session.enableConsoleCapture()
    ft.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'x' }],
      timestamp: 1
    })
    manager.handleExternalDetach('t1')
    expect(session.getConsoleMessages()).toHaveLength(0)
    expect(ft.hasListener()).toBe(false)
  })
})

describe('通用事件缓冲（events action 支撑）', () => {
  it('所有事件带递增 seq；按方法/ sinceSeq 增量过滤', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')

    ft.emit('Network.responseReceived', { requestId: 'r1' })
    ft.emit('Runtime.consoleAPICalled', { type: 'log', args: [], timestamp: 1 })
    ft.emit('Network.responseReceived', { requestId: 'r2' })

    const all = session.getEvents({})
    expect(all.entries.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(all.nextSeq).toBe(3)

    // 按方法过滤
    const net = session.getEvents({ event: 'Network.responseReceived' })
    expect(net.entries).toHaveLength(2)

    // sinceSeq 增量：只拿 seq>2 的
    const inc = session.getEvents({ sinceSeq: 2 })
    expect(inc.entries.map((e) => e.seq)).toEqual([3])
  })

  it('超大事件参数被截断并标注原始长度', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    ft.emit('Big.event', { blob: 'x'.repeat(10_000) })
    const e = session.getEvents({}).entries[0]
    expect(e.truncatedFrom).toBeGreaterThan(4000)
    expect(JSON.stringify(e.params).length).toBeLessThan(6000)
  })
})

describe('对话框自动处理', () => {
  it('confirm 弹出 → 自动 dismiss（accept=false）', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    await session.enableDialogHandling()
    ft.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'ok?' })
    // 同步 emit 后 handleJavaScriptDialog 是 fire-and-forget，等一个微任务
    await Promise.resolve()
    const handled = ft.commands.find((c) => c.method === 'Page.handleJavaScriptDialog')
    expect(handled?.params).toMatchObject({ accept: false })
  })

  it('alert / beforeunload → accept', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    await session.enableDialogHandling()
    ft.emit('Page.javascriptDialogOpening', { type: 'alert' })
    await Promise.resolve()
    expect(
      ft.commands.filter((c) => c.method === 'Page.handleJavaScriptDialog').pop()?.params
    ).toMatchObject({ accept: true })
  })

  it('关闭自动处理 → 不自动响应（agent 接管）', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    await session.enableDialogHandling()
    session.setAutoDismissDialogs(false)
    ft.emit('Page.javascriptDialogOpening', { type: 'confirm' })
    await Promise.resolve()
    expect(ft.commands.some((c) => c.method === 'Page.handleJavaScriptDialog')).toBe(false)
  })
})
