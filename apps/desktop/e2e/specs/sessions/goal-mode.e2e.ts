/**
 * 目标（`/goal`，docs/goal-mode-design.md §16，实验）—— 管理员的说明文字、宿主的拒绝、通知的安静各有单测，这里只走一遍
 * 它们替身掉的那条链：真输入框里写 `/goal <条件>` 回车 → `agent.goalStart` → goalService fork 这条会话、给 fork 一行对原
 * 会话的「对话」权限、以人的来源把带「目标」Token 的消息发进 fork → 界面切到 fork（管理员）→ 管理员用真的 `session`
 * 工具把任务发给原会话（不弹权限卡片）→ 原会话那一轮结束 → 完成通知把空闲的管理员叫回来（设置 `session.autoResume`
 * 关着也一样）→ 管理员收尾。
 *
 *   G-1 原会话先聊过一句；`/goal <条件>` + 回车：出现一条管理员会话（`settings.goalManagerOf` = 原会话、标题 = 目标原文、
 *       侧栏 ◎），界面切到它、输入框清空、用户气泡带「目标」胶囊；发给管理员的第一个请求是原文 + `<goal-set>` 说明
 *       （点名原会话的 id 与标题、身份是管理员），历史里有设目标之前那句话；它调 `session`/`prompt-session` 把任务发给
 *       原会话 —— 没有权限卡片，原会话收到任务（带发送方说明）；原会话那一轮挂着时管理员已经停下来等
 *   G-2 放行：原会话汇报 → 管理员被叫回来（请求里是 `<session …>` 完成通知，让它用 `wait-for-sessions` 去取）→ 它取回
 *       汇报（工具结果里是原会话的原话）→ 说出结论；管理员四个请求、原会话两个，没有别的 agent
 *   G-3 被拒的几种（IPC）：在管理员会话里再设目标；原会话正在跑；原会话的管理员还在忙。都不留下新会话
 *   G-4 管理员第一轮先 `ask`：卡片就在界面切过去的那条对话里等人；答了 → 同一轮接着跑、把任务发给原会话 → 汇报 → 收尾
 *
 * 请求按内容认领：管理员的请求历史里有 `<goal-set id=`（设目标那条消息的说明），原会话的没有。会话标题都不是缺省标题：
 * 自动标题不跑；审查在 harness 里本就关着。DOM 只经 `harness/pages.ts`。设了 `GOAL_E2E_SHOTS=<目录>` 时在
 * (a) 管理员派完活在等、(b) 管理员收尾 两处存整窗截图给人看；不设就不截。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  startFakeProvider,
  type FakeProvider,
  type FakeRequest,
  type FakeTurn
} from '../../harness/fakeProvider'
import {
  createProject,
  requestToolNames,
  seedFakeProvider,
  waitRendererReady
} from '../../harness/seed'
import {
  chatPane,
  goalPane,
  inlineAskPane,
  sidebarPane,
  type ChatPane,
  type GoalPane,
  type InlineAskPane,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const TITLES = { loop: 'Goal loop', refuse: 'Goal refuse', asks: 'Goal asks' }
/** 都不超过 60 字：管理员会话的标题就是原文（更长的截断由单测管） */
const OBJECTIVES = {
  loop: 'G1: write notes.txt in the project with the word READY',
  refuse: 'G3: keep the manager busy for a while',
  asks: 'G4: speed up the build'
}
const BEFORE_GOAL = 'Remember: the marker colour is BLUE'
const TASK =
  'Task from the goal manager: create notes.txt containing READY and show `cat notes.txt`.'
const WORKER_REPORT = 'Done. `cat notes.txt` prints READY.'
const MANAGER_WAITING = 'Criteria: notes.txt exists and contains READY. Handed to the worker.'
const MANAGER_FINAL = 'Goal met: the worker showed notes.txt containing READY.'
const ASK_QUESTION = 'Which build should get faster?'
const ASK_OPTIONS = [
  { label: 'Release build (recommended)', description: 'What ships' },
  { label: 'Dev build', description: 'What you run every day' }
]

interface SessionRow {
  id: string
  title: string
  settings?: { goalManagerOf?: string; titleOrigin?: string } | null
}

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let goals: GoalPane
let asks: InlineAskPane
let projDir = ''
const sids: Record<keyof typeof TITLES, string> = { loop: '', refuse: '', asks: '' }

// ─── 请求认领 ───

/** 管理员的请求：历史里有设目标那条消息的说明 */
const isManager = (req: FakeRequest): boolean => req.raw.includes('<goal-set id=')
const isWorker = (req: FakeRequest): boolean => !isManager(req)

const managerTurn = (turn: Omit<FakeTurn, 'when'>): FakeTurn => ({
  usage: { prompt: 80, completion: 5 },
  ...turn,
  when: isManager
})
const workerTurn = (turn: Omit<FakeTurn, 'when'>): FakeTurn => ({
  usage: { prompt: 80, completion: 5 },
  ...turn,
  when: isWorker
})

