/**
 * P2-06-20 / P2-06-21（docs/pi-durable/p2-06-test-design.md，PIN-08）—— 防递归的端到端：真 toolContext 的门
 * （getDesktopSecurityContext）+ 真 permissionReview（经 setPermissionReviewer 注入）。会话级 ctx 带
 * `agentOf`：主体按**这次调用**的对话认人，审查员（被绑在 `permission.request` 上的派生 agent）自己要权限
 * 时不再交给审查、直接问人；根与别的派生 agent 照常审查。绑定集合每次现读（`agentsBoundTo`）。
 *
 * hookService / messageService / settingsService / 前端注册表是替身；toolContext 的 dao / paths / policy /
 * sandbox / skill / knowledge 依赖照 toolContext.test 的做法替身（内置策略读仓库里那一份 md）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rv = vi.hoisted(() => ({
  agentsBoundTo: vi.fn((_trigger: string): Set<string> => new Set(['permission-reviewer'])),
  decide: vi.fn(),
  listBySession: vi.fn(async (_sessionId: string): Promise<unknown[]> => []),
  settingsGet: vi.fn((_key: string): string | undefined => undefined),
  broadcast: vi.fn((_event: Record<string, unknown>) => {}),
  builtinDir: `${__dirname}/../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`
}))

vi.mock('../hookService', () => ({
  hookService: { agentsBoundTo: rv.agentsBoundTo },
  hookTriggers: { decide: rv.decide }
}))
vi.mock('../messageService', () => ({ messageService: { listBySession: rv.listBySession } }))
vi.mock('../settingsService', () => ({ settingsService: { get: rv.settingsGet } }))
vi.mock('../../frontend/core', () => ({ chatFrontendRegistry: { broadcast: rv.broadcast } }))
vi.mock('../sessionRecords', () => ({
  sessionRecords: { pick: () => undefined, pickSettings: () => undefined }
}))
// toolContext 的依赖（同 toolContext.test）
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../dao/sessionDao', () => ({ sessionDao: { pickSettings: () => undefined } }))
vi.mock('../sessionService', () => ({
  sessionService: { getById: () => undefined, addAllowListPaths: () => {} }
}))
vi.mock('../skillService', () => ({
  skillService: { listExternalDirs: () => [], enabledSkillRoots: () => [] }
}))
vi.mock('../knowledge/sessionBundle', () => ({ enabledTargets: () => [] }))
vi.mock('../policyService', () => ({
  policyService: {
    getUserPolicies: () => [],
    readBuiltinPolicyMd: (fileName: string) => {
      try {
        return readFileSync(join(rv.builtinDir, fileName), 'utf-8')
      } catch {
        return null
      }
    }
  }
}))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: () => '/tmp/shuvix-rv-ws',
  getToolResultsBase: () => '/tmp/shuvix-rv-tool-results',
  getDefaultSkillsDir: () => '/tmp/shuvix-rv-skills',
  getBuiltinSkillsDir: () => '/tmp/shuvix-rv-builtin-skills',
  getMemoryRootDir: () => '/tmp/shuvix-rv-memory',
  getDefaultBotsDir: () => '/tmp/shuvix-rv-bots',
  getDefaultPoliciesDir: () => '/tmp/shuvix-rv-policies',
  getDefaultAgentsDir: () => '/tmp/shuvix-rv-agents',
  getDefaultHooksDir: () => '/tmp/shuvix-rv-hooks',
  getBuiltinKnowledgeDir: () => '/tmp/shuvix-rv-builtin-knowledge',
  getSessionArtifactsDir: (id: string) => `/tmp/shuvix-rv-artifacts/${id}`,
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..'),
  getShuvixKnowledgeRootDir: () => '/tmp/shuvix-rv-knowledge-shuvix'
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import {
  clearReviewState,
  clearSessionDecisions,
  type PermissionRequestPayload
} from '@shuvix/agent-runtime'
import type { AskInputRequest, InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import {
  getDesktopSecurityContext,
  setPermissionReviewer,
  type ProjectConfig
} from '../toolContext'
import type { ToolAgentIdentity } from '../toolAgent'
import { reviewPermissionRequest } from '../permissionReview'

const SID = 'rv-s1'
/** 会话目录外的普通文件：ask-on-external-path#1（ask 档，审查接缝只管这一档） */
const OUTSIDE = '/tmp/shuvix-rv-outside/a.txt'
const cfg = (): ProjectConfig => ({ workingDirectory: '/rv-ws' })

const haiku = (): ReturnType<NonNullable<ToolAgentIdentity['getModelConfig']>> => ({
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  capabilities: {}
})
const WORK: ToolAgentIdentity = { profileName: 'work', kind: 'root' }
const EXPLORE: ToolAgentIdentity = {
  profileName: 'explore',
  kind: 'spawned',
  callerId: 'sub-a1',
  getModelConfig: haiku
}
const REVIEWER: ToolAgentIdentity = {
  profileName: 'permission-reviewer',
  kind: 'spawned',
  callerId: 'sub-r1',
  getModelConfig: haiku
}
const HOOK_T: ToolAgentIdentity = {
  profileName: 'titler',
  kind: 'spawned',
  callerId: 'sub-h1',
  getModelConfig: haiku
}
/** 根，但档案名恰好叫 permission-reviewer（不是派生的就不跳过） */
const ROOT_NAMED_REVIEWER: ToolAgentIdentity = { profileName: 'permission-reviewer', kind: 'root' }
const IDENTITIES: Record<number, ToolAgentIdentity> = {
  1: WORK,
  2: EXPLORE,
  3: REVIEWER,
  6: HOOK_T,
  7: ROOT_NAMED_REVIEWER
}

