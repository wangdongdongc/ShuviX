/**
 * 对话区基础全链路 —— 输入框发送 → 流式事件 → 卡片渲染 → 重开投影一致。
 *
 * 被测契约（`eventHandler.ts` 头注释写成明文的那条）：**流式与重开必须产出同一份
 * 消息列表、尤其是同一批 id** —— 一条 entry 一条消息，id 就是 entry id（工具调用是
 * 卡内的块，按 toolCallId 认）。本文件围绕它展开。
 *
 * 模型侧由 `harness/fakeProvider` 脚本化（隔离实例没有 API Key）。
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

/** message.list 返回的消息（只声明本文件会读的字段） */
interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
  blocks?: Array<{ type: string; text?: string; toolCallId?: string; toolName?: string }>
  metadata?: {
    usage?: {
      input: number
      output: number
      total: number
    }
  } | null
}

/** 卡内某类块的文本（thinking / text） */
const blockTexts = (m: ListedMessage | undefined, type: string): string[] =>
  (m?.blocks ?? []).filter((b) => b.type === type).map((b) => b.text ?? '')

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
const sids: Record<string, string> = {}
let defaultTitle = ''
let readFile = ''

const createSession = async (title: string, projectId: string): Promise<string> =>
  app.main.eval<string>(
    `window.api.session
      .create(${JSON.stringify({ title, projectId })})
      .then((s) => s.id)`
  )

const listSessionIds = (): Promise<string[]> =>
  app.main.eval<string[]>(`window.api.session.list().then((ss) => ss.map((s) => s.id))`)

const titleOf = (sid: string): Promise<string> =>
  app.main.eval<string>(`window.api.session.getById(${JSON.stringify(sid)}).then((s) => s.title)`)

const listMessages = (sid: string): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

/** 本会话收到的事件（收集器是全局的，按 sessionId 过滤） */
const sessionEvents = async (sid: string): Promise<RecordedEvent[]> =>
  (await events.all()).filter((e) => e.sessionId === sid)

/** 事件里的消息载荷（user_message / step_end / agent_end 的 message 字段） */
const payloadOf = (event: RecordedEvent | undefined): ListedMessage | null =>
  event && typeof event.message === 'string' ? (JSON.parse(event.message) as ListedMessage) : null

