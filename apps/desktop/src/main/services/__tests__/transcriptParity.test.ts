/**
 * P2-14 · 上限与截断的孪生用例：同一份脚本建成旧格式（v3 JSONL → 冻结投影，经 messageService）与 durable
 * （MemoryStorage 会话 → 转写摘要，经 SessionHost.peek）两条会话，审查 payload（去掉 sessionId）与起标题的
 * 事实必须逐字相等，并且等于这里写死的字面量。
 *
 *   P2-14-18 审查孪生 T1（顶层）：思考 / 正文 / 通知 / 错误 / payload 不进；trim → clip；首条 + 尾部
 *   P2-14-19 审查孪生 T2（子会话）：顶层的人话 + 子会话的 ask 回答与卡片反馈；子会话的「用户消息」进 delegatedTasks
 *   P2-14-20 起标题孪生 T3：计数与 recentText；压缩摘要算一条 assistant、排第一
 *   P2-14-21 durable 路径上的边界：先 trim 再 clip、clip 的格式、组合串整体 clip、recentText 的 1000 字尾
 *
 * 替身：hookService / messageService（交出 L 那份的冻结投影）/ sessionRecords / settingsService / logger /
 * frontend/core / sessionHost（`peek` 交出真 MemoryStorage 会话）/ i18n。agent-runtime 用真的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearReviewState,
  clearSessionDecisions,
  harnessV3TextToChatMessages,
  noteHumanFeedback,
  type PermissionRequestPayload,
  type SessionHost
} from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import {
  IMAGE,
  ans,
  assistant,
  bg,
  call,
  compaction,
  fb,
  legacyJsonl,
  makeEvent,
  memoryHost,
  notice,
  result,
  text,
  thinking,
  user,
  writeDurable,
  type TwinStep
} from './support/transcriptTwins'

interface Row {
  parentId: string | null
  storageKind: string
  title: string
  settings: Record<string, unknown> | null
}

const mocks = vi.hoisted(() => ({
  pick: vi.fn<(id: string, fields: string[]) => unknown>(),
  listBySession: vi.fn<(id: string) => Promise<ChatMessage[]>>(),
  peek: vi.fn<(id: string) => Promise<unknown>>(),
  open: vi.fn(),
  get: vi.fn()
}))

vi.mock('../hookService', () => ({
  hookService: { agentsBoundTo: () => new Set(['permission-reviewer']) },
  hookTriggers: { decide: async () => null }
}))
vi.mock('../messageService', () => ({ messageService: { listBySession: mocks.listBySession } }))
vi.mock('../sessionRecords', () => ({ sessionRecords: { pick: mocks.pick } }))
vi.mock('../settingsService', () => ({ settingsService: { get: () => undefined } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: () => {} } }))
vi.mock('../sessionHost', () => ({
  getSessionHost: () => ({ peek: mocks.peek, get: mocks.get, open: mocks.open })
}))
vi.mock('../../i18n', () => ({
  t: (key: string) => (key === 'agent.defaultTitle' ? 'New Chat' : key)
}))

import { buildPermissionRequestPayload } from '../permissionReview'
import { buildTurnCompletedFacts } from '../sessionTriggerFacts'

const rows = new Map<string, Row>()
const legacyTexts = new Map<string, string>()
const used = new Set<string>()
let host: SessionHost

beforeEach(() => {
  vi.resetAllMocks()
  ;({ host } = memoryHost())
  mocks.pick.mockImplementation((id) => rows.get(id))
  mocks.listBySession.mockImplementation(async (id) => {
    const textValue = legacyTexts.get(id)
    return textValue === undefined ? [] : harnessV3TextToChatMessages(textValue, id).messages
  })
  mocks.peek.mockImplementation((id) => host.peek(id))
})

afterEach(async () => {
  vi.useRealTimers()
  await host.closeAll()
  for (const id of used) {
    clearReviewState(id)
    clearSessionDecisions(id)
  }
  used.clear()
  rows.clear()
  legacyTexts.clear()
})

interface Twin {
  L: string
  D: string
}

/** 一份脚本建成两条会话：L（旧格式行 + v3 文本）与 D（durable 行 + MemoryStorage 会话） */
async function twin(name: string, steps: readonly TwinStep[], parent?: Twin): Promise<Twin> {
  const pair = { L: `L-${name}`, D: `D-${name}` }
  const row = { title: 'New Chat', settings: { titleOrigin: 'auto' } }
  rows.set(pair.L, { ...row, parentId: parent?.L ?? null, storageKind: 'harness-v3-jsonl' })
  rows.set(pair.D, { ...row, parentId: parent?.D ?? null, storageKind: 'durable-sqlite-1' })
  legacyTexts.set(pair.L, legacyJsonl(pair.L, steps))
  await writeDurable(await host.open(pair.D), steps)
  used.add(pair.L).add(pair.D)
  return pair
}

