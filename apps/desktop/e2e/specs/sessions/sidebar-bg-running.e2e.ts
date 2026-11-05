/**
 * 侧栏的「在跑」含后台任务：这一轮结束了、后台命令还在跑的会话，行上照样亮着，而看轮次的地方（输入卡片的停止键、行菜单的
 * 分支）不受影响。真实链路：bash `run_in_background` → 后台任务枢纽 → `bg_task` 事件 → 渲染端的表 → 行上的 `data-running`。
 *
 *   BG-E0 对照：这一轮在跑时有停止键、行亮着，停下之后都没了（BG-E1 的「没有停止键」靠它才站得住）
 *   BG-E1 这一轮结束、后台命令还在：行亮着（别的行不亮）；分支可点；打开它没有停止键，行还亮着。命令退出：灭了，
 *         任务 endedAt 落定，没有新请求（`session.autoResume` 关掉，否则退出的通知会起一轮，行又亮）
 *
 * 后台命令等一个标记文件（用相对路径：工作目录在沙箱里能读，家目录下别处不能）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
import { launchApp, type E2EApp } from '../../harness/launch'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'
import {
  createProject,
  eventRecorder,
  installAutoAllow,
  seedFakeProvider,
  waitRendererReady,
  type EventRecorder
} from '../../harness/seed'

const MODEL = 'e2e-model'
const SENTINEL = 'bg.release'
const COMMAND = `until [ -f ${SENTINEL} ]; do sleep 0.2; done`

interface ListedTask {
  taskId: string
  status: string
  endedAt: number | null
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let projDir = ''
const sids: Record<string, string> = {}

const createSession = (title: string, projectId: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

const promptOverIpc = (sid: string, text: string): Promise<boolean> =>
  app.main.eval<boolean>(
    `(window.api.agent.prompt(${JSON.stringify({ sessionId: sid, text })}).catch(() => undefined), true)`
  )

const listTasks = (sid: string): Promise<ListedTask[]> =>
  app.main.eval<ListedTask[]>(`window.api.bgTask.list(${JSON.stringify({ sessionId: sid })})`)

beforeAll(async () => {
  app = await launchApp()
  await app.main.eval(`window.api.settings.set({ key: 'general.language', value: 'en' })`)
  await app.main.eval(`window.api.settings.set({ key: 'session.autoResume', value: 'false' })`)
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-bg-running')
  mkdirSync(projDir, { recursive: true })
  const project = await createProject(app.main, { name: 'BgProj', path: projDir })
  sids.a = await createSession('BG-A', project.id)
  sids.b = await createSession('BG-B', project.id)
  sids.c = await createSession('BG-C', project.id)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await until(async () => {
    const titles = await sidebar.titles()
    return ['BG-A', 'BG-B', 'BG-C'].every((title) => titles.includes(title))
  }, 'the sidebar lists the sessions')

  events = eventRecorder(app.main)
  await events.install()
  // 没有沙箱的机器上这条命令会问一次（ask-on-command）：替用户放行
  await installAutoAllow(app.main)
}, 120_000)

afterAll(async () => {
  await provider?.close().catch(() => undefined)
  await app?.stop()
})

describe('the sidebar counts background tasks as running', () => {
  it('BG-E0 control: a running turn has the stop button and lights the row; both go when it ends', async () => {
    provider.script({
      text: 'held',
      holdMs: 60_000,
      holdKey: 'bg-e0',
      usage: { prompt: 10, completion: 2 }
    })
    expect(await sidebar.openSession('BG-C')).toBe(true)
    await chat.ready()
    expect(await chat.stopButtonShown()).toBe(false)

    await promptOverIpc(sids.c, 'hold this turn')
    await until(() => chat.stopButtonShown(), 'the stop button is shown while the turn runs')
    await until(() => sidebar.rowRunning('BG-C'), 'the row is running')
    await until(() => provider.holding('bg-e0'), 'the turn reached the hold')

    provider.release('bg-e0')
    await events.waitFor('agent_end', { sessionId: sids.c })
    await until(async () => !(await chat.stopButtonShown()), 'the stop button is gone')
    await until(async () => !(await sidebar.rowRunning('BG-C')), 'the row is no longer running')
  }, 60_000)

  it('BG-E1 a finished turn with a live background command stays lit, without borrowing what belongs to the turn', async () => {
    provider.reset()
    provider.script(
      {
        toolCalls: [
          {
            id: 'call_bg_running',
            name: 'bash',
            args: JSON.stringify({
              command: COMMAND,
              description: 'wait for the sentinel',
              run_in_background: true
            })
          }
        ],
        usage: { prompt: 20, completion: 4 }
      },
      { text: 'started', usage: { prompt: 30, completion: 2 } }
    )

    expect(await sidebar.openSession('BG-B')).toBe(true)
    await chat.ready()

    await promptOverIpc(sids.a, 'start the background command')
    await events.waitFor('agent_end', { sessionId: sids.a })
    await until(
      () => sidebar.rowRunning('BG-A'),
      'the row is running on the background task',
      20_000
    )

    // 不是这一轮的余光：轮次结束之后过一会儿还亮着
    await sleep(500)
    expect(await sidebar.rowRunning('BG-A')).toBe(true)
    expect(await sidebar.rowRunning('BG-B')).toBe(false)
    expect(await sidebar.rowRunning('BG-C')).toBe(false)

    // 看轮次的地方不受影响
    const fork = (await sidebar.rowMenuShots('BG-A'))?.find((item) => item.id === 'fork-session')
    expect(fork).toBeDefined()
    expect(fork!.enabled).toBe(true)

    expect(await sidebar.openSession('BG-A')).toBe(true)
    await chat.ready()
    await chat.waitIdle()
    expect(await chat.stopButtonShown()).toBe(false)
    expect(await sidebar.rowRunning('BG-A')).toBe(true)

    const [task] = await listTasks(sids.a)
    expect(task).toMatchObject({ taskId: 'call_bg_running', status: 'running', endedAt: null })

    expect(await sidebar.openSession('BG-B')).toBe(true)
    const requestsBefore = provider.requests().length
    writeFileSync(join(projDir, SENTINEL), '')

    await until(
      async () => !(await sidebar.rowRunning('BG-A')),
      'the row goes out when the command exits',
      20_000
    )
    const [ended] = await listTasks(sids.a)
    expect(ended.taskId).toBe('call_bg_running')
    expect(ended.endedAt).not.toBeNull()

    // session.autoResume 关着：退出的通知排队，不起新的一轮，行也不会再亮
    await sleep(1000)
    expect(provider.requests().length).toBe(requestsBefore)
    expect(await sidebar.rowRunning('BG-A')).toBe(false)
  }, 90_000)
})
