/**
 * botService 的询问生命周期（M7′）—— 聊天会话没有根运行时，这份状态得自己养。
 *
 * 有根会话里「在飞的询问」住在 `HarnessSession.pendingInputs`，跟着 harness 的中止/结束
 * 一起收口。聊天会话没有那个运行时：询问由派生的任务段 agent 发出，带着**根会话 id**
 * 走 broker 到这里，于是挂起、送达、取消三件事全部要在 botService 里重做一遍 ——
 * 而且要跟有根路径逐条对齐，否则同一个 `ask` 工具在两种会话里会有两种脾气。
 *
 * 这一层钉三组不变量：
 *   1. **没有输入面板就立刻取消**，不是挂起 —— 一个永远等不到答复的 Promise 会把任务段的
 *      墙钟耗光，而用户那边压根没看见问题；
 *   2. **中止一定要广播 `input_request_resolved`** —— 前端待答卡只认这一个事件，而聊天
 *      会话本来就永不发 `agent_end`，少了它卡片会永远挂在那里；
 *   3. **中止是「关门」不是「清一次」**：`blockWrites` 出了 finally 就没了，而工具可能
 *      在整个 abortSession 落定之后才发出询问。门由 `inputsClosed` 把住，下一条用户消息
 *      重新开门。
 *
 * mock 面沿用 botServiceMessages 那套（真 sessionStorage + 临时目录，广播是 spy），
 * 另补两件 M7′ 才需要的：`ChatFrontendRegistry.hasCapability`（输入面板在不在）与
 * `sessionService.isBotSession`（broker 参与方的 claims 判据）。
 *
 * ⚠️ **刻意不 mock `../userInputBroker`**：botService 的参与方是模块加载的副作用，要让
 * 它真的落进注册表，末尾那组「经 broker」的用例才算数。也**不调**
 * `resetUserInputParticipantsForTests()` —— 那会把被测对象自己从路由表上摘掉。
 * sessionService 在这里是假件，所以它那份参与方从未注册，注册表里干干净净只有 bot 一个。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-botinput-${process.pid}`
  return { base, sessions: `${base}/sessions`, bots: `${base}/bots` }
})
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ started: false, reason: 'not-found' })),
  broadcast: vi.fn(),
  getById: vi.fn(),
  isBotSession: vi.fn(() => true),
  hasCapability: vi.fn(() => true)
}))

vi.mock('../workflowService', () => ({
  workflowService: {
    invoke: mocks.invoke,
    abortSessionRuns: vi.fn(() => 0),
    hasWorkflow: vi.fn(() => true),
    // 槽位表来自管线的输入 schema —— 这一组不看槽位，空表即可
    agentSlots: vi.fn(() => []),
    registerRunJournalSink: vi.fn()
  },
  workflowTriggers: { fire: vi.fn() }
}))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
// v2：聊天会话转写在 chat_messages 表里。真 DAO 一经导入就会打开 sqlite
// （DatabaseManager 构造即开库，而原生绑定是 Electron ABI 的），故整个替换成内存版
vi.mock('../../dao/chatMessageDao', async () => await import('./fakeChatMessageDao'))
vi.mock('../../utils/paths', () => ({
  // v2 起 botService 经 chatMessageDao 触到 DatabaseManager，它的构造读 getDataDir
  getDataDir: () => `${dirs.base}/data`,
  getChatAttachmentsDir: (sid: string) => `${dirs.base}/data/chat-attachments/${sid}`,
  getSessionsDir: () => dirs.sessions,
  getDefaultBotsDir: () => dirs.bots,
  // botService → agentService 的模块作用域构造器在 import 阶段就要它
  getDefaultAgentsDir: () => `${dirs.base}/agents`
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../agentRuntimeAdapters', () => ({
  electronEventSink: { broadcast: mocks.broadcast }
}))
// 会话域埋点的事实构造器会拉进 sessionDao / messageService / i18n —— 这些用例不测埋点，
// 桩掉比给 paths mock 补一串无关导出干净
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(async () => null),
  isDefaultTitle: vi.fn(() => false)
}))
vi.mock('../sessionService', () => ({
  sessionService: { getById: mocks.getById, isBotSession: mocks.isBotSession }
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { hasCapability: mocks.hasCapability, broadcast: vi.fn() }
}))

import { botService } from '../botService'
import { requestUserInputFor, respondToUserInput } from '../userInputBroker'
import { clearSessionTreeCacheForTests } from '../sessionStorage'
import { __reset as resetRows } from './fakeChatMessageDao'

/**
 * **每条用例一套全新的 id**。botService 是模块级单例，而 `inputsClosed` 按设计是 sticky 的
 * （只有下一条用户消息能开门）—— 复用同一个 sessionId 就会把上一条用例关上的门带进下一条，
 * 于是后面每一条询问都走立刻取消。`pendingInputs` 同理跨用例共存，requestId 也一并隔离。
 */
