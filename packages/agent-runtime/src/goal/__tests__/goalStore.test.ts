/**
 * 会话目标的读写（goal/goalStore.ts，docs/goal-mode-design.md §2.1）—— `GoalDoc` 经 `goalRecordOf` 校验，失败闭合。
 *
 *   GST-1 goalRecordOf：缺字段、类型不对、认不出的状态 → undefined（宁可不续跑，也不按坏记录续跑）；可选字段坏了只丢那一项
 *   GST-2 真存储上的读写：没有文档 → undefined 且读不建文档（不补种）；写下的 JSON 里没有 undefined 键；回 undefined = 删掉；
 *         存储里一份坏记录 → 读出 undefined
 *   GST-3 v0.2.58–v0.2.59 的记录（带 baselineCostUsd、limits.costUsd、暂停原因 budget）：照样读得出，花费的字段丢掉；
 *         下次写回就没了（2026-11-09：ShuviX 不算花费）
 */
import { describe, expect, it } from 'vitest'
import type { GoalRecord } from '@shuvix/chat-protocol/types/goal'
import { backgroundContext as BG } from '../../durable/context'
import { GoalDoc } from '../../durable/docs'
import { makeHost, registerHostCleanup } from '../../durable/__tests__/support/host'
import { goalRecordOf, readGoal, updateGoal } from '../goalStore'

registerHostCleanup()

const VALID: GoalRecord = {
  id: 'g_1',
  objective: 'Make e2e green',
  status: 'active',
  setAt: 1000,
  limits: { maxTurns: 50, stallTurns: 3 },
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
    ['limits without maxTurns', { ...VALID, limits: { stallTurns: 3 } }],
    ['limits without stallTurns', { ...VALID, limits: { maxTurns: 50 } }],
    ['limits not an object', { ...VALID, limits: 5 }]
  ])('%s → undefined', (_label, value) => {
    expect(goalRecordOf(value)).toBeUndefined()
  })

  it('记录本身合法、可选字段坏了：只丢那一项（认不出的暂停原因、坏的结论、非有限的 activeSince / 时长上限）', () => {
    const read = goalRecordOf({
      ...VALID,
      status: 'paused',
      pauseReason: 'coffee-break',
      lastVerdict: { verdict: 'done', reason: 'x', at: 1 },
      activeSince: Number.POSITIVE_INFINITY,
      endedAt: 'yesterday',
      limits: { maxTurns: 50, stallTurns: 3, wallClockMin: Number.NaN }
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

describe('GST-3 v0.2.58–v0.2.59 带花费字段的记录', () => {
  const LEGACY = {
    ...VALID,
    status: 'paused',
    pauseReason: 'budget',
    activeSince: undefined,
    limits: { costUsd: 5, maxTurns: 50, stallTurns: 3, wallClockMin: 30 },
    baselineCostUsd: 0.5
  }

  it('读得出：花费上限、基线丢掉，暂停原因 budget 认不出 → 暂停、没有原因；其余照旧', () => {
    const read = goalRecordOf(structuredClone(LEGACY))
    expect(read).toBeDefined()
    expect(read!.status).toBe('paused')
    expect('pauseReason' in read!).toBe(false)
    expect('baselineCostUsd' in read!).toBe(false)
    expect(read!.limits).toStrictEqual({ maxTurns: 50, stallTurns: 3, wallClockMin: 30 })
    expect(read!.turns).toBe(VALID.turns)
    expect(read!.lastVerdict).toStrictEqual(VALID.lastVerdict)
  })

  it('真存储上：旧记录读得出，下一次写回之后花费的字段就没了', async () => {
    const t = await makeHost({ ephemeral: ['gst3'] })
    const session = await t.open('gst3')
    await session.harness.commit(async (tx) => {
      const doc = await tx.doc(GoalDoc)
      const { activeSince: _a, ...legacy } = LEGACY
      doc.goal = JSON.parse(JSON.stringify(legacy))
    }, BG)
    expect((await readGoal(session.harness))?.status).toBe('paused')
    await updateGoal(session.harness, (current) => ({ ...current!, turns: current!.turns + 1 }))
    const raw = (await session.harness.snapshot(GoalDoc, BG))?.goal as Record<string, unknown>
    expect('baselineCostUsd' in raw).toBe(false)
    expect('pauseReason' in raw).toBe(false)
    expect(raw.limits).toStrictEqual({ maxTurns: 50, stallTurns: 3, wallClockMin: 30 })
  })
})
