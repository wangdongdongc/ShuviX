import { afterEach, describe, it, expect, vi, type Mock } from 'vitest'
import {
  clickOp,
  fillOp,
  typeOp,
  pressKeyOp,
  navigateOp,
  waitForLoad,
  waitForOp,
  cdpOp,
  eventsOp,
  readPageOp
} from '../cdpOps'
import type { TabCdpSession } from '../attachManager'
import type { NavKind } from '../backend'

type Params = Record<string, unknown>
type Point = { x: number; y: number }
type Command = { method: string; params?: Params }
type Match = (c: Command) => boolean

interface Handle {
  uid: string
  backendNodeId: number
  objectId: string
  relocated: boolean
}

interface NodeInfo {
  role?: { value: string }
  name?: { value: string }
}

/** 假 controller：句柄、坐标、命中检查都可编程，调用可断言 */
interface FakeController {
  resolveElement: Mock<(uid: string) => Promise<Handle>>
  pointOf: Mock<(el: Handle) => Promise<Point | null>>
  /** 在句柄上执行页面函数 —— 只有 click 的命中检查走这里 */
  callOn: Mock<(el: Handle, fn: string, args?: unknown[]) => Promise<Params>>
  release: Mock<(el: Handle) => Promise<void>>
  resolveCoordinates: Mock<(uid: string) => Promise<Point>>
  callOnElement: Mock<(uid: string, fn: string, args?: unknown[]) => Promise<unknown>>
  getNode: Mock<(uid: string) => NodeInfo | undefined>
  reset: Mock<() => void>
}

type Reaction = (method: string, params?: Params) => void

interface FakeSession {
  session: TabCdpSession
  ctl: FakeController
  /** 发出的 CDP 命令（按顺序） */
  commands: Command[]
  /** callOnElement 执行过的页面函数（按函数体特征命名，见 pageFnName） */
  controllerCalls: string[]
  /** 与 controllerCalls 一一对应：页面函数收到的参数 */
  controllerArgs: Array<unknown[] | undefined>
  /** CDP 命令与页面函数混排的时间线（页面函数记作 `fn:<名字>`），断言先后用 */
  timeline: string[]
  /** pageState 读到的页面：url / readyState / 是否仍是打过记号的那个文档（打记号时置真） */
  page: { url: string; readyState: string; marked: boolean }
  /** 事件缓冲（getEvents 按 event、sinceSeq（严格大于）、limit（最新 N 条）过滤） */
  events: Array<{ seq: number; method: string; params: Params }>
  /** 往事件缓冲追加一条，seq 递增 */
  push: (method: string, params?: Params) => void
  /** 页面对命令的反应：命令记下之后、回包之前调用（推事件、改页面状态；抛错即命令失败） */
  onCommand: (reaction: Reaction) => void
  /** Page.navigate 的回包 */
  navigateResult: { value: Params }
  /** Page.getNavigationHistory 的回包 */
  history: { currentIndex: number; entries: Array<{ id: number; url?: string }> }
  /** 页面函数的返回序列（按名字）：每调一次取下一个，剩最后一个时一直沿用 */
  results: Record<string, unknown[]>
}

/**
 * 在元素上执行的页面函数 → 用例里的名字（按函数体特征识别）。
 * set-value / select-option 也会发 change 事件，必须在 change 之前认出来。
 */
function pageFnName(fn: string): string {
  if (fn.includes('readOnly:')) return 'inspect'
  if (fn.includes('el.select();')) return 'select-content'
  if (fn.includes('visible: visible()')) return 'read-back'
  if (fn.includes('focused:')) return 'focus'
  if (fn.includes('disabledOption')) return 'select-option'
  if (fn.includes('getOwnPropertyDescriptor')) return 'set-value'
  if (fn.includes('elementFromPoint')) return 'hit-test'
  if (fn.includes("Event('change'")) return 'change'
  return 'other'
}

/** inspect 的返回：默认是一个可编辑、当前值为 "old" 的文本框 */
function field(overrides: Params = {}): Params {
  return {
    kind: 'text',
    type: 'text',
    desc: '<input>',
    disabled: false,
    readOnly: false,
    value: 'old',
    ...overrides
  }
}

/** read-back 的返回：默认可见、焦点没被页面挪走 */
function readBack(value: string, overrides: Params = {}): Params {
  return { value, visible: true, active: null, ...overrides }
}

