/**
 * botService 的笔记半边（M9′）—— **派一次归纳出去的那条路**。
 *
 * 调度那半边（什么时候值得跑、状态怎么落盘）在 `bot/__tests__/botNotesScheduler.test.ts`，
 * 它用假时钟跑纯算术。这里接着往下走：门槛过了之后，宿主到底**给笔记段看什么材料**、
 * **拿什么形状的信封调管线**、以及**凭什么认定这一轮算跑成了**。
 *
 * 三件事都只在这一层成立 —— 材料要读会话树、信封要拼 bot md 的全部字段、成功判定要看
 * 引擎的返回值。脚本那一侧（笔记场合的分支、提示词、超时）在 botChatTask.test.ts。
 *
 * mock 面沿用 botServiceTriggers 那套，多一个 `messageService`：
 * 材料组装的每条断言都要精确控制「这条会话上有哪些消息、各自什么时刻」，而真会话树
 * 给不了亚毫秒的时序控制 —— 归属会话恰恰是按最后一条消息的时刻挑的。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const dirs = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]+$/, '')
  const base = `${tmp}/shuvix-botnotesvc-${process.pid}`
  return { base, sessions: `${base}/sessions`, bots: `${base}/bots` }
})

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  hasWorkflow: vi.fn(() => true),
  abortSessionRuns: vi.fn(() => 0),
  getById: vi.fn(),
  listBySession: vi.fn(),
  broadcast: vi.fn(),
  warn: vi.fn()
}))

vi.mock('../workflowService', () => ({
  workflowService: {
    invoke: mocks.invoke,
    abortSessionRuns: mocks.abortSessionRuns,
    hasWorkflow: mocks.hasWorkflow,
    registerRunJournalSink: vi.fn()
  },
  workflowTriggers: { fire: vi.fn() }
}))
vi.mock('electron', () => ({ shell: { openPath: vi.fn(async () => '') } }))
vi.mock('../../utils/paths', () => ({
  getSessionsDir: () => dirs.sessions,
  getDefaultBotsDir: () => dirs.bots
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {} })
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../agentRuntimeAdapters', () => ({ electronEventSink: { broadcast: mocks.broadcast } }))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(async () => null),
  isDefaultTitle: vi.fn(() => false)
}))
vi.mock('../sessionService', () => ({
  sessionService: {
    getById: mocks.getById,
    // 改名迁移要走它们（BN-E3）：这些用例里没有会话名单要改，给一对空实现就够
    list: () => [],
    rewriteBots: vi.fn()
  }
}))
// 材料组装的唯一数据源。真树给不了「这两条会话的最后一条消息差 3 秒」这种时序控制，
// 而归属会话正是按那个时刻挑的（D12）
vi.mock('../messageService', () => ({ messageService: { listBySession: mocks.listBySession } }))

import { botService, isNoteWorthy } from '../botService'
import { clearSessionTreeCacheForTests } from '../sessionStorage'

/** 与实现里的 NOTES_MAX_LINES 对齐（该常量未导出） */
const MAX_LINES = 200
/** 与调度器的 NOTES_MIN_EVENTS 对齐 —— 攒够这么多件才跑一次 */
const MIN_EVENTS = 3

/**
 * **每条用例一个新 bot 名**。botService 是模块级单例，笔记调度的状态（攒了几件、上次
 * 什么时候跑的、各会话归纳到哪条）活在它里面，而那份状态只按 bot 名分隔 —— 换个名字
 * 比给生产代码开一个复位后门干净。同一个理由也适用于会话 id。
 */
let seq = 0
let BOT = 'scout-0'
let SID = 'notes-sess-0'