let callSeq = 0
/** 管理员的一轮：被叫回来之后用 `session` 工具取回原会话那一轮的汇报 */
const collect = (workerId: string): FakeTurn =>
  managerTurn({
    toolCalls: [
      {
        id: `call_collect_${++callSeq}`,
        name: 'session',
        args: JSON.stringify({ action: 'wait-for-sessions', session_id: workerId })
      }
    ]
  })

/** 管理员的一轮：调 `session` 工具把任务发给原会话 */
const handOff = (workerId: string, message: string): FakeTurn =>
  managerTurn({
    toolCalls: [
      {
        id: `call_hand_${++callSeq}`,
        name: 'session',
        args: JSON.stringify({ action: 'prompt-session', session_id: workerId, message })
      }
    ]
  })

// ─── 助手 ───

const sessionRows = (): Promise<SessionRow[]> =>
  app.main.eval<SessionRow[]>(`window.api.session.list()`)

/** 原会话的管理员们（按会话行上的 `goalManagerOf`） */
const managersOf = async (workerId: string): Promise<SessionRow[]> =>
  (await sessionRows()).filter((row) => row.settings?.goalManagerOf === workerId)

const goalStart = (
  sessionId: string,
  objective: string
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> =>
  app.main.eval(`window.api.agent.goalStart(${JSON.stringify({ sessionId, objective })})`)

const openSession = async (title: string): Promise<void> => {
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

/** 真输入框：`/goal <条件>`（打出空格那一刻转成内置命令的芯片）+ 回车 */
const setGoalInComposer = async (objective: string): Promise<void> => {
  await chat.type(`/goal ${objective}`)
  await chat.pressEnter()
}

/** 侧栏这一行彻底落定：不在跑（连续两次） */
const waitRowSettled = async (title: string): Promise<void> => {
  await until(async () => {
    if (await sidebar.rowRunning(title)) return false
    await sleep(400)
    return !(await sidebar.rowRunning(title))
  }, `${title} settled`)
}

/** 当前对话里出现了这段助手正文 */
const waitReply = (text: string, timeoutMs = 30_000): Promise<unknown> =>
  until(
    async () => (await chat.settledItems()).some((item) => item.text.includes(text)) || null,
    `reply "${text.slice(0, 30)}"`,
    timeoutMs
  )

/** 整窗截图（给人看的证据，不是断言）；没设 GOAL_E2E_SHOTS 就什么都不做 */
async function shot(name: string): Promise<void> {
  const dir = process.env.GOAL_E2E_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const res = await app.main.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(dir, `${name}.png`), Buffer.from(res.data, 'base64'))
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  // 自动续跑关着：别的会话的完成通知只写不起轮 —— 管理员不看这个开关（用户设了目标就是要它自己接着推），
  // G-2 / G-4 里它照样被叫回来
  await app.main.eval(`window.api.settings.set({ key: 'session.autoResume', value: 'false' })`)

  projDir = join(app.home, 'proj-goal')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'README.md'), '# goal e2e\n')
  const project = await createProject(app.main, { name: 'GoalProj', path: projDir })
  for (const key of Object.keys(TITLES) as Array<keyof typeof TITLES>) {
    sids[key] = await app.main.eval<string>(
      `window.api.session.create(${JSON.stringify({ title: TITLES[key], projectId: project.id })}).then((s) => s.id)`
    )
  }

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  goals = goalPane(app.main)
  asks = inlineAskPane(app.main)
  // IPC 建的会话：点一次「新对话」让侧栏拉全量列表
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes(TITLES.asks), 'sidebar lists sessions')
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('设目标 → 管理员派活 → 汇报 → 收尾', () => {
  let managerId = ''

  it('G-1 /goal + 回车：fork 出管理员、界面切过去，管理员不问权限就把任务发给原会话，然后停下来等', async () => {
    provider.reset()
    // 设目标之前，原会话先聊过一句：管理员是它的拷贝，这句话得在管理员的历史里
    provider.script(workerTurn({ text: 'Noted: BLUE.' }))
    await openSession(TITLES.loop)
    await chat.type(BEFORE_GOAL)
    await chat.pressEnter()
    await waitReply('Noted: BLUE.')
    await waitRowSettled(TITLES.loop)
    expect(await managersOf(sids.loop)).toHaveLength(0)
    expect(await sidebar.goalMarkOf(TITLES.loop)).toBeNull()

    // 管理员：派活 → 说一句验收条件、结束这一轮；原会话：汇报，挂在收尾之前（G-2 放行）
    provider.script(
      handOff(sids.loop, TASK),
      managerTurn({ text: MANAGER_WAITING }),
      workerTurn({ text: WORKER_REPORT, holdMs: 60_000 })
    )
    await setGoalInComposer(OBJECTIVES.loop)
    await until(() => provider.holding(), 'worker turn held', 30_000)

    // 一条管理员会话：会话行记着它管的是谁，标题是目标原文（人起的名字，自动标题不动它）
    const managers = await managersOf(sids.loop)
    expect(managers).toHaveLength(1)
    const manager = managers[0]!
    managerId = manager.id
    expect(manager.id).not.toBe(sids.loop)
    expect(manager.title).toBe(OBJECTIVES.loop)
    expect(manager.settings?.titleOrigin).toBe('user')

    // 界面切到了管理员：侧栏选中的是它、带 ◎；原会话不带
    await until(
      async () => (await sidebar.activeTitle()) === OBJECTIVES.loop,
      'manager session is the active one'
    )
    expect(await sidebar.goalMarkOf(OBJECTIVES.loop)).toBe('manager')
    expect(await sidebar.goalMarkOf(TITLES.loop)).toBeNull()

    // 输入框清空；管理员对话里的用户气泡带「目标」胶囊，正文是原文
    expect(await chat.inputValue()).toBe('')
    const chipped = await until(async () => {
      const ids = await goals.goalChipMessages()
      return ids.length > 0 ? ids : null
    }, 'user bubble with the goal chip')
    expect(chipped).toHaveLength(1)
    const bubble = (await chat.settledItems()).find((i) => i.id === chipped[0])
    expect(bubble?.text).toContain(OBJECTIVES.loop)
    expect(bubble?.text).not.toContain('<goal-set')
    // 管理员说了验收条件、停下来等；没有权限卡片（设目标时宿主已经给了它对原会话的「对话」权限）
    await waitReply(MANAGER_WAITING)
    expect(await asks.cardKind()).toBeNull()

    const reqs = provider.requests()
    const managerReqs = reqs.filter(isManager)
    const workerReqs = reqs.filter(isWorker)
    // 设目标之前那一句（原会话）+ 任务（原会话，挂着）；管理员：设目标那条 + 工具结果之后那条
    expect(workerReqs).toHaveLength(2)
    expect(managerReqs).toHaveLength(2)

    // 发给管理员的是人的消息：原文在前，系统写的 `<goal-set>` 说明在后 —— 身份是管理员，点名原会话的 id 与标题
    const first = managerReqs[0]!
    expect(first.lastUserText.startsWith(OBJECTIVES.loop)).toBe(true)
    expect(first.lastUserText).toMatch(/<goal-set id="g_[0-9a-f]{8}">/)
    expect(first.lastUserText).toContain('you are the manager of this goal')
    expect(first.lastUserText).toContain(`("${TITLES.loop}", session id ${sids.loop})`)
    expect(first.lastUserText).toContain('What you must not do: any of the work.')
    // 它是原会话的拷贝：设目标之前那句话在历史里；工具还是那一组（派活用的 session、问人用的 ask 都在）
    expect(first.raw).toContain(BEFORE_GOAL)
    expect(requestToolNames(first)).toEqual(expect.arrayContaining(['session', 'ask']))
    // 工具结果是回执：已经发出去、那一轮结束时会被叫回来
    expect(managerReqs[1]!.raw).toContain(sids.loop)

    // 原会话收到的是管理员写的任务，末尾带发送方说明（另一条会话、不是用户写的）
    const task = workerReqs[1]!
    expect(task.lastUserText).toBe(TASK)
    expect(task.lastUserFullText).toContain(`[Sent by another session (id ${managerId}`)
    expect(task.lastUserFullText).toContain('An agent there wrote this, not the user.')
    // 原会话没见过设目标那条消息（它在管理员那边）
    expect(task.raw).not.toContain('<goal-set')
    await shot('a-manager-waiting')
  }, 120_000)

  it('G-2 原会话汇报 → 完成通知把管理员叫回来（自动续跑关着也一样）→ 它取回汇报、说出结论', async () => {
    provider.script(collect(sids.loop), managerTurn({ text: MANAGER_FINAL }))
    provider.release()

    // 界面还在管理员会话里：结论出现在这条对话里
    await waitReply(MANAGER_FINAL, 60_000)
    await waitRowSettled(OBJECTIVES.loop)
    await waitRowSettled(TITLES.loop)

    const reqs = provider.requests()
    const managerReqs = reqs.filter(isManager)
    expect(managerReqs).toHaveLength(4)
    expect(reqs.filter(isWorker)).toHaveLength(2)
    // 叫回来的那一轮：正文是原会话那一轮的完成通知（不带汇报，让它自己去取）
    const woken = managerReqs[2]!
    expect(woken.lastUserText).toContain(`<session id="${sids.loop}"`)
    expect(woken.lastUserText).toContain('The turn you started in the background has finished.')
    expect(woken.lastUserText).not.toContain(WORKER_REPORT)
    // 取回来的工具结果里是原会话的原话
    expect(managerReqs[3]!.raw).toContain(WORKER_REPORT)
    // 没有别的管理员冒出来
    expect((await managersOf(sids.loop)).map((row) => row.id)).toEqual([managerId])
    await shot('b-manager-final')
  }, 120_000)
})

