/**
 * 父会话介入子会话（docs/sub-session-design.md §19）—— 跨会话、跨进程才证得出来的那几条链路：
 *
 *   子会话在父会话发起的那一轮里停下来问 → 这一轮的后台任务进「等待输入」→ `wait-for-sessions` 握着就由它交回 /
 *   没人等就经枢纽通知父会话（空闲 → 自动续跑）→ 父会话 `answer-session` 代答（只回执；应答只送进子会话自己，
 *   答题方由宿主记下）→ 子会话接着跑完，答复经完成通知或 wait 交回；权限卡只转告；`steer-session` 落进跑着的
 *   一轮；`inspect-session` 的大纲 / 展开 / 搜索；用户自己发起的一轮不通知、不能代答、不能插话；父会话被停不
 *   级联到子会话（§20）。
 *
 * 模型侧是假提供商，**每个回合都按内容认领**（父会话与子会话的请求交错到达）：
 *  - `isParent` = 请求里有父会话的第一条用户消息（`P_MARK`）—— 它永远在父会话的历史里、子会话的历史里永远没有；
 *  - `isChild`  = 不是父会话 + 最后一条用户消息恰为派进去的任务（`C_MARK`）。**先排除父会话**：父会话的历史里有
 *    `prompt-session` 的参数，裸的 `raw.includes(C_MARK)` 会把它认成子会话。
 *
 * 确定性的四个抓手：
 *  1. 先让父会话空闲、再放子会话出问题：子会话第一轮挂在具名 hold 槽 `child` 里，父会话那一轮落定之后才放；
 *  2. 要看「卡在等输入」的中间态，就把父会话被叫醒的那一轮挂在 `parent` 槽里（两个槽可以同时挂着）；
 *  3. 否定断言用有界静默窗（`quiet`，1500 ms > 枢纽合并窗口 + 续跑合并窗口），只用于「不该有」，正向一律等；
 *  4. `prompt` / `answer` 只回执（§20），回执的种类取决于子会话在 50 ms 确认窗里停没停下来问 —— 凡断言回执的，子会话
 *     那一步都挂着（于是恒为 `started`）；要 `wait` 握着它的，先等视图里那次 wait 在跑（`waitArmed`）再放。
 *
 * **不装 `installAutoAllow`**（刻意）：它对任何挂着的询问都回「允许 + 空选」，会抢在父会话前面把选择题答掉。
 * 除 WP6-06 那张故意的权限卡外，脚本只碰免询问的路径（项目目录里的 ls / read、ask）。
 *
 * 每个 describe 一对新会话（IPC 直建，显式标题 —— 自动标题不跑）；读法 IPC 优先，DOM 只两处（任务面板行、
 * 代答标签），都经 pages.ts。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  messageTextsOf,
  startFakeProvider,
  toolTextsOf,
  userTextsOf,
  type FakeProvider,
  type FakeRequest
} from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import { syncProbe, type SyncProbe, type ToolResult } from '../../harness/sync'
import {
  chatPane,
  sidebarPane,
  tasksPanelPane,
  type ChatPane,
  type SidebarPane,
  type TaskRowShot
} from '../../harness/pages'

const MODEL = 'e2e-model'
/** 一轮挂在 hold 里的上限：远长于用例要它挂着的时间，放行靠 `release(key)` */
const HOLD_MS = 30_000
/** 否定断言的静默窗 */
const QUIET_MS = 1500
/**
 * 父会话的 `wait` 在视图里已经在跑之后，再留给它登记成「握着这条子会话」的余量（中间只隔两次 memo 读写）。
 * 枢纽的询问通知与完成通知都在那一刻看「有没有 wait 握着」，所以放子会话往下走之前必须先过这一段
 */
const WAIT_ARMED_MS = 300
/** 一条流程的用例上限（几轮父会话 + 子会话 + 通知的合并窗口） */
const FLOW_TIMEOUT = 120_000

interface ListedBlock {
  type: string
  toolCallId?: string
  toolName?: string
  result?: string
  isError?: boolean
  details?: Record<string, unknown> | null
}

interface ListedMessage {
  id: string
  role: string
  content: string
  metadata?: { isSystemNotice?: boolean } | null
  blocks?: ListedBlock[]
}

interface Pair {
  parent: string
  child: string
  parentTitle: string
  childTitle: string
}

let app: E2EApp
let provider: FakeProvider
let probe: SyncProbe
let events: EventRecorder
let sidebar: SidebarPane
let chat: ChatPane
let projDir = ''
let projectId = ''
/** 家目录里、会话目录外的一份文件：子会话读它会弹权限卡（出厂 `ask-on-external-path#0`） */
let secretPath = ''

const SECRET = 'SECRET-D6'
const SEED_FILE = 'SEEDFILE-F8'

// ─── 小助手 ──────────────────────────────────────

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

/** 系统通知（子会话回报父会话的那几条：role user + metadata.isSystemNotice） */
const systemNotices = (msgs: ListedMessage[]): ListedMessage[] =>
  msgs.filter((m) => m.role === 'user' && m.metadata?.isSystemNotice === true)

/** 不是系统通知的用户消息正文（人打的 / 父会话代发的） */
const userMessages = (msgs: ListedMessage[]): string[] =>
  msgs.filter((m) => m.role === 'user' && !m.metadata?.isSystemNotice).map((m) => m.content)

/** 这条会话的转写里有没有含这段文字的助手消息 */
const hasAssistantText = (msgs: ListedMessage[], text: string): boolean =>
  msgs.some((m) => m.role === 'assistant' && m.content.includes(text))

/** 经 IPC 发一条用户消息并等这一轮落定（与用户在输入框里敲同一条路） */
const promptSession = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )

/** 发一条用户消息、不等它（它要停在询问上） */
const sendPrompt = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `(() => {
      window.api.agent
        .prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })
        .catch(() => undefined)
      return true
    })()`
  )

/** 扮演用户在卡片上作答（走用户点按钮的同一条 IPC） */
const respond = (
  sid: string,
  requestId: string,
  response: Record<string, unknown>
): Promise<unknown> =>
  app.main.eval(
    `window.api.agent.respondToInput(${JSON.stringify({ sessionId: sid, requestId, response })})`
  )

/** 父会话名下这条子会话的 sub-session 任务（后台任务枢纽的快照） */
const subTasks = async (parent: string, child: string): Promise<TaskInfo[]> =>
  (
    await app.main.eval<TaskInfo[]>(
      `window.api.bgTask.list(${JSON.stringify({ sessionId: parent })})`
    )
  ).filter((t) => t.subject.kind === 'sub-session' && t.subject.childSessionId === child)

/** 一次工具调用落盘的结果（会话视图里的工具块）；等它出现 */
const resultOf = (sid: string, callId: string): Promise<ToolResult> =>
  probe.waitToolResult(sid, callId, 60_000)

/** 某会话里某个 toolCallId 的全部结果（同一个 id 被答两次会在这里现形） */
const resultsOf = async (sid: string, callId: string): Promise<ToolResult[]> =>
  (await probe.toolResults(sid)).filter((r) => r.toolCallId === callId)

const quiet = (ms = QUIET_MS): Promise<void> => sleep(ms)

/** 等这条会话的某次工具调用（wait）真的挂上了：视图里它在跑，再留登记的余量 */
const waitArmed = async (sid: string, callId: string): Promise<void> => {
  await probe.waitView(
    sid,
    (v) => v.toolRuns[callId]?.status === 'running',
    30_000,
    `${callId} running in ${sid}`
  )
  await sleep(WAIT_ARMED_MS)
}

/** 结果带不带后台标签（`details.background`，与 bash 后台任务同一枚） */
const backgroundTagOf = (r: ToolResult): boolean | undefined =>
  (r.details as { background?: boolean } | undefined)?.background

