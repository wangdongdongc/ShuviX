/**
 * A2 · 对话流完整渲染（C 组后半）—— 失败卡、BotReply 双形态、追问 chip、救济 chip、
 * 「正在判断」行、全体沉默提示的三个出口、子代理面板的 bot-intent 折叠纪律。
 *
 * 除 C-15（真 bot-chat 意图段，需要假提供商喂 `next` 裁决）外全程零 LLM：
 * `a2-ui-probe` 是参数化 bot 管线，结局（mode / sayLine）与相位窗（preClaimMs）
 * 全部读自各 bot md 的 `shuvix-bot-input`。
 *
 * 双断纪律：同一条消息先按 id 走 IPC（message.list 的 metadata），再进 DOM 断视觉物
 * （data-* 锚点，经 pages.ts 的 botFlowPane）—— DOM 只answers「屏幕上长出来了什么」。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sleep, until } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider, type FakeRequest } from '../../harness/fakeProvider'
import {
  createBotSession,
  eventRecorder,
  seedFakeProvider,
  waitRendererReady,
  writeBotMd,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'
import {
  botFlowPane,
  chatPane,
  sidebarPane,
  type BotFlowPane,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'

let app: E2EApp
let events: EventRecorder
let provider: FakeProvider
let chat: ChatPane
let sidebar: SidebarPane
let flow: BotFlowPane

const MODEL = 'e2e-model'
const PROBE = 'a2-ui-probe'

/**
 * 结局分支全部由 `input.mode` 选中；reply-bubble / reply-full / reply-error 的结构
 * 硬编码在管线里（writeBotMd 的 botInput 只走扁平标量），spec 侧按同一份常量断言。
 */
const PROBE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${PROBE}`,
  'description: A2 e2e probe — endings and the pre-claim window come from shuvix-bot-input.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  'A2 参数化 bot 管线（渲染半边）：结局与意图窗全部来自 bot md 的 `shuvix-bot-input`，零 LLM。',
  '',
  '```js workflow',
  '// 「正在判断」行的观察窗：claim 之前先睡',
  'if (input.preClaimMs) {',
  '  try {',
  '    await sleep(input.preClaimMs)',
  '  } catch (e) {',
  "    log('pre-claim wake: ' + String((e && e.message) || e))",
  "    return { outcome: 'aborted-before-claim' }",
  '  }',
  '}',
  '',
  'var verdict = await claim({',
  "  decision: input.decision || 'reply',",
  "  relevance: typeof input.relevance === 'number' ? input.relevance : 5,",
  '  reason: input.reason',
  '})',
  'if (!verdict.won) return { outcome: verdict.reason }',
  '',
  "if (input.mode === 'mute') return { outcome: 'won-but-mute' }",
  "if (input.mode === 'say-error') {",
  "  await say(input.sayLine || '出错降级的一句', { error: true })",
  "  return { outcome: 'said-error' }",
  '}',
  "if (input.mode === 'reply-error') {",
  "  await say({ headline: '出错但有结构', body: '带着结构的降级通告。' }, { error: true })",
  "  return { outcome: 'said-reply-error' }",
  '}',
  "if (input.mode === 'reply-bubble') {",
  "  await say({ headline: '结论要加粗', body: '气泡形态只有散文正文。' })",
  "  return { outcome: 'reply' }",
  '}',
  "if (input.mode === 'reply-full') {",
  '  await say({',
  "    headline: '查完了，两处待修',",
  "    body: '鉴权中间件的空值判断没跟上。',",
  "    points: ['auth.ts:42 缺判空', 'router 顺序变了'],",
  "    table: { columns: ['接口', '状态'], rows: [['/login', '待修']] },",
  "    status: 'warn',",
  "    followups: ['要我直接改吗？']",
  '  })',
  "  return { outcome: 'reply' }",
  '}',
  '',
  '// working/queued 窗（C-10 的卡与回执要靠它撑开）',
  'if (input.turnMs) {',
  '  await turn(async function (slot) {',
  '    await sleep(input.turnMs)',
  '  })',
  '}',
  '',
  "await say(input.sayLine || 'ok', { decision: 'reply' })",
  "return { outcome: 'reply' }",
  '```',
  ''
].join('\n')

