/**
 * sessionService 作为 broker 参与方 —— 有根会话那一半的询问路由（M7′）。
 *
 * 这份参与方只有三行代码，但它把两条容易写反的判断钉在了一起：
 *
 *   - **`claims` 问的是「此刻有没有活着的运行时」，不是「这条会话记录存不存在」。**
 *     询问要送到的是内存里那个 AgentSession 的 pendingInputs；会话行躺在库里而运行时
 *     没建（或刚被失效），就没有可送达的地方 —— 认领了反而把询问吞进黑洞；
 *   - **`respond` 遍历所有活运行时，而不是拿 sessionId 索引。** requestId 才是全局唯一的
 *     那个，调用方（IPC）手上的 sessionId 只是它以为的那个；用它选会话等于把前端的判断
 *     当成真相。派生 agent 的询问带根会话 id 进来、答复只带 requestId 出去，两个方向
 *     本来就不必落在同一把钥匙上。
 *
 * 还顺带钉住 M7′ 的互斥前提：**聊天会话恒无根 Agent**。守在 `SessionManager.create` 那一处，
 * `agents` 表里就永远不会有它的条目，于是这份参与方对聊天会话恒不认领 —— botService 那份
 * 才接得住。这个不变量一破，两份参与方会同时认领同一条会话，先注册的赢，而「先注册」
 * 取决于模块加载顺序。
 *
 * mock 面沿用 sessionServiceBotSession，但**删掉了 `vi.mock('../userInputBroker')`** ——
 * 要让 sessionService 模块加载时的注册真的落进注册表，否则测的只是一个空壳。
 * botService 在这里是假件（从未加载），所以注册表里干干净净只有 session 一个。
 * 也**不调** `resetUserInputParticipantsForTests()`：那会把被测对象自己摘掉。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { AgentSession } from '../agentSession'

const mocks = vi.hoisted(() => ({
  daoPick: vi.fn(),
  daoPickSettings: vi.fn(),
  daoUpdateSettings: vi.fn(),
  daoInsert: vi.fn(),
  getProfile: vi.fn(),
  readSessionRunConfig: vi.fn(),
  findModelsByProvider: vi.fn(() => []),
  findByKey: vi.fn(() => undefined),
  agentCreate: vi.fn(),
  warn: vi.fn()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    updateSettings: mocks.daoUpdateSettings,
    insert: mocks.daoInsert
  }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: {} }))
vi.mock('../../dao/providerDao', () => ({
  providerDao: { findModelsByProvider: mocks.findModelsByProvider }
}))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: vi.fn() } }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: mocks.findByKey } }))
vi.mock('../messageService', () => ({ messageService: {} }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: mocks.readSessionRunConfig,
  addSessionTreePin: vi.fn(),
  appendModelChange: vi.fn(),
  appendActiveToolsChange: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: (sid: string) => `/tmp/${sid}`,
  getToolResultsBase: vi.fn()
}))
vi.mock('../toolAggregator', () => ({
  getDefaultEnabledTools: vi.fn(() => []),
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../botService', () => ({
  botService: {
    abortSession: vi.fn(async () => {}),
    forgetNotesSession: vi.fn(),
    seedGreetings: vi.fn(async () => {}),
    isActive: vi.fn(() => false)
  }
}))
vi.mock('../agentService', () => ({ agentService: { getProfile: mocks.getProfile } }))
vi.mock('../agentSession', () => ({ AgentSession: { create: mocks.agentCreate } }))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
}))

import { requestUserInputFor, respondToUserInput } from '../userInputBroker'

let sessionService: (typeof import('../sessionService'))['sessionService']
let realGetAgentSession: (sessionId: string) => AgentSession | undefined
let getAgentSpy: ReturnType<typeof vi.spyOn>
let liveSpy: ReturnType<typeof vi.spyOn>

const REQ: InputRequest = {
  id: 'req-1',
  kind: 'ask',
  toolName: 'bash',
  createdAt: 0,
  command: 'ls'
}
const ANSWER: InputResponse = { kind: 'ask', allowed: true }

/** 一个假的 AgentSession —— 参与方只碰它的两个方法 */
function fakeAgent(
  name: string,
  opts: { respond?: boolean } = {}
): {
  name: string
  requestUserInput: ReturnType<typeof vi.fn>
  respondToInput: ReturnType<typeof vi.fn>
} {
  return {
    name,
    requestUserInput: vi.fn(async () => ANSWER),
    respondToInput: vi.fn(() => opts.respond ?? false)
  }
}

type Fake = ReturnType<typeof fakeAgent>

/** 注入「此刻活着的运行时」集合 */
function live(...agents: Fake[]): void {
  liveSpy.mockReturnValue(agents as unknown as Iterable<AgentSession>)
}

/** 注入「某会话此刻的运行时」 */
function bound(agent: Fake | undefined): void {
  getAgentSpy.mockReturnValue(agent as unknown as AgentSession | undefined)
}

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  // 先留一份真身：C-2 要用它验「聊天会话根本没被登记进 agents」，而其余用例都靠打桩
  realGetAgentSession = sessionService.getAgentSession.bind(sessionService)
  getAgentSpy = vi.spyOn(sessionService, 'getAgentSession')
  liveSpy = vi.spyOn(sessionService, 'liveAgentSessions')
})

let seq = 0
let SID = ''

beforeEach(() => {
  seq += 1
  SID = `s-${seq}`
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.findModelsByProvider.mockReturnValue([])
  mocks.findByKey.mockReturnValue(undefined)
  mocks.readSessionRunConfig.mockResolvedValue({})
  // 会话行存在（普通会话）—— 各例只改自己关心的那一格
  mocks.daoPick.mockReturnValue({ projectId: null })
  mocks.daoPickSettings.mockReturnValue({})
  bound(undefined)
  live()
})

