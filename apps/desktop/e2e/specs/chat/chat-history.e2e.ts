/**
 * 附图 / 内联 Token 芯片 / 回退 / 重新生成 —— 「消息本身携带的东西」在
 * 流式与重开两条路径上是否都还原得回来。
 *
 * 附图与芯片走 IPC 直发（`agent.prompt` 的 images / inlineTokens 参数），
 * 避开粘贴与拖拽的浏览器事件模拟；回退与重新生成必须走 DOM —— 被测的正是那两条 UI 链路。
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
import { chatPane, sidebarPane, type ChatPane, type SidebarPane } from '../../harness/pages'

const MODEL = 'e2e-model'

/** 4×4 RGB PNG（zlib 生成，CRC 正确）—— 解码成功才有 naturalWidth > 0 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4IWcDRwzEcQDgQxIh0JD36gAAAABJRU5ErkJggg=='

interface ListedMessage {
  id: string
  role: string
  type: string
  content: string
  metadata?: {
    images?: Array<{ data: string; mimeType: string }>
    inlineTokens?: Record<string, { displayText: string; payload: string }>
  } | null
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

/** 经 IPC 发一条 prompt（不 await 整轮：`agent:prompt` 要等 run 跑完才 resolve） */
const promptViaIpc = (params: Record<string, unknown>): Promise<unknown> =>
  app.main.eval(`window.api.agent.prompt(${JSON.stringify(params)}).catch(() => undefined); true`)

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const projDir = join(app.home, 'proj-history')
  mkdirSync(projDir, { recursive: true })
  const project = await createProject(app.main, { name: 'HistoryProj', path: projDir })

  sids.image = await createSession('H-image', project.id)
  sids.token = await createSession('H-token', project.id)
  sids.rollback = await createSession('H-rollback', project.id)
  sids.regen = await createSession('H-regen', project.id)
  sids.scratch = await createSession('H-scratch', project.id)

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes('H-image'), 'sidebar list refreshed')

  events = eventRecorder(app.main)
  await events.install()
})

afterAll(async () => {
  await provider.close()
  await app.stop()
})

describe('用户附图', () => {
  it('发送即显示且能解码，重开后仍能解码', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'saw the image' })

    expect(await sidebar.openSession('H-image')).toBe(true)
    await chat.ready()
    await promptViaIpc({
      sessionId: sids.image,
      text: 'look at this',
      images: [{ type: 'image', data: PNG_B64, mimeType: 'image/png' }]
    })
    await events.waitFor('agent_end', { sessionId: sids.image })
    await chat.waitIdle()

    const listed = await listMessages(sids.image)
    const user = listed[0]
    expect(user.metadata?.images?.[0].mimeType).toBe('image/png')
    expect(user.metadata?.images?.[0].data).toBeTruthy()
    // 落库的是裸 base64（`data:` 前缀由 imageSrc 按 mimeType 现补，见 38de169d）
    expect(user.metadata?.images?.[0].data.startsWith('data:')).toBe(false)

    await until(async () => (await chat.images()).length === 1, 'user image rendered')
    await until(async () => (await chat.images())[0].complete, 'user image decoded')
    expect(await chat.images()).toEqual([{ naturalWidth: 4, complete: true }])

    // 重开路径没有 preview，只能靠 imageSrc 按 mimeType 补前缀
    expect(await sidebar.openSession('H-scratch')).toBe(true)
    expect(await sidebar.openSession('H-image')).toBe(true)
    await until(async () => (await chat.images()).length === 1, 'user image reprojected')
    await until(async () => (await chat.images())[0].complete, 'user image re-decoded')
    expect(await chat.images()).toEqual([{ naturalWidth: 4, complete: true }])
  })
})

