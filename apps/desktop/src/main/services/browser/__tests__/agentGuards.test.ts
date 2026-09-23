/**
 * agent 接管的 tab 上「别打扰用户」的两道防护（agentGuards.ts）—— 原生文件选择框与原生打印框。
 *
 *   NG-U1  安装：先挂 debugger 的 message 处理函数、再按序发 Page.enable → Runtime.enable →
 *          Runtime.addBinding{__shuvixPrintRequest} → Page.addScriptToEvaluateOnNewDocument{改写源码}；
 *          没有独立的 Runtime.evaluate（当前文档靠 Runtime.enable 重放的默认执行上下文），每个
 *          isDefault 的 executionContextCreated 在那个 contextId 里 evaluate 一次改写，非默认的不管；
 *          安装时从不打开文件框拦截；Page.enable 失败只记 warn、照常 resolve。
 *   NG-U2  改写源码放进 node:vm 的假 window 里跑：binding 缺席时 print 是空操作（绝不退回原生）；
 *          binding 在改写之后才出现也照样用上；binding 不是函数什么都不做；改写两次，一次 print 一次调用。
 *   NG-U3  拦截的开关（假时钟）：动作开始前打开、结束后恰好 FILE_CHOOSER_GRACE_MS 关；宽限期里的新动作
 *          不重复打开、从它结束起重新计时；关掉之后的动作重新打开；重叠的动作；动作抛错照样安排关；
 *          打开失败动作照跑、记 warn、下一个动作重试。
 *   NG-U4  文件框的去向：动作进行中 → 记进（每个进行中的）动作结果、不弹框（即便用户正看着浏览器窗口）；
 *          宽限期里用户不在看 → 丢弃 + 一行 info；在看 → 替用户弹原生框（单选 / 多选），选中的文件交给
 *          那个 input；取消 / 空选 / tab 已销毁 → 什么都不做；弹框本身失败 → warn，没有未处理的 rejection。
 *   NG-U5  打印请求：用户正看着浏览器窗口且 tab 活着 → wc.print 一次（取消不吭声，其余失败 warn）；
 *          否则丢弃 + 一行 info；别的 binding 名不理。
 *   NG-U6  摘除与重装：off 的就是 on 的那个处理函数；待关的定时器清掉；摘了之后的事件不起作用；
 *          没装防护的 tab 动作照跑、不发拦截命令；tab 已销毁时不碰 off；装两次只留一份；跨越摘除 / 重装
 *          的进行中动作结束时不会把新装的那份关掉；hasAgentGuards 跟着装 / 摘变。
 *
 * electron 换成 ./fakeElectron.ts（只用到 dialog）；browserViewService 只剩 browserWindowInFront 一个
 * 可拨的间谍；logger 的四个方法是间谍。模块级的防护表每条用例都要新的：beforeEach 里 resetModules，
 * 用例里 load() 重新导入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInNewContext, createContext } from 'node:vm'
import { createFakeDebugger, fakeElectron, type FakeDebugger } from './fakeElectron'

vi.mock('electron', async () => (await import('./fakeElectron')).fakeElectron().module)

const state = vi.hoisted(() => ({
  /** browserWindowInFront 的回答：null = 用户没在看浏览器窗口 */
  inFront: null as unknown,
  log: {
    info: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
    debug: vi.fn<(...args: unknown[]) => void>()
  }
}))

// mock 路径按**测试文件**解析：被测模块在 services/browser/，测试在其 __tests__/ 下
vi.mock('../browserViewService', () => ({ browserWindowInFront: () => state.inFront }))
vi.mock('../../../logger', () => ({ createLogger: () => state.log }))

const fx = fakeElectron()

type Guards = typeof import('../agentGuards')

/** 浏览器窗口（替用户弹框时的父窗口）—— 只拿来比身份 */
const BROWSER_WINDOW = { label: 'browser-window' }
const GRACE = 5000
const INTERCEPT = 'Page.setInterceptFileChooserDialog'
const SUPPRESSED_LINE = 'file chooser opened while the browser window is not in front: suppressed'
const DROPPED_LINE = 'window.print() while the browser window is not in front: dropped'

