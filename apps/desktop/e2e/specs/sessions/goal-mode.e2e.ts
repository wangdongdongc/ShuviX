/**
 * 目标模式（`/goal`，docs/goal-mode-design.md，实验）—— 状态机、护栏、信封、目标栏各有单测，这里只走一遍它们替身掉的
 * 那条链：真输入框里写 `/goal <条件>` 回车 → `agent.goalAct` → goalService 以人的来源发出带「目标」Token 的消息、
 * 起一轮 → 根运行结束 → 判定型埋点 `goal.check` → 内置 hook `goal-check` 派发内置 agent `goal-judge`（真 runner、
 * 真 `next`）→ not_met 时续跑通知起下一轮 → met 时写结局通知；以及目标栏的按钮、侧栏的 ◎ 记号、停用目标检查之后的暂停。
 *
 *   G-1 真输入框 `/goal <条件>` + 回车：用户气泡带「目标」胶囊；目标栏出现、进行中；`agent.goal()` 是 active；
 *       侧栏那一行有 ◎（active）；干活的第一个请求是原文 + `<goal-set>` 说明
 *   G-2 脚本化的一圈：第一轮（一次 ls + 一段话）→ 判定 not_met（带理由与下一步）→ 对话里一行 goal-continue、
 *       第二轮起跑，请求里是 `<goal-continue>` 信封、带判定理由 → 判定 met → 一行 goal-status met，目标栏是达成，
 *       `agent.goal()` 是 met、turns = 1；判定请求是 goal-judge（工具恰为 read + next），事件里有目标原文与上一轮的 ls
 *   G-3 目标栏按钮：第一轮挂着时点暂停 → 栏、IPC、侧栏都是暂停（user），这一轮跑完也不判定；打开编辑器再取消；
 *       点继续 → 空闲的会话起一轮（`resumed="true"` 的续跑信封），栏与侧栏回到进行中；这一轮挂着时点清除 →
 *       目标没了、栏与侧栏记号都消失，跑完也不判定
 *   G-4 停用内置 `goal-check`（`mdMeta.setEnabled`）：目标栏明说检查已停用；第一轮跑完目标暂停，原因
 *       `judge-unavailable`，没有任何判定请求
 *   G-5 目标规划写了规格：规划员（内置 goal-planner，开工之前由宿主派发）挂着时 IPC 与目标栏都是「规划中」、还没有干活的
 *       请求；它用 `write` 在项目里写 `docs/goal-spec.md`、`next {verdict:'spec', specPath:<相对路径>}` → 文件在，
 *       `agent.goal().specPath` 是绝对路径，干活的第一个请求的 `<goal-set>` 说明里点名它，判定事件里有 `specPath`
 *   G-6 规划员的 `ask`：普通的询问卡片（选择题），在界面里答了 → 规划员收到选择、回 ready → 目标开始，记录没有 specPath
 *
 * 每次设定目标，第一个请求是规划员的（系统提示词是 goal-planner 的 md，工具含 `next` / `ask` / `write`）：按系统提示词认领；
 * G-1..G-4 给它排一个 `next {verdict:'ready'}`，让它们照旧只看干活与判定。判定请求与审查请求同形（工具恰为 `read` +
 * `next`；审查在 harness 里本就关着），这里按内容认领：任务文本里有 `<hook_event trigger="goal.check">`。干活的请求按
 * 「既不是规划也不是判定」认领。会话标题都不是缺省标题：自动标题不跑。
 * DOM 只经 `harness/pages.ts`（`goalPane` / `chatPane` / `sidebarPane`）。设了 `GOAL_E2E_SHOTS=<目录>` 时在
 * (a) 刚设定、(b) 达成、(c) 暂停、(d) 编辑器开着 四处存整窗截图给人看；不设就不截。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { GoalStatus, GoalVerdict, GoalView } from '@shuvix/chat-protocol/types/goal'
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
  requestSystemText,
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
  type GoalBarShot,
  type GoalPane,
  type InlineAskPane,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const GOAL_CHECK_ID = 'hook:builtin:goal-check'
const GOAL_FENCE = '<hook_event trigger="goal.check">'
const TITLES = {
  loop: 'Goal loop',
  bar: 'Goal bar',
  off: 'Goal off',
  spec: 'Goal spec',
  asks: 'Goal asks'
}
const OBJECTIVES = {
  loop: 'G2 objective: write notes.txt in the project with the word READY',
  bar: 'G3 objective: keep working until the user pauses',
  off: 'G4 objective: nobody is here to check this',
  spec: 'G5 objective: make the importer robust',
  asks: 'G6 objective: speed up the build'
}
/** goal-planner.md 的第一句（规划请求的系统提示词里有它） */
const PLANNER_PROMPT = "You are ShuviX's goal planner."
const SPEC_REL = 'docs/goal-spec.md'
const SPEC_BODY =
  '# Importer robust: done when\n\n- [ ] `npm test` passes\n- [ ] malformed rows are skipped, not fatal\n'