/** reply-full 的期望面（与 PROBE_MD 里的字面量同一份数据） */
const FULL_REPLY = {
  headline: '查完了，两处待修',
  body: '鉴权中间件的空值判断没跟上。',
  points: ['auth.ts:42 缺判空', 'router 顺序变了'],
  table: { columns: ['接口', '状态'], rows: [['/login', '待修']] },
  status: 'warn',
  followups: ['要我直接改吗？']
}

interface ProbeSeed {
  displayName: string
  decision?: 'reply' | 'task' | 'clarify' | 'ignore'
  relevance?: number
  reason?: string
  sayLine?: string
  mode?: 'mute' | 'say-error' | 'reply-error' | 'reply-bubble' | 'reply-full'
  preClaimMs?: number
}

function probe(name: string, seed: ProbeSeed): string {
  const botInput: Record<string, string | number> = {}
  for (const k of ['decision', 'relevance', 'reason', 'sayLine', 'mode', 'preClaimMs'] as const) {
    if (seed[k] !== undefined) botInput[k] = seed[k] as string | number
  }
  writeBotMd(app, name, {
    description: `probe ${name}`,
    displayName: seed.displayName,
    pipeline: PROBE,
    botInput
  })
  return name
}

interface Msg {
  id: string
  role?: string
  content?: unknown
  metadata?: {
    sender?: { name: string; displayName: string }
    reply?: Record<string, unknown>
    botFailure?: unknown
    suppressed?: Array<{ name: string }>
  } | null
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

const replies = async (sid: string): Promise<Msg[]> =>
  (await listMessages(sid)).filter((m) => m.role === 'assistant')

const prompt = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )

const promptDetached = (sid: string, text: string): Promise<string> =>
  app.main.eval(
    `(window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }).catch(() => undefined), 'sent')`
  )

const untilReplies = (sid: string, n: number, timeoutMs = 25_000): Promise<Msg[]> =>
  until(
    async () => {
      const msgs = await replies(sid)
      return msgs.length >= n ? msgs : undefined
    },
    `${n} assistant message(s) on ${sid}`,
    timeoutMs
  )

interface ActivityEvent extends RecordedEvent {
  botName: string
  phase: string
}

/** 锚一个相位：顺着事件游标吃 bot_activity，直到该 bot 到达该相位 */
async function waitPhase(
  sid: string,
  botName: string,
  phase: string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const evt = await events.waitFor<ActivityEvent>('bot_activity', {
      sessionId: sid,
      timeoutMs: Math.max(500, deadline - Date.now())
    })
    if (evt.botName === botName && evt.phase === phase) return
  }
}

/** 某个 bot 的决策记录 kind 序列 */
function kindsOf(botName: string): string[] {
  const file = join(app.home, '.shuvix', 'bots', '.runs', botName, 'decisions.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => String((JSON.parse(l) as Record<string, unknown>).kind))
}

/** 建会话并在 UI 里打开（失败卡/提示/回执/面板都只对活动会话渲染） */
async function openBotSession(bots: string[], title: string): Promise<string> {
  const sid = await createBotSession(app.main, { bots, title })
  await until(async () => (await sidebar.titles()).includes(title), `session ${title} listed`)
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
  return sid
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
  flow = botFlowPane(app.main)

  const wfDir = join(app.home, '.shuvix', 'workflows')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, `${PROBE}.md`), PROBE_MD)
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
})

