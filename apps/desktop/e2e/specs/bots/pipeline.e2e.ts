/**
 * 管线链路的端到端：**消息进 → 绑定的 bot 一次 invoke → turn → say 落库**。
 *
 * 三个观测面 —— `message.list`（落库 + 署名）、事件录制器（user_message / bot_activity /
 * bot_mailbox / assistant_message）、`~/.shuvix/bots/.runs/`（决策记录与 run journal），
 * 外加假提供商的请求记录（**发给模型的系统提示词**：bot 正文的围栏就落在那里）。
 *
 * 会话是一对一的：一个会话恰绑一个 bot（`settings.bot`），每条用户消息就是它的一次
 * 管线 invoke，`input.session` 只有 `{ id }` —— 没有成员名单、没有「谁被点名」、没有
 * 参与者筛选这一层（群聊时代的 L0 门、cohort、@定向、clarify 回连、多 bot 各自独立都
 * 随之退场，那些用例整体删除）。留下来的是管线本身：门控裁决怎么变成一条署名消息、
 * 正文经 `<bot_profile>` 围栏进每个参与 agent 的系统提示词、配置错在会话里可见地说出来、
 * 门控故障是故障不是判定。「绑定的 md 不存在」搬去了 binding.e2e.ts（那是绑定的事）。
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
 * `when` 用于按内容认领：假提供商的队列按「请求体读完的顺序」消费，标题请求等别的
 * 请求混进来时不按内容认领就会串号。
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
 * 一对一之后一条会话里只有一个 bot，认领不再是并发下的必需品；留着它是因为围栏的
 * name 只属于这次 run 的主人 —— 用它做 `when`，等于顺手断定「这次请求确实带着这个 bot
 * 的围栏」，比按显示名或裸请求序认领可靠。
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
    // 按围栏认领：这次门控请求的系统提示词末尾确实是 p-alpha 的 <bot_profile>
    provider.script(
      gate({ decision: 'reply', reason: '寒暄', reply: '你好，我在。' }, forBot('p-alpha'))
    )
    const sid = await createBotSession(app.main, { bot: 'p-alpha' })
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
    const sid = await createBotSession(app.main, { bot: 'p-task' })
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
    const sid = await createBotSession(app.main, { bot: 'p-alpha' })
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

describe('管线不存在 —— 失败在会话里看得见', () => {
  it('指向一份不存在的管线 → 落一条可见失败 + pipeline_not_found', async () => {
    const sid = await createBotSession(app.main, { bot: 'p-broken' })
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
    const sid = await createBotSession(app.main, { bot: 'p-unset' })
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
    provider.script(gate({ decision: 'reply', reason: 'x', reply: '记一笔。' }, forBot('p-alpha')))
    const sid = await createBotSession(app.main, { bot: 'p-alpha' })
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
    // 信封里是会话窗口 + 管线 input，每个 run 抄一份 —— journal 要答的是「发生了什么」
    expect(meta.event).toBeUndefined()
    expect(meta.sessionId).toBe(sid)
  })
})

describe('门控故障：破损与超时是故障不是判定', () => {
  it('契约破损 → 会话里出声，记 gate_broken，消费两个请求（含一次追问）', async () => {
    // 什么都不脚本化：队列耗尽 → 裸文本 OK → manager 追问一次 → 仍没调 next
    provider.reset()
    writeBotMd(app, 'p-broke', { description: 'broken gate', displayName: 'Broke' })
    const sid = await createBotSession(app.main, { bot: 'p-broke' })
    await prompt(sid, 'this gate will not answer')

    const msgs = await untilReplies(sid, 1)
    // 一对一会话里沉默与坏掉长得一模一样 —— 必须出声
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
    const sid = await createBotSession(app.main, { bot: 'p-streak' })
    await prompt(sid, 'first')
    await untilReplies(sid, 1)
    await prompt(sid, 'second')
    await untilReplies(sid, 2)

    expect(kindsOf('p-streak')).toContain('gate_fallback')
  })
})
