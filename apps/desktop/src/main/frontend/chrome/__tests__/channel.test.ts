/**
 * 侧边栏的单会话对话接口（frontend/chrome/channel.ts 的 `callPanelChannel`）。
 *
 * 契约：
 *   - 只接 `CHROME_PANEL_CHANNEL_PATHS` 里的路径，别的一律拒绝、什么也不调；
 *   - 每个带会话的调用**先**核对归属（会话必须是这条连接 = 这个浏览器这一轮运行的标签页会话），
 *     不归它就拒绝、什么也不调 —— 桥不是 `window.api` 的远程版；
 *   - 过了关就落到与 Electron IPC 同样的服务调用上（同样的参数、同样的返回），
 *     而且在一个 chrome 来源的操作上下文里跑；
 *   - `agent.prompt` 在开跑**之前**把消息里带上的标签页（tab token）此刻所在的站点记为这条会话
 *     已同意的站点：地址向 Chrome 现问（`tabs.get`，5 秒超时），问不到就跳过，发送照常；
 *     steer / followUp / nextTurn 不记任何站点；
 *   - `agent.respondToInput` 只送进这条会话自己的运行时；没人认领就广播 input_request_resolved
 *     把卡片收走 —— 别的会话的 requestId 永远送不到那条会话。
 *
 * 归属判定用真的 `../tabSessions`（规则住在那里），sessionDao 是一张 pickSettings 的内存表。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CHROME_PANEL_CHANNEL_PATHS } from '@shuvix/chat-protocol/chromeBridge'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import type { BridgeConnection } from '../../../services/chromeBridge'

type Ctx = { source: { type: string; installId: string }; sessionId?: string }

const mocks = vi.hoisted(() => {
  /** 当前操作上下文（operationContext.run 期间有值） */
  const ctx = { current: undefined as unknown }
  /** 每次委托调用：名字 + 参数 + 调用那一刻的上下文 */
  const calls: Array<{ name: string; args: unknown[]; ctx: unknown }> = []
  const timeline: string[] = []
  const delegate = (
    name: string,
    result: (...args: unknown[]) => unknown
  ): ReturnType<typeof vi.fn> =>
    vi.fn((...args: unknown[]) => {
      calls.push({ name, args, ctx: ctx.current })
      timeline.push(name)
      return result(...args)
    })
  return {
    ctx,
    calls,
    timeline,
    delegate,
    settings: new Map<string, Record<string, unknown>>(),
    gateway: {} as Record<string, ReturnType<typeof vi.fn>>,
    broadcast: vi.fn(),
    runInContext: vi.fn(),
    getById: vi.fn(),
    getAgentSession: vi.fn(),
    taskList: vi.fn(),
    presentations: vi.fn(),
    definitions: vi.fn(),
    grantSite: vi.fn(),
    pickSettings: vi.fn()
  }
})

vi.mock('../../core', () => ({
  chatGateway: new Proxy({}, { get: (_t, key: string) => mocks.gateway[key] }),
  chatFrontendRegistry: { broadcast: mocks.broadcast },
  createChromeContext: (installId: string, sessionId?: string) => ({
    source: { type: 'chrome', installId },
    sessionId
  }),
  operationContext: { run: mocks.runInContext }
}))
vi.mock('../../../services/sessionService', () => ({
  sessionService: { getById: mocks.getById, getAgentSession: mocks.getAgentSession }
}))
vi.mock('../../../services/taskRegistry', () => ({ taskRegistry: { list: mocks.taskList } }))
vi.mock('../../../services/toolRegistry', () => ({
  getBuiltinToolPresentations: mocks.presentations
}))
vi.mock('../../../services/agentToolBuilder', () => ({
  getBuiltinToolDefinitions: mocks.definitions
}))
vi.mock('../../../services/chromeBridge', () => ({
  grantSite: mocks.grantSite,
  existingChromeBrowserState: vi.fn()
}))
vi.mock('../../../dao/sessionDao', () => ({ sessionDao: { pickSettings: mocks.pickSettings } }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('@shuvix/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shuvix/agent-runtime')>()
  return {
    ...actual,
    browserSiteOf: vi.fn(actual.browserSiteOf),
    validateShuvixMdText: vi.fn(actual.validateShuvixMdText)
  }
})

