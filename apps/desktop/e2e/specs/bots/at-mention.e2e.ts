/**
 * A3 · @提及胶囊，端到端 —— 弹层（成员优先/过滤/键盘）→ 胶囊落输入框 → token 生产
 * （contentText 带标记 + metadata.inlineTokens）→ L0 按 token.id 精确定向（via:'token'）
 * → 署名回复落树；外加回退重建（胶囊消息回填输入框后原样重发仍走 token 路）与
 * 程序化半链锚点（不经 DOM，直接 `agent.prompt` 带手写 bot token）。
 *
 * 双断纪律：链路事实走 IPC（message.list / decisions.jsonl / 假提供商请求记录），
 * 弹层与气泡只在 DOM 断「屏幕上长出来了什么」（选择器全部收在 pages.ts 的
 * atPopoverPane / chatPane）。bot 候选与文件表都是异步拉的 —— 行的出现一律 until 等，
 * 不用裸 sleep。
 *
 * 弹层行选择的两条通道都被钉住：键盘（弹层开着时 Enter **只选中不发送**，C1 专门断
 * 第一次回车没把消息发出去）与鼠标（行按钮监听 onMouseDown，pages.ts 派发 bubbling
 * mousedown；element.click() 选不中）。
 *
 * C11（同 bot 双胶囊）舍弃：生产端去重发生在 buildOutgoing（hook 内部，B 组明确不建
 * hook 测试设施），门侧的提及去重是 M4′ 既有单测钉过的分支 —— 两头都已有归属，
 * 在这里再走一遍 UI 只是重复。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { until } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import {
  createBotSession,
  createProject,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  writeBotMd,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import {
  atPopoverPane,
  chatPane,
  sidebarPane,
  type AtPopoverPane,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'

let app: E2EApp
let events: EventRecorder
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let pop: AtPopoverPane
let projectId: string

const MODEL = 'e2e-model'

/** C1 的会话与胶囊消息 —— C2（气泡呈现）与 C9（回退重建）接着用 */
let sidC1 = ''
let c1UserMsgId = ''

/** 脚本化一次门控判定（意图段靠 `next` 工具交回结构化结果；同 pipeline.e2e.ts） */
function gate(
  verdict: Record<string, unknown>,
  when?: (r: FakeRequest) => boolean
): Parameters<FakeProvider['script']>[0] {
  return {
    toolCalls: [{ id: 'call_next', name: 'next', args: JSON.stringify(verdict) }],
    usage: { prompt: 200, completion: 20 },
    ...(when ? { when } : {})
  }
}

/** 按提示词里的 displayName 认领自己那一份脚本 */
const forBot =
  (displayName: string) =>
  (r: FakeRequest): boolean =>
    !r.isTitle && r.raw.includes(displayName)

