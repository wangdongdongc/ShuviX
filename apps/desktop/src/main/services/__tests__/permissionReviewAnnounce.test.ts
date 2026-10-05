/**
 * 工具卡上的「审查中」—— `reviewPermissionRequest` 在交给判定型 hook 之前与之后各广播一次
 * `tool_review`（ChatToolReviewEvent），按 toolCallId 更新那张卡。
 *
 * 钉的是这一对广播的纪律：
 *   - 开始（true）早于 decide 被调用，落定（false）不论结论如何、出错与否都发，且恰成一对；
 *   - 没有 hook 绑在 `permission.request` 上、没有 toolCallId、或根本不去问审查（关了 / 非 agent 主体 /
 *     审查员自己要权限）时一次都不发 —— 否则卡片会闪一下「审查中」；
 *   - 子会话的广播落在子会话自己的 id 上（卡片在那里），不是顶层会话。
 *
 * 替身：hookService / messageService / sessionRecords / settingsService / logger / frontend/core / sessionHost
 * （会话行不带 storageKind = 旧格式路径，转写经 messageService；碰到 SessionHost 即路由错了）；
 * @shuvix/agent-runtime 用真的（决策日志与卡片反馈是进程级 Map —— 每条用例用自己的会话 id，afterEach 清掉）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearReviewState,
  clearSessionDecisions,
  type PermissionRequestEvent,
  type PermissionRequestPayload,
  type SecuritySubject
} from '@shuvix/agent-runtime'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { PermissionVerdict } from '@shuvix/chat-protocol/types/permissionReview'

type DecideResult = { result: PermissionVerdict; hook: string } | null

const mocks = vi.hoisted(() => ({
  agentsBoundTo: vi.fn<(trigger: string) => Set<string>>(),
  decide:
    vi.fn<
      (
        id: string,
        payload: PermissionRequestPayload,
        opts?: { signal?: AbortSignal }
      ) => Promise<DecideResult>
    >(),
  listBySession: vi.fn<(sessionId: string) => Promise<ChatMessage[]>>(),
  pick: vi.fn<(id: string, fields: string[]) => { parentId: string | null } | undefined>(),
  settingsGet: vi.fn<(key: string) => string | undefined>(),
  broadcast: vi.fn<(event: unknown) => void>()
}))

vi.mock('../hookService', () => ({
  hookService: { agentsBoundTo: mocks.agentsBoundTo },
  hookTriggers: { decide: mocks.decide }
}))
vi.mock('../messageService', () => ({
  messageService: { listBySession: mocks.listBySession }
}))
// 这里的会话行都不带 storageKind（= 旧格式）：转写走 messageService。durable 路径另有用例
// （permissionReviewDurable / sessionTriggerFactsDurable），这里碰到 SessionHost 就是路由错了
vi.mock('../sessionHost', () => ({
  getSessionHost: () => {
    throw new Error('legacy-path tests must not reach the session host')
  }
}))
vi.mock('../sessionRecords', () => ({ sessionRecords: { pick: mocks.pick } }))
vi.mock('../settingsService', () => ({ settingsService: { get: mocks.settingsGet } }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: mocks.broadcast } }))

import { reviewPermissionRequest } from '../permissionReview'

/** 会话行：id → parentId（null = 顶层） */
const parents = new Map<string, string | null>()
const USED = ['S', 'SUB', 'TOP']

beforeEach(() => {
  parents.clear()
  parents.set('S', null)
  mocks.agentsBoundTo.mockReset().mockReturnValue(new Set(['permission-reviewer']))
  mocks.decide.mockReset().mockResolvedValue(null)
  mocks.listBySession.mockReset().mockResolvedValue([])
  mocks.pick.mockReset().mockImplementation((id) => {
    if (!parents.has(id)) return undefined
    return { parentId: parents.get(id) ?? null }
  })
  mocks.settingsGet.mockReset().mockReturnValue(undefined)
  mocks.broadcast.mockReset()
})

afterEach(() => {
  for (const sid of USED) {
    clearReviewState(sid)
    clearSessionDecisions(sid)
  }
})

const VERDICT: PermissionVerdict = {
  decision: 'allow',
  risk: 'low',
  summary: 'Removes the build folder',
  reason: 'Ordinary work'
}

