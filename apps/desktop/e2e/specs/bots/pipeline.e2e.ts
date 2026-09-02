/**
 * 管线链路的端到端：**消息进 → L0 门 → 参与者名单 → turn → say 落库**。
 *
 * 三个观测面 —— `message.list`（落库 + 署名）、事件录制器（user_message / bot_activity /
 * bot_mailbox / assistant_message）、`~/.shuvix/bots/.runs/`（决策记录与 run journal）。
 *
 * **v2 取消了仲裁**：一条消息不再由多个 bot 抢、也不再只有一个胜出，每个成员各自独立
 * 判断要不要接话。因此原先钉「谁赢了 / 谁记 claim_lost / 谁让位」的三条用例整体退场
 * （claim_solo、relevance 高者胜、门控破损者让位），换成 v2 的对位事实：
 * 各说各的、故障者自己出声。`claim` 这个名字在管线脚本里已经不存在，调它是 ReferenceError。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

let app: E2EApp
let events: EventRecorder
let provider: FakeProvider

const MODEL = 'e2e-model'

/**
 * bot→bot 接力的探针管线（v2）—— **零 LLM**：它不跑门控段，落一句话就完事。
 *
 * 护栏（hop / 单轮扇出 / 永不响应自己）判在 L0 里，与管线脚本无关；用真门控只会让每一跳
 * 都多付一次假提供商往返，还把「第几跳停下来」这件事泡在 LLM 的时序噪音里。
 * `delayMs` 是唯一的旋钮：把某个成员的发言推后，好让扇出计数在它发言之前就已经涨上去。
 */
const RELAY = 'v2-relay-probe'
const RELAY_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${RELAY}`,
  'description: v2 e2e probe — say one line; bot→bot relay comes from the host, not the script.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  'v2 接力探针：可选延时 → say 一句，零 LLM。护栏由 L0 判，脚本不参与。',
  '',
  '```js workflow',
  'if (input.delayMs) await sleep(input.delayMs)',
  "await say(input.sayLine || 'ok')",
  "return { outcome: 'reply' }",
  '```',
  ''
].join('\n')

/** 落一个接力探针 bot；`relay` 决定它是不是 `shuvix-bot-respond-to: all` */
function relayBot(
  name: string,
  opts: { display: string; relay: boolean; delayMs?: number }
): string {
  writeBotMd(app, name, {
    description: `relay probe ${name}`,
    displayName: opts.display,
    pipeline: RELAY,
    ...(opts.relay ? { respondTo: 'all' } : {}),
    botInput: {
      sayLine: `${opts.display} 说话`,
      ...(opts.delayMs ? { delayMs: opts.delayMs } : {})
    }
  })
  return name
}

/**
 * 脚本化一次门控判定 —— 意图段靠 `next` 工具交回结构化结果。
 *
 * `when` 是**并发下的必需品**：假提供商的队列按「请求体读完的顺序」消费，而双 bot 的两个
 * 意图段是并行发出的 —— 不按内容认领就必然串号。判据用提示词里带的 displayName。
 */
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

/** 提示词里出现了这个 bot 的显示名 —— 双 bot 场景下认领自己那一份脚本 */
const forBot =
  (displayName: string) =>
  (r: FakeRequest): boolean =>
    !r.isTitle && r.raw.includes(displayName)

interface Msg {
  id: string
  role?: string
  content?: unknown
  metadata?: { sender?: { kind: string; name: string; displayName: string } } | null
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

const prompt = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )

async function typesFor(sid: string): Promise<string[]> {
  const all = await events.all<RecordedEvent>()
  return all.filter((e) => e.sessionId === sid).map((e) => e.type)
}

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

const kindsOf = (botName: string): string[] => decisions(botName).map((d) => String(d.kind))

/** 等到该会话上出现 n 条 assistant 消息 */
async function untilReplies(sid: string, n: number): Promise<Msg[]> {
  for (let i = 0; i < 100; i++) {
    const msgs = await listMessages(sid)
    if (msgs.filter((m) => m.role === 'assistant').length >= n) return msgs
    await new Promise((r) => setTimeout(r, 100))
  }
  return await listMessages(sid)
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()

  writeBotMd(app, 'p-alpha', { description: 'alpha', displayName: 'Alpha' })
  writeBotMd(app, 'p-beta', { description: 'beta', displayName: 'Beta' })
  writeBotMd(app, 'p-quiet', {
    description: 'quiet',
    displayName: 'Quiet',
    respond: 'mention-only'
  })
  writeBotMd(app, 'p-task', { description: 'takes the task branch', displayName: 'Tasker' })
  writeBotMd(app, 'p-broken', {
    description: 'points at a pipeline that does not exist',
    displayName: 'Broken',
    pipeline: 'no-such-pipeline'
  })

  const wfDir = join(app.home, '.shuvix', 'workflows')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, `${RELAY}.md`), RELAY_MD)
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
})