import { validateShuvixMdText } from '@shuvix/agent-runtime'
import { callPanelChannel, isPanelChannelPath, NOT_YOUR_SESSION } from '../channel'

const OWNED = 'tab-owned'
const OTHER_RUN = 'tab-other-run'
const OTHER_INSTALL = 'tab-other-install'
const DESKTOP = 'desktop-session'

const CHROME_CTX = (sessionId: string): Ctx => ({
  source: { type: 'chrome', installId: 'i1' },
  sessionId
})

interface FakeConn {
  id: string
  info: { installId: string; runId: string } | undefined
  request: ReturnType<typeof vi.fn>
}

/** i1 / r1 的连接；request 回 tabs 表里的标签页（没有就 null） */
function makeConn(tabs: Record<number, unknown> = {}): FakeConn {
  return {
    id: 'conn-1',
    info: { installId: 'i1', runId: 'r1' },
    request: vi.fn(async (method: string, params: { tabId: number }) => {
      mocks.timeline.push(`request:${method}:${params.tabId}`)
      const tab = tabs[params.tabId]
      if (tab instanceof Error) throw tab
      return tab ?? null
    })
  }
}

let conn: FakeConn
const call = (path: unknown, args: unknown, c: FakeConn = conn): Promise<unknown> =>
  callPanelChannel(c as unknown as BridgeConnection, path, args)

/** 全部委托 spy（「恰好调了一个」的计数口径） */
const allDelegates = (): Array<ReturnType<typeof vi.fn>> => [
  ...Object.values(mocks.gateway),
  mocks.getById,
  mocks.getAgentSession,
  mocks.taskList,
  mocks.presentations,
  mocks.definitions,
  vi.mocked(validateShuvixMdText) as unknown as ReturnType<typeof vi.fn>
]
const totalDelegateCalls = (): number =>
  allDelegates().reduce((n, spy) => n + spy.mock.calls.length, 0)

const tabToken = (tabId: number, over: Partial<InlineToken> = {}): InlineToken => ({
  type: 'tab',
  id: `chrome-tab:${tabId}`,
  displayText: `tab ${tabId}`,
  payload: `[Chrome tab ${tabId}: "t" — u]`,
  ...over
})

/** 一个会被认领的运行时（respondToInput 回 claims） */
const agentWith = (claims: boolean): { respondToInput: ReturnType<typeof vi.fn> } => ({
  respondToInput: vi.fn(() => claims)
})

beforeEach(() => {
  mocks.calls.length = 0
  mocks.timeline.length = 0
  mocks.ctx.current = undefined
  mocks.settings.clear()
  mocks.settings.set(OWNED, { chromeTab: { installId: 'i1', runId: 'r1', tabId: 5 } })
  mocks.settings.set(OTHER_RUN, { chromeTab: { installId: 'i1', runId: 'r0', tabId: 5 } })
  mocks.settings.set(OTHER_INSTALL, { chromeTab: { installId: 'i2', runId: 'r1', tabId: 5 } })
  mocks.settings.set(DESKTOP, { enabledTools: [] })

  mocks.pickSettings.mockReset()
  mocks.pickSettings.mockImplementation((id: string, keys: string[]) => {
    const s = mocks.settings.get(id)
    return s ? Object.fromEntries(keys.map((k) => [k, structuredClone(s[k])])) : undefined
  })
  mocks.runInContext.mockReset()
  mocks.runInContext.mockImplementation((ctx: unknown, fn: () => unknown) => {
    const prev = mocks.ctx.current
    mocks.ctx.current = ctx
    try {
      return fn()
    } finally {
      mocks.ctx.current = prev
    }
  })

  mocks.gateway = {
    startChat: mocks.delegate('startChat', () => ({ success: true, created: false })),
    prompt: mocks.delegate('prompt', async () => ({})),
    steer: mocks.delegate('steer', () => undefined),
    followUp: mocks.delegate('followUp', () => undefined),
    nextTurn: mocks.delegate('nextTurn', () => undefined),
    abort: mocks.delegate('abort', async () => ({ aborted: true })),
    listMessages: mocks.delegate('listMessages', async () => [{ id: 'm1' }]),
    getRuntimeStatuses: mocks.delegate('getRuntimeStatuses', () => [{ id: 'rt1' }]),
    listTools: mocks.delegate('listTools', () => [{ name: 'mcp:chrome' }]),
    // 网关的按 requestId 在全部会话里找认领者的那条路 —— 侧边栏绝不能走它
    respondToInput: mocks.delegate('gateway.respondToInput', () => undefined)
  }
  for (const spy of [
    mocks.broadcast,
    mocks.getById,
    mocks.getAgentSession,
    mocks.taskList,
    mocks.presentations,
    mocks.definitions,
    mocks.grantSite
  ]) {
    spy.mockReset()
  }
  mocks.getById.mockImplementation((id: string) => {
    mocks.calls.push({ name: 'getById', args: [id], ctx: mocks.ctx.current })
    return { id, title: 'Chrome · Page' }
  })
  mocks.getAgentSession.mockReturnValue(undefined)
  mocks.taskList.mockReturnValue([{ id: 'task-1' }])
  mocks.presentations.mockReturnValue({ read: { icon: 'file' } })
  mocks.definitions.mockReturnValue([{ name: 'read' }])
  mocks.grantSite.mockImplementation((sid: string, site: string) => {
    mocks.timeline.push(`grant:${sid}:${site}`)
  })
  vi.mocked(validateShuvixMdText).mockClear()
  conn = makeConn()
})