/** 等某个 hold 槽里挂着的恰好是满足 pred 的那个请求 */
const waitHeld = (
  key: string,
  pred: (r: FakeRequest) => boolean,
  what: string
): Promise<FakeRequest> =>
  until(
    () => {
      const held = provider.heldRequest(key)
      return held && pred(held) ? held : null
    },
    what,
    30_000
  )

/** 等这条会话的转写里出现某段助手正文、且这一轮落定（不靠 agent.prompt 的返回：续跑那一轮不是它发起的） */
const waitAssistant = async (sid: string, text: string): Promise<ListedMessage[]> => {
  await probe.waitView(
    sid,
    (v) =>
      v.run.state !== 'busy' &&
      v.messages.some((m) => m.role === 'assistant' && m.content.includes(text)),
    60_000,
    `"${text}" in ${sid}`
  )
  return listMessages(sid)
}

/** 新的一对会话：父会话在项目里，子会话 IPC 直建（`parentId`，同 `createPinnedChildSession` 的建法，不打戳） */
const newPair = async (label: string): Promise<Pair> => {
  const parentTitle = `IV-${label}-parent`
  const childTitle = `IV-${label}-child`
  const parent = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title: parentTitle, projectId })}).then((s) => s.id)`
  )
  const child = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ parentId: parent, title: childTitle })}).then((s) => s.id)`
  )
  return { parent, child, parentTitle, childTitle }
}

const sessionCall = (
  id: string,
  args: Record<string, unknown>
): { id: string; name: string; args: string } => ({
  id,
  name: 'session',
  args: JSON.stringify(args)
})

const askCall = (
  id: string,
  question: string,
  labels: string[]
): { id: string; name: string; args: string } => ({
  id,
  name: 'ask',
  args: JSON.stringify({ question, options: labels.map((label) => ({ label, description: '' })) })
})

/** 结果文本里 `<session …>` 的那一行开标签 */
const openTagOf = (text: string, child: string): string =>
  text.split('\n').find((line) => line.startsWith(`<session id="${child}"`)) ?? ''

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-intervene')
  mkdirSync(projDir, { recursive: true })
  // 只会出现在 ls 的结果里的文件名（WP6-09 / 10：大纲不给工具结果、搜索覆盖它）
  writeFileSync(join(projDir, `${SEED_FILE}.txt`), 'seed\n')
  mkdirSync(join(app.home, 'outside-d'), { recursive: true })
  secretPath = join(app.home, 'outside-d', 'secret.txt')
  writeFileSync(secretPath, `${SECRET}\n`)
  projectId = (await createProject(app.main, { name: 'IntervProj', path: projDir })).id

  sidebar = sidebarPane(app.main)
  chat = chatPane(app.main)
  events = eventRecorder(app.main)
  await events.install()
  probe = syncProbe(app.main)
  await probe.install()
}, 60_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

// ─────────────────────────────────────────────────────────────────────────
// A. 主链：问 → 父会话被叫醒 → 代答（回执）→ 跑完再被完成通知叫醒、wait 收回答复（WP6-01 / 02 / 03 一条流程）

