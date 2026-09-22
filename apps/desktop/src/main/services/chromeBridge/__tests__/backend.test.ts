/**
 * ChromeBridgeBackend —— 内置能力服务器 `chrome` 的后端：把每个浏览器操作翻成桥上的请求。
 *
 *   CBB-P1…P6  纯函数：list_tabs 的正文（顺序与标注）、一行标签页、标签组标题与颜色、端能力；
 *   CBB-1      listTabs：tabs.list，按本会话的标签组标注；
 *   CBB-2…8    openTab：先问挂着的页（窗口、标题）、后台开页、并进本会话的标签组（同一会话串行，
 *              并发两次只建一个组）、等加载；分组 / 等加载失败不影响开页，开页失败原样失败；
 *   CBB-9      closeTab：挂着的那个标签页不关；tabId 必须是整数；
 *   CBB-10     readPage：extractPage 注入的结果 → 带表头的 markdown；读不了时说清为什么；
 *   CBB-11     tabUrl（站点门要用）：不 attach、带超时；桥失败 / 没连着 / 没挂着一律拒绝（fail closed），
 *              只有非整数 id（不发请求）与「没有这个标签页」回 undefined；
 *   CBB-12…13  没挂着 / 没连着的原话；绑定每次现读（会话设置是事实源）；
 *   CBB-14…16  交互 / 调试经 CDP 转发：attach 一次、对话框处理开一次、结果形状、事件经模块路由进缓冲、
 *              截图的超时（成功之后不留计时器，迟到的失败不成为未处理的拒绝）、attach 失败下一次重试。
 *
 * 桥用真的单例（browserState 的钩子挂在它上面），`connectionFor` 换成查本文件的连接表；
 * 连接是假的（`request` 按方法名回答并记下每一次请求）。会话设置经 sessionDao 的替身读。
 * 状态表是进程级的 —— 每个用例用自己的 installId / 会话 id。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CHROME_GROUP_COLORS, type ChromeTabInfo } from '@shuvix/chat-protocol/chromeBridge'
import { browserToolsForCaps } from '@shuvix/agent-runtime'

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

/** 会话 → 它的 settings.chromeTab（原样交给 chromeTabOf，可以是不合法的形状） */
const db = vi.hoisted(() => ({ bindings: {} as Record<string, unknown> }))

vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: {
    pickSettings: vi.fn((sid: string) =>
      sid in db.bindings ? { chromeTab: db.bindings[sid] } : undefined
    )
  }
}))

import { chromeBridge, type BridgeConnection } from '../server'
import { CHROME_NOT_CONNECTED, chromeBrowserState } from '../browserState'
import {
  CHROME_BROWSER_CAPS,
  ChromeBridgeBackend,
  createChromeBrowserBackend,
  formatTabLine,
  formatTabList,
  groupColorFor,
  groupTitleFor
} from '../backend'

// ─── 假连接 ─────────────────────────────────────────────────────────────

type Answer = (params: Record<string, unknown>) => unknown
type RequestMock = Mock<
  (method: string, params?: Record<string, unknown>, opts?: unknown) => Promise<unknown>
>

interface FakeConn {
  id: string
  ready: boolean
  info: { installId: string; runId: string }
  request: RequestMock
}

let seq = 0
const iid = (): string => `cbb-install-${++seq}`
const sid = (): string => `cbb-session-${++seq}`

const conns = new Map<string, FakeConn>()

vi.spyOn(chromeBridge, 'connectionFor').mockImplementation(
  (installId: string) => conns.get(installId) as unknown as BridgeConnection | undefined
)

/** 一个标签页快照（没说的字段给个平常值） */
const tab = (id: number, over: Partial<ChromeTabInfo> = {}): ChromeTabInfo => ({
  id,
  windowId: 1,
  title: `T${id}`,
  url: `u${id}`,
  active: false,
  groupId: -1,
  ...over
})

/** 挂着的页（tab 5）：窗口 3、标题 Inbox */
const ANCHOR = tab(5, { windowId: 3, title: 'Inbox', url: 'https://mail.example/', active: true })

