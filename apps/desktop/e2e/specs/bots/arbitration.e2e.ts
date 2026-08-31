/**
 * 多 bot 仲裁的两个新面（M6′）：**救济**与**全体沉默**。
 *
 * 一条用户消息只有一个回复者，这条纪律 M4′ 已经端到端钉住了。剩下的两个问题都出在
 * 「输掉之后」：落败但确实想说话的人得留下痕迹（胜者那条消息上的救济 chip），而一轮
 * 什么都没换来时得说得出坏在哪（`bot_cohort_silent`）。两者都跨 barrier → 宿主暂存 →
 * 署名侧车 → 投影 → 广播四层，所以只能在这里验。
 *
 * **大半用例零 LLM**：`t-probe` 是一份参数化的自定义 bot 管线，判定与结局全部读自各
 * bot md 的 `shuvix-bot-input`（宿主键铺在用户键之后，自定义键原样进 `input`）。真门控
 * 破损那条路才需要假提供商 —— 只有它必须让 `bot-chat` 真的跑一遍意图段。
 *
 * 不与 `pipeline.e2e.ts` 合并：那份 beforeAll 种了 5 个 bot，本文件大量用例要等满 3 秒
 * 宽限窗，混在一起会让管线用例平白慢下来。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { sleep } from '../../harness/cdp'
import { startFakeProvider, type FakeProvider } from '../../harness/fakeProvider'
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
/** 参数化探针管线的名字 —— bot md 用 `shuvix-bot-pipeline` 指向它 */
const PROBE = 't-probe'

interface Suppressed {
  name: string
  displayName: string
  decision: string
  relevance: number
  reason?: string
}

interface Msg {
  id: string
  role?: string
  content?: unknown
  metadata?: {
    sender?: { kind: string; name: string; displayName: string }
    suppressed?: Suppressed[]
  } | null
}

interface SilentEvent extends RecordedEvent {
  messageId: string
  reason: string
  members: Array<{ name: string; displayName: string; outcome: string }>
  suppressed?: Suppressed[]
}

/**
 * 参数化的 bot 管线 —— 每一条分支都对应本文件里的一个形态，而且全部由 `input` 选中。
 *
 * `mode: 'late'` 里那个 try/catch 是刻意的：定局时宿主会中止仍未表态的成员（「继续跑
 * 纯属烧钱」），`sleep` 因此会被拒绝。吞掉它，「定局之后才到」这个形态在端到端里才真的
 * 可达 —— 而它正是 `claim_timeout` 与（被中止时的）`claim_aborted` 唯一的产生路径。
 */
const PROBE_MD = [
  '---',
  'shuvix: workflow v1',
  `name: ${PROBE}`,
  'description: e2e probe pipeline — every branch is chosen by the bot own shuvix-bot-input.',
  'shuvix-workflow-concurrency: parallel',
  '---',
  '',
  'E2E 参数化 bot 管线：判定与结局全部来自 bot md 的 `shuvix-bot-input`，零 LLM。',
  '',
  '```js workflow',
  '// 旁路入场：不 claim 直接 say —— 多 bot 会话里 say 的第三道闸该拦下它',
  "if (input.mode === 'nobody') {",
  "  await say(input.line || 'bypass')",
  "  return { outcome: 'said-without-claim' }",
  '}',
  '// 连意图都没交出来的一轮',
  "if (input.mode === 'crash') fail('probe crashed before claim')",
  '',
  '// 定局之后才表态。宿主会中止未表态的成员，sleep 因此会被拒绝 —— 吞掉它，',
  '// 「迟到者」这个形态才真的可达',
  "var delayMs = input.mode === 'late' ? 4500 : input.delayMs || 0",
  'if (delayMs) {',
  '  try {',
  '    await sleep(delayMs)',
  '  } catch (e) {',
  "    log('probe woke early: ' + String((e && e.message) || e))",
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
  "if (input.mode === 'throw') fail('probe failed after winning')",
  "if (input.mode === 'mute') return { outcome: 'won-but-mute' }",
  "if (input.mode === 'twice') {",
  "  await say(input.line || 'first', { decision: 'reply' })",
  "  await say('second', { decision: 'reply' })",
  "  return { outcome: 'said-twice' }",
  '}',
  "await say(input.line || 'ok', { decision: 'reply' })",
  "return { outcome: 'reply' }",
  '```',
  ''
].join('\n')