describe('子会话停下来问：通知、代答、留痕', () => {
  const P_MARK = 'P1-PARENT-ASK-FLOW'
  const C_MARK = 'C1-CHILD-TASK'
  const QUESTION = 'Q1-keep-old-api?'
  const KEEP = 'OPT-A-KEEP'
  const DROP = 'OPT-A-DROP'
  /** 子会话与旁观会话的询问用同一个 id：应答按会话送达，不按 id 全局认领 */
  const ASK_ID = 'call_shared_ask'
  const BYSTANDER = 'IV-A-bystander'
  const BYSTANDER_TEXT = 'B1-BYSTANDER'

  const isParent = (r: FakeRequest): boolean => r.raw.includes(P_MARK)
  const isChild = (r: FakeRequest): boolean => !isParent(r) && r.lastUserText === C_MARK
  const parentWoken = (r: FakeRequest): boolean =>
    isParent(r) && r.lastUserText.includes('status="waiting-input"')
  const parentDone = (r: FakeRequest): boolean =>
    isParent(r) && r.lastUserText.includes('has finished')

  let pair: Pair
  let bystander = ''
  /** 父会话被叫醒的那一轮的请求（hold 住时取下） */
  let wokenRequest: FakeRequest | null = null
  /** hold 期间的枢纽状态与面板行（WP6-02） */
  let midTasks: TaskInfo[] = []
  let midRow: TaskRowShot | null = null

  it(
    'WP6-01 子会话停下来问 → 空闲的父会话被通知、自动续跑 → 代答只回执 → 跑完再被完成通知叫醒，wait 收回答复',
    async () => {
      pair = await newPair('A')
      bystander = await app.main.eval<string>(
        `window.api.session.create(${JSON.stringify({ title: BYSTANDER, projectId })}).then((s) => s.id)`
      )
      provider.reset()
      await events.clear()
      provider.script(
        {
          toolCalls: [
            sessionCall('call_a_prompt', {
              action: 'prompt-session',
              session_id: pair.child,
              message: C_MARK
            })
          ],
          when: isParent
        },
        { text: 'dispatched.', when: isParent },
        {
          toolCalls: [askCall(ASK_ID, QUESTION, [KEEP, DROP])],
          when: isChild,
          holdMs: HOLD_MS,
          holdKey: 'child'
        },
        {
          toolCalls: [
            sessionCall('call_a_steer', {
              action: 'steer-session',
              session_id: pair.child,
              message: 'STEER-WHILE-ASKING'
            })
          ],
          when: parentWoken,
          holdMs: HOLD_MS,
          holdKey: 'parent'
        },
        // 不给 ask_id、不给 session_id：只有一条可答的询问、一条子会话 —— 补全
        {
          toolCalls: [
            sessionCall('call_a_answer', { action: 'answer-session', selections: [KEEP] })
          ],
          when: parentWoken
        },
        // 代答只回执：被叫醒的这一轮就此收尾
        { text: 'answered.', when: parentWoken },
        // 答完之后子会话的下一步：挂住，等父会话那一轮落定再放 —— 完成通知只能经自动续跑到达
        { text: 'C1-CHILD-FINAL', when: isChild, holdMs: HOLD_MS, holdKey: 'child2' },
        // 被完成通知叫醒的那一轮：照通知说的，用 wait 收
        {
          toolCalls: [sessionCall('call_a_collect', { action: 'wait-for-sessions' })],
          when: parentDone
        },
        { text: 'P1-ALL-DONE', when: parentDone },
        // 旁观会话：同一个询问 id
        {
          toolCalls: [askCall(ASK_ID, 'B1-question?', ['B1-OPT-X', 'B1-OPT-Y'])],
          when: (r) => r.lastUserText === BYSTANDER_TEXT
        }
      )

      // 任务面板只画活动会话 —— 父会话先在侧栏里打开
      await until(
        async () => (await sidebar.titles()).includes(pair.parentTitle) || null,
        'parent listed'
      )
      expect(await sidebar.openSession(pair.parentTitle)).toBe(true)

      await sendPrompt(bystander, BYSTANDER_TEXT)
      await probe.waitView(
        bystander,
        (v) => v.asks.some((a) => a.id === ASK_ID),
        30_000,
        'bystander asking'
      )

      // 抓手 1：父会话这一轮落定（空闲）之后才放子会话出问题
      await promptSession(pair.parent, P_MARK)
      await waitHeld('child', isChild, 'child turn 1 held')
      provider.release('child')

      // 抓手 2：父会话被叫醒的那一轮挂住 —— 此刻子会话一定还挂着询问（WP6-02 的中间态）
      wokenRequest = await waitHeld('parent', parentWoken, 'parent woken by the input notice')
      midTasks = await subTasks(pair.parent, pair.child)
      const tasks = tasksPanelPane(app.main)
      await tasks.open()
      midRow = await until(
        async () =>
          (await tasks.rows()).find(
            (r) =>
              r.kind === 'sub-session' &&
              r.title === pair.childTitle &&
              r.status === 'waiting-input'
          ) ?? null,
        'sub-session task row waiting for input'
      )
      provider.release('parent')

      // 代答回执、那一轮收尾时子会话的下一步还挂着；放它跑完 → 完成通知 → 父会话再被叫醒
      await waitAssistant(pair.parent, 'answered.')
      await waitHeld('child2', isChild, 'child turn 2 held')
      provider.release('child2')
      const parentMsgs = await waitAssistant(pair.parent, 'P1-ALL-DONE')

      // 1. 两条系统通知：先是可代答的那一块（不是转告），再是跑完的那一条
      const notices = systemNotices(parentMsgs)
      expect(notices).toHaveLength(2)
      const notice = notices[0].content
      expect(notice).toContain('status="waiting-input"')
      expect(notice).toContain('It stopped to ask a question in the turn you started')
      expect(notice).toContain(`<question ask_id="${ASK_ID}">`)
      expect(notice).toContain(QUESTION)
      expect(notice).toContain(`1. ${KEEP}`)
      expect(notice).toContain(`2. ${DROP}`)
      expect(notice).toContain('answer-session')
      expect(notice).not.toContain('for="user"')
      expect(notice).not.toContain('<blocked-on-user-approval>')
      const finished = notices[1].content
      expect(finished).toContain(`<session id="${pair.child}"`)
      expect(finished).toContain('has finished')
      expect(finished).toContain('wait-for-sessions')
      // 父会话代答不是用户插手
      expect(finished.split('\n')[0]).not.toContain('user-intervened')

      // 2. 模型以 user 角色看到它；续跑不是用户发起的 —— 父会话没有新的非通知用户消息
      expect(wokenRequest.lastUserText.trim()).toBe(notice.trim())
      expect(userMessages(parentMsgs)).toEqual([P_MARK])

      // 3. 代答的结果只是回执：在跑、带后台标签，不带答复
      const answer = await resultOf(pair.parent, 'call_a_answer')
      expect(answer.isError).toBe(false)
      expect(answer.result).toContain(`<session id="${pair.child}" status="running"/>`)
      expect(answer.result).toContain('Answered; it carries on in the background.')
      expect(answer.result).not.toContain('<reply>')
      expect(answer.result).not.toContain('C1-CHILD-FINAL')
      expect(backgroundTagOf(answer)).toBe(true)

      // 4. 答复经 wait 收回，在围栏里；代答不算用户插手
      const collected = await resultOf(pair.parent, 'call_a_collect')
      expect(collected.isError).toBe(false)
      expect(collected.result).toContain('<sessions status="settled">')
      expect(collected.result).toContain('<reply>\nC1-CHILD-FINAL\n</reply>')
      expect(openTagOf(collected.result, pair.child)).not.toContain('user-intervened')
      expect(backgroundTagOf(collected)).not.toBe(true)

      // 5. 代答不是一条用户消息
      expect(userMessages(await listMessages(pair.child))).toEqual([C_MARK])

      // 6. 没有第三条通知；父会话的请求：派活、收尾、被叫醒（插话）、代答、收尾、被叫醒（wait）、收尾
      await quiet()
      expect(systemNotices(await listMessages(pair.parent))).toHaveLength(2)
      expect(provider.requests().filter(isParent)).toHaveLength(7)
    },
    FLOW_TIMEOUT
  )

  it('WP6-02 「卡在等输入」看得见：任务状态 / 面板行；询问挂着时 steer 被拒、指向 answer', async () => {
    // 1. 枢纽状态（§19.3 的新东西）：hold 期间那一条任务在等输入、还没结束
    expect(midTasks).toHaveLength(1)
    expect(midTasks[0].status).toBe('waiting-input')
    expect(midTasks[0].endedAt).toBeNull()

    // 2. 面板：行的枢纽状态 + 行首的「等你回答」点
    expect(midRow).not.toBeNull()
    expect(midRow!.status).toBe('waiting-input')
    expect(midRow!.dot).toBe('blocked')
    expect(midRow!.id).toBe(midTasks[0].taskId)

    // 3. 询问挂着时 steer 被拒、指向 answer；被拒 = 没排队
    const steer = await resultOf(pair.parent, 'call_a_steer')
    expect(steer.isError).toBe(true)
    expect(steer.result).toContain('waiting for an answer to its question')
    expect(steer.result).toContain('answer-session')
    expect((await probe.viewOf(pair.child))?.queue).toEqual([])
    const childMsgs = await listMessages(pair.child)
    expect(childMsgs.some((m) => m.content.includes('STEER-WHILE-ASKING'))).toBe(false)
    expect(
      provider.requests().filter((r) => !isParent(r) && r.raw.includes('STEER-WHILE-ASKING'))
    ).toEqual([])

    // 4. 流程结束之后：同一条任务落到 done，面板行跟着落定
    const after = await subTasks(pair.parent, pair.child)
    expect(after).toHaveLength(1)
    expect(after[0].taskId).toBe(midTasks[0].taskId)
    expect(after[0].status).toBe('done')
    expect(after[0].endedAt).not.toBeNull()
    const tasks = tasksPanelPane(app.main)
    await until(
      async () =>
        (await tasks.rows()).some((r) => r.id === midTasks[0].taskId && r.status === 'done') ||
        null,
      'sub-session task row done'
    )
  })

  it('WP6-03 代答留痕：结果文案、子模型看到的、卡片标签（重开仍在）；同 id 的别的会话不受影响', async () => {
    // 1. ask 的结果按答题方写，details 里记着答题方（宿主写的）
    const asked = await resultsOf(pair.child, ASK_ID)
    expect(asked).toHaveLength(1)
    expect(asked[0].result.startsWith('The user did not answer this')).toBe(true)
    expect(asked[0].result).toContain(`Selected: ${KEEP}`)
    expect(asked[0].result).not.toContain('User selected')
    expect((asked[0].details as { answeredBy?: unknown } | undefined)?.answeredBy).toEqual({
      kind: 'parent-session',
      sessionId: pair.parent,
      title: pair.parentTitle
    })

    // 2. 子会话的模型下一步看到的就是这句（它知道不是用户本人选的）
    const childTurns = provider.requests().filter(isChild)
    expect(childTurns).toHaveLength(2)
    expect(
      toolTextsOf(childTurns[1]).some((t) => t.startsWith('The user did not answer this'))
    ).toBe(true)

    // 3. DOM：子会话里那张 ask 卡带「父会话代答」标签；切走再切回来仍在（来自落盘的 details）
    const askTag = async (): Promise<string | null> =>
      (await chat.toolRowShots()).find((r) => r.name === 'ask')?.answeredByParent ?? null
    expect(await sidebar.openSession(pair.childTitle)).toBe(true)
    const tag = await until(askTag, 'answered-by-parent tag on the ask row')
    expect(tag).toContain(pair.parentTitle)
    expect(await sidebar.openSession(BYSTANDER)).toBe(true)
    expect(await sidebar.openSession(pair.childTitle)).toBe(true)
    expect(await until(askTag, 'answered-by-parent tag after reopening')).toContain(
      pair.parentTitle
    )

    // 4. 旁观会话的同 id 询问原样挂着、没有结果（应答只送进子会话自己）
    const view = await probe.viewOf(bystander)
    expect(view?.asks.some((a) => a.id === ASK_ID)).toBe(true)
    expect(await resultsOf(bystander, ASK_ID)).toEqual([])

    await app.main.eval(`window.api.agent.abort(${JSON.stringify(bystander)})`)
    await probe.waitView(bystander, (v) => v.run.state !== 'busy', 30_000, 'bystander stopped')
  })
})

// ─────────────────────────────────────────────────────────────────────────
// B. wait 握着时停下来问（WP6-04）

