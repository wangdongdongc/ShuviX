/**
 * 目标的验收规格（docs/goal-mode-design.md §15）：设定目标的消息让干活的 agent 第一轮先整理验收规格 —— 只问用户自己才能定的事、
 * 在工作目录里写一份 md、回复里一行 `Acceptance spec: <路径>` —— 宿主不派别的 agent。根运行结束时，目标还没有 `specPath`
 * 就从设定之后的助手回复里认最后一行，文件在才记下（绝对路径），之后判定的 payload、续跑与恢复通知都点名它。
 * 替身与 goalService.test.ts 同一套（真 durable 会话 + 桌面接缝替身），工作目录是每个用例一份的临时目录。
 *
 * GS-1 设定消息：原文 + `<goal-set>` 说明（整理规格的做法 + `Acceptance spec:` 约定），只发这一条、只有干活的一轮；视图没有 planning
 * GS-2 第一轮回复里的相对路径（反引号包着）→ 绝对 specPath 进记录与广播 → 判定 payload 带它 → 续跑通知点名它 → 恢复通知也点名它
 * GS-3 绝对路径（强调包着标签与路径）照收，工作目录外也行；`..` 归一
 * GS-4 认最后一行：前面的被后面的盖过；最后一行点名的文件不在 → 没有规格（不回头找前面的）
 * GS-5 没有这一行 / 文件不在 / 点名的是目录 → 没有规格，判定照常（payload 没有 specPath），不在的记一条 warn
 * GS-6 第一轮没写、续跑那一轮写了 → 第二次运行结束时记下，第二次判定的 payload 才有它
 * GS-7 记下之后不再自动改：之后的回复点名别的文件也不换
 * GS-8 只看设定之后的回复：换新目标后，旧目标那一轮的那一行不算
 * GS-9 `specPathNamedIn`：逐个正文块看（块与块之间没有换行也认得出），只看助手消息、只看 since 之后
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fauxText, type AssistantMessage } from '@earendil-works/pi-ai'
import {
  readGoal,
  readTranscriptDigest,
  type DurableSession,
  type GoalCheckPayload
} from '@shuvix/agent-runtime'
import { GOAL_SET_NOTE_TEXT } from '@shuvix/chat-protocol/goalSet'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { GoalRecord, GoalView } from '@shuvix/chat-protocol/types/goal'
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/host'
import {
  answer,
  assistantWith
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/faux'
import {
  sleep,
  waitFor
} from '../../../../../../packages/agent-runtime/src/durable/__tests__/support/wait'

// ─────────────────────────── 替身 ───────────────────────────

type Row = { parentId?: string | null; settings?: Record<string, unknown>; title?: string }
type Facade = {
  durable: DurableSession
  maskTexts: (texts: readonly string[]) => Promise<string[]>
  admitSteer: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  rows: new Map<string, Row>(),
  decide: vi.fn(),
  broadcast: vi.fn<(event: Record<string, unknown>) => void>(),
  host: {
    current: undefined as
      | undefined
      | { peek: (id: string) => Promise<unknown>; get: (id: string) => unknown }
  },
  ensure: vi.fn<(id: string) => Promise<unknown>>(),
  transcript: vi.fn<(id: string) => Promise<unknown[]>>(),
  warn: vi.fn<(message: string) => void>(),
  workingDirectory: { current: '' }
}))

vi.mock('../settingsService', () => ({
  settingsService: {
    get: (key: string) => mocks.settings.get(key),
    set: (key: string, value: string) => mocks.settings.set(key, value)
  }
}))
vi.mock('../sessionRecords', () => ({
  sessionRecords: {
    pick: (id: string, fields: string[]) => {
      const row = mocks.rows.get(id)
      if (row === undefined) return undefined
      return Object.fromEntries(
        fields.map((field) => [field, (row as Record<string, unknown>)[field]])
      )
    },
    isEphemeral: () => false,
    findChildren: () => []
  }
}))
vi.mock('../hookService', () => ({
  hookService: { agentsBoundTo: () => new Set(['goal-judge']) },
  hookTriggers: { decide: mocks.decide }
}))
vi.mock('../notificationService', () => ({ notifyGoalEnded: () => {} }))
vi.mock('../sessionHost', () => ({
  getSessionHost: () => ({
    peek: async (id: string) => mocks.host.current!.peek(id),
    get: (id: string) => mocks.host.current!.get(id)
  })
}))
vi.mock('../sessionService', () => ({
  sessionService: {
    ensureAgentSession: (id: string) => mocks.ensure(id),
    resolveAgentProfileName: () => 'work'
  }
}))
vi.mock('../sessionSignalSeams', () => ({ sessionSignalsReady: async () => {} }))
vi.mock('../toolContext', () => ({
  resolveProjectConfig: () => ({ workingDirectory: mocks.workingDirectory.current })
}))
vi.mock('../taskRegistry', () => ({ taskRegistry: { runningCount: () => 0 } }))
vi.mock('../transcriptSource', () => ({ readSessionTranscript: mocks.transcript }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: mocks.broadcast } }))
vi.mock('../../i18n', () => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    vars === undefined ? key : `${key}|${JSON.stringify(vars)}`
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: mocks.warn, error: () => {}, debug: () => {} })
}))

import { GoalService, specPathNamedIn } from '../goalService'

registerHostCleanup()

// ─────────────────────────── 夹具 ───────────────────────────

const SID = 'spec-s1'
const LOCAL: InputOrigin = { kind: 'local' }

let t: TestHost
let service: GoalService
let workDir: string
const facades = new Map<string, Facade>()

async function setup(): Promise<{ session: DurableSession }> {
  t = await makeHost({ noticeCoalesceMs: 20 })
  mocks.host.current = t.host
  service = new GoalService({
    now: () => Date.now(),
    checkinFirstMs: 60_000
  })
  const session = await t.open(SID)
  await primeRoot(session)
  return { session }
}

function facadeOf(session: DurableSession): Facade {
  let facade = facades.get(session.sessionId)
  if (facade === undefined || facade.durable !== session) {
    facade = {
      durable: session,
      maskTexts: async (texts) => [...texts],
      admitSteer: vi.fn(async (text: string, options: Record<string, unknown>) =>
        session.steer(text, options as never)
      )
    }
    facades.set(session.sessionId, facade)
  }
  return facade
}

beforeEach(() => {
  facades.clear()
  workDir = mkdtempSync(join(tmpdir(), 'goal-spec-'))
  mocks.workingDirectory.current = workDir
  mocks.settings.clear()
  mocks.rows.clear()
  mocks.rows.set(SID, { parentId: null, settings: {}, title: 'Spec session' })
  mocks.decide.mockReset()
  mocks.decide.mockResolvedValue(null)
  mocks.broadcast.mockReset()
  mocks.warn.mockReset()
  mocks.ensure.mockImplementation(async (id: string) => facadeOf(await t.host.open(id)))
  mocks.transcript.mockImplementation(async (id: string) => {
    const session = await t.host.peek(id)
    return session === undefined ? [] : (await readTranscriptDigest(session)).items
  })
})

afterEach(() => {
  service?.dispose()
  rmSync(workDir, { recursive: true, force: true })
})

async function drain(sessionId = SID): Promise<void> {
  const serial = (service as unknown as { serial: Map<string, Promise<unknown>> }).serial
  for (let n = 0; n < 50; n++) {
    const pending = serial.get(sessionId)
    if (pending === undefined) return
    await pending
  }
}

async function endRun(session: DurableSession): Promise<void> {
  await waitFor(() => !session.isBusy(), 5000, 'session idle before run end')
  service.onRootRunEnded(session.sessionId, 'ok')
  await drain(session.sessionId)
}

async function goalOf(session: DurableSession): Promise<GoalRecord | undefined> {
  return readGoal(session.harness)
}

/**
 * 设定并等干活的那一轮跑完（`reply` = 那一轮的回复）。回复在模型被请求的那一刻才盖时间戳：faux 的消息带着构造时的
 * 时间，而宿主只看设定之后（`createdAt >= setAt`）的回复 —— 排在设定之前构造的回复在负载下会早一毫秒，被当成旧回复
 */