/** 假 session：记录 CDP 命令序列 + 可编程 controller / 页面状态 / 事件缓冲 / 页面反应 */
function fakeSession(overrides: Params = {}): FakeSession {
  const commands: Command[] = []
  const controllerCalls: string[] = []
  const controllerArgs: FakeSession['controllerArgs'] = []
  const timeline: string[] = []
  const page = { url: 'https://a.com/', readyState: 'complete', marked: true }
  const events: FakeSession['events'] = []
  const navigateResult: FakeSession['navigateResult'] = { value: { frameId: 'F', loaderId: 'L2' } }
  const history: FakeSession['history'] = {
    currentIndex: 1,
    entries: [
      { id: 10, url: 'https://a.com/0' },
      { id: 11, url: 'https://a.com/1' },
      { id: 12, url: 'https://a.com/2' }
    ]
  }
  const results: FakeSession['results'] = {}
  let seq = 0
  let reaction: Reaction | null = null
  let lastInserted = ''

  const push = (method: string, params: Params = {}): void => {
    events.push({ seq: ++seq, method, params })
  }

  const evaluate = (expression: string): Params => {
    // DOM 安静探针（及其清理）里也有 defineProperty(window —— 要先认出来
    if (expression.includes('__shuvixQuiet')) return { result: { value: 1000 } }
    if (expression.includes('defineProperty(window')) {
      page.marked = true
      return { result: { value: page.url } }
    }
    if (expression.includes('readyState')) return { result: { value: { ...page } } }
    return { result: { value: false } }
  }

  const pageFnResult = (name: string): unknown => {
    const queue = results[name]
    if (queue?.length) return queue.length > 1 ? queue.shift() : queue[0]
    if (name === 'inspect') return field()
    if (name === 'read-back') return readBack(lastInserted)
    return {}
  }

  const ctl: FakeController = {
    resolveElement: vi.fn(
      async (uid: string): Promise<Handle> => ({
        uid,
        backendNodeId: 7,
        objectId: 'obj-7',
        relocated: false
      })
    ),
    pointOf: vi.fn(async (_el: Handle): Promise<Point | null> => ({ x: 5, y: 6 })),
    callOn: vi.fn(async (_el: Handle, fn: string, _args?: unknown[]): Promise<Params> => {
      timeline.push(`fn:${pageFnName(fn)}`)
      return { ok: true }
    }),
    release: vi.fn(async (_el: Handle): Promise<void> => {}),
    resolveCoordinates: vi.fn(async (_uid: string): Promise<Point> => ({ x: 5, y: 6 })),
    callOnElement: vi.fn(async (_uid: string, fn: string, args?: unknown[]): Promise<unknown> => {
      const name = pageFnName(fn)
      controllerCalls.push(name)
      controllerArgs.push(args)
      timeline.push(`fn:${name}`)
      return pageFnResult(name)
    }),
    getNode: vi.fn((_uid: string): NodeInfo | undefined => ({
      role: { value: 'button' },
      name: { value: 'Submit' }
    })),
    reset: vi.fn((): void => {})
  }

  const session = {
    send: vi.fn(async (method: string, params?: Params) => {
      commands.push({ method, params })
      timeline.push(method)
      reaction?.(method, params)
      if (method === 'Page.getNavigationHistory') return history
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F' } } }
      if (method === 'Page.navigate') return navigateResult.value
      if (method === 'Input.insertText') lastInserted = String(params?.text)
      if (method === 'Runtime.evaluate') return evaluate(String(params?.expression))
      return {}
    }),
    eventCursor: vi.fn(() => seq),
    getEvents: vi.fn((opts: { event?: string; sinceSeq?: number; limit?: number }) => {
      const since = opts.sinceSeq
      const matched = events.filter(
        (e) => (!opts.event || e.method === opts.event) && (since == null || e.seq > since)
      )
      return { entries: matched.slice(-(opts.limit ?? 100)), nextSeq: seq }
    }),
    controller: ctl,
    ...overrides
  }
  return {
    session: session as unknown as TabCdpSession,
    ctl,
    commands,
    controllerCalls,
    controllerArgs,
    timeline,
    page,
    events,
    push,
    onCommand: (fn) => {
      reaction = fn
    },
    navigateResult,
    history,
    results
  }
}

// ====== 命令匹配、页面反应、计时 ======

const cmd =
  (name: string): Match =>
  (c) =>
    c.method === name
const mouseUp: Match = (c) =>
  c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mouseReleased'
const keyUp: Match = (c) => c.method === 'Input.dispatchKeyEvent' && c.params?.type === 'keyUp'
/** 动作前给文档打记号的 evaluate（DOM 安静探针里也有 defineProperty(window，但总在它之后发） */
const markEvaluate: Match = (c) =>
  c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('defineProperty(window')
const pageStateRead: Match = (c) =>
  c.method === 'Runtime.evaluate' && String(c.params?.expression).includes('readyState')

function sent(fake: FakeSession, match: Match): Command[] {
  return fake.commands.filter(match)
}

/** 这些命令都发了，且按给定顺序（各取第一次出现） */
function expectCommandOrder(fake: FakeSession, ...matches: Match[]): void {
  const positions = matches.map((m) => fake.commands.findIndex(m))
  expect(positions.every((p) => p >= 0)).toBe(true)
  for (let i = 1; i < positions.length; i++) expect(positions[i - 1]).toBeLessThan(positions[i])
}

/** anchor 那条命令之后，又发了几条 match */
function countAfter(fake: FakeSession, anchor: Match, match: Match): number {
  const from = fake.commands.findIndex(anchor)
  expect(from).toBeGreaterThanOrEqual(0)
  return fake.commands.slice(from + 1).filter(match).length
}

/** trigger 那条命令一发出，页面就执行 effect */
function when(fake: FakeSession, trigger: Match, effect: () => void): void {
  fake.onCommand((method, params) => {
    if (trigger({ method, params })) effect()
  })
}

/** 主框架发起导航并换成 url 上的新文档（打过的记号随旧文档一起没了） */
function navigateTo(fake: FakeSession, url: string): void {
  fake.push('Page.frameRequestedNavigation', { frameId: 'F' })
  fake.push('Page.frameStartedLoading', { frameId: 'F' })
  fake.page.url = url
  fake.page.marked = false
}

/** 主框架开始加载又停下，文档没换 */
function startAndStopLoading(fake: FakeSession): void {
  fake.push('Page.frameStartedLoading', { frameId: 'F' })
  fake.push('Page.frameStoppedLoading', { frameId: 'F' })
}

/** 导航结束，落在 Chromium 的错误页上 */
function landOnErrorPage(fake: FakeSession): void {
  startAndStopLoading(fake)
  fake.page.url = 'chrome-error://chromewebdata/'
  fake.page.marked = false
}