describe('wait 握着时停下来问：wait 交回、代答只回执、零通知', () => {
  const P_MARK = 'P4-PARENT-FG'
  const C_MARK = 'C4-CHILD-TASK'
  const isParent = (r: FakeRequest): boolean => r.raw.includes(P_MARK)
  const isChild = (r: FakeRequest): boolean => !isParent(r) && r.lastUserText === C_MARK

  it(
    'WP6-04 prompt 只回执；wait 报 asking；错选项被拒且没发；message 代答只回执、下一问由 wait 交回；selections 代答之后 wait 收到答复；全程零通知',
    async () => {
      const pair = await newPair('B')
      provider.reset()
      await events.clear()
      // 整条都在父会话的一轮里。子会话的每一步都挂住，等父会话下一次 wait 握着了才放 —— 它停下来问 / 跑完都落在
      // 某次 wait 里（于是一条通知都没有），回执也恒为「在跑」
      provider.script(
        {
          toolCalls: [
            sessionCall('call_b_prompt', {
              action: 'prompt-session',
              session_id: pair.child,
              message: C_MARK
            })
          ],
          when: isParent
        },
        {
          toolCalls: [askCall('call_b_ask1', 'Q4a-which-path?', ['OPT-B1-A', 'OPT-B1-B'])],
          when: isChild,
          holdMs: HOLD_MS,
          holdKey: 'child'
        },
        {
          toolCalls: [
            sessionCall('call_b_wait1', {
              action: 'wait-for-sessions',
              session_id: pair.child
            })
          ],
          when: isParent
        },
        {
          toolCalls: [
            sessionCall('call_b_wrong', {
              action: 'answer-session',
              selections: ['OPT-B1-NOPE']
            })
          ],
          when: isParent
        },
        {
          toolCalls: [
            sessionCall('call_b_free', {
              action: 'answer-session',
              ask_id: 'call_b_ask1',
              message: 'FREE-TEXT-B4'
            })
          ],
          when: isParent
        },
        {
          toolCalls: [askCall('call_b_ask2', 'Q4b-which-name?', ['OPT-B2-A', 'OPT-B2-B'])],
          when: isChild,
          holdMs: HOLD_MS,
          holdKey: 'child2'
        },
        {
          toolCalls: [
            sessionCall('call_b_wait2', {
              action: 'wait-for-sessions',
              session_id: pair.child
            })
          ],
          when: isParent
        },
        {
          toolCalls: [
            sessionCall('call_b_pick', { action: 'answer-session', selections: ['OPT-B2-A'] })
          ],
          when: isParent
        },
        { text: 'C4-CHILD-FINAL', when: isChild, holdMs: HOLD_MS, holdKey: 'child3' },
        {
          toolCalls: [
            sessionCall('call_b_wait3', {
              action: 'wait-for-sessions',
              session_id: pair.child
            })
          ],
          when: isParent
        },
        { text: 'P4-DONE', when: isParent }
      )

      const turn = promptSession(pair.parent, P_MARK).catch((error: unknown) => error)
      await waitHeld('child', isChild, 'child step 1 held')
      await waitArmed(pair.parent, 'call_b_wait1')
      provider.release('child')
      await waitHeld('child2', isChild, 'child step 2 held')
      await waitArmed(pair.parent, 'call_b_wait2')
      provider.release('child2')
      await waitHeld('child3', isChild, 'child step 3 held')
      await waitArmed(pair.parent, 'call_b_wait3')
      provider.release('child3')
      await turn
      expect(hasAssistantText(await listMessages(pair.parent), 'P4-DONE')).toBe(true)

      // 1. prompt 只回执：在跑、带后台标签，没有询问也没有答复
      const first = await resultOf(pair.parent, 'call_b_prompt')
      expect(first.isError).toBe(false)
      expect(first.result).toContain(`<session id="${pair.child}" status="running"/>`)
      expect(first.result).toContain('Started in the background')
      expect(first.result).not.toContain('<question')
      expect(backgroundTagOf(first)).toBe(true)

      // 2. wait 报 asking，带那一块询问（可代答），尾注指向 answer；wait 不带后台标签
      const waited = await resultOf(pair.parent, 'call_b_wait1')
      expect(waited.result).toContain('<sessions status="asking">')
      expect(waited.result).toContain('status="waiting-input"')
      expect(waited.result).toContain('<question ask_id="call_b_ask1">')
      expect(waited.result).toContain('Q4a-which-path?')
      expect(waited.result).toContain('1. OPT-B1-A')
      expect(waited.result).toContain('2. OPT-B1-B')
      expect(waited.result).toContain('You may answer it for the user')
      expect(waited.result).not.toContain('for="user"')
      expect(waited.result.split('</sessions>')[1] ?? '').toContain('answer-session')
      expect(backgroundTagOf(waited)).not.toBe(true)

      // 3. 错选项被拒、什么都没发，列出全部选项
      const wrong = await resultOf(pair.parent, 'call_b_wrong')
      expect(wrong.isError).toBe(true)
      expect(wrong.result).toContain('Not an option: "OPT-B1-NOPE"')
      expect(wrong.result).toContain('Nothing was sent')
      expect(wrong.result).toContain('- OPT-B1-A')
      expect(wrong.result).toContain('- OPT-B1-B')

      // 4. message 代答只回执（子会话的下一步挂着，回执恒为在跑）
      const free = await resultOf(pair.parent, 'call_b_free')
      expect(free.isError).toBe(false)
      expect(free.result).toContain(`<session id="${pair.child}" status="running"/>`)
      expect(free.result).toContain('Answered; it carries on in the background.')
      expect(free.result).not.toContain('<question')
      expect(backgroundTagOf(free)).toBe(true)

      // 5. 下一问由下一次 wait 交回，不再带上一问
      const waited2 = await resultOf(pair.parent, 'call_b_wait2')
      expect(waited2.result).toContain('<sessions status="asking">')
      expect(waited2.result).toContain('<question ask_id="call_b_ask2">')
      expect(waited2.result).toContain('Q4b-which-name?')
      expect(waited2.result).not.toContain('call_b_ask1')

      // 6. selections 代答同样只回执；这一轮的答复由最后一次 wait 交回（不带后台标签）
      const pick = await resultOf(pair.parent, 'call_b_pick')
      expect(pick.isError).toBe(false)
      expect(pick.result).toContain('Answered; it carries on in the background.')
      expect(pick.result).not.toContain('<reply>')
      expect(pick.result).not.toContain('C4-CHILD-FINAL')
      expect(backgroundTagOf(pick)).toBe(true)
      const collected = await resultOf(pair.parent, 'call_b_wait3')
      expect(collected.isError).toBe(false)
      expect(collected.result).toContain('<sessions status="settled">')
      expect(collected.result).toContain('<reply>\nC4-CHILD-FINAL\n</reply>')
      expect(backgroundTagOf(collected)).not.toBe(true)

      // 7. 子会话里两问的结果：错选项没有送到；两次都记着答题方
      const ask1 = await resultsOf(pair.child, 'call_b_ask1')
      expect(ask1).toHaveLength(1)
      expect(ask1[0].result).toBe(
        'The user did not answer this — the session that assigned you this task answered on their behalf. Instead of picking an option, it wrote:\nFREE-TEXT-B4'
      )
      const ask2 = await resultsOf(pair.child, 'call_b_ask2')
      expect(ask2).toHaveLength(1)
      expect(ask2[0].result).toContain('Selected: OPT-B2-A')
      for (const r of [ask1[0], ask2[0]]) {
        expect(
          (r.details as { answeredBy?: { sessionId?: string } } | undefined)?.answeredBy?.sessionId
        ).toBe(pair.parent)
      }

      // 8. 每次停下来都有 wait 握着：没有任何系统通知（询问两次、跑完一次）
      expect(systemNotices(await listMessages(pair.parent))).toEqual([])
      await quiet()
      expect(systemNotices(await listMessages(pair.parent))).toEqual([])
      expect(provider.requests().filter(isParent)).toHaveLength(8)
      const tasks = await subTasks(pair.parent, pair.child)
      expect(tasks).toHaveLength(1)
      expect(tasks[0].status).toBe('done')
    },
    FLOW_TIMEOUT
  )
})