let seq = 0
let SID = ''
let OTHER = ''

/** 本例专属的 requestId */
const rid = (suffix: string): string => `${SID}/${suffix}`

/** 一条最小可用的 ask 询问 */
function req(suffix: string): InputRequest {
  return { id: rid(suffix), kind: 'ask', toolName: 'bash', createdAt: 0, command: 'ls' }
}

const ALLOW: InputResponse = { kind: 'ask', allowed: true }
const CANCELLED: InputResponse = { kind: 'cancel', reason: 'aborted' }

/** 广播出去的 ChatEvent（按 type 过滤） */
function broadcasts(type?: string): Array<Record<string, unknown>> {
  return mocks.broadcast.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => !type || e.type === type)
}

/**
 * 「此刻还没落定」的哨兵。
 *
 * 挂起是这一层的核心语义，而「Promise 没 resolve」没法直接断言 —— 只能给它一个明确的
 * 时间窗再看。落定了就返回那个值，没落定返回 PENDING。
 */
const PENDING = Symbol('pending')
function peek<T>(p: Promise<T>): Promise<T | typeof PENDING> {
  return Promise.race([p, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), 20))])
}

/**
 * 一份最小可用的 bot 定义 —— 只为让派发找得到它，好让管线真的飞起来。
 * 管线绑定块（`workflow` 必填、没有缺省）是「最小」的一部分：缺了它文件整份非法，成员就不在册。
 */
function writeBot(
  name: string,
  opts: { pipeline?: string; agents?: Record<string, string> } = {}
): void {
  mkdirSync(dirs.bots, { recursive: true })
  const lines = ['---', 'shuvix: bot v1', `name: ${name}`, `description: unit bot`]
  lines.push('shuvix-bot-pipeline:', `  workflow: ${opts.pipeline ?? 'bot-chat'}`)
  if (opts.agents) {
    lines.push('  agents:')
    for (const [k, v] of Object.entries(opts.agents)) lines.push(`    ${k}: ${v}`)
  }
  lines.push('---', '', 'BODY.')
  writeFileSync(join(dirs.bots, `${name}.md`), lines.join('\n'))
}

/**
 * 造一个「run 还在飞」的确定性窗口：卡住管线的 invoke。
 *
 * v1 这里是拿住会话树的写锁 —— v2 的写者是一次同步事务，锁根本卡不住 `handleUserMessage`，
 * 而 `abortSession` 等的也从来不是那把锁，是 `whenIdle`（在飞管线计数）。所以窗口的
 * 支点跟着挪到管线本身
 */
function holdInflight(): { release: () => void; inflight: Promise<unknown> } {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  mocks.invoke.mockImplementation(async () => {
    await gate
    return { started: false, reason: 'not-found' }
  })
  writeBot('scout')
  const inflight = botService.handleUserMessage({ sessionId: SID, text: '你好' })
  return { release, inflight }
}