// ─── 白名单 ─────────────────────────────────────────────────────────────────

describe('CH-1 白名单之外的路径一律拒绝', () => {
  it.each([
    'session.list',
    'session.create',
    'session.updateEnabledTools',
    'agent.setModel',
    'agent.subAgentPrompt',
    'files.scan',
    'bgTask.readLog',
    'command.list',
    'settings.getAll',
    '__proto__',
    'constructor',
    'hasOwnProperty',
    'toString',
    undefined,
    null,
    42
  ])('CH-1 %s → 拒绝，什么也不调', async (path) => {
    await expect(call(path, [OWNED])).rejects.toThrow(
      `"${String(path)}" is not available from the Chrome side panel.`
    )
    expect(totalDelegateCalls()).toBe(0)
    expect(mocks.pickSettings).not.toHaveBeenCalled()
    expect(conn.request).not.toHaveBeenCalled()
    expect(isPanelChannelPath(path)).toBe(false)
  })
})

// ─── 表里每条路径都真的接上了 ───────────────────────────────────────────────

/** 每条白名单路径：怎么调（归属于本连接的会话）+ 应该落到哪个委托 */
const FIXTURES: Record<string, { args: unknown[]; delegate: () => ReturnType<typeof vi.fn> }> = {
  'agent.init': { args: [{ sessionId: OWNED }], delegate: () => mocks.gateway.startChat },
  'agent.prompt': {
    args: [{ sessionId: OWNED, text: 'hi' }],
    delegate: () => mocks.gateway.prompt
  },
  'agent.steer': { args: [{ sessionId: OWNED, text: 's' }], delegate: () => mocks.gateway.steer },
  'agent.followUp': {
    args: [{ sessionId: OWNED, text: 'f' }],
    delegate: () => mocks.gateway.followUp
  },
  'agent.nextTurn': {
    args: [{ sessionId: OWNED, text: 'n' }],
    delegate: () => mocks.gateway.nextTurn
  },
  'agent.abort': { args: [OWNED], delegate: () => mocks.gateway.abort },
  'agent.respondToInput': {
    args: [{ sessionId: OWNED, requestId: 'req-1', response: { kind: 'ask', allowed: true } }],
    delegate: () => mocks.getAgentSession
  },
  'session.getById': { args: [OWNED], delegate: () => mocks.getById },
  'message.list': { args: [OWNED], delegate: () => mocks.gateway.listMessages },
  'runtime.statuses': { args: [OWNED], delegate: () => mocks.gateway.getRuntimeStatuses },
  'bgTask.list': { args: [{ sessionId: OWNED }], delegate: () => mocks.taskList },
  'tools.list': { args: [OWNED], delegate: () => mocks.gateway.listTools },
  'tools.presentations': { args: [], delegate: () => mocks.presentations },
  'tools.definitions': { args: [], delegate: () => mocks.definitions },
  'shuvixMd.validate': {
    args: [{ type: 'agent', text: '---\nname: x\n---\n' }],
    delegate: () => vi.mocked(validateShuvixMdText) as unknown as ReturnType<typeof vi.fn>
  }
}

