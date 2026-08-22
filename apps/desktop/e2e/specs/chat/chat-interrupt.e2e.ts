/**
 * 中断 / 引导 / 错误 / 会话隔离 —— 对话区「运行途中出事」的四条路径。
 *
 * 这些用例都要在**运行中**动手，靠假提供商的 `holdMs`（内容片发完后挂住，
 * `release()` 提前放行）制造可观察的中间态；一切等待都有上界，队列耗尽也只会
 * 回默认 `"OK"`，不会挂死。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
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
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'

interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
  blocks?: Array<{ type: string }>
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let projDir = ''
let providerId = ''
const sids: Record<string, string> = {}

const createSession = async (title: string, projectId: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title, projectId })}).then((s) => s.id)`
  )

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

const sessionEvents = async (sid: string): Promise<RecordedEvent[]> =>
  (await events.all()).filter((e) => e.sessionId === sid)

const setSetting = (key: string, value: string): Promise<unknown> =>
  app.main.eval(`window.api.settings.set(${JSON.stringify({ key, value })})`)

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  const seeded = await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  providerId = seeded.providerId
  await waitRendererReady(app.main)

  projDir = join(app.home, 'proj-interrupt')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'alpha.txt'), 'ALPHA CONTENT\n')
  const project = await createProject(app.main, { name: 'InterruptProj', path: projDir })

  sids.abort = await createSession('I-abort', project.id)
  sids.steer = await createSession('I-steer', project.id)
  sids.error = await createSession('I-error', project.id)
  sids.isoA = await createSession('I-isoA', project.id)
  sids.isoB = await createSession('I-isoB', project.id)
  sids.nomodel = await createSession('I-nomodel', project.id)
  sids.nomodelEnter = await createSession('I-nomodel-enter', project.id)
  sids.scratch = await createSession('I-scratch', project.id)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes('I-abort'), 'sidebar list refreshed')

  events = eventRecorder(app.main)
  await events.install()
})

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('中止', () => {
  it('中止后已生成的部分内容保留在对话流，切走切回仍在', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: ['partial ', 'answer'], chunkDelayMs: 30, holdMs: 10_000 })

    expect(await sidebar.openSession('I-abort')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('start something long')

    await until(
      async () => (await chat.items()).some((i) => i.text.includes('partial answer')),
      'partial text streamed'
    )

    await app.main.eval(`window.api.agent.abort(${JSON.stringify(sids.abort)})`)
    await events.waitFor('agent_end', { sessionId: sids.abort })
    await chat.waitIdle()

    // 契约：harness 把带 stopReason='aborted' 的部分消息正常 append，projection 不塌成 error
    const listed = await listMessages(sids.abort)
    expect(listed.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(listed[1].type).toBe('message')
    expect(listed[1].content).toBe('partial answer')
    expect(await chat.errorRows()).toBe(0)

    const items = await chat.settledItems()
    expect(items.at(-1)).toMatchObject({ role: 'assistant', text: 'partial answer' })

    expect(await sidebar.openSession('I-scratch')).toBe(true)
    expect(await sidebar.openSession('I-abort')).toBe(true)
    await until(async () => (await chat.settledItems()).length === 2, 'abort session reopened')
    expect((await chat.settledItems()).at(-1)?.text).toBe('partial answer')
  })
})

describe('引导（steer）', () => {
  it('运行中插入的用户消息落在两张卡片之间，且进入下一次请求的 payload', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      {
        thinking: 'thinking hard',
        toolCalls: [
          {
            id: 'call_steer',
            name: 'read',
            args: JSON.stringify({ path: join(projDir, 'alpha.txt') })
          }
        ],
        holdMs: 10_000
      },
      { text: 'steered answer' }
    )

    expect(await sidebar.openSession('I-steer')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('original ask')
    await events.waitFor('agent_start', { sessionId: sids.steer })
    await until(() => chat.isBusy(), 'streaming started')

    // 运行中回车 = steer（InputArea 的 handleKeyDown 在 isStreaming 时改投 handleSteer）
    await chat.type('STEER-TEXT please pivot')
    await chat.pressEnter()
    await new Promise((r) => setTimeout(r, 300))
    provider.release()

    await events.waitFor('agent_end', { sessionId: sids.steer })
    await chat.waitIdle()

    // 发给模型的最后一次 payload 里带着 steer 原文
    const chats = provider.chatRequests()
    expect(chats.length).toBeGreaterThanOrEqual(2)
    expect(chats.at(-1)!.raw).toContain('STEER-TEXT please pivot')

    // steer 被投影成普通 user/text，夹在被它截断的那张卡与终答之间
    const listed = await listMessages(sids.steer)
    expect(listed.map((m) => `${m.role}/${m.type}`)).toEqual([
      'user/text',
      'assistant/message',
      'user/text',
      'assistant/message'
    ])
    // 被截断的那一轮是一条真实 entry（思考 + 工具调用同处一卡），不是 UI 造的合成消息
    expect(listed[1].blocks?.map((b) => b.type)).toEqual(['thinking', 'tool'])
    expect(listed[2].content).toBe('STEER-TEXT please pivot')
    expect(listed[3].content).toBe('steered answer')

    // DOM：四项，第二项就是那条真实 entry —— 不再有 orphan- 合成 id
    const items = await chat.settledItems()
    expect(items.map((i) => i.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(items[1].id).toBe(listed[1].id)
    expect(items[2].text).toBe('STEER-TEXT please pivot')

    expect(await sidebar.openSession('I-scratch')).toBe(true)
    expect(await sidebar.openSession('I-steer')).toBe(true)
    await until(async () => (await chat.settledItems()).length === 4, 'steer session reopened')
    expect((await chat.settledItems()).map((i) => i.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant'
    ])
  })
})

describe('provider 报错', () => {
  it('对话流出现恰好一条错误行，输入框随即恢复可用', async () => {
    provider.reset()
    await events.clear()
    provider.script({ httpStatus: 500 })

    expect(await sidebar.openSession('I-error')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('this will fail')
    await events.waitFor('error', { sessionId: sids.error })
    await chat.waitIdle()

    const all = await sessionEvents(sids.error)
    expect(all.filter((e) => e.type === 'error')).toHaveLength(1)
    // live 的错误行是本地 local-error-*（不落盘）；agent_end 投影不出助手卡片，
    // 故不会再补一条 —— 重复出现即缺陷
    expect(await chat.errorRows()).toBe(1)

    await chat.type('retry?')
    expect(await chat.sendDisabled()).toBe(false)
    await chat.type('')

    // 重开：失败轮以 stopReason='error' 落进 entry 树，投影成一条 error_event
    const listed = await listMessages(sids.error)
    expect(listed.filter((m) => m.type === 'error_event')).toHaveLength(1)
    expect(await sidebar.openSession('I-scratch')).toBe(true)
    expect(await sidebar.openSession('I-error')).toBe(true)
    await until(async () => (await chat.settledItems()).length === 2, 'error session reopened')
    expect(await chat.errorRows()).toBe(1)
  })
})

describe('会话隔离', () => {
  it('A 运行中切到 B，跑完再切回 A：消息不重不漏', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: ['iso ', 'answer'], chunkDelayMs: 30, holdMs: 3000 })

    expect(await sidebar.openSession('I-isoA')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('run in A')
    await events.waitFor('agent_start', { sessionId: sids.isoA })

    // 运行中切走：finishStreaming 只在 sessionId === activeSessionId 时 append，
    // 切回靠 setMessages 重建 —— 两者叠加是重复消息的经典来源
    expect(await sidebar.openSession('I-isoB')).toBe(true)
    expect(await chat.settledItems()).toHaveLength(0)
    expect(await chat.isBusy()).toBe(false)

    await events.waitFor('agent_end', { sessionId: sids.isoA })
    expect(await sidebar.openSession('I-isoA')).toBe(true)
    await until(async () => (await chat.settledItems()).length === 2, 'A reopened')

    const listed = await listMessages(sids.isoA)
    expect(listed.map((m) => `${m.role}/${m.type}`)).toEqual(['user/text', 'assistant/message'])
    expect(listed[1].content).toBe('iso answer')
    expect(await chat.settledItems()).toHaveLength(2)
    expect(await chat.isBusy()).toBe(false)
    expect(await chat.loadingDots()).toBe(false)
  })
})

describe('未配置模型', () => {
  it('清空默认模型后发送按钮禁用，点发送不产生任何消息', async () => {
    await setSetting('general.defaultModel', '')
    try {
      expect(await sidebar.openSession('I-nomodel')).toBe(true)
      await chat.ready()
      await chat.type('should not be sendable')
      expect(await chat.sendDisabled()).toBe(true)
      await chat.clickSend()
      await new Promise((r) => setTimeout(r, 800))
      expect(await listMessages(sids.nomodel)).toHaveLength(0)
    } finally {
      await setSetting('general.defaultModel', MODEL)
      await setSetting('general.defaultProvider', providerId)
      await chat.type('')
    }
  })

  /**
   * 回归：回车与发送按钮必须对同一状态给出同一答案。
   *
   * 曾经不是：`handleKeyDown` 的回车分支只挡 `isStreaming` 就直接 `handleSend()`，
   * 而 `handleSend` 的早退也只看「无正文/无图片/无命令芯片」与 `isStreaming`，
   * 两处都不看 `canSend` 里的 `!!activeModel` —— 按钮灰着、回车照发，
   * 实测会建起 Agent 并落下一条 user + 一条 assistant。守卫已收进 `handleSend`。
   */
  it('无模型时回车与按钮一致：都发不出去', async () => {
    await setSetting('general.defaultModel', '')
    try {
      expect(await sidebar.openSession('I-nomodel-enter')).toBe(true)
      await chat.ready()
      await chat.type('should not be sendable')
      expect(await chat.sendDisabled()).toBe(true)
      await chat.pressEnter()
      await new Promise((r) => setTimeout(r, 1500))
      expect(await listMessages(sids.nomodelEnter)).toHaveLength(0)
    } finally {
      await setSetting('general.defaultModel', MODEL)
      await setSetting('general.defaultProvider', providerId)
      await chat.type('')
    }
  })
})