/** 缺省回答：一个平常的浏览器 */
const DEFAULT_ANSWERS: Record<string, Answer> = {
  'tabs.get': (p) => (p.tabId === 5 ? ANCHOR : tab(Number(p.tabId))),
  'tabs.list': () => [ANCHOR],
  'tabs.create': () => tab(11, { windowId: 3 }),
  'tabs.remove': () => null,
  'tabs.waitLoad': () => ({ loaded: true }),
  'group.ensure': () => ({ groupId: 42 }),
  'page.extract': () => ({ title: 'T', url: 'https://a/', html: '<h1>Hi</h1><p>there</p>' }),
  'debugger.attach': () => null,
  'debugger.detach': () => null,
  'debugger.send': () => null
}

interface Rig {
  installId: string
  sessionId: string
  conn: FakeConn
  backend: ChromeBridgeBackend
}

/** 一条挂在 tab 5 上的标签页会话，浏览器连着 */
function rig(answers: Record<string, Answer> = {}): Rig {
  const installId = iid()
  const sessionId = sid()
  db.bindings[sessionId] = { installId, runId: 'run-1', tabId: 5 }
  const all = { ...DEFAULT_ANSWERS, ...answers }
  const conn: FakeConn = {
    id: `cbb-conn-${++seq}`,
    ready: true,
    info: { installId, runId: 'run-1' },
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      const answer = all[method]
      if (!answer) throw new Error(`unexpected request ${method}`)
      return answer(params ?? {})
    }) as RequestMock
  }
  conns.set(installId, conn)
  return { installId, sessionId, conn, backend: createChromeBrowserBackend(sessionId) }
}

/** 请求流水：[方法, 参数]（不含第三个参数） */
const requests = (c: FakeConn): Array<[string, unknown]> =>
  c.request.mock.calls.map(([m, p]) => [m, p])

const paramsOf = (c: FakeConn, method: string): unknown[] =>
  c.request.mock.calls.filter(([m]) => m === method).map(([, p]) => p)

const methodsOf = (c: FakeConn): string[] => c.request.mock.calls.map(([m]) => m)

async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r))
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 抓住一次拒绝的原话（toThrow 的字符串参数只做子串匹配） */
async function rejectionOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (err) {
    return (err as Error).message
  }
  throw new Error('expected the promise to reject')
}

const NOT_ATTACHED = 'This conversation is not attached to a Chrome tab.'
const invalidTab = (id: string): string =>
  `Invalid tabId "${id}". Use a tab id from list_tabs / open_tab.`

beforeEach(() => {
  conns.clear()
})

afterEach(() => {
  for (const key of Object.keys(db.bindings)) delete db.bindings[key]
  vi.useRealTimers()
})

// ─── 纯函数 ──────────────────────────────────────────────────────────────

