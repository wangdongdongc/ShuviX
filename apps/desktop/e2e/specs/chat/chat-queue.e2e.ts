/**
 * 两档输入框的「追加」与队列面板的撤回（P3-11-22 / -23）。
 *
 *   22 追加送达：一轮挂着时输入 `later please`、点「追加」→ 队列面板里恰好一行追加，`message.list` 里还没有它；
 *      放行之后下一次请求的最后一条用户消息就是它，`message.list` 以 [user 'later please', assistant 'after
 *      followup'] 收尾，面板空了
 *   23 撤回阻止送达：同样排上一条 `drop me`，点那一行的撤回 → 放行之前那一行就没了；这条会话的对话请求只有
 *      1 次，`message.list` 里从来没有 `drop me`；`window.api.agent` 上没有「下一轮」，有 withdrawQueued
 *
 * 靠假提供商的 `holdMs` 制造运行中的中间态（`release()` 提前放行），一切等待都有上界。
 */
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
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const MODEL = 'e2e-model'

interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
const sids: Record<string, string> = {}

const createSession = async (title: string, projectId: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const projDir = join(app.home, 'proj-queue')
  mkdirSync(projDir, { recursive: true })
  const project = await createProject(app.main, { name: 'QueueProj', path: projDir })
  sids.append = await createSession('Q-append', project.id)
  sids.withdraw = await createSession('Q-withdraw', project.id)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes('Q-append'), 'sidebar list refreshed')

  events = eventRecorder(app.main)
  await events.install()
})

afterAll(async () => {
  await provider.close()
  await app.stop()
})

/** 打开会话、发一条、等到它挂在 hold 里 */
async function startHeldTurn(title: string, sid: string): Promise<void> {
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
  await chat.typeAndSend('start held turn')
  await events.waitFor('agent_start', { sessionId: sid })
  await until(() => chat.isBusy(), 'streaming started')
  await until(async () => provider.holding(), 'provider holding')
}

describe('P3-11 追加与撤回', () => {
  it('P3-11-22 追加送达：挂着时排一行追加，放行后作为下一次请求的最后一条用户消息', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'first answer', holdMs: 10_000 }, { text: 'after followup' })
    await startHeldTurn('Q-append', sids.append)

    await chat.type('later please')
    await chat.clickQueueTier('followUp')
    await until(async () => (await chat.queueRows()).length === 1, 'queued row shown')
    const [row] = await chat.queueRows()
    expect(row).toMatchObject({ mode: 'followUp', text: 'later please' })
    expect((await listMessages(sids.append)).map((m) => m.content)).not.toContain('later please')

    provider.release()
    await events.waitFor('agent_end', { sessionId: sids.append })
    await chat.waitIdle()
    await until(
      async () => (await listMessages(sids.append)).at(-1)?.content === 'after followup',
      'follow-up answered'
    )

    const chats = provider.chatRequests()
    expect(chats).toHaveLength(2)
    expect(chats[1]!.lastUserText).toBe('later please')
    const listed = await listMessages(sids.append)
    expect(listed.slice(-2).map((m) => [m.role, m.content])).toEqual([
      ['user', 'later please'],
      ['assistant', 'after followup']
    ])
    expect(await chat.queueRows()).toEqual([])
  })

  it('P3-11-23 撤回阻止送达：那一行在放行前就没了，请求只有一次，转写里从来没有它', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'held answer', holdMs: 10_000 })
    await startHeldTurn('Q-withdraw', sids.withdraw)

    await chat.type('drop me')
    await chat.clickQueueTier('followUp')
    await until(async () => (await chat.queueRows()).length === 1, 'queued row shown')
    const [row] = await chat.queueRows()
    expect(row).toMatchObject({ mode: 'followUp', text: 'drop me' })

    await chat.withdrawQueued(row!.submissionId)
    await until(async () => (await chat.queueRows()).length === 0, 'row withdrawn before release')
    expect(provider.holding()).toBe(true)

    provider.release()
    await events.waitFor('agent_end', { sessionId: sids.withdraw })
    await chat.waitIdle()
    await new Promise((r) => setTimeout(r, 500))

    expect(provider.chatRequestCount()).toBe(1)
    const listed = await listMessages(sids.withdraw)
    expect(listed.map((m) => m.content)).not.toContain('drop me')
    expect(listed.map((m) => [m.role, m.content])).toEqual([
      ['user', 'start held turn'],
      ['assistant', 'held answer']
    ])
    expect(
      await app.main.eval<[string, string]>(
        `[typeof window.api.agent.nextTurn, typeof window.api.agent.withdrawQueued]`
      )
    ).toEqual(['undefined', 'function'])
  })
})