// ─────────────────────────────────────────────────────────────────────────
// C. 用户抢先（WP6-05）

describe('用户先在子会话里答了', () => {
  const P_MARK = 'P5-PARENT-RACE'
  const C_MARK = 'C5-CHILD-TASK'
  const ASK_ID = 'call_c5_ask'
  const isParent = (r: FakeRequest): boolean => r.raw.includes(P_MARK)
  const isChild = (r: FakeRequest): boolean => !isParent(r) && r.lastUserText === C_MARK
  const parentWoken = (r: FakeRequest): boolean =>
    isParent(r) && r.lastUserText.includes('status="waiting-input"')
  const parentAfterDone = (r: FakeRequest): boolean =>
    isParent(r) && r.lastUserText.includes('has finished')

  it(
    'WP6-05 父会话已收到通知、正要代答时用户先答了：answer 如实说什么都没发（带出用户的回答）；子会话只被答一次，记成用户答的；落定之后再答也什么都不发',
    async () => {
      const pair = await newPair('C')
      provider.reset()
      await events.clear()
      provider.script(
        {
          toolCalls: [
            sessionCall('call_c5_prompt', {
              action: 'prompt-session',
              session_id: pair.child,
              message: C_MARK
            })
          ],
          when: isParent
        },
        { text: 'dispatched.', when: isParent },
        {
          toolCalls: [askCall(ASK_ID, 'Q5-keep-cache?', ['OPT-C5-A', 'OPT-C5-B'])],
          when: isChild,
          holdMs: HOLD_MS,
          holdKey: 'child'
        },
        // 被通知叫醒的那一轮：挂住，等用户先答
        {
          toolCalls: [
            sessionCall('call_c5_answer', {
              action: 'answer-session',
              ask_id: ASK_ID,
              selections: ['OPT-C5-A']
            })
          ],
          when: parentWoken,
          holdMs: HOLD_MS,
          holdKey: 'parent'
        },
        { text: 'ok', when: isParent },
        // 用户答完之后子会话的下一步：挂住 —— 父会话的 answer 落在「子会话还在跑这一轮」的时候
        { text: 'C5-CHILD-FINAL', when: isChild, holdMs: HOLD_MS, holdKey: 'child2' },
        // 这一轮落定之后（完成通知叫醒父会话）再答一次：不带 ask_id
        {
          toolCalls: [
            sessionCall('call_c5_late', { action: 'answer-session', selections: ['OPT-C5-A'] })
          ],
          when: parentAfterDone
        },
        { text: 'ok-late', when: isParent }
      )

      await promptSession(pair.parent, P_MARK)
      await waitHeld('child', isChild, 'child turn 1 held')
      provider.release('child')
      // 父会话**已经看到**通知（它被叫醒的那一轮挂着）
      await waitHeld('parent', parentWoken, 'parent woken by the input notice')

      // 扮演用户先答；载荷里伪造一个答题方 —— 宿主不信它
      await respond(pair.child, ASK_ID, {
        kind: 'choice',
        selections: ['OPT-C5-B'],
        answeredBy: { kind: 'parent-session', sessionId: pair.parent, title: 'FORGED' }
      })
      await probe.waitAskGone(pair.child, ASK_ID)
      // 子会话已经接着跑下一步（挂着）：这一轮还是父会话发起、还没结束的那一轮
      await waitHeld('child2', isChild, 'child turn 2 held')

      provider.release('parent')
      const raced = await resultOf(pair.parent, 'call_c5_answer')
      await probe.waitView(pair.parent, (v) => v.run.state !== 'busy', 30_000, 'parent idle')

      // 1. 如实说什么都没发：用户已经答了，带上用户的答案
      expect(raced.isError).toBe(true)
      expect(raced.result).toMatch(/nothing was sent/i)
      expect(raced.result).toContain(
        `Question "${ASK_ID}" in session "${pair.childTitle}" was already answered (most likely by the user in that session): User selected: OPT-C5-B. Nothing was sent.`
      )

      // 子会话这一轮落定 → 完成通知叫醒父会话 → 再答一次（不带 ask_id）
      provider.release('child2')
      await waitAssistant(pair.child, 'C5-CHILD-FINAL')
      const late = await resultOf(pair.parent, 'call_c5_late')
      await waitAssistant(pair.parent, 'ok-late')
      expect(late.isError).toBe(true)
      expect(late.result).toContain(
        `Session "${pair.childTitle}" is not waiting for an answer (status: idle). Nothing was sent.`
      )

      // 2. 子会话只被答了一次，记成用户答的（伪造的答题方被宿主剥掉）
      const asked = await resultsOf(pair.child, ASK_ID)
      expect(asked).toHaveLength(1)
      expect(asked[0].result).toBe('User selected: OPT-C5-B')
      expect((asked[0].details as { answeredBy?: unknown } | undefined)?.answeredBy).toBeUndefined()
      const childTurns = provider.requests().filter(isChild)
      expect(childTurns).toHaveLength(2)
      const seen = toolTextsOf(childTurns[1])
      expect(seen).toContain('User selected: OPT-C5-B')
      expect(seen.some((t) => t.includes('The user did not answer this'))).toBe(false)
      const tasks = await subTasks(pair.parent, pair.child)
      expect(tasks.map((t) => t.status)).toEqual(['done'])
    },
    FLOW_TIMEOUT
  )
})

// ─────────────────────────────────────────────────────────────────────────
// D. 权限卡只转告（WP6-06）

describe('子会话卡在权限卡上', () => {
  const P_MARK = 'P6-PARENT-APPROVAL'
  const C_MARK = 'C6-CHILD-TASK'
  const isParent = (r: FakeRequest): boolean => r.raw.includes(P_MARK)
  const isChild = (r: FakeRequest): boolean => !isParent(r) && r.lastUserText === C_MARK
  const parentWoken = (r: FakeRequest): boolean =>
    isParent(r) && r.lastUserText.includes('status="waiting-input"')

  it(
    'WP6-06 父会话收到的是转告；代答被拒；wait 报 blocked；卡片原样挂着，用户批准后照常跑完',
    async () => {
      const pair = await newPair('D')
      provider.reset()
      await events.clear()
      provider.script(
        {
          toolCalls: [
            sessionCall('call_d_prompt', {
              action: 'prompt-session',
              session_id: pair.child,
              message: C_MARK
            })
          ],
          when: isParent
        },
        { text: 'dispatched.', when: isParent },
        {
          toolCalls: [
            { id: 'call_d_read', name: 'read', args: JSON.stringify({ path: secretPath }) }
          ],
          when: isChild,
          holdMs: HOLD_MS,
          holdKey: 'child'
        },
        {
          toolCalls: [
            sessionCall('call_d_answer', { action: 'answer-session', selections: ['allow'] })
          ],
          when: parentWoken
        },
        {
          toolCalls: [
            sessionCall('call_d_wait', {
              action: 'wait-for-sessions',
              session_id: pair.child
            })
          ],
          when: isParent
        },
        { text: 'P6-RELAYED', when: isParent },
        { text: 'C6-CHILD-FINAL', when: (r) => !isParent(r) && r.raw.includes(SECRET) },
        { text: 'P6-DONE', when: (r) => isParent(r) && r.lastUserText.includes('has finished') }
      )

      await promptSession(pair.parent, P_MARK)
      await waitHeld('child', isChild, 'child turn 1 held')
      provider.release('child')
      const parentMsgs = await waitAssistant(pair.parent, 'P6-RELAYED')

      // 1. 通知是转告：等用户批准、你答不了；没有可代答的问题块
      const notices = systemNotices(parentMsgs)
      expect(notices).toHaveLength(1)
      const notice = notices[0].content
      expect(notice).toContain('stopped to ask the user for approval')
      expect(notice).toContain('<blocked-on-user-approval>')
      const approvalLine = notice.split('\n').find((l) => l.startsWith('- read:')) ?? ''
      expect(approvalLine).toContain(secretPath)
      expect(notice).toContain('you cannot answer it')
      expect(notice).not.toContain('<question')

      // 2. 代答被拒（不点名：blockedError 的非可答分支），带上那张卡的摘要
      const answer = await resultOf(pair.parent, 'call_d_answer')
      expect(answer.isError).toBe(true)
      expect(answer.result).toContain('blocked on a question for the user')
      expect(answer.result).toContain('Tell the user')
      expect(answer.result).toContain('read:')
      expect(answer.result).toContain(secretPath)

      // 3. wait 报 blocked，尾注说只有用户能答
      const waited = await resultOf(pair.parent, 'call_d_wait')
      expect(waited.result).toContain('<sessions status="blocked">')
      expect(waited.result.split('</sessions>')[1] ?? '').toContain('only the user can answer')

      // 4. 卡片原样挂着；任务仍在等输入
      const card = (await probe.viewOf(pair.child))?.asks.find((a) => a.kind === 'ask')
      expect(card, 'the approval card is still pending').toBeDefined()
      const waiting = await subTasks(pair.parent, pair.child)
      expect(waiting.map((t) => t.status)).toEqual(['waiting-input'])

      // 5. 用户批准 → 照常跑完 → 父会话收到完成通知并续跑
      await respond(pair.child, card!.id, { kind: 'ask', allowed: true, selections: [] })
      const done = await waitAssistant(pair.parent, 'P6-DONE')
      const childTurn2 = provider.requests().find((r) => !isParent(r) && r.raw.includes(SECRET))
      expect(childTurn2, 'child saw the file after approval').toBeDefined()
      expect(toolTextsOf(childTurn2!).some((t) => t.includes(SECRET))).toBe(true)
      const finished = systemNotices(done).filter((m) => m.content.includes('has finished'))
      expect(finished).toHaveLength(1)
      expect(finished[0].content).toContain('wait-for-sessions')
      await until(
        async () => (await subTasks(pair.parent, pair.child))[0]?.status === 'done' || null,
        'sub-session task done'
      )
    },
    FLOW_TIMEOUT
  )
})