const PLAN_QUESTION = 'Which build should get faster?'
const PLAN_OPTIONS = [
  { label: 'Release build (recommended)', description: 'What ships' },
  { label: 'Dev build', description: 'What you run every day' }
]
const REASON_1 = 'notes.txt does not exist yet; the run only listed the folder.'
const NEXT_1 = 'Create notes.txt containing READY.'
const REASON_2 = 'The second run reports notes.txt written with READY.'

let app: E2EApp
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let goals: GoalPane
let asks: InlineAskPane
let projDir = ''
const sids: Record<keyof typeof TITLES, string> = { loop: '', bar: '', off: '', spec: '', asks: '' }

// ─── 请求认领 ───

/** 规划请求：系统提示词是 goal-planner 的 md（它的每一个请求都是，含工具结果之后的那些） */
const isPlanner = (req: FakeRequest): boolean => requestSystemText(req).includes(PLANNER_PROMPT)
/** 判定请求：任务文本里有 goal.check 的事件围栏 */
const isJudge = (req: FakeRequest): boolean =>
  !isPlanner(req) && req.lastUserText.includes(GOAL_FENCE)
/** 干活的请求：规划与判定之外的一切（审查关着、标题都不是缺省的，不会有别的派发） */
const isWorker = (req: FakeRequest): boolean => !isPlanner(req) && !isJudge(req)

let plannerSeq = 0
function plannerTurn(turn: Omit<FakeTurn, 'when'>): FakeTurn {
  return { usage: { prompt: 70, completion: 6 }, ...turn, when: isPlanner }
}
/** 规划员的结论：调一次 `next`，参数就是结论 */
function plannerNext(plan: { verdict: 'ready' | 'spec'; specPath?: string }): FakeTurn {
  return plannerTurn({
    toolCalls: [{ id: `call_plan_${++plannerSeq}`, name: 'next', args: JSON.stringify(plan) }]
  })
}
/** G-1..G-4：目标本来就够清楚 */
const plannerReady = (): FakeTurn => plannerNext({ verdict: 'ready' })

let judgeSeq = 0
/** 判定的一轮：调一次 `next`，参数就是结论 */
function judgeTurn(verdict: GoalVerdict): FakeTurn {
  return {
    toolCalls: [{ id: `call_judge_${++judgeSeq}`, name: 'next', args: JSON.stringify(verdict) }],
    when: isJudge,
    usage: { prompt: 60, completion: 8 }
  }
}

function workerTurn(turn: Omit<FakeTurn, 'when'>): FakeTurn {
  return { usage: { prompt: 80, completion: 5 }, ...turn, when: isWorker }
}

/** 判定请求里事件围栏的 YAML（goal.check 的 payload）—— 判定 agent 的全部输入 */
interface GoalCheckEvent {
  goal: { id: string; objective: string; turns: number; specPath?: string }
  lastRun: {
    assistantText: string
    toolCalls: Array<{ tool: string; summary: string; outcome: string }>
  }
  previousVerdict?: { verdict: string; reason: string; nextStep?: string }
}

function goalEventOf(req: FakeRequest): GoalCheckEvent {
  const text = req.lastUserText
  const start = text.indexOf(`${GOAL_FENCE}\n`)
  const end = text.indexOf('\n</hook_event>', start)
  if (start < 0 || end < start) {
    throw new Error(`no goal.check fence in request: ${text.slice(0, 300)}`)
  }
  return parseYaml(text.slice(start + GOAL_FENCE.length + 1, end)) as GoalCheckEvent
}