describe('失败卡（C-1 / C-2）', () => {
  it('A2-C1 管线缺失的失败卡：metadata.botFailure === true + 失败角标 + 错误色盒', async () => {
    writeBotMd(app, 'ul-missing', {
      description: 'points at a pipeline that does not exist',
      displayName: 'Missing',
      pipeline: 'a2-no-such-flow'
    })
    const sid = await openBotSession(['ul-missing'], 'A2-C1')
    await prompt(sid, '这条没人接得住')

    const msgs = await untilReplies(sid, 1)
    // IPC 主断言：失败标记随消息持久化
    expect(msgs[0].metadata?.botFailure).toBe(true)
    expect(String(msgs[0].content)).toContain('a2-no-such-flow')

    // DOM 只断视觉物，且与 IPC 断的是**同一条消息**（按 id 对齐）
    await until(async () => (await flow.messageFlags(msgs[0].id)).failureBadge, 'failure badge')
    const flags = await flow.messageFlags(msgs[0].id)
    expect(flags.failureBadge).toBe(true)
    expect(flags.contentClassName).toContain('border-error')
    expect(flags.replyCard).toBe(false)
  })

  it('A2-C2 say({error:true}) 同款失败卡；结构化 + error 时失败角标与回复卡并存', async () => {
    probe('ul-err', { displayName: 'Degraded', mode: 'say-error', sayLine: '出错降级的一句' })
    const sidPlain = await openBotSession(['ul-err'], 'A2-C2a')
    await prompt(sidPlain, '降级出声')
    const plain = await untilReplies(sidPlain, 1)
    expect(plain[0].metadata?.botFailure).toBe(true)
    await until(async () => (await flow.messageFlags(plain[0].id)).failureBadge, 'failure badge')
    const plainFlags = await flow.messageFlags(plain[0].id)
    expect(plainFlags.failureBadge).toBe(true)
    expect(plainFlags.contentClassName).toContain('border-error')

    // 变体：结构化 + error —— 失败角标与 BotReply 卡并存（结构照常渲染，角标说明它是通告）
    probe('ul-err-reply', { displayName: 'DegradedReply', mode: 'reply-error' })
    const sidReply = await openBotSession(['ul-err-reply'], 'A2-C2b')
    await prompt(sidReply, '带结构的降级')
    const withReply = await untilReplies(sidReply, 1)
    expect(withReply[0].metadata?.botFailure).toBe(true)
    expect(withReply[0].metadata?.reply).toMatchObject({ headline: '出错但有结构' })
    await until(
      async () => (await flow.messageFlags(withReply[0].id)).failureBadge,
      'failure badge on reply card'
    )
    const replyFlags = await flow.messageFlags(withReply[0].id)
    expect(replyFlags.failureBadge).toBe(true)
    expect(replyFlags.replyCard).toBe(true)
  })
})

describe('「正在判断」合并行（C-4）', () => {
  it('A2-C4 双成员意图段：一行 data-bot-deciding="2"、无成员卡；claim 后行消失', async () => {
    probe('ul-dec-a', { displayName: 'DecA', relevance: 8, preClaimMs: 1800, sayLine: 'A 的回答' })
    probe('ul-dec-b', { displayName: 'DecB', relevance: 3, preClaimMs: 1800 })
    const sid = await openBotSession(['ul-dec-a', 'ul-dec-b'], 'A2-C4')
    await events.clear()
    await promptDetached(sid, '你们谁来')

    // 意图窗内：两个成员合并成一行「正在判断」，不铺成员卡（started 不落卡）
    await until(async () => {
      const [count, cards] = await Promise.all([flow.decidingCount(), flow.activityCards()])
      return count === 2 && cards.length === 0
    }, 'deciding row with 2 members, zero member cards')

    // claim 之后：行消失（成员各自进入 claimed/silent，不再是「判断中」）
    await waitPhase(sid, 'ul-dec-a', 'claimed')
    await until(async () => (await flow.decidingCount()) === null, 'deciding row gone after claim')
    await untilReplies(sid, 1)
  })
})