describe('list_tabs 的正文与标签组的名字', () => {
  const A = tab(1, { title: 'A', url: 'u1', active: true })
  const X = tab(5, { title: 'X', url: 'u5' })
  const G = tab(7, { title: 'G', url: 'u7', groupId: 42 })
  const B = tab(9, { title: 'B', url: 'u9', audible: true })

  it('CBB-P1 挂着的页排第一，其次是本会话标签组里的（agent 自己开的），再是其余的；标注顺序 标签 → active → audible', () => {
    expect(formatTabList([A, X, G, B], { attachedTabId: 5, groupId: 42 }).split('\n')).toEqual([
      "[5] (this conversation's tab) X — u5",
      '[7] (opened by you) G — u7',
      '[1] (active) A — u1',
      '[9] (audible) B — u9'
    ])
    expect(formatTabLine({ ...X, active: true, audible: true }, ["this conversation's tab"])).toBe(
      "[5] (this conversation's tab, active, audible) X — u5"
    )
  })

  it('CBB-P1 分隔用的是 em dash（U+2014）', () => {
    expect(formatTabLine(X, [])).toBe('[5] X — u5')
  })

  it('CBB-P2 一行：pendingUrl 优先（导航进行中 url 还是旧的）；空标题写 (untitled)；两个地址都空时以「— 」结尾', () => {
    expect(formatTabLine(tab(3, { url: 'old', pendingUrl: 'new' }), [])).toBe('[3] T3 — new')
    expect(formatTabLine(tab(3, { title: '' }), [])).toBe('[3] (untitled) — u3')
    expect(formatTabLine(tab(3, { url: '', pendingUrl: undefined }), [])).toBe('[3] T3 — ')
  })

  it('CBB-P3 没有标签组 → 没有「opened by you」；挂着的页不在列表里 → 没有那一行；空列表 → (no open tabs)', () => {
    expect(formatTabList([A, G], { attachedTabId: 5 })).toBe('[1] (active) A — u1\n[7] G — u7')
    expect(formatTabList([A, G, B], { attachedTabId: 99, groupId: 42 }).split('\n')).toEqual([
      '[7] (opened by you) G — u7',
      '[1] (active) A — u1',
      '[9] (audible) B — u9'
    ])
    expect(formatTabList([], { attachedTabId: 5, groupId: 42 })).toBe('(no open tabs)')
  })

  it('CBB-P3 挂着的页恰好也在本会话的组里 → 只列一次（按挂着的页标注）', () => {
    const attachedInGroup = tab(5, { title: 'X', url: 'u5', groupId: 42 })
    expect(formatTabList([attachedInGroup, G], { attachedTabId: 5, groupId: 42 })).toBe(
      "[5] (this conversation's tab) X — u5\n[7] (opened by you) G — u7"
    )
  })

  it.each<[string | undefined, string]>([
    [undefined, 'ShuviX'],
    ['', 'ShuviX'],
    ['   ', 'ShuviX'],
    [' Inbox ', 'ShuviX · Inbox'],
    ['a'.repeat(18), `ShuviX · ${'a'.repeat(18)}`],
    ['b'.repeat(19), `ShuviX · ${'b'.repeat(17)}…`]
  ])('CBB-P4 groupTitleFor(%j) → %s', (title, expected) => {
    expect(groupTitleFor(title)).toBe(expected)
  })

  it('CBB-P5 groupColorFor：同一会话恒同一种颜色，总在 Chrome 的颜色表里；空串 → blue；200 个会话至少分出 3 种颜色', () => {
    expect(groupColorFor('')).toBe('blue')
    const ids = Array.from({ length: 200 }, (_, i) => `session-${i}-${(i * 7919) % 1000}`)
    const colors = ids.map(groupColorFor)
    for (const [i, id] of ids.entries()) {
      expect(groupColorFor(id)).toBe(colors[i])
      expect(CHROME_GROUP_COLORS).toContain(colors[i])
    }
    expect(new Set(colors).size).toBeGreaterThanOrEqual(3)
  })

  it('CBB-P6 端能力：没有 pdf / 上传 / 全页与元素截图 / 截图落盘；工具表里因此没有 upload_file 与 pdf；后端用的就是这一份', () => {
    expect(CHROME_BROWSER_CAPS).toEqual({
      pdf: false,
      fullPageScreenshot: false,
      elementScreenshot: false,
      screenshotToFile: false,
      evaluate: true,
      network: true,
      console: true,
      rawCdp: true,
      upload: false
    })
    const names = browserToolsForCaps(CHROME_BROWSER_CAPS).map((t) => t.name)
    expect(names).not.toContain('upload_file')
    expect(names).not.toContain('pdf')
    expect(createChromeBrowserBackend(sid()).caps).toBe(CHROME_BROWSER_CAPS)
    expect(createChromeBrowserBackend(sid())).toBeInstanceOf(ChromeBridgeBackend)
  })
})

// ─── listTabs ───────────────────────────────────────────────────────────

describe('listTabs', () => {
  it('CBB-1 tabs.list {} → formatTabList（挂着的页 = 绑定里的 tab，组 = 本会话记下的那个）', async () => {
    const tabs = [tab(1, { active: true }), ANCHOR, tab(7, { groupId: 42 }), tab(8, { groupId: 9 })]
    const r = rig({ 'tabs.list': () => tabs })
    chromeBrowserState(r.installId).groups.set(r.sessionId, 42)
    const out = await r.backend.listTabs()
    expect(requests(r.conn)).toEqual([['tabs.list', {}]])
    expect(out).toEqual({ text: formatTabList(tabs, { attachedTabId: 5, groupId: 42 }) })
    expect(out.text!.split('\n')[1]).toBe('[7] (opened by you) T7 — u7')
  })

  it('CBB-1 本会话还没有标签组 → 不标「opened by you」', async () => {
    const tabs = [ANCHOR, tab(7, { groupId: 42 })]
    const r = rig({ 'tabs.list': () => tabs })
    expect((await r.backend.listTabs()).text).toBe(
      formatTabList(tabs, { attachedTabId: 5, groupId: undefined })
    )
  })
})

// ─── openTab ────────────────────────────────────────────────────────────