function writeBot(
  name: string,
  opts: {
    displayName?: string
    description?: string
    notesEnabled?: boolean
    notes?: string
    input?: Record<string, string>
    agents?: Record<string, string>
    pipeline?: string
  } = {}
): string {
  mkdirSync(dirs.bots, { recursive: true })
  const lines = [
    '---',
    'shuvix: bot v1',
    `name: ${name}`,
    `description: ${opts.description ?? `unit bot ${name}`}`
  ]
  if (opts.displayName) lines.push(`shuvix-displayName: ${opts.displayName}`)
  if (opts.notesEnabled === false) lines.push('shuvix-bot-notes: false')
  if (opts.pipeline) lines.push(`shuvix-bot-pipeline: ${opts.pipeline}`)
  if (opts.input) {
    lines.push('shuvix-bot-input:')
    for (const [k, v] of Object.entries(opts.input)) lines.push(`  ${k}: ${v}`)
  }
  if (opts.agents) {
    lines.push('shuvix-bot-agents:')
    for (const [k, v] of Object.entries(opts.agents)) lines.push(`  ${k}: ${v}`)
  }
  lines.push('---', '', 'BOT BODY.')
  if (opts.notes !== undefined) lines.push('', '<!-- shuvix:bot-notes -->', '', opts.notes)
  const filePath = join(dirs.bots, `${name}.md`)
  writeFileSync(filePath, lines.join('\n'))
  return filePath
}

/** 会话事实：标题 + 成员名单（按 sid 分发，多会话用例要各有各的标题） */
function seedSessions(map: Record<string, { title: string; bots: string[] }>): void {
  mocks.getById.mockImplementation((sid: string) => {
    const found = map[sid]
    return found
      ? { workingDirectory: dirs.sessions, title: found.title, settings: { bots: found.bots } }
      : null
  })
}

interface FakeMsg {
  id: string
  role: string
  content: string
  createdAt: number
  metadata?: Record<string, unknown> | null
}

/** 一条会话的投影（`messageService.listBySession` 的返回） */
const msg = (id: string, role: string, content: string, at: number, meta?: unknown): FakeMsg => ({
  id,
  role,
  content,
  createdAt: at,
  metadata: (meta as Record<string, unknown>) ?? null
})

/** 各会话的投影表 */
function seedMessages(map: Record<string, FakeMsg[]>): void {
  mocks.listBySession.mockImplementation(async (sid: string) => map[sid] ?? [])
}

/** 管线跑完了，门控正常 */
const ran = (
  output: Record<string, unknown>
): { started: boolean; ok: boolean; output: Record<string, unknown> } => ({
  started: true,
  ok: true,
  output
})

/** 消息场合的结局 —— 缺省「干过一次活」（isNoteWorthy 为真，于是记一件） */
let messageOutcome: Record<string, unknown> = { gate: 'ok', outcome: 'task' }
/** 笔记场合的结局 —— 缺省「归纳成功」 */
let notesResult: Record<string, unknown> = ran({ outcome: 'notes' })

/** 笔记场合的那几次 invoke（按 input.occasion 认） */
function notesInvokes(): Array<Record<string, unknown>> {
  return mocks.invoke.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((req) => (req.input as { occasion?: string } | undefined)?.occasion === 'notes')
}

const notesInput = (i = 0): Record<string, unknown> =>
  notesInvokes()[i].input as Record<string, unknown>

const sinceOf = (i = 0): string[] => (notesInput(i).since as string[]) ?? []

/** 这一轮归纳挂在哪条会话名下 —— 询问卡、工具、日志都跟着它走 */
const ownerOf = (i = 0): string | undefined =>
  (notesInvokes()[i] as { sessionId?: string }).sessionId

/** 攒够门槛：在这些会话上各发一条消息（每条都会被记成「值得归纳的一件事」） */
async function accumulate(sids: string[]): Promise<void> {
  for (const sid of sids) {
    await botService.handleUserMessage({ sessionId: sid, text: `msg on ${sid}` } as never)
  }
}

/** 等到笔记场合真的派出去（`maybeRun` 是脱手调用的，不挂在这一轮的收尾上） */
const waitForNotes = (n = 1): Promise<void> =>
  vi.waitFor(() => expect(notesInvokes().length).toBeGreaterThanOrEqual(n))

/**
 * 自己写的轮询 —— 用在把 Date 换成假的那段里。`vi.waitFor` 在假时钟下会去推进定时器，
 * 而那段只想让 `Date.now()` 跳过 30 分钟的门槛，定时器仍须是真的。
 */
async function poll(check: () => boolean, what: string, tries = 400): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`等不到：${what}`)
}

/** 调度器落盘的那份状态（不存在 = 这一轮压根没 advance 过） */
function stateOf(botName: string): { sessions?: Record<string, string> } | undefined {
  const file = join(dirs.bots, '.notes-state.json')
  if (!existsSync(file)) return undefined
  return (JSON.parse(readFileSync(file, 'utf-8')) as Record<string, { sessions: Sessions }>)[
    botName
  ]
}
type Sessions = Record<string, string>