describe('单 bot：消息进 → 内置管线 → say 落库', () => {
  it('落一条带署名的 assistant 消息，事件序列覆盖 user_message → bot_activity → assistant_message', async () => {
    provider.reset()
    provider.script(gate({ decision: 'reply', reason: '寒暄', reply: '你好，我在。' }))
    const sid = await createBotSession(app.main, { bots: ['p-alpha'] })
    await events.clear()
    await prompt(sid, 'hello pipeline')

    const msgs = await untilReplies(sid, 1)
    const reply = msgs.find((m) => m.role === 'assistant')!
    expect(reply.content).toBe('你好，我在。')
    expect(reply.metadata?.sender).toMatchObject({ name: 'p-alpha', displayName: 'Alpha' })
    // 捕获即软停止是同步落地的 —— 一次成功的门控恰好一个 chat 请求
    expect(provider.chatRequestCount()).toBe(1)

    const types = await typesFor(sid)
    expect(types[0]).toBe('user_message')
    expect(types).toContain('bot_activity')
    expect(types).toContain('assistant_message')
  })

  it('task 分支走 turn()：mailbox 授予并广播快照', async () => {
    provider.reset()
    provider.script(gate({ decision: 'task', reason: '要动手', task: { objective: '查一下日志' } }))
    const sid = await createBotSession(app.main, { bots: ['p-task'] })
    await events.clear()
    await prompt(sid, 'do some work')
    await untilReplies(sid, 1)

    expect(await typesFor(sid)).toContain('bot_mailbox')
    expect(kindsOf('p-task')).toContain('mailbox_granted')
  })
})

describe('L0 门', () => {
  it('mention-only 未被提及 → 零派发，且决策记录里有痕', async () => {
    const sid = await createBotSession(app.main, { bots: ['p-quiet'] })
    await events.clear()
    await prompt(sid, 'nobody is named here')

    // 给管线一点起跑的时间，然后断言它根本没起
    await new Promise((r) => setTimeout(r, 600))
    expect((await listMessages(sid)).filter((m) => m.role === 'assistant')).toHaveLength(0)
    expect(await typesFor(sid)).toEqual(['user_message'])
    expect(kindsOf('p-quiet')).toContain('l0_mention_only_skipped')
  })

  it('裸文本 @提及 → mention-only 也参与（定向压过它）', async () => {
    provider.reset()
    provider.script(gate({ decision: 'reply', reason: '被点名', reply: '在的。' }))
    const sid = await createBotSession(app.main, { bots: ['p-quiet'] })
    await prompt(sid, '@Quiet 你在吗')
    const msgs = await untilReplies(sid, 1)
    expect(msgs.find((m) => m.role === 'assistant')?.metadata?.sender?.name).toBe('p-quiet')

    const directed = decisions('p-quiet').filter((d) => d.kind === 'l0_directed')
    expect(directed.length).toBeGreaterThan(0)
    expect((directed[directed.length - 1].detail as { via?: string })?.via).toBe('text')
    // 被点名 = 不给 ignore 的那份契约。v2 收窄了这条判据：门控段的 `solo` 只看
    // `input.session.directed`，「会话里只有我一个」不再算（`arbitrated` 那个入参没有了）
    const gateReq = provider.chatRequests().find((r) => r.raw.includes('Quiet'))!
    expect(gateReq.raw).not.toContain('\\"ignore\\"')
  })

  it('成员 md 不存在 → l0_member_missing，会话不报错', async () => {
    const sid = await createBotSession(app.main, { bots: ['p-ghost'] })
    await prompt(sid, 'anyone home')
    await new Promise((r) => setTimeout(r, 600))
    expect((await listMessages(sid)).filter((m) => m.role === 'assistant')).toHaveLength(0)
    expect(kindsOf('p-ghost')).toContain('l0_member_missing')
  })
})