afterEach(() => {
  vi.useRealTimers()
})

/** 假计时器下把时间推进 ms：操作必须已经落定（没落定直接判红，不挂到用例超时） */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let settled = false
  work.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await vi.advanceTimersByTimeAsync(ms)
  expect(settled, `the operation should settle within ${ms}ms`).toBe(true)
  return work
}

describe('clickOp', () => {
  it('命中检查通过 → mouseMoved → mousePressed → mouseReleased，回显节点描述', async () => {
    const { session, commands } = fakeSession()
    const out = await clickOp(session, 'e7')
    const mouseEvents = commands
      .filter((c) => c.method === 'Input.dispatchMouseEvent')
      .map((c) => c.params?.type)
    expect(mouseEvents).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    const pressed = commands.find(
      (c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed'
    )
    expect(pressed?.params).toMatchObject({ x: 5, y: 6, button: 'left', buttons: 1, clickCount: 1 })
    expect(out.text).toContain('button "Submit"')
  })

  it('点击后同文档路由（URL 变了、文档没换）→ 提示重新 snapshot，不作废 uid', async () => {
    const fake = fakeSession()
    when(fake, mouseUp, () => {
      fake.push('Page.navigatedWithinDocument', { frameId: 'F', url: 'https://a.com/next' })
      fake.page.url = 'https://a.com/next'
    })
    const out = await clickOp(fake.session, 'e7')
    expect(out.text).toContain('URL changed to https://a.com/next')
    expect(out.text).toContain('snapshot')
    expect(fake.ctl.reset).not.toHaveBeenCalled()
  })

  it.each<[string, boolean]>([
    ['button', false],
    ['option', true]
  ])('O1 目标一直没有盒子（role=%s）→ 复查几轮后报不可见，不发鼠标事件', async (role, hinted) => {
    vi.useFakeTimers()
    const fake = fakeSession()
    fake.ctl.getNode.mockReturnValue({ role: { value: role }, name: { value: 'Submit' } })
    fake.ctl.pointOf.mockResolvedValue(null)
    const out = await within(clickOp(fake.session, 'e7'), 700)
    const error = String(out.details?.error)
    expect(error).toContain('is not visible — it has no size on the page')
    expect(error.includes('use fill on the select with the option label')).toBe(hinted)
    expect(fake.ctl.pointOf).toHaveBeenCalledTimes(5)
    expect(sent(fake, cmd('Input.dispatchMouseEvent'))).toEqual([])
    expect(sent(fake, cmd('Page.getFrameTree'))).toEqual([])
    expect(fake.ctl.release).toHaveBeenCalledTimes(1)
  })

  it('O2 一直被别的元素盖住 → 报盖住它的是谁、让先关掉，不发鼠标事件', async () => {
    vi.useFakeTimers()
    const fake = fakeSession()
    fake.ctl.callOn.mockResolvedValue({ ok: false, hit: '<div#cookie.banner> "Accept"' })
    const out = await within(clickOp(fake.session, 'e7'), 700)
    const error = String(out.details?.error)
    expect(error).toContain('is covered by <div#cookie.banner> "Accept"')
    expect(error).toContain('Dismiss or close it first')
    expect(sent(fake, cmd('Input.dispatchMouseEvent'))).toEqual([])
    expect(fake.ctl.release).toHaveBeenCalledTimes(1)
  })

  it('O3 刚弹出还没有盒子：复查到有了再点，命中检查与鼠标都用复查拿到的坐标', async () => {
    vi.useFakeTimers()
    const fake = fakeSession()
    fake.ctl.pointOf
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ x: 1, y: 2 })
    const out = await within(clickOp(fake.session, 'e7'), 1000)
    expect(out.details?.error).toBeUndefined()
    expect(fake.ctl.pointOf).toHaveBeenCalledTimes(3)
    const [, fn, args] = fake.ctl.callOn.mock.calls[0]
    expect(pageFnName(fn)).toBe('hit-test')
    expect(args).toEqual([1, 2])
    const pressed = sent(fake, cmd('Input.dispatchMouseEvent')).find(
      (c) => c.params?.type === 'mousePressed'
    )
    expect(pressed?.params).toMatchObject({ x: 1, y: 2 })
  })

  it('O3 遮罩正在淡出：前两次命中检查被盖住，第三次通过就点', async () => {
    vi.useFakeTimers()
    const fake = fakeSession()
    fake.ctl.callOn
      .mockResolvedValueOnce({ ok: false, hit: '<div.overlay>' })
      .mockResolvedValueOnce({ ok: false, hit: '<div.overlay>' })
    const out = await within(clickOp(fake.session, 'e7'), 1000)
    expect(out.details?.error).toBeUndefined()
    expect(sent(fake, cmd('Input.dispatchMouseEvent'))).toHaveLength(3)
  })

  it('O4 目标是 <select> → 让改用 fill 选选项，不点', async () => {
    const fake = fakeSession()
    fake.ctl.callOn.mockResolvedValue({ select: true })
    const out = await clickOp(fake.session, 'e7')
    const error = String(out.details?.error)
    expect(error).toContain('is a <select>')
    expect(error).toContain('fill(uid')
    expect(sent(fake, cmd('Input.dispatchMouseEvent'))).toEqual([])
    expect(fake.ctl.pointOf).toHaveBeenCalledTimes(1)
  })

  it('O4 命中检查时节点已脱离文档 → 抛 stale 错，句柄照样释放', async () => {
    const fake = fakeSession()
    fake.ctl.callOn.mockResolvedValue({ gone: true })
    await expect(clickOp(fake.session, 'e7')).rejects.toThrow(/no longer on the page/)
    expect(fake.ctl.release).toHaveBeenCalledTimes(1)
    expect(sent(fake, cmd('Input.dispatchMouseEvent'))).toEqual([])
  })

  it.each<[string, string, string]>([
    [
      '去了新 URL',
      'https://a.com/next',
      'Page navigated to https://a.com/next — take a new snapshot before further interaction.'
    ],
    [
      'URL 没变（重新加载）',
      'https://a.com/',
      'Page reloaded — take a new snapshot before further interaction.'
    ]
  ])('O5 点击触发导航（%s）→ 等新文档加载完再回，作废 uid', async (_label, url, note) => {
    const fake = fakeSession()
    when(fake, mouseUp, () => navigateTo(fake, url))
    const out = await clickOp(fake.session, 'e7')
    expect(out.text).toBe(`Clicked button "Submit" (uid=e7). ${note}`)
    expect(out.details?.error).toBeUndefined()
    expect(fake.ctl.reset).toHaveBeenCalledTimes(1)
    expectCommandOrder(fake, cmd('Page.getFrameTree'), cmd('Input.dispatchMouseEvent'))
  })

  it.each<[string, (fake: FakeSession) => void, string, boolean]>([
    [
      '加载开始又结束、文档没换（下载 / 204 / 被取消）',
      (fake) => when(fake, mouseUp, () => startAndStopLoading(fake)),
      '(no new page was loaded — the request may have been a download or was cancelled)',
      false
    ],
    [
      '同文档路由（pushState 也会发加载事件）',
      (fake) =>
        when(fake, mouseUp, () => {
          fake.push('Page.frameStartedLoading', { frameId: 'F' })
          fake.push('Page.navigatedWithinDocument', { frameId: 'F', url: 'https://a.com/b' })
          fake.push('Page.frameStoppedLoading', { frameId: 'F' })
          fake.page.url = 'https://a.com/b'
        }),
      'Page URL changed to https://a.com/b',
      false
    ],
    [
      '只有 iframe 在加载',
      (fake) =>
        when(fake, mouseUp, () => fake.push('Page.frameStartedLoading', { frameId: 'IFRAME' })),
      'Clicked button "Submit" (uid=e7).',
      true
    ],
    [
      '加载事件发生在点击之前',
      (fake) => startAndStopLoading(fake),
      'Clicked button "Submit" (uid=e7).',
      true
    ]
  ])('O6 %s → 不当成换了页面，uid 不作废', async (_label, arrange, expected, exact) => {
    const fake = fakeSession()
    arrange(fake)
    const out = await clickOp(fake.session, 'e7')
    if (exact) expect(out.text).toBe(expected)
    else expect(out.text).toContain(expected)
    expect(out.details?.error).toBeUndefined()
    expect(fake.ctl.reset).not.toHaveBeenCalled()
  })

  it('O7 目标是按角色与名字重新找回的 → 回显里说明', async () => {
    const fake = fakeSession()
    fake.ctl.resolveElement.mockResolvedValue({
      uid: 'e7',
      backendNodeId: 8,
      objectId: 'obj-8',
      relocated: true
    })
    const out = await clickOp(fake.session, 'e7')
    expect(out.text).toContain(
      '(It had been re-rendered since your snapshot and was found again by role and name.)'
    )
  })

  it('O7 点击开了新 tab（Page.windowOpen）→ 提示用 list_tabs 找', async () => {
    const fake = fakeSession()
    when(fake, mouseUp, () => fake.push('Page.windowOpen', { url: 'https://b.com/' }))
    const out = await clickOp(fake.session, 'e7')
    expect(out.text).toBe(
      'Clicked button "Submit" (uid=e7). It opened a new tab — use list_tabs to find it.'
    )
  })
})

