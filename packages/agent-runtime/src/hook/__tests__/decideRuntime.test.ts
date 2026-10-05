/**
 * 判定型 hook 全链路（P2-08 E 段，43–49 = 原 DR-1..7）—— 真 runner → 真路由 → 真协调器 → durable 子对话 →
 * faux provider，跑在 `makeHost` 的 durable 会话上（`hookRig`）。这里的判定都不带 `ownerTaskId`：审查员归一个
 * 后台锚任务。假的只有 faux 的剧本与测试 ToolHost。
 *
 * 这一层钉的是各层单测拼不出来的东西：模型只调一次 `next` 就出结论（请求恰一次、诱饵留在队列里）、请求里
 * 工具表只有 `next`、任务文本里既有事件围栏也有契约段；以及「没有意见」在真链路上的样子 —— 只写散文（追问
 * 一次后放弃）、模型报错（不追问）、`next` 与别的工具同批（捕获即中止子对话）、中途被外部中止（不等流收尾，
 * 子对话随后以 aborted 收场）。
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import type { PermissionVerdict } from '@shuvix/chat-protocol/types/permissionReview'
import { describe, expect, it } from 'vitest'
import { spawnedAgentRecordOf } from '../../durable/agentRecord'
import { backgroundContext as BG } from '../../durable/context'
import type { DurableSession } from '../../durable/durableSession'
import { testProfile } from '../../durable/__tests__/support/agentConfig'
import {
  answer,
  callTool,
  callTools,
  held,
  modelError,
  requestTools
} from '../../durable/__tests__/support/faux'
import { registerHostCleanup } from '../../durable/__tests__/support/host'
import {
  anchors,
  HOOK_PROFILES,
  hookRig,
  REVIEW_HOOK,
  REVIEWER,
  reviewerOf,
  type HookRig
} from '../../durable/__tests__/support/hookRig'
import { liveTasks, submissionByRequest, tasksOf } from '../../durable/__tests__/support/spawn'
import { allEntries, messageText } from '../../durable/__tests__/support/transcript'
import { waitFor } from '../../durable/__tests__/support/wait'
import { NEXT_NUDGE_TEXT } from '../../subagent/nextTool'

registerHostCleanup()

const V: PermissionVerdict = {
  decision: 'allow',
  risk: 'low',
  summary: 'Cleans build output',
  reason: 'The user asked for it'
}

function next(value: Record<string, unknown> = { ...V }, id = 'call-next'): ReturnType<typeof callTool> {
  return callTool('next', value as never, id)
}

/** 只有审查 hook 的夹具（判定都在锚下） */
function reviewRig(options: Parameters<typeof hookRig>[0] = {}): Promise<HookRig> {
  return hookRig({ hooks: [REVIEW_HOOK], ...options })
}

/** 这次判定的审查员对话（锚拥有的那条） */
async function reviewer(session: DurableSession): Promise<ConversationId> {
  const [anchor] = await anchors(session)
  const [R] = await reviewerOf(session, anchor!.id)
  return R!
}

async function kinds(session: DurableSession, id: ConversationId): Promise<string[]> {
  const conversation = (await session.harness.conversation(id, BG))!
  return (await allEntries(conversation))
    .filter((entry) => entry.kind !== 'pi.system')
    .map((entry) => entry.kind)
}

async function userTexts(session: DurableSession, id: ConversationId): Promise<string[]> {
  const conversation = (await session.harness.conversation(id, BG))!
  return (await allEntries(conversation))
    .filter((entry) => entry.kind === 'pi.user')
    .map((entry) => messageText(entry.model?.[0]))
}