/** 往两条会话里续写同一段脚本 */
async function extend(
  pair: Twin,
  all: readonly TwinStep[],
  more: readonly TwinStep[]
): Promise<void> {
  legacyTexts.set(pair.L, legacyJsonl(pair.L, [...all, ...more]))
  await writeDurable((await host.peek(pair.D))!, more)
}

/** 两边在同一时刻记下同一条卡片反馈（noteHumanFeedback 用 Date.now() 盖时间戳） */
function feedbackAt(ts: number, pair: Twin, target: string, textValue: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ts)
  noteHumanFeedback(pair.L, target, textValue)
  noteHumanFeedback(pair.D, target, textValue)
  vi.useRealTimers()
}

/** 两边的审查 payload（去掉 sessionId）逐字相等；交回 D 那份 */
async function twinPayload(pair: Twin): Promise<Omit<PermissionRequestPayload, 'sessionId'>> {
  const { sessionId: legacyId, ...legacy } = await buildPermissionRequestPayload(makeEvent(pair.L))
  const { sessionId: durableId, ...durable } = await buildPermissionRequestPayload(
    makeEvent(pair.D)
  )
  expect([legacyId, durableId]).toEqual([pair.L, pair.D])
  expect(durable).toEqual(legacy)
  return durable
}

async function twinFacts(pair: Twin): Promise<unknown> {
  const legacy = await buildTurnCompletedFacts(pair.L)
  const durable = await buildTurnCompletedFacts(pair.D)
  expect(durable).toEqual(legacy)
  return durable
}

const DISPLAY_K1 = {
  content: 'run {{shuvixInlineToken:k1}} please',
  tokens: {
    k1: { type: 'cmd' as const, id: 'deploy', displayText: '/deploy', payload: 'PAYLOAD-K1' }
  }
}