interface ProbeSeed {
  displayName: string
  decision?: 'reply' | 'task' | 'clarify' | 'ignore'
  relevance?: number
  reason?: string
  line?: string
  mode?: 'late' | 'throw' | 'mute' | 'twice' | 'nobody' | 'crash'
  /** claim 之前先睡这么久（制造确定的到达序） */
  delayMs?: number
}

/** 写一个指向探针管线的 bot；返回它的稳定名 */
function probe(name: string, seed: ProbeSeed): string {
  const botInput: Record<string, string | number> = {}
  if (seed.decision) botInput.decision = seed.decision
  if (seed.relevance !== undefined) botInput.relevance = seed.relevance
  if (seed.reason) botInput.reason = seed.reason
  if (seed.line) botInput.line = seed.line
  if (seed.mode) botInput.mode = seed.mode
  if (seed.delayMs !== undefined) botInput.delayMs = seed.delayMs
  writeBotMd(app, name, {
    description: `probe ${name}`,
    displayName: seed.displayName,
    pipeline: PROBE,
    botInput
  })
  return name
}

const listMessages = (sid: string): Promise<Msg[]> =>
  app.main.eval(`window.api.message.list(${JSON.stringify(sid)})`)

const replies = async (sid: string): Promise<Msg[]> =>
  (await listMessages(sid)).filter((m) => m.role === 'assistant')

const prompt = (sid: string, text: string): Promise<void> =>
  app.main.eval(
    `window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} })`
  )

/** 发出但**不等** —— 中止用例要在 cohort 还在跑的时候插进去 */
const promptDetached = (sid: string, text: string): Promise<string> =>
  app.main.eval(
    `(window.api.agent.prompt({ sessionId: ${JSON.stringify(sid)}, text: ${JSON.stringify(text)} }).catch(() => undefined), 'sent')`
  )

const abortSession = (sid: string): Promise<unknown> =>
  app.main.eval(`window.api.agent.abort(${JSON.stringify(sid)})`)

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

/** 该会话上录到的全体沉默事件（断言「一次都没有」时也用它） */
async function silences(sid: string): Promise<SilentEvent[]> {
  const all = await events.all<RecordedEvent>()
  return all.filter(
    (e) => e.type === 'bot_cohort_silent' && e.sessionId === sid
  ) as unknown as SilentEvent[]
}

/** 等到该会话上出现 n 条 assistant 消息 */
async function untilReplies(sid: string, n: number): Promise<Msg[]> {
  for (let i = 0; i < 100; i++) {
    const msgs = await replies(sid)
    if (msgs.length >= n) return msgs
    await sleep(100)
  }
  return await replies(sid)
}

/** 等到某个 bot 的决策记录里出现这个 kind（脱手跑的脚本会晚一点才落记录） */
async function untilKind(botName: string, kind: string): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    const kinds = kindsOf(botName)
    if (kinds.includes(kind)) return kinds
    await sleep(100)
  }
  return kindsOf(botName)
}

beforeAll(async () => {
  app = await launchApp()
  provider = await startFakeProvider()
  await seedFakeProvider(app.main, { baseUrl: provider.baseUrl, modelId: MODEL })
  await waitRendererReady(app.main)
  events = eventRecorder(app.main)
  await events.install()

  const wfDir = join(app.home, '.shuvix', 'workflows')
  mkdirSync(wfDir, { recursive: true })
  writeFileSync(join(wfDir, `${PROBE}.md`), PROBE_MD)
}, 120_000)

afterAll(async () => {
  await app?.stop()
  await provider?.close()
})