beforeEach(() => {
  seq += 1
  SID = `bot-sess-${seq}`
  OTHER = `other-sess-${seq}`
  rmSync(dirs.base, { recursive: true, force: true })
  mkdirSync(dirs.sessions, { recursive: true })
  mkdirSync(dirs.bots, { recursive: true })
  clearSessionTreeCacheForTests()
  resetRows()
  mocks.invoke.mockReset()
  mocks.invoke.mockResolvedValue({ started: false, reason: 'not-found' })
  mocks.broadcast.mockReset()
  mocks.getById.mockReset()
  mocks.getById.mockReturnValue({ workingDirectory: dirs.sessions, settings: { bot: 'scout' } })
  mocks.isBotSession.mockReset()
  mocks.isBotSession.mockReturnValue(true)
  mocks.hasCapability.mockReset()
  mocks.hasCapability.mockReturnValue(true)
})

afterAll(() => {
  rmSync(dirs.base, { recursive: true, force: true })
})

describe('requestUserInput —— 挂起还是立刻取消', () => {
  it('没有输入面板 → 立刻取消，一个字都不广播', async () => {
    mocks.hasCapability.mockReturnValue(false)

    // 与 HarnessSession.requestUserInput 同一判据：挂起一个没人看得见的询问，
    // 只会让任务段把墙钟烧光，而用户那边什么都没发生
    await expect(botService.requestUserInput(SID, req('r1'))).resolves.toEqual(CANCELLED)
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('早退的请求不进 pendingInputs（事后答它是「不认识」）', async () => {
    mocks.hasCapability.mockReturnValue(false)
    await botService.requestUserInput(SID, req('r1'))

    // 登记了却已经落定的记录，会在中止时再 resolve 一次并多播一条 resolved
    expect(botService.respondToInput(rid('r1'), ALLOW)).toBe(false)
  })

  it('有输入面板 → 挂起，并广播恰好一条 input_request（request 原件）', async () => {
    const request = req('r1')
    const pending = botService.requestUserInput(SID, request)

    expect(await peek(pending)).toBe(PENDING)
    const sent = broadcasts('input_request')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ sessionId: SID })
    expect(sent[0].request).toBe(request)

    await botService.abortSession(SID)
    await pending
  })

  it('abortSession 进行中（在飞管线没排空）发起的询问 → 立刻取消、不广播', async () => {
    const held = holdInflight()
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalled())
    const aborting = botService.abortSession(SID)
    expect(await peek(aborting)).toBe(PENDING)

    await expect(botService.requestUserInput(SID, req('r1'))).resolves.toEqual(CANCELLED)
    expect(broadcasts('input_request')).toHaveLength(0)

    held.release()
    await held.inflight
    await aborting
  })

  it('同会话两条在飞互不干扰', async () => {
    const a = botService.requestUserInput(SID, req('r1'))
    const b = botService.requestUserInput(SID, req('r2'))

    expect(botService.respondToInput(rid('r1'), ALLOW)).toBe(true)
    await expect(a).resolves.toEqual(ALLOW)
    // 答一条不该把另一条也收掉：pendingInputs 的键是 requestId 不是 sessionId
    expect(await peek(b)).toBe(PENDING)

    await botService.abortSession(SID)
    await b
  })
})

