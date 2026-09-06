/**
 * A2 · 按消息停止与在飞展示（C 组前半）—— 「正在输入」三相位、停止钮、mailbox 回执、
 * 「停止 ≠ 沉默」（设计 §5.4 / §9.1）。
 *
 * 会话是一对一的：一个会话恰绑一个 bot（`settings.bot`），每条消息都归它。于是
 * 「正在输入」**至多一行**（store 里一个会话一条活动快照：live 相位覆写、ended 删键 ——
 * 两条消息同时在飞时那一行显示的是最近一次相位事件的那条），停止钮停的是**某条消息**的
 * 应答（`agent.abortBot({ sessionId, messageId })`，不再带 botName），mailbox 回执不再署名
 * （布尔属性），`bot_mailbox` 快照也不再带 botName。v2 的「停一个不影响另一个」（C-17）
 * 没有前提了，换成 B4：同一个 bot 连发两条时那一行的相位流转、排队回执与顺位后的停止。
 *
 * 全程零 LLM：`a2-abort-probe` 是一份参数化 bot 管线，相位窗口（preTurnMs / turnMs）
 * 与结局（sayLine / mode）全部读自各 bot md 的 `shuvix-bot-pipeline.input`。相位窗口用真实毫秒
 * —— 「正在输入」行、停止钮、回执都是「窗口期间屏幕上长出来的东西」，每一步先 waitFor
 * 锚相位事件，再进 DOM；固定 sleep 只用于「断不发生」的静置复查。
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
  type BotTypingRowShot,
  type ChatPane,
  type SidebarPane
} from '../../harness/pages'

let app: E2EApp
let events: EventRecorder
let chat: ChatPane
let sidebar: SidebarPane
let flow: BotFlowPane

/** 参数化探针管线名 —— bot md 用 `shuvix-bot-pipeline.workflow` 指向它 */
const PROBE = 'a2-abort-probe'

/**
 * 相位窗口全部由 knob 撑开：preTurnMs（started 窗）→ turn(turnMs)（queued/working 窗）
 * → say。被停时：preTurn 的 sleep 拒绝由脚本吞掉（run 正常收尾、说话被 §9.1 的
 * aborted 守卫拦下）；turn 里的 sleep 拒绝**任其冒顶**（run 以 failed 收尾）——
 * 两条路都不该冒出失败气泡，正是本文件要钉的那半边。
 *
 * v2 的脚本 API 只有 `say` / `turn`：`claim` 已经彻底不存在，写在这里会是 ReferenceError。
 */
const PROBE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${PROBE}`,
  'description: A2 e2e probe — phase windows and endings all come from shuvix-bot-pipeline.input.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  'A2 参数化 bot 管线：相位窗口与结局全部来自 bot md 的 `shuvix-bot-pipeline.input`，零 LLM。',
  '',
  '```js workflow',
  '// started 窗：turn() 之前先睡（「正在输入 · 判断中」那一行的观察窗）',
  'if (input.preTurnMs) {',
  '  try {',
  '    await sleep(input.preTurnMs)',
  '  } catch (e) {',
  "    log('pre-turn wake: ' + String((e && e.message) || e))",
  "    return { outcome: 'aborted-before-turn' }",
  '  }',
  '}',
  '',
  "if (input.mode === 'mute') return { outcome: 'mute' }",
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
  reason?: string
  sayLine?: string
  mode?: 'mute'
  preTurnMs?: number
  turnMs?: number
}