interface FakeWc {
  debugger: FakeDebugger
  print: ReturnType<
    typeof vi.fn<(opts: unknown, cb?: (ok: boolean, reason: string) => void) => void>
  >
  destroyed: boolean
  isDestroyed(): boolean
}

function fakeWc(): FakeWc {
  const wc: FakeWc = {
    debugger: createFakeDebugger(),
    print: vi.fn<(opts: unknown, cb?: (ok: boolean, reason: string) => void) => void>(),
    destroyed: false,
    isDestroyed: () => wc.destroyed
  }
  return wc
}

async function load(): Promise<Guards> {
  return import('../agentGuards')
}

/** 装防护（假 wc 按 Electron 的 WebContents 用） */
async function install(g: Guards, tabId: string, wc: FakeWc): Promise<void> {
  await g.installAgentGuards(tabId, wc as never)
}

/** 某个 wc 收到的命令（方法 + 参数），按顺序 */
function commands(wc: FakeWc): Array<[string, unknown]> {
  return wc.debugger.sendCommand.mock.calls.map(([m, p]) => [m, p])
}

/** 拦截开关命令的 enabled 序列 */
function intercepts(wc: FakeWc): boolean[] {
  return wc.debugger.sendCommand.mock.calls
    .filter(([m]) => m === INTERCEPT)
    .map(([, p]) => (p as { enabled: boolean }).enabled)
}

/** 一个可以从外面结束的动作 */
function deferredOp<T = string>(
  value: T
): { op: () => Promise<T>; finish: () => void; fail: (e: Error) => void; started: boolean } {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const d = {
    started: false,
    op: () => {
      d.started = true
      return new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
    },
    finish: () => resolve(value),
    fail: (e: Error) => reject(e)
  }
  return d
}

/** 让出事件循环一拍（替用户弹框那条链是 async 的） */
const flush = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

/** 以 Electron 的形状派发一次文件框事件 */
function chooser(wc: FakeWc, mode: 'selectSingle' | 'selectMultiple', backendNodeId = 42): void {
  wc.debugger.message('Page.fileChooserOpened', { frameId: 'F', mode, backendNodeId })
}

function printRequest(wc: FakeWc, name = '__shuvixPrintRequest'): void {
  wc.debugger.message('Runtime.bindingCalled', { name, payload: '', executionContextId: 1 })
}