describe('P2-14-18 reviewer twin T1 (top level)', () => {
  const T1: TwinStep[] = [
    user(1000, '  deploy the staging stack  '),
    assistant(
      1500,
      [thinking('THINK-1'), text('Sure.'), call('ask', { question: 'Which region?' }, 'c1')],
      {
        stopReason: 'toolUse'
      }
    ),
    result(1510, 'c1', 'User selected: eu-west-1'),
    notice(2000, bg('n1', 'NOTICE-1')),
    user(2500, '<sub-session id="s" status="done">x</sub-session>'),
    user(3000, 'run PAYLOAD-K1 please', DISPLAY_K1),
    assistant(3500, [text('ok'), call('ask', { question: 'Force?' }, 'c2')], {
      stopReason: 'toolUse'
    }),
    result(3510, 'c2', 'Aborted', { isError: true }),
    assistant(3700, [], { stopReason: 'error', errorMessage: 'ERR-1' }),
    user(4000, 'y'.repeat(1500)),
    user(4100, 'x'.repeat(1600)),
    user(4200, 'm1'),
    user(4300, 'm2')
  ]

  it('T1: the human words only, trimmed then clipped, merged with the card feedback by time', async () => {
    const pair = await twin('t1', T1)
    feedbackAt(4050, pair, 'rm -rf build', 'only tmp')
    const payload = await twinPayload(pair)
    expect(payload.userMessages).toEqual([
      'deploy the staging stack',
      ans('Which region?', 'User selected: eu-west-1'),
      'run {{shuvixInlineToken:k1}} please',
      'y'.repeat(1500),
      fb('rm -rf build', 'only tmp'),
      `${'x'.repeat(1500)}… [100 more chars]`,
      'm1',
      'm2'
    ])
    expect(payload.delegatedTasks).toEqual([])
    const serialized = JSON.stringify(payload)
    for (const marker of ['PAYLOAD-K1', 'THINK-1', 'Sure.', 'NOTICE-1', 'ERR-1']) {
      expect(serialized).not.toContain(marker)
    }
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('T1b: two more messages → the first, "(1 earlier messages omitted)", then the last eight', async () => {
    const pair = await twin('t1b', T1)
    feedbackAt(4050, pair, 'rm -rf build', 'only tmp')
    await extend(pair, T1, [user(4400, 'm3'), user(4500, 'm4')])
    expect((await twinPayload(pair)).userMessages).toEqual([
      'deploy the staging stack',
      '(1 earlier messages omitted)',
      'run {{shuvixInlineToken:k1}} please',
      'y'.repeat(1500),
      fb('rm -rf build', 'only tmp'),
      `${'x'.repeat(1500)}… [100 more chars]`,
      'm1',
      'm2',
      'm3',
      'm4'
    ])
  })
})

describe('P2-14-19 reviewer twin T2 (sub-session)', () => {
  it('T2: the top session’s human words + the child’s ask answer and card feedback; the child’s prompts are delegated tasks', async () => {
    const top = await twin('top', [user(1000, 'top task')])
    const childSteps: TwinStep[] = []
    for (let n = 1; n <= 10; n++) {
      childSteps.push(user(1000 + n * 100, `t${n}`))
      if (n === 5) {
        childSteps.push(
          assistant(1550, [call('ask', { question: 'Proceed?' }, 'p1')], { stopReason: 'toolUse' }),
          result(1560, 'p1', 'User selected: yes')
        )
      }
      if (n === 6) childSteps.push(notice(1650, bg('n2', 'CHILD-NOTICE')))
    }
    const child = await twin('child', childSteps, top)
    feedbackAt(1700, child, 'git push', 'not to main')

    const payload = await twinPayload(child)
    expect(payload.userMessages).toEqual([
      'top task',
      ans('Proceed?', 'User selected: yes'),
      fb('git push', 'not to main')
    ])
    expect(payload.delegatedTasks).toEqual([
      't1',
      '(1 earlier messages omitted)',
      't3',
      't4',
      't5',
      't6',
      't7',
      't8',
      't9',
      't10'
    ])
    expect(JSON.stringify(payload)).not.toContain('CHILD-NOTICE')
    expect(mocks.peek.mock.calls.map(([id]) => id).sort()).toEqual([child.D, top.D].sort())
  })
})

describe('P2-14-20 titler twin T3', () => {
  const T3: TwinStep[] = [
    user(1000, '  first  '),
    assistant(1100, [thinking('hmm'), text('r1')]),
    assistant(1200, [call('bash', { command: 'ls' }, 'b1')], { stopReason: 'toolUse' }),
    result(1210, 'b1', 'file.txt', { toolName: 'bash' }),
    assistant(1300, [], { stopReason: 'error', errorMessage: 'boom' }),
    user(1400, [text('second'), IMAGE]),
    assistant(1500, 'r2')
  ]

  it('T3a: counts and recentText (thinking, tool-only and error entries do not count)', async () => {
    const pair = await twin('t3a', T3)
    expect(await twinFacts(pair)).toEqual({
      title: 'New Chat',
      isDefaultTitle: true,
      titleAutoGenerated: true,
      turnCount: 2,
      textMessageCount: 4,
      recentText: 'User:   first  \nAssistant: r1\nUser: second\nAssistant: r2'
    })
  })

  it('T3b: a compaction kept from "second": the summary counts as one assistant message, listed first', async () => {
    const steps = [...T3, compaction(1600, 'SUM', 5), user(1700, 'third'), assistant(1800, 'r3')]
    const pair = await twin('t3b', steps)
    expect(await twinFacts(pair)).toMatchObject({
      turnCount: 2,
      textMessageCount: 5,
      recentText: 'Assistant: SUM\nUser: second\nAssistant: r2\nUser: third\nAssistant: r3'
    })
  })
})

describe('P2-14-21 boundaries on the durable path', () => {
  it('trim comes before clip; 1501 chars clip with "… [1 more chars]"; an over-long composed answer is clipped as a whole', async () => {
    const question = 'q'.repeat(1400)
    const answer = 'a'.repeat(200)
    const pair = await twin('bounds', [
      user(1000, ` ${'a'.repeat(1500)} `),
      user(1100, 'b'.repeat(1501)),
      assistant(1200, [call('ask', { question }, 'long')], { stopReason: 'toolUse' }),
      result(1210, 'long', answer)
    ])
    const composed = ans(question, answer)
    expect(composed.length).toBeGreaterThan(1500)
    expect((await twinPayload(pair)).userMessages).toEqual([
      'a'.repeat(1500),
      `${'b'.repeat(1500)}… [1 more chars]`,
      `${composed.slice(0, 1500)}… [${composed.length - 1500} more chars]`
    ])
  })

  it('titler: the recentText tail is 1000 chars and ends with the last message', async () => {
    const pair = await twin('tail', [user(1000, 'x'.repeat(2000)), assistant(1100, 'last')])
    const facts = (await twinFacts(pair)) as { recentText: string }
    expect(facts.recentText).toHaveLength(1000)
    expect(facts.recentText.endsWith('Assistant: last')).toBe(true)
  })
})