describe('openTab', () => {
  const URL = 'https://x.example/'
  const OPENED = `Opened ${URL} in background tab 11. Use read_page / snapshot with this tab id.`

  it('CBB-2 第一次：先问挂着的页 → 在它的窗口里后台开页 → 建组并入（标题取挂着的页、颜色按会话）→ 等加载；组 id 记下', async () => {
    const r = rig()
    const out = await r.backend.openTab({ url: URL })
    expect(requests(r.conn)).toEqual([
      ['tabs.get', { tabId: 5 }],
      ['tabs.create', { url: URL, windowId: 3 }],
      [
        'group.ensure',
        {
          groupId: undefined,
          tabIds: [11],
          title: groupTitleFor('Inbox'),
          color: groupColorFor(r.sessionId)
        }
      ],
      ['tabs.waitLoad', { tabId: 11, timeoutMs: 10_000 }]
    ])
    expect(out).toEqual({ text: OPENED, details: { url: URL } })
    expect(chromeBrowserState(r.installId).groups.get(r.sessionId)).toBe(42)
  })

  it('CBB-3 第二次：group.ensure 收到记下的组 id；回了新的 id（组被解散后重建）就换成新的', async () => {
    let next = 42
    const r = rig({ 'group.ensure': () => ({ groupId: next }) })
    await r.backend.openTab({ url: URL })
    next = 77
    await r.backend.openTab({ url: URL })
    expect(
      paramsOf(r.conn, 'group.ensure').map((p) => (p as { groupId?: number }).groupId)
    ).toEqual([undefined, 42])
    expect(chromeBrowserState(r.installId).groups.get(r.sessionId)).toBe(77)
  })

  it.each<[string, Answer]>([
    [
      '失败',
      () => {
        throw new Error('No tab with id: 5.')
      }
    ],
    ['回 null（挂着的页已经关了）', (p) => (p.tabId === 5 ? null : tab(Number(p.tabId)))]
  ])('CBB-4 问挂着的页%s → 窗口不指定、组标题就是 ShuviX；照样开页', async (_l, tabsGet) => {
    const r = rig({ 'tabs.get': tabsGet })
    const out = await r.backend.openTab({ url: URL })
    expect(paramsOf(r.conn, 'tabs.create')).toEqual([{ url: URL, windowId: undefined }])
    expect(paramsOf(r.conn, 'group.ensure')).toEqual([
      { groupId: undefined, tabIds: [11], title: 'ShuviX', color: groupColorFor(r.sessionId) }
    ])
    expect(out.text).toBe(OPENED)
  })

  it('CBB-5 并组失败 → 照样报开页成功；记下的组 id 不变', async () => {
    const r = rig({
      'group.ensure': () => {
        throw new Error('Tabs cannot be edited right now.')
      }
    })
    const state = chromeBrowserState(r.installId)
    expect((await r.backend.openTab({ url: URL })).text).toBe(OPENED)
    expect(state.groups.has(r.sessionId)).toBe(false)

    state.groups.set(r.sessionId, 42)
    expect((await r.backend.openTab({ url: URL })).text).toBe(OPENED)
    expect(state.groups.get(r.sessionId)).toBe(42)
    expect(paramsOf(r.conn, 'tabs.waitLoad')).toHaveLength(2)
  })

  it.each<[string, Answer]>([
    ['超时（loaded:false）', () => ({ loaded: false })],
    [
      '失败',
      () => {
        throw new Error('Chrome did not answer "tabs.waitLoad" within 60s.')
      }
    ]
  ])('CBB-6 等加载%s → 开页照样成功，文本注明 (still loading)', async (_l, waitLoad) => {
    const r = rig({ 'tabs.waitLoad': waitLoad })
    const out = await r.backend.openTab({ url: URL })
    expect(out.text).toBe(
      `Opened ${URL} in background tab 11 (still loading). Use read_page / snapshot with this tab id.`
    )
  })

  it('CBB-7 开页失败 → 原样失败；不并组、不等加载', async () => {
    const r = rig({
      'tabs.create': () => {
        throw new Error('Cannot create tab: the window was closed.')
      }
    })
    expect(await rejectionOf(r.backend.openTab({ url: URL }))).toBe(
      'Cannot create tab: the window was closed.'
    )
    expect(methodsOf(r.conn)).toEqual(['tabs.get', 'tabs.create'])
  })

  it('CBB-8 同一浏览器的两条会话：各有各的组（按会话记）、颜色按各自的会话', async () => {
    let nextGroup = 40
    const r = rig({ 'group.ensure': () => ({ groupId: nextGroup++ }) })
    const other = sid()
    db.bindings[other] = { installId: r.installId, runId: 'run-1', tabId: 6 }
    const backend2 = createChromeBrowserBackend(other)

    await r.backend.openTab({ url: URL })
    await backend2.openTab({ url: URL })
    const ensures = paramsOf(r.conn, 'group.ensure') as Array<{ groupId?: number; color: string }>
    // 第二条会话第一次开页：不拿第一条会话的组
    expect(ensures.map((p) => p.groupId)).toEqual([undefined, undefined])
    expect(ensures.map((p) => p.color)).toEqual([groupColorFor(r.sessionId), groupColorFor(other)])
    const groups = chromeBrowserState(r.installId).groups
    expect(groups.get(r.sessionId)).toBe(40)
    expect(groups.get(other)).toBe(41)
    // 第二条会话的开页挂在它自己的那一页（tab 6）旁边
    expect(paramsOf(r.conn, 'tabs.get')).toEqual([{ tabId: 5 }, { tabId: 6 }])
  })

  it('CBB-8b 同一会话并发两次开页 → 只建一个组：第一次 ensure 收到 undefined，第二次收到第一次回的组 id', async () => {
    let created = 10
    const firstEnsure = deferred<{ groupId: number }>()
    let ensureCalls = 0
    const r = rig({
      'tabs.create': () => tab(++created, { windowId: 3 }),
      'group.ensure': (p) => {
        ensureCalls++
        return ensureCalls === 1 ? firstEnsure.promise : { groupId: p.groupId as number }
      }
    })

    const one = r.backend.openTab({ url: URL })
    const two = r.backend.openTab({ url: 'https://y.example/' })
    await vi.waitFor(() => expect(paramsOf(r.conn, 'group.ensure')).toHaveLength(1))
    await settle()
    expect(paramsOf(r.conn, 'group.ensure')).toHaveLength(1)
    expect(paramsOf(r.conn, 'tabs.create')).toHaveLength(2)

    firstEnsure.resolve({ groupId: 42 })
    await Promise.all([one, two])
    const ensures = paramsOf(r.conn, 'group.ensure') as Array<{
      groupId?: number
      tabIds: number[]
    }>
    expect(ensures.map((p) => p.groupId)).toEqual([undefined, 42])
    expect(ensures.flatMap((p) => p.tabIds).sort()).toEqual([11, 12])
    expect(chromeBrowserState(r.installId).groups.get(r.sessionId)).toBe(42)
  })
})