beforeEach(() => {
  seq += 1
  BOT = `scout-${seq}`
  SID = `notes-sess-${seq}`
  rmSync(dirs.base, { recursive: true, force: true })
  mkdirSync(dirs.sessions, { recursive: true })
  mkdirSync(dirs.bots, { recursive: true })
  clearSessionTreeCacheForTests()
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.hasWorkflow.mockReturnValue(true)
  mocks.abortSessionRuns.mockReturnValue(0)
  messageOutcome = { gate: 'ok', outcome: 'task' }
  notesResult = ran({ outcome: 'notes' })
  mocks.invoke.mockImplementation(async (req: { input?: { occasion?: string } }) =>
    req.input?.occasion === 'notes' ? notesResult : ran(messageOutcome)
  )
  mocks.listBySession.mockResolvedValue([])
  writeBot(BOT)
  seedSessions({ [SID]: { title: 'Some title', bots: [BOT] } })
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  rmSync(dirs.base, { recursive: true, force: true })
})

// ────────────────────── BN-A：给笔记段看什么材料 ──────────────────────

describe('BN-A —— 材料组装', () => {
  it('BN-A1 各会话一段，带标题行与逐条署名（User / 该 bot 的显示名）', async () => {
    seedMessages({
      [SID]: [
        msg('e1', 'user', '以后统一用 pnpm', 1000),
        msg('e2', 'assistant', '记住了', 1001, { sender: { displayName: '侦察兵' } })
      ]
    })
    await accumulate([SID, SID, SID])
    await waitForNotes()
    expect(sinceOf()).toEqual(['--- Some title ---', 'User: 以后统一用 pnpm', '侦察兵: 记住了'])
  })

  it('BN-A2 没有 sender 的助手消息回落 Assistant（署名缺失不该把那句话弄丢）', async () => {
    seedMessages({ [SID]: [msg('e1', 'assistant', '嗯', 1000)] })
    await accumulate([SID, SID, SID])
    await waitForNotes()
    expect(sinceOf()).toContain('Assistant: 嗯')
  })

  it('BN-A3 用户消息取展开后的全文（内联 Token 的占位符不该进笔记）', async () => {
    // 笔记段看到的必须是模型当时看到的那一份 —— 标记态里那串占位符对它没有任何意义
    seedMessages({
      [SID]: [
        msg('e1', 'user', '看看 {{shuvixInlineToken:t0}}', 1000, {
          inlineTokens: {
            t0: {
              type: 'at',
              id: 'src/a.ts',
              displayText: 'a.ts',
              payload: '[workspace file: src/a.ts]'
            }
          }
        })
      ]
    })
    await accumulate([SID, SID, SID])
    await waitForNotes()
    const since = sinceOf().join('\n')
    expect(since).toContain('[workspace file: src/a.ts]')
    expect(since).not.toContain('shuvixInlineToken')
  })

  it('BN-A4 只收 user / assistant，其余 entry 不进材料', async () => {
    // 模型切换、指令注入这类 entry 也在投影里，但它们不是「这次对话教了什么」
    seedMessages({
      [SID]: [
        msg('e1', 'user', '真材料', 1000),
        msg('e2', 'custom_message', '模型切到了 gpt-x', 1001)
      ]
    })
    await accumulate([SID, SID, SID])
    await waitForNotes()
    expect(sinceOf()).toEqual(['--- Some title ---', 'User: 真材料'])
  })

  it('BN-A5 归属会话取「最近有增量」的那条，不是最早被记账的那条', async () => {
    // 询问卡必须落在用户刚才还在看的地方。dirty 的顺序是「这条会话第一次被记账」的插入序，
    // 拿它当「最近」会把卡片挂到一条早就冷掉的会话上（D12）
    const other = `${SID}-b`
    seedSessions({
      [SID]: { title: 'Older', bots: [BOT] },
      [other]: { title: 'Newer', bots: [BOT] }
    })
    seedMessages({
      [SID]: [msg('a1', 'user', '早的', 5_000)],
      [other]: [msg('b1', 'user', '晚的', 9_000)]
    })
    // 插入序：先 SID 再 other；而「最近」正好也是 other —— 下一条用例把两者拆开
    await accumulate([SID, other, SID])
    await waitForNotes()
    // 归属体现在两处：run 挂到哪条会话名下（询问卡的落点），以及信封里的 session.id
    expect(ownerOf()).toBe(other)
    expect((notesInput().session as { id: string }).id).toBe(other)
  })

  it('BN-A6 插入序与「最近」相反时按最近算（这才是 D12 真正要拆开的那一对）', async () => {
    const other = `${SID}-b`
    seedSessions({
      [SID]: { title: 'First seen', bots: [BOT] },
      [other]: { title: 'Seen later', bots: [BOT] }
    })
    seedMessages({
      // 先被记账的那条会话反而带着更新的消息
      [SID]: [msg('a1', 'user', '早记账、晚说话', 9_000)],
      [other]: [msg('b1', 'user', '晚记账、早说话', 5_000)]
    })
    await accumulate([SID, other, SID])
    await waitForNotes()
    expect(ownerOf()).toBe(SID)
    expect((notesInput().session as { id: string }).id).toBe(SID)
  })

  it('BN-A7 材料有上限：超过 200 行只留最后 200 行', async () => {
    // 一个 bot 在几条繁忙会话里攒半小时就能凑出上千行，而这份 input 既进提示词
    // 也被原样写进 run journal —— 两处都要付这笔钱，所以宿主侧也得有一把尺
    const many = Array.from({ length: 250 }, (_, i) => msg(`e${i}`, 'user', `第${i}条`, 1000 + i))
    seedMessages({ [SID]: many })
    await accumulate([SID, SID, SID])
    await waitForNotes()
    const since = sinceOf()
    expect(since).toHaveLength(MAX_LINES)
    // 留的是**尾巴**：最新的那条在，最早的那些（连同标题行）被切掉
    expect(since[since.length - 1]).toBe('User: 第249条')
    expect(since).not.toContain('--- Some title ---')
    expect(since).not.toContain('User: 第0条')
  })

  it('BN-A8 一条会话都没有增量 → 根本不派发（空跑一次的代价是一张询问卡）', async () => {
    seedMessages({ [SID]: [] })
    await accumulate([SID, SID, SID])
    // 给脱手的那次 maybeRun 足够的机会跑到 invoke
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.length).toBeGreaterThanOrEqual(3))
    expect(notesInvokes()).toHaveLength(0)
  })

  it('BN-A9 检查点在投影里找不到 → 跳过这条会话，而不是整段重来', async () => {
    // 检查点可能因为一次回退而不在当前分支的投影里了。那时若退化成「从头再来」，代价是
    // 把整段历史当新材料重灌一遍（成倍的上下文 + 一份重复的笔记）；而「跳过」最多少归纳
    // 一轮 —— 这条会话下次有新消息时自然会重新开始。
    //
    // 要两轮才测得到：第一轮把检查点种下去，第二轮把那个 id 从投影里抽走。中间必须跨过
    // 30 分钟的时间门槛，所以这里**只把 Date 换成假的**（定时器仍是真的，轮询照常工作）
    const other = `${SID}-b`
    seedSessions({
      [SID]: { title: 'Rolled back', bots: [BOT] },
      [other]: { title: 'Intact', bots: [BOT] }
    })
    seedMessages({
      [SID]: [msg('a1', 'user', '一轮之前的', 1000)],
      [other]: [msg('b1', 'user', '完好的', 1001)]
    })
    await accumulate([SID, other, SID])
    await waitForNotes()
    await poll(() => stateOf(BOT)?.sessions?.[SID] === 'a1', '第一轮的检查点落盘')
    expect(stateOf(BOT)?.sessions?.[other]).toBe('b1')

    // 第二轮：SID 换了一支分支（a1 不在其中了），other 完好且有新消息
    seedMessages({
      [SID]: [msg('z9', 'user', '回退之后的另一支', 2000)],
      [other]: [msg('b1', 'user', '完好的', 1001), msg('b2', 'user', '新的', 2001)]
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 31 * 60 * 1000)
      await accumulate([SID, other, SID])
      await poll(() => notesInvokes().length >= 2, '第二轮归纳派发')
    } finally {
      vi.useRealTimers()
    }

    // 被跳过的那条会话一行材料都没进去；完好的那条只给增量
    const since = sinceOf(1).join('\n')
    expect(since).not.toContain('回退之后的另一支')
    expect(since).not.toContain('--- Rolled back ---')
    expect(since).toContain('User: 新的')
    expect(since).not.toContain('User: 完好的')
    // 跳过不等于清空：它的检查点原地不动，等这条会话下次有新消息
    await poll(() => stateOf(BOT)?.sessions?.[other] === 'b2', '第二轮的检查点落盘')
    expect(stateOf(BOT)?.sessions?.[SID]).toBe('a1')
  })
})