async function setAndRun(
  session: DurableSession,
  objective: string,
  reply: AssistantMessage = answer('working on it')
): Promise<GoalRecord> {
  const before = t.kit.callCount
  t.kit.queue(() => ({ ...reply, timestamp: Date.now() }))
  expect(await service.act(SID, { type: 'set', objective }, LOCAL)).toEqual({ ok: true })
  await waitFor(() => t.kit.callCount > before && !session.isBusy(), 5000, 'set run')
  return (await goalOf(session))!
}

function views(): Array<GoalView | null> {
  return mocks.broadcast.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === 'goal' && event.sessionId === SID)
    .map((event) => event.goal as GoalView | null)
}

function payloads(): GoalCheckPayload[] {
  return mocks.decide.mock.calls.map(([, payload]) => payload as GoalCheckPayload)
}

function notMetOnce(reason = 'not yet'): void {
  mocks.decide.mockResolvedValueOnce({
    result: { verdict: 'not_met', reason },
    hook: 'goal-check'
  })
}

function writeSpec(relativePath: string, body = '# Done when\n- tests pass\n'): string {
  const absolute = join(workDir, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, body)
  return absolute
}

// ─────────────────────────── 用例 ───────────────────────────

describe('goal spec · the set note asks the main agent to shape first', () => {
  it('GS-1 只发一条设定消息：原文 + <goal-set> 说明（整理规格的做法 + Acceptance spec 约定），只有干活的一轮；视图没有 planning', async () => {
    const { session } = await setup()
    const goal = await setAndRun(session, 'Make login robust')
    const facade = facades.get(SID)!
    expect(facade.admitSteer).toHaveBeenCalledTimes(1)
    const text = facade.admitSteer.mock.calls[0]![0] as string
    expect(text).toBe(
      `Make login robust\n\n<goal-set id="${goal.id}">${GOAL_SET_NOTE_TEXT}</goal-set>`
    )
    // 设定之后只有干活的这一轮（没有派别的 agent）
    expect(t.kit.callCount).toBe(1)
    expect(goal.specPath).toBeUndefined()
    for (const view of views()) expect(view).not.toHaveProperty('planning')

    // 模型面向的说明：第一轮先整理、只问用户自己才能定的事、写 md、一行 Acceptance spec、检查员的事实
    const note = GOAL_SET_NOTE_TEXT
    for (const piece of [
      'a separate checker',
      'your own statement that it is met is not evidence',
      'In this first turn, before you do the work',
      'Read what the goal touches',
      'already states its end state and how to check it',
      'write no spec',
      'ask with `ask`',
      'at most three questions',
      'recommended one first',
      'outputs or formats, defaults, flags, or whether old behaviour stays available',
      'Do not settle these as assumptions',
      'decide yourself and note it as an assumption',
      'Markdown file in the working directory',
      'under a name of your choosing',
      'each with how to check it',
      "the user's answers",
      'what must not change',
      'the checker does not see it',
      'exactly: Acceptance spec: <path>',
      'Then do the work.'
    ]) {
      expect(note, piece).toContain(piece)
    }
  })
})