// ─────────────────────────────────────────────────────────────────────────
// E. 用户自己发起的一轮（WP6-07）

describe('用户在子会话里自己发起的一轮', () => {
  const P_MARK = 'P7-PARENT-FIRST'
  const P_SECOND = 'P7-PARENT-SECOND'
  const C0 = 'C7-CHILD-FIRST'
  const U = 'U7-USER-OWN-TURN'
  const ASK_ID = 'call_e_ask'
  const isParent = (r: FakeRequest): boolean => r.raw.includes(P_MARK)
  const parentFirst = (r: FakeRequest): boolean => isParent(r) && r.lastUserText === P_MARK
  const parentSecond = (r: FakeRequest): boolean => isParent(r) && r.lastUserText === P_SECOND
  const childFirst = (r: FakeRequest): boolean => !isParent(r) && r.lastUserText === C0
  const childOwn = (r: FakeRequest): boolean => !isParent(r) && r.lastUserText === U

  it(
    'WP6-07 父会话驱动的那一轮落定之后用户自己发起一轮、模型问了一句：父会话不收通知、没有任务；read 标 for="user"；answer / steer 被拒；询问原样挂着',
    async () => {
      const pair = await newPair('E')
      provider.reset()
      await events.clear()
      provider.script(
        {
          toolCalls: [
            sessionCall('call_e_prompt', {
              action: 'prompt-session',
              session_id: pair.child,
              message: C0
            })
          ],
          when: parentFirst
        },
        // 挂住，等父会话的 wait 握着它再放：那一轮在父会话这一轮里交回，不另发完成通知（③ 要的就是「没有通知」）
        { text: 'C7-FIRST-DONE', when: childFirst, holdMs: HOLD_MS, holdKey: 'child' },
        {
          toolCalls: [
            sessionCall('call_e_wait', {
              action: 'wait-for-sessions',
              session_id: pair.child
            })
          ],
          when: parentFirst
        },
        { text: 'ok', when: parentFirst },
        { toolCalls: [askCall(ASK_ID, 'Q7-which-db?', ['OPT-E-A', 'OPT-E-B'])], when: childOwn },
        {
          toolCalls: [sessionCall('call_e_read', { action: 'read-session' })],
          when: parentSecond
        },
        {
          toolCalls: [
            sessionCall('call_e_answer', {
              action: 'answer-session',
              ask_id: ASK_ID,
              selections: ['OPT-E-A']
            })
          ],
          when: parentSecond
        },
        {
          toolCalls: [sessionCall('call_e_steer', { action: 'steer-session', message: 'STEER-E' })],
          when: parentSecond
        },
        { text: 'P7-DONE', when: parentSecond },
        { text: 'U7-FINAL', when: childOwn }
      )

      // ① 父会话驱动的一轮落定（这条子会话被驱动过、那一轮已销账），由 wait 在同一轮里收回
      const first = promptSession(pair.parent, P_MARK).catch((error: unknown) => error)
      await waitHeld('child', childFirst, 'child first turn held')
      await waitArmed(pair.parent, 'call_e_wait')
      provider.release('child')
      await first
      expect(hasAssistantText(await listMessages(pair.child), 'C7-FIRST-DONE')).toBe(true)
      expect((await resultOf(pair.parent, 'call_e_wait')).result).toContain(
        '<reply>\nC7-FIRST-DONE\n</reply>'
      )

      // ② 用户自己在子会话里发起一轮，模型问了一句
      await sendPrompt(pair.child, U)
      await probe.waitView(
        pair.child,
        (v) => v.asks.some((a) => a.id === ASK_ID),
        30_000,
        'child asking in the user turn'
      )
      const mark = provider.requests().length
      await quiet()

      // ③ 父会话不收通知、没有被叫醒、没有活着的子会话任务
      expect(systemNotices(await listMessages(pair.parent))).toEqual([])
      expect(provider.requests().slice(mark).filter(isParent)).toEqual([])
      const tasks = await subTasks(pair.parent, pair.child)
      expect(tasks.filter((t) => t.endedAt === null)).toEqual([])
      expect(tasks.map((t) => t.status)).toEqual(['done'])

      // ④ 父会话来读、来答、来插话
      await promptSession(pair.parent, P_SECOND)

      const read = await resultOf(pair.parent, 'call_e_read')
      expect(read.result).toContain('status="waiting-input"')
      expect(openTagOf(read.result, pair.child)).toContain('user-intervened="true"')
      expect(read.result).toContain(`<question ask_id="${ASK_ID}" for="user">`)
      expect(read.result).toContain('only the user answers it')
      expect(read.result).not.toContain('You may answer it for the user')

      const answer = await resultOf(pair.parent, 'call_e_answer')
      expect(answer.isError).toBe(true)
      expect(answer.result).toContain('is not in a turn you are driving now')
      expect(answer.result).toContain('it is not yours to answer')
      expect(answer.result).toContain('Nothing was sent')

      const steer = await resultOf(pair.parent, 'call_e_steer')
      expect(steer.isError).toBe(true)
      expect(steer.result).toContain('was not started by you')
      const childView = await probe.viewOf(pair.child)
      expect(childView?.queue).toEqual([])
      // 询问在 ④ 期间一直挂着
      expect(childView?.asks.some((a) => a.id === ASK_ID)).toBe(true)
      expect((await listMessages(pair.child)).some((m) => m.content.includes('STEER-E'))).toBe(
        false
      )

      // ⑤ 扮演用户答 → 子会话跑完；用户自己的一轮落定不回报父会话
      await respond(pair.child, ASK_ID, { kind: 'choice', selections: ['OPT-E-B'] })
      await waitAssistant(pair.child, 'U7-FINAL')
      const asked = await resultsOf(pair.child, ASK_ID)
      expect(asked).toHaveLength(1)
      expect(asked[0].result).toBe('User selected: OPT-E-B')
      expect((asked[0].details as { answeredBy?: unknown } | undefined)?.answeredBy).toBeUndefined()
      await quiet()
      expect(systemNotices(await listMessages(pair.parent))).toEqual([])
    },
    FLOW_TIMEOUT
  )
})