describe('fillOp', () => {
  it('配方回归：检查 → 全选 → insertText → 读回一致 → change', async () => {
    const { session, commands, controllerCalls } = fakeSession()
    const out = await fillOp(session, 'e7', 'hello')
    expect(controllerCalls).toEqual(['inspect', 'select-content', 'read-back', 'change'])
    const insert = commands.find((c) => c.method === 'Input.insertText')
    expect(insert?.params).toEqual({ text: 'hello' })
    expect(out.text).toContain('Filled')
    expect(out.details?.error).toBeUndefined()
  })

  it('F1 fill("") 清空：全选后按 Delete、不 insertText；读回为空即成功，补发 change', async () => {
    const fake = fakeSession()
    fake.results['read-back'] = [readBack('')]
    const out = await fillOp(fake.session, 'e7', '')
    const keys = sent(fake, cmd('Input.dispatchKeyEvent'))
    expect(keys.map((c) => [c.params?.key, c.params?.windowsVirtualKeyCode])).toEqual([
      ['Delete', 46],
      ['Delete', 46]
    ])
    expect(sent(fake, cmd('Input.insertText'))).toEqual([])
    expect(out.text).toBe('Filled button "Submit" (uid=e7) with "".')
    expect(fake.controllerCalls.at(-1)).toBe('change')
  })

  it('F2 contenteditable 编辑器：读回多出的块级换行不算差异，也不补发 change', async () => {
    const fake = fakeSession()
    fake.results.inspect = [field({ kind: 'editor', type: '' })]
    fake.results['read-back'] = [readBack('\nhello\n\n')]
    const out = await fillOp(fake.session, 'e7', 'hello')
    expect(out.text).toContain('Filled')
    expect(fake.controllerCalls).toEqual(['inspect', 'select-content', 'read-back'])
    expect(sent(fake, cmd('Input.insertText'))).toHaveLength(1)
  })

  it('F3 <select>：按选项 value / label 选中，一次页面函数搞定，不碰键盘', async () => {
    const fake = fakeSession()
    fake.results.inspect = [field({ kind: 'select', type: 'select-one' })]
    fake.results['select-option'] = [{ ok: true, label: 'Blue' }]
    const out = await fillOp(fake.session, 'e7', 'blue')
    expect(fake.controllerCalls).toEqual(['inspect', 'select-option'])
    expect(fake.controllerArgs[1]).toEqual(['blue'])
    expect(out.text).toBe('Selected "Blue" in button "Submit" (uid=e7).')
    expect(fake.commands.filter((c) => c.method.startsWith('Input.'))).toEqual([])
  })

  it('F4 没有这个选项 → 列出现有选项，超出的只报个数', async () => {
    const fake = fakeSession()
    fake.results.inspect = [field({ kind: 'select', type: 'select-one' })]
    fake.results['select-option'] = [{ ok: false, options: ['Red [r]', 'Green [g]'], more: 5 }]
    const out = await fillOp(fake.session, 'e7', 'Purple')
    expect(String(out.details?.error)).toContain(
      'has no option "Purple". Options: Red [r] | Green [g] … (+5 more)'
    )
  })

  it('F4 选项被禁用 → 明说', async () => {
    const fake = fakeSession()
    fake.results.inspect = [field({ kind: 'select', type: 'select-one' })]
    fake.results['select-option'] = [{ ok: false, disabledOption: 'Blue' }]
    const out = await fillOp(fake.session, 'e7', 'Blue')
    expect(out.details?.error).toBe('option "Blue" of button "Submit" (uid=e7) is disabled.')
  })

  it.each<[string, string, string, string, 'text' | 'error', string]>([
    [
      'date 按格式填',
      'date',
      '2024-01-02',
      '2024-01-02',
      'text',
      'Set button "Submit" (uid=e7) to "2024-01-02".'
    ],
    [
      'date 格式不对、被浏览器拒收',
      'date',
      '01/02/2024',
      '',
      'error',
      'rejected "01/02/2024" — expected a value like YYYY-MM-DD'
    ],
    [
      'color 被浏览器规范化',
      'color',
      '#FF0000',
      '#ff0000',
      'text',
      'normalized "#FF0000" to "#ff0000"'
    ]
  ])(
    'F5 值类 input（%s）：走 value setter，不打字',
    async (_label, type, input, returned, channel, fragment) => {
      const fake = fakeSession()
      fake.results.inspect = [field({ kind: 'value', type })]
      fake.results['set-value'] = [{ value: returned }]
      const out = await fillOp(fake.session, 'e7', input)
      if (channel === 'error') {
        expect(String(out.details?.error)).toContain(fragment)
      } else {
        expect(out.details?.error).toBeUndefined()
        expect(out.text).toContain(fragment)
      }
      expect(fake.controllerCalls).toEqual(['inspect', 'set-value'])
      expect(fake.controllerArgs[1]).toEqual([input])
      expect(sent(fake, cmd('Input.insertText'))).toEqual([])
    }
  )

  it.each<[string, Params, string, string[]]>([
    [
      '勾选框',
      { kind: 'checkable', type: 'checkbox' },
      'hello',
      ['is a checkbox — use click to toggle it']
    ],
    [
      '文件 input',
      { kind: 'file', type: 'file' },
      'hello',
      ['DOM.setFileInputFiles', '{"$uid":"e7"}']
    ],
    [
      '不是表单控件',
      { kind: 'other', type: '', desc: '<div.card>' },
      'hello',
      ['is not a form field (<div.card>)']
    ],
    [
      '数字框收到非数字',
      { kind: 'text', type: 'number' },
      'abc',
      ['is a number field and cannot take "abc"']
    ]
  ])('F6 %s → 直接报错改道，只做了检查', async (_label, info, text, fragments) => {
    const fake = fakeSession()
    fake.results.inspect = [field(info)]
    const out = await fillOp(fake.session, 'e7', text)
    for (const fragment of fragments) expect(String(out.details?.error)).toContain(fragment)
    expect(fake.controllerCalls).toEqual(['inspect'])
  })

  it('F7 字段暂时 disabled（脚本稍后才放开）→ 等它可编辑再填', async () => {
    vi.useFakeTimers()
    const fake = fakeSession()
    fake.results.inspect = [field({ disabled: true }), field({ disabled: true }), field()]
    const out = await within(fillOp(fake.session, 'e7', 'hello'), 300)
    expect(out.text).toContain('Filled')
    expect(fake.controllerCalls.filter((name) => name === 'inspect')).toHaveLength(3)
  })

  it.each<[string, Params, string]>([
    ['disabled', { disabled: true }, 'button "Submit" (uid=e7) is disabled.'],
    ['read-only', { readOnly: true }, 'button "Submit" (uid=e7) is read-only.']
  ])('F7 一直 %s → 等满 1.5s 后报错，不打字', async (_label, info, error) => {
    vi.useFakeTimers()
    const fake = fakeSession()
    fake.results.inspect = [field(info)]
    const out = await within(fillOp(fake.session, 'e7', 'hello'), 1600)
    expect(out.details?.error).toBe(error)
    expect(sent(fake, cmd('Input.insertText'))).toEqual([])
  })

  it.each<[string, Params, string, 'text' | 'error', string, boolean]>([
    [
      '页面把焦点挪去了下一个输入框',
      readBack('', { active: '<input#otp-2>' }),
      '123456',
      'error',
      'the page moved focus to <input#otp-2>, so the typing landed there',
      false
    ],
    [
      '页面把值格式化了',
      readBack('(555) 123-4567'),
      '5551234567',
      'text',
      'but the page changed the value to "(555) 123-4567"',
      true
    ],
    [
      '元素不可见（代码编辑器的输入代理）',
      readBack('', { visible: false }),
      'hello',
      'text',
      'could not verify it: the element is hidden',
      false
    ]
  ])(
    'F8 读回对不上（%s）→ 如实说明，不重试',
    async (_label, after, text, channel, fragment, changeSent) => {
      const fake = fakeSession()
      fake.results['read-back'] = [after]
      const out = await fillOp(fake.session, 'e7', text)
      if (channel === 'error') {
        expect(String(out.details?.error)).toContain(fragment)
      } else {
        expect(out.details?.error).toBeUndefined()
        expect(out.text).toContain(fragment)
      }
      expect(sent(fake, cmd('Input.insertText'))).toHaveLength(1)
      expect(fake.controllerCalls.at(-1) === 'change').toBe(changeSent)
    }
  )

  it('F9 第一次没留住（被重渲染冲掉）→ 重新全选再输入一次', async () => {
    vi.useFakeTimers()
    const fake = fakeSession()
    fake.results['read-back'] = [readBack('old'), readBack('hello')]
    const out = await within(fillOp(fake.session, 'e7', 'hello'), 500)
    expect(out.text).toContain('Filled')
    expect(fake.controllerCalls.filter((name) => name === 'select-content')).toHaveLength(2)
    expect(sent(fake, cmd('Input.insertText'))).toHaveLength(2)
  })

  it('F9 两次都没留住 → 报错，不试第三次', async () => {
    vi.useFakeTimers()
    const fake = fakeSession()
    fake.results['read-back'] = [readBack('old')]
    const out = await within(fillOp(fake.session, 'e7', 'hello'), 500)
    expect(String(out.details?.error)).toContain('after two attempts it still shows "old"')
    expect(sent(fake, cmd('Input.insertText'))).toHaveLength(2)
  })

  it('读回时节点两次都已被页面替换 → 报「填的过程中被换掉了」', async () => {
    vi.useFakeTimers()
    const fake = fakeSession()
    fake.results['read-back'] = [{ gone: true }]
    const out = await within(fillOp(fake.session, 'e7', 'hello'), 500)
    expect(String(out.details?.error)).toContain('was replaced by the page while filling')
  })
})