describe('goal spec · picked up from the reply', () => {
  it('GS-2 第一轮回复里的相对路径（反引号）→ 绝对 specPath 进记录与广播 → 判定 payload → 续跑通知 → 恢复通知', async () => {
    const { session } = await setup()
    const absolute = writeSpec('docs/goal-spec.md')
    const notify = vi.spyOn(session, 'notify')
    await setAndRun(
      session,
      'Make login robust',
      answer('I wrote the spec.\n\nAcceptance spec: `docs/goal-spec.md`\n\nNow the work.')
    )
    notMetOnce('spec item 2 open')
    t.kit.queue(answer('continuing'))
    await endRun(session)

    const goal = (await goalOf(session))!
    expect(goal.specPath).toBe(absolute)
    expect(views().some((view) => view?.specPath === absolute)).toBe(true)
    expect(payloads()).toHaveLength(1)
    expect(payloads()[0]!.goal.specPath).toBe(absolute)

    const cont = notify.mock.calls.find(([, options]) => options?.kind === 'goal-continue')!
    expect(cont[0]).toContain(
      `Acceptance spec (you wrote it at the start, with the user's answers): ${absolute}`
    )
    await waitFor(() => t.kit.callCount === 2 && !session.isBusy(), 5000, 'continuation run')

    // 暂停再恢复：恢复通知也点名它
    expect(await service.act(SID, { type: 'pause' }, LOCAL)).toEqual({ ok: true })
    t.kit.queue(answer('resumed'))
    expect(await service.act(SID, { type: 'resume' }, LOCAL)).toEqual({ ok: true })
    const resumed = notify.mock.calls.filter(([, options]) => options?.kind === 'goal-continue')
    expect(resumed.at(-1)![0]).toContain('The user resumed this goal')
    expect(resumed.at(-1)![0]).toContain(absolute)
    await waitFor(() => t.kit.callCount === 3, 5000, 'resumed run')
  })

  it('GS-3 绝对路径（标签加粗、路径加粗）照收；工作目录外也行，文件在就行', async () => {
    const { session } = await setup()
    const absolute = writeSpec('nested/acceptance.md')
    mocks.workingDirectory.current = join(workDir, 'elsewhere')
    await setAndRun(
      session,
      'Ship the importer',
      answer(`Spec is ready.\n**Acceptance spec:** **${absolute}**`)
    )
    await endRun(session)
    expect((await goalOf(session))!.specPath).toBe(absolute)
    expect(payloads()[0]!.goal.specPath).toBe(absolute)

    // `..` 归一：记下的是规范的绝对路径
    const dotted = join(workDir, 'nested', '..', 'nested', 'acceptance.md')
    await setAndRun(session, 'Dotted path', answer(`Acceptance spec: ${dotted}`))
    await endRun(session)
    expect((await goalOf(session))!.specPath).toBe(absolute)
  })

  it('GS-4 认最后一行：前面那行被后面的盖过；最后一行点名的文件不在 → 没有规格，不回头找前面的', async () => {
    const { session } = await setup()
    writeSpec('docs/first.md')
    const second = writeSpec('docs/second.md')
    await setAndRun(
      session,
      'Two specs',
      answer(
        'Acceptance spec: docs/first.md\n\nOn second thought:\n\n- Acceptance spec: docs/second.md'
      )
    )
    await endRun(session)
    expect((await goalOf(session))!.specPath).toBe(second)

    // 同一会话换个新目标（旧回复在设定之前，不算）：最后一行点名的不在 → 没有规格
    await setAndRun(
      session,
      'Last one missing',
      answer('Acceptance spec: docs/first.md\nAcceptance spec: docs/missing.md')
    )
    await endRun(session)
    expect((await goalOf(session))!.specPath).toBeUndefined()
    expect(mocks.warn.mock.calls.some(([m]) => m.includes(join(workDir, 'docs/missing.md')))).toBe(
      true
    )
  })

  it('GS-5 没有这一行 / 文件不在 / 点名的是目录 → 没有规格，判定照常（payload 没有 specPath）', async () => {
    const replies = [
      'Done with the first pass. The spec lives in docs/spec.md.',
      'Acceptance spec: docs/never-written.md',
      'Acceptance spec: docs'
    ]
    mkdirSync(join(workDir, 'docs'), { recursive: true })
    const { session } = await setup()
    for (const [index, reply] of replies.entries()) {
      mocks.decide.mockClear()
      await setAndRun(session, `goal ${index}`, answer(reply))
      await endRun(session)
      const goal = (await goalOf(session))!
      expect(goal.specPath, `case ${index}`).toBeUndefined()
      expect(mocks.decide, `case ${index}`).toHaveBeenCalledTimes(1)
      expect(payloads()[0]!.goal, `case ${index}`).not.toHaveProperty('specPath')
      expect(payloads()[0]!.goal.objective).toBe(`goal ${index}`)
    }
  })

  it('GS-6 第一轮没写、续跑那一轮写了 → 第二次运行结束时记下；第二次判定才带它', async () => {
    const { session } = await setup()
    await setAndRun(session, 'Late spec', answer('Asked nothing yet; reading the code.'))
    notMetOnce('no spec, no work')
    const absolute = writeSpec('SPEC.md')
    t.kit.queue(answer('Wrote it.\nAcceptance spec: SPEC.md'))
    await endRun(session)
    expect((await goalOf(session))!.specPath).toBeUndefined()
    expect(payloads()[0]!.goal).not.toHaveProperty('specPath')

    await waitFor(() => t.kit.callCount === 2, 5000, 'continuation run')
    await endRun(session)
    expect((await goalOf(session))!.specPath).toBe(absolute)
    expect(payloads()).toHaveLength(2)
    expect(payloads()[1]!.goal.specPath).toBe(absolute)
  })

  it('GS-7 记下之后不再自动改：之后的回复点名别的文件也不换', async () => {
    const { session } = await setup()
    const first = writeSpec('spec-a.md')
    writeSpec('spec-b.md')
    await setAndRun(session, 'Stable spec', answer('Acceptance spec: spec-a.md'))
    notMetOnce()
    t.kit.queue(answer('Moved things around.\nAcceptance spec: spec-b.md'))
    await endRun(session)
    expect((await goalOf(session))!.specPath).toBe(first)
    await waitFor(() => t.kit.callCount === 2, 5000, 'continuation run')
    await endRun(session)
    expect((await goalOf(session))!.specPath).toBe(first)
    expect(payloads()[1]!.goal.specPath).toBe(first)
  })

  it('GS-8 只看设定之后的回复：换新目标后，旧目标那一轮的那一行不算', async () => {
    const { session } = await setup()
    const old = writeSpec('old-spec.md')
    await setAndRun(session, 'Old goal', answer('Acceptance spec: old-spec.md'))
    await endRun(session)
    expect((await goalOf(session))!.specPath).toBe(old)
    await sleep(5)
    const fresh = await setAndRun(
      session,
      'New goal',
      answer('No spec needed: the goal is checkable.')
    )
    expect(fresh.objective).toBe('New goal')
    expect(fresh.specPath).toBeUndefined()
    await endRun(session)
    expect((await goalOf(session))!.specPath).toBeUndefined()
    expect(payloads().at(-1)!.goal).not.toHaveProperty('specPath')
  })
})