// ────────────────────── BN-B：调管线的信封形状 ──────────────────────

describe('BN-B —— invoke 入参形态', () => {
  beforeEach(() => {
    seedMessages({ [SID]: [msg('e1', 'user', '材料', 1000)] })
  })

  it('BN-B1 occasion 是 notes，管线名取 bot 声明的那份', async () => {
    writeBot(BOT, { pipeline: 'my-flow' })
    await accumulate([SID, SID, SID])
    await waitForNotes()
    expect(notesInput().occasion).toBe('notes')
    expect(notesInvokes()[0].workflow).toBe('my-flow')
  })

  it('BN-B2 bot 信封带 name/displayName/description 与那份 md 的**绝对路径**', async () => {
    const path = writeBot(BOT, { displayName: '侦察兵', description: '负责代码侦察' })
    await accumulate([SID, SID, SID])
    await waitForNotes()
    expect(notesInput().bot).toEqual({
      name: BOT,
      displayName: '侦察兵',
      description: '负责代码侦察',
      file: path
    })
  })

  it('BN-B3 agents 表来自 resolvePipeline（笔记角色可被 bot md 覆盖）', async () => {
    writeBot(BOT, { agents: { notes: 'my-notes' } })
    await accumulate([SID, SID, SID])
    await waitForNotes()
    expect(notesInput().agents).toMatchObject({ notes: 'my-notes', task: `bot:${BOT}` })
  })

  it('BN-B4 session 信封是「无仲裁、无点名、无成员」的退化形态', async () => {
    // 笔记场合没有第二个人在场：仲裁、点名、成员名单在这条路径上都没有意义，
    // 但键必须齐 —— 它们是管线 input 的 required 字段
    await accumulate([SID, SID, SID])
    await waitForNotes()
    expect(notesInput().session).toEqual({
      id: SID,
      arbitrated: false,
      directed: false,
      members: []
    })
  })

  it('BN-B5 分道键是 bot:<name>:notes 且排队而不是丢弃', async () => {
    // 同一个 bot 的笔记同时刻只能有一处在改（它改的是那一份文件），而这与会话无关。
    // `queue`：排队时被更新的调用顶掉是对的（检查点只在成功后前进，后来者看到的是超集），
    // `skip` 则是真的丢
    await accumulate([SID, SID, SID])
    await waitForNotes()
    expect(notesInvokes()[0].reentry).toEqual({ mode: 'queue', key: `bot:${BOT}:notes` })
    expect(notesInvokes()[0].label).toBe(`notes:${BOT}`)
  })

  it('BN-B6 笔记正文与用户自定 input 一并铺进信封', async () => {
    writeBot(BOT, { notes: '用户偏好简答。', input: { tone: 'terse' } })
    await accumulate([SID, SID, SID])
    await waitForNotes()
    expect(notesInput().notes).toContain('用户偏好简答。')
    expect(notesInput().tone).toBe('terse')
  })

  it('BN-B7 没有笔记区的 bot 给空串（不给 undefined —— 管线 input 有类型）', async () => {
    await accumulate([SID, SID, SID])
    await waitForNotes()
    expect(notesInput().notes).toBe('')
  })
})