describe('CH-2 白名单里的每条路径都落到恰好一个委托上', () => {
  it('CH-2 夹具覆盖整张白名单（表里加了路径、这里没加 → 红）', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...CHROME_PANEL_CHANNEL_PATHS].sort())
  })

  it.each([...CHROME_PANEL_CHANNEL_PATHS])('CH-2 %s', async (path) => {
    const fixture = FIXTURES[path]
    expect(fixture, `缺 ${path} 的夹具`).toBeDefined()
    // respondToInput：让本会话的运行时认领（不再多出一次广播）
    mocks.getAgentSession.mockReturnValue(agentWith(true))
    await call(path, fixture.args)
    expect(fixture.delegate()).toHaveBeenCalledTimes(1)
    expect(totalDelegateCalls()).toBe(1)
  })
})

// ─── 归属核对 ───────────────────────────────────────────────────────────────

/** 带会话的 12 条路径：会话怎么放进参数 */
const SESSION_PATHS: Array<[string, (sid: unknown) => unknown[]]> = [
  ['agent.init', (sid) => [{ sessionId: sid }]],
  ['agent.prompt', (sid) => [{ sessionId: sid, text: 'hi', inlineTokens: { t: tabToken(5) } }]],
  ['agent.steer', (sid) => [{ sessionId: sid, text: 's' }]],
  ['agent.followUp', (sid) => [{ sessionId: sid, text: 'f' }]],
  ['agent.nextTurn', (sid) => [{ sessionId: sid, text: 'n' }]],
  ['agent.abort', (sid) => [sid]],
  [
    'agent.respondToInput',
    (sid) => [{ sessionId: sid, requestId: 'req-1', response: { kind: 'ask', allowed: true } }]
  ],
  ['session.getById', (sid) => [sid]],
  ['message.list', (sid) => [sid]],
  ['runtime.statuses', (sid) => [sid]],
  ['bgTask.list', (sid) => [{ sessionId: sid }]],
  ['tools.list', (sid) => [sid]]
]

describe('CH-3 带会话的调用：会话不归这条连接 → 拒绝，什么也不调', () => {
  it('CH-3 恰是白名单里除三条无会话路径以外的全部', () => {
    expect(SESSION_PATHS.map(([p]) => p).sort()).toEqual(
      CHROME_PANEL_CHANNEL_PATHS.filter(
        (p) => !['tools.presentations', 'tools.definitions', 'shuvixMd.validate'].includes(p)
      ).sort()
    )
  })

  const cases: Array<[string, unknown]> = [
    ['别的浏览器的标签页会话', OTHER_INSTALL],
    ['同一浏览器上一轮运行的会话', OTHER_RUN],
    ['桌面自己的会话', DESKTOP],
    ['不存在的会话', 'no-such-session'],
    ['没给会话 id', undefined],
    ['会话 id 不是字符串', 7]
  ]

  for (const [path, argsOf] of SESSION_PATHS) {
    it.each(cases)(`CH-3 ${path}：%s`, async (_label, sid) => {
      await expect(call(path, argsOf(sid))).rejects.toThrow(NOT_YOUR_SESSION)
      expect(totalDelegateCalls()).toBe(0)
      expect(mocks.runInContext).not.toHaveBeenCalled()
      // agent.prompt：不归它的会话连标签页都不去问、站点更不会记
      expect(conn.request).not.toHaveBeenCalled()
      expect(mocks.grantSite).not.toHaveBeenCalled()
      expect(mocks.broadcast).not.toHaveBeenCalled()
    })

    it(`CH-3 ${path}：参数不是数组（会话 id 在对象里 / 裸字符串）`, async () => {
      await expect(call(path, { sessionId: OWNED, 0: OWNED })).rejects.toThrow(NOT_YOUR_SESSION)
      await expect(call(path, OWNED)).rejects.toThrow(NOT_YOUR_SESSION)
      await expect(call(path, undefined)).rejects.toThrow(NOT_YOUR_SESSION)
      expect(totalDelegateCalls()).toBe(0)
    })
  }

  it('CH-3 没握手的连接一条会话都不拥有', async () => {
    const unready = { ...makeConn(), info: undefined }
    await expect(call('agent.init', [{ sessionId: OWNED }], unready)).rejects.toThrow(
      NOT_YOUR_SESSION
    )
    expect(totalDelegateCalls()).toBe(0)
  })
})