// ─── IPC 助手 ───

const goalOf = (sid: string): Promise<GoalView | null> =>
  app.main.eval<GoalView | null>(`window.api.agent.goal(${JSON.stringify(sid)})`)
const goalStatuses = (): Promise<Record<string, GoalStatus>> =>
  app.main.eval<Record<string, GoalStatus>>(`window.api.agent.goalStatuses()`)
const setGoalCheckEnabled = (enabled: boolean): Promise<{ success: boolean }> =>
  app.main.eval<{ success: boolean }>(
    `window.api.mdMeta.setEnabled({ objectId: ${JSON.stringify(GOAL_CHECK_ID)}, enabled: ${enabled} })`
  )

/** 等目标走到某个状态（IPC），回那一刻的视图 */
const waitGoal = (sid: string, status: GoalStatus, timeoutMs = 30_000): Promise<GoalView> =>
  until(
    async () => {
      const goal = await goalOf(sid)
      return goal?.status === status ? goal : null
    },
    `goal ${status}`,
    timeoutMs
  )

/** 等目标栏走到某个状态（DOM），回那一刻的快照 */
const waitBar = (status: string): Promise<GoalBarShot> =>
  until(async () => {
    const bar = await goals.bar()
    return bar?.status === status ? bar : null
  }, `goal bar ${status}`)

const openSession = async (key: keyof typeof TITLES): Promise<void> => {
  expect(await sidebar.openSession(TITLES[key])).toBe(true)
  await chat.ready()
}

/** 真输入框：`/goal <条件>`（打出空格那一刻转成内置命令的芯片）+ 回车 */
const setGoalInComposer = async (objective: string): Promise<void> => {
  await chat.type(`/goal ${objective}`)
  await chat.pressEnter()
}