// ────────────────────── BN-C：凭什么算跑成了 ──────────────────────

/**
 * **run 跑完 ≠ 归纳成功**。脚本 catch 掉任何错误之后是正常返回的，于是引擎照例记
 * `ok: true`（botChatTask 的 OC-1l 钉的就是这一点）。宿主若只看 `result.ok`，一次派不
 * 出去、一次超时、甚至用户按停止，都会把这一批材料的检查点推进掉 —— 而检查点一旦前进，
 * 那些 entry 就再也不会被任何一轮看见。
 *
 * 观测面是调度器落盘的那份状态：advance 会立刻 save，没 advance 就没有那份文件。
 */
describe('BN-C —— 成功判定', () => {
  beforeEach(() => {
    seedMessages({
      [SID]: [msg('e1', 'user', '材料', 1000), msg('e2', 'assistant', '好', 1001)]
    })
  })

  const runAndPeek = async (): Promise<{ sessions?: Record<string, string> } | undefined> => {
    await accumulate([SID, SID, SID])
    await waitForNotes()
    // 判定发生在 invoke 返回之后，给它一个微任务落定
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 5))
    return stateOf(BOT)
  }

  it('BN-C1 started + ok + outcome:notes → 前进到该会话投影的最后一条 entry', async () => {
    notesResult = ran({ outcome: 'notes' })
    expect((await runAndPeek())?.sessions?.[SID]).toBe('e2')
  })

  it('BN-C2 ok:true 但 outcome 是 notes-failed → 不前进（脚本自报的才作数）', async () => {
    notesResult = ran({ outcome: 'notes-failed' })
    expect((await runAndPeek())?.sessions?.[SID]).not.toBe('e2')
  })

  it('BN-C3 ok:false → 不前进', async () => {
    notesResult = { started: true, ok: false, output: { outcome: 'notes' } }
    expect((await runAndPeek())?.sessions?.[SID]).not.toBe('e2')
  })

  it('BN-C4 started:false（管线不存在 / 入参不合法）→ 不前进', async () => {
    notesResult = { started: false, reason: 'not-found' }
    expect((await runAndPeek())?.sessions?.[SID]).not.toBe('e2')
  })

  it('BN-C5 output 缺失 → 不前进（读不出结局就当没跑成）', async () => {
    notesResult = { started: true, ok: true }
    expect((await runAndPeek())?.sessions?.[SID]).not.toBe('e2')
  })

  it('BN-C6 没跑成时留一条 warn（否则「笔记从来不更新」无从查起）', async () => {
    notesResult = { started: false, reason: 'not-found' }
    await runAndPeek()
    const lines = mocks.warn.mock.calls.map((c) => String(c[0]))
    expect(lines.some((l) => l.includes('not-found'))).toBe(true)
  })

  it('BN-C7 管线名写坏的 bot 不读会话树 —— 便宜的检查排在读树之前', async () => {
    // 否则这个 bot 的每条消息都要白读一遍所有 dirty 会话的树，而结论恒为「派不出去」。
    //
    // 造这个局面要卡在一个很窄的缝里：管线得存在到第三条消息跑完（否则根本没有 note()
    // 记账），又得在紧随其后的那次 maybeRun 之前消失。于是在第三次消息场合的 invoke
    // 里翻开关 —— 那一刻 runPipeline 早已过了它自己那道 exists 检查
    let msgRuns = 0
    mocks.invoke.mockImplementation(async (req: { input?: { occasion?: string } }) => {
      if (req.input?.occasion === 'notes') return notesResult
      msgRuns += 1
      if (msgRuns === MIN_EVENTS) {
        mocks.hasWorkflow.mockReturnValue(false)
        // 此刻之后的每一次读树都只可能来自笔记那条路（窗口构建已经跑完了）
        mocks.listBySession.mockClear()
      }
      return ran(messageOutcome)
    })

    await accumulate([SID, SID, SID])
    await new Promise((r) => setTimeout(r, 5))
    expect(notesInvokes()).toHaveLength(0)
    expect(mocks.listBySession).not.toHaveBeenCalled()
  })
})