describe('respondToInput —— 答复送达', () => {
  it('送达并逐字段落定，返回 true', async () => {
    const pending = botService.requestUserInput(SID, req('r1'))
    const response: InputResponse = {
      kind: 'ask',
      allowed: true,
      reason: 'user said yes',
      extra: { rememberPath: true }
    }

    expect(botService.respondToInput(rid('r1'), response)).toBe(true)
    // extra 是工具自定义副作用的唯一载体，中途重建对象就会把它丢掉
    await expect(pending).resolves.toEqual(response)
  })

  it('resolved 的 sessionId 取自 pending 记录（调用方根本不传）', async () => {
    const pending = botService.requestUserInput(SID, req('r1'))
    botService.respondToInput(rid('r1'), ALLOW)
    await pending

    // 签名只有 (requestId, response) —— 归属是登记时就定下的事实，
    // 不是答复时由调用方补充的猜测
    expect(botService.respondToInput.length).toBe(2)
    expect(broadcasts('input_request_resolved')).toEqual([
      { type: 'input_request_resolved', sessionId: SID, requestId: rid('r1') }
    ])
  })

  it('未知 requestId → false，不广播', () => {
    expect(botService.respondToInput(rid('never-asked'), ALLOW)).toBe(false)
    expect(broadcasts('input_request_resolved')).toHaveLength(0)
  })

  it('同一条答两次：第一次赢，第二次是 false，resolved 只播一条', async () => {
    const pending = botService.requestUserInput(SID, req('r1'))

    expect(botService.respondToInput(rid('r1'), { kind: 'ask', allowed: true })).toBe(true)
    expect(botService.respondToInput(rid('r1'), { kind: 'ask', allowed: false })).toBe(false)

    // 「取走即删」：不然用户双击一下按钮，前端就会收到两条 resolved 去撤同一张卡片
    await expect(pending).resolves.toEqual({ kind: 'ask', allowed: true })
    expect(broadcasts('input_request_resolved')).toHaveLength(1)
  })

  it('中止之后到达的答复 → false，不广播', async () => {
    const pending = botService.requestUserInput(SID, req('r1'))
    await botService.abortSession(SID)
    await pending
    mocks.broadcast.mockClear()

    // 用户在停止之后才点下按钮：那条询问早已 cancel 落定，再 resolve 一次就是双重落定
    expect(botService.respondToInput(rid('r1'), ALLOW)).toBe(false)
    expect(broadcasts('input_request_resolved')).toHaveLength(0)
  })
})

