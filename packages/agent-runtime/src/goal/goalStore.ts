/**
 * 会话目标的读写（`GoalDoc`，docs/goal-mode-design.md §2.1）。读出来经 `goalRecordOf` 校验：认不出的形状当作没有目标
 * （失败闭合：宁可不续跑，也不按一份坏记录续跑）。写在一个提交里：先读后改，并发的两次改动不会互相覆盖。
 */
import { copyJson } from '@earendil-works/chord'
import type { Harness, JsonObject } from '@earendil-works/pi-durable'
import {
  GOAL_PAUSE_REASONS,
  GOAL_VERDICTS,
  type GoalLimits,
  type GoalRecord,
  type GoalStatus,
  type GoalVerdictRecord
} from '@shuvix/chat-protocol/types/goal'
import { backgroundContext as BG } from '../durable/context'
import { GoalDoc } from '../durable/docs'
import { totalCost } from '../durable/monitorSnapshot'

const STATUSES: readonly GoalStatus[] = ['active', 'paused', 'met', 'impossible']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function limitsOf(value: unknown): GoalLimits | undefined {
  if (!isRecord(value) || !finite(value.maxTurns) || !finite(value.stallTurns)) return undefined
  return {
    maxTurns: value.maxTurns,
    stallTurns: value.stallTurns,
    ...(finite(value.costUsd) ? { costUsd: value.costUsd } : {}),
    ...(finite(value.wallClockMin) ? { wallClockMin: value.wallClockMin } : {})
  }
}

function verdictOf(value: unknown): GoalVerdictRecord | undefined {
  if (!isRecord(value)) return undefined
  if (!(GOAL_VERDICTS as readonly unknown[]).includes(value.verdict)) return undefined
  if (typeof value.reason !== 'string' || !finite(value.at)) return undefined
  return {
    verdict: value.verdict as GoalVerdictRecord['verdict'],
    reason: value.reason,
    at: value.at,
    ...(typeof value.nextStep === 'string' ? { nextStep: value.nextStep } : {})
  }
}

/** 存储里的值 → 目标记录；缺字段、类型不对 → undefined */
export function goalRecordOf(value: unknown): GoalRecord | undefined {
  if (!isRecord(value)) return undefined
  const limits = limitsOf(value.limits)
  if (
    typeof value.id !== 'string' ||
    typeof value.objective !== 'string' ||
    !(STATUSES as readonly unknown[]).includes(value.status) ||
    !finite(value.setAt) ||
    !finite(value.baselineCostUsd) ||
    !finite(value.turns) ||
    !finite(value.stalls) ||
    !finite(value.activeMs) ||
    limits === undefined
  ) {
    return undefined
  }
  const pauseReason = (GOAL_PAUSE_REASONS as readonly unknown[]).includes(value.pauseReason)
    ? (value.pauseReason as GoalRecord['pauseReason'])
    : undefined
  const lastVerdict = verdictOf(value.lastVerdict)
  return {
    id: value.id,
    objective: value.objective,
    status: value.status as GoalStatus,
    setAt: value.setAt,
    limits,
    baselineCostUsd: value.baselineCostUsd,
    turns: value.turns,
    stalls: value.stalls,
    activeMs: value.activeMs,
    ...(pauseReason !== undefined ? { pauseReason } : {}),
    ...(lastVerdict !== undefined ? { lastVerdict } : {}),
    ...(finite(value.activeSince) ? { activeSince: value.activeSince } : {}),
    ...(finite(value.endedAt) ? { endedAt: value.endedAt } : {})
  }
}

/** 读出会话当前的目标；没有文档、没有目标、形状不对 → undefined */
export async function readGoal(harness: Harness): Promise<GoalRecord | undefined> {
  const doc = await harness.snapshot(GoalDoc, BG)
  return goalRecordOf(doc?.goal)
}

/**
 * 在一个提交里改目标：`mutate` 拿到当前目标（可能没有），回新的目标（undefined = 删掉）。回写入后的目标。
 * `mutate` 必须是纯的 —— 提交冲突重试时可能被调多次。
 */
export async function updateGoal(
  harness: Harness,
  mutate: (current: GoalRecord | undefined) => GoalRecord | undefined
): Promise<GoalRecord | undefined> {
  return harness.commit(async (tx) => {
    const doc = await tx.doc(GoalDoc)
    const next = mutate(goalRecordOf(doc.goal))
    if (next === undefined) delete doc.goal
    else doc.goal = copyJson(next as unknown as JsonObject, { omitUndefinedProperties: true }) as JsonObject
    return next
  }, BG)
}

/** 整条会话此刻的累计花费（美元）：`harness.usage()` 合计，含同一存储里的派生 agent 与 hook agent */
export async function sessionCostUsd(harness: Harness): Promise<number> {
  return totalCost(await harness.usage(BG))
}