/** 这条会话彻底落定：不在流式态，侧栏那一行也不在跑（连续两次） */
const waitSettled = async (key: keyof typeof TITLES): Promise<void> => {
  await chat.waitIdle()
  await until(async () => {
    if (await sidebar.rowRunning(TITLES[key])) return false
    await sleep(400)
    return !(await sidebar.rowRunning(TITLES[key])) && !(await chat.isBusy())
  }, `${TITLES[key]} settled`)
}

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
  await until(async () => (await sidebar.titles()).includes(TITLES.off), 'sidebar lists sessions')
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('设定与一圈判定', () => {
  it('G-1 真输入框里 /goal + 回车：气泡带目标胶囊，目标栏进行中，IPC active，侧栏 ◎', async () => {
    provider.reset()
    // 第一轮：一次 ls，然后一段话 —— 挂在收尾之前，好看清「刚设定」的样子（G-2 放行）
    provider.script(
      plannerReady(),
      workerTurn({
        toolCalls: [{ id: 'call_ls_1', name: 'ls', args: JSON.stringify({ path: projDir }) }]
      }),
      workerTurn({ text: 'Listed the project; notes.txt comes next.', holdMs: 60_000 })
    )
    await openSession('loop')
    expect(await goals.bar()).toBeNull()
    expect(await sidebar.goalMarkOf(TITLES.loop)).toBeNull()

    await setGoalInComposer(OBJECTIVES.loop)
    await until(() => provider.holding(), 'first worker turn held', 30_000)

    const goal = await goalOf(sids.loop)
    expect(goal).toMatchObject({
      sessionId: sids.loop,
      objective: OBJECTIVES.loop,
      status: 'active',
      turns: 0,
      stalls: 0,
      checkerMissing: false
    })
    expect(goal?.lastVerdict).toBeUndefined()
    expect(goal?.specPath).toBeUndefined()
    expect(goal?.planning).toBe(false)
    expect((await goalStatuses())[sids.loop]).toBe('active')

    // 开工之前先派了规划员（一个请求，回 ready），之后才是干活的请求
    const planners = provider.requests().filter(isPlanner)
    expect(planners).toHaveLength(1)
    expect(provider.requests().indexOf(planners[0]!)).toBe(0)
    expect(planners[0]!.lastUserText).toContain(`<goal>\n${OBJECTIVES.loop}\n</goal>`)

    // 发给模型的是人的消息：原文在前，系统写的 `<goal-set>` 说明在后
    const first = provider.requests().filter(isWorker)[0]!
    expect(first.lastUserText.startsWith(OBJECTIVES.loop)).toBe(true)
    expect(first.lastUserText).toContain(`<goal-set id="${goal!.id}">`)
    expect(first.lastUserText).not.toContain('acceptance spec')

    // 输入框清空；用户气泡带「目标」胶囊，正文是原文
    expect(await chat.inputValue()).toBe('')
    const chipped = await until(async () => {
      const ids = await goals.goalChipMessages()
      return ids.length > 0 ? ids : null
    }, 'user bubble with the goal chip')
    expect(chipped).toHaveLength(1)
    const bubble = (await chat.settledItems()).find((i) => i.id === chipped[0])
    expect(bubble?.text).toContain(OBJECTIVES.loop)
    expect(bubble?.text).not.toContain('<goal-set')

    const bar = await waitBar('active')
    expect(bar.actions).toEqual(['pause', 'edit', 'clear'])
    expect(bar.checkerMissing).toBe(false)
    expect(bar.verdict).toBeNull()
    expect(bar.state).not.toBe('')

    await until(
      async () => (await sidebar.goalMarkOf(TITLES.loop)) === 'active',
      'sidebar goal mark active'
    )
    await shot('a-goal-active')
  }, 90_000)

  it('G-2 not_met → 续跑（信封带判定理由）→ met：两行目标通知，栏是达成，turns = 1', async () => {
    provider.script(
      judgeTurn({ verdict: 'not_met', reason: REASON_1, next_step: NEXT_1 }),
      workerTurn({ text: 'Wrote notes.txt with READY.' }),
      judgeTurn({ verdict: 'met', reason: REASON_2 })
    )
    provider.release()

    const met = await waitGoal(sids.loop, 'met', 90_000)
    expect(met).toMatchObject({
      turns: 1,
      lastVerdict: { verdict: 'met', reason: REASON_2 }
    })
    expect(met.endedAt).toBeTypeOf('number')
    await waitSettled('loop')

    // 请求序：ls、话（第一轮）→ 判定 → 续跑的一轮 → 判定；之后再没有
    const reqs = provider.requests()
    const judges = reqs.filter(isJudge)
    const workers = reqs.filter(isWorker)
    expect(judges).toHaveLength(2)
    expect(workers).toHaveLength(3)
    const second = workers[2]!
    expect(reqs.indexOf(judges[0]!)).toBeLessThan(reqs.indexOf(second))
    expect(reqs.indexOf(second)).toBeLessThan(reqs.indexOf(judges[1]!))

    // 判定的是内置 goal-judge：工具恰为 read + next，系统提示词是它的 md
    for (const judge of judges) {
      expect([...requestToolNames(judge)].sort()).toEqual(['next', 'read'])
      expect(requestSystemText(judge)).toContain('You judge whether a goal the user set')
    }
    const firstCheck = goalEventOf(judges[0]!)
    expect(firstCheck.goal).toMatchObject({ id: met.id, objective: OBJECTIVES.loop, turns: 0 })
    expect(firstCheck.lastRun.toolCalls.map((c) => c.tool)).toContain('ls')
    expect(firstCheck.lastRun.assistantText).toContain('notes.txt comes next')
    expect(firstCheck.previousVerdict).toBeUndefined()
    const secondCheck = goalEventOf(judges[1]!)
    expect(secondCheck.goal.turns).toBe(1)
    expect(secondCheck.previousVerdict).toMatchObject({
      verdict: 'not_met',
      reason: REASON_1,
      nextStep: NEXT_1
    })
    expect(secondCheck.lastRun.assistantText).toContain('Wrote notes.txt with READY.')

    // 续跑那一轮收到的是 `<goal-continue>` 信封：目标原文 + 判定理由 + 下一步
    expect(second.lastUserText).toContain(`<goal-continue id="${met.id}" turn="1">`)
    expect(second.lastUserText).toContain(OBJECTIVES.loop)
    expect(second.lastUserText).toContain(`Checker: ${REASON_1}`)
    expect(second.lastUserText).toContain(`Suggested next step: ${NEXT_1}`)

    // 对话里：续跑与达成各一行通知（画成通知行，不是用户气泡）
    const notices = await until(async () => {
      const rows = await goals.notices()
      return rows.some((r) => r.kind === 'goal-status' && r.event === 'met') ? rows : null
    }, 'goal-status met row')
    expect(notices.map((r) => r.kind)).toEqual(['goal-continue', 'goal-status'])
    expect(notices[1]).toMatchObject({ kind: 'goal-status', event: 'met' })
    expect(await goals.goalChipMessages()).toHaveLength(1)

    // 目标栏：达成，最近一次判定是 met；按钮换成「沿用原文再设 / 移除」
    const bar = await waitBar('met')
    expect(bar.verdict).toBe('met')
    expect(bar.actions).toEqual(['set-again', 'dismiss'])
    // 终态不进状态表：侧栏没有记号
    expect((await goalStatuses())[sids.loop]).toBeUndefined()
    await until(
      async () => (await sidebar.goalMarkOf(TITLES.loop)) === null,
      'sidebar goal mark gone after met'
    )
    await shot('b-goal-met')
  }, 120_000)
})