function logged(level: 'info' | 'warn', needle: string): number {
  return state.log[level].mock.calls.filter(([msg]) => String(msg).includes(needle)).length
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

beforeEach(() => {
  vi.resetModules()
  fx.reset()
  state.inFront = null
  for (const fn of Object.values(state.log)) fn.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════════════════
// NG-U1 安装
// ═══════════════════════════════════════════════════════════════════════

describe('installAgentGuards：先挂处理函数，再按序装好打印改写（NG-U1）', () => {
  it('NG-U1 message 处理函数在第一条命令之前挂上；命令恰好是 Page.enable → Runtime.enable → addBinding → addScriptToEvaluateOnNewDocument，没有独立的 Runtime.evaluate，不碰文件框拦截', async () => {
    const g = await load()
    const wc = fakeWc()
    const dbg = wc.debugger
    // 同一条时间线记下「挂处理函数」与「发命令」（挂照常挂上：包一层原实现）
    const timeline: string[] = []
    const origOn = dbg.on.getMockImplementation()!
    dbg.on.mockImplementation((event, fn) => {
      timeline.push(`on:${event}`)
      return origOn(event, fn)
    })
    dbg.sendCommand.mockImplementation(async (method) => {
      timeline.push(method)
      return {}
    })

    await install(g, 't1', wc)

    expect(timeline).toEqual([
      'on:message',
      'Page.enable',
      'Runtime.enable',
      'Runtime.addBinding',
      'Page.addScriptToEvaluateOnNewDocument'
    ])
    expect(commands(wc)).toEqual([
      ['Page.enable', undefined],
      ['Runtime.enable', undefined],
      ['Runtime.addBinding', { name: '__shuvixPrintRequest' }],
      ['Page.addScriptToEvaluateOnNewDocument', { source: g.PRINT_OVERRIDE_SOURCE }]
    ])
    expect(intercepts(wc)).toEqual([])
    expect(dbg.listenerCount('message')).toBe(1)
    expect(g.hasAgentGuards('t1')).toBe(true)
  })

  it('NG-U1 isDefault 的执行上下文一出现就在它里面 evaluate 一次改写；非默认 / 缺 auxData / id 不是数字的不管', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    wc.debugger.sendCommand.mockClear()

    wc.debugger.message('Runtime.executionContextCreated', {
      context: { id: 7, auxData: { isDefault: true, frameId: 'F' } }
    })
    expect(commands(wc)).toEqual([
      ['Runtime.evaluate', { expression: g.PRINT_OVERRIDE_SOURCE, contextId: 7 }]
    ])

    wc.debugger.sendCommand.mockClear()
    wc.debugger.message('Runtime.executionContextCreated', {
      context: { id: 8, auxData: { isDefault: false, type: 'isolated' } }
    })
    wc.debugger.message('Runtime.executionContextCreated', { context: { id: 9 } })
    wc.debugger.message('Runtime.executionContextCreated', {
      context: { id: '10', auxData: { isDefault: true } }
    })
    wc.debugger.message('Runtime.executionContextCreated', {})
    expect(commands(wc)).toEqual([])
  })

  it('NG-U1 在上下文里 evaluate 失败（上下文转眼没了）：吞掉，没有未处理的 rejection', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    const watch = watchUnhandledRejections()
    try {
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error('Cannot find context with id 7'))
      wc.debugger.message('Runtime.executionContextCreated', {
        context: { id: 7, auxData: { isDefault: true } }
      })
      await flush()
      await flush()
      expect(watch.seen).toEqual([])
    } finally {
      watch.stop()
    }
  })

  it('NG-U1 改写源码按 JSON.stringify 嵌入 binding 名；binding 名就是 __shuvixPrintRequest', async () => {
    const g = await load()
    expect(g.PRINT_BINDING).toBe('__shuvixPrintRequest')
    expect(g.PRINT_OVERRIDE_SOURCE).toContain(JSON.stringify(g.PRINT_BINDING))
    expect(g.FILE_CHOOSER_GRACE_MS).toBe(GRACE)
  })

  it('NG-U1 Page.enable 失败：安装照常 resolve、记一行 warn，不抛', async () => {
    const g = await load()
    const wc = fakeWc()
    wc.debugger.sendCommand.mockImplementation(async (method) => {
      if (method === 'Page.enable') throw new Error('Target closed')
      return {}
    })
    await expect(install(g, 't9', wc)).resolves.toBeUndefined()
    expect(logged('warn', 'installing agent guards on tab t9 failed')).toBe(1)
    expect(intercepts(wc)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// NG-U2 改写源码本身
// ═══════════════════════════════════════════════════════════════════════

describe('PRINT_OVERRIDE_SOURCE 在一个假 window 里（NG-U2）', () => {
  /** window === globalThis 的假页面，print 是「原生」间谍 */
  function page(): { ctx: Record<string, unknown>; native: ReturnType<typeof vi.fn> } {
    const native = vi.fn()
    const ctx: Record<string, unknown> = { print: native }
    createContext(ctx)
    runInNewContext('window = globalThis', ctx)
    return { ctx, native }
  }

  const callPrint = (ctx: Record<string, unknown>): unknown =>
    runInNewContext('window.print()', ctx)

  it('NG-U2 binding 缺席：print 是空操作，原生 print 一次都没调', async () => {
    const g = await load()
    const { ctx, native } = page()
    runInNewContext(g.PRINT_OVERRIDE_SOURCE, ctx)
    expect(() => callPrint(ctx)).not.toThrow()
    expect(native).not.toHaveBeenCalled()
    expect(runInNewContext('window.print === globalThis.print', ctx)).toBe(true)
  })

  it('NG-U2 binding 在改写之后才装上：print 照样交给它，参数是空串', async () => {
    const g = await load()
    const { ctx, native } = page()
    runInNewContext(g.PRINT_OVERRIDE_SOURCE, ctx)
    const binding = vi.fn()
    ctx[g.PRINT_BINDING] = binding
    callPrint(ctx)
    expect(binding).toHaveBeenCalledTimes(1)
    expect(binding).toHaveBeenCalledWith('')
    expect(native).not.toHaveBeenCalled()
  })

  it.each([['a string'], [42], [{ call: true }], [null]])(
    'NG-U2 binding 不是函数（%j）：什么都不做、不抛',
    async (value) => {
      const g = await load()
      const { ctx, native } = page()
      ctx[g.PRINT_BINDING] = value
      runInNewContext(g.PRINT_OVERRIDE_SOURCE, ctx)
      expect(() => callPrint(ctx)).not.toThrow()
      expect(native).not.toHaveBeenCalled()
    }
  )

  it('NG-U2 改写跑两次（新文档脚本 + 上下文注入）：一次 print 仍只调一次 binding', async () => {
    const g = await load()
    const { ctx, native } = page()
    const binding = vi.fn()
    ctx[g.PRINT_BINDING] = binding
    runInNewContext(g.PRINT_OVERRIDE_SOURCE, ctx)
    runInNewContext(g.PRINT_OVERRIDE_SOURCE, ctx)
    callPrint(ctx)
    callPrint(ctx)
    expect(binding).toHaveBeenCalledTimes(2)
    expect(native).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// NG-U3 拦截的开与关
// ═══════════════════════════════════════════════════════════════════════

describe('withAgentGuards：动作期间与之后宽限期里拦文件框（NG-U3）', () => {
  it('NG-U3 一个动作：动作开始前已打开拦截；结束后 4999ms 什么都没有，第 5000ms 恰好关一次', async () => {
    vi.useFakeTimers()
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    let seenAtStart: boolean[] = []
    const out = await g.withAgentGuards('t1', async () => {
      seenAtStart = intercepts(wc)
      return 'r'
    })
    expect(out).toEqual({ result: 'r', suppressed: [] })
    expect(seenAtStart).toEqual([true])
    expect(commands(wc).filter(([m]) => m === INTERCEPT)).toEqual([[INTERCEPT, { enabled: true }]])

    await vi.advanceTimersByTimeAsync(GRACE - 1)
    expect(intercepts(wc)).toEqual([true])
    await vi.advanceTimersByTimeAsync(1)
    expect(intercepts(wc)).toEqual([true, false])
    await vi.advanceTimersByTimeAsync(GRACE * 3)
    expect(intercepts(wc)).toEqual([true, false])
  })

  it('NG-U3 宽限期里的第二个动作：不重复打开；关的时间从第二个动作结束起算；关掉之后的动作重新打开', async () => {
    vi.useFakeTimers()
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    await g.withAgentGuards('t1', async () => 1)
    await vi.advanceTimersByTimeAsync(3000)
    await g.withAgentGuards('t1', async () => 2)
    expect(intercepts(wc)).toEqual([true])

    // 第一个动作的 5000ms 到了：第二个动作把它推迟了
    await vi.advanceTimersByTimeAsync(GRACE - 1)
    expect(intercepts(wc)).toEqual([true])
    await vi.advanceTimersByTimeAsync(1)
    expect(intercepts(wc)).toEqual([true, false])

    await g.withAgentGuards('t1', async () => 3)
    expect(intercepts(wc)).toEqual([true, false, true])
    await vi.advanceTimersByTimeAsync(GRACE)
    expect(intercepts(wc)).toEqual([true, false, true, false])
  })

  it('NG-U3 重叠的两个动作：只开一次；先结束的那个到点时另一个还在跑就不关；后结束的那个结束满 5000ms 才关', async () => {
    vi.useFakeTimers()
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    const a = deferredOp('A')
    const b = deferredOp('B')
    // B 在 A 已经打开拦截、还在跑的时候开始（同一 tab 的动作本由 tab 队列串行，这是最坏的重叠）
    const pa = g.withAgentGuards('t1', a.op)
    await vi.advanceTimersByTimeAsync(0)
    const pb = g.withAgentGuards('t1', b.op)
    await vi.advanceTimersByTimeAsync(0)
    expect(a.started && b.started).toBe(true)
    expect(intercepts(wc)).toEqual([true])

    a.finish()
    await expect(pa).resolves.toEqual({ result: 'A', suppressed: [] })
    await vi.advanceTimersByTimeAsync(GRACE * 2)
    expect(intercepts(wc)).toEqual([true])

    b.finish()
    await expect(pb).resolves.toEqual({ result: 'B', suppressed: [] })
    await vi.advanceTimersByTimeAsync(GRACE - 1)
    expect(intercepts(wc)).toEqual([true])
    await vi.advanceTimersByTimeAsync(1)
    expect(intercepts(wc)).toEqual([true, false])
  })

  it('NG-U3 动作抛错：错误原样抛出，关拦截照样安排', async () => {
    vi.useFakeTimers()
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    const boom = new Error('click failed')
    await expect(
      g.withAgentGuards('t1', async () => {
        throw boom
      })
    ).rejects.toBe(boom)
    expect(intercepts(wc)).toEqual([true])
    await vi.advanceTimersByTimeAsync(GRACE)
    expect(intercepts(wc)).toEqual([true, false])
  })

  it('NG-U3 打开拦截失败：动作照跑、记 warn；下一个动作重试打开', async () => {
    vi.useFakeTimers()
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    wc.debugger.sendCommand.mockImplementationOnce(async () => {
      throw new Error('Page domain not enabled')
    })
    const ran = vi.fn(async () => 'ok')
    await expect(g.withAgentGuards('t1', ran)).resolves.toEqual({ result: 'ok', suppressed: [] })
    expect(ran).toHaveBeenCalledTimes(1)
    expect(logged('warn', 'arming the file chooser guard on tab t1 failed')).toBe(1)

    await g.withAgentGuards('t1', async () => 'again')
    expect(intercepts(wc)).toEqual([true, true])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// NG-U4 文件框的去向
// ═══════════════════════════════════════════════════════════════════════

describe('被拦下的文件框去哪（NG-U4）', () => {
  it('NG-U4 动作进行中打开的：记进动作结果，不弹框、不交文件 —— 即便用户正看着浏览器窗口', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    state.inFront = BROWSER_WINDOW
    const out = await g.withAgentGuards('t1', async () => {
      chooser(wc, 'selectSingle')
      chooser(wc, 'selectMultiple')
      return 'clicked'
    })
    expect(out).toEqual({
      result: 'clicked',
      suppressed: [{ mode: 'selectSingle' }, { mode: 'selectMultiple' }]
    })
    await flush()
    expect(fx.dialog.showOpenDialog).not.toHaveBeenCalled()
    expect(commands(wc).map(([m]) => m)).not.toContain('DOM.setFileInputFiles')
    expect(logged('info', SUPPRESSED_LINE)).toBe(0)
  })

  it('NG-U4 两个重叠的动作：进行中打开的文件框两个动作都记下', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    const a = deferredOp('A')
    const b = deferredOp('B')
    const pa = g.withAgentGuards('t1', a.op)
    const pb = g.withAgentGuards('t1', b.op)
    await flush()
    chooser(wc, 'selectSingle')
    a.finish()
    b.finish()
    expect((await pa).suppressed).toEqual([{ mode: 'selectSingle' }])
    expect((await pb).suppressed).toEqual([{ mode: 'selectSingle' }])
  })

  it('NG-U4 未知的 mode 按单选记', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    const out = await g.withAgentGuards('t1', async () => {
      wc.debugger.message('Page.fileChooserOpened', { frameId: 'F', backendNodeId: 1 })
      return 0
    })
    expect(out.suppressed).toEqual([{ mode: 'selectSingle' }])
  })

  it('NG-U4 宽限期里、用户没在看浏览器窗口：丢弃，只留一行 info；不弹框、不交文件、不记进之前的结果', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    const out = await g.withAgentGuards('t1', async () => 'clicked')
    chooser(wc, 'selectSingle')
    await flush()
    expect(out.suppressed).toEqual([])
    expect(logged('info', SUPPRESSED_LINE)).toBe(1)
    expect(fx.dialog.showOpenDialog).not.toHaveBeenCalled()
    expect(commands(wc).map(([m]) => m)).not.toContain('DOM.setFileInputFiles')
  })

  it.each([
    ['selectSingle', ['openFile'], ['/Users/me/a.txt']],
    ['selectMultiple', ['openFile', 'multiSelections'], ['/Users/me/a.txt', '/Users/me/b.png']]
  ] as const)(
    'NG-U4 宽限期里、用户正看着浏览器窗口（多半是用户自己点的，%s）：替用户弹原生框，选中的文件交给那个 input',
    async (mode, properties, files) => {
      const g = await load()
      const wc = fakeWc()
      await install(g, 't1', wc)
      await g.withAgentGuards('t1', async () => 'clicked')
      state.inFront = BROWSER_WINDOW
      fx.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [...files] })
      chooser(wc, mode, 77)
      await flush()
      expect(fx.dialog.showOpenDialog).toHaveBeenCalledTimes(1)
      expect(fx.dialog.showOpenDialog.mock.calls[0][0]).toBe(BROWSER_WINDOW)
      expect(fx.dialog.showOpenDialog.mock.calls[0][1]).toEqual({ properties: [...properties] })
      expect(commands(wc).filter(([m]) => m === 'DOM.setFileInputFiles')).toEqual([
        ['DOM.setFileInputFiles', { files: [...files], backendNodeId: 77 }]
      ])
      expect(logged('info', SUPPRESSED_LINE)).toBe(0)
    }
  )

  it.each([
    ['canceled', { canceled: true, filePaths: ['/x'] }, false],
    ['empty selection', { canceled: false, filePaths: [] }, false],
    ['tab destroyed while the dialog was up', { canceled: false, filePaths: ['/x'] }, true]
  ] as const)('NG-U4 替用户弹的框 %s：什么都不交', async (_label, answer, destroy) => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    await g.withAgentGuards('t1', async () => 'clicked')
    state.inFront = BROWSER_WINDOW
    fx.dialog.showOpenDialog.mockImplementationOnce(async () => {
      if (destroy) wc.destroyed = true
      return { canceled: answer.canceled, filePaths: [...answer.filePaths] }
    })
    chooser(wc, 'selectSingle')
    await flush()
    expect(fx.dialog.showOpenDialog).toHaveBeenCalledTimes(1)
    expect(commands(wc).map(([m]) => m)).not.toContain('DOM.setFileInputFiles')
  })

  it('NG-U4 弹框本身失败：记 warn，没有未处理的 rejection', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    await g.withAgentGuards('t1', async () => 'clicked')
    state.inFront = BROWSER_WINDOW
    fx.dialog.showOpenDialog.mockRejectedValueOnce(new Error('no window'))
    const watch = watchUnhandledRejections()
    try {
      chooser(wc, 'selectSingle')
      await flush()
      await flush()
      expect(logged('warn', 'file chooser for the user failed')).toBe(1)
      expect(watch.seen).toEqual([])
    } finally {
      watch.stop()
    }
  })

  it('NG-U4 交文件那条命令失败：同样只记 warn，没有未处理的 rejection', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    await g.withAgentGuards('t1', async () => 'clicked')
    state.inFront = BROWSER_WINDOW
    fx.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/x'] })
    wc.debugger.sendCommand.mockImplementation(async (method) => {
      if (method === 'DOM.setFileInputFiles') throw new Error('node gone')
      return {}
    })
    const watch = watchUnhandledRejections()
    try {
      chooser(wc, 'selectSingle')
      await flush()
      await flush()
      expect(logged('warn', 'file chooser for the user failed')).toBe(1)
      expect(watch.seen).toEqual([])
    } finally {
      watch.stop()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// NG-U5 打印请求
// ═══════════════════════════════════════════════════════════════════════

describe('页面 window.print() 的去向（NG-U5）', () => {
  it('NG-U5 用户正看着浏览器窗口、tab 活着：wc.print({}, cb) 恰好一次；取消不吭声，成功不吭声，其余失败 warn', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    state.inFront = BROWSER_WINDOW
    printRequest(wc)
    expect(wc.print).toHaveBeenCalledTimes(1)
    const [opts, cb] = wc.print.mock.calls[0]
    expect(opts).toEqual({})
    expect(typeof cb).toBe('function')

    cb!(false, 'cancelled')
    cb!(true, '')
    expect(state.log.warn).not.toHaveBeenCalled()
    cb!(false, 'Printer is offline')
    expect(logged('warn', 'print failed: Printer is offline')).toBe(1)
    expect(logged('info', DROPPED_LINE)).toBe(0)
  })

  it('NG-U5 用户没在看浏览器窗口：不打印，只留一行 info', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    printRequest(wc)
    expect(wc.print).not.toHaveBeenCalled()
    expect(logged('info', DROPPED_LINE)).toBe(1)
  })

  it('NG-U5 在看但 tab 已销毁：不打印，只留一行 info', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    state.inFront = BROWSER_WINDOW
    wc.destroyed = true
    printRequest(wc)
    expect(wc.print).not.toHaveBeenCalled()
    expect(logged('info', DROPPED_LINE)).toBe(1)
  })

  it('NG-U5 别的 binding 名：不理（不打印、不记日志）', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    state.inFront = BROWSER_WINDOW
    printRequest(wc, 'somethingElse')
    printRequest(wc, '__shuvixPrintRequestX')
    expect(wc.print).not.toHaveBeenCalled()
    expect(state.log.info).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// NG-U6 摘除与重装
// ═══════════════════════════════════════════════════════════════════════

describe('摘除与重装（NG-U6）', () => {
  it('NG-U6 摘除：off 的就是 on 的那个处理函数；hasAgentGuards 跟着装 / 摘变', async () => {
    const g = await load()
    const wc = fakeWc()
    expect(g.hasAgentGuards('t1')).toBe(false)
    await install(g, 't1', wc)
    expect(g.hasAgentGuards('t1')).toBe(true)
    const [[event, handler]] = wc.debugger.on.mock.calls
    expect(event).toBe('message')

    g.uninstallAgentGuards('t1')
    expect(g.hasAgentGuards('t1')).toBe(false)
    expect(wc.debugger.off).toHaveBeenCalledTimes(1)
    expect(wc.debugger.off).toHaveBeenCalledWith('message', handler)
    expect(wc.debugger.listenerCount('message')).toBe(0)

    // 再摘一次：什么都不做
    g.uninstallAgentGuards('t1')
    expect(wc.debugger.off).toHaveBeenCalledTimes(1)
  })

  it('NG-U6 宽限期里摘掉：待关的定时器清掉（不再发 enabled:false）；之后的文件框 / 打印事件不起作用', async () => {
    vi.useFakeTimers()
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    await g.withAgentGuards('t1', async () => 'x')
    g.uninstallAgentGuards('t1')
    await vi.advanceTimersByTimeAsync(GRACE * 2)
    expect(intercepts(wc)).toEqual([true])

    state.inFront = BROWSER_WINDOW
    fx.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/x'] })
    chooser(wc, 'selectSingle')
    printRequest(wc)
    wc.debugger.message('Runtime.executionContextCreated', {
      context: { id: 3, auxData: { isDefault: true } }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(fx.dialog.showOpenDialog).not.toHaveBeenCalled()
    expect(wc.print).not.toHaveBeenCalled()
    expect(commands(wc).map(([m]) => m)).not.toContain('Runtime.evaluate')
    expect(state.log.info).not.toHaveBeenCalled()
  })

  it('NG-U6 没装防护的 tab：动作照跑，suppressed 为空，不发任何拦截命令', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 'other', wc)
    wc.debugger.sendCommand.mockClear()
    const op = vi.fn(async () => 'plain')
    await expect(g.withAgentGuards('t-unguarded', op)).resolves.toEqual({
      result: 'plain',
      suppressed: []
    })
    expect(op).toHaveBeenCalledTimes(1)
    expect(commands(wc)).toEqual([])
  })

  it('NG-U6 tab 已销毁时摘：不碰 debugger.off（销毁的 webContents 上调它会抛）', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    wc.destroyed = true
    wc.debugger.off.mockImplementation(() => {
      throw new Error('Object has been destroyed')
    })
    expect(() => g.uninstallAgentGuards('t1')).not.toThrow()
    expect(wc.debugger.off).not.toHaveBeenCalled()
    expect(g.hasAgentGuards('t1')).toBe(false)
  })

  it('NG-U6 同一个 tab 装两次：只留一份（旧处理函数摘掉），事件只处理一次', async () => {
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    await install(g, 't1', wc)
    expect(wc.debugger.listenerCount('message')).toBe(1)
    expect(wc.debugger.off).toHaveBeenCalledTimes(1)
    expect(wc.debugger.off.mock.calls[0][1]).toBe(wc.debugger.on.mock.calls[0][1])
    expect(g.hasAgentGuards('t1')).toBe(true)

    printRequest(wc)
    expect(logged('info', DROPPED_LINE)).toBe(1)
  })

  it('NG-U6 跨越重装的进行中动作：它结束后到点不会把新装的那份关掉，旧 webContents 也不再收到 enabled:false', async () => {
    vi.useFakeTimers()
    const g = await load()
    const wc1 = fakeWc()
    const wc2 = fakeWc()
    await install(g, 't1', wc1)
    const old = deferredOp('old')
    const pOld = g.withAgentGuards('t1', old.op)
    await vi.advanceTimersByTimeAsync(0)
    expect(intercepts(wc1)).toEqual([true])

    // 换了一份（重新 attach）；新的那份上有一个进行中的动作
    await install(g, 't1', wc2)
    const fresh = deferredOp('fresh')
    const pFresh = g.withAgentGuards('t1', fresh.op)
    await vi.advanceTimersByTimeAsync(0)
    expect(intercepts(wc2)).toEqual([true])

    old.finish()
    await pOld
    await vi.advanceTimersByTimeAsync(GRACE * 2)
    expect(intercepts(wc1)).toEqual([true])
    expect(intercepts(wc2)).toEqual([true])

    fresh.finish()
    await pFresh
    await vi.advanceTimersByTimeAsync(GRACE)
    expect(intercepts(wc2)).toEqual([true, false])
    expect(intercepts(wc1)).toEqual([true])
  })

  it('NG-U6 摘掉时仍在跑的动作：结束后不发 enabled:false', async () => {
    vi.useFakeTimers()
    const g = await load()
    const wc = fakeWc()
    await install(g, 't1', wc)
    const d = deferredOp('x')
    const p = g.withAgentGuards('t1', d.op)
    await vi.advanceTimersByTimeAsync(0)
    g.uninstallAgentGuards('t1')
    d.finish()
    await p
    await vi.advanceTimersByTimeAsync(GRACE * 2)
    expect(intercepts(wc)).toEqual([true])
  })
})
