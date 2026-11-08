/**
 * 会话目标的读写（goal/goalStore.ts，docs/goal-mode-design.md §2.1）—— `GoalDoc` 经 `goalRecordOf` 校验，失败闭合。
 *
 *   GST-1 goalRecordOf：缺字段、类型不对、认不出的状态 → undefined（宁可不续跑，也不按坏记录续跑）；可选字段坏了只丢那一项
 *   GST-2 真存储上的读写：没有文档 → undefined 且读不建文档（不补种）；写下的 JSON 里没有 undefined 键；回 undefined = 删掉；
 *         存储里一份坏记录 → 读出 undefined
 *   GST-3 sessionCostUsd = harness.usage() 合计：根运行 + 同一存储里的 hook agent（判定的花费也算进目标预算，§6.1）
 */
import { describe, expect, it } from 'vitest'
import type { GoalRecord } from '@shuvix/chat-protocol/types/goal'
import { backgroundContext as BG } from '../../durable/context'
import { GoalDoc } from '../../durable/docs'
import { answer } from '../../durable/__tests__/support/faux'
import {
  hookRig,
  promptPayload,
  queueRoles,
  roleOf,
  type Role
} from '../../durable/__tests__/support/hookRig'
import { makeHost, registerHostCleanup } from '../../durable/__tests__/support/host'
import { stampUsage } from '../../durable/__tests__/support/usage'
import { waitFor } from '../../durable/__tests__/support/wait'
import { goalRecordOf, readGoal, sessionCostUsd, updateGoal } from '../goalStore'

registerHostCleanup()

const VALID: GoalRecord = {
  id: 'g_1',
  objective: 'Make e2e green',
  status: 'active',
  setAt: 1000,
  limits: { costUsd: 5, maxTurns: 50, stallTurns: 3 },
  baselineCostUsd: 0.5,
  turns: 2,
  stalls: 1,
  activeMs: 100,
  activeSince: 1000,
  lastVerdict: { verdict: 'not_met', reason: 'tests fail', nextStep: 'fix', at: 1500 }
}

describe('GST-1 goalRecordOf 校验（失败闭合）', () => {
  it('合法的整份记录原样读回（新对象）', () => {
    const read = goalRecordOf(structuredClone(VALID))
    expect(read).toStrictEqual(VALID)
  })

  it.each<[string, unknown]>([
    ['not an object', 'g_1'],
    ['null', null],
    ['array', [VALID]],
    ['missing id', { ...VALID, id: undefined }],
    ['missing objective', { ...VALID, objective: undefined }],
    ["status 'cleared'", { ...VALID, status: 'cleared' }],
    ['turns NaN', { ...VALID, turns: Number.NaN }],
    ["turns '3'", { ...VALID, turns: '3' }],
    ['turns Infinity', { ...VALID, turns: Number.POSITIVE_INFINITY }],
    ['stalls missing', { ...VALID, stalls: undefined }],
    ['activeMs missing', { ...VALID, activeMs: undefined }],
    ['setAt string', { ...VALID, setAt: '1000' }],
    ['baselineCostUsd missing', { ...VALID, baselineCostUsd: undefined }],
    ['limits without maxTurns', { ...VALID, limits: { costUsd: 5, stallTurns: 3 } }],
    ['limits without stallTurns', { ...VALID, limits: { costUsd: 5, maxTurns: 50 } }],
    ['limits not an object', { ...VALID, limits: 5 }]
  ])('%s → undefined', (_label, value) => {
    expect(goalRecordOf(value)).toBeUndefined()
  })

  it('记录本身合法、可选字段坏了：只丢那一项（认不出的暂停原因、坏的结论、非有限的 activeSince / 花费上限）', () => {
    const read = goalRecordOf({
      ...VALID,
      status: 'paused',
      pauseReason: 'coffee-break',
      lastVerdict: { verdict: 'done', reason: 'x', at: 1 },
      activeSince: Number.POSITIVE_INFINITY,
      endedAt: 'yesterday',
      limits: { costUsd: 'five', maxTurns: 50, stallTurns: 3, wallClockMin: Number.NaN }
    })
    expect(read).toBeDefined()
    expect(read!.status).toBe('paused')
    expect('pauseReason' in read!).toBe(false)
    expect('lastVerdict' in read!).toBe(false)
    expect('activeSince' in read!).toBe(false)
    expect('endedAt' in read!).toBe(false)
    expect(read!.limits).toStrictEqual({ maxTurns: 50, stallTurns: 3 })
  })

  it('结论里 at 不是数、reason 不是字符串 → 丢掉结论；nextStep 不是字符串 → 只丢 nextStep', () => {
    expect(
      'lastVerdict' in goalRecordOf({ ...VALID, lastVerdict: { verdict: 'met', reason: 'x' } })!
    ).toBe(false)
    expect(
      'lastVerdict' in
        goalRecordOf({ ...VALID, lastVerdict: { verdict: 'met', reason: 1, at: 1 } })!
    ).toBe(false)
    expect(
      goalRecordOf({ ...VALID, lastVerdict: { verdict: 'met', reason: 'x', at: 1, nextStep: 3 } })!
        .lastVerdict
    ).toStrictEqual({
      verdict: 'met',
      reason: 'x',
      at: 1
    })
  })
})