// ─────────────────────────────────────────────────────────────────────────
// F. 引导与查看现场（WP6-08 / 09 / 10 一条流程）

describe('steer 落进跑着的一轮；inspect 的大纲 / 展开 / 搜索', () => {
  const P_MARK = 'P8-PARENT-STEER'
  const C_MARK = 'C8-CHILD-TASK'
  const PARENT_STEER = 'PARENT-STEER-F8'
  const USER_STEER = 'USER-STEER-F8 别动 legacy/ 目录'
  const isParent = (r: FakeRequest): boolean => r.raw.includes(P_MARK)
  const isChild = (r: FakeRequest): boolean => !isParent(r) && r.lastUserText === C_MARK
  /** 引导落下之后子会话的各步：不是父会话 + 带着父会话的引导 */
  const childSteered = (r: FakeRequest): boolean => !isParent(r) && r.raw.includes(PARENT_STEER)
  const parentAfterDone = (r: FakeRequest): boolean =>
    isParent(r) && r.lastUserText.includes('has finished')

  let pair: Pair
  let missingPath = ''
  /** 大纲里失败那一行的编号（T6 在认领时从 T5 的结果里解析出来） */
  let failedRef = ''
  let since = 0

  it(
    'WP6-08 steer 落进父会话发起、正在跑的那一轮，子会话在下一步看到；结果仍经这一轮交回；空闲时被拒',
    async () => {
      pair = await newPair('F')
      missingPath = join(projDir, 'missing-f8.txt')
      provider.reset()
      await events.clear()
      since = await events.mark()
      provider.script(
        {
          toolCalls: [
            sessionCall('call_f_prompt', {
              action: 'prompt-session',
              session_id: pair.child,
              message: C_MARK
            })
          ],
          when: isParent
        },
        // 引导要在子会话那一轮跑着的时候送到：挂住，等子会话的第一步也挂上了再放
        {
          toolCalls: [
            sessionCall('call_f_steer', {
              action: 'steer-session',
              session_id: pair.child,
              message: PARENT_STEER
            })
          ],
          when: isParent,
          holdMs: HOLD_MS,
          holdKey: 'parent'
        },
        { text: 'steered.', when: isParent },
        {
          toolCalls: [{ id: 'call_f_ls', name: 'ls', args: JSON.stringify({ path: projDir }) }],
          when: isChild,
          holdMs: HOLD_MS,
          holdKey: 'child'
        },
        {
          toolCalls: [
            { id: 'call_f_missing', name: 'read', args: JSON.stringify({ path: missingPath }) }
          ],
          when: childSteered
        },
        { text: 'F8-CHILD-FINAL', when: childSteered },
        {
          toolCalls: [sessionCall('call_f_read', { action: 'read-session' })],
          when: parentAfterDone
        },
        {
          toolCalls: [sessionCall('call_f_outline', { action: 'inspect-session' })],
          when: isParent
        },
        {
          // 编号来自条目 id，写不死：从上一步（大纲）的结果里取失败那一行
          when: isParent,
          build: (req) => {
            const outline = toolTextsOf(req).at(-1) ?? ''
            const m = /^(#\S+) read .* — FAILED: File not found/m.exec(outline)
            if (!m) throw new Error(`no failed read line in the outline:\n${outline.slice(0, 600)}`)
            failedRef = m[1]
            return {
              toolCalls: [sessionCall('call_f_item', { action: 'inspect-session', item: m[1] })]
            }
          }
        },
        {
          toolCalls: [sessionCall('call_f_match', { action: 'inspect-session', match: SEED_FILE })],
          when: isParent
        },
        {
          toolCalls: [
            sessionCall('call_f_late', { action: 'steer-session', message: 'LATE-STEER' })
          ],
          when: isParent
        },
        { text: 'P8-DONE', when: isParent }
      )

      // 这一轮的 T2 挂着，不能 await：先认两个 hold，再放
      const first = promptSession(pair.parent, P_MARK).catch((error: unknown) => error)
      await waitHeld('child', isChild, 'child turn 1 held')
      await waitHeld('parent', isParent, 'parent steer turn held')
      provider.release('parent')
      await first

      // 用户也在这一轮里插一句（与父会话的引导一起排着）
      await app.main.eval(
        `window.api.agent.steer(${JSON.stringify({ sessionId: pair.child, text: USER_STEER })})`
      )
      await probe.waitView(pair.child, (v) => v.queue.length === 2, 30_000, 'both steers queued')
      provider.release('child')
      const parentMsgs = await waitAssistant(pair.parent, 'P8-DONE')

      // 1. steer 送到
      const steer = await resultOf(pair.parent, 'call_f_steer')
      expect(steer.isError).toBe(false)
      expect(steer.result).toContain('status="running"')
      expect(steer.result).toContain('Steer delivered — it reads it at its next step')

      // 2. 子会话下一步就看到：ls 的结果之后紧跟父会话的引导（不是新开一轮的首条消息）
      const next = provider.requests().find(childSteered)
      expect(next).toBeDefined()
      const seen = messageTextsOf(next!)
      const toolAt = seen.findIndex((m) => m.role === 'tool')
      expect(toolAt).toBeGreaterThan(0)
      expect(seen[toolAt].text).toContain(SEED_FILE)
      const usersAfter = seen
        .slice(toolAt + 1)
        .filter((m) => m.role === 'user')
        .map((m) => m.text)
      expect(usersAfter).toContain(PARENT_STEER)
      // 引导之前只有那一条任务（不是新开一轮的首条消息）
      expect(userTextsOf(next!).slice(0, 1)).toEqual([C_MARK])

      // 3. 子会话的用户消息依次三条，引导没有起新的一轮
      const childMsgs = await listMessages(pair.child)
      expect(userMessages(childMsgs)).toEqual([C_MARK, PARENT_STEER, USER_STEER])
      const childStarts = async (): Promise<number> =>
        (await events.allSince(since)).filter(
          (e) => e.type === 'agent_start' && e.sessionId === pair.child
        ).length
      expect(await childStarts()).toBe(1)

      // 4. 父会话收到一条完成通知；结果由这一轮原来那条任务交回（steer 没另建任务）
      const notices = systemNotices(parentMsgs)
      expect(notices).toHaveLength(1)
      expect(notices[0].content).toContain('has finished')
      expect(await subTasks(pair.parent, pair.child)).toHaveLength(1)

      // 5. 空闲时 steer 被拒，指向 prompt；子会话没有新的一轮
      const late = await resultOf(pair.parent, 'call_f_late')
      expect(late.isError).toBe(true)
      expect(late.result).toContain('is idle')
      expect(late.result).toContain('prompt-session')
      await quiet()
      expect((await listMessages(pair.child)).some((m) => m.content.includes('LATE-STEER'))).toBe(
        false
      )
      expect(await childStarts()).toBe(1)
    },
    FLOW_TIMEOUT
  )

  it('WP6-09 inspect 大纲：来源标记、一轮不被插话切开、失败行带错误首行、工具结果不出现、全在围栏里；read / 完成通知带 user-intervened', async () => {
    // 1. read 的开标签带 user-intervened；完成通知同样带
    const read = await resultOf(pair.parent, 'call_f_read')
    expect(openTagOf(read.result, pair.child)).toContain('user-intervened="true"')
    expect(read.result).toContain('<reply>\nF8-CHILD-FINAL\n</reply>')
    const notice = systemNotices(await listMessages(pair.parent))[0]?.content ?? ''
    expect(notice.split('\n')[0]).toContain('user-intervened="true"')

    // 2. 大纲：两条插话没有把这一轮切成两轮
    const outline = (await resultOf(pair.parent, 'call_f_outline')).result
    expect(outline).toMatch(/<transcript turns="1 of 1" shown="(\d+)\/\1">/)
    const open = outline.indexOf('<transcript ')
    const close = outline.indexOf('</transcript>')
    expect(open).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(open)
    const body = outline.slice(open, close)
    expect(body).toMatch(/^#\S+ \[you\] C8-CHILD-TASK/m)
    expect(body).toMatch(/^#\S+ \[you\] PARENT-STEER-F8/m)
    expect(body).toMatch(/^#\S+ \[user\] USER-STEER-F8/m)
    expect(body).toMatch(/^#\S+ read .* — FAILED: File not found/m)
    const finalAt = outline.indexOf('F8-CHILD-FINAL')
    expect(finalAt).toBeGreaterThan(open)
    expect(finalAt).toBeLessThan(close)
    // ls 的结果不进大纲
    expect(outline).not.toContain(SEED_FILE)
    // 围栏外是用法提示
    const outside = outline.slice(outline.indexOf('</session>'))
    expect(outside).toContain('item')
    expect(outside).toContain('match')

    // 3. 编号与界面同源：失败行的条目编号就是子会话里那张卡的 id（message.list / data-msg-id）
    expect(failedRef).not.toBe('')
    const failedCard = (await listMessages(pair.child)).find((m) =>
      (m.blocks ?? []).some((b) => b.toolCallId === 'call_f_missing' && b.isError)
    )
    expect(failedCard).toBeDefined()
    expect(failedRef.slice(1).split('.')[0]).toBe(failedCard!.id)
  })

  it('WP6-10 inspect 按编号展开一条、按文字搜索整段历史', async () => {
    // 1. 展开失败那一行：工具名、状态、参数、结果
    const item = (await resultOf(pair.parent, 'call_f_item')).result
    expect(item).toContain(`<transcript item="${failedRef}">`)
    expect(item).toContain('tool: read')
    expect(item).toContain('status: failed')
    const lines = item.split('\n')
    expect(lines.find((l) => l.startsWith('args:')) ?? '').toContain('missing-f8.txt')
    const resultAt = lines.findIndex((l) => l === 'result:')
    expect(resultAt).toBeGreaterThan(-1)
    expect(lines.slice(resultAt + 1).join('\n')).toContain('File not found')

    // 2. 搜索覆盖大纲里隐藏的工具结果：命中的是 ls 那一行（行本身不含该串，带片段）
    const match = (await resultOf(pair.parent, 'call_f_match')).result
    expect(match).toContain(`<transcript match="${SEED_FILE}" hits="1" shown="1">`)
    const hit = match.split('\n').find((l) => l.startsWith('#')) ?? ''
    expect(hit).toMatch(/^#\S+ ls /)
    const [line, ...snippet] = hit.split('  … ')
    expect(line).not.toContain(SEED_FILE)
    expect(snippet.join('  … ')).toContain(SEED_FILE)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// G. 父会话被停不级联（§20）

describe('父会话被停：派出去的子会话照跑完', () => {
  const P_MARK = 'P9-PARENT-STOP'
  const P_NEXT = 'P9-PARENT-NEXT'
  const C_MARK = 'C9-CHILD-TASK'
  const isParent = (r: FakeRequest): boolean => r.raw.includes(P_MARK)
  const isChild = (r: FakeRequest): boolean => !isParent(r) && r.lastUserText === C_MARK

  it(
    'BG-E2 停止父会话：子会话那一轮不跟着停、照常答完，任务落到 done；父会话不被叫醒，完成通知随用户下一句话送到模型',
    async () => {
      const pair = await newPair('G')
      provider.reset()
      await events.clear()
      provider.script(
        {
          toolCalls: [
            sessionCall('call_g_prompt', {
              action: 'prompt-session',
              session_id: pair.child,
              message: C_MARK
            })
          ],
          when: isParent
        },
        // 父会话的下一步挂住：停止落在它还在跑的时候
        { text: 'P9-NEVER', when: isParent, holdMs: HOLD_MS, holdKey: 'parent' },
        // 子会话那一轮挂住：父会话被停的那一刻它一定还在跑
        { text: 'C9-CHILD-FINAL', when: isChild, holdMs: HOLD_MS, holdKey: 'child' },
        { text: 'P9-NEXT-DONE', when: (r) => isParent(r) && r.raw.includes(P_NEXT) }
      )

      // 任务面板只画活动会话 —— 父会话先在侧栏里打开
      await until(
        async () => (await sidebar.titles()).includes(pair.parentTitle) || null,
        'parent listed'
      )
      expect(await sidebar.openSession(pair.parentTitle)).toBe(true)

      await sendPrompt(pair.parent, P_MARK)
      await waitHeld('child', isChild, 'child turn held')
      const parentStep = await waitHeld('parent', isParent, 'parent next step held')
      const receipt = await resultOf(pair.parent, 'call_g_prompt')
      expect(receipt.result).toContain('Started in the background')
      expect(backgroundTagOf(receipt)).toBe(true)

      // 1. 用户停掉父会话（点「停止生成」的同一条 IPC）
      await app.main.eval(`window.api.agent.abort(${JSON.stringify(pair.parent)})`)
      await probe.waitView(pair.parent, (v) => v.run.state !== 'busy', 30_000, 'parent stopped')
      await until(() => parentStep.aborted || null, "parent's held request aborted")

      // 2. 子会话那一轮没被级联中止：请求还挂着、没断开，会话还在跑，任务还开着
      expect(provider.heldRequest('child')?.aborted).toBe(false)
      expect((await probe.viewOf(pair.child))?.run.state).toBe('busy')
      const open = await subTasks(pair.parent, pair.child)
      expect(open).toHaveLength(1)
      expect(open[0].endedAt).toBeNull()

      // 3. 放行 → 子会话照常答完：一条任务、一条答复，没有中止 / 错误那一行
      const mark = provider.requests().length
      provider.release('child')
      const childMsgs = await waitAssistant(pair.child, 'C9-CHILD-FINAL')
      expect(childMsgs.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(userMessages(childMsgs)).toEqual([C_MARK])
      expect(
        provider
          .requests()
          .filter(isChild)
          .map((r) => r.aborted)
      ).toEqual([false])

      // 4. 任务落到 done：枢纽与面板行
      await until(
        async () => (await subTasks(pair.parent, pair.child))[0]?.status === 'done' || null,
        'sub-session task done'
      )
      const tasks = tasksPanelPane(app.main)
      await tasks.open()
      await until(
        async () =>
          (await tasks.rows()).some(
            (r) => r.kind === 'sub-session' && r.title === pair.childTitle && r.status === 'done'
          ) || null,
        'sub-session task row done'
      )

      // 5. 父会话刚被用户停过：完成通知写进它的对话（一条），但不起自动续跑 —— 静默窗里没有新的模型请求
      await until(
        async () =>
          systemNotices(await listMessages(pair.parent)).some((m) =>
            m.content.includes('has finished')
          ) || null,
        'completion notice written into the stopped parent'
      )
      await quiet()
      expect(provider.requests().slice(mark).filter(isParent)).toEqual([])
      expect((await probe.viewOf(pair.parent))?.run.state).not.toBe('busy')

      // 6. 用户再说一句：这一次请求里模型看得到那条完成通知（在这句话之前）
      await promptSession(pair.parent, P_NEXT)
      const next = provider.requests().slice(mark).filter(isParent)
      expect(next).toHaveLength(1)
      const users = userTextsOf(next[0])
      const noticeAt = users.findIndex(
        (t) => t.includes(`<session id="${pair.child}"`) && t.includes('has finished')
      )
      expect(noticeAt).toBeGreaterThan(-1)
      expect(users.lastIndexOf(P_NEXT)).toBeGreaterThan(noticeAt)
      const parentMsgs = await waitAssistant(pair.parent, 'P9-NEXT-DONE')
      expect(systemNotices(parentMsgs)).toHaveLength(1)
    },
    FLOW_TIMEOUT
  )
})