describe('全体沉默提示的出口（C-8 / C-9 / C-10）', () => {
  it('A2-C8 双 ignore → 输入卡内 all_ignored 提示；点 ✕ 消失', async () => {
    probe('ul-ig1', { displayName: 'Ig1', decision: 'ignore', relevance: 1, preClaimMs: 1200 })
    probe('ul-ig2', { displayName: 'Ig2', decision: 'ignore', relevance: 1, preClaimMs: 1200 })
    const sid = await openBotSession(['ul-ig1', 'ul-ig2'], 'A2-C8')
    await events.clear()
    await prompt(sid, '这条跟你们都没关系')

    await events.waitFor('bot_cohort_silent', { sessionId: sid })
    await until(async () => (await flow.silence())?.reason === 'all_ignored', 'silence notice')
    expect(await flow.dismissSilence()).toBe(true)
    await until(async () => (await flow.silence()) === null, 'notice dismissed')
  })

  it('A2-C9 提示在屏时再发一条：下一轮 started 即清（preClaimMs 拉宽断言窗）', async () => {
    const sid = await openBotSession(['ul-ig1', 'ul-ig2'], 'A2-C9')
    await events.clear()
    await prompt(sid, '第一轮沉默')
    await events.waitFor('bot_cohort_silent', { sessionId: sid })
    await until(async () => (await flow.silence()) !== null, 'notice on screen')

    // 第二条消息 → started 即清提示；preClaimMs 1200 保证「已清、下一次定局未到」的窗口
    await promptDetached(sid, '第二轮来了')
    await waitPhase(sid, 'ul-ig1', 'started')
    await until(async () => (await flow.silence()) === null, 'notice cleared by next started')
  })

  it('A2-C10 message.clear：提示 / 占位卡 / 回执全部消失（messages_reloaded 清）', async () => {
    // 先铺出「卡 + 回执」：worker bot 两条消息，一条 working 一条排队
    // （turnMs 不在本文件 ProbeSeed 里 —— abort.e2e.ts 才大量用它，这里直接写 botInput）
    writeBotMd(app, 'ul-work', {
      description: 'probe ul-work',
      displayName: 'Worker',
      pipeline: PROBE,
      botInput: { sayLine: 'W 的回答', turnMs: 8000 }
    })
    const sidWork = await openBotSession(['ul-work'], 'A2-C10a')
    await events.clear()
    await promptDetached(sidWork, '第一条')
    await waitPhase(sidWork, 'ul-work', 'working')
    await promptDetached(sidWork, '第二条')
    await waitPhase(sidWork, 'ul-work', 'queued')
    await until(async () => (await flow.activityCards()).length > 0, 'activity card on screen')
    await until(async () => (await flow.receipts()).length > 0, 'receipt on screen')

    await app.main.eval(`window.api.message.clear(${JSON.stringify(sidWork)})`)
    await until(async () => (await flow.activityCards()).length === 0, 'cards cleared')
    await until(async () => (await flow.receipts()).length === 0, 'receipts cleared')

    // 再铺「沉默提示」：ignore 会话取得提示后 clear —— 同一把 messages_reloaded 扫掉。
    //
    // ⚠️ 已知实现缺陷（上报，勿弱化断言）：A2 只落了 messages_reloaded 的**消费侧**
    // （useAgentEvents → clearBotLiveState），聊天会话没有任何**生产者** ——
    // DefaultChatGateway.clearMessages / rollbackMessage 不广播它，而唯二的 emit 点
    // （harnessSession 自动压缩 / eventHandler session_compact）都是聊天会话永远走不到的
    // harness 路径。于是清空会话后：卡与回执靠 abortSession 的副作用消失（上半段绿），
    // 沉默提示却在一条已被清空的会话上永久残留（BotSilenceNotice 文档声称的第三个出口
    // 是死的）。此断言按设计期望钉住，修复生产侧后即绿。
    const sidIg = await openBotSession(['ul-ig1', 'ul-ig2'], 'A2-C10b')
    await events.clear()
    await prompt(sidIg, '沉默一轮')
    await events.waitFor('bot_cohort_silent', { sessionId: sidIg })
    await until(async () => (await flow.silence()) !== null, 'notice before clear')
    await app.main.eval(`window.api.message.clear(${JSON.stringify(sidIg)})`)
    await until(async () => (await flow.silence()) === null, 'notice cleared by messages_reloaded')
  })
})