describe('被拒', () => {
  it('G-3 管理员会话里再设目标 / 原会话正在跑 / 原会话的管理员还在忙：都给一句话，不留下新会话', async () => {
    provider.reset()
    const before = (await sessionRows()).length

    // (1) 管理员自己不能再当原会话：要改目标，直接跟它说
    const loopManager = (await managersOf(sids.loop))[0]!
    const onManager = await goalStart(loopManager.id, 'another goal')
    expect(onManager).toMatchObject({ ok: false })
    expect((onManager as { error: string }).error).toContain('already manages a goal')

    // (2) 原会话正在跑：fork 要它空闲
    provider.script(workerTurn({ text: 'Busy for a while.', holdMs: 60_000 }))
    await openSession(TITLES.refuse)
    await chat.type('Do something slow')
    await chat.pressEnter()
    await until(() => provider.holding(), 'refuse session turn held', 30_000)
    const whileBusy = await goalStart(sids.refuse, OBJECTIVES.refuse)
    expect(whileBusy).toMatchObject({ ok: false })
    expect((whileBusy as { error: string }).error).toContain('in the middle of a turn')
    provider.release()
    await waitReply('Busy for a while.')
    await waitRowSettled(TITLES.refuse)
    expect((await sessionRows()).length).toBe(before)

    // (3) 它的管理员还在忙（第一轮挂着）：不再建第二个，错误里点名那个管理员
    provider.script(managerTurn({ text: 'Thinking about the criteria.', holdMs: 60_000 }))
    const started = await goalStart(sids.refuse, OBJECTIVES.refuse)
    expect(started).toMatchObject({ ok: true })
    await until(() => provider.holding(), 'manager turn held', 30_000)
    const again = await goalStart(sids.refuse, 'a second goal')
    expect(again).toMatchObject({ ok: false })
    expect((again as { error: string }).error).toContain(OBJECTIVES.refuse)
    expect(await managersOf(sids.refuse)).toHaveLength(1)
    provider.release()
    await waitRowSettled(OBJECTIVES.refuse)
    expect((await sessionRows()).length).toBe(before + 1)
  }, 120_000)
})