describe('救济 chip —— 落败但想说话的人挂在胜者那条消息上', () => {
  it('胜者那条回复带着完整的候选名单（稳定名 / 显示名 / 判定 / 相关度 / 理由）', async () => {
    // 名字本身答不了「XX 也想回答」：chip 的整句话是「它本来打算做什么、有多相关、
    // 为什么」—— 少任何一格，UI 就只能显示一个没有信息量的名字
    probe('s1-alpha', { displayName: 'Alpha', relevance: 8, line: 'A 的回答' })
    probe('s1-beta', { displayName: 'Beta', relevance: 3, reason: '我也能答' })
    const sid = await createBotSession(app.main, { bots: ['s1-alpha', 's1-beta'] })
    await prompt(sid, '谁来答这条')

    const msgs = await untilReplies(sid, 1)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].metadata?.sender?.name).toBe('s1-alpha')
    expect(msgs[0].content).toBe('A 的回答')
    expect(msgs[0].metadata?.suppressed).toEqual([
      { name: 's1-beta', displayName: 'Beta', decision: 'reply', relevance: 3, reason: '我也能答' }
    ])
  })

  it('流式广播与重开会话逐字段同源', async () => {
    // 落树那条广播跑的是切片投影，`message.list` 跑的是整棵树。chip 若只在其中一条
    // 路径上成型，用户刷新一下就会看到「还有人想回答」凭空出现或消失
    probe('s2-alpha', { displayName: 'Alpha', relevance: 8, line: '我来' })
    probe('s2-beta', { displayName: 'Beta', relevance: 3, reason: '我也能答' })
    const sid = await createBotSession(app.main, { bots: ['s2-alpha', 's2-beta'] })
    await events.clear()
    await prompt(sid, '谁来答这条')

    const evt = await events.waitFor<RecordedEvent & { messageId: string; message: string }>(
      'assistant_message',
      { sessionId: sid, timeoutMs: 20_000 }
    )
    const streamed = JSON.parse(evt.message) as Msg
    const reopened = (await untilReplies(sid, 1)).find((m) => m.id === evt.messageId)
    expect(streamed.metadata?.suppressed).toEqual(reopened?.metadata?.suppressed)
    expect(streamed.metadata?.suppressed).toHaveLength(1)
  })

  it('名单按排名而不是按到达序 —— 先到的未必排在前面', async () => {
    // 到达序刻意与排名相反：beta(3) 最先表态、alpha(5) 其次、gamma(7) 最后夺冠。
    // 按到达序输出会得到 [beta, alpha]
    probe('s3-alpha', { displayName: 'Alpha', relevance: 5, delayMs: 150 })
    probe('s3-beta', { displayName: 'Beta', relevance: 3 })
    probe('s3-gamma', { displayName: 'Gamma', relevance: 7, delayMs: 300, line: 'G 的回答' })
    const sid = await createBotSession(app.main, {
      bots: ['s3-alpha', 's3-beta', 's3-gamma']
    })
    await prompt(sid, '谁来答这条')

    const msgs = await untilReplies(sid, 1)
    expect(msgs[0].metadata?.sender?.name).toBe('s3-gamma')
    expect(msgs[0].metadata?.suppressed?.map((s) => s.name)).toEqual(['s3-alpha', 's3-beta'])
  })

  it('自判不接的成员不进名单 —— 它刚刚明确说过这条不归自己', async () => {
    probe('s4-alpha', { displayName: 'Alpha', relevance: 5, line: 'A 的回答' })
    probe('s4-beta', { displayName: 'Beta', decision: 'ignore', relevance: 9 })
    probe('s4-gamma', { displayName: 'Gamma', relevance: 2 })
    const sid = await createBotSession(app.main, {
      bots: ['s4-alpha', 's4-beta', 's4-gamma']
    })
    await prompt(sid, '谁来答这条')

    const msgs = await untilReplies(sid, 1)
    expect(msgs[0].metadata?.sender?.name).toBe('s4-alpha')
    // relevance 9 的 ignore 者压根没进过候选池 —— 它不是「被压制」，是自己不想说
    expect(msgs[0].metadata?.suppressed?.map((s) => s.name)).toEqual(['s4-gamma'])
    expect(kindsOf('s4-beta')).toContain('claim_ignored')
  })

  it('定局之后才表态的成员既不进名单，也不落第二条消息', async () => {
    // 名单是定局那一刻的快照；胜者那条消息往往已经落树了，追加进去等于事后改写
    probe('s5-alpha', { displayName: 'Alpha', relevance: 5, line: 'A 的回答' })
    probe('s5-beta', { displayName: 'Beta', relevance: 3 })
    probe('s5-gamma', { displayName: 'Gamma', relevance: 9, mode: 'late' })
    const sid = await createBotSession(app.main, {
      bots: ['s5-alpha', 's5-beta', 's5-gamma']
    })
    await prompt(sid, '谁来答这条')
    await untilReplies(sid, 1)
    // 迟到者 4.5s 后才醒；再等一会儿，确认它没有把第二条塞进来
    await sleep(3500)

    const msgs = await replies(sid)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].metadata?.sender?.name).toBe('s5-alpha')
    expect(msgs[0].metadata?.suppressed?.map((s) => s.name)).toEqual(['s5-beta'])
    // 「慢」不是「不想说」也不是「输了」—— 决策记录里它是独立的一种结局
    expect(await untilKind('s5-gamma', 'claim_timeout')).toContain('claim_timeout')
  })

  it('一轮只挂一次：胜者说第二句时不再重复「还有谁想回答」', async () => {
    probe('s6-alpha', { displayName: 'Alpha', relevance: 8, mode: 'twice', line: '第一句' })
    probe('s6-beta', { displayName: 'Beta', relevance: 3, reason: '我也能答' })
    const sid = await createBotSession(app.main, { bots: ['s6-alpha', 's6-beta'] })
    await prompt(sid, '谁来答这条')

    const msgs = await untilReplies(sid, 2)
    expect(msgs.map((m) => m.content)).toEqual(['第一句', 'second'])
    expect(msgs[0].metadata?.suppressed?.map((s) => s.name)).toEqual(['s6-beta'])
    expect(msgs[1].metadata).not.toHaveProperty('suppressed')
  })

  it('一轮一份，按 (会话, 消息序) 隔离：同一会话的第二轮不串味，第一轮也不被改写', async () => {
    // 暂存键是 `(sessionId, messageSeq)` 而不是 sessionId —— 否则同一会话里连发两条，
    // 第二轮的名单会覆盖第一轮那份还没被取走的
    probe('s7-alpha', { displayName: 'Alpha', relevance: 9, line: 'A 的回答' })
    probe('s7-beta', { displayName: 'Beta', relevance: 3 })
    probe('s7-gamma', { displayName: 'Gamma', relevance: 5 })
    const sid = await createBotSession(app.main, {
      bots: ['s7-alpha', 's7-beta', 's7-gamma']
    })

    await prompt(sid, '第一轮谁来答')
    const first = await untilReplies(sid, 1)
    expect(first[0].metadata?.suppressed?.map((s) => s.name)).toEqual(['s7-gamma', 's7-beta'])

    // 第二轮只点名两个人 —— cohort 变小，名单也该跟着变小
    await prompt(sid, '@Alpha @Gamma 第二轮')
    const both = await untilReplies(sid, 2)
    expect(both[1].metadata?.suppressed?.map((s) => s.name)).toEqual(['s7-gamma'])

    // 第一条消息上的那份仍是两个：它已经落树，与第二轮再无关系
    const reread = await replies(sid)
    expect(reread[0].metadata?.suppressed?.map((s) => s.name)).toEqual(['s7-gamma', 's7-beta'])
  })
})