const verdict = (decision: 'allow' | 'ask' | 'deny'): Record<string, string> => ({
  decision,
  risk: 'low',
  summary: 'Writes a file.',
  reason: 'test reviewer'
})

let asks: InputRequest[]
let requestUserInput: ReturnType<typeof vi.fn>
let ctx: ReturnType<typeof getDesktopSecurityContext>

/** 会话目录外写一次（这次调用的对话 / taskId） */
const writeFrom = (conversationId: number, toolCallId: string, taskId = 9): Promise<void> =>
  ctx.enforcePath('write', OUTSIDE, { toolCallId, toolName: 'write', taskId, conversationId })

const payloadOf = (call: number): PermissionRequestPayload =>
  rv.decide.mock.calls[call][1] as PermissionRequestPayload

const reviewBroadcasts = (toolCallId: string): unknown[] =>
  rv.broadcast.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === 'tool_review' && event.toolCallId === toolCallId)
    .map((event) => event.reviewing)

beforeEach(() => {
  rv.agentsBoundTo.mockReset().mockImplementation(() => new Set(['permission-reviewer']))
  rv.decide.mockReset().mockImplementation(async () => ({
    result: verdict('allow'),
    hook: 'auto-review'
  }))
  rv.listBySession.mockClear()
  rv.settingsGet.mockClear()
  rv.broadcast.mockClear()
  setPermissionReviewer(reviewPermissionRequest)
  asks = []
  requestUserInput = vi.fn(async (request: InputRequest) => {
    asks.push(request)
    return { kind: 'ask', allowed: true }
  })
  ctx = getDesktopSecurityContext(
    {
      sessionId: SID,
      requestUserInput: requestUserInput as never,
      agentOf: (conversationId) => IDENTITIES[conversationId]
    },
    cfg
  )
})

afterEach(() => {
  setPermissionReviewer(null)
  clearReviewState(SID)
  clearSessionDecisions(SID)
})

describe('P2-06-20 防递归的端到端（真门 + 真审查接缝）', () => {
  it('P2-06-20 审查员的对话（3）：不交审查、直接问人；根（1）与派生 explore（2）照常交审查，payload 带各自的主体', async () => {
    // 1. 审查员自己要权限
    await expect(writeFrom(3, 'r-3')).resolves.toBeUndefined()
    expect(rv.agentsBoundTo).toHaveBeenCalledWith('permission.request')
    expect(rv.decide).not.toHaveBeenCalled()
    expect(reviewBroadcasts('r-3')).toEqual([])
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect((asks[0] as AskInputRequest).review).toBeUndefined()

    // 2. 根 agent：交审查，审查员放行 → 不问人
    await expect(writeFrom(1, 'r-1')).resolves.toBeUndefined()
    expect(rv.decide).toHaveBeenCalledTimes(1)
    const [trigger, , options] = rv.decide.mock.calls[0]
    expect(trigger).toBe('permission.request')
    expect(options).toEqual({ signal: expect.anything() })
    expect(payloadOf(0).agent).toStrictEqual({ profile: 'work', kind: 'root' })
    expect(payloadOf(0).sessionId).toBe(SID)
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(reviewBroadcasts('r-1')).toEqual([true, false])

    // 3. 派生 explore（没绑在埋点上）：照常交审查
    await expect(writeFrom(2, 'r-2')).resolves.toBeUndefined()
    expect(rv.decide).toHaveBeenCalledTimes(2)
    expect(payloadOf(1).agent).toStrictEqual({ profile: 'explore', kind: 'spawned' })
  })
})

describe('P2-06-21 只有绑在埋点上的派生档案才跳过，绑定集合现读', () => {
  it('P2-06-21 titler（没绑）→ 交审查；根但档案名叫 permission-reviewer → 交审查；titler 被绑上之后 → 不交审查、问人', async () => {
    await expect(writeFrom(6, 't-6')).resolves.toBeUndefined()
    expect(rv.decide).toHaveBeenCalledTimes(1)
    expect(payloadOf(0).agent).toStrictEqual({ profile: 'titler', kind: 'spawned' })

    await expect(writeFrom(7, 't-7')).resolves.toBeUndefined()
    expect(rv.decide).toHaveBeenCalledTimes(2)
    expect(payloadOf(1).agent).toStrictEqual({ profile: 'permission-reviewer', kind: 'root' })
    expect(requestUserInput).not.toHaveBeenCalled()

    rv.agentsBoundTo.mockImplementation(() => new Set(['permission-reviewer', 'titler']))
    await expect(writeFrom(6, 't-6b')).resolves.toBeUndefined()
    expect(rv.decide).toHaveBeenCalledTimes(2)
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect((asks[0] as AskInputRequest).review).toBeUndefined()
  })
})