// ─── closeTab ───────────────────────────────────────────────────────────

describe('closeTab', () => {
  it('CBB-9 挂着的那个标签页 → 拒绝（关了对话就没了），不发 tabs.remove', async () => {
    const r = rig()
    expect(await rejectionOf(r.backend.closeTab({ tabId: '5' }))).toBe(
      'Tab 5 is the tab this conversation is attached to; closing it would end the conversation. Close a different tab.'
    )
    expect(paramsOf(r.conn, 'tabs.remove')).toEqual([])
  })

  it('CBB-9 别的标签页 → tabs.remove {tabId:数字}', async () => {
    const r = rig()
    expect(await r.backend.closeTab({ tabId: '6' })).toEqual({ text: 'Closed tab 6.' })
    expect(paramsOf(r.conn, 'tabs.remove')).toEqual([{ tabId: 6 }])
  })

  it.each(['abc', '1.5', '6x', 'NaN', 'Infinity'])(
    'CBB-9 tabId %j 不是整数 → 逐字报错，一个请求都不发',
    async (id) => {
      const r = rig()
      expect(await rejectionOf(r.backend.closeTab({ tabId: id }))).toBe(invalidTab(id))
      expect(r.conn.request).not.toHaveBeenCalled()
    }
  )
})

// ─── readPage ───────────────────────────────────────────────────────────