/** 只比投影契约关心的 4 个字段（model/createdAt 两条路径语义不同，见清单） */
const identityOf = (m: ListedMessage): [string, string, string, string] => [
  m.id,
  m.role,
  m.type,
  m.content
]

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  // 会话一律绑项目：工具用例的 read 目标落在 projDir 内，天然不撞 ask-on-read
  const projDir = join(app.home, 'proj-stream')
  mkdirSync(projDir, { recursive: true })
  readFile = join(projDir, 'hello.txt')
  writeFileSync(readFile, 'HELLO E2E\n')
  const project = await createProject(app.main, { name: 'StreamProj', path: projDir })

  sids.stream = await createSession('S-stream', project.id)
  sids.usage = await createSession('S-usage', project.id)
  sids.thinking = await createSession('S-thinking', project.id)
  sids.scratch = await createSession('S-scratch', project.id)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  // 侧栏拉一次全量列表（IPC 建的会话无广播）；顺带得到一条默认标题的会话给自动标题用例
  const before = await listSessionIds()
  await sidebar.clickNewChat()
  await until(async () => (await listSessionIds()).length === before.length + 1, 'new chat created')
  sids.title = (await listSessionIds()).find((id) => !before.includes(id))!
  defaultTitle = await titleOf(sids.title)
  await until(async () => (await sidebar.titles()).includes('S-stream'), 'sidebar list refreshed')

  events = eventRecorder(app.main)
  await events.install()
})

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('流式发送与重开一致性', () => {
  let liveUser: ListedMessage | null = null
  let liveAssistant: ListedMessage | null = null

  it('输入框发送：用户气泡 + 助手卡片，事件序列 agent_start → text_delta* → text_end → agent_end', async () => {
    provider.reset()
    await events.clear()
    provider.script({
      text: ['Hello', ' ', 'world'],
      chunkDelayMs: 40,
      usage: { prompt: 120, completion: 6 }
    })

    expect(await sidebar.openSession('S-stream')).toBe(true)
    await chat.ready()
    // 输入框为空时发送键本就是灰的；填字后才应可点（模型已由 useSessionInit 同步）
    expect(await chat.sendDisabled()).toBe(true)
    await chat.type('ping one')
    expect(await chat.sendDisabled()).toBe(false)
    await chat.pressEnter()
    await events.waitFor('agent_end', { sessionId: sids.stream })
    await chat.waitIdle()

    const all = await sessionEvents(sids.stream)
    const types = all.map((e) => e.type)
    expect(types.indexOf('agent_start')).toBe(0)
    expect(types.filter((t) => t === 'text_delta').length).toBe(3)
    expect(types.indexOf('text_end')).toBeGreaterThan(types.lastIndexOf('text_delta'))
    expect(types.at(-1)).toBe('agent_end')

    // C-02：气泡完全来自 user_message 事件回环（sendToMainAgent 只置流式态，不做乐观插入）
    liveUser = payloadOf(all.find((e) => e.type === 'user_message'))
    liveAssistant = payloadOf(all.find((e) => e.type === 'agent_end'))
    expect(liveUser?.content).toBe('ping one')

    const listed = await listMessages(sids.stream)
    expect(listed.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(listed[0].id).toBe(liveUser?.id)

    const items = await chat.settledItems()
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ role: 'user', type: 'text', text: 'ping one' })
    expect(items[1]).toMatchObject({ role: 'assistant', type: 'message', text: 'Hello world' })
    expect(await chat.loadingDots()).toBe(false)
    expect(await chat.isBusy()).toBe(false)
  })

  it('重开：message.list 的 [id, role, type, content] 与流式事件逐条一致，DOM 不变', async () => {
    const listed = await listMessages(sids.stream)
    expect(listed.map(identityOf)).toEqual(
      [liveUser, liveAssistant].map((m) => identityOf(m as ListedMessage))
    )

    const before = await chat.settledItems()
    expect(await sidebar.openSession('S-scratch')).toBe(true)
    expect(await chat.settledItems()).toHaveLength(0)

    expect(await sidebar.openSession('S-stream')).toBe(true)
    await until(
      async () => (await chat.settledItems()).length === before.length,
      'session reopened'
    )
    expect(await chat.settledItems()).toEqual(before)
  })
})

