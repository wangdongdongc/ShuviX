/**
 * 判定型埋点的结论契约（triggerPoints.ts 的 DECIDE_SPECS）—— schema、parse、severity 三件套。
 *
 * schema 同时是派发时 `next` 工具的参数：runner 把它原样交给结果契约，模型的调用参数就是结论。
 * 所以这里除了钉目录一致（判定型 id 恰好都有 spec、观察型一个都没有），还经**真 NextTool**
 * 把 schema 走一遍：合格判决被捕获（P2-02 起结果在 `details: {result}` 里，没有回调）且带
 * control.terminate（一次请求出结论），不合格的逐字段报错（isError 结果 —— P1-04 起 BaseTool 模板把
 * 抛错收成失败结果，裁定 Q12）、不带 details。
 * parse 是交给 runner 之前的最后一道（认不出 = 这个 hook 没有意见），severity 决定多个结论谁胜出。
 */
import { describe, expect, it } from 'vitest'
import {
  PERMISSION_VERDICT_SCHEMA,
  type PermissionVerdict
} from '@shuvix/chat-protocol/types/permissionReview'
import { DECIDE_SPECS, TRIGGER_POINTS, type TriggerId } from '../triggerPoints'
import { NextTool, validateContractSchema } from '../../subagent/nextTool'
import { invokeTool, type InvokedToolResult } from '../../tools/testing/invokeTool'

const SPEC = DECIDE_SPECS['permission.request']

const verdictOf = (over: Partial<PermissionVerdict> = {}): PermissionVerdict => ({
  decision: 'allow',
  risk: 'low',
  summary: 'Runs the tests.',
  reason: 'The user asked for it.',
  ...over
})

/** 经 BaseTool.execute 模板调一次 next（与 durable 派发工具调用同一条路径） */
const callNext = async (tool: NextTool, params: unknown): Promise<InvokedToolResult> =>
  (await invokeTool(tool, params as Record<string, unknown>, { callId: 'tc-1' })).result

const textOf = (r: InvokedToolResult): string =>
  r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')

/** 一次不合格调用交回的失败文字（不是失败结果则测试失败） */
async function rejectionOf(params: unknown): Promise<{ message: string; captured: boolean }> {
  const tool = new NextTool(SPEC.schema)
  const out = await callNext(tool, params)
  expect(out.isError, 'next should reject a non-conforming verdict').toBe(true)
  return { message: textOf(out), captured: out.details !== undefined }
}

describe('目录一致', () => {
  it('DS-1 DECIDE_SPECS 的键恰是 kind 为 decide 的埋点；观察型埋点一个都没有 spec', () => {
    const ids = Object.keys(TRIGGER_POINTS) as TriggerId[]
    const decideIds = ids.filter((id) => TRIGGER_POINTS[id].kind === 'decide')
    const observeIds = ids.filter((id) => TRIGGER_POINTS[id].kind === 'observe')
    expect(decideIds.length).toBeGreaterThan(0)
    expect(observeIds.length).toBeGreaterThan(0)
    expect(Object.keys(DECIDE_SPECS).sort()).toEqual([...decideIds].sort())
    for (const id of observeIds) expect(id in DECIDE_SPECS).toBe(false)
  })

  it('DS-2 permission.request 的 schema 就是 PERMISSION_VERDICT_SCHEMA 本身，且过得了派发前的契约自检', () => {
    expect(SPEC.schema).toBe(PERMISSION_VERDICT_SCHEMA)
    expect(validateContractSchema(SPEC.schema)).toBeNull()
  })
})

describe('schema 经真 NextTool', () => {
  it.each(['allow', 'ask', 'deny'] as const)(
    'DS-3 合格判决（decision %s）→ 结果原样在 details.result 里，结果带 control.terminate',
    async (decision) => {
      const tool = new NextTool(SPEC.schema)
      const verdict = verdictOf({ decision, risk: 'medium' })
      const out = await callNext(tool, verdict)
      expect(out.details).toEqual({ result: verdict })
      expect(out.control).toEqual({ terminate: true })
    }
  )

  it.each([
    ["decision: 'maybe'", { ...verdictOf(), decision: 'maybe' }, /\/decision:/],
    [
      '缺 reason',
      (({ reason: _r, ...rest }) => rest)(verdictOf()),
      /\(root\): must have required properties reason/
    ],
    ["risk: 'LOW'", { ...verdictOf(), risk: 'LOW' }, /\/risk:/],
    ['summary: 42', { ...verdictOf(), summary: 42 }, /\/summary: must be string/],
    [
      '多出 confidence',
      { ...verdictOf(), confidence: 0.9 },
      /\(root\): must not have additional properties/
    ]
  ])(
    'DS-3 不合格（%s）→ isError、不带 details、错误点名那个字段',
    async (_label, params, pattern) => {
      const { message, captured } = await rejectionOf(params)
      expect(captured).toBe(false)
      expect(message).toMatch(pattern)
      // 纠正性引导：告诉模型改哪里、再调一次
      expect(message).toContain('call `next` again')
    }
  )

  it('DS-3 不合格之后改正 → 同一个工具实例照常捕获改正后的值', async () => {
    const tool = new NextTool(SPEC.schema)
    const rejected = await callNext(tool, { ...verdictOf(), decision: 'maybe' })
    expect(rejected.isError).toBe(true)
    expect(rejected.details).toBeUndefined()
    const corrected = await callNext(tool, verdictOf({ decision: 'deny' }))
    expect(corrected.details).toEqual({ result: verdictOf({ decision: 'deny' }) })
  })

  it('DS-4 5000 字的 summary / reason 照样捕获（schema 刻意不设长度上限）', async () => {
    const tool = new NextTool(SPEC.schema)
    const long = verdictOf({ summary: 's'.repeat(5000), reason: 'r'.repeat(5000) })
    const out = await callNext(tool, long)
    expect(out.details).toEqual({ result: long })
  })
})

describe('parse —— 认不出 = 这个 hook 没有意见', () => {
  it('DS-5 合格判决 → 等值对象', () => {
    const verdict = verdictOf({ decision: 'ask', risk: 'high' })
    expect(SPEC.parse(verdict)).toEqual(verdict)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ["字符串 'allow'", 'allow'],
    ["只有 {decision:'allow'}", { decision: 'allow' }],
    ['词汇外的 decision', { ...verdictOf(), decision: 'maybe' }],
    ['词汇外的 risk', { ...verdictOf(), risk: 'severe' }]
  ])('DS-5 %s → null，且不抛', (_label, value) => {
    expect(() => SPEC.parse(value)).not.toThrow()
    expect(SPEC.parse(value)).toBeNull()
  })
})

describe('severity —— 只看 decision', () => {
  const sev = (decision: PermissionVerdict['decision'], risk: PermissionVerdict['risk']): number =>
    SPEC.severity(verdictOf({ decision, risk }))

  it('DS-6 风险再高的 allow 也不如风险最低的 ask 严；ask 与 deny 同理', () => {
    expect(sev('allow', 'critical')).toBeLessThan(sev('ask', 'low'))
    expect(sev('ask', 'critical')).toBeLessThan(sev('deny', 'low'))
  })

  it.each(['allow', 'ask', 'deny'] as const)(
    'DS-6 decision %s 相同、risk 不同 → 严格程度相等',
    (decision) => {
      expect(sev(decision, 'low')).toBe(sev(decision, 'critical'))
      expect(sev(decision, 'medium')).toBe(sev(decision, 'high'))
    }
  )
})