describe('goal spec · specPathNamedIn', () => {
  it('GS-9 逐个正文块看（块之间没有换行也认得出），只看助手消息、只看 since 之后；没有 → undefined', async () => {
    const { session } = await setup()
    writeSpec('blocks.md')
    await setAndRun(
      session,
      'Blocks',
      assistantWith([
        fauxText('First block, no newline at its end.'),
        fauxText('Acceptance spec: blocks.md')
      ])
    )
    const { messages } = await session.viewSnapshot()
    const goal = (await goalOf(session))!
    const reply = messages.find((m) => m.role === 'assistant')!
    // 拼起来的 content 里这一行不在行首：只看 content 就认不出
    expect(reply.content).not.toMatch(/^Acceptance spec/m)
    expect(specPathNamedIn(messages, goal.setAt)).toBe('blocks.md')
    expect(specPathNamedIn(messages, Date.now() + 60_000)).toBeUndefined()
    // 用户消息里的同一行不算（设定消息的说明里就有这个约定）
    const userOnly = messages.filter((m) => m.role === 'user') as ChatMessage[]
    expect(userOnly.length).toBeGreaterThan(0)
    expect(specPathNamedIn(userOnly, 0)).toBeUndefined()
    await endRun(session)
    expect((await goalOf(session))!.specPath).toBe(join(workDir, 'blocks.md'))
  })
})