interface Msg {
  id: string
  role?: string
  content?: unknown
  metadata?: {
    sender?: { kind: string; name: string; displayName: string }
    inlineTokens?: Record<string, { type: string; id: string; displayText: string }>
  } | null
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

const replies = async (sid: string): Promise<Msg[]> =>
  (await listMessages(sid)).filter((m) => m.role === 'assistant')

const untilReplies = (sid: string, n: number, timeoutMs = 25_000): Promise<Msg[]> =>
  until(
    async () => {
      const msgs = await replies(sid)
      return msgs.length >= n ? msgs : undefined
    },
    `${n} assistant message(s) on ${sid}`,
    timeoutMs
  )

/** 某个 bot 的决策记录（一行一条 JSON） */
function decisions(botName: string): Array<Record<string, unknown>> {
  const file = join(app.home, '.shuvix', 'bots', '.runs', botName, 'decisions.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const directedOf = (botName: string): Array<Record<string, unknown>> =>
  decisions(botName).filter((d) => d.kind === 'l0_directed')

const viaOfLast = (botName: string): string | undefined =>
  (directedOf(botName).at(-1)?.detail as { via?: string } | undefined)?.via

/** 侧栏里打开会话并等输入框就绪（弹层/气泡都只对活动会话渲染） */
async function openInUi(title: string): Promise<void> {
  await until(async () => (await sidebar.titles()).includes(title), `session ${title} listed`)
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()
  chat = chatPane(app.main)
  sidebar = sidebarPane(app.main)
  pop = atPopoverPane(app.main)

  // 成员：auto 一名 + mention-only 一名（@ 是后者唯一入口）+ C4 的双通道语料
  writeBotMd(app, 'at-alpha', { description: 'auto member', displayName: 'Alpha' })
  writeBotMd(app, 'at-quiet', {
    description: 'mention-only member',
    displayName: 'Quiet',
    respond: 'mention-only'
  })
  writeBotMd(app, 'at-scout', { description: 'CJK display name', displayName: '侦察兵' })
  writeBotMd(app, 'm-alpha', { description: 'identity-key hit', displayName: '旁观者' })
  // 'at-ghost' 刻意不写 —— C8 的幽灵成员

  // 工作区文件（C1 断「bot 行在文件行前」、C6 断「纯文件行」都要有真文件）
  const wsDir = join(app.home, 'at-ws')
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(wsDir, 'alpha-notes.md'), '# notes\n')
  writeFileSync(join(wsDir, 'zeta.txt'), 'zeta\n')
  projectId = (await createProject(app.main, { name: 'AT-WS', path: wsDir })).id
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
})

describe('@ 弹层 → 胶囊 → token 定向（主链路）', () => {
  it('C1 · 成员序在文件前 → 过滤 → 首个回车只选中 → 再回车发送 → via:token 定向', async () => {
    provider.reset()
    sidC1 = await createBotSession(app.main, {
      bots: ['at-alpha', 'at-quiet'],
      title: 'AT-C1',
      projectId
    })
    await openInUi('AT-C1')

    // bot 候选与文件表都是异步的：until 到「成员序的 bot 行在前 + 文件行跟在后」齐活
    await chat.type('大家好 @')
    await until(async () => {
      const keys = (await pop.rows()).map((r) => r.key)
      return (
        keys.length >= 3 &&
        keys[0] === 'bot:at-alpha' &&
        keys[1] === 'bot:at-quiet' &&
        keys.slice(2).every((k) => !k.startsWith('bot:'))
      )
    }, 'bot rows in member order before file rows')

    // 过滤到 quiet（显示名 Quiet 命中；文件与 Alpha 都被滤掉）
    await chat.type('大家好 @qui')
    await until(async () => {
      const keys = (await pop.rows()).map((r) => r.key)
      return keys.length === 1 && keys[0] === 'bot:at-quiet'
    }, 'filtered down to quiet')

    const msgsBefore = (await listMessages(sidC1)).length
    const alphaBefore = decisions('at-alpha').length

    // 第一次回车：弹层开着 → 只选中，不发送
    await chat.pressEnter()
    await until(async () => (await chat.inputValue()) === '大家好 @Quiet ', 'capsule inserted')
    expect((await listMessages(sidC1)).length).toBe(msgsBefore)

    // 脚本化 quiet 的意图段（定向 solo：恰一发），再第二次回车发送
    provider.script(
      gate(
        { decision: 'reply', relevance: 6, reason: '被点名', reply: '收到，我在。' },
        forBot('Quiet')
      )
    )
    await chat.pressEnter()

    const botReplies = await untilReplies(sidC1, 1)
    expect(botReplies).toHaveLength(1)
    expect(botReplies[0].metadata?.sender?.name).toBe('at-quiet')
    expect(botReplies[0].content).toBe('收到，我在。')
    // alpha 未被点名：不派发、零增量记录、无第二条回复
    expect(decisions('at-alpha').length).toBe(alphaBefore)

    // 定向经 token（不是裸文本降级）
    expect(directedOf('at-quiet').length).toBeGreaterThan(0)
    expect(viaOfLast('at-quiet')).toBe('token')

    // user 消息落树：content 是标记态原文，token 全量进 metadata（id 是身份键全名）
    const user = (await listMessages(sidC1)).find((m) => m.role === 'user')!
    c1UserMsgId = user.id
    expect(String(user.content)).toContain('{{shuvixInlineToken:')
    expect(String(user.content)).not.toContain('@Quiet')
    const tokens = Object.values(user.metadata?.inlineTokens ?? {})
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ type: 'bot', id: 'at-quiet', displayText: '@Quiet' })

    // 发给模型的是展开原文：@Quiet 在、标记不在
    const req = provider.chatRequests().find((r) => r.raw.includes('Quiet'))
    expect(req).toBeDefined()
    expect(req!.raw).toContain('@Quiet')
    expect(req!.raw).not.toContain('shuvixInlineToken')
  })