describe('typeOp', () => {
  it('无 uid 不 focus；submitKey 触发按键', async () => {
    const { session, commands, controllerCalls } = fakeSession()
    await typeOp(session, 'query', undefined, 'Enter')
    expect(controllerCalls).toEqual([])
    expect(commands.some((c) => c.method === 'Input.insertText')).toBe(true)
    const keyEvents = commands.filter((c) => c.method === 'Input.dispatchKeyEvent')
    expect(keyEvents.length).toBe(2) // Enter keyDown + keyUp
  })

  it('T1 带 uid：先聚焦再 insertText，回显打进了哪个元素', async () => {
    const fake = fakeSession()
    fake.results.focus = [{ focused: true, active: '<input>' }]
    const out = await typeOp(fake.session, 'abc', 'e7')
    expect(fake.controllerCalls).toEqual(['focus'])
    const focus = fake.timeline.indexOf('fn:focus')
    expect(focus).toBeGreaterThanOrEqual(0)
    expect(focus).toBeLessThan(fake.timeline.indexOf('Input.insertText'))
    expect(sent(fake, cmd('Input.insertText')).map((c) => c.params)).toEqual([{ text: 'abc' }])
    expect(out.text).toBe('Typed "abc" into button "Submit" (uid=e7).')
  })

  it('T2 聚焦不上（焦点还在 <body>）→ 报错，不打字也不按键', async () => {
    const fake = fakeSession()
    fake.results.focus = [{ focused: false, active: '<body>' }]
    const out = await typeOp(fake.session, 'abc', 'e7', 'Enter')
    expect(String(out.details?.error)).toContain(
      'could not focus button "Submit" (uid=e7) — focus is on <body>'
    )
    expect(fake.commands.filter((c) => c.method.startsWith('Input.'))).toEqual([])
  })

  it('T2 聚焦时节点已脱离文档 → 抛 stale 错', async () => {
    const fake = fakeSession()
    fake.results.focus = [{ gone: true }]
    await expect(typeOp(fake.session, 'abc', 'e7')).rejects.toThrow(/no longer on the page/)
  })

  it('T3 submitKey 触发导航：打字 → 打记号 → 按键，等新页面加载完再回', async () => {
    const fake = fakeSession()
    when(fake, keyUp, () => navigateTo(fake, 'https://a.com/results'))
    const out = await typeOp(fake.session, 'q', undefined, 'Enter')
    expectCommandOrder(
      fake,
      cmd('Input.insertText'),
      cmd('Page.getFrameTree'),
      cmd('Input.dispatchKeyEvent')
    )
    expect(out.text).toBe(
      'Typed "q". Pressed Enter. Page navigated to https://a.com/results — take a new snapshot before further interaction.'
    )
    expect(fake.ctl.reset).toHaveBeenCalledTimes(1)
  })

  it('T3 不带 submitKey：只发一条 insertText，不打记号、不等页面', async () => {
    const fake = fakeSession()
    await typeOp(fake.session, 'hi')
    expect(fake.commands.map((c) => c.method)).toEqual(['Input.insertText'])
  })
})