describe('多 bot：各自独立，没有胜负', () => {
  it('两个成员都判要答 → 两条消息各自落库，谁也没被压制', async () => {
    provider.reset()
    // 两个意图段并行发出 —— 必须按内容认领，否则脚本会串号
    provider.script(
      gate({ decision: 'reply', reason: '我来答', reply: 'A 的回答' }, forBot('Alpha')),
      gate({ decision: 'reply', reason: '我也答', reply: 'B 的回答' }, forBot('Beta'))
    )
    const sid = await createBotSession(app.main, { bots: ['p-alpha', 'p-beta'] })
    await prompt(sid, 'who answers this')
    await untilReplies(sid, 2)
    // 静置复查：既没有迟到的第三条，也没有谁被事后撤下
    await new Promise((r) => setTimeout(r, 1500))

    const replies = (await listMessages(sid)).filter((m) => m.role === 'assistant')
    expect(replies).toHaveLength(2)
    // 落库顺序由两个 run 各自跑完的先后决定，成员序不作数 —— 断集合
    expect(replies.map((m) => m.metadata?.sender?.name).sort()).toEqual(['p-alpha', 'p-beta'])
    expect(replies.map((m) => String(m.content)).sort()).toEqual(['A 的回答', 'B 的回答'])
  })

  it('一个判 ignore、一个判要答 → 只有后者出声，前者安静且有痕', async () => {
    // 沉默只剩一条通路：这个 bot 自己判定这条不归它。它不是「让位」，
    // 也不再触发任何「全体沉默」提示
    provider.reset()
    provider.script(
      gate({ decision: 'ignore', reason: '明显冲着 Beta 去的' }, forBot('Alpha')),
      gate({ decision: 'reply', reason: '正是我管的', reply: 'B 的回答' }, forBot('Beta'))
    )
    const sid = await createBotSession(app.main, { bots: ['p-alpha', 'p-beta'] })
    await prompt(sid, 'beta please take this')
    await untilReplies(sid, 1)
    await new Promise((r) => setTimeout(r, 1500))

    const replies = (await listMessages(sid)).filter((m) => m.role === 'assistant')
    expect(replies).toHaveLength(1)
    expect(replies[0].metadata?.sender?.name).toBe('p-beta')
    // 安静的那个照样记账（结局写在 run_end 的 detail.outcome 里）
    const lastEnd = decisions('p-alpha')
      .filter((d) => d.kind === 'run_end')
      .at(-1)
    expect((lastEnd?.detail as { outcome?: string })?.outcome).toBe('ignored')
  })
})

/**
 * bot→bot 接力（v2 新增的第二根轴 `shuvix-bot-respond-to`）与它的两道护栏。
 *
 * 为什么值得一条 e2e：终止性是**结构保证**，而这个结构横跨三处 —— `say` 落库后的
 * `relayToBots`、L0 的 hop/扇出判据、以及计数的两个来源（行上的 `hop` 列与
 * 「同一 rootId 下已有多少条 bot 消息」的查询）。任何一处漏传计数，单测都看不出来：
 * 它们各自的入参都是对的，错的是「一路传下去」这件事本身。
 */