describe('claims —— 认领的是运行时，不是会话记录', () => {
  it('会话行在库里但运行时没建 → 不认领（reject），运行时建好后才认领', async () => {
    // 「会话存在」与「此刻能收询问」是两件事：懒创建意味着一条从没发过消息的会话
    // 完全可能有记录而无运行时。认领了却送不出去，工具就得挂在一个没人管的 Promise 上
    await expect(requestUserInputFor(SID, REQ)).rejects.toThrow(`Session ${SID} is not active`)

    const agent = fakeAgent('a')
    bound(agent)
    await expect(requestUserInputFor(SID, REQ)).resolves.toEqual(ANSWER)
    expect(agent.requestUserInput).toHaveBeenCalledTimes(1)
  })

  it('聊天会话恒无根 Agent —— ensure 不建，也不留条目在 agents 表里', async () => {
    getAgentSpy.mockImplementation(realGetAgentSession)
    const chat = `${SID}-chat`
    const rooted = `${SID}-rooted`
    const agent = fakeAgent('rooted')
    mocks.agentCreate.mockResolvedValue(agent)

    // 聊天会话：resolveAgentProfileName 返回 null，create 早退
    mocks.daoPickSettings.mockReturnValue({ bots: ['scout'] })
    expect(await sessionService.ensureAgentSession(chat)).toBeUndefined()
    expect(sessionService.getAgentSession(chat)).toBeUndefined()
    expect(mocks.agentCreate).not.toHaveBeenCalled()

    // 对照组：同一套上下文解析，普通会话建得出来也登记得进去 —— 上面那条早退
    // 因此是「因为它是聊天会话」，不是「因为上下文解析失败」
    mocks.daoPickSettings.mockReturnValue({})
    expect(await sessionService.ensureAgentSession(rooted)).toBe(agent)
    expect(sessionService.getAgentSession(rooted)).toBe(agent)

    // 这才是 M7′ 的互斥前提：agents 表里没有聊天会话的条目 ⇒ 这份参与方对它恒不认领，
    // botService 那份才接得住。两份同时认领的话，谁赢取决于模块加载顺序
    await expect(requestUserInputFor(chat, REQ)).rejects.toThrow(`Session ${chat} is not active`)
  })

  it('claims 与 request 之间运行时被失效 → reject，不往空处投递', async () => {
    // 切档案 / 回退 / 清空都会在这两步之间把运行时摘掉。第二次查是必需的：
    // 少了它就会对着 undefined 调 requestUserInput，工具收到的是 TypeError 而不是
    // 一句能读懂的「会话不活跃」
    const agent = fakeAgent('a')
    getAgentSpy.mockReturnValueOnce(agent as unknown as AgentSession)

    await expect(requestUserInputFor(SID, REQ)).rejects.toThrow(`Session ${SID} is not active`)
    expect(agent.requestUserInput).not.toHaveBeenCalled()
  })

  it('只把 request 交给运行时（不把 sessionId 也递过去）', async () => {
    const agent = fakeAgent('a')
    bound(agent)

    await requestUserInputFor(SID, REQ)
    // 运行时早就知道自己是谁；再递一个 sessionId 过去，等于给它一个机会去质疑
    // 自己的身份 —— 而那个值恰恰是调用方以为的那个
    expect(agent.requestUserInput).toHaveBeenCalledWith(REQ)
    expect(agent.requestUserInput.mock.calls[0]).toHaveLength(1)
  })
})

describe('respond —— 按 requestId 遍历活运行时', () => {
  it('第一个认下的短路，后面的不再被问', () => {
    const a = fakeAgent('a', { respond: false })
    const b = fakeAgent('b', { respond: true })
    const c = fakeAgent('c', { respond: true })
    live(a, b, c)

    expect(respondToUserInput('req-1', ANSWER)).toBe(true)
    expect(a.respondToInput).toHaveBeenCalledTimes(1)
    expect(b.respondToInput).toHaveBeenCalledWith('req-1', ANSWER)
    expect(c.respondToInput).not.toHaveBeenCalled()
  })

  it('不按 sessionId 挑人：认领请求的是 A，持有 requestId 的是 B', () => {
    // 派生 agent 的询问带**根会话 id** 进来，答复只带 requestId 出去 ——
    // 两个方向本来就不必落在同一把钥匙上，遍历才是对的
    const a = fakeAgent('a', { respond: false })
    const b = fakeAgent('b', { respond: true })
    bound(a)
    live(a, b)

    expect(respondToUserInput('req-1', ANSWER)).toBe(true)
    expect(b.respondToInput).toHaveBeenCalledTimes(1)
  })

  it('全员都不认 → false，并留下一行带 requestId 的 warn', () => {
    live(fakeAgent('a'), fakeAgent('b'))
    mocks.warn.mockClear()

    // 请求早被取消（中止 / 会话拆了）而前端那张卡片还在。日志是把「点了没反应」
    // 变成一句话查得清的事的唯一线索
    expect(respondToUserInput('req-gone', ANSWER)).toBe(false)
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    expect(String(mocks.warn.mock.calls[0][0])).toContain('req-gone')
  })

  it('一个运行时都没活着 → false，不抛', () => {
    live()
    expect(() => respondToUserInput('req-1', ANSWER)).not.toThrow()
    expect(respondToUserInput('req-1', ANSWER)).toBe(false)
  })
})
