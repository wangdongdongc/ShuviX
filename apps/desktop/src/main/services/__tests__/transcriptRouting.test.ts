/**
 * P2-14 · 转写读口的路由（`transcriptSource`）—— 两个消费者一起看。
 *
 *   P2-14-34 旧格式行、没有 storageKind 的行、查不到的行：照旧 messageService，SessionHost 一个方法都不碰；
 *            旧会话的起标题事实照旧把系统写的 user（后台通知）算一条 —— PIN-02 只管 durable
 *   P2-14-35 不认识的存储类型：哪个读者都不跑（审查只剩卡片反馈、事实为零）
 *   P2-14-37 源码守卫（TS AST）：permissionReview / sessionTriggerFacts / transcriptSource 从不调
 *            `getSessionHost().open`、`ensureAgentSession`、`openSessionStorage`
 *
 * 替身：hookService / messageService（交出 v3 文本的冻结投影）/ sessionRecords / settingsService / logger /
 * frontend/core / sessionHost（三个方法都是 spy）/ i18n。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearReviewState,
  clearSessionDecisions,
  harnessV3TextToChatMessages,
  noteHumanFeedback
} from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import {
  assistant,
  bg,
  fb,
  legacyJsonl,
  makeEvent,
  notice,
  user,
  type TwinStep
} from './support/transcriptTwins'

const mocks = vi.hoisted(() => ({
  pick: vi.fn<(id: string, fields: string[]) => unknown>(),
  listBySession: vi.fn<(id: string) => Promise<ChatMessage[]>>(),
  peek: vi.fn(),
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

const rows = new Map<string, Record<string, unknown>>()
const legacyTexts = new Map<string, string>()
const used = ['rt-v3', 'rt-nokind', 'rt-missing', 'rt-future']

beforeEach(() => {
  vi.resetAllMocks()
  mocks.pick.mockImplementation((id) => rows.get(id))
  mocks.listBySession.mockImplementation(async (id) => {
    const textValue = legacyTexts.get(id)
    return textValue === undefined ? [] : harnessV3TextToChatMessages(textValue, id).messages
  })
})

afterEach(() => {
  vi.useRealTimers()
  for (const id of used) {
    clearReviewState(id)
    clearSessionDecisions(id)
  }
  rows.clear()
  legacyTexts.clear()
})

function expectHostUntouched(): void {
  expect(mocks.peek).not.toHaveBeenCalled()
  expect(mocks.get).not.toHaveBeenCalled()
  expect(mocks.open).not.toHaveBeenCalled()
}

/** 旧会话：[a, A, 后台通知（系统写的 user）, ack, b, B] */
const WITH_NOTICE: TwinStep[] = [
  user(1000, 'a'),
  assistant(1100, 'A'),
  notice(1200, bg('t', 'y')),
  assistant(1300, 'ack'),
  user(1400, 'b'),
  assistant(1500, 'B')
]

describe('P2-14-34 legacy rows keep the messageService path', () => {
  it.each([
    ['rt-v3', { storageKind: 'harness-v3-jsonl' }],
    ['rt-nokind', {}]
  ])(
    '%s: both consumers read messageService exactly as before; the legacy titler still counts the notice user',
    async (sid, kind) => {
      rows.set(sid, { parentId: null, title: 'T', settings: { titleOrigin: 'auto' }, ...kind })
      legacyTexts.set(sid, legacyJsonl(sid, WITH_NOTICE))

      const payload = await buildPermissionRequestPayload(makeEvent(sid))
      expect(payload.userMessages).toEqual(['a', 'b'])
      expect(await buildTurnCompletedFacts(sid)).toMatchObject({
        turnCount: 3,
        textMessageCount: 6,
        recentText: `User: a\nAssistant: A\nUser: ${bg('t', 'y')}\nAssistant: ack\nUser: b\nAssistant: B`
      })
      expect(mocks.listBySession.mock.calls).toEqual([[sid], [sid]])
      expectHostUntouched()
    }
  )

  it('a missing row: the reviewer reads messageService (legacy, as today); the titler answers null without reading', async () => {
    const payload = await buildPermissionRequestPayload(makeEvent('rt-missing'))
    expect(payload.userMessages).toEqual([])
    expect(mocks.listBySession.mock.calls).toEqual([['rt-missing']])
    expect(await buildTurnCompletedFacts('rt-missing')).toBeNull()
    expect(mocks.listBySession).toHaveBeenCalledTimes(1)
    expectHostUntouched()
  })
})

describe('P2-14-35 an unknown storage kind reads nothing', () => {
  it('durable-sqlite-9: feedback only, zero facts, no reader runs', async () => {
    rows.set('rt-future', {
      parentId: null,
      title: 'Future',
      settings: null,
      storageKind: 'durable-sqlite-9'
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1000)
    noteHumanFeedback('rt-future', 'rm -rf build', 'only build')
    vi.useRealTimers()

    const payload = await buildPermissionRequestPayload(makeEvent('rt-future'))
    expect(payload.userMessages).toEqual([fb('rm -rf build', 'only build')])
    expect(payload.delegatedTasks).toEqual([])
    expect(await buildTurnCompletedFacts('rt-future')).toEqual({
      title: 'Future',
      isDefaultTitle: false,
      titleAutoGenerated: false,
      turnCount: 0,
      textMessageCount: 0,
      recentText: ''
    })
    expect(mocks.listBySession).not.toHaveBeenCalled()
    expectHostUntouched()
  })
})

describe('P2-14-37 source guard: the transcript readers never open or create a session', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const FILES = ['permissionReview.ts', 'sessionTriggerFacts.ts', 'transcriptSource.ts']
  const FORBIDDEN = new Set(['ensureAgentSession', 'openSessionStorage'])

  /** 违规点：`getSessionHost()` 上取了 peek 以外的成员、调了 / 引用了禁用的名字 */
  function violations(fileName: string, source: string): string[] {
    const file = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    const found: string[] = []
    const isHostCall = (node: ts.Node): boolean =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'getSessionHost'
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        isHostCall(node.expression) &&
        node.name.text !== 'peek'
      ) {
        found.push(`getSessionHost().${node.name.text}`)
      }
      // 任何位置的标识符（调用、成员名、import 绑定）都算：`x.ensureAgentSession` 的成员名也是标识符
      if (ts.isIdentifier(node) && FORBIDDEN.has(node.text)) found.push(node.text)
      ts.forEachChild(node, visit)
    }
    visit(file)
    return found
  }

  it('the guard itself flags each forbidden shape', () => {
    expect(violations('x.ts', 'getSessionHost().open("s")')).toEqual(['getSessionHost().open'])
    expect(violations('x.ts', 'getSessionHost().get("s")')).toEqual(['getSessionHost().get'])
    expect(violations('x.ts', 'sessionService.ensureAgentSession("s")')).toEqual([
      'ensureAgentSession'
    ])
    expect(violations('x.ts', 'import { openSessionStorage } from "./sessionStorage"')).toEqual([
      'openSessionStorage'
    ])
    expect(violations('x.ts', 'await getSessionHost().peek("s")')).toEqual([])
  })

  it.each(FILES)(
    '%s: only getSessionHost().peek, no ensureAgentSession, no openSessionStorage',
    (name) => {
      const source = readFileSync(resolve(HERE, '..', name), 'utf8')
      expect(violations(name, source)).toEqual([])
    }
  )

  it('the routing helper does reach the host through peek', () => {
    const source = readFileSync(resolve(HERE, '../transcriptSource.ts'), 'utf8')
    expect(source).toContain('getSessionHost().peek(')
  })
})