describe('bot→bot 接力与循环护栏', () => {
  /** 该会话上的 bot 消息（system 行不在其中 —— 它投影成 error_event） */
  const botMsgs = async (sid: string): Promise<Msg[]> =>
    (await listMessages(sid)).filter((m) => m.role === 'assistant')

  it('缺省 respond-to: user —— bot 的发言不触发任何人，两条消息就到头', async () => {
    // 缺省档与 v1 的硬规则「bot 的回复不触发 bot」逐字节等价：连 relayToBots 的第一句
    // 都进不去（没有任何成员声明 all）
    relayBot('rl-u1', { display: 'U1', relay: false })
    relayBot('rl-u2', { display: 'U2', relay: false })
    const sid = await createBotSession(app.main, { bots: ['rl-u1', 'rl-u2'] })
    await prompt(sid, '你们说说')
    await untilReplies(sid, 2)
    // 静置窗断「不发生」：接力若漏网，第三条会在这段时间里冒出来
    await sleep(2000)
    expect(await botMsgs(sid)).toHaveLength(2)
  })

  it('respond-to: all + maxHop=2 —— 用户 → 两人各答 → 互相接一手，第 3 跳不再派发', async () => {
    relayBot('rl-a', { display: 'RelayA', relay: true })
    relayBot('rl-b', { display: 'RelayB', relay: true })
    const sid = await createBotSession(app.main, { bots: ['rl-a', 'rl-b'] })
    await prompt(sid, '开个头')

    // 纵向必然终止：hop0 用户 → hop1 各一条 → hop2 各接一手 → hop2 的消息不再触发任何人
    await untilReplies(sid, 4)
    await sleep(2500)
    const msgs = await botMsgs(sid)
    expect(msgs).toHaveLength(4)
    // 每人两条：自己答用户的那条 + 接对方那一手
    const bySender = msgs.map((m) => m.metadata?.sender?.name).sort()
    expect(bySender).toEqual(['rl-a', 'rl-a', 'rl-b', 'rl-b'])
    // 停下来的理由写在决策记录里（不是「恰好没人再说话」）
    expect(kindsOf('rl-a')).toContain('l0_hop_exceeded')
    expect(kindsOf('rl-b')).toContain('l0_hop_exceeded')
  }, 60_000)

  it('单轮扇出触顶 → 停止派发并落一条用户看得见的 system 行，不静默', async () => {
    // 造触顶的办法：三个快成员先把这一轮撑满（3 条一跳 + 6 条二跳 = 9 > 8），
    // 第四个成员被 delayMs 推到那之后才发言 —— 它的接力读到的扇出计数已经越界。
    // 靠时序而不是靠更大的 N：扇出计数是在**每条 bot 消息要往下派发的那一刻**读的，
    // 而二跳消息（hop=2）根本不派发，所以光堆人数并不会让计数在派发前涨上去
    for (const [name, display] of [
      ['rl-f1', 'Fan1'],
      ['rl-f2', 'Fan2'],
      ['rl-f3', 'Fan3']
    ]) {
      relayBot(name, { display, relay: true })
    }
    relayBot('rl-slow', { display: 'FanSlow', relay: true, delayMs: 3000 })
    const members = ['rl-f1', 'rl-f2', 'rl-f3', 'rl-slow']
    const sid = await createBotSession(app.main, { bots: members })
    await prompt(sid, '大家一起来')

    // 触顶不静默：用户在会话里看得到「本轮已达上限」那一行（system 行投影成 error_event）
    const capped = await until(
      async () => {
        const msgs = await listMessages(sid)
        const hit = msgs.filter((m) => m.role === 'system_notify')
        return hit.length > 0 ? hit : undefined
      },
      'a system row telling the round hit its cap',
      60_000
    )
    expect(String(capped[0].content)).toBeTruthy()
    // 谁被拦下的写在它自己的决策记录里
    expect(kindsOf('rl-slow')).toContain('l0_fanout_exceeded')

    // 而且整轮确实收住了：护栏的意义是终止，不是某个精确的条数 ——
    // 派发是并发的，扇出计数每次派发只读一次，所以上界是「有界」而不是「恰好 8」
    await sleep(4000)
    const finalCount = (await botMsgs(sid)).length
    expect(finalCount).toBeLessThanOrEqual(16)
  }, 120_000)
})

describe('管线不存在 —— 失败在会话里看得见', () => {
  it('指向一份不存在的管线 → 落一条可见失败 + pipeline_not_found', async () => {
    const sid = await createBotSession(app.main, { bots: ['p-broken'] })
    await prompt(sid, 'this will not run')
    const msgs = await untilReplies(sid, 1)

    // journal 深处的记录不是呈现：用户得在会话里看到这件事
    expect(String(msgs.find((m) => m.role === 'assistant')?.content)).toContain('no-such-pipeline')
    expect(kindsOf('p-broken')).toContain('pipeline_not_found')
  })
})

describe('run journal 落到 bot 自己的目录', () => {
  it('决策记录与 run journal 同放 .runs/<bot>/，且 meta 不抄整份信封', async () => {
    provider.reset()
    provider.script(gate({ decision: 'reply', reason: 'x', reply: '记一笔。' }))
    const sid = await createBotSession(app.main, { bots: ['p-alpha'] })
    await prompt(sid, 'journal check')
    await untilReplies(sid, 1)

    const dir = join(app.home, '.shuvix', 'bots', '.runs', 'p-alpha')
    const runFiles = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && f !== 'decisions.jsonl')
    expect(runFiles.length).toBeGreaterThan(0)

    // 同一个 bot 在别的会话里也跑过 —— 按 sessionId 挑本轮那一份
    const metas = runFiles
      .map((f) =>
        readFileSync(join(dir, f), 'utf-8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((r) => r.type === 'meta')
      )
      .filter(Boolean) as Array<Record<string, unknown>>
    const meta = metas.find((m) => m.sessionId === sid)!
    expect(meta).toBeDefined()
    // 信封里是会话窗口 + 笔记 + 成员表，每个 run 抄一份 —— journal 要答的是「发生了什么」
    expect(meta.event).toBeUndefined()
    expect(meta.sessionId).toBe(sid)
  })
})

