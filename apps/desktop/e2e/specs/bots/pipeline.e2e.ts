/**
 * 管线链路的端到端：**消息进 → L0 门 → 参与者名单 → turn → say 落库**。
 *
 * 三个观测面 —— `message.list`（落库 + 署名）、事件录制器（user_message / bot_activity /
 * bot_mailbox / assistant_message）、`~/.shuvix/bots/.runs/`（决策记录与 run journal），
 * 外加假提供商的请求记录（**发给模型的系统提示词**：bot 正文的围栏就落在那里）。
 *
 * **v2 取消了仲裁**：一条消息不再由多个 bot 抢、也不再只有一个胜出，每个成员各自独立
 * 判断要不要接话。`claim` 这个名字在管线脚本里已经不存在，调它是 ReferenceError。
 *
 * **v3 取消了逐 bot 的门控模式与 bot→bot 接力**：没有 mention-only（每个在册成员都进
 * cohort，「这条与我无关」由它自己的意图段说），也没有 respond-to / hop / 扇出护栏
 * （bot 的回复不触发 bot 由结构保证：`appendBotMessage` 不回灌任何门）。那些用例整体
 * 退场。取而代之的是 v3 的两件新事实：正文经 `<bot_profile>` 围栏进每个参与 agent 的
 * 系统提示词；必填槽位漏填由管线的入参校验拦下并在会话里可见地说出来。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sleep } from '../../harness/cdp'
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
 * 脚本化一次门控判定 —— 意图段靠 `next` 工具交回结构化结果。
 *
 * `when` 是**并发下的必需品**：假提供商的队列按「请求体读完的顺序」消费，而双 bot 的两个
 * 意图段是并行发出的 —— 不按内容认领就必然串号。
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

/** 请求体里的系统提示词（openai-completions 把它放在 messages 头部，role 为 system 或 developer） */
function systemPromptOf(r: FakeRequest): string {
  const m = (r.body.messages ?? []).find((x) => x.role === 'system' || x.role === 'developer')
  const c = m?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((b) => (b as { text?: string }).text ?? '').join('')
  }
  return ''
}

/**
 * 这一请求属于哪个 bot 的 run —— 按系统提示词末尾的 `<bot_profile name="…">` 围栏认领。
 *
 * 不能按显示名认：门控提示词的 others 块会列出**别的**成员的显示名，双 bot 场景下
 * 「提示词里出现了 Alpha」对 Beta 的请求同样成立。围栏的 name 只属于这次 run 的主人。
 */
const forBot =
  (name: string) =>
  (r: FakeRequest): boolean =>
    !r.isTitle && systemPromptOf(r).includes(`<bot_profile name="${name}"`)

interface Msg {
  id: string
  role?: string
  content?: unknown
  metadata?: {
    sender?: { kind: string; name: string; displayName: string }
    botFailure?: unknown
  } | null
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

const ALPHA_BODY = 'ALPHA PERSONA BODY — answer tersely.'

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()

