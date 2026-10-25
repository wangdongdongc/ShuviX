/**
 * 提议（`suggest` 工具，2026-10-25）—— 单测（suggestions.test.ts / suggestTool.test.ts / chatGatewayAcceptSuggestion /
 * suggestionHandlers / suggestionCards.dom / conversationSuggestions.dom）各管一段，这里只走一遍它们都替身掉的那条链：
 * 模型真调 suggest → 工具结果落进会话 → 渲染端画出卡片 → 点「采纳」→ preload → IPC `suggestion:accept` → 网关从会话里
 * 取那句话、盖上提议引用 → 起一轮 → 那句话真的发给了模型 → 视图带着 `origin.suggestion` 回来 → 卡片翻成「已采纳」、
 * 用户气泡带上「采纳的提议」标签。
 *
 *   S-1 fake provider 先发一次 suggest（两条），再发终答；卡片两张、都可点。点第二张（index 1）→ 下一次请求的最后一条
 *       user 正是那条的 message；会话里多出一条用户消息，正文就是它、`metadata.origin` 是 `{kind: local, suggestion:
 *       {messageId: 那张助手卡的 id, toolCallId, index: 1}}`；屏上那条用户气泡带 `[data-origin-suggestion]`、正文相同；
 *       卡片 1 `data-suggestion-accepted`、卡片 0 压淡、没有按钮了；再经 IPC 采纳同一组 → closed，不再发请求
 *
 * 选择器全部走 `harness/pages.ts` 的 `suggestionsPane`。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, until } from '../../harness/cdp'
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
  sidebarPane,
  suggestionsPane,
  type ChatPane,
  type SidebarPane,
  type SuggestionsPane
} from '../../harness/pages'

const MODEL = 'e2e-model'
const TITLE = 'Suggest-S1'
const CALL_ID = 'call_suggest_1'
const SUGGESTIONS = [
  { title: 'Add tests', message: 'Yes, also add tests for the parser', detail: 'It has none' },
  { title: 'Update the README', message: 'Please update the README with the new flag too' }
]

interface ListedMessage {
  id: string
  role: string
  content: string
  blocks?: Array<{ type: string; toolName?: string; toolCallId?: string }>
  metadata?: { origin?: unknown } | null
}

let app: E2EApp
let provider: FakeProvider
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let cards: SuggestionsPane
let sid = ''

const listMessages = (): Promise<ListedMessage[]> =>
  app.main.eval<ListedMessage[]>(`window.api.message.list(${JSON.stringify(sid)})`)

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)

  const projDir = join(app.home, 'proj-suggest')
  mkdirSync(projDir, { recursive: true })
  const project = await createProject(app.main, { name: 'SuggestProj', path: projDir })
  sid = await app.main.eval<string>(
    `window.api.session.create(${JSON.stringify({ title: TITLE, projectId: project.id })}).then((s) => s.id)`
  )

  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  cards = suggestionsPane(app.main)
  // IPC 建的会话没有广播：点一次「新对话」让侧栏拉全量列表
  await sidebar.clickNewChat()
  await until(async () => (await sidebar.titles()).includes(TITLE), 'sidebar lists the session')

  events = eventRecorder(app.main)
  await events.install()
}, 120_000)

afterAll(async () => {
  await provider?.close()
  await app?.stop()
})

describe('采纳一条提议', () => {
  it('S-1 suggest → 卡片 → 采纳 index 1 → 那句话发给模型、带着提议引用回到会话，卡片翻成已采纳', async () => {
    provider.reset()
    provider.script(
      {
        toolCalls: [
          { id: CALL_ID, name: 'suggest', args: JSON.stringify({ suggestions: SUGGESTIONS }) }
        ],
        usage: { prompt: 90, completion: 10 }
      },
      { text: 'Done with the fix.', usage: { prompt: 110, completion: 5 } },
      { text: 'Updating the README now.', usage: { prompt: 130, completion: 5 } }
    )

    expect(await sidebar.openSession(TITLE)).toBe(true)
    await chat.ready()
    await chat.typeAndSend('fix the bug')
    await events.waitFor('agent_end', { sessionId: sid })
    await chat.waitIdle()

    // 工具真的跑了：suggest 调用在会话里，结果落定
    const before = await listMessages()
    const owner = before.find((m) =>
      m.blocks?.some((b) => b.type === 'tool' && b.toolName === 'suggest')
    )
    expect(owner, 'assistant message holding the suggest call').toBeDefined()
    expect(provider.chatRequestCount()).toBe(2)

    // 卡片：一组、两张、都开着
    const [open] = await until(async () => {
      const groups = await cards.groups()
      return groups.length === 1 && groups[0]!.cards.length === 2 ? groups : null
    }, 'suggestion cards rendered')
    expect(open!.state).toBe('open')
    expect(open!.cards.map((c) => [c.index, c.message, c.acceptable])).toStrictEqual([
      [0, SUGGESTIONS[0]!.message, true],
      [1, SUGGESTIONS[1]!.message, true]
    ])

    // 点第二张
    const since = await events.mark()
    expect(await cards.accept(1)).toBe(true)
    await events.waitFor('agent_end', { sessionId: sid, since })
    await chat.waitIdle()

    // 那句话真的发给了模型：第三次请求的最后一条 user 就是它
    expect(provider.chatRequestCount()).toBe(3)
    const third = provider.requests()[2]!
    expect(third.lastUserText.endsWith(SUGGESTIONS[1]!.message)).toBe(true)

    // 会话里多出的那条用户消息：正文 = 那条的 message，来源 = 本机窗口 + 提议引用
    const after = await listMessages()
    const accepted = after.filter((m) => m.role === 'user').pop()!
    expect(accepted.content).toBe(SUGGESTIONS[1]!.message)
    expect(accepted.metadata?.origin).toStrictEqual({
      kind: 'local',
      suggestion: { messageId: owner!.id, toolCallId: CALL_ID, index: 1 }
    })

    // 屏上：用户气泡带「采纳的提议」标签，正文相同
    const bubbles = await until(async () => {
      const list = await cards.acceptedBubbles()
      return list.length === 1 ? list : null
    }, 'accepted-suggestion bubble rendered')
    expect(bubbles).toStrictEqual([{ id: accepted.id, text: SUGGESTIONS[1]!.message }])

    // 卡片翻成已采纳：1 是采纳的那张，0 压淡，没有按钮了
    const [done] = await until(async () => {
      const groups = await cards.groups()
      return groups[0]?.state === 'accepted' ? groups : null
    }, 'suggestion group accepted')
    expect(done!.cards.map((c) => [c.index, c.accepted, c.dimmed, c.acceptable])).toStrictEqual([
      [0, false, true, false],
      [1, true, false, false]
    ])

    // 同一组再经 IPC 采纳 → closed，不再发请求
    const again = await app.main.eval<unknown>(
      `window.api.suggestion.accept(${JSON.stringify({
        sessionId: sid,
        messageId: owner!.id,
        toolCallId: CALL_ID,
        index: 0
      })})`
    )
    expect(again).toStrictEqual({ success: false, reason: 'closed' })
    await sleep(500)
    expect(provider.chatRequestCount()).toBe(3)
  })
})
