/**
 * A2 · per-bot 停止与在飞展示（C 组前半）—— 占位卡三相位、停止钮、mailbox 回执、
 * 「停止 ≠ 沉默」（设计 §5.4 / §9.1）。
 *
 * 全程零 LLM：`a2-abort-probe` 是一份参数化 bot 管线，相位窗口（preClaimMs /
 * postClaimMs / turnMs）与结局（sayLine / mode）全部读自各 bot md 的 `shuvix-bot-input`。
 * 相位窗口用真实毫秒 —— 占位卡、停止钮、回执都是「窗口期间屏幕上长出来的东西」，
 * 每一步先 waitFor 锚相位事件，再进 DOM；固定 sleep 只用于宽限窗复查与「断不发生」静置。
 *
 * DOM 断言全部经 pages.ts 的 botFlowPane（data-* 锚点）；IPC 能断的（事件序列、
 * message.list、decisions.jsonl）不走 DOM。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sleep, until } from '../../harness/cdp'
import {
  createBotSession,
  eventRecorder,
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
let chat: ChatPane
let sidebar: SidebarPane
let flow: BotFlowPane

/** 参数化探针管线名 —— bot md 用 `shuvix-bot-pipeline` 指向它 */
const PROBE = 'a2-abort-probe'

/**
 * 相位窗口全部由 knob 撑开：preClaimMs（started 窗）→ claim → postClaimMs（claimed 卡窗）
 * → turn(turnMs)（queued/working 窗）→ say。被停时：postClaim 的 sleep 拒绝由脚本吞掉
 * （run 正常收尾、说话被 §9.1 守卫拦下）；turn 里的 sleep 拒绝**任其冒顶**（run 以
 * failed 收尾）—— 两条路都不该冒出失败气泡，正是本文件要钉的那半边。
 */
const PROBE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${PROBE}`,
  'description: A2 e2e probe — phase windows and endings all come from shuvix-bot-input.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  'A2 参数化 bot 管线：相位窗口与结局全部来自 bot md 的 `shuvix-bot-input`，零 LLM。',
  '',
  '```js workflow',
  '// started 窗：claim 之前先睡（「正在判断」行的观察窗）',
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
  '// claimed 卡窗。被停时安静返回 —— run 正常收尾，说话被 §9.1 的 aborted 守卫拦下',
  'if (input.postClaimMs) {',
  '  try {',
  '    await sleep(input.postClaimMs)',
  '  } catch (e) {',
  "    log('post-claim wake: ' + String((e && e.message) || e))",
  "    return { outcome: 'aborted-after-claim' }",
  '  }',
  '}',
  '',
  "if (input.mode === 'mute') return { outcome: 'won-but-mute' }",
  '',
  '// queued/working 窗：turn() 进独占段后睡。被停时 sleep 拒绝任其冒顶 —— run 以',
  '// failed 收尾，兜底气泡该被 !signal.aborted 压掉',
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

interface ProbeSeed {
  displayName: string
  decision?: 'reply' | 'task' | 'clarify' | 'ignore'
  relevance?: number
  reason?: string
  sayLine?: string
  mode?: 'mute'
  preClaimMs?: number
  postClaimMs?: number
  turnMs?: number
}