describe('readPage', () => {
  const HINT = "(chrome:// pages, the Chrome Web Store and other extensions' pages cannot be read.)"

  it('CBB-10 extractPage 的结果 → 表头（标题、地址）+ markdown 正文；不 attach', async () => {
    const r = rig()
    const out = await r.backend.readPage({ tabId: '6' })
    expect(requests(r.conn)).toEqual([['page.extract', { tabId: 6 }]])
    expect(out.text!.startsWith('Page: T\nURL: https://a/\n\n')).toBe(true)
    expect(out.text).toContain('# Hi')
    expect(out.text).toContain('there')
  })

  it('CBB-10 注入失败 → 说清读不了、为什么，以及哪些页读不了', async () => {
    const r = rig({
      'page.extract': () => {
        throw new Error('X')
      }
    })
    expect(await rejectionOf(r.backend.readPage({ tabId: '6' }))).toBe(
      `Cannot read tab 6: X. ${HINT}`
    )
  })

  it.each<[string, unknown]>([
    ['{}', {}],
    ['null', null],
    ['html 不是字符串', { title: 'T', url: 'u', html: 42 }]
  ])('CBB-10 注入回来 %s → 当作没有结果', async (_l, result) => {
    const r = rig({ 'page.extract': () => result })
    const message = await rejectionOf(r.backend.readPage({ tabId: '6' }))
    expect(message).toBe(`Cannot read tab 6: no result. ${HINT}`)
  })

  it('CBB-10 tabId 不是整数 → 逐字报错（不包成「读不了」），不发请求', async () => {
    const r = rig()
    expect(await rejectionOf(r.backend.readPage({ tabId: 'abc' }))).toBe(invalidTab('abc'))
    expect(r.conn.request).not.toHaveBeenCalled()
  })
})

// ─── tabUrl ─────────────────────────────────────────────────────────────

describe('tabUrl（站点门用：只问地址，不 attach）', () => {
  it.each<[string, ChromeTabInfo | null, string | undefined]>([
    ['url', tab(6, { url: 'https://a.example/' }), 'https://a.example/'],
    [
      'url 为空、导航进行中',
      tab(6, { url: '', pendingUrl: 'https://b.example/' }),
      'https://b.example/'
    ],
    [
      'url 与 pendingUrl 都有 → 眼下显示的那一个',
      tab(6, { url: 'https://a.example/', pendingUrl: 'https://b.example/' }),
      'https://a.example/'
    ],
    ['两个都空', tab(6, { url: '' }), undefined],
    ['没有这个标签页（null）', null, undefined]
  ])('CBB-11 %s', async (_l, answer, expected) => {
    const r = rig({ 'tabs.get': () => answer })
    expect(await r.backend.tabUrl({ tabId: '6' })).toBe(expected)
    // 一次 tabs.get，带自己的超时；不 attach、不碰调试
    expect(r.conn.request.mock.calls).toEqual([['tabs.get', { tabId: 6 }, { timeoutMs: 10_000 }]])
  })

  it.each(['x', '1.5', 'NaN'])('CBB-11 tabId %j 不是整数 → undefined，不发请求', async (id) => {
    const r = rig()
    expect(await r.backend.tabUrl({ tabId: id })).toBeUndefined()
    expect(r.conn.request).not.toHaveBeenCalled()
  })

  it('CBB-11 桥上的请求失败（超时 / 断开）→ 拒绝，原话不改（门得知道 tab 在哪才能放行）', async () => {
    const r = rig({
      'tabs.get': () => {
        throw new Error('Chrome did not answer "tabs.get" within 10s.')
      }
    })
    expect(await rejectionOf(r.backend.tabUrl({ tabId: '6' }))).toBe(
      'Chrome did not answer "tabs.get" within 10s.'
    )
  })

  it('CBB-11 浏览器没连着 → 以 CHROME_NOT_CONNECTED 拒绝', async () => {
    const r = rig()
    conns.delete(r.installId)
    expect(await rejectionOf(r.backend.tabUrl({ tabId: '6' }))).toBe(CHROME_NOT_CONNECTED)
  })

  it('CBB-11 会话没挂在任何标签页上 → 拒绝（不当成「没有这个 tab」放行）', async () => {
    const r = rig()
    delete db.bindings[r.sessionId]
    expect(await rejectionOf(r.backend.tabUrl({ tabId: '6' }))).toBe(NOT_ATTACHED)
    expect(r.conn.request).not.toHaveBeenCalled()
  })
})

// ─── 没挂着 / 没连着 / 绑定现读 ─────────────────────────────────────────