describe('pressKeyOp', () => {
  it('P1 Enter 触发导航 → 按键前打好记号，等新页面加载完，作废 uid', async () => {
    const fake = fakeSession()
    when(fake, keyUp, () => navigateTo(fake, 'https://a.com/results'))
    const out = await pressKeyOp(fake.session, 'Enter')
    expect(out.text).toBe(
      'Pressed Enter. Page navigated to https://a.com/results — take a new snapshot before further interaction.'
    )
    expect(fake.ctl.reset).toHaveBeenCalledTimes(1)
    expectCommandOrder(
      fake,
      cmd('Page.getFrameTree'),
      (c) =>
        c.method === 'Input.dispatchKeyEvent' &&
        c.params?.type === 'keyDown' &&
        c.params.text === '\r' &&
        c.params.windowsVirtualKeyCode === 13
    )
  })

  it('P1 Tab 没触发导航 → 只回 Pressed Tab.，不作废 uid', async () => {
    const fake = fakeSession()
    const out = await pressKeyOp(fake.session, 'Tab')
    expect(out.text).toBe('Pressed Tab.')
    expect(fake.ctl.reset).not.toHaveBeenCalled()
  })
})

describe('navigateOp', () => {
  it('goto：Page.navigate + reset uid，等到新文档加载完', async () => {
    const fake = fakeSession()
    when(fake, cmd('Page.navigate'), () => {
      fake.page.marked = false
    })
    const out = await navigateOp(fake.session, 'goto', 'https://a.com/')
    expect(sent(fake, cmd('Page.navigate'))).toHaveLength(1)
    expect(fake.ctl.reset).toHaveBeenCalledTimes(1)
    expect(out.details?.url).toBe('https://a.com/')
  })

  it('goto 缺 url → 业务错误不抛异常', async () => {
    const { session } = fakeSession()
    const out = await navigateOp(session, 'goto')
    expect(out.details?.error).toBeTruthy()
  })

  it('back：navigateToHistoryEntry(currentIndex-1)', async () => {
    const fake = fakeSession()
    when(fake, cmd('Page.navigateToHistoryEntry'), () => {
      fake.page.marked = false
    })
    await navigateOp(fake.session, 'back')
    expect(sent(fake, cmd('Page.navigateToHistoryEntry')).map((c) => c.params)).toEqual([
      { entryId: 10 }
    ])
  })

  it('reload：Page.reload + reset uid', async () => {
    const fake = fakeSession()
    when(fake, cmd('Page.reload'), () => {
      fake.page.marked = false
    })
    await navigateOp(fake.session, 'reload')
    expect(sent(fake, cmd('Page.reload'))).toHaveLength(1)
    expect(fake.ctl.reset).toHaveBeenCalledTimes(1)
  })

  it('N1 Page.navigate 当场报错（DNS 失败）→ 业务错误带上原因，不等加载', async () => {
    const fake = fakeSession()
    fake.navigateResult.value = {
      frameId: 'F',
      loaderId: 'L2',
      errorText: 'net::ERR_NAME_NOT_RESOLVED'
    }
    const out = await navigateOp(fake.session, 'goto', 'https://nope.invalid/')
    expect(out.details).toEqual({
      url: 'https://nope.invalid/',
      error: 'navigation to https://nope.invalid/ failed: net::ERR_NAME_NOT_RESOLVED'
    })
    expect(countAfter(fake, cmd('Page.navigate'), pageStateRead)).toBe(0)
  })

  it('N2 goto：Page.enable → 打记号 → Page.navigate，等到新文档加载完', async () => {
    const fake = fakeSession()
    when(fake, cmd('Page.navigate'), () => {
      fake.page.url = 'https://a.com/login'
      fake.page.marked = false
    })
    const out = await navigateOp(fake.session, 'goto', 'https://a.com/login')
    expectCommandOrder(
      fake,
      cmd('Page.enable'),
      cmd('Page.getFrameTree'),
      markEvaluate,
      cmd('Page.navigate')
    )
    expect(out.details?.url).toBe('https://a.com/login')
    expect(out.text).toBe('Navigated to https://a.com/login. Take a snapshot before interacting.')
  })

  it('N3 只改 hash（Page.navigate 不带 loaderId）→ 没有新文档要等，直接回', async () => {
    const fake = fakeSession()
    fake.navigateResult.value = { frameId: 'F' }
    const out = await navigateOp(fake.session, 'goto', 'https://a.com/#x')
    expect(out.text).toBe('Navigated to https://a.com/#x. Take a snapshot before interacting.')
    expect(countAfter(fake, cmd('Page.navigate'), pageStateRead)).toBe(0)
  })

  it.each<[string, NavKind, string, (fake: FakeSession) => void, string, string]>([
    [
      'back 落到错误页',
      'back',
      'Page.navigateToHistoryEntry',
      landOnErrorPage,
      '(the page failed to load)',
      'https://a.com/0'
    ],
    [
      'forward 落到错误页',
      'forward',
      'Page.navigateToHistoryEntry',
      landOnErrorPage,
      '(the page failed to load)',
      'https://a.com/2'
    ],
    [
      'reload 落到错误页',
      'reload',
      'Page.reload',
      landOnErrorPage,
      '(the page failed to load)',
      'https://a.com/before'
    ],
    [
      'reload 开始又结束、文档没换',
      'reload',
      'Page.reload',
      startAndStopLoading,
      '(no new page was loaded',
      'https://a.com/before'
    ]
  ])(
    'N4 %s → 报想去的那个页面（历史记录的地址 / 重新加载前的地址），不报 chrome-error',
    async (_label, nav, trigger, effect, note, target) => {
      const fake = fakeSession()
      fake.page.url = 'https://a.com/before'
      when(fake, cmd(trigger), () => effect(fake))
      const out = await navigateOp(fake.session, nav)
      const error = String(out.details?.error)
      expect(error).toContain(note)
      expect(error).toContain(target)
      expect(out.details?.url).toBe(target)
      expect(out.text).not.toContain('chrome-error')
    }
  )

  it.each<[string, string, number, string]>([
    [
      '一直停在 loading',
      'loading',
      10_100,
      '(still loading after 10s — use wait_for before interacting)'
    ],
    ['DOM 已解析完、子资源迟迟不完', 'interactive', 2_100, '(still loading some resources)']
  ])('N5 %s → 到点放行、回显里说明，不算失败', async (_label, readyState, ms, note) => {
    vi.useFakeTimers()
    const fake = fakeSession()
    when(fake, cmd('Page.navigate'), () => {
      fake.page.url = 'https://a.com/slow'
      fake.page.readyState = readyState
      fake.page.marked = false
    })
    const out = await within(navigateOp(fake.session, 'goto', 'https://a.com/slow'), ms)
    expect(out.text).toContain(note)
    expect(out.details?.error).toBeUndefined()
  })
})