// ─── 过了关的调用 ───────────────────────────────────────────────────────────

describe('CH-4 agent.prompt', () => {
  it('CH-4 恰以四个参数调网关（多余字段丢掉），在 chrome 来源的上下文里；回 {success:true}', async () => {
    const images = [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }]
    const inlineTokens = { k: { type: 'at', id: 'a', displayText: 'a', payload: 'p' } }
    const result = await call('agent.prompt', [
      { sessionId: OWNED, text: 'hello', images, inlineTokens, extra: 'dropped', model: 'x' }
    ])
    expect(result).toStrictEqual({ success: true })
    expect(mocks.gateway.prompt.mock.calls).toEqual([[OWNED, 'hello', images, inlineTokens]])
    expect(mocks.gateway.prompt.mock.calls[0]).toHaveLength(4)
    expect(mocks.calls.find((c) => c.name === 'prompt')!.ctx).toEqual(CHROME_CTX(OWNED))
  })

  it('CH-4 网关回 {error} 也回 {success:true}（与 Electron IPC 一致：错误走事件流）', async () => {
    mocks.gateway.prompt.mockImplementation(async () => ({ error: 'Agent 未初始化' }))
    expect(await call('agent.prompt', [{ sessionId: OWNED, text: 'x' }])).toStrictEqual({
      success: true
    })
  })

  it('CH-4 网关抛错 → 调用失败（与 Electron IPC 一致）', async () => {
    mocks.gateway.prompt.mockImplementation(async () => {
      throw new Error('boom')
    })
    await expect(call('agent.prompt', [{ sessionId: OWNED, text: 'x' }])).rejects.toThrow('boom')
  })
})

describe('CH-5 init / abort / 三条队列 / respondToInput', () => {
  it('CH-5 agent.init 回 startChat 的结果本身，在上下文里', async () => {
    const result = await call('agent.init', [{ sessionId: OWNED }])
    expect(result).toBe(mocks.gateway.startChat.mock.results[0].value)
    expect(mocks.gateway.startChat.mock.calls).toEqual([[OWNED]])
    expect(mocks.calls[0].ctx).toEqual(CHROME_CTX(OWNED))
  })

  it('CH-5 agent.abort 收的是字符串会话 id，回网关的结果', async () => {
    expect(await call('agent.abort', [OWNED])).toEqual({ aborted: true })
    expect(mocks.gateway.abort.mock.calls).toEqual([[OWNED]])
    expect(mocks.calls[0].ctx).toEqual(CHROME_CTX(OWNED))
    // 对象形参不是 abort 的形状
    await expect(call('agent.abort', [{ sessionId: OWNED }])).rejects.toThrow(NOT_YOUR_SESSION)
  })

  it.each([
    ['agent.steer', 'steer'],
    ['agent.followUp', 'followUp'],
    ['agent.nextTurn', 'nextTurn']
  ])('CH-5 %s 转 (sessionId, text)，回 {success:true}，在上下文里', async (path, method) => {
    const result = await call(path, [{ sessionId: OWNED, text: 'more', extra: 1 }])
    expect(result).toStrictEqual({ success: true })
    expect(mocks.gateway[method].mock.calls).toEqual([[OWNED, 'more']])
    expect(mocks.calls[0].ctx).toEqual(CHROME_CTX(OWNED))
  })

  const RESPONSE = { kind: 'ask', allowed: true }
  const respond = (requestId = 'req-1'): Promise<unknown> =>
    call('agent.respondToInput', [{ sessionId: OWNED, requestId, response: RESPONSE }])

  it('CH-5 respondToInput：本会话的运行时认领 → 只送给它，不广播，回 {success:true}', async () => {
    const agent = agentWith(true)
    mocks.getAgentSession.mockReturnValue(agent)
    expect(await respond()).toStrictEqual({ success: true })
    expect(mocks.getAgentSession.mock.calls).toEqual([[OWNED]])
    expect(agent.respondToInput.mock.calls).toEqual([['req-1', RESPONSE]])
    expect(mocks.broadcast).not.toHaveBeenCalled()
    expect(mocks.gateway.respondToInput).not.toHaveBeenCalled()
    expect(mocks.runInContext.mock.calls[0][0]).toEqual(CHROME_CTX(OWNED))
  })

  it('CH-5 respondToInput：运行时不认领（请求已取消）→ 广播 input_request_resolved 收走卡片', async () => {
    mocks.getAgentSession.mockReturnValue(agentWith(false))
    expect(await respond('req-gone')).toStrictEqual({ success: true })
    expect(mocks.broadcast.mock.calls).toEqual([
      [{ type: 'input_request_resolved', sessionId: OWNED, requestId: 'req-gone' }]
    ])
  })

  it('CH-5 respondToInput：会话此刻没有运行时 → 同样广播 resolved', async () => {
    mocks.getAgentSession.mockReturnValue(undefined)
    expect(await respond('req-x')).toStrictEqual({ success: true })
    expect(mocks.broadcast.mock.calls).toEqual([
      [{ type: 'input_request_resolved', sessionId: OWNED, requestId: 'req-x' }]
    ])
    expect(mocks.gateway.respondToInput).not.toHaveBeenCalled()
  })
})