describe('没挂着、没连着', () => {
  type Op = (b: ChromeBridgeBackend) => Promise<unknown>
  const OPS: Array<[string, Op]> = [
    ['listTabs', (b) => b.listTabs()],
    ['openTab', (b) => b.openTab({ url: 'https://x.example/' })],
    ['closeTab', (b) => b.closeTab({ tabId: '6' })],
    ['tabUrl', (b) => b.tabUrl({ tabId: '6' })],
    ['click', (b) => b.click({ tabId: '6', uid: 'e1' })],
    ['cdp', (b) => b.cdp({ tabId: '6', method: 'DOM.getDocument' })],
    ['screenshot', (b) => b.screenshot({ tabId: '6' })]
  ]

  it.each<[string, unknown]>([
    ['没有这条会话的绑定', undefined],
    ['绑定不合法（tabId 是字符串）', { installId: 'i', runId: 'r', tabId: '5' }],
    ['绑定不合法（缺 installId）', { runId: 'r', tabId: 5 }]
  ])('CBB-12 %s → 每个操作都以同一句原话失败，一个请求都不发', async (_l, binding) => {
    const r = rig()
    if (binding === undefined) delete db.bindings[r.sessionId]
    else db.bindings[r.sessionId] = binding
    for (const [name, op] of OPS) {
      expect(await rejectionOf(op(r.backend)), name).toBe(NOT_ATTACHED)
    }
    expect(r.conn.request).not.toHaveBeenCalled()
  })

  it('CBB-12 挂着但浏览器没连着 → 每个操作都以 CHROME_NOT_CONNECTED 原话失败', async () => {
    const r = rig()
    conns.delete(r.installId)
    for (const [name, op] of OPS) {
      expect(await rejectionOf(op(r.backend)), name).toBe(CHROME_NOT_CONNECTED)
    }
  })

  it('CBB-12b readPage 没挂着 / 没连着 → 同一句原话，不包成「这一页读不了」', async () => {
    const r = rig()
    conns.delete(r.installId)
    expect(await rejectionOf(r.backend.readPage({ tabId: '6' }))).toBe(CHROME_NOT_CONNECTED)
    delete db.bindings[r.sessionId]
    expect(await rejectionOf(r.backend.readPage({ tabId: '6' }))).toBe(NOT_ATTACHED)
  })

  it('CBB-13 绑定每次现读：挂着的 tab 从 5 换成 6 之后，关 6 被拒、关 5 放行', async () => {
    const r = rig()
    expect((await r.backend.closeTab({ tabId: '6' })).text).toBe('Closed tab 6.')
    db.bindings[r.sessionId] = { installId: r.installId, runId: 'run-1', tabId: 6 }
    expect(await rejectionOf(r.backend.closeTab({ tabId: '6' }))).toContain(
      'Tab 6 is the tab this conversation is attached to'
    )
    expect((await r.backend.closeTab({ tabId: '5' })).text).toBe('Closed tab 5.')
    expect(paramsOf(r.conn, 'tabs.remove')).toEqual([{ tabId: 6 }, { tabId: 5 }])
  })
})

// ─── CDP 转发 ────────────────────────────────────────────────────────────

