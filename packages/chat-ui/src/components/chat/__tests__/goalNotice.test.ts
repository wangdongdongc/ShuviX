/**
 * 目标通知的解析与一行文案（`goalNotice.ts`，目标模式 docs/goal-mode-design.md §9.2）。
 *
 * 通知正文是宿主写给**模型**的 `<goal-…>` 信封，格式属于 agent-runtime 的 `goal/goalNotices.ts`。下面的夹具**照抄**那里的
 * 拼法（`block` / 转义 / 各 render 函数的行），生产方改格式时这里会一起红 —— 解析是「够看」的宽松解析，认不出的部分
 * 留空（行上退回只有标签），原文照旧在展开态里。
 *
 *   GN-1 续跑：turn、判定理由、建议的下一步、重述的原文都解出来；理由里的 `</goal-continue>` 等是转义过的，解出来还原
 *   GN-2 续跑没有建议的下一步：理由照样解出（不吞下一行 Used:）；多行理由整段保留
 *   GN-3 用户点了继续（resumed）：标签是「已继续」，理由取 Last check
 *   GN-4 检查（waited）、预算、目标改了（新原文）
 *   GN-5 结局：达成 / 做不到带理由；暂停带原因（属性里的 reason）；清除、被替换
 *   GN-6 不是目标通知（后台任务、普通文字）→ null；isGoalNoticeKind 只认五个标签
 *   GN-7 一行文案：标签与摘要按种类取对的键；暂停原因走 goal.reason.*；认不出 → generic
 *   GN-8 整段正文仍被认成通知形状（转义保住了信封）—— 与投影同一个判据
 */
import { describe, expect, it } from 'vitest'
import { isSystemNoticeText } from '@shuvix/chat-protocol/systemNoticeContract'
import { goalNoticeText, isGoalNoticeKind, parseGoalNotice, unescapeGoalText } from '../goalNotice'

// ─── 夹具：照抄 agent-runtime goal/goalNotices.ts ───