describe('用量', () => {
  it('每条助手卡片只记自己那次调用；整轮聚合留在 agent_end 事件里', async () => {
    provider.reset()
    await events.clear()
    provider.script(
      {
        toolCalls: [{ id: 'call_usage', name: 'read', args: JSON.stringify({ path: readFile }) }],
        usage: { prompt: 100, completion: 10 }
      },
      { text: 'done', usage: { prompt: 120, completion: 8 } }
    )

    expect(await sidebar.openSession('S-usage')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('run a tool')
    await events.waitFor('agent_end', { sessionId: sids.usage })
    await chat.waitIdle()

    // 一条 entry = 一次 LLM 调用 = 一条消息，账各归各
    const listed = await listMessages(sids.usage)
    expect(listed.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
    const toolRound = listed[1]
    const final = listed[2]
    expect(blockTexts(toolRound, 'text')).toEqual([])
    expect(toolRound.blocks?.some((b) => b.type === 'tool')).toBe(true)
    expect(toolRound.metadata?.usage).toMatchObject({ input: 100, output: 10, total: 110 })
    expect(final).toMatchObject({ role: 'assistant', type: 'message', content: 'done' })
    expect(final.metadata?.usage).toMatchObject({ input: 120, output: 8, total: 128 })

    // 整轮聚合（上下文占用指示器的来源）只在 agent_end 事件上
    const end = (await sessionEvents(sids.usage)).find((e) => e.type === 'agent_end')!
    expect(end.usage).toMatchObject({ input: 220, output: 18, total: 238 })
    expect((end.usage as { details: unknown[] }).details).toHaveLength(2)

    // 本轮结局：通知层按它分「完成 / 失败」文案，正常跑完必须是 'ok'
    // （跨进程字段，改动只会在这里露出来）
    expect(end.reason).toBe('ok')

    // 用量不再上屏（ebff5581「助手消息去模型名与用量行」把它从卡片上撤了），
    // 故本用例只断数据：呈现与否是产品决定。

    // 重开：投影路径与流式路径必须给出同一批数字
    expect(await sidebar.openSession('S-scratch')).toBe(true)
    expect(await sidebar.openSession('S-usage')).toBe(true)
    await until(async () => (await chat.settledItems()).length > 0, 'usage session reopened')
    const reopened = await listMessages(sids.usage)
    expect(reopened[1].metadata?.usage).toMatchObject({ input: 100, output: 10, total: 110 })
    expect(reopened[2].metadata?.usage).toMatchObject({ input: 120, output: 8, total: 128 })
  })
})

describe('思考块', () => {
  it('只有空白的思考不成块、不渲染；有内容的思考流式出现且重开保留', async () => {
    provider.reset()
    await events.clear()
    provider.script({ thinking: '\n \n', text: 'blank thinking' })

    expect(await sidebar.openSession('S-thinking')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('first')
    await events.waitFor('agent_end', { sessionId: sids.thinking })
    await chat.waitIdle()

    let listed = await listMessages(sids.thinking)
    expect(blockTexts(listed.at(-1), 'thinking')).toEqual([])
    expect(await chat.thinkingBlocks()).toBe(0)

    provider.script({ thinking: ['Let me ', 'think'], text: 'real thinking' })
    await chat.typeAndSend('second')
    await until(
      async () => (await listMessages(sids.thinking)).length === 4,
      'second round persisted'
    )
    await chat.waitIdle()

    listed = await listMessages(sids.thinking)
    expect(blockTexts(listed.at(-1), 'thinking')).toEqual(['Let me think'])
    expect(await chat.thinkingBlocks()).toBe(1)

    // 重开：思考随 blocks 还原，数量不变
    expect(await sidebar.openSession('S-scratch')).toBe(true)
    expect(await sidebar.openSession('S-thinking')).toBe(true)
    await until(async () => (await chat.settledItems()).length === 4, 'thinking session reopened')
    expect(await chat.thinkingBlocks()).toBe(1)
  })
})

describe('自动标题', () => {
  it('首轮生成的标题回写会话并同步侧栏', async () => {
    provider.reset()
    await events.clear()

    // 自动标题现在是 **auto-title 工作流派发 titler agent**，不再是那条带 TITLE_MARKER 的
    // 专用请求 —— 所以它是一次普通对话请求，会正常消费脚本队列。用 `when` 按内容认领：
    // titler 的工具集里有 session 工具，主对话没有（按工具名精确匹配 —— 单词 session
    // 在别的工具描述里也出现，子串匹配会误认领）。
    // （fakeProvider 里那条「标题请求不消费队列」的分支因此已是死代码，见 TITLE_MARKER。）
    const isTitler = (r: { body: { tools?: unknown[] } }): boolean =>
      JSON.stringify(r.body.tools ?? []).includes('"name":"session"')
    provider.script(
      { text: 'titled', when: (r) => !isTitler(r) },
      // titler 先用 session 工具写标题……
      {
        toolCalls: [
          {
            id: 'call_title',
            name: 'session',
            args: JSON.stringify({ action: 'set-title', title: 'E2E 标题' })
          }
        ],
        when: isTitler
      },
      // ……再以结果契约收尾
      {
        toolCalls: [{ id: 'call_next', name: 'next', args: JSON.stringify({ title: 'E2E 标题' }) }],
        when: isTitler
      }
    )

    expect(await sidebar.openSession(defaultTitle)).toBe(true)
    await chat.ready()
    await chat.typeAndSend('give me a title')
    await events.waitFor('agent_end', { sessionId: sids.title })

    await until(
      async () => (await titleOf(sids.title)) === 'E2E 标题',
      'session title written back'
    )
    await until(async () => (await sidebar.titles()).includes('E2E 标题'), 'sidebar title synced')

    // 主对话一次 + titler 两次（工具调用一次、契约收尾一次）
    expect(provider.chatRequests().filter((r) => !isTitler(r))).toHaveLength(1)
  })
})