// ─────────────── BN-D：哪一轮算「值得记的一件事」 ───────────────

/**
 * 纯函数表。抽成导出函数而不是留在 `runPipeline` 里的一行三元，正是为了让这张表能在
 * 这一层摆开 —— 它的每一格都对应一次「要不要为此付一整份笔记 + 一张询问卡」的取舍。
 */
describe('BN-D —— isNoteWorthy', () => {
  it('BN-D1 判定表', () => {
    const table: Array<[string, { outcome?: string; memorable?: boolean } | undefined, boolean]> = [
      // 干成了一次活 —— 结论值得留下
      ['task', { outcome: 'task' }, true],
      // 没调 next 但留下了散文，仍然是干过一次活（结果已降级成回复交出去了）
      ['task-unshaped', { outcome: 'task-unshaped' }, true],
      // 意图段说这条带着可长期沿用的东西 —— 不限于哪一种结局
      ['memorable 的一次普通回复', { outcome: 'reply', memorable: true }, true],
      // 仲裁落败者也带 memorable：把它绑到胜者身上等于一次对话只教会一个 bot
      ['memorable 的落败者', { outcome: 'yielded', memorable: true }, true],
      // **没干成**的三种：把计数顶到门槛，换来的是一次没有材料价值的归纳
      ['task-failed', { outcome: 'task-failed' }, false],
      ['task-timeout', { outcome: 'task-timeout' }, false],
      // 配置错，脚本自己的注释就写着重试永远不会好
      ['task-no-agent', { outcome: 'task-no-agent' }, false],
      // 一句话答完的普通回复不算 —— 否则寒暄也能攒够门槛
      ['reply', { outcome: 'reply' }, false],
      ['clarify', { outcome: 'clarify' }, false],
      ['ignored', { outcome: 'ignored' }, false],
      ['gate-broken', { outcome: 'gate-broken' }, false],
      ['aborted', { outcome: 'aborted' }, false]
    ]
    for (const [what, output, expected] of table) {
      expect({ what, worth: isNoteWorthy(output) }).toEqual({ what, worth: expected })
    }
  })

  it('BN-D2 output 整个缺失 → false（读不出结局就不记账）', () => {
    expect(isNoteWorthy(undefined)).toBe(false)
    expect(isNoteWorthy({})).toBe(false)
  })

  it('BN-D3 memorable 只认真布尔 true（跨 vm realm 到达的值，逐字段 typeof 是唯一防线）', () => {
    expect(isNoteWorthy({ outcome: 'reply', memorable: 'yes' } as never)).toBe(false)
    expect(isNoteWorthy({ outcome: 'reply', memorable: 1 } as never)).toBe(false)
    expect(isNoteWorthy({ outcome: 'reply', memorable: false })).toBe(false)
  })

  it('BN-D4 memorable 为真时不看 outcome（连没干成的那几种也算）', () => {
    // 这不是矛盾：memorable 说的是「这条对话里有可长期沿用的东西」，与这一轮干没干成无关
    expect(isNoteWorthy({ outcome: 'task-failed', memorable: true })).toBe(true)
    expect(isNoteWorthy({ memorable: true })).toBe(true)
  })
})