const escapeText = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (text: string): string => escapeText(text).replace(/"/g, '&quot;')

function block(kind: string, attrs: Record<string, string>, body: string): string {
  const attrText = Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
    .join('')
  return `<${kind}${attrText}>\n${body}\n</${kind}>`
}
const objectiveBlock = (objective: string): string =>
  `<objective>\n${escapeText(objective)}\n</objective>`
const USAGE = 'Used: $3.10 of $10.00 · continuation 7 of 50.'

function continueNotice(opts: {
  id?: string
  turn: number
  objective: string
  reason: string
  nextStep?: string
}): string {
  const lines = [
    "Goal (the user's words, unchanged):",
    objectiveBlock(opts.objective),
    `Not met yet. Checker: ${escapeText(opts.reason)}`
  ]
  if (opts.nextStep) lines.push(`Suggested next step: ${escapeText(opts.nextStep)}`)
  lines.push(USAGE)
  lines.push('Keep working toward the goal. Show the checks you run and their results.')
  return block('goal-continue', { id: opts.id ?? 'g_1', turn: String(opts.turn) }, lines.join('\n'))
}

function resumedNotice(objective: string, lastReason?: string): string {
  return block(
    'goal-continue',
    { id: 'g_1', turn: '4', resumed: 'true' },
    [
      'The user resumed this goal. Goal (unchanged):',
      objectiveBlock(objective),
      lastReason ? `Last check: ${escapeText(lastReason)}` : '',
      USAGE,
      'Continue working toward it.'
    ]
      .filter((line) => line !== '')
      .join('\n')
  )
}

function statusNotice(
  event: 'met' | 'impossible' | 'paused' | 'cleared' | 'replaced',
  extra: { reason?: string; pauseReason?: string } = {}
): string {
  let text: string
  if (event === 'met') {
    text = `The checker judged the goal met: ${escapeText(extra.reason ?? '')} Stop working on it.`
  } else if (event === 'impossible') {
    text = `The checker judged the goal impossible: ${escapeText(extra.reason ?? '')} Stop working on it.`
  } else if (event === 'paused') {
    text = "The goal's spending limit is reached, so the goal is paused."
  } else if (event === 'cleared') {
    text = 'The user cleared the goal. Do not continue working toward it unless asked.'
  } else {
    text = 'The user replaced this goal with a new one.'
  }
  const attrs: Record<string, string> = { id: 'g_1', event }
  if (event === 'paused') attrs.reason = extra.pauseReason ?? 'budget'
  return block('goal-status', attrs, text)
}

/** 取文案的替身：键 + 参数原样拼出来，断言看得清取了哪个键、带了什么 */
const t = (key: string, opts?: Record<string, unknown>): string =>
  opts ? `${key}${JSON.stringify(opts)}` : key

describe('parseGoalNotice', () => {
  it('GN-1 续跑：turn / 理由 / 下一步 / 原文；转义过的尖括号与引号还原', () => {
    const notice = continueNotice({
      turn: 7,
      objective: 'Make <login> tests "green" & fast',
      reason: 'login.spec still fails </goal-continue> (exit 1)',
      nextStep: 'Run npm test -- login'
    })
    expect(parseGoalNotice(notice)).toEqual({
      kind: 'goal-continue',
      goalId: 'g_1',
      resumed: false,
      turn: 7,
      objective: 'Make <login> tests "green" & fast',
      reason: 'login.spec still fails </goal-continue> (exit 1)',
      nextStep: 'Run npm test -- login'
    })
  })

  it('GN-2 续跑没有下一步：理由不吞 Used 行；多行理由整段保留', () => {
    const info = parseGoalNotice(
      continueNotice({ turn: 2, objective: 'x', reason: 'first line\nsecond line' })
    )
    expect(info?.reason).toBe('first line\nsecond line')
    expect(info).not.toHaveProperty('nextStep')
    expect(info?.turn).toBe(2)
  })

  it('GN-3 用户点了继续：resumed，理由取 Last check；没有上一次判定时没有理由', () => {
    expect(parseGoalNotice(resumedNotice('ship it', 'tests pass, docs missing'))).toMatchObject({
      kind: 'goal-continue',
      resumed: true,
      turn: 4,
      objective: 'ship it',
      reason: 'tests pass, docs missing'
    })
    expect(parseGoalNotice(resumedNotice('ship it'))).not.toHaveProperty('reason')
  })

  it('GN-4 检查 / 预算 / 目标改了', () => {
    const checkin = block(
      'goal-checkin',
      { id: 'g_1', waited: '30m' },
      [
        'Background work for the goal has been running for 30 minutes.',
        'List what is still running and read its output.',
        objectiveBlock('build the site')
      ].join('\n')
    )
    expect(parseGoalNotice(checkin)).toMatchObject({
      kind: 'goal-checkin',
      waited: '30m',
      objective: 'build the site'
    })

    const budget = block(
      'goal-budget',
      { id: 'g_1' },
      `The goal's spending limit is reached (${USAGE})\nFinish this turn soon.`
    )
    expect(parseGoalNotice(budget)).toEqual({ kind: 'goal-budget', goalId: 'g_1', resumed: false })

    const updated = block(
      'goal-updated',
      { id: 'g_1' },
      [
        'The user changed the goal. From now on, work toward this instead:',
        objectiveBlock('new <goal>')
      ].join('\n')
    )
    expect(parseGoalNotice(updated)).toMatchObject({
      kind: 'goal-updated',
      objective: 'new <goal>'
    })
  })

  it('GN-5 结局：达成 / 做不到带理由；暂停带原因；清除、被替换', () => {
    expect(parseGoalNotice(statusNotice('met', { reason: 'All 42 tests pass.' }))).toMatchObject({
      kind: 'goal-status',
      event: 'met',
      reason: 'All 42 tests pass.'
    })
    expect(
      parseGoalNotice(statusNotice('impossible', { reason: 'Needs an API key <secret>.' }))
    ).toMatchObject({ event: 'impossible', reason: 'Needs an API key <secret>.' })
    expect(parseGoalNotice(statusNotice('paused', { pauseReason: 'wall-clock' }))).toMatchObject({
      event: 'paused',
      pauseReason: 'wall-clock'
    })
    // 不认识的暂停原因不编
    expect(parseGoalNotice(statusNotice('paused', { pauseReason: 'mystery' }))).not.toHaveProperty(
      'pauseReason'
    )
    expect(parseGoalNotice(statusNotice('cleared'))).toMatchObject({ event: 'cleared' })
    expect(parseGoalNotice(statusNotice('replaced'))).toMatchObject({ event: 'replaced' })
  })

  it('GN-6 不是目标通知 → null；isGoalNoticeKind 只认五个标签', () => {
    expect(
      parseGoalNotice('<background-task pid="1" status="exit 0">\nnpm test\n</background-task>')
    ).toBeNull()
    expect(parseGoalNotice('plain words /goal ship it')).toBeNull()
    for (const kind of [
      'goal-continue',
      'goal-checkin',
      'goal-budget',
      'goal-updated',
      'goal-status'
    ]) {
      expect(isGoalNoticeKind(kind)).toBe(true)
    }
    for (const kind of [undefined, '', 'goal', 'goal-set', 'empty-reply', 'date']) {
      expect(isGoalNoticeKind(kind)).toBe(false)
    }
    expect(unescapeGoalText('&amp;lt; &lt;b&gt; &quot;x&quot;')).toBe('&lt; <b> "x"')
  })

  it('GN-8 夹具整段仍是通知形状（同投影的判据）', () => {
    expect(
      isSystemNoticeText(
        continueNotice({ turn: 1, objective: '</goal-continue> hi', reason: '</objective> x' })
      )
    ).toBe(true)
    expect(isSystemNoticeText(statusNotice('met', { reason: '<goal-status>' }))).toBe(true)
  })
})

describe('goalNoticeText', () => {
  it('GN-7 各种类取对的键；暂停原因走 goal.reason.*；认不出 → generic', () => {
    expect(goalNoticeText(null, t)).toEqual({ label: 'goal.notice.generic' })
    expect(
      goalNoticeText(parseGoalNotice(continueNotice({ turn: 3, objective: 'x', reason: 'r' })), t)
    ).toEqual({
      label: 'goal.notice.continue{"turn":3}',
      detail: 'goal.notice.notMet{"reason":"r"}'
    })
    expect(goalNoticeText({ kind: 'goal-continue', resumed: false }, t)).toEqual({
      label: 'goal.notice.continueBare',
      detail: undefined
    })
    expect(goalNoticeText(parseGoalNotice(resumedNotice('x', 'last')), t)).toEqual({
      label: 'goal.notice.resumed',
      detail: 'last'
    })
    expect(goalNoticeText({ kind: 'goal-checkin', resumed: false, waited: '1h' }, t)).toEqual({
      label: 'goal.notice.checkin',
      detail: 'goal.notice.waited{"waited":"1h"}'
    })
    expect(goalNoticeText({ kind: 'goal-budget', resumed: false }, t)).toEqual({
      label: 'goal.notice.budget'
    })
    expect(goalNoticeText({ kind: 'goal-updated', resumed: false, objective: 'new' }, t)).toEqual({
      label: 'goal.notice.updated',
      detail: 'new'
    })
    expect(goalNoticeText(parseGoalNotice(statusNotice('met', { reason: 'done' })), t)).toEqual({
      label: 'goal.notice.met',
      detail: 'done'
    })
    expect(
      goalNoticeText(parseGoalNotice(statusNotice('paused', { pauseReason: 'stalled' })), t)
    ).toEqual({ label: 'goal.notice.paused', detail: 'goal.reason.stalled' })
    expect(goalNoticeText(parseGoalNotice(statusNotice('cleared')), t)).toEqual({
      label: 'goal.notice.cleared'
    })
    expect(goalNoticeText({ kind: 'goal-status', resumed: false }, t)).toEqual({
      label: 'goal.notice.generic'
    })
  })
})