describe('CH-9 respondToInput 拿着别的会话的 requestId 也送不到那条会话', () => {
  it('CH-9 只问本会话的运行时；另一条会话的运行时一次都没被碰', async () => {
    const mine = agentWith(false)
    const theirs = agentWith(true)
    mocks.getAgentSession.mockImplementation((sid: string) =>
      sid === OWNED ? mine : sid === DESKTOP ? theirs : undefined
    )
    // 桌面会话里一张挂着的询问卡：它的 requestId 就是那次工具调用的 id
    await call('agent.respondToInput', [
      {
        sessionId: OWNED,
        requestId: 'desktop-tool-call-9',
        response: { kind: 'ask', allowed: true }
      }
    ])
    expect(mocks.getAgentSession.mock.calls.every(([sid]) => sid === OWNED)).toBe(true)
    expect(theirs.respondToInput).not.toHaveBeenCalled()
    expect(mocks.gateway.respondToInput).not.toHaveBeenCalled()
    // 本会话没有这个请求 → 只在本会话里收走这张（并不存在的）卡
    expect(mocks.broadcast.mock.calls).toEqual([
      [{ type: 'input_request_resolved', sessionId: OWNED, requestId: 'desktop-tool-call-9' }]
    ])
  })
})

describe('CH-6 读类调用落到对应的服务', () => {
  it('CH-6 session.getById → sessionService.getById；找不到回 null', async () => {
    expect(await call('session.getById', [OWNED])).toEqual({ id: OWNED, title: 'Chrome · Page' })
    expect(mocks.getById).toHaveBeenCalledWith(OWNED)
    mocks.getById.mockReturnValue(undefined)
    expect(await call('session.getById', [OWNED])).toBeNull()
  })

  it('CH-6 message.list → chatGateway.listMessages，在上下文里', async () => {
    expect(await call('message.list', [OWNED])).toEqual([{ id: 'm1' }])
    expect(mocks.gateway.listMessages.mock.calls).toEqual([[OWNED]])
    expect(mocks.calls[0].ctx).toEqual(CHROME_CTX(OWNED))
  })

  it('CH-6 runtime.statuses → chatGateway.getRuntimeStatuses', async () => {
    expect(await call('runtime.statuses', [OWNED])).toEqual([{ id: 'rt1' }])
    expect(mocks.gateway.getRuntimeStatuses.mock.calls).toEqual([[OWNED]])
  })

  it('CH-6 bgTask.list({sessionId}) → taskRegistry.list(sessionId)', async () => {
    expect(await call('bgTask.list', [{ sessionId: OWNED }])).toEqual([{ id: 'task-1' }])
    expect(mocks.taskList.mock.calls).toEqual([[OWNED]])
  })

  it('CH-6 tools.list(sessionId) → chatGateway.listTools(sessionId)', async () => {
    expect(await call('tools.list', [OWNED])).toEqual([{ name: 'mcp:chrome' }])
    expect(mocks.gateway.listTools.mock.calls).toEqual([[OWNED]])
  })
})