// ─────────────────────────── BN-E：接线 ───────────────────────────

describe('BN-E —— 接线', () => {
  it('BN-E1 关掉笔记的 bot 连账都不记（攒一堆永远不会被读的计数没有意义）', async () => {
    writeBot(BOT, { notesEnabled: false })
    seedMessages({ [SID]: [msg('e1', 'user', '材料', 1000)] })
    await accumulate([SID, SID, SID])
    await new Promise((r) => setTimeout(r, 5))
    expect(notesInvokes()).toHaveLength(0)
    expect(existsSync(join(dirs.bots, '.notes-state.json'))).toBe(false)
  })

  it('BN-E2 forgetNotesSession 转给调度器：删掉会话就删掉它的检查点', async () => {
    seedMessages({ [SID]: [msg('e1', 'user', '材料', 1000)] })
    await accumulate([SID, SID, SID])
    await waitForNotes()
    await vi.waitFor(() => expect(stateOf(BOT)?.sessions?.[SID]).toBe('e1'))

    botService.forgetNotesSession(SID)
    expect(stateOf(BOT)?.sessions?.[SID]).toBeUndefined()
  })

  it('BN-E3 bot 改名时检查点跟着搬（三处引用里的第三处）', async () => {
    // 名单与 journal 目录那两处在 botServiceSaveGuard 测；检查点这一处放在这里，
    // 是因为只有跑过一次真归纳才有东西可搬 —— 在那边断言会恒真
    seedMessages({ [SID]: [msg('e1', 'user', '材料', 1000)] })
    await accumulate([SID, SID, SID])
    await waitForNotes()
    await vi.waitFor(() => expect(stateOf(BOT)?.sessions?.[SID]).toBe('e1'))

    const renamed = `${BOT}-renamed`
    const res = botService.save(
      BOT,
      [
        '---',
        'shuvix: bot v1',
        `name: ${renamed}`,
        'description: 改了个名字',
        '---',
        '',
        'BODY.'
      ].join('\n')
    )
    expect(res.success).toBe(true)
    expect(stateOf(renamed)?.sessions?.[SID]).toBe('e1')
    expect(stateOf(BOT)).toBeUndefined()
  })
})