describe('救济 chip（C-11 / C-12）', () => {
  it('A2-C11 胜者卡底的败者 chip：点击 = 带 @displayName 前缀定向重发，原消息集合不动', async () => {
    probe('ul-win', { displayName: 'Winner', relevance: 8, sayLine: 'W 的回答' })
    probe('ul-lose', {
      displayName: 'Loser',
      relevance: 2,
      reason: '我也能答',
      sayLine: 'L 的回答'
    })
    const sid = await openBotSession(['ul-win', 'ul-lose'], 'A2-C11')
    await prompt(sid, '救济这一条')

    const [winnerMsg] = await untilReplies(sid, 1)
    expect(winnerMsg.metadata?.sender?.name).toBe('ul-win')
    expect(winnerMsg.metadata?.suppressed?.map((s) => s.name)).toEqual(['ul-lose'])

    // chip 的锚是稳定名，可见文本是 displayName
    await until(async () => (await flow.rescueChips(winnerMsg.id)).length === 1, 'rescue chip')
    const [chip] = await flow.rescueChips(winnerMsg.id)
    expect(chip.name).toBe('ul-lose')
    expect(chip.label).toContain('Loser')

    const before = (await listMessages(sid)).map((m) => m.id)
    expect(await flow.clickRescueChip(winnerMsg.id, 'ul-lose')).toBe(true)

    // 定向重发：新 user 消息 = `@<displayName> <原文>`；败者按 l0_directed 应答
    const after = await until(async () => {
      const msgs = await listMessages(sid)
      return msgs.filter((m) => m.role === 'assistant').length >= 2 ? msgs : undefined
    }, 'loser answered the rescue resend')
    // 原消息集合不动：新 id 只增不改（旧序是新序的前缀）
    expect(after.map((m) => m.id).slice(0, before.length)).toEqual(before)
    const resent = after.filter((m) => m.role === 'user').at(-1)!
    expect(resent.content).toBe('@Loser 救济这一条')
    const rescue = after.filter((m) => m.role === 'assistant').at(-1)!
    expect(rescue.metadata?.sender?.name).toBe('ul-lose')
    expect(rescue.content).toBe('L 的回答')
    expect(kindsOf('ul-lose')).toContain('l0_directed')
  })

  it('A2-C12 胜者 mute → 沉默提示带 suppressed，chip 在提示块内；点击按 userMessageId 重发', async () => {
    probe('ul-mute', { displayName: 'Muter', relevance: 8, mode: 'mute' })
    probe('ul-lose2', {
      displayName: 'Rescue',
      relevance: 2,
      reason: '我也能答',
      sayLine: 'R 的回答'
    })
    const sid = await openBotSession(['ul-mute', 'ul-lose2'], 'A2-C12')
    await events.clear()
    await prompt(sid, '这轮胜者会哑')

    const evt = await events.waitFor<RecordedEvent & { suppressed?: Array<{ name: string }> }>(
      'bot_cohort_silent',
      { sessionId: sid }
    )
    expect(evt.suppressed?.map((s) => s.name)).toEqual(['ul-lose2'])
    expect(await replies(sid)).toHaveLength(0)

    // chip 挂在提示块内（胜者半路失败时名单无消息可挂）
    await until(async () => (await flow.silenceRescueChips()).length === 1, 'chip inside notice')
    const before = (await listMessages(sid)).map((m) => m.id)
    expect(await flow.clickSilenceRescueChip('ul-lose2')).toBe(true)

    const after = await until(async () => {
      const msgs = await listMessages(sid)
      return msgs.filter((m) => m.role === 'assistant').length >= 1 ? msgs : undefined
    }, 'rescue answered after mute round')
    expect(after.map((m) => m.id).slice(0, before.length)).toEqual(before)
    const resent = after.filter((m) => m.role === 'user').at(-1)!
    expect(resent.content).toBe('@Rescue 这轮胜者会哑')
    const rescue = after.filter((m) => m.role === 'assistant').at(-1)!
    expect(rescue.metadata?.sender?.name).toBe('ul-lose2')
    expect(kindsOf('ul-lose2')).toContain('l0_directed')
  })
})