  writeBotMd(app, 'p-alpha', { description: 'alpha', displayName: 'Alpha', body: ALPHA_BODY })
  writeBotMd(app, 'p-beta', { description: 'beta', displayName: 'Beta' })
  writeBotMd(app, 'p-task', { description: 'takes the task branch', displayName: 'Tasker' })
  writeBotMd(app, 'p-broken', {
    description: 'points at a pipeline that does not exist',
    displayName: 'Broken',
    pipeline: 'no-such-pipeline'
  })
  // 必填槽位 task 漏填：没有缺省表，管线的入参校验会拦下它
  writeBotMd(app, 'p-unset', {
    description: 'forgot to fill the task slot',
    displayName: 'Unset',
    agents: { intent: 'bot-intent' }
  })
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

describe('正文进系统提示词（v3）', () => {
  it('门控段的系统提示词末尾带 <bot_profile name file> 围栏 + 前言 + 正文；用户提示词里没有它', async () => {
    // 正文不是任何一个 agent 的系统提示词，也不在管线的任何 prompt 块里 —— 它由宿主围栏后
    // 随 invoke 的 systemContext 追加到这次 run 派发的每一个 agent 的系统提示词末尾。
    // 这件事横跨 botService → workflow engine → manager → createAgent 四层，只有真跑一次、
    // 看发到模型那边的请求体才作数
    provider.reset()
    provider.script(gate({ decision: 'reply', reason: '寒暄', reply: '在。' }))
    const sid = await createBotSession(app.main, { bots: ['p-alpha'] })
    await prompt(sid, 'who are you')
    await untilReplies(sid, 1)

    const req = provider.chatRequests()[0]
    expect(req).toBeDefined()
    const sys = systemPromptOf(req)
    // 围栏的属性：身份键 + 这份 md 的绝对路径（agent 就是往这里写）
    const file = join(app.botsDir, 'p-alpha.md')
    expect(sys).toContain(`<bot_profile name="p-alpha" file="${file}">`)
    expect(sys).toContain(ALPHA_BODY)
    // 围栏在系统提示词的**末尾**（排在门控 agent 自己的正文与项目注入之后）
    expect(sys.trimEnd().endsWith('</bot_profile>')).toBe(true)
    // 围栏外的前言是宿主在说话：这是谁、这段文字是什么
    expect(sys).toContain('You are acting on behalf of the chat bot "Alpha" (p-alpha)')
    // 正文只走系统提示词，不进用户消息
    expect(req.lastUserText).not.toContain(ALPHA_BODY)
    expect(req.lastUserText).not.toContain('<bot_profile')
  })
})

describe('L0 门', () => {
  it('裸文本 @提及 → 只有被点名的成员派发（via:text），且拿的是不含 ignore 的契约', async () => {
    provider.reset()
    provider.script(
      gate({ decision: 'reply', reason: '被点名', reply: '在的。' }, forBot('p-beta'))
    )
    const sid = await createBotSession(app.main, { bots: ['p-alpha', 'p-beta'] })
    const alphaBefore = decisions('p-alpha').length
    await prompt(sid, '@Beta 你在吗')
    const msgs = await untilReplies(sid, 1)
    await sleep(800)

    const replies = msgs.filter((m) => m.role === 'assistant')
    expect(replies).toHaveLength(1)
    expect(replies[0].metadata?.sender?.name).toBe('p-beta')
    // 定向压过 cohort：没被点名的 alpha 根本不派发（零增量记录、零请求）
    expect(decisions('p-alpha').length).toBe(alphaBefore)
    expect(provider.chatRequestCount()).toBe(1)

    const directed = decisions('p-beta').filter((d) => d.kind === 'l0_directed')
    expect(directed.length).toBeGreaterThan(0)
    expect((directed[directed.length - 1].detail as { via?: string })?.via).toBe('text')
    // 被点名 = 不给 ignore 的那份契约（门控段的 `solo` 只看 `input.session.directed`）
    const gateReq = provider.chatRequests().find(forBot('p-beta'))!
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
      gate({ decision: 'reply', reason: '我来答', reply: 'A 的回答' }, forBot('p-alpha')),
      gate({ decision: 'reply', reason: '我也答', reply: 'B 的回答' }, forBot('p-beta'))
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
      gate({ decision: 'ignore', reason: '明显冲着 Beta 去的' }, forBot('p-alpha')),
      gate({ decision: 'reply', reason: '正是我管的', reply: 'B 的回答' }, forBot('p-beta'))
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

describe('必填槽位漏填 —— 配置错在会话里看得见（v3）', () => {
  it('task 槽位未填 → 管线拒绝起跑，会话里落一条说出原话的失败；不再补通用失败气泡；零 LLM', async () => {
    // 没有缺省表：漏填不是「跑到一半坏了」而是配置错。管线的入参校验（沿 properties 递归查
    // required）把原话交回来，宿主原样说出 —— 用户才知道该去改哪一行
    provider.reset()
    const sid = await createBotSession(app.main, { bots: ['p-unset'] })
    await prompt(sid, 'anything')
    const msgs = await untilReplies(sid, 1)
    await sleep(800)

    const replies = (await listMessages(sid)).filter((m) => m.role === 'assistant')
    expect(replies).toHaveLength(1)
    const text = String(replies[0].content)
    expect(text).toContain('refused to start')
    // 管线的原话：缺的正是 agents.task
    expect(text).toContain('agents.task')
    // 通用的「没能处理完」不得叠上来（这条失败已经显形）
    expect(text).not.toContain("couldn't finish")
    expect(replies[0].metadata?.botFailure).toBe(true)
    expect(replies[0].metadata?.sender).toMatchObject({ name: 'p-unset', displayName: 'Unset' })
    // 记账 + 门控根本没起（一次模型请求都没有）
    expect(kindsOf('p-unset')).toContain('pipeline_invalid_input')
    expect(provider.chatRequestCount()).toBe(0)
    expect(msgs.some((m) => m.role === 'user')).toBe(true)
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
    // 信封里是会话窗口 + 成员表，每个 run 抄一份 —— journal 要答的是「发生了什么」
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
    provider.script(
      gate({ decision: 'reply', reason: '我来', reply: '我回答。' }, forBot('p-alpha'))
    )
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
