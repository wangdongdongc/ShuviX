/**
 * 管线链路的端到端（M4′）：**消息进 → L0 门 → cohort → claim → turn → say 落树**。
 *
 * 全程 no-LLM：骨架管线一次 `run()` 都不调，所以不解析模型、不碰 provider、不需要 API key。
 * 三个观测面 —— `message.list`（落树 + 署名）、事件录制器（user_message / bot_activity /
 * bot_mailbox / assistant_message）、`~/.shuvix/bots/.runs/`（决策记录与 run journal）。
 *
 * 骨架脚本的判定是确定性的（`skeletonDecision`），所以这些用例钉的是**链路**不是判断力；
 * 真意图段接上（M5′）之后它们仍应全绿。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createBotSession,
  eventRecorder,
  waitRendererReady,
  writeBotMd,
  type EventRecorder,
  type RecordedEvent
} from '../../harness/seed'

let app: E2EApp
let events: EventRecorder

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
  writeBotMd(app, 'p-task', {
    description: 'takes the task branch',
    displayName: 'Tasker',
    botInput: { skeletonDecision: 'task' }
  })
  writeBotMd(app, 'p-broken', {
    description: 'points at a pipeline that does not exist',
    displayName: 'Broken',
    pipeline: 'no-such-pipeline'
  })
}, 120_000)

afterAll(async () => {
  await app?.stop()
})

describe('单 bot：消息进 → 骨架管线 → say 落树', () => {
  it('落一条带署名的 assistant 消息，事件序列覆盖 started → claimed → ended', async () => {
    const sid = await createBotSession(app.main, { bots: ['p-alpha'] })
    await events.clear()
    await prompt(sid, 'hello pipeline')

    const msgs = await untilReplies(sid, 1)
    const reply = msgs.find((m) => m.role === 'assistant')!
    expect(reply.content).toContain('hello pipeline')
    expect(reply.metadata?.sender).toMatchObject({ name: 'p-alpha', displayName: 'Alpha' })

    const types = await typesFor(sid)
    expect(types[0]).toBe('user_message')
    expect(types).toContain('bot_activity')
    expect(types).toContain('assistant_message')
  })

  it('单 bot 的 claim 是常量退化：记 claim_solo，不是 claim_won', async () => {
    const sid = await createBotSession(app.main, { bots: ['p-alpha'] })
    await prompt(sid, 'solo path')
    await untilReplies(sid, 1)
    // cohort.size === 1 时胜者在 barrier 建立时就定了 —— 零等待、零宽限窗
    expect(kindsOf('p-alpha')).toContain('claim_solo')
  })

  it('task 分支走 turn()：mailbox 授予并广播快照', async () => {
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
    const sid = await createBotSession(app.main, { bots: ['p-quiet'] })
    await prompt(sid, '@Quiet 你在吗')
    const msgs = await untilReplies(sid, 1)
    expect(msgs.find((m) => m.role === 'assistant')?.metadata?.sender?.name).toBe('p-quiet')

    const directed = decisions('p-quiet').filter((d) => d.kind === 'l0_directed')
    expect(directed.length).toBeGreaterThan(0)
    expect((directed[directed.length - 1].detail as { via?: string })?.via).toBe('text')
  })

  it('成员 md 不存在 → l0_member_missing，会话不报错', async () => {
    const sid = await createBotSession(app.main, { bots: ['p-ghost'] })
    await prompt(sid, 'anyone home')
    await new Promise((r) => setTimeout(r, 600))
    expect((await listMessages(sid)).filter((m) => m.role === 'assistant')).toHaveLength(0)
    expect(kindsOf('p-ghost')).toContain('l0_member_missing')
  })
})

describe('多 bot 仲裁：一条消息只有一个回复者', () => {
  it('双 bot 同分 → 只有一条 assistant 消息落树，败者记 claim_lost', async () => {
    const sid = await createBotSession(app.main, { bots: ['p-alpha', 'p-beta'] })
    await prompt(sid, 'who answers this')
    await untilReplies(sid, 1)
    // 宽限窗 3s：等它定局再断言「没有第二条」
    await new Promise((r) => setTimeout(r, 3500))

    const replies = (await listMessages(sid)).filter((m) => m.role === 'assistant')
    expect(replies).toHaveLength(1)
    // 同 relevance / 同 decision → 成员序决胜，胜者恒为 p-alpha
    expect(replies[0].metadata?.sender?.name).toBe('p-alpha')
    expect(kindsOf('p-beta')).toContain('claim_lost')
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

describe('run journal 落到 bot 自己的目录', () => {
  it('决策记录与 run journal 同放 .runs/<bot>/，且 meta 不抄整份信封', async () => {
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