describe('目标栏的按钮', () => {
  it('G-3 暂停 / 编辑器 / 继续 / 清除：栏、IPC、侧栏一起变；暂停或清除之后跑完的那一轮不判定', async () => {
    provider.reset()
    provider.script(plannerReady(), workerTurn({ text: 'G3 first pass.', holdMs: 60_000 }))
    await openSession('bar')
    await setGoalInComposer(OBJECTIVES.bar)
    await until(() => provider.holding(), 'G3 first worker turn held', 30_000)
    await waitBar('active')

    // 这一轮还在跑时点暂停
    expect(await goals.clickAction('pause')).toBe(true)
    const paused = await waitGoal(sids.bar, 'paused')
    expect(paused.pauseReason).toBe('user')
    const pausedBar = await waitBar('paused')
    expect(pausedBar.actions).toEqual(['resume', 'edit', 'clear'])
    expect(pausedBar.error).toBeNull()
    expect((await goalStatuses())[sids.bar]).toBe('paused')
    await until(
      async () => (await sidebar.goalMarkOf(TITLES.bar)) === 'paused',
      'sidebar goal mark paused'
    )

    // 放行：这一轮跑完，目标暂停着 —— 不判定
    provider.release()
    await waitSettled('bar')
    expect(provider.requests().filter(isJudge)).toHaveLength(0)
    expect((await goalOf(sids.bar))?.status).toBe('paused')
    await until(async () => {
      const rows = await goals.notices()
      return rows.some((r) => r.kind === 'goal-status' && r.event === 'paused')
    }, 'goal-status paused row')
    await shot('c-goal-paused')

    // 编辑器：开着时栏上不出按钮；取消即关、目标不变
    expect(await goals.clickAction('edit')).toBe(true)
    const editing = await until(async () => {
      const bar = await goals.bar()
      return bar?.editor === 'edit' ? bar : null
    }, 'goal editor open')
    expect(editing.actions).toEqual([])
    await shot('d-goal-edit')
    expect(await goals.cancelEditor()).toBe(true)
    await until(async () => (await goals.bar())?.editor === null, 'goal editor closed')
    expect(await goalOf(sids.bar)).toMatchObject({ status: 'paused', objective: OBJECTIVES.bar })

    // 继续：会话空闲 → 宿主起一轮（`resumed="true"` 的续跑信封）；挂住它，好在进行中点清除
    provider.script(workerTurn({ text: 'G3 resumed pass.', holdMs: 60_000 }))
    expect(await goals.clickAction('resume')).toBe(true)
    await until(() => provider.holding(), 'resumed worker turn held', 30_000)
    const resumedReq = provider.heldRequest()!
    expect(resumedReq.lastUserText).toContain('resumed="true"')
    expect(resumedReq.lastUserText).toContain(OBJECTIVES.bar)
    const resumed = await waitGoal(sids.bar, 'active')
    expect(resumed.pauseReason).toBeUndefined()
    await waitBar('active')
    await until(
      async () => (await sidebar.goalMarkOf(TITLES.bar)) === 'active',
      'sidebar goal mark active again'
    )

    // 清除：目标记录没了，栏与侧栏记号都消失
    expect(await goals.clickAction('clear')).toBe(true)
    await until(async () => (await goalOf(sids.bar)) === null, 'goal cleared (IPC)')
    await until(async () => (await goals.bar()) === null, 'goal bar gone')
    await until(
      async () => (await sidebar.goalMarkOf(TITLES.bar)) === null,
      'sidebar goal mark gone after clear'
    )
    expect((await goalStatuses())[sids.bar]).toBeUndefined()

    provider.release()
    await waitSettled('bar')
    expect(provider.requests().filter(isJudge)).toHaveLength(0)
    expect(await goalOf(sids.bar)).toBeNull()
    await until(async () => {
      const rows = await goals.notices()
      return rows.some((r) => r.kind === 'goal-status' && r.event === 'cleared')
    }, 'goal-status cleared row')
  }, 150_000)
})