  it('C2 · 气泡胶囊：用户气泡 DOM 文本含 @Quiet、不含裸标记', async () => {
    expect(c1UserMsgId).not.toBe('')
    await until(
      async () => (await chat.settledItems()).some((i) => i.id === c1UserMsgId),
      'user bubble on screen'
    )
    // 胶囊本体（TokenChip 的 span[role=button]）显示 @显示名
    expect(await chat.tokenBadges(c1UserMsgId)).toContain('@Quiet')
    const item = (await chat.settledItems()).find((i) => i.id === c1UserMsgId)!
    expect(item.text).toContain('@Quiet')
    expect(item.text).not.toContain('shuvixInlineToken')
  })
})

describe('弹层交互（键盘 / 过滤 / 徽标）', () => {
  it('C3 · 键盘导航：空查询全员 → ArrowDown → Enter 选中第 2 个成员', async () => {
    await createBotSession(app.main, { bots: ['at-alpha', 'at-quiet'], title: 'AT-C3' })
    await openInUi('AT-C3')

    await chat.type('你们好 @')
    await until(async () => {
      const rows = await pop.rows()
      return rows.length === 2 && rows[0].key === 'bot:at-alpha' && rows[1].key === 'bot:at-quiet'
    }, 'both member rows listed')
    expect((await pop.rows())[0].selected).toBe(true)

    await chat.pressKey('ArrowDown')
    await until(async () => (await pop.rows())[1]?.selected === true, 'second row highlighted')

    await chat.pressEnter()
    await until(async () => (await chat.inputValue()) === '你们好 @Quiet ', 'second member picked')
  })

  it('C4 · 过滤双通道：`@侦察` 走显示名、`@M-AL` 走身份键，大小写不敏感（只开弹层不发送）', async () => {
    await createBotSession(app.main, { bots: ['at-scout', 'm-alpha'], title: 'AT-C4' })
    await openInUi('AT-C4')

    await chat.type('问下 @侦察')
    await until(async () => {
      const keys = (await pop.rows()).map((r) => r.key)
      return keys.length === 1 && keys[0] === 'bot:at-scout'
    }, 'CJK display-name hit')

    // 大写查询命中小写身份键 m-alpha（显示名「旁观者」不含该串 —— 命中只能来自身份键）
    await chat.type('问下 @M-AL')
    await until(async () => {
      const keys = (await pop.rows()).map((r) => r.key)
      return keys.length === 1 && keys[0] === 'bot:m-alpha'
    }, 'identity-key hit, case-insensitive')
  })

  it('C5 · mention-only 徽标：quiet 行内有徽标节点，普通成员行没有', async () => {
    await openInUi('AT-C3')
    await chat.type('大家 @')
    await until(async () => (await pop.rows()).length === 2, 'member rows listed')
    const rows = await pop.rows()
    expect(rows.find((r) => r.key === 'bot:at-quiet')!.mentionBadge).toBe(true)
    expect(rows.find((r) => r.key === 'bot:at-alpha')!.mentionBadge).toBe(false)
  })
})

describe('候选来源的边界（会话形态 / 切换 / 幽灵）', () => {
  it('C6 · 非聊天会话不漏 bot 行：普通 agent 会话输 @ 只有文件行', async () => {
    // 普通会话（无 bots）挂在同一个项目下 —— 有真文件，弹层才会真的开
    await app.main.eval(
      `window.api.session.create({ title: 'AT-C6', projectId: ${JSON.stringify(projectId)} })`
    )
    await openInUi('AT-C6')

    await chat.type('看下 @')
    await until(async () => {
      const keys = (await pop.rows()).map((r) => r.key)
      return keys.length > 0 && keys.every((k) => !k.startsWith('bot:'))
    }, 'file rows only, no bot rows')
    const keys = (await pop.rows()).map((r) => r.key)
    expect(keys).toContain('alpha-notes.md')
    expect(keys.some((k) => k.startsWith('bot:'))).toBe(false)
  })

  it('C7 · 切会话不串味：S1 见 alpha 后切 S2 只见 quiet', async () => {
    await createBotSession(app.main, { bots: ['at-alpha'], title: 'AT-C7A' })
    await createBotSession(app.main, { bots: ['at-quiet'], title: 'AT-C7B' })

    await openInUi('AT-C7A')
    await chat.type('hej @')
    await until(async () => {
      const keys = (await pop.rows()).map((r) => r.key)
      return keys.length === 1 && keys[0] === 'bot:at-alpha'
    }, 'S1 lists alpha')

    await openInUi('AT-C7B')
    await chat.type('hej @')
    await until(async () => {
      const keys = (await pop.rows()).map((r) => r.key)
      return keys.length === 1 && keys[0] === 'bot:at-quiet'
    }, 'S2 lists quiet only, alpha gone')
  })

  it('C8 · 幽灵成员：settings.bots 含无 md 的名字 → 只列存活成员，不崩', async () => {
    await createBotSession(app.main, { bots: ['at-alpha', 'at-ghost'], title: 'AT-C8' })
    await openInUi('AT-C8')
    await chat.type('人呢 @')
    await until(async () => {
      const keys = (await pop.rows()).map((r) => r.key)
      return keys.length === 1 && keys[0] === 'bot:at-alpha'
    }, 'only the living member listed')
  })
})

