/**
 * 收件箱里的任务列表（2026-11-14，app-shell InboxTaskList.tsx）—— 单测（inboxPanel.dom.test.ts INP-TL）把
 * chat-ui 整份换成替身，视图订阅与 store 都是假的；这里走一遍真链：主窗口开着会话 A，会话 B 在后台跑一轮发了
 * `update_plan` → 收件箱里 B 那一行订 B 的视图，列表挂在行下面实时推进 → B 以终答收尾、变成新回复 → 那一行用
 * 摘录那次取回的消息画「已完成」的列表，替掉摘录；点列表打开 B。
 *
 *   ITL-E1 B 第二轮（advance）挂着：B 的收件箱行在运行，行下 [data-inbox-task-list=B] 三步、running、第一步进行中
 *   ITL-E2 放行：A 仍开着，B 的列表在原处推进成第二步进行中（第三轮挂着时截图）
 *   ITL-E3 B 以「All done.」收尾、变成新回复：行下是 done 的列表（全部完成），没有「All done.」那一句摘录；
 *          点列表打开 B
 *
 * 选择器全部走 `harness/pages.ts`（`inboxSessionsPane` / `sidebarPane` / `chatPane`）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import {
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'
import {
  chatPane,
  inboxSessionsPane,
  sidebarPane,
  type ChatPane,
  type InboxSessionsPane,
  type SidebarPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const PLAN = 'update_plan'
const STEPS = ['Read the code', 'Fix the bug', 'Run the tests']
const ITEMS = STEPS.map((content, i) => ({
  content,
  status: i === 0 ? 'in_progress' : 'pending'
}))
const TITLES = { a: 'ITL-A', b: 'ITL-B' }
const SHOT_DIR =
  '/private/tmp/claude-501/-Users-agent--claude-spares-spare-mQumgl/33eb15fc-3c44-41c5-9f05-e01c5be3895c/scratchpad'

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let inbox: InboxSessionsPane
let projDir = ''
const sids = { a: '', b: '' }

const createSession = (title: string, projectId: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

/** 发 prompt 不等它、失败也吞掉（B 在后台跑，主窗口开着的是 A） */
const promptInBackground = (sid: string, text: string): Promise<unknown> =>
  app.main.eval(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text })}).catch(() => undefined), true)`
  )

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-inbox-task-list')
  mkdirSync(projDir, { recursive: true })
  const project = await createProject(app.main, { name: 'InboxTaskListProj', path: projDir })
  // 标题都不是缺省标题：自动标题不跑，不会吃掉脚本队列里的轮次
  sids.a = await createSession(TITLES.a, project.id)
  sids.b = await createSession(TITLES.b, project.id)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  inbox = inboxSessionsPane(app.main)
  // IPC 建的会话没有广播：点一次「新对话」让侧栏拉全量列表
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes(TITLES.b), 'sidebar lists sessions')

  events = eventRecorder(app.main)
  await events.install()
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('收件箱里的任务列表', () => {
  it('ITL-E1..E3 B 在后台跑：行下的列表实时推进；收尾成新回复后是已完成的列表，替掉摘录；点列表打开 B', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      {
        toolCalls: [
          { id: 'p1', name: PLAN, args: JSON.stringify({ items: ITEMS }) },
          { id: 'l1', name: 'ls', args: JSON.stringify({ path: projDir }) }
        ],
        usage: { prompt: 90, completion: 10 }
      },
      {
        toolCalls: [{ id: 'p2', name: PLAN, args: JSON.stringify({ advance: true }) }],
        usage: { prompt: 110, completion: 5 },
        holdMs: 30_000
      },
      {
        text: 'All done.',
        usage: { prompt: 130, completion: 5 },
        holdMs: 30_000,
        holdKey: 'final'
      }
    )

    // A 开在中间，收件箱开在右侧
    expect(await sidebar.openSession(TITLES.a)).toBe(true)
    await chat.ready()
    await inbox.open()

    await promptInBackground(sids.b, 'fix the bug')
    await until(() => provider.holding(), 'second turn of B held', 30_000)

    // ITL-E1 第二轮挂着：第一轮的列表在 B 的行下面，进行中
    const running = await until(async () => {
      const row = await inbox.row(sids.b)
      return row?.taskList?.phase === 'running' ? row : null
    }, 'B task list running in the inbox')
    expect(running.kind).toBe('running')
    expect(running.selected).toBe(false)
    expect(running.taskList!.steps).toEqual([
      { n: 1, status: 'in_progress', text: STEPS[0] },
      { n: 2, status: 'pending', text: STEPS[1] },
      { n: 3, status: 'pending', text: STEPS[2] }
    ])

    // ITL-E2 放行：推进落定、终答那一轮挂着 —— B 的列表在原处变成第二步进行中，A 仍开着
    provider.release()
    await until(() => provider.holding('final'), 'final turn of B held', 30_000)
    const advanced = await until(async () => {
      const row = await inbox.row(sids.b)
      return row?.taskList?.steps[1]?.status === 'in_progress' ? row : null
    }, 'B task list advanced in the inbox')
    expect(advanced.kind).toBe('running')
    expect(advanced.selected).toBe(false)
    expect(advanced.taskList!.phase).toBe('running')
    expect(advanced.taskList!.steps.map((s) => s.status)).toEqual([
      'completed',
      'in_progress',
      'pending'
    ])
    await inbox.screenshot(join(SHOT_DIR, 'inbox-task-list.png'))

    // ITL-E3 收尾：B 成了新回复，行下是已完成的列表，摘录不画
    provider.release('final')
    await events.waitFor('agent_end', { sessionId: sids.b })
    const done = await until(async () => {
      const row = await inbox.row(sids.b)
      return row?.kind === 'unread' && row.taskList?.phase === 'done' ? row : null
    }, 'B unread with a done task list')
    expect(done.taskList!.steps).toEqual([
      { n: 1, status: 'completed', text: STEPS[0] },
      { n: 2, status: 'completed', text: STEPS[1] },
      { n: 3, status: 'completed', text: STEPS[2] }
    ])
    expect(done.preview).toBe('')
    expect(done.preview).not.toContain('All done.')
    expect(done.selected).toBe(false)
    await inbox.screenshot(join(SHOT_DIR, 'inbox-task-list-done.png'))

    // 点列表 = 打开 B：它成了选中的那一行（作为新回复打开，留在原处）
    await inbox.clickTaskList(sids.b)
    const opened = await until(async () => {
      const row = await inbox.row(sids.b)
      return row?.selected ? row : null
    }, 'B opened from its task list')
    expect(opened.kind).toBe('unread')
    expect(opened.taskList?.phase).toBe('done')
  }, 180_000)
})