describe('胜者自己也哑了 —— 欠着一条回复的人不该沉默', () => {
  it('胜者半路失败 → 会话里有一条可见失败气泡，chip 挂在那条气泡上', async () => {
    // 多 bot 的败者保持静默（否则每条消息多出 N−1 条错误气泡），但胜者不在此列：
    // 它正是那个欠着一条回复的人。顺带这也让被它压制的候选有处可挂
    probe('s8-alpha', { displayName: 'Alpha', relevance: 8, mode: 'throw' })
    probe('s8-beta', { displayName: 'Beta', relevance: 3, reason: '我也能答' })
    const sid = await createBotSession(app.main, { bots: ['s8-alpha', 's8-beta'] })
    await events.clear()
    await prompt(sid, '谁来答这条')

    const msgs = await untilReplies(sid, 1)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].metadata?.sender?.name).toBe('s8-alpha')
    expect(String(msgs[0].content)).toContain('⚠️')
    expect(msgs[0].metadata?.suppressed).toEqual([
      { name: 's8-beta', displayName: 'Beta', decision: 'reply', relevance: 3, reason: '我也能答' }
    ])
    // 会话里已经有一条可见结局了 —— 再弹一次「全体沉默」是把同一件事说两遍
    expect(await silences(sid)).toHaveLength(0)
  })

  it('胜者赢了却什么都没说 → 全体沉默事件自己带上那份名单', async () => {
    // `ChatBotCohortSilentEvent.suppressed` 存在的唯一理由：没有胜者消息可挂，
    // 而这恰恰是最该给出救济的一次 —— 有人想接，赢家却一个字都没说
    probe('s9-alpha', { displayName: 'Alpha', relevance: 8, mode: 'mute' })
    probe('s9-beta', { displayName: 'Beta', relevance: 3, reason: '我也能答' })
    const sid = await createBotSession(app.main, { bots: ['s9-alpha', 's9-beta'] })
    await events.clear()
    await prompt(sid, '谁来答这条')

    const evt = await events.waitFor<SilentEvent>('bot_cohort_silent', {
      sessionId: sid,
      timeoutMs: 20_000
    })
    expect(await replies(sid)).toHaveLength(0)
    expect(evt.reason).toBe('all_failed')
    expect(evt.suppressed).toEqual([
      { name: 's9-beta', displayName: 'Beta', decision: 'reply', relevance: 3, reason: '我也能答' }
    ])
  })
})