describe('回退重建与程序化半链', () => {
  it('C9 · 回退重建胶囊：明文恰为单个 @、重发仍走 token 路（已修，应绿）', async () => {
    expect(sidC1).not.toBe('')
    provider.reset()
    await openInUi('AT-C1')
    // 输入框是跨会话常驻组件（InputArea 不按 sessionId 重挂），上一条用例留下的 @ 触发态
    // 会让本用例的回车变成「选中」而不是发送。Esc 是确定性的关闭手势（弹层没开时无副作用）；
    // 用 type('') 清不掉 —— 本会话草稿本来就是空串，React 对同值 input 事件去重，refresh 不会跑
    await chat.pressKey('Escape')
    await until(async () => !(await pop.open()), 'stale popover dismissed')
    await until(
      async () => (await chat.settledItems()).some((i) => i.id === c1UserMsgId),
      'capsule message on screen'
    )

    await chat.clickRollback(c1UserMsgId)
    expect(await chat.confirmOpen()).toBe(true)
    await chat.confirmAccept()

    // 重建明文：单个 @（不翻倍）、无裸标记
    await until(async () => (await chat.inputValue()) === '大家好 @Quiet', 'draft rebuilt')
    const val = await chat.inputValue()
    expect(val).not.toContain('@@')
    expect(val).not.toContain('{{shuvixInlineToken')

    // 原样重发：第二次定向仍是 token（胶囊经 restoreFromTokens 重新登记）
    const before = directedOf('at-quiet').length
    provider.script(
      gate(
        { decision: 'reply', relevance: 6, reason: '再次被点名', reply: '第二次收到。' },
        forBot('Quiet')
      )
    )
    await chat.pressEnter()

    const msgs = await untilReplies(sidC1, 1)
    expect(msgs[0].metadata?.sender?.name).toBe('at-quiet')
    expect(directedOf('at-quiet').length).toBe(before + 1)
    expect(viaOfLast('at-quiet')).toBe('token')
  })

  it('C10 · 程序化半链锚点：手写 bot token、全文无裸 @名 → via:token + 投影带回 token', async () => {
    provider.reset()
    await events.clear()
    const sid = await createBotSession(app.main, { bots: ['at-quiet'], title: 'AT-C10' })
    const before = directedOf('at-quiet').length
    provider.script(
      gate(
        { decision: 'reply', relevance: 6, reason: '被点名', reply: '看到了。' },
        forBot('Quiet')
      )
    )

    // 文本里没有任何 @ —— 定向若发生，只可能来自 token（裸文本降级无从命中）
    await app.main.eval(
      `window.api.agent.prompt(${JSON.stringify({
        sessionId: sid,
        text: '请安静的那位看一下 {{shuvixInlineToken:x0}}',
        inlineTokens: {
          x0: {
            type: 'bot',
            id: 'at-quiet',
            displayText: '@Quiet',
            payload: '@Quiet',
            name: 'Quiet'
          }
        }
      })})`
    )

    // user_message 广播的投影切片带回 token（重开会话走同一投影，见 message.list 断言）
    const evt = await events.waitFor<RecordedEvent & { message: string }>('user_message', {
      sessionId: sid
    })
    const projected = JSON.parse(evt.message) as Msg
    expect(String(projected.content)).toContain('{{shuvixInlineToken:x0}}')
    expect(projected.metadata?.inlineTokens?.x0).toMatchObject({ type: 'bot', id: 'at-quiet' })

    const msgs = await untilReplies(sid, 1)
    expect(msgs[0].metadata?.sender?.name).toBe('at-quiet')
    expect(directedOf('at-quiet').length).toBe(before + 1)
    expect(viaOfLast('at-quiet')).toBe('token')

    const user = (await listMessages(sid)).find((m) => m.role === 'user')!
    expect(user.metadata?.inlineTokens?.x0).toMatchObject({ type: 'bot', id: 'at-quiet' })
  })
})