describe('判定型 hook 全链路（真 runner / 路由 / 协调器 / durable + faux provider）', () => {
  it('P2-08-43 DR-1 one next call → {result, hook}; one request, the decoy stays queued; tools exactly [next]; the task text has the event fence and the contract; R is [user, assistant, tool-result] and its submission is done', async () => {
    const rig = await reviewRig()
    rig.kit.queue(next(), answer('decoy'))
    expect(await rig.decide()).toEqual({ result: V, hook: 'auto-review' })
    expect(rig.kit.callCount).toBe(1)
    expect(rig.kit.faux.getPendingResponseCount()).toBe(1)
    expect(requestTools(rig.kit, 0).map((tool) => tool.name)).toEqual(['next'])
    const lastUser = [...rig.kit.requests[0]!.messages].reverse().find((m) => m.role === 'user')
    const text = messageText(lastUser)
    expect(text).toContain('<hook_event trigger="permission.request">')
    expect(text).toContain('target: rm -rf build')
    expect(text).toContain('<result_contract>')
    expect(text).toContain('("auto-review")')
    expect(rig.ends()).toEqual([expect.objectContaining({ ok: true, result: V })])
    expect(rig.router.ends()).toEqual([expect.objectContaining({ isError: false })])
    expect(rig.runner.runningCount()).toBe(0)
    const R = await reviewer(rig.session)
    expect(await kinds(rig.session, R)).toEqual(['pi.user', 'pi.assistant', 'pi.tool-result'])
    const runId = rig.starts()[0]!.run.runId
    expect((await submissionByRequest(rig.session, R, `hook:${runId}`))?.status).toBe('done')
  })

  it('P2-08-44 DR-2 prose twice → null; exactly two requests (the original + one nudge), the decoy left; R holds the nudge; end error "no valid result"', async () => {
    const rig = await reviewRig()
    rig.kit.queue(answer('looks fine'), answer('still fine'), answer('decoy'))
    expect(await rig.decide()).toBeNull()
    expect(rig.kit.callCount).toBe(2)
    expect(rig.kit.faux.getPendingResponseCount()).toBe(1)
    const R = await reviewer(rig.session)
    expect((await userTexts(rig.session, R)).at(-1)).toBe(NEXT_NUDGE_TEXT)
    expect(rig.ends()).toEqual([expect.objectContaining({ ok: false, error: 'no valid result' })])
  })

  it('P2-08-45 DR-3 a model error → null; one request, no nudge; end.error carries the provider text; sub_session_end isError', async () => {
    const rig = await reviewRig()
    rig.kit.queue(modelError('500 Internal Server Error'), answer('decoy'))
    expect(await rig.decide()).toBeNull()
    expect(rig.kit.callCount).toBe(1)
    const R = await reviewer(rig.session)
    expect(await userTexts(rig.session, R)).not.toContain(NEXT_NUDGE_TEXT)
    expect(rig.ends()[0]!.ok).toBe(false)
    expect(rig.ends()[0]!.error).toContain('500 Internal Server Error')
    expect(rig.router.ends()).toEqual([expect.objectContaining({ isError: true })])
  })

  it('P2-08-46 DR-4 an invalid next, then a valid one → the corrected verdict; exactly two requests', async () => {
    const rig = await reviewRig()
    rig.kit.queue(next({ decision: 'allow' }, 'call-bad'), next())
    expect(await rig.decide()).toEqual({ result: V, hook: 'auto-review' })
    expect(rig.kit.callCount).toBe(2)
  })

  it('P2-08-47 DR-5 thinking: session high and no declaration → reasoning high; profile off → no reasoning', async () => {
    const plain = testProfile({ name: 'permission-reviewer', displayName: 'Reviewer', tools: [] })
    const profiles = { ...HOOK_PROFILES, 'permission-reviewer': plain }
    const rig = await reviewRig({ profiles })
    await rig.session.setThinkingLevel('high')
    rig.kit.queue(next())
    expect(await rig.decide()).not.toBeNull()
    expect(rig.kit.requests[0]!.options?.reasoning).toBe('high')
    profiles['permission-reviewer'] = { ...REVIEWER, thinkingLevel: 'off' }
    rig.kit.queue(next())
    expect(await rig.decide()).not.toBeNull()
    expect(rig.kit.requests[1]!.options?.reasoning).toBeUndefined()
  })

  it('P2-08-48 DR-6 next with another tool in one batch → the captured verdict, no hang, no nudge; at most two requests; the coordinator aborts R', async () => {
    const profiles = {
      ...HOOK_PROFILES,
      'permission-reviewer': { ...REVIEWER, tools: ['probe'] }
    }
    const rig = await reviewRig({ profiles })
    rig.kit.queue(
      callTools([
        ['next', { ...V }, 'call-next'],
        ['probe', {}, 'call-probe']
      ]),
      answer('after the batch')
    )
    expect(await rig.decide()).toEqual({ result: V, hook: 'auto-review' })
    expect(rig.kit.callCount).toBeLessThanOrEqual(2)
    const R = await reviewer(rig.session)
    expect(await userTexts(rig.session, R)).not.toContain(NEXT_NUDGE_TEXT)
    await waitFor(async () => (await liveTasks(rig.session, R)).length === 0)
    expect((await tasksOf(rig.session, R)).map((task) => task.state)).toContainEqual({
      status: 'terminal',
      outcome: { status: 'aborted' }
    })
  })

  it('P2-08-49 DR-7 the outer signal falls mid-stream → null within 500 ms, end aborted; R ends aborted within 3 s; the slot drains; still one request', async () => {
    const rig = await reviewRig()
    const slow = held(next())
    rig.kit.queue(slow.step)
    const controller = new AbortController()
    const pending = rig.decide(undefined, { signal: controller.signal })
    await slow.reached
    const started = Date.now()
    controller.abort()
    expect(await pending).toBeNull()
    expect(Date.now() - started).toBeLessThan(500)
    expect(rig.ends()).toEqual([expect.objectContaining({ ok: false, error: 'aborted' })])
    const R = await reviewer(rig.session)
    await waitFor(async () => (await liveTasks(rig.session, R)).length === 0, 3000)
    expect((await tasksOf(rig.session, R)).map((task) => task.state)).toEqual([
      { status: 'terminal', outcome: { status: 'aborted' } }
    ])
    await waitFor(() => rig.runner.runningCount() === 0, 3000)
    expect(rig.kit.callCount).toBe(1)
    expect((await spawnedAgentRecordOf(rig.session.harness, R, BG))?.dispatch).toBe('hook')
  })
})