describe('全体沉默 —— 一轮一个字都没换来', () => {
  it('全员自判不接 → all_ignored，事件不带救济名单，每个成员各记一条', async () => {
    probe('sa-alpha', { displayName: 'Alpha', decision: 'ignore', relevance: 1 })
    probe('sa-beta', { displayName: 'Beta', decision: 'ignore', relevance: 2 })
    const sid = await createBotSession(app.main, { bots: ['sa-alpha', 'sa-beta'] })
    await events.clear()
    await prompt(sid, '这条跟你们都没关系')

    const evt = await events.waitFor<SilentEvent>('bot_cohort_silent', {
      sessionId: sid,
      timeoutMs: 20_000
    })
    expect(evt.reason).toBe('all_ignored')
    expect(evt.members).toEqual([
      { name: 'sa-alpha', displayName: 'Alpha', outcome: 'claim_ignored' },
      { name: 'sa-beta', displayName: 'Beta', outcome: 'claim_ignored' }
    ])
    // 谁都没进过候选池，所以没有任何人可救济 —— 连这个键都不该铺
    expect(evt).not.toHaveProperty('suppressed')
    expect(await replies(sid)).toHaveLength(0)

    // 决策记录按 bot 分目录，回答的是「这个 bot 为什么没说话」——「这一轮谁都没说」
    // 正是只能由 cohort 视角给出、又最该记在它自己那份里的一句
    for (const name of ['sa-alpha', 'sa-beta']) {
      const rec = decisions(name).filter((d) => d.kind === 'cohort_silent')
      expect(rec).toHaveLength(1)
      expect(rec[0].ticketId).toBe('-')
      expect(rec[0].detail).toMatchObject({ reason: 'all_ignored', self: 'claim_ignored' })
    }
  })

  it('没有一个走到判定 → all_failed，且每个成员的 outcome 说得出坏在哪', async () => {
    // 走真的 bot-chat：假提供商不给脚本，两个意图段都拿不到结构化结果 → 门控破损。
    // 破损是**故障不是判定**，有别人在场时它选择让位 —— 于是一轮下来一个字都没有
    provider.reset()
    writeBotMd(app, 'sb-alpha', { description: 'real gate', displayName: 'Alpha' })
    writeBotMd(app, 'sb-beta', { description: 'real gate', displayName: 'Beta' })
    const sid = await createBotSession(app.main, { bots: ['sb-alpha', 'sb-beta'] })
    await events.clear()
    await prompt(sid, '你们谁来')

    const evt = await events.waitFor<SilentEvent>('bot_cohort_silent', {
      sessionId: sid,
      timeoutMs: 30_000
    })
    expect(evt.reason).toBe('all_failed')
    // 「跑完了」不是结局。三级优先里脚本自报的 outcome 压过 run 怎么收的，
    // 正是为了让这里读出 gate-broken 而不是一个毫无信息量的 ok
    expect(evt.members.map((m) => m.outcome)).toEqual(['gate-broken', 'gate-broken'])
    expect(await replies(sid)).toHaveLength(0)
  })

  it('自定义管线在判定之前就抛 → 同样是 all_failed', async () => {
    probe('sc-alpha', { displayName: 'Alpha', mode: 'crash' })
    probe('sc-beta', { displayName: 'Beta', mode: 'crash' })
    const sid = await createBotSession(app.main, { bots: ['sc-alpha', 'sc-beta'] })
    await events.clear()
    await prompt(sid, '你们谁来')

    const evt = await events.waitFor<SilentEvent>('bot_cohort_silent', {
      sessionId: sid,
      timeoutMs: 20_000
    })
    expect(evt.reason).toBe('all_failed')
    expect(evt.members.map((m) => m.outcome)).toEqual(['failed', 'failed'])
  })

  it('一个判定不接、一个坏掉 → mixed（不能说成「大家都不接」）', async () => {
    provider.reset()
    probe('sd-alpha', { displayName: 'Alpha', decision: 'ignore', relevance: 3 })
    writeBotMd(app, 'sd-beta', { description: 'real gate', displayName: 'Beta' })
    const sid = await createBotSession(app.main, { bots: ['sd-alpha', 'sd-beta'] })
    await events.clear()
    await prompt(sid, '你们谁来')

    const evt = await events.waitFor<SilentEvent>('bot_cohort_silent', {
      sessionId: sid,
      timeoutMs: 30_000
    })
    expect(evt.reason).toBe('mixed')
    expect(evt.members.map((m) => m.outcome)).toEqual(['claim_ignored', 'gate-broken'])
  })

  it('有人开了口就不提示 —— 哪怕它说的是一条失败', async () => {
    // 判据是「会话里多出东西了吗」，不是「脚本调过 say 吗」：一条已经显形的失败
    // 再触发一次沉默提示，等于把同一件事说两遍
    writeBotMd(app, 'se-ghost', {
      description: 'points at a pipeline that does not exist',
      displayName: 'Ghost',
      pipeline: 'no-such-pipeline'
    })
    probe('se-alpha', { displayName: 'Alpha', decision: 'ignore' })
    probe('se-beta', { displayName: 'Beta', decision: 'ignore' })
    const sid = await createBotSession(app.main, {
      bots: ['se-ghost', 'se-alpha', 'se-beta']
    })
    await events.clear()
    await prompt(sid, '你们谁来')

    const msgs = await untilReplies(sid, 1)
    expect(msgs).toHaveLength(1)
    expect(String(msgs[0].content)).toContain('no-such-pipeline')
    await sleep(1000)
    expect(await silences(sid)).toHaveLength(0)
  })

  it('单 bot 路径不走这条 —— 那里的沉默要的是一条留痕的失败消息', async () => {
    // 一对一会话里沉默与坏掉长得一模一样，所以必须出声；而一次转瞬即逝的提示
    // 留不下痕迹。cohort 只有一个人时（这里是被点名收窄成的）同理
    provider.reset()
    writeBotMd(app, 'sf-alpha', { description: 'real gate', displayName: 'Alpha' })
    probe('sf-beta', { displayName: 'Beta' })
    probe('sf-gamma', { displayName: 'Gamma' })
    const sid = await createBotSession(app.main, {
      bots: ['sf-alpha', 'sf-beta', 'sf-gamma']
    })
    await events.clear()
    await prompt(sid, '@Alpha 只问你')

    const msgs = await untilReplies(sid, 1)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].metadata?.sender?.name).toBe('sf-alpha')
    expect(kindsOf('sf-alpha')).toContain('gate_broken')
    expect(await silences(sid)).toHaveLength(0)
  })

  it('多 bot 会话里不 claim 的自定义管线：被 say 的闸拦下，整轮记为 all_failed', async () => {
    // 隐式入场等于给「不调 claim」发一张永远赢的票
    probe('sg-alpha', { displayName: 'Alpha', mode: 'nobody', line: '我直接说了' })
    probe('sg-beta', { displayName: 'Beta', mode: 'nobody', line: '我也直接说' })
    const sid = await createBotSession(app.main, { bots: ['sg-alpha', 'sg-beta'] })
    await events.clear()
    await prompt(sid, '你们谁来')

    const evt = await events.waitFor<SilentEvent>('bot_cohort_silent', {
      sessionId: sid,
      timeoutMs: 20_000
    })
    expect(evt.reason).toBe('all_failed')
    expect(await replies(sid)).toHaveLength(0)
    expect(kindsOf('sg-alpha')).toContain('arbitration_bypassed')
    expect(kindsOf('sg-beta')).toContain('arbitration_bypassed')
    // 提示自己就说得出是哪一种坏法：笼统的 'failed' 会让写管线的人往网络/模型上找原因，
    // 而真正的原因是这份 md 压根没调 claim。members 带结局的全部意义就在这里 ——
    // 不必去读 N 份 decisions.jsonl 才能说清「谁怎么了」
    expect(evt.members.map((m) => m.outcome)).toEqual([
      'arbitration_bypassed',
      'arbitration_bypassed'
    ])
  })
})