describe('内联 Token 侧车', () => {
  it('展开态发给模型、标记态留给 UI，重开后芯片不退化成裸标记', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'reviewed' })

    expect(await sidebar.openSession('H-token')).toBe(true)
    await chat.ready()
    await promptViaIpc({
      sessionId: sids.token,
      text: '{{shuvixInlineToken:t1}} 请看',
      inlineTokens: {
        t1: { type: 'cmd', id: 'x', displayText: '/review', payload: 'REVIEW-EXPANDED' }
      }
    })
    await events.waitFor('agent_end', { sessionId: sids.token })
    await chat.waitIdle()

    // 模型看到的是展开态
    const first = provider.chatRequests()[0]
    expect(first.raw).toContain('REVIEW-EXPANDED')
    expect(first.raw).not.toContain('shuvixInlineToken')

    // UI 看到的是标记态 + 字典
    const listed = await listMessages(sids.token)
    expect(listed[0].content).toContain('{{shuvixInlineToken:t1}}')
    expect(listed[0].metadata?.inlineTokens?.t1.displayText).toBe('/review')

    // live：handleMessageEnd 把侧车父 entry 一起投影
    expect(await chat.tokenBadges(listed[0].id)).toEqual(['/review'])
    const liveText = (await chat.settledItems())[0].text
    expect(liveText).toContain('/review')
    expect(liveText).not.toContain('{{shuvixInlineToken')

    // reload：pendingInline 还原（另一段代码）
    expect(await sidebar.openSession('H-scratch')).toBe(true)
    expect(await sidebar.openSession('H-token')).toBe(true)
    await until(async () => (await chat.settledItems()).length === 2, 'token session reopened')
    expect(await chat.tokenBadges(listed[0].id)).toEqual(['/review'])
    expect((await chat.settledItems())[0].text).not.toContain('{{shuvixInlineToken')
  })
})

describe('回退', () => {
  it('回退截断会话树并把原文回填输入框，之后还能正常再发一次', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'first answer' }, { text: 'second answer' })

    expect(await sidebar.openSession('H-rollback')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('rollback me')
    await events.waitFor('agent_end', { sessionId: sids.rollback })
    await chat.waitIdle()

    const listed = await listMessages(sids.rollback)
    expect(listed).toHaveLength(2)

    await chat.clickRollback(listed[0].id)
    expect(await chat.confirmOpen()).toBe(true)
    await chat.confirmAccept()

    await until(async () => (await listMessages(sids.rollback)).length === 0, 'tree truncated')
    await until(async () => (await chat.inputValue()) === 'rollback me', 'draft restored')
    expect(await chat.settledItems()).toHaveLength(0)

    // 回填的草稿可以直接再发一次
    await chat.pressEnter()
    await events.waitFor('agent_end', { sessionId: sids.rollback })
    await chat.waitIdle()
    // 「第二轮真的跑完了」的确定性锚点：收集器按游标推进，两轮就该有两条 agent_end。
    // 老实现的 waitFor 按整个缓冲区 find，这里会秒回第一轮那条，本条断言即恒为 1 ——
    // 下面几条消息断言的偶发失败正是那个陈旧命中的下游表现。
    const ends = (await events.all()).filter(
      (e) => e.type === 'agent_end' && e.sessionId === sids.rollback
    )
    expect(ends).toHaveLength(2)
    const again = await listMessages(sids.rollback)
    expect(again.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(again[1].content).toBe('second answer')
  })
})

describe('重新生成', () => {
  it('末条助手卡片被新回复替换，卡片不增殖', async () => {
    provider.reset()
    await events.clear()
    provider.script({ text: 'original answer' }, { text: 'regenerated answer' })

    expect(await sidebar.openSession('H-regen')).toBe(true)
    await chat.ready()
    await chat.typeAndSend('answer me')
    await events.waitFor('agent_end', { sessionId: sids.regen })
    await chat.waitIdle()

    const before = await listMessages(sids.regen)
    expect(before[1].content).toBe('original answer')
    expect(await chat.settledItems()).toHaveLength(2)

    await chat.clickRegenerate(before[1].id)
    await until(
      async () => (await listMessages(sids.regen))[1]?.content === 'regenerated answer',
      'regenerated'
    )
    await chat.waitIdle()

    const after = await listMessages(sids.regen)
    expect(after.map((m) => `${m.role}/${m.type}`)).toEqual(['user/text', 'assistant/message'])
    expect(after[1].content).toBe('regenerated answer')
    await until(async () => (await chat.settledItems()).length === 2, 'card count unchanged')
    expect((await chat.settledItems()).at(-1)?.text).toBe('regenerated answer')
  })
})