function makeEvent(
  init: { sessionId?: string; subject?: Partial<SecuritySubject>; toolCallId?: string } = {}
): PermissionRequestEvent {
  const sessionId = init.sessionId ?? 'S'
  return {
    request: {
      subject: {
        kind: 'agent',
        sessionId,
        agentKind: 'root',
        profileName: 'work',
        ...init.subject
      },
      action: 'execute',
      tool: { name: 'bash' },
      object: { type: 'command', channel: 'bash', command: 'rm -rf build' },
      environment: { host: 'desktop', platform: 'darwin', workspaceDir: '/w' }
    },
    decision: {
      effect: 'ask',
      tier: 'ask',
      matched: ['ask-on-command#0'],
      winning: 'ask-on-command#0',
      ask: { command: 'rm -rf build' }
    },
    toolCallId: init.toolCallId ?? 'tc-1',
    command: 'rm -rf build'
  }
}

const reviewEvent = (sessionId: string, reviewing: boolean, taskId?: number): unknown => ({
  type: 'tool_review',
  sessionId,
  toolCallId: 'tc-1',
  ...(taskId === undefined ? {} : { taskId }),
  reviewing
})

/** 手动落定的 decide */
function deferredDecide(): {
  resolve: (value: DecideResult) => void
  reject: (err: unknown) => void
} {
  let resolve!: (value: DecideResult) => void
  let reject!: (err: unknown) => void
  mocks.decide.mockImplementation(
    () =>
      new Promise<DecideResult>((res, rej) => {
        resolve = res
        reject = rej
      })
  )
  return {
    resolve: (value) => resolve(value),
    reject: (err) => reject(err)
  }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('reviewPermissionRequest — 「审查中」的一对广播', () => {
  it('RV-1 有 hook、有 toolCallId：恰两次，先 reviewing:true 再 reviewing:false；true 早于 decide；落定前只有 true 一次', async () => {
    const decide = deferredDecide()
    const pending = reviewPermissionRequest(makeEvent())
    await flush()

    expect(mocks.decide).toHaveBeenCalledTimes(1)
    expect(mocks.broadcast).toHaveBeenCalledTimes(1)
    expect(mocks.broadcast.mock.calls[0][0]).toStrictEqual(reviewEvent('S', true))
    expect(mocks.broadcast.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.decide.mock.invocationCallOrder[0]
    )

    decide.resolve({ result: VERDICT, hook: 'auto-review' })
    await expect(pending).resolves.toStrictEqual({ verdict: VERDICT, source: 'auto-review' })

    expect(mocks.broadcast).toHaveBeenCalledTimes(2)
    expect(mocks.broadcast.mock.calls[1][0]).toStrictEqual(reviewEvent('S', false))
  })

  it('RV-2 decide 回 null：仍 true → false，函数返回 null', async () => {
    mocks.decide.mockResolvedValue(null)
    await expect(reviewPermissionRequest(makeEvent())).resolves.toBeNull()
    expect(mocks.broadcast.mock.calls.map(([e]) => e)).toStrictEqual([
      reviewEvent('S', true),
      reviewEvent('S', false)
    ])
  })

  it('RV-3 decide 抛错：返回 null、不抛，false 照发', async () => {
    mocks.decide.mockRejectedValue(new Error('hook crashed'))
    await expect(reviewPermissionRequest(makeEvent())).resolves.toBeNull()
    expect(mocks.broadcast.mock.calls.map(([e]) => e)).toStrictEqual([
      reviewEvent('S', true),
      reviewEvent('S', false)
    ])
  })

  it('RV-4 投影 payload 时 listBySession reject：decide 不调，true / false 仍成对', async () => {
    mocks.listBySession.mockRejectedValue(new Error('tree gone'))
    await expect(reviewPermissionRequest(makeEvent())).resolves.toBeNull()
    expect(mocks.decide).not.toHaveBeenCalled()
    expect(mocks.broadcast.mock.calls.map(([e]) => e)).toStrictEqual([
      reviewEvent('S', true),
      reviewEvent('S', false)
    ])
  })

  it('RV-5 没有 hook 绑在 permission.request 上（空 Set）：一次都不发', async () => {
    mocks.agentsBoundTo.mockReturnValue(new Set())
    await reviewPermissionRequest(makeEvent())
    expect(mocks.agentsBoundTo).toHaveBeenCalledWith('permission.request')
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it("RV-6 toolCallId ''：一次都不发（decide 仍被调用）", async () => {
    mocks.decide.mockResolvedValue({ result: VERDICT, hook: 'auto-review' })
    await expect(reviewPermissionRequest(makeEvent({ toolCallId: '' }))).resolves.toStrictEqual({
      verdict: VERDICT,
      source: 'auto-review'
    })
    expect(mocks.decide).toHaveBeenCalledTimes(1)
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it.each<[string, () => PermissionRequestEvent]>([
    [
      "设置 security.autoReview = 'false'",
      () => {
        mocks.settingsGet.mockReturnValue('false')
        return makeEvent()
      }
    ],
    ["subject.kind 'user'", () => makeEvent({ subject: { kind: 'user' } })],
    [
      '派生的 permission-reviewer 自己要权限（防递归）',
      () => makeEvent({ subject: { agentKind: 'spawned', profileName: 'permission-reviewer' } })
    ]
  ])('RV-7 不去问审查的早退（%s）：一次都不发、decide 不调、返回 null', async (_label, make) => {
    await expect(reviewPermissionRequest(make())).resolves.toBeNull()
    expect(mocks.decide).not.toHaveBeenCalled()
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it("RV-8 子会话：'SUB' 的 parentId 是 'TOP'，两条广播的 sessionId 都是 'SUB'", async () => {
    parents.set('TOP', null)
    parents.set('SUB', 'TOP')
    await reviewPermissionRequest(makeEvent({ sessionId: 'SUB' }))
    // 投影确实往上找到了顶层会话（读了 TOP 的消息）—— 广播却仍落在子会话自己身上
    expect(mocks.listBySession).toHaveBeenCalledWith('TOP')
    expect(mocks.broadcast.mock.calls.map(([e]) => e)).toStrictEqual([
      reviewEvent('SUB', true),
      reviewEvent('SUB', false)
    ])
  })

  it('P2-08-31 事件带 taskId 61 → 两条广播都带 taskId（toolCallId 照旧）', async () => {
    mocks.decide.mockResolvedValue(null)
    await reviewPermissionRequest({ ...makeEvent(), toolCallId: 'call_0', taskId: 61 })
    expect(mocks.broadcast.mock.calls.map(([e]) => e)).toStrictEqual([
      { type: 'tool_review', sessionId: 'S', toolCallId: 'call_0', taskId: 61, reviewing: true },
      { type: 'tool_review', sessionId: 'S', toolCallId: 'call_0', taskId: 61, reviewing: false }
    ])
  })

  it('P2-08-31 两个并发的审查、都是 call_0、taskId 61 与 62 → 两对广播，各带各的 taskId', async () => {
    const pending: Array<(value: DecideResult) => void> = []
    mocks.decide.mockImplementation(
      () => new Promise<DecideResult>((resolve) => pending.push(resolve))
    )
    const first = reviewPermissionRequest({ ...makeEvent(), toolCallId: 'call_0', taskId: 61 })
    const second = reviewPermissionRequest({ ...makeEvent(), toolCallId: 'call_0', taskId: 62 })
    await flush()
    expect(pending).toHaveLength(2)
    pending[1]!(null)
    await second
    pending[0]!(null)
    await first
    const events = mocks.broadcast.mock.calls.map(([e]) => e as { taskId?: number; reviewing: boolean })
    expect(events.map((e) => [e.taskId, e.reviewing])).toEqual([
      [61, true],
      [62, true],
      [62, false],
      [61, false]
    ])
  })

  it('P2-08-31 没有 taskId → 事件里没有 taskId 这个键（RV-1 的形状不变）', async () => {
    mocks.decide.mockResolvedValue(null)
    await reviewPermissionRequest(makeEvent())
    for (const [event] of mocks.broadcast.mock.calls) {
      expect('taskId' in (event as object)).toBe(false)
    }
  })

  it('RV-9 传入的 signal 原样交给 decide；abort 之后 decide reject，false 照发', async () => {
    const controller = new AbortController()
    mocks.decide.mockImplementation(
      (_id, _payload, opts) =>
        new Promise<DecideResult>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )
    const pending = reviewPermissionRequest(makeEvent(), controller.signal)
    await flush()
    expect(mocks.decide.mock.calls[0][2]?.signal).toBe(controller.signal)
    expect(mocks.broadcast).toHaveBeenCalledTimes(1)

    controller.abort()
    await expect(pending).resolves.toBeNull()
    expect(mocks.broadcast.mock.calls.map(([e]) => e)).toStrictEqual([
      reviewEvent('S', true),
      reviewEvent('S', false)
    ])
  })
})