describe('用户按了停止 —— 那不是「无从解释的沉默」', () => {
  it('中止在飞的 cohort：一条沉默提示都不弹', async () => {
    // 不加分辨的话，点一次停止就会弹一条「全体沉默：有东西坏了」。这两个 bot 若跑完
    // 恰恰会触发一次 all_failed（赢了却什么都不说），所以这条用例是有差可辨的
    probe('sh-alpha', { displayName: 'Alpha', relevance: 8, mode: 'mute', delayMs: 1500 })
    probe('sh-beta', { displayName: 'Beta', relevance: 3, mode: 'mute', delayMs: 1500 })
    const sid = await createBotSession(app.main, { bots: ['sh-alpha', 'sh-beta'] })
    await events.clear()
    await promptDetached(sid, '你们谁来')

    await sleep(400)
    await abortSession(sid)
    await sleep(5000)

    expect(await silences(sid)).toHaveLength(0)
    expect(await replies(sid)).toHaveLength(0)
  })

  it('中止连 barrier 一起拆：宽限窗不会在会话收尾之后才 fire', async () => {
    // 不拆的话，定时器会在 3 秒后往一个早已收尾的会话里回调宿主，把一份再也没人来取的
    // 名单塞进暂存表（内存泄漏），迟到者也会被写成「你太慢了」而不是「有人按了停止」
    probe('si-alpha', { displayName: 'Alpha', relevance: 8, line: 'A 的回答' })
    probe('si-beta', { displayName: 'Beta', relevance: 3, mode: 'late' })
    const sid = await createBotSession(app.main, { bots: ['si-alpha', 'si-beta'] })
    await events.clear()
    await promptDetached(sid, '你们谁来')

    // alpha 已经表态、宽限窗正在走；在它到期之前停掉
    await sleep(500)
    await abortSession(sid)
    await sleep(5000)

    // 迟到者拿到的是「有人按了停止」而不是「你太慢了」—— barrier 若活到宽限窗到期，
    // 它会照常自然定局，这里读出来的就会是 claim_timeout
    const kinds = await untilKind('si-beta', 'claim_aborted')
    expect(kinds).toContain('claim_aborted')
    expect(kinds).not.toContain('claim_timeout')
    expect(await silences(sid)).toHaveLength(0)
    expect(await replies(sid)).toHaveLength(0)
  })
})