describe('abortSession —— 在飞询问的收口', () => {
  it('在飞的询问以 cancel 落定', async () => {
    const pending = botService.requestUserInput(SID, req('r1'))
    await botService.abortSession(SID)
    await expect(pending).resolves.toEqual(CANCELLED)
  })

  it('必须广播 input_request_resolved（前端待答卡只认这一个事件）', async () => {
    const pending = botService.requestUserInput(SID, req('r1'))
    mocks.broadcast.mockClear()
    await botService.abortSession(SID)
    await pending

    // 聊天会话永不发 agent_end，没有第二个事件能替它收卡片
    expect(broadcasts('input_request_resolved')).toEqual([
      { type: 'input_request_resolved', sessionId: SID, requestId: rid('r1') }
    ])
  })

  it('多条在飞一条不落（按 requestId 集合断言，不看顺序）', async () => {
    const all = ['r1', 'r2', 'r3'].map((id) => botService.requestUserInput(SID, req(id)))
    await botService.abortSession(SID)

    expect(await Promise.all(all)).toEqual([CANCELLED, CANCELLED, CANCELLED])
    expect(
      broadcasts('input_request_resolved')
        .map((e) => e.requestId)
        .sort()
    ).toEqual([rid('r1'), rid('r2'), rid('r3')].sort())
  })

  it('跨会话不误伤：停 A 之后 B 的询问照常挂着，也照常答得进去', async () => {
    const a = botService.requestUserInput(SID, req('r1'))
    const b = botService.requestUserInput(OTHER, req('r2'))

    await botService.abortSession(SID)
    await expect(a).resolves.toEqual(CANCELLED)
    // 停止按钮是会话级的：另一条会话的待答卡不该跟着一起消失
    expect(await peek(b)).toBe(PENDING)

    expect(botService.respondToInput(rid('r2'), ALLOW)).toBe(true)
    await expect(b).resolves.toEqual(ALLOW)
  })

  it('无在飞询问时是安全 no-op（不播噪声事件）', async () => {
    await expect(botService.abortSession(SID)).resolves.toBeUndefined()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('中止落定之后**新发起**的询问也立刻取消（门是关着的，不只是清了一次）', async () => {
    await botService.abortSession(SID)
    mocks.broadcast.mockClear()

    // 工具是在自己的收尾里才发出询问的，完全可能晚于整个 abortSession 落定。
    // 只靠 blockWrites（出了 finally 就没了）的话，这条询问会登记进去再没人取消：
    // run 烧到墙钟上限，用户还会在**按下停止之后**看见一张新冒出来的卡片
    await expect(botService.requestUserInput(SID, req('r1'))).resolves.toEqual(CANCELLED)
    expect(broadcasts('input_request')).toHaveLength(0)
  })

  it('下一条用户消息重新开门 —— 中止只该管住那一轮', async () => {
    writeBot('scout')
    await botService.abortSession(SID)
    await botService.handleUserMessage({ sessionId: SID, text: '再来一次' })
    mocks.broadcast.mockClear()

    const pending = botService.requestUserInput(SID, req('r1'))
    expect(await peek(pending)).toBe(PENDING)
    expect(broadcasts('input_request')).toHaveLength(1)

    await botService.abortSession(SID)
    await pending
  })

  it('会话最后一个 run 结束时，遗留的 pending 被取消并广播 resolved', async () => {
    // 询问是被工具 await 着的，run 正常跑着就不可能结束 —— 能走到「在飞计数归零而询问
    // 还挂着」只有一种情况：那个 run 被单独中止或超时掉了（定局时中止未表态成员、引擎
    // 墙钟）。而中止路径拿不到「哪条询问属于哪张票」（询问经 broker 到达时只带会话 id），
    // 所以收口按「会话归零」来，不必伪造那个归属。
    // 这里把管线卡在飞行中，好在归零之前把询问挂上去
    const held = holdInflight()
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalled())
    const pending = botService.requestUserInput(SID, req('r1'))
    expect(await peek(pending)).toBe(PENDING)
    mocks.broadcast.mockClear()

    held.release()
    await held.inflight

    await expect(pending).resolves.toEqual(CANCELLED)
    expect(broadcasts('input_request_resolved')).toEqual([
      { type: 'input_request_resolved', sessionId: SID, requestId: rid('r1') }
    ])
  })
})

/**
 * 经 broker 的那一段 —— **M7′ 的主诉就在这里**。
 *
 * 派生的任务段 agent 自身没有输入面板，它的询问带着聊天会话 id 走 broker；此前 broker 的
 * 单槽 resolver 只认有根会话，于是 bot 管线里的每一次询问都以「Session … is not active」
 * 收场：工具拿到一条错误，用户那边什么都没发生。
 */
describe('作为 broker 参与方', () => {
  it('claims 严格等于 isBotSession —— 有根会话在这里不该被拦下', async () => {
    mocks.isBotSession.mockReturnValue(false)
    const rooted = `rooted-${seq}`

    await expect(requestUserInputFor(rooted, req('r1'))).rejects.toThrow(
      `Session ${rooted} is not active`
    )
    // 认领要**先于**任何自己的判断：抢在 claims 之前查输入面板，等于替有根会话回答了
    // 一个不归自己管的问题（那条会话的面板能力由 HarnessSession 自己看）
    expect(mocks.hasCapability).not.toHaveBeenCalled()
  })

  it('聊天会话的询问经 broker 到达 botService 并挂起（不再是「会话未激活」）', async () => {
    const pending = requestUserInputFor(SID, req('r1'))

    expect(await peek(pending)).toBe(PENDING)
    expect(broadcasts('input_request')).toHaveLength(1)

    await botService.abortSession(SID)
    await pending
  })

  it('答复只凭 requestId 就能落到 botService', async () => {
    const pending = requestUserInputFor(SID, req('r1'))

    expect(respondToUserInput(rid('r1'), ALLOW)).toBe(true)
    await expect(pending).resolves.toEqual(ALLOW)
  })

  it('claims 与 request 之间会话被中止 → 立刻取消、不广播', async () => {
    // 会话删除 / 停止走的是 abortSession，它同步置上 blockWrites 与 inputsClosed；
    // 借 claims 的副作用把这个竞态摆到确定的位置上（这是唯一能把 broker 两个阶段
    // 掰开的地方），断言 request 阶段不会再挂起一条没人管的询问
    let aborting: Promise<void> | undefined
    mocks.isBotSession.mockImplementation(() => {
      aborting ??= botService.abortSession(SID)
      return true
    })

    await expect(requestUserInputFor(SID, req('r1'))).resolves.toEqual(CANCELLED)
    expect(broadcasts('input_request')).toHaveLength(0)
    await aborting
  })
})