describe('BotReply 双形态（C-13 / C-14）', () => {
  it('A2-C13 气泡形态：加粗结论 + 散文，无列点/表格/状态 chip；全键形态逐条在屏', async () => {
    // 气泡形态：仅 headline + body
    probe('ul-bubble', { displayName: 'Bubble', mode: 'reply-bubble' })
    const sidBubble = await openBotSession(['ul-bubble'], 'A2-C13a')
    await prompt(sidBubble, '来一条气泡')
    const [bubble] = await untilReplies(sidBubble, 1)
    expect(bubble.metadata?.reply).toEqual({
      headline: '结论要加粗',
      body: '气泡形态只有散文正文。'
    })
    await until(async () => (await flow.replyShape(bubble.id)).present, 'bubble reply card')
    const bubbleShape = await flow.replyShape(bubble.id)
    expect(bubbleShape.headline).toBe('结论要加粗')
    expect(bubbleShape.headlineBold).toBe(true)
    expect(bubbleShape.bullets).toEqual([])
    expect(bubbleShape.tableRows).toEqual([])
    expect(bubbleShape.status).toBeNull()
    expect(bubbleShape.followups).toEqual([])

    // 全键形态：列点 / 表格 / 状态 chip / 追问逐条在屏
    probe('ul-full', { displayName: 'Full', mode: 'reply-full' })
    const sidFull = await openBotSession(['ul-full'], 'A2-C13b')
    await prompt(sidFull, '来一份全键')
    const [full] = await untilReplies(sidFull, 1)
    expect(full.metadata?.reply).toEqual(FULL_REPLY)
    await until(async () => (await flow.replyShape(full.id)).present, 'full reply card')
    const fullShape = await flow.replyShape(full.id)
    expect(fullShape.headline).toBe(FULL_REPLY.headline)
    expect(fullShape.headlineBold).toBe(true)
    expect(fullShape.bullets).toEqual(FULL_REPLY.points)
    expect(fullShape.tableRows).toEqual([FULL_REPLY.table.columns, FULL_REPLY.table.rows[0]])
    expect(fullShape.status).toBe('warn')
    expect(fullShape.followups).toEqual(FULL_REPLY.followups)
  })

  it('A2-C14 追问 chip 点击只填不发：输入框 value = 文本，message.list 长度不变', async () => {
    // 追问常要改两个字，直接发送还会立刻烧一轮意图段（裁决③）——「直接发出去」在这里是缺陷
    probe('ul-follow', { displayName: 'Follow', mode: 'reply-full' })
    const sid = await openBotSession(['ul-follow'], 'A2-C14')
    await prompt(sid, '来一份带追问的')
    const [msg] = await untilReplies(sid, 1)
    await until(async () => (await flow.replyShape(msg.id)).followups.length === 1, 'followup chip')

    const countBefore = (await listMessages(sid)).length
    expect(await flow.clickFollowup(msg.id, 0)).toBe(true)
    await until(async () => (await chat.inputValue()) === FULL_REPLY.followups[0], 'input filled')

    // 静置复查：只填入，不发送
    await sleep(1000)
    expect((await listMessages(sid)).length).toBe(countBefore)
    expect(await chat.inputValue()).toBe(FULL_REPLY.followups[0])
  })
})

describe('子代理面板的 bot-intent 折叠纪律（C-15）', () => {
  /** 一次门控裁决脚本（真 bot-chat 意图段 —— 唯一需要假提供商的用例） */
  const gate = (reply: string): Parameters<FakeProvider['script']>[0] => ({
    toolCalls: [
      {
        id: 'call_next',
        name: 'next',
        args: JSON.stringify({ decision: 'reply', relevance: 5, reason: 'e2e', reply })
      }
    ],
    usage: { prompt: 150, completion: 10 },
    when: (r: FakeRequest) => !r.isTitle
  })

  it('A2-C15 bot-intent run 注册后不自动展开；手动展开的在新一批到达时保持，新的折叠', async () => {
    provider.reset()
    provider.script(gate('第一轮回复'))
    writeBotMd(app, 'ul-gate', { description: 'real gate for panel', displayName: 'GateBot' })
    const sid = await openBotSession(['ul-gate'], 'A2-C15')
    await events.clear()
    await prompt(sid, '第一轮')
    await untilReplies(sid, 1)

    // 意图段 run 已注册（工具栏胶囊出现）→ 打开面板：行在，但**不自动展开**
    await until(() => flow.openSubAgentPanel(), 'sub-agent capsule appears and opens panel')
    await until(async () => (await flow.subAgentRows()).length === 1, 'one bot-intent row')
    const first = await flow.subAgentRows()
    expect(first[0].agent).toBe('bot-intent')
    expect(first[0].expanded).toBe(false)

    // 手动展开它
    await flow.toggleSubAgentRow(0)
    expect((await flow.subAgentRows())[0].expanded).toBe(true)

    // 新一批 bot-intent 到达：手动展开的保持展开，新的折叠 ——
    // 「新出现即独占展开」对高频短命的意图段 run 让位（A2 的折叠纪律）
    provider.script(gate('第二轮回复'))
    await prompt(sid, '第二轮')
    await untilReplies(sid, 2)
    await until(async () => (await flow.subAgentRows()).length === 2, 'second bot-intent row')
    const rows = await flow.subAgentRows()
    expect(rows.map((r) => r.agent)).toEqual(['bot-intent', 'bot-intent'])
    expect(rows[0].expanded).toBe(true)
    expect(rows[1].expanded).toBe(false)
  })
})