describe('waitForLoad', () => {
  type Mark = NonNullable<NonNullable<Parameters<typeof waitForLoad>[1]>['mark']>
  /** 动作前打的记号：主框架 F，只看 seq 0 之后的事件 */
  const MARK: Mark = { token: 'tok', url: 'https://a.com/', seq: 0, frameId: 'F' }

  it.each<[string, boolean, string]>([
    ['about:blank 不算加载完', false, 'timeout'],
    ['allowBlank 时 about:blank 也算', true, 'complete']
  ])('W1 没有记号：%s', async (_label, allowBlank, state) => {
    const fake = fakeSession()
    Object.assign(fake.page, { url: 'about:blank', marked: false })
    const load = await waitForLoad(fake.session, { allowBlank, timeoutMs: 300 })
    expect(load.state).toBe(state)
  })

  it('W1 没有记号：落在 chrome-error 页 → 立刻判失败，不再轮询', async () => {
    const fake = fakeSession()
    Object.assign(fake.page, { url: 'chrome-error://chromewebdata/', marked: false })
    const load = await waitForLoad(fake.session, { timeoutMs: 300 })
    expect(load).toEqual({ state: 'failed', url: 'chrome-error://chromewebdata/' })
    expect(sent(fake, pageStateRead)).toHaveLength(1)
  })

  it.each<[string, Partial<FakeSession['page']>, boolean, string]>([
    ['还是打了记号的旧文档', { marked: true }, false, 'timeout'],
    ['新文档已 complete', { marked: false }, false, 'complete'],
    [
      '错误页、导航却还没结束（从错误页 back 离开的途中）',
      { url: 'chrome-error://chromewebdata/', marked: false },
      false,
      'timeout'
    ],
    [
      '错误页、导航已开始并结束',
      { url: 'chrome-error://chromewebdata/', marked: false },
      true,
      'failed'
    ]
  ])('W2 有记号：%s → %s', async (_label, page, loadingEvents, state) => {
    const fake = fakeSession()
    Object.assign(fake.page, page)
    if (loadingEvents) startAndStopLoading(fake)
    const load = await waitForLoad(fake.session, { mark: MARK, timeoutMs: 300 })
    expect(load.state).toBe(state)
  })

  it.each<[string, Array<[string, string]>, string]>([
    [
      'stop 在 start 之前（不是这次加载的结束）',
      [
        ['Page.frameStoppedLoading', 'F'],
        ['Page.frameStartedLoading', 'F']
      ],
      'timeout'
    ],
    [
      'start 之后 stop（下载 / 204 / 被取消）',
      [
        ['Page.frameStartedLoading', 'F'],
        ['Page.frameStoppedLoading', 'F']
      ],
      'stopped'
    ],
    ['同文档导航', [['Page.navigatedWithinDocument', 'F']], 'complete'],
    [
      '事件全是别的框架的',
      [
        ['Page.frameStartedLoading', 'OTHER'],
        ['Page.frameStoppedLoading', 'OTHER'],
        ['Page.navigatedWithinDocument', 'OTHER']
      ],
      'timeout'
    ]
  ])('W3 仍是打了记号的文档：%s → %s', async (_label, events, state) => {
    const fake = fakeSession()
    for (const [method, frameId] of events) fake.push(method, { frameId })
    const load = await waitForLoad(fake.session, { mark: MARK, timeoutMs: 300 })
    expect(load.state).toBe(state)
  })

  it('读页面状态抛错（执行上下文正被销毁）→ 接着轮询，不当成失败', async () => {
    const fake = fakeSession()
    fake.page.marked = false
    let throws = 2
    fake.onCommand((method, params) => {
      if (pageStateRead({ method, params }) && throws-- > 0) {
        throw new Error('Execution context was destroyed.')
      }
    })
    const load = await waitForLoad(fake.session, { mark: MARK, timeoutMs: 1000 })
    expect(load.state).toBe('complete')
    expect(sent(fake, pageStateRead)).toHaveLength(3)
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