describe('CH-7 tools.presentations / tools.definitions 不带会话、不核对归属', () => {
  it('CH-7 回注册表的结果；没握手的连接也行，不查库', async () => {
    const unready = { ...makeConn(), info: undefined }
    expect(await call('tools.presentations', [], unready)).toEqual({ read: { icon: 'file' } })
    expect(await call('tools.definitions', undefined, unready)).toEqual([{ name: 'read' }])
    expect(mocks.pickSettings).not.toHaveBeenCalled()
  })
})

describe('CH-8 shuvixMd.validate', () => {
  const AGENT_MD = '---\nshuvix: agent v1\nname: helper\ndescription: helps\n---\n\nbody\n'

  it('CH-8 结果等于 validateShuvixMdText(type, text, name)', async () => {
    const result = await call('shuvixMd.validate', [
      { type: 'agent', text: AGENT_MD, name: 'h.md' }
    ])
    expect(vi.mocked(validateShuvixMdText).mock.calls).toEqual([['agent', AGENT_MD, 'h.md']])
    expect(result).toEqual(vi.mocked(validateShuvixMdText).mock.results[0].value)
    expect((result as { status: string }).status).toBe('valid')
  })

  it('CH-8 name 不是字符串 → 按没给传 undefined', async () => {
    await call('shuvixMd.validate', [{ type: 'agent', text: AGENT_MD, name: 42 }])
    expect(vi.mocked(validateShuvixMdText).mock.calls).toEqual([['agent', AGENT_MD, undefined]])
  })

  it.each([
    ['缺 type', [{ text: AGENT_MD }]],
    ['缺 text', [{ type: 'agent' }]],
    ['type 不是字符串', [{ type: 1, text: AGENT_MD }]],
    ['没有参数', []]
  ])('CH-8 %s → 拒绝', async (_label, args) => {
    await expect(call('shuvixMd.validate', args)).rejects.toThrow(
      'shuvixMd.validate needs { type, text }.'
    )
    expect(validateShuvixMdText).not.toHaveBeenCalled()
  })
})

// ─── agent.prompt：用户指着的标签页 → 站点授权 ─────────────────────────────