describe('目标检查停用', () => {
  it('G-4 停用 goal-check：栏上明说检查已停用；第一轮跑完暂停（judge-unavailable），没有判定请求', async () => {
    provider.reset()
    expect((await setGoalCheckEnabled(false)).success).toBe(true)
    try {
      provider.script(plannerReady(), workerTurn({ text: 'G4 pass.', holdMs: 60_000 }))
      await openSession('off')
      await setGoalInComposer(OBJECTIVES.off)
      await until(() => provider.holding(), 'G4 worker turn held', 30_000)

      const active = await waitBar('active')
      expect(active.checkerMissing).toBe(true)
      expect(await goalOf(sids.off)).toMatchObject({ status: 'active', checkerMissing: true })

      provider.release()
      const paused = await waitGoal(sids.off, 'paused')
      expect(paused).toMatchObject({ pauseReason: 'judge-unavailable', checkerMissing: true })
      expect(paused.lastVerdict).toBeUndefined()
      const bar = await waitBar('paused')
      expect(bar.checkerMissing).toBe(true)
      expect(bar.actions).toContain('resume')
      await waitSettled('off')
      expect(provider.requests().filter(isJudge)).toHaveLength(0)
      expect(provider.requests().filter(isWorker)).toHaveLength(1)
      await until(async () => {
        const rows = await goals.notices()
        return rows.some((r) => r.kind === 'goal-status' && r.event === 'paused')
      }, 'goal-status paused row (judge unavailable)')
      await until(
        async () => (await sidebar.goalMarkOf(TITLES.off)) === 'paused',
        'sidebar goal mark paused (judge unavailable)'
      )
    } finally {
      await setGoalCheckEnabled(true)
    }
  }, 90_000)
})

