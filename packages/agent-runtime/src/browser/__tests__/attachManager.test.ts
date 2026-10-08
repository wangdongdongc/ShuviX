import { describe, it, expect, vi } from 'vitest'
import {
  CdpAttachManager,
  PAGE_CRASHED_MESSAGE,
  type CdpTabTransport,
  type SessionEndReason
} from '../attachManager'
import { PAGE_CRASHED_MESSAGE as PACKAGE_PAGE_CRASHED_MESSAGE } from '../../index'

type EventListener = (method: string, params: Record<string, unknown>) => void

/** 一条被扣住的命令：用例决定它什么时候回、回什么 */
interface Held {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

interface FakeTransport {
  transport: CdpTabTransport
  commands: Array<{ method: string; params?: Record<string, unknown> }>
  emit: (method: string, params: Record<string, unknown>) => void
  hasListener: () => boolean
  /**
   * 测试侧的「页面崩着」：开着时发给页面的命令（不在 PAGE_SAFE 里）永远不回 —— 与真的崩溃页一样挂住。
   * 产品的崩溃闸要是漏了，用例就会因为「没有在一拍之内落定」变红，而不是挂到超时
   */
  crashed: boolean
  /** 按方法名的回包（缺省 `{}`） */
  replies: Record<string, unknown>
  /** 命令记下之后、回包之前调用（推事件；抛错即命令失败） */
  react: ((method: string, params?: Record<string, unknown>) => void) | null
  /** 扣住下一条该方法的命令，交出放行 / 失败的把手 */
  hold: (method: string) => Held
}

/** 真的崩溃页上照样能回的命令（浏览器进程自己处理的导航 + Inspector 域）—— 与产品那张表逐项相同 */
const PAGE_SAFE = new Set([
  'Page.reload',
  'Page.navigate',
  'Page.navigateToHistoryEntry',
  'Page.getNavigationHistory',
  'Inspector.enable',
  'Inspector.disable'
])

/** 假 transport：记录命令、可注入 CDP 事件；可扣住命令、可装作页面崩着 */
function fakeTransport(): FakeTransport {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  let listener: EventListener | null = null
  const holds = new Map<string, Array<{ held: Held; promise: Promise<unknown> }>>()
  const ft = {
    commands,
    crashed: false,
    replies: {} as Record<string, unknown>,
    react: null as FakeTransport['react'],
    emit: (method: string, params: Record<string, unknown>) => listener?.(method, params),
    hasListener: () => listener != null,
    hold: (method: string): Held => {
      let held!: Held
      const promise = new Promise<unknown>((resolve, reject) => {
        held = { resolve, reject }
      })
      holds.set(method, [...(holds.get(method) ?? []), { held, promise }])
      return held
    }
  } as Omit<FakeTransport, 'transport'>
  const transport: CdpTabTransport = {
    sendCommand: vi.fn((method: string, params?: Record<string, unknown>) => {
      commands.push({ method, params })
      try {
        ft.react?.(method, params)
      } catch (err) {
        return Promise.reject(err)
      }
      const queue = holds.get(method)
      const next = queue?.shift()
      if (next) return next.promise as Promise<never>
      if (ft.crashed && !PAGE_SAFE.has(method)) return new Promise<never>(() => {})
      return Promise.resolve((method in ft.replies ? ft.replies[method] : {}) as never)
    }),
    onEvent: (fn) => {
      listener = fn
      return () => {
        listener = null
      }
    },
    detach: vi.fn(async () => {})
  }
  return Object.assign(ft, { transport }) as FakeTransport
}

/** 让出事件循环一拍（排上的微任务都跑完） */
const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

/** 一个 promise 的落定情况（不 await 它：随时读） */
function track<T>(p: Promise<T>): {
  settled: () => boolean
  error: () => unknown
  value: () => T | undefined
} {
  let settled = false
  let error: unknown
  let value: T | undefined
  p.then(
    (v) => {
      settled = true
      value = v
    },
    (e) => {
      settled = true
      error = e
    }
  )
  return { settled: () => settled, error: () => error, value: () => value }
}

/** 用例期间进程级的未处理 rejection */
function watchUnhandledRejections(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = []
  const onRejection = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on('unhandledRejection', onRejection)
  return { seen, stop: () => void process.off('unhandledRejection', onRejection) }
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

describe('会话结束的原因（ended）：等页面的循环靠它收手', () => {
  /** 每次 attach 一个新的假 transport */
  const newManager = (): CdpAttachManager =>
    new CdpAttachManager({ attach: async () => fakeTransport().transport })

  it.each<[string, (m: CdpAttachManager) => unknown, SessionEndReason, SessionEndReason | null]>([
    ['外部断开：tab 没了', (m) => m.handleExternalDetach('t1', 'tab-closed'), 'tab-closed', null],
    ['外部断开：调试连接没了', (m) => m.handleExternalDetach('t1', 'detached'), 'detached', null],
    ['外部断开：没给原因', (m) => m.handleExternalDetach('t1'), 'detached', null],
    ['主动 detach', (m) => m.detach('t1'), 'detached', null],
    ['detachAll', (m) => m.detachAll(), 'detached', 'detached']
  ])(
    'AM-1 %s → 手里那个会话记下原因、不再算接管；别的 tab 不动；重新 attach 拿到一个干净的新会话',
    async (_label, end, expected, t2Ended) => {
      const manager = newManager()
      const s = await manager.session('t1')
      const t2 = await manager.session('t2')
      expect(s.ended).toBeNull()

      await end(manager)
      expect(s.ended).toBe(expected)
      expect(manager.isAttached('t1')).toBe(false)
      expect(t2.ended).toBe(t2Ended)

      const s2 = await manager.session('t1')
      expect(s2).not.toBe(s)
      expect(s2.ended).toBeNull()
      // 旧会话的原因不会被新会话改写
      expect(s.ended).toBe(expected)
    }
  )

  it('AM-2 先到的原因为准：外部断开之后再 disposeLocal / dispose 不改写；重新 attach 的会话各记各的', async () => {
    const manager = newManager()
    const s = await manager.session('t1')
    manager.handleExternalDetach('t1', 'tab-closed')
    s.disposeLocal('detached')
    await s.dispose()
    expect(s.ended).toBe('tab-closed')

    const s2 = await manager.session('t1')
    manager.handleExternalDetach('t1', 'detached')
    expect(s2.ended).toBe('detached')
    expect(s.ended).toBe('tab-closed')

    const s3 = await manager.session('t1')
    s3.disposeLocal('detached')
    s3.disposeLocal('tab-closed')
    expect(s3.ended).toBe('detached')
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

  it('A1 eventCursor 是最新一条事件的 seq；拿它当 sinceSeq 只看得到之后的事件', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    expect(session.eventCursor()).toBe(0)

    ft.emit('Page.lifecycleEvent', { frameId: 'F', name: 'init' })
    ft.emit('Page.lifecycleEvent', { frameId: 'F', name: 'load' })
    expect(session.eventCursor()).toBe(2)

    ft.emit('Page.frameStartedLoading', { frameId: 'F' })
    expect(session.getEvents({ sinceSeq: 2 }).entries.map((e) => [e.seq, e.method])).toEqual([
      [3, 'Page.frameStartedLoading']
    ])
    expect(session.getEvents({ sinceSeq: 3 }).entries).toEqual([])
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

// ═══════════════════════════════════════════════════════════════════════
// 页面的渲染进程崩了（CR-U1…U4）：发给页面的命令当场失败，不挂到有人重新加载
// ═══════════════════════════════════════════════════════════════════════

/** agent 看到的那句话 —— 全文钉在这一处，别处一律 import PAGE_CRASHED_MESSAGE */
const S =
  'The page in this tab crashed — bring it back with navigate (nav "reload"), or close the tab with close_tab.'

describe('页面崩溃时的命令闸（CR-U1）', () => {
  it('CR-U1 那句话的全文；包的入口导出的是同一句', () => {
    expect(PAGE_CRASHED_MESSAGE).toBe(S)
    expect(PACKAGE_PAGE_CRASHED_MESSAGE).toBe(S)
  })

  /** 接上 t1、页面崩掉（测试侧的 transport 也装作崩着：漏网的命令会一直挂着） */
  async function crashedSession(): Promise<{
    ft: FakeTransport
    session: Awaited<ReturnType<CdpAttachManager['session']>>
  }> {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    expect(ft.commands.map((c) => c.method)).toEqual(['Inspector.enable'])
    ft.crashed = true
    ft.emit('Inspector.targetCrashed', {})
    expect(session.crashed).toBe(true)
    return { ft, session }
  }

  type Session = Awaited<ReturnType<CdpAttachManager['session']>>

  it.each<[string, (s: Session) => Promise<unknown>, string | null]>([
    [
      'Runtime.evaluate',
      (s) => s.send('Runtime.evaluate', { expression: '1' }),
      'Runtime.evaluate'
    ],
    [
      'DOM.describeNode',
      (s) => s.send('DOM.describeNode', { backendNodeId: 1 }),
      'DOM.describeNode'
    ],
    [
      'Accessibility.getFullAXTree',
      (s) => s.send('Accessibility.getFullAXTree'),
      'Accessibility.getFullAXTree'
    ],
    ['Page.enable', (s) => s.send('Page.enable'), 'Page.enable'],
    ['Page.getFrameTree', (s) => s.send('Page.getFrameTree'), 'Page.getFrameTree'],
    [
      'Page.setInterceptFileChooserDialog',
      (s) => s.send('Page.setInterceptFileChooserDialog', { enabled: true }),
      'Page.setInterceptFileChooserDialog'
    ],
    [
      'Input.dispatchMouseEvent',
      (s) => s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }),
      'Input.dispatchMouseEvent'
    ],
    [
      'controller.buildSnapshot',
      (s) => s.controller.buildSnapshot('u'),
      'Accessibility.getFullAXTree'
    ]
  ])(
    'CR-U1 崩着时发给页面的 %s → 一拍之内以那句话失败，命令根本没发出去',
    async (_label, call, method) => {
      const { ft, session } = await crashedSession()
      const work = track(call(session))
      await flush()
      expect(work.settled(), 'should settle within one flush').toBe(true)
      expect((work.error() as Error | undefined)?.message).toBe(S)
      expect(ft.commands.map((c) => c.method)).not.toContain(method)
      expect(ft.commands.map((c) => c.method)).toEqual(['Inspector.enable'])
    }
  )

  it.each([
    ['Page.reload', { ignoreCache: false }],
    ['Page.navigate', { url: 'https://a.test/' }],
    ['Page.navigateToHistoryEntry', { entryId: 3 }],
    ['Page.getNavigationHistory', undefined],
    ['Inspector.enable', undefined],
    ['Inspector.disable', undefined]
  ])('CR-U1 崩着时 %s 照常发出（参数原样），回 transport 的回包', async (method, params) => {
    const { ft, session } = await crashedSession()
    ft.replies[method] = { reply: method }
    const work = track(session.send(method, params))
    await flush()
    expect(work.settled(), 'should settle within one flush').toBe(true)
    expect(work.error()).toBeUndefined()
    expect(work.value()).toEqual({ reply: method })
    expect(ft.commands.at(-1)).toEqual({ method, params })
  })
})

describe('崩溃那一刻还在路上的命令（CR-U2）', () => {
  it('CR-U2 在途的 evaluate 当场以那句话失败、reload 照等它自己的回包；transport 之后再以 Target crashed 拒绝 evaluate 也只看到那句话，没有未处理的 rejection', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    const heldEval = ft.hold('Runtime.evaluate')
    const heldReload = ft.hold('Page.reload')
    const evaluate = track(session.send('Runtime.evaluate', { expression: '1' }))
    const reload = track(session.send('Page.reload'))
    await flush()
    expect(evaluate.settled()).toBe(false)
    expect(reload.settled()).toBe(false)

    const watch = watchUnhandledRejections()
    try {
      ft.emit('Inspector.targetCrashed', {})
      await flush()
      expect(evaluate.settled()).toBe(true)
      expect((evaluate.error() as Error).message).toBe(S)
      expect(reload.settled()).toBe(false)

      heldReload.resolve({})
      await flush()
      expect(reload.settled()).toBe(true)
      expect(reload.error()).toBeUndefined()
      expect(reload.value()).toEqual({})

      // 页面被救回来时，挂住的那条才以 Target crashed 失败 —— 调用方早已拿到那句话，不再变
      heldEval.reject(new Error('Target crashed'))
      await flush()
      await flush()
      expect((evaluate.error() as Error).message).toBe(S)
      expect(watch.seen).toEqual([])
    } finally {
      watch.stop()
    }
  })
})

describe('崩溃 → 救回 → 又崩（CR-U3）', () => {
  it('CR-U3 崩了：crashed、uid 作废一次；救回来（targetReloadedAfterCrash）：命令照常发出；又崩：又拒；两次崩溃都按顺序进了事件缓冲，救回那条也在', async () => {
    const ft = fakeTransport()
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    const reset = vi.spyOn(session.controller, 'reset')
    const cursor = session.eventCursor()

    ft.emit('Inspector.targetCrashed', {})
    expect(session.crashed).toBe(true)
    expect(reset).toHaveBeenCalledTimes(1)
    await expect(session.send('Runtime.evaluate', { expression: '1' })).rejects.toThrow(S)

    ft.emit('Inspector.targetReloadedAfterCrash', {})
    expect(session.crashed).toBe(false)
    await session.send('Runtime.evaluate', { expression: '2' })
    expect(ft.commands.at(-1)).toEqual({
      method: 'Runtime.evaluate',
      params: { expression: '2' }
    })

    ft.emit('Inspector.targetCrashed', {})
    expect(session.crashed).toBe(true)
    await expect(session.send('Runtime.evaluate', { expression: '3' })).rejects.toThrow(S)
    expect(ft.commands.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(1)

    const crashes = session.getEvents({ event: 'Inspector.targetCrashed', sinceSeq: cursor })
    expect(crashes.entries).toHaveLength(2)
    expect(crashes.entries[0].seq).toBeLessThan(crashes.entries[1].seq)
    const reloaded = session.getEvents({
      event: 'Inspector.targetReloadedAfterCrash',
      sinceSeq: cursor
    }).entries
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0].seq).toBeGreaterThan(crashes.entries[0].seq)
    expect(reloaded[0].seq).toBeLessThan(crashes.entries[1].seq)
  })
})

describe('attach 之后先问一句页面是不是已经崩了（CR-U4）', () => {
  it('CR-U4 (a) Inspector.enable 的回包之前就补发 targetCrashed：session() 拿到时已是 crashed，第一条 evaluate 以那句话失败、没发出去', async () => {
    const ft = fakeTransport()
    ft.crashed = true
    ft.react = (method) => {
      if (method === 'Inspector.enable') ft.emit('Inspector.targetCrashed', {})
    }
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    expect(ft.commands[0]).toEqual({ method: 'Inspector.enable', params: undefined })
    expect(session.crashed).toBe(true)

    const work = track(session.send('Runtime.evaluate', { expression: '1' }))
    await flush()
    expect((work.error() as Error | undefined)?.message).toBe(S)
    expect(ft.commands.map((c) => c.method)).toEqual(['Inspector.enable'])
  })

  it('CR-U4 (b) 回包先到、targetCrashed 下一拍才到，第一条 evaluate 正在路上：它以那句话失败', async () => {
    const ft = fakeTransport()
    ft.react = (method) => {
      if (method === 'Inspector.enable') {
        setImmediate(() => {
          ft.crashed = true
          ft.emit('Inspector.targetCrashed', {})
        })
      }
    }
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    expect(ft.commands[0].method).toBe('Inspector.enable')
    expect(session.crashed).toBe(false)
    ft.hold('Runtime.evaluate')
    const work = track(session.send('Runtime.evaluate', { expression: '1' }))
    expect(ft.commands.map((c) => c.method)).toEqual(['Inspector.enable', 'Runtime.evaluate'])

    await flush()
    expect(session.crashed).toBe(true)
    expect(work.settled()).toBe(true)
    expect((work.error() as Error).message).toBe(S)
  })

  it('CR-U4 (c) Inspector.enable 失败：session() 照样拿到、算接管，不算崩，命令照常', async () => {
    const ft = fakeTransport()
    ft.react = (method) => {
      if (method === 'Inspector.enable') throw new Error("'Inspector.enable' wasn't found")
    }
    const manager = new CdpAttachManager({ attach: async () => ft.transport })
    const session = await manager.session('t1')
    expect(manager.isAttached('t1')).toBe(true)
    expect(session.crashed).toBe(false)
    ft.replies['Runtime.evaluate'] = { result: { value: 2 } }
    await expect(session.send('Runtime.evaluate', { expression: '1 + 1' })).resolves.toEqual({
      result: { value: 2 }
    })
    expect(ft.commands.map((c) => c.method)).toEqual(['Inspector.enable', 'Runtime.evaluate'])
  })
})