describe('管理员先问人', () => {
  it('G-4 第一轮先 ask：卡片在切过去的那条对话里等人；答了 → 同一轮接着派活 → 汇报 → 收尾', async () => {
    provider.reset()
    provider.script(
      managerTurn({
        toolCalls: [
          {
            id: 'call_goal_ask',
            name: 'ask',
            args: JSON.stringify({ question: ASK_QUESTION, options: ASK_OPTIONS })
          }
        ]
      }),
      handOff(sids.asks, TASK),
      managerTurn({ text: MANAGER_WAITING }),
      workerTurn({ text: WORKER_REPORT }),
      collect(sids.asks),
      managerTurn({ text: MANAGER_FINAL })
    )
    await openSession(TITLES.asks)
    await setGoalInComposer(OBJECTIVES.asks)

    // 界面已经在管理员会话里：它的问题就在眼前；这时还没有任何东西发给原会话
    await until(
      async () => (await sidebar.activeTitle()) === OBJECTIVES.asks,
      'manager session is the active one'
    )
    await until(async () => (await asks.cardKind()) === 'choice', 'manager ask card', 30_000)
    expect(provider.requests().filter(isWorker)).toHaveLength(0)

    await asks.pickChoice(ASK_OPTIONS[0]!.label)
    await sleep(100)
    await asks.confirmChoice()
    await until(async () => (await asks.cardKind()) === null, 'ask card answered', 20_000)

    await waitReply(MANAGER_FINAL, 90_000)
    await waitRowSettled(OBJECTIVES.asks)
    const reqs = provider.requests()
    const managerReqs = reqs.filter(isManager)
    const workerReqs = reqs.filter(isWorker)
    // 管理员：设目标 → 用户的选择（工具结果）→ 回执 → 被叫回来 → 取回的汇报；原会话：任务
    expect(managerReqs).toHaveLength(5)
    expect(workerReqs).toHaveLength(1)
    expect(managerReqs[1]!.raw).toContain(`User selected: ${ASK_OPTIONS[0]!.label}`)
    expect(workerReqs[0]!.lastUserText).toBe(TASK)
    expect(managerReqs[3]!.lastUserText).toContain(`<session id="${sids.asks}"`)
    expect(managerReqs[4]!.raw).toContain(WORKER_REPORT)
  }, 120_000)
})