describe('目标规划', () => {
  it('G-5 规划员写了规格：规划中 → 文件在项目里，specPath 是绝对路径，<goal-set> 与判定事件都点名它', async () => {
    provider.reset()
    const specAbs = join(projDir, SPEC_REL)
    expect(existsSync(specAbs)).toBe(false)
    provider.script(
      // 规划员的第一步挂住：看清「规划中」
      plannerTurn({
        toolCalls: [
          {
            id: 'call_plan_write',
            name: 'write',
            args: JSON.stringify({ path: specAbs, content: SPEC_BODY })
          }
        ],
        holdMs: 60_000
      }),
      plannerNext({ verdict: 'spec', specPath: SPEC_REL }),
      workerTurn({ text: 'Read the spec; the importer now skips malformed rows.' }),
      judgeTurn({ verdict: 'met', reason: 'Every item in the spec holds.' })
    )
    await openSession('spec')
    await setGoalInComposer(OBJECTIVES.spec)
    await until(() => provider.holding(), 'planner turn held', 30_000)

    // 挂着的是规划员：goal-planner 的系统提示词，工具含 next / ask / write；任务里有目标原文
    const held = provider.heldRequest()!
    expect(isPlanner(held)).toBe(true)
    expect(requestToolNames(held)).toEqual(expect.arrayContaining(['next', 'ask', 'write']))
    expect(held.lastUserText).toContain(`<goal>\n${OBJECTIVES.spec}\n</goal>`)
    // 规划中：目标已进行中、视图 planning，栏上是规划中；还没有任何干活的请求
    expect(await goalOf(sids.spec)).toMatchObject({
      objective: OBJECTIVES.spec,
      status: 'active',
      planning: true
    })
    await until(
      async () => (await goals.bar())?.state.startsWith('Preparing the acceptance spec…') === true,
      'goal bar shows planning'
    )
    expect(provider.requests().filter(isWorker)).toHaveLength(0)

    provider.release()
    const met = await waitGoal(sids.spec, 'met', 90_000)
    expect(met.specPath).toBe(specAbs)
    expect(met.planning).toBe(false)
    expect(readFileSync(specAbs, 'utf8')).toBe(SPEC_BODY)
    await waitSettled('spec')

    // 请求序：规划（write）→ 规划（next）→ 干活 → 判定
    const reqs = provider.requests()
    expect(reqs.filter(isPlanner)).toHaveLength(2)
    const workers = reqs.filter(isWorker)
    const judges = reqs.filter(isJudge)
    expect(workers).toHaveLength(1)
    expect(judges).toHaveLength(1)
    expect(reqs.indexOf(reqs.filter(isPlanner)[1]!)).toBeLessThan(reqs.indexOf(workers[0]!))

    // 干活的第一个请求：原文 + `<goal-set>` 说明，说明里点名规格文件的绝对路径
    const first = workers[0]!.lastUserText
    expect(first.startsWith(OBJECTIVES.spec)).toBe(true)
    const note = first.slice(
      first.indexOf(`<goal-set id="${met.id}">`),
      first.indexOf('</goal-set>')
    )
    expect(note).toContain(specAbs)
    // 判定事件带着它（判定 agent 自己去 read）
    expect(goalEventOf(judges[0]!).goal).toMatchObject({ id: met.id, specPath: specAbs })
  }, 120_000)

  it('G-6 规划员的 ask：询问卡片在对话里等人，答了之后规划员收到选择、回 ready，目标开始', async () => {
    provider.reset()
    provider.script(
      plannerTurn({
        toolCalls: [
          {
            id: 'call_plan_ask',
            name: 'ask',
            args: JSON.stringify({ question: PLAN_QUESTION, options: PLAN_OPTIONS })
          }
        ]
      }),
      plannerReady(),
      workerTurn({ text: 'G6 pass.' }),
      judgeTurn({ verdict: 'met', reason: 'The release build is faster.' })
    )
    await openSession('asks')
    await setGoalInComposer(OBJECTIVES.asks)

    // 卡片等着人：规划还没完，没有干活的请求
    await until(async () => (await asks.cardKind()) === 'choice', 'planner ask card', 30_000)
    expect(await goalOf(sids.asks)).toMatchObject({ status: 'active', planning: true })
    await sleep(500)
    expect(provider.requests().filter(isWorker)).toHaveLength(0)
    expect(provider.requests().filter(isPlanner)).toHaveLength(1)

    await asks.pickChoice(PLAN_OPTIONS[0]!.label)
    await sleep(100)
    await asks.confirmChoice()
    await until(async () => (await asks.cardKind()) === null, 'ask card answered', 20_000)

    const met = await waitGoal(sids.asks, 'met', 90_000)
    expect(met.specPath).toBeUndefined()
    await waitSettled('asks')
    const planners = provider.requests().filter(isPlanner)
    expect(planners).toHaveLength(2)
    expect(planners[1]!.raw).toContain(`User selected: ${PLAN_OPTIONS[0]!.label}`)
    const workers = provider.requests().filter(isWorker)
    expect(workers).toHaveLength(1)
    expect(workers[0]!.lastUserText.startsWith(OBJECTIVES.asks)).toBe(true)
    expect(workers[0]!.lastUserText).not.toContain('acceptance spec')
  }, 120_000)
})