function probe(name: string, seed: ProbeSeed): string {
  const botInput: Record<string, string | number> = {}
  for (const k of [
    'decision',
    'relevance',
    'reason',
    'sayLine',
    'mode',
    'preClaimMs',
    'postClaimMs',
    'turnMs'
  ] as const) {
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
  metadata?: { sender?: { name: string } } | null
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

const replies = async (sid: string): Promise<Msg[]> =>
  (await listMessages(sid)).filter((m) => m.role === 'assistant')

/** 发出但**不等** —— 停止用例要在 cohort 还在跑的时候插进去 */
const promptDetached = (sid: string, text: string): Promise<string> =>
  app.main.eval(
    `(window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }).catch(() => undefined), 'sent')`
  )

const prompt = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )

/** per-bot 停止 IPC（A2 的新契约成员） */
const abortBot = (sid: string, botName: string, messageId: string): Promise<{ aborted: boolean }> =>
  app.main.eval(
    `window.api.agent.abortBot({ sessionId: ${JSON.stringify(sid)}, botName: ${JSON.stringify(botName)}, messageId: ${JSON.stringify(messageId)} })`
  )

/** 等到该会话第 n 条（1 起）user 消息落树并返回其 id —— 停止钮的 messageId 参数 */
const userMessageId = (sid: string, nth: number): Promise<string> =>
  until(async () => {
    const users = (await listMessages(sid)).filter((m) => m.role === 'user')
    return users.length >= nth ? users[nth - 1].id : undefined
  }, `user message #${nth} on ${sid}`)

/** 等到该会话上出现 n 条 assistant 消息 */
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

/** 锚一个相位：顺着事件游标吃 bot_activity，直到该 bot 到达该相位（禁止裸 sleep 抓相位） */
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

interface MailboxEvent extends RecordedEvent {
  botName: string
  active: { messageId: string } | null
  queued: Array<{ messageId: string }>
}

/** 该会话上录到的全体沉默事件（断「一次都没有」也用它） */
async function silences(sid: string): Promise<RecordedEvent[]> {
  const all = await events.all<RecordedEvent>()
  return all.filter((e) => e.type === 'bot_cohort_silent' && e.sessionId === sid)
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

/** 建会话 + 在 UI 里打开（占位卡/回执/提示只对活动会话渲染） */
async function openBotSession(bots: string[], title: string): Promise<string> {
  const sid = await createBotSession(app.main, { bots, title })
  await until(async () => (await sidebar.titles()).includes(title), `session ${title} listed`)
  expect(await sidebar.openSession(title)).toBe(true)
  await chat.ready()
  return sid
}

beforeAll(async () => {
  app = await launchApp()
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
})

describe('活动占位卡三相位（C-3 / C-4 的停止钮半边）', () => {
  it('A2-C3 claimed 有停止钮、working 有、queued 无；回复落树后卡消失', async () => {
    probe('ab-flow', {
      displayName: 'Flow',
      postClaimMs: 1500,
      turnMs: 4500,
      sayLine: 'Flow 的回答'
    })
    const sid = await openBotSession(['ab-flow'], 'A2-flow')
    await events.clear()
    await promptDetached(sid, '第一条')

    // claimed：占位卡带停止钮（postClaimMs 撑开的窗）
    await waitPhase(sid, 'ab-flow', 'claimed')
    await until(async () => {
      const cards = await flow.activityCards()
      return cards.some((c) => c.name === 'ab-flow' && c.phase === 'claimed' && c.hasStop)
    }, 'claimed card with stop button')

    // working：turn 授予之后仍带停止钮
    await waitPhase(sid, 'ab-flow', 'working')
    await until(async () => {
      const cards = await flow.activityCards()
      return cards.some((c) => c.name === 'ab-flow' && c.phase === 'working' && c.hasStop)
    }, 'working card with stop button')

    // 第二条消息进来：同 bot 在 mailbox 排队 —— queued 卡是纯信息，**没有**停止钮
    await promptDetached(sid, '第二条')
    await waitPhase(sid, 'ab-flow', 'queued')
    await until(async () => {
      const cards = await flow.activityCards()
      return cards.some((c) => c.name === 'ab-flow' && c.phase === 'queued' && !c.hasStop)
    }, 'queued card without stop button')

    // 两条回复都落树后：占位卡全部收摊（原位替换成回复）
    await untilReplies(sid, 2)
    await until(async () => (await flow.activityCards()).length === 0, 'activity cards gone')
  })
})

describe('working 中点停止（C-5）', () => {
  it('A2-C5 停止钮点下去：卡消失、零失败气泡、无新增 assistant；再发一条照常应答', async () => {
    probe('ab-stop', { displayName: 'Stopper', turnMs: 6000, sayLine: 'Stopper 的回答' })
    const sid = await openBotSession(['ab-stop'], 'A2-stop')
    await events.clear()
    await promptDetached(sid, '这条会被停掉')

    await waitPhase(sid, 'ab-stop', 'working')
    await until(async () => {
      const cards = await flow.activityCards()
      return cards.some((c) => c.name === 'ab-stop' && c.phase === 'working' && c.hasStop)
    }, 'working card before stop')
    expect(await flow.clickStop('ab-stop')).toBe(true)

    // 卡消失（run 收尾广播 ended）
    await until(async () => (await flow.activityCards()).length === 0, 'card gone after stop')
    // 静置复查：§9.1 —— 用户按的停止不是「无从解释的沉默」，不许补失败气泡
    await sleep(1500)
    expect(await replies(sid)).toHaveLength(0)
    expect(await chat.errorRows()).toBe(0)

    // 停止只停「卡上那件事」：同一个 bot 对下一条消息照常应答
    await prompt(sid, '再来一条')
    const msgs = await untilReplies(sid, 1)
    expect(msgs[0].content).toBe('Stopper 的回答')
    expect(msgs[0].metadata?.sender?.name).toBe('ab-stop')
  })
})

describe('停止不清 mailbox（C-6）', () => {
  it('A2-C6a 停掉 working 的 msg1 → {aborted:true}，排队的 msg2 顺位授予并落回复', async () => {
    probe('ab-lane', { displayName: 'Lane', turnMs: 3000, sayLine: 'Lane 的回答' })
    const sid = await createBotSession(app.main, { bots: ['ab-lane'], title: 'A2-lane-a' })
    await events.clear()
    await promptDetached(sid, '第一条')
    await waitPhase(sid, 'ab-lane', 'working')
    await promptDetached(sid, '第二条')
    await waitPhase(sid, 'ab-lane', 'queued')

    const m1 = await userMessageId(sid, 1)
    expect(await abortBot(sid, 'ab-lane', m1)).toEqual({ aborted: true })

    // msg1 的 run 被停、独占段随它的 finally 释放 → msg2 顺位授予，回复照常落树
    const msgs = await untilReplies(sid, 1)
    expect(msgs[0].content).toBe('Lane 的回答')
    // 静置复查：msg1 不再冒出第二条（无论失败气泡还是迟到的回复）
    await sleep(1500)
    expect(await replies(sid)).toHaveLength(1)
  })

  it('A2-C6b 停掉排队的 msg2 → msg1 照常、msg2 无声，decisions 含 mailbox_aborted', async () => {
    // 同 bot 换会话：lane 键含 sessionId，上一条用例的 lane 不串味
    const sid = await createBotSession(app.main, { bots: ['ab-lane'], title: 'A2-lane-b' })
    await events.clear()
    await promptDetached(sid, '第一条')
    await waitPhase(sid, 'ab-lane', 'working')
    await promptDetached(sid, '第二条')
    await waitPhase(sid, 'ab-lane', 'queued')

    const m2 = await userMessageId(sid, 2)
    expect(await abortBot(sid, 'ab-lane', m2)).toEqual({ aborted: true })

    // msg1 不受影响，照常落回复
    const msgs = await untilReplies(sid, 1)
    expect(msgs[0].content).toBe('Lane 的回答')
    // msg2 无声（引擎 run 级 abort 唤不醒排队脚本 —— mailbox.abortTicket 把它摘下来拒绝）
    await sleep(1500)
    expect(await replies(sid)).toHaveLength(1)
    expect(kindsOf('ab-lane')).toContain('mailbox_aborted')
  })
})

describe('mailbox 回执（C-7）', () => {
  it('A2-C7 排队消息的用户气泡下有回执，active 的没有；全部完成后回执消失', async () => {
    probe('ab-receipt', { displayName: 'Receipt', turnMs: 3500, sayLine: 'Receipt 的回答' })
    const sid = await openBotSession(['ab-receipt'], 'A2-receipt')
    await events.clear()
    await promptDetached(sid, '第一条')
    await waitPhase(sid, 'ab-receipt', 'working')
    await promptDetached(sid, '第二条')
    await waitPhase(sid, 'ab-receipt', 'queued')

    const m1 = await userMessageId(sid, 1)
    const m2 = await userMessageId(sid, 2)

    // 先断快照（IPC 面）：active=msg1、queued 含 msg2
    const snap = await until(async () => {
      const all = await events.all<MailboxEvent>()
      return all.find(
        (e) =>
          e.type === 'bot_mailbox' &&
          e.sessionId === sid &&
          e.botName === 'ab-receipt' &&
          e.active?.messageId === m1 &&
          (e.queued ?? []).some((q) => q.messageId === m2)
      )
    }, 'mailbox snapshot active=m1 queued=[m2]')
    expect(snap.active?.messageId).toBe(m1)

    // 再断 DOM：回执只挂在还排着队的 msg2 下（active 由占位卡呈现，不出回执）
    await until(async () => {
      const receipts = await flow.receipts()
      return receipts.length === 1 && receipts[0].msgId === m2
    }, 'receipt under msg2 only')
    const receipts = await flow.receipts()
    expect(receipts[0].names).toContain('ab-receipt')
    expect(receipts.some((r) => r.msgId === m1)).toBe(false)

    // 全部完成后回执消失（空快照删键）
    await untilReplies(sid, 2)
    await until(async () => (await flow.receipts()).length === 0, 'receipts gone when drained')
  })
})

describe('对已收尾票的停止（C-16）', () => {
  it('A2-C16 对已收尾的 (bot, 消息) abortBot → {aborted:false}，不抛、无副作用', async () => {
    probe('ab-done', { displayName: 'Done', sayLine: 'Done 的回答' })
    const sid = await createBotSession(app.main, { bots: ['ab-done'], title: 'A2-done' })
    await events.clear()
    await prompt(sid, '快问快答')
    await untilReplies(sid, 1)

    const m1 = await userMessageId(sid, 1)
    const activityBefore = (await events.all()).filter(
      (e) => e.type === 'bot_activity' && e.sessionId === sid
    ).length

    expect(await abortBot(sid, 'ab-done', m1)).toEqual({ aborted: false })

    // 静置复查：没有第二条消息、没有新的活动事件 —— 未命中就是纯 no-op
    await sleep(1000)
    expect(await replies(sid)).toHaveLength(1)
    const activityAfter = (await events.all()).filter(
      (e) => e.type === 'bot_activity' && e.sessionId === sid
    ).length
    expect(activityAfter).toBe(activityBefore)
  })
})

describe('多 bot 停胜者 ≠ 全体沉默（C-17，裁决 2 / §9.1）', () => {
  it('A2-C17 停掉胜者：无 bot_cohort_silent 事件、无提示；decisions 照记 run_end', async () => {
    // §9.1「用户按停止不是无从解释的沉默」：barrier 级守卫只覆盖会话中止，per-bot 停止
    // 靠 MemberOutcome.aborted 位对整轮闭嘴。没有这半边，点一次停止就弹一条
    // 「全体沉默：有东西坏了」—— 本用例钉的正是裁决 2 修掉的那个缺陷
    probe('ab-win', { displayName: 'Winner', relevance: 8, postClaimMs: 4000, sayLine: 'W 的回答' })
    probe('ab-lose', { displayName: 'Loser', relevance: 2, reason: '我也能答' })
    const sid = await openBotSession(['ab-win', 'ab-lose'], 'A2-stop-winner')
    await events.clear()
    await promptDetached(sid, '你们谁来')

    // 胜者定局（claimed 事件）之后、说话之前（postClaimMs 窗内）按停止
    await waitPhase(sid, 'ab-win', 'claimed')
    const m1 = await userMessageId(sid, 1)
    expect(await abortBot(sid, 'ab-win', m1)).toEqual({ aborted: true })

    // 静置窗断「不发生」：盖过 postClaim 剩余与 cohort 收尾，一条沉默提示都不许有
    await sleep(5000)
    expect(await silences(sid)).toHaveLength(0)
    expect(await flow.silence()).toBeNull()
    expect(await replies(sid)).toHaveLength(0)
    // 沉默事件不发 ≠ 账也不记：两个成员的 run_end 决策照常落盘
    expect(kindsOf('ab-win')).toContain('run_end')
    expect(kindsOf('ab-lose')).toContain('run_end')
  })
})