function probe(name: string, seed: ProbeSeed): string {
  const botInput: Record<string, string | number> = {}
  for (const k of ['reason', 'sayLine', 'mode', 'preTurnMs', 'turnMs'] as const) {
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

/** 发出但**不等** —— 停止用例要在管线还在跑的时候插进去 */
const promptDetached = (sid: string, text: string): Promise<string> =>
  app.main.eval(
    `(window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }).catch(() => undefined), 'sent')`
  )

const prompt = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )

/** 按消息停止 IPC：一对一之后只认 (会话, 消息)，不再点名 bot */
const abortBot = (sid: string, messageId: string): Promise<{ aborted: boolean }> =>
  app.main.eval(
    `window.api.agent.abortBot({ sessionId: ${JSON.stringify(sid)}, messageId: ${JSON.stringify(messageId)} })`
  )

/** 等到该会话第 n 条（1 起）user 消息落库并返回其 id —— 停止钮的 messageId 参数 */
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

/** mailbox 快照事件（一对一：没有 botName —— 一个会话一条 lane） */
interface MailboxEvent extends RecordedEvent {
  active: { messageId: string } | null
  queued: Array<{ messageId: string }>
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

/** 建会话（绑定一个 bot）+ 在 UI 里打开（「正在输入」行/回执只对活动会话渲染） */
async function openBotSession(bot: string, title: string): Promise<string> {
  const sid = await createBotSession(app.main, { bot, title })
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

describe('「正在输入」三相位（C-3 / C-4 的停止钮半边）', () => {
  it('A2-C3 started 有停止钮、working 有、queued 无 —— 自始至终恰一行；回复落库后整行消失', async () => {
    probe('ab-flow', {
      displayName: 'Flow',
      preTurnMs: 1500,
      turnMs: 4500,
      sayLine: 'Flow 的回答'
    })
    const sid = await openBotSession('ab-flow', 'A2-flow')
    await events.clear()
    await promptDetached(sid, '第一条')

    // started：判断中那一行就带停止钮（preTurnMs 撑开的窗）。
    // v1 这里断的是 claimed —— 取消仲裁之后 turn() 之前只有 started 一个相位
    await waitPhase(sid, 'ab-flow', 'started')
    await until(async () => {
      const rows = await flow.typingRows()
      return rows.length === 1 && rows[0].phase === 'started' && rows[0].hasStop
    }, 'started row with stop button')

    // working：turn 授予之后仍带停止钮
    await waitPhase(sid, 'ab-flow', 'working')
    await until(async () => {
      const rows = await flow.typingRows()
      return rows.length === 1 && rows[0].phase === 'working' && rows[0].hasStop
    }, 'working row with stop button')

    // 第二条消息进来：同一个 bot 在 mailbox 排队 —— 那一行换成排队相位，**没有**停止钮
    // （还没开始做，无处可停）；仍只有一行：一对一没有第二行的来源
    await promptDetached(sid, '第二条')
    await waitPhase(sid, 'ab-flow', 'queued')
    await until(async () => {
      const rows = await flow.typingRows()
      return rows.length === 1 && rows[0].phase === 'queued' && !rows[0].hasStop
    }, 'queued row without stop button')

    // 两条回复都落库后：「正在输入」收摊（原位替换成气泡）
    await untilReplies(sid, 2)
    await until(async () => (await flow.typingRows()).length === 0, 'typing row gone')
  })
})

describe('working 中点停止（C-5）', () => {
  it('A2-C5 停止钮点下去：行消失、零失败气泡、无新增 assistant；再发一条照常应答', async () => {
    probe('ab-stop', { displayName: 'Stopper', turnMs: 6000, sayLine: 'Stopper 的回答' })
    const sid = await openBotSession('ab-stop', 'A2-stop')
    await events.clear()
    await promptDetached(sid, '这条会被停掉')

    await waitPhase(sid, 'ab-stop', 'working')
    await until(async () => {
      const rows = await flow.typingRows()
      return rows.some((r) => r.name === 'ab-stop' && r.phase === 'working' && r.hasStop)
    }, 'working row before stop')
    expect(await flow.clickStop('ab-stop')).toBe(true)

    // 行消失（run 收尾广播 ended）
    await until(async () => (await flow.typingRows()).length === 0, 'row gone after stop')
    // 静置复查：§9.1 —— 用户按的停止不是「无从解释的沉默」，不许补失败气泡
    await sleep(1500)
    expect(await replies(sid)).toHaveLength(0)
    expect(await chat.errorRows()).toBe(0)

    // 停止只停「那一行上的那件事」：同一个 bot 对下一条消息照常应答
    await prompt(sid, '再来一条')
    const msgs = await untilReplies(sid, 1)
    expect(msgs[0].content).toBe('Stopper 的回答')
    expect(msgs[0].metadata?.sender?.name).toBe('ab-stop')
  })
})

describe('停止不清 mailbox（C-6）', () => {
  it('A2-C6a 停掉 working 的 msg1 → {aborted:true}，排队的 msg2 顺位授予并落回复', async () => {
    probe('ab-lane', { displayName: 'Lane', turnMs: 3000, sayLine: 'Lane 的回答' })
    const sid = await createBotSession(app.main, { bot: 'ab-lane', title: 'A2-lane-a' })
    await events.clear()
    await promptDetached(sid, '第一条')
    await waitPhase(sid, 'ab-lane', 'working')
    await promptDetached(sid, '第二条')
    await waitPhase(sid, 'ab-lane', 'queued')

    const m1 = await userMessageId(sid, 1)
    expect(await abortBot(sid, m1)).toEqual({ aborted: true })

    // msg1 的 run 被停、独占段随它的 finally 释放 → msg2 顺位授予，回复照常落库
    const msgs = await untilReplies(sid, 1)
    expect(msgs[0].content).toBe('Lane 的回答')
    // 静置复查：msg1 不再冒出第二条（无论失败气泡还是迟到的回复）
    await sleep(1500)
    expect(await replies(sid)).toHaveLength(1)
  })

  it('A2-C6b 停掉排队的 msg2 → msg1 照常、msg2 无声，decisions 含 mailbox_aborted', async () => {
    // 同 bot 换会话：lane 键就是 sessionId，上一条用例的 lane 不串味
    const sid = await createBotSession(app.main, { bot: 'ab-lane', title: 'A2-lane-b' })
    await events.clear()
    await promptDetached(sid, '第一条')
    await waitPhase(sid, 'ab-lane', 'working')
    await promptDetached(sid, '第二条')
    await waitPhase(sid, 'ab-lane', 'queued')

    const m2 = await userMessageId(sid, 2)
    expect(await abortBot(sid, m2)).toEqual({ aborted: true })

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
  it('A2-C7 排队消息的用户气泡下有回执，active 的没有；快照不署名；全部完成后回执消失', async () => {
    probe('ab-receipt', { displayName: 'Receipt', turnMs: 3500, sayLine: 'Receipt 的回答' })
    const sid = await openBotSession('ab-receipt', 'A2-receipt')
    await events.clear()
    await promptDetached(sid, '第一条')
    await waitPhase(sid, 'ab-receipt', 'working')
    await promptDetached(sid, '第二条')
    await waitPhase(sid, 'ab-receipt', 'queued')

    const m1 = await userMessageId(sid, 1)
    const m2 = await userMessageId(sid, 2)

    // 先断快照（IPC 面）：active=msg1、queued 含 msg2；一对一的快照不带 botName ——
    // lane 键就是 sessionId，会话里没有第二个人可署
    const snap = await until(async () => {
      const all = await events.all<MailboxEvent>()
      return all.find(
        (e) =>
          e.type === 'bot_mailbox' &&
          e.sessionId === sid &&
          e.active?.messageId === m1 &&
          (e.queued ?? []).some((q) => q.messageId === m2)
      )
    }, 'mailbox snapshot active=m1 queued=[m2]')
    expect(snap.active?.messageId).toBe(m1)
    expect(snap).not.toHaveProperty('botName')

    // 再断 DOM：回执只挂在还排着队的 msg2 下（active 由「正在输入」那行呈现，不出回执）
    await until(async () => {
      const receipts = await flow.receipts()
      return receipts.length === 1 && receipts[0] === m2
    }, 'receipt under msg2 only')
    expect(await flow.receipts()).toEqual([m2])

    // 全部完成后回执消失（空快照删键）
    await untilReplies(sid, 2)
    await until(async () => (await flow.receipts()).length === 0, 'receipts gone when drained')
  })
})

describe('对已收尾票的停止（C-16）', () => {
  it('A2-C16 对已收尾的消息 abortBot → {aborted:false}，不抛、无副作用', async () => {
    probe('ab-done', { displayName: 'Done', sayLine: 'Done 的回答' })
    const sid = await createBotSession(app.main, { bot: 'ab-done', title: 'A2-done' })
    await events.clear()
    await prompt(sid, '快问快答')
    await untilReplies(sid, 1)

    const m1 = await userMessageId(sid, 1)
    const activityBefore = (await events.all()).filter(
      (e) => e.type === 'bot_activity' && e.sessionId === sid
    ).length

    expect(await abortBot(sid, m1)).toEqual({ aborted: false })

    // 静置复查：没有第二条消息、没有新的活动事件 —— 未命中就是纯 no-op
    await sleep(1000)
    expect(await replies(sid)).toHaveLength(1)
    const activityAfter = (await events.all()).filter(
      (e) => e.type === 'bot_activity' && e.sessionId === sid
    ).length
    expect(activityAfter).toBe(activityBefore)
  })
})

describe('同一个 bot 连发两条（B4）', () => {
  /**
   * v1/v2 在这里问的是「多 bot 里停掉一个会不会连累另一个」——一对一之后没有另一个。
   * 留下来的是同一处守卫在一对一里的样子：一条 lane、一行「正在输入」、一个停止钮，
   * 两条消息同时在飞时行上显示的是最近一次相位事件的那条；停掉顺位后的第二条，
   * 它安静收场（`!ticket.abort.signal.aborted` 压掉失败气泡）、回执随排空消失、
   * 决策记录照常落 run_end。
   */
  it('B4 恰一行：msg1 working 带停止钮 → msg2 排队（无停止钮 + 回执 + 不署名快照）→ 顺位 working 后点停止：行消失、零错误气泡、回执清空', async () => {
    probe('ab-burst', { displayName: 'Burst', turnMs: 4500, sayLine: 'Burst 的回答' })
    const sid = await openBotSession('ab-burst', 'A2-burst')
    await events.clear()

    // 采样纪律：整条用例里任何一次读行都不许超过一行 —— 一对一没有第二行的来源
    const sampleRows = async (): Promise<BotTypingRowShot[]> => {
      const rows = await flow.typingRows()
      expect(rows.length).toBeLessThanOrEqual(1)
      return rows
    }

    await promptDetached(sid, '第一条')
    await waitPhase(sid, 'ab-burst', 'working')
    await until(async () => {
      const rows = await sampleRows()
      return rows.length === 1 && rows[0].phase === 'working' && rows[0].hasStop
    }, 'working row with stop button (msg1)')
    expect(await sampleRows()).toEqual([{ name: 'ab-burst', phase: 'working', hasStop: true }])

    // 第二条：同一条 lane 上排队 —— 那一行换成 queued，没有停止钮
    await promptDetached(sid, '第二条')
    await waitPhase(sid, 'ab-burst', 'queued')
    await until(async () => {
      const rows = await sampleRows()
      return rows.length === 1 && rows[0].phase === 'queued' && !rows[0].hasStop
    }, 'queued row without stop button (msg2)')

    const m1 = await userMessageId(sid, 1)
    const m2 = await userMessageId(sid, 2)
    // mailbox 快照（IPC 面）：active=msg1、queued=[msg2]，且没有 botName 键
    const snap = await until(async () => {
      const all = await events.all<MailboxEvent>()
      return all.find(
        (e) =>
          e.type === 'bot_mailbox' &&
          e.sessionId === sid &&
          e.active?.messageId === m1 &&
          (e.queued ?? []).some((q) => q.messageId === m2)
      )
    }, 'mailbox snapshot active=m1 queued=[m2]')
    expect(snap).not.toHaveProperty('botName')
    expect(snap.queued.map((q) => q.messageId)).toEqual([m2])
    // 回执只挂在排队的 msg2 下
    await until(
      async () => JSON.stringify(await flow.receipts()) === JSON.stringify([m2]),
      'receipt under msg2 only'
    )

    // msg1 说完 → msg2 顺位授予：那一行再次是 working + 停止钮。中间隔着 msg1 的 ended
    // （键被删、行短暂消失）—— 只 until 等它回来，不断言那段空窗里的持续性
    await untilReplies(sid, 1)
    await until(async () => {
      const rows = await sampleRows()
      return rows.length === 1 && rows[0].phase === 'working' && rows[0].hasStop
    }, 'working row with stop button (msg2)')

    expect(await flow.clickStop('ab-burst')).toBe(true)
    await until(async () => (await sampleRows()).length === 0, 'row gone after stop')
    // 静置复查：§9.1 —— 用户按的停止不是「无从解释的沉默」，msg2 不补失败气泡；
    // lane 排空，回执跟着消失
    await sleep(1500)
    expect(await replies(sid)).toHaveLength(1)
    expect(await chat.errorRows()).toBe(0)
    expect(await flow.receipts()).toEqual([])
    // 不出声 ≠ 不记账：两个 run（说完的 msg1、被停的 msg2）都落 run_end
    await until(
      () => kindsOf('ab-burst').filter((k) => k === 'run_end').length >= 2,
      'run_end recorded for both runs'
    )
  })
})