describe('GST-2 真存储上的读写', () => {
  it('没有文档 → undefined；读不建文档（不补种）', async () => {
    const t = await makeHost({ ephemeral: ['gst2a'] })
    const session = await t.open('gst2a')
    expect(await readGoal(session.harness)).toBeUndefined()
    expect(await session.harness.snapshot(GoalDoc, BG)).toBeUndefined()
  })

  it('写入：可选字段为 undefined 的键不落盘；读回相等；回 undefined = 删掉 goal 键', async () => {
    const t = await makeHost({ ephemeral: ['gst2b'] })
    const session = await t.open('gst2b')
    const goal: GoalRecord = {
      ...VALID,
      pauseReason: undefined,
      lastVerdict: undefined,
      endedAt: undefined
    }
    const written = await updateGoal(session.harness, (current) => {
      expect(current).toBeUndefined()
      return goal
    })
    expect(written).toBe(goal)
    const raw = (await session.harness.snapshot(GoalDoc, BG))?.goal as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(
      [
        'id',
        'objective',
        'status',
        'setAt',
        'limits',
        'baselineCostUsd',
        'turns',
        'stalls',
        'activeMs',
        'activeSince'
      ].sort()
    )
    expect(Object.values(raw)).not.toContain(undefined)
    const { pauseReason: _p, lastVerdict: _l, endedAt: _e, ...expected } = goal
    expect(await readGoal(session.harness)).toStrictEqual(expected)

    // 改：mutate 拿到的是当前的那一份
    await updateGoal(session.harness, (current) => ({ ...current!, turns: current!.turns + 1 }))
    expect((await readGoal(session.harness))?.turns).toBe(3)

    expect(await updateGoal(session.harness, () => undefined)).toBeUndefined()
    const doc = await session.harness.snapshot(GoalDoc, BG)
    expect(doc).toBeDefined()
    expect('goal' in doc!).toBe(false)
    expect(await readGoal(session.harness)).toBeUndefined()
  })

  it('存储里一份坏记录 → readGoal undefined；updateGoal 的 mutate 也拿到 undefined', async () => {
    const t = await makeHost({ ephemeral: ['gst2c'] })
    const session = await t.open('gst2c')
    await session.harness.commit(async (tx) => {
      const doc = await tx.doc(GoalDoc)
      doc.goal = { id: 'g_1', objective: 'x', status: 'active', turns: 'many' }
    }, BG)
    expect(await readGoal(session.harness)).toBeUndefined()
    let seen: GoalRecord | undefined | null = null
    await updateGoal(session.harness, (current) => {
      seen = current
      return current
    })
    expect(seen).toBeUndefined()
  })
})

describe('GST-3 sessionCostUsd 含同一存储里的 hook agent', () => {
  it('根运行 + 起标题的 hook agent：合计两者（判定 agent 的花费照样算进目标预算）', async () => {
    const rig = await hookRig()
    const prices: Record<Role, number> = { root: 0.01, titler: 0.02, reviewer: 0.04 }
    const stamp = stampUsage(rig.kit)
    stamp.price((context) => ({ input: 10, cost: prices[roleOf(context.messages)] }))
    expect(await sessionCostUsd(rig.session.harness)).toBe(0)
    queueRoles(rig.kit, { root: [answer('root done')], titler: [answer('A Title')] })
    expect(await rig.session.submitUser('make e2e green')).toEqual({})
    rig.runner.fire('session.prompt-accepted', promptPayload())
    await waitFor(() => rig.ends().length >= 1 && stamp.stamped.length === 2, 5000, 'titler ran')
    expect(await sessionCostUsd(rig.session.harness)).toBeCloseTo(prices.root + prices.titler, 12)
  })
})