describe('CH-G agent.prompt 先把带上的标签页所在的站点记为已同意，再开跑', () => {
  const prompt = (inlineTokens: unknown, c: FakeConn = conn): Promise<unknown> =>
    call('agent.prompt', [{ sessionId: OWNED, text: 'look', inlineTokens }], c)

  it('CH-G1 每个标签页现问一次 Chrome（5 秒超时），站点记到本会话，全在 prompt 之前', async () => {
    conn = makeConn({
      5: { id: 5, url: 'https://Mail.Example./inbox?x=1', title: 'Inbox' },
      7: { id: 7, url: 'https://b.example/p', title: 'B' }
    })
    await prompt({ a: tabToken(5), b: tabToken(7) })
    expect(conn.request.mock.calls).toEqual([
      ['tabs.get', { tabId: 5 }, { timeoutMs: 5000 }],
      ['tabs.get', { tabId: 7 }, { timeoutMs: 5000 }]
    ])
    // 站点按 browserSiteOf 归一（小写、去结尾的点、不含路径）
    expect(mocks.grantSite.mock.calls).toEqual([
      [OWNED, 'mail.example'],
      [OWNED, 'b.example']
    ])
    const promptAt = mocks.timeline.indexOf('prompt')
    expect(promptAt).toBeGreaterThan(-1)
    for (const entry of mocks.timeline.filter((e) => e.startsWith('grant:'))) {
      expect(mocks.timeline.indexOf(entry)).toBeLessThan(promptAt)
    }
  })

  it('CH-G2 正在导航的标签页按导航目标（pendingUrl）算；pendingUrl 为空才用 url', async () => {
    conn = makeConn({
      5: { id: 5, url: 'https://old.example/', pendingUrl: 'https://new.example/' },
      6: { id: 6, url: 'https://kept.example/', pendingUrl: '' }
    })
    await prompt({ a: tabToken(5), b: tabToken(6) })
    expect(mocks.grantSite.mock.calls).toEqual([
      [OWNED, 'new.example'],
      [OWNED, 'kept.example']
    ])
  })

  it('CH-G3 问不到（标签页关了 / 超时）→ 跳过这一个，其余照记，消息照发', async () => {
    conn = makeConn({
      5: new Error('Chrome did not answer "tabs.get" within 5s.'),
      7: { id: 7, url: 'https://b.example/' }
    })
    expect(await prompt({ a: tabToken(5), b: tabToken(7) })).toStrictEqual({ success: true })
    expect(mocks.grantSite.mock.calls).toEqual([[OWNED, 'b.example']])
    expect(mocks.gateway.prompt).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['标签页不存在（null）', null],
    ['about:blank', { id: 5, url: 'about:blank' }],
    ['chrome:// 页', { id: 5, url: 'chrome://settings/' }],
    ['本地文件', { id: 5, url: 'file:///Users/u/a.html' }],
    ['data: 地址', { id: 5, url: 'data:text/html,hi' }],
    ['地址为空', { id: 5, url: '' }]
  ])('CH-G4 %s → 没有站点，不记', async (_label, tab) => {
    conn = makeConn({ 5: tab })
    await prompt({ a: tabToken(5) })
    expect(conn.request).toHaveBeenCalledTimes(1)
    expect(mocks.grantSite).not.toHaveBeenCalled()
    expect(mocks.gateway.prompt).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['没有 token', undefined],
    ['空 token 表', {}],
    ['只有 @ 引用与斜杠命令', { a: { type: 'at', id: 'x', displayText: 'x', payload: 'p' } }],
    [
      '类型是 tab 但 id 不是 chrome-tab:<数字>',
      {
        a: tabToken(5, { id: 'chrome-tab:abc' }),
        b: tabToken(5, { id: 'tab:5' }),
        c: tabToken(5, { id: 'chrome-tab:-1' })
      }
    ],
    ['id 对但类型不是 tab', { a: tabToken(5, { type: 'at' }) }]
  ])('CH-G5 %s → 不问 Chrome、不记站点', async (_label, tokens) => {
    conn = makeConn({ 5: { id: 5, url: 'https://a.example/' } })
    await prompt(tokens)
    expect(conn.request).not.toHaveBeenCalled()
    expect(mocks.grantSite).not.toHaveBeenCalled()
    expect(mocks.gateway.prompt).toHaveBeenCalledTimes(1)
  })

  it('CH-G6 查询没回来之前不开跑', async () => {
    let answer!: (tab: unknown) => void
    conn = makeConn()
    conn.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const pending = prompt({ a: tabToken(5) })
    await vi.waitFor(() => expect(conn.request).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(mocks.gateway.prompt).not.toHaveBeenCalled()
    answer({ id: 5, url: 'https://a.example/' })
    await pending
    expect(mocks.timeline).toEqual([`grant:${OWNED}:a.example`, 'prompt'])
  })

  it('CH-G7 同一个标签页带了两次 → 只问一次', async () => {
    conn = makeConn({ 5: { id: 5, url: 'https://a.example/' } })
    await prompt({ a: tabToken(5), b: tabToken(5, { displayText: 'again' }) })
    expect(conn.request).toHaveBeenCalledTimes(1)
    expect(mocks.grantSite.mock.calls).toEqual([[OWNED, 'a.example']])
  })

  it.each(['agent.steer', 'agent.followUp', 'agent.nextTurn'])(
    'CH-G8 %s 不记任何站点（只有 agent.prompt 授权），哪怕参数里夹着 tab token',
    async (path) => {
      conn = makeConn({ 5: { id: 5, url: 'https://a.example/' } })
      await call(path, [{ sessionId: OWNED, text: 'x', inlineTokens: { a: tabToken(5) } }])
      expect(conn.request).not.toHaveBeenCalled()
      expect(mocks.grantSite).not.toHaveBeenCalled()
    }
  )
})