describe('交互 / 调试经 CDP 转发', () => {
  it('CBB-14 cdp：attach {tabId:数字} → 开对话框处理（Page.enable）→ 发命令；结果以「方法 →」开头；同一 tab 不重复 attach，别的 tab 各自 attach', async () => {
    const r = rig({
      'debugger.send': (p) => (p.method === 'DOM.getDocument' ? { root: { nodeId: 1 } } : null)
    })
    const out = await r.backend.cdp({ tabId: '6', method: 'DOM.getDocument' })
    expect(requests(r.conn)).toEqual([
      ['debugger.attach', { tabId: 6 }],
      ['debugger.send', { tabId: 6, method: 'Page.enable', params: undefined }],
      ['debugger.send', { tabId: 6, method: 'DOM.getDocument', params: undefined }]
    ])
    expect(out.text!.startsWith('DOM.getDocument →')).toBe(true)
    expect(out.text).toContain('"nodeId": 1')

    await r.backend.cdp({ tabId: '6', method: 'DOM.getDocument', params: { depth: 2 } })
    expect(paramsOf(r.conn, 'debugger.attach')).toEqual([{ tabId: 6 }])
    // 对话框处理只开一次
    expect(
      paramsOf(r.conn, 'debugger.send').filter(
        (p) => (p as { method: string }).method === 'Page.enable'
      )
    ).toHaveLength(1)
    expect(paramsOf(r.conn, 'debugger.send').at(-1)).toEqual({
      tabId: 6,
      method: 'DOM.getDocument',
      params: { depth: 2 }
    })

    await r.backend.cdp({ tabId: '7', method: 'DOM.getDocument' })
    expect(paramsOf(r.conn, 'debugger.attach')).toEqual([{ tabId: 6 }, { tabId: 7 }])
  })

  it('CBB-14 开对话框处理失败不挡路：命令照发', async () => {
    const r = rig({
      'debugger.send': (p) => {
        if (p.method === 'Page.enable') throw new Error('Cannot access a chrome:// URL')
        return { ok: true }
      }
    })
    const out = await r.backend.cdp({ tabId: '6', method: 'Runtime.evaluate' })
    expect(out.text!.startsWith('Runtime.evaluate →')).toBe(true)
  })

  it('CBB-14b 模块路由进来的 CDP 事件落在这个后端用的会话里：events 拉得到', async () => {
    const r = rig()
    await r.backend.cdp({ tabId: '6', method: 'Log.enable' })
    chromeBridge.dispatchEvent(r.conn as unknown as BridgeConnection, 'debugger.event', {
      tabId: 6,
      method: 'Log.entryAdded',
      params: { entry: { text: 'hello from the page' } }
    })
    const out = await r.backend.events({ tabId: '6' })
    expect(out.text).toContain('Log.entryAdded')
    expect(out.text).toContain('hello from the page')
  })

  it('CBB-15 screenshot：Page.captureScreenshot {jpeg, 60} → 一张内联 jpeg；成功之后不留计时器', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = rig({
      'debugger.send': (p) => (p.method === 'Page.captureScreenshot' ? { data: 'QUJD' } : null)
    })
    const out = await r.backend.screenshot({ tabId: '6' })
    expect(out).toEqual({
      text: 'Screenshot of tab 6.',
      images: [{ data: 'QUJD', mimeType: 'image/jpeg' }]
    })
    expect(paramsOf(r.conn, 'debugger.send').at(-1)).toEqual({
      tabId: 6,
      method: 'Page.captureScreenshot',
      params: { format: 'jpeg', quality: 60 }
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('CBB-15 截图 20 秒没出帧 → 逐字的超时原话；之后截图那一路才失败也不成为未处理的拒绝', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const capture = deferred<unknown>()
      const r = rig({
        'debugger.send': (p) => (p.method === 'Page.captureScreenshot' ? capture.promise : null)
      })
      let outcome: string | undefined
      const shot = r.backend.screenshot({ tabId: '6' }).then(
        () => (outcome = 'resolved'),
        (err: Error) => (outcome = err.message)
      )
      await settle()
      expect(
        paramsOf(r.conn, 'debugger.send').some(
          (p) => (p as { method: string }).method === 'Page.captureScreenshot'
        )
      ).toBe(true)

      await vi.advanceTimersByTimeAsync(19_999)
      expect(outcome).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      await shot
      expect(outcome).toBe(
        'Tab 6 did not produce a screenshot in time — Chrome may not be rendering it while it is in the background. Use snapshot or read_page instead.'
      )

      capture.reject(new Error('Chrome is no longer connected to ShuviX.'))
      await settle(10)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('CBB-16 attach 失败 → 这次操作失败（原话）；下一次操作重新 attach', async () => {
    let refuse = true
    const r = rig({
      'debugger.attach': () => {
        if (refuse) throw new Error('Another debugger is already attached to the tab with id: 6.')
        return null
      },
      'debugger.send': () => ({})
    })
    expect(await rejectionOf(r.backend.click({ tabId: '6', uid: 'e1' }))).toBe(
      'Another debugger is already attached to the tab with id: 6.'
    )
    refuse = false
    await r.backend.cdp({ tabId: '6', method: 'DOM.getDocument' })
    expect(paramsOf(r.conn, 'debugger.attach')).toEqual([{ tabId: 6 }, { tabId: 6 }])
  })

  it('CBB-16 交互类操作的 tabId 不是整数 → 逐字报错，不 attach', async () => {
    const r = rig()
    expect(await rejectionOf(r.backend.click({ tabId: 'abc', uid: 'e1' }))).toBe(invalidTab('abc'))
    expect(await rejectionOf(r.backend.screenshot({ tabId: '1.5' }))).toBe(invalidTab('1.5'))
    expect(r.conn.request).not.toHaveBeenCalled()
  })
})