describe('门控故障：破损与超时是故障不是判定', () => {
  it('单 bot + 契约破损 → 会话里出声，记 gate_broken，消费两个请求（含一次追问）', async () => {
    // 什么都不脚本化：队列耗尽 → 裸文本 OK → manager 追问一次 → 仍没调 next
    provider.reset()
    writeBotMd(app, 'p-broke', { description: 'broken gate', displayName: 'Broke' })
    const sid = await createBotSession(app.main, { bots: ['p-broke'] })
    await prompt(sid, 'this gate will not answer')

    const msgs = await untilReplies(sid, 1)
    // 单 bot 会话里沉默与坏掉长得一模一样 —— 必须出声
    expect(String(msgs.find((m) => m.role === 'assistant')?.content)).toMatch(
      /shape I could not read/
    )
    expect(kindsOf('p-broke')).toContain('gate_broken')
    expect(provider.chatRequestCount()).toBe(2)
  })

  it('连续两次破损 → 回落内置门控并记 gate_fallback', async () => {
    // 两轮都不脚本化 —— 真的是「门控跑完了却没交结构化结果」，而不是管线本身坏掉。
    // （把 intent 换成一个不存在的 agent 是另一回事：那是 pipeline_error，`gate` 根本没有
    //  值，计数器刻意不动它 —— 这个计数器问的是「门控契约还灵不灵」）
    provider.reset()
    writeBotMd(app, 'p-streak', { description: 'gate keeps failing', displayName: 'Streak' })
    const sid = await createBotSession(app.main, { bots: ['p-streak'] })
    await prompt(sid, 'first')
    await untilReplies(sid, 1)
    await prompt(sid, 'second')
    await untilReplies(sid, 2)

    expect(kindsOf('p-streak')).toContain('gate_fallback')
  })

  it('多 bot + 一个门控破损 → 破损者自己出声，另一个照常回答', async () => {
    // v1 在这里是「破损者让位、只有胜者出声」；v2 每个 bot 各自为自己的结局负责，
    // 所以坏掉的那个必须自己冒一条可见失败 —— N 个同时坏就是 N 条错误气泡，
    // 在群聊形态下这是正确的（失败本就罕见），而「选一个代表出声」的规则已经没有前提
    provider.reset()
    // 只给 Alpha 脚本；Beta 的门控拿不到脚本 → 契约破损
    provider.script(gate({ decision: 'reply', reason: '我来', reply: '我回答。' }, forBot('Alpha')))
    const sid = await createBotSession(app.main, { bots: ['p-alpha', 'p-beta'] })
    await prompt(sid, 'one of you please')
    await untilReplies(sid, 2)
    await new Promise((r) => setTimeout(r, 1500))

    const replies = (await listMessages(sid)).filter((m) => m.role === 'assistant')
    expect(replies).toHaveLength(2)
    const alpha = replies.find((m) => m.metadata?.sender?.name === 'p-alpha')!
    const beta = replies.find((m) => m.metadata?.sender?.name === 'p-beta')!
    expect(alpha.content).toBe('我回答。')
    expect(String(beta.content)).toMatch(/shape I could not read/)
    expect(kindsOf('p-beta')).toContain('gate_broken')
  })
})

describe('clarify 回连', () => {
  it('clarify 记进那条消息的行，下一条无提及消息硬路由回同一个 bot', async () => {
    // 判定材料 v2 起直接读 `chat_messages` 的最后一条 bot 行（它自带 botName 与 decision），
    // v1 那套「消息前多写一条署名 custom entry、投影时靠紧邻配对」已随会话树一并退场
    provider.reset()
    provider.script(
      gate({ decision: 'clarify', reason: '有歧义', reply: '你指的是哪一个？' }),
      gate({ decision: 'reply', reason: '回答追问', reply: '明白了。' })
    )
    // 名单里两个成员，但第二条消息只该回到问问题的那个
    const sid = await createBotSession(app.main, { bots: ['p-alpha', 'p-beta'] })
    await prompt(sid, '@Alpha 帮我看看那个东西')
    await untilReplies(sid, 1)

    await prompt(sid, '第二个')
    await untilReplies(sid, 2)
    await new Promise((r) => setTimeout(r, 500))

    const replies = (await listMessages(sid)).filter((m) => m.role === 'assistant')
    expect(replies.map((m) => m.metadata?.sender?.name)).toEqual(['p-alpha', 'p-alpha'])
    expect(kindsOf('p-alpha')).toContain('l0_clarify_relink')
    // 回连是一次性的：同一条 clarify 不会把之后每条消息都吸过去
    expect(decisions('p-alpha').filter((d) => d.kind === 'l0_clarify_relink')).toHaveLength(1)
  })
})
