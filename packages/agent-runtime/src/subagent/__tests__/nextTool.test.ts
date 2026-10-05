/**
 * NextTool —— 结果契约协议的工具侧：schema 校验挡回、一次性捕获、契约段文案、结果读回。
 *
 * 这里钉的是「结果即参数」的可信度：校验失败**必须交回失败结果且不带 details**（模型同轮
 * 看到字段级指正后重试，重试的才是结果）；捕获成功后的重复调用**必须温和拒绝**（并联
 * 双发防护）。错误文案遵循 5250adc 的纠正性引导纪律 —— 说清哪个字段、期望什么、
 * 下一步做什么（call `next` again），而不是一句 invalid。
 *
 * P1-04（pi-durable）：工具经 durable 的 `execute(args, api, context)` 调（测试里经 invokeTool）；
 * 校验失败从「抛错」变成 BaseTool 模板收口的 isError 结果（裁定 Q12，模型看到的文字不变），
 * 收尾从结果上的 `terminate` 变成 `control: { terminate: true }`。
 *
 * P2-02：没有回调了 —— 结果只在返回值的 `details: {result}` 里（从不经 `api.details()`，PIN-04），
 * 转写条目经 `nextResultOf` 读回。用例编号 P2-02-16…20。
 */
import type { JsonValue } from '@earendil-works/chord'
import type { ConversationId, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import {
  NextTool,
  buildResultContractNote,
  nextResultOf,
  validateContractSchema,
  NEXT_TOOL_NAME
} from '../nextTool'
import { invokeTool, type InvokedToolResult } from '../../tools/testing/invokeTool'

const TITLE_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string' } }
}

const RECORDED = 'Result recorded — the task is complete. Do not call any more tools.'
const ALREADY_RECORDED =
  'Result already recorded — the task is complete. Do not call any more tools.'

describe('validateContractSchema — 派发前的契约自检', () => {
  it.each([
    ['null', null],
    ['数组', [] as unknown],
    ['字符串', 'nope']
  ])('%s → must be a JSON Schema object', (_label, schema) => {
    expect(validateContractSchema(schema)).toContain('must be a JSON Schema object')
  })

  it('缺 type / type:array → 消息含 wrap scalars as {result: …}（指路而非拒绝了事）', () => {
    expect(validateContractSchema({})).toContain('wrap scalars as {result: …}')
    expect(validateContractSchema({ type: 'array' })).toContain('wrap scalars as {result: …}')
  })

  it('{type: object} 最小合法 → null', () => {
    expect(validateContractSchema({ type: 'object' })).toBeNull()
  })
})

describe('buildResultContractNote — prompt 末尾契约段', () => {
  it('带 sourceLabel → 点名来源 + 开闭标签 + exactly once + NOT returned 警示', () => {
    const note = buildResultContractNote({ schema: TITLE_SCHEMA, sourceLabel: 'wf' })
    expect(note).toContain('one step of an automated flow ("wf")')
    // workflow 引擎退役后不再自称 workflow
    expect(note).not.toContain('workflow')
    expect(note.startsWith('<result_contract>')).toBe(true)
    expect(note.endsWith('</result_contract>')).toBe(true)
    expect(note).toContain('exactly once')
    expect(note).toContain('NOT returned to the caller')
  })

  it('无 sourceLabel → 通用来源文案', () => {
    expect(buildResultContractNote({ schema: TITLE_SCHEMA })).toContain(
      'one step of a larger automated flow'
    )
  })
})

describe('NextTool — 结果在 details 里（P2-02）', () => {
  const textOf = (r: InvokedToolResult): string =>
    r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
  const run = async (
    tool: NextTool,
    params: Record<string, unknown>,
    callId = 't1'
  ): Promise<InvokedToolResult> => (await invokeTool(tool, params, { callId })).result
  /** durable 会为这次结果写下的 `pi.tool-result` 条目（appendToolResult 的形状） */
  const entryOf = (result: InvokedToolResult, toolName = NEXT_TOOL_NAME): EntryRecord => ({
    id: 7 as EntryId,
    conversationId: 2 as ConversationId,
    kind: 'pi.tool-result',
    model: [
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName,
        content: result.content,
        ...(result.details === undefined ? {} : { details: result.details as JsonValue }),
        isError: result.isError ?? false,
        timestamp: 0
      }
    ],
    data: { diagnostics: [] }
  })

  it('P2-02-16 success → details {result: 参数的拷贝}、control.terminate、确认文案；从不经 api.details()', async () => {
    const params = { title: 'Fix login bug' }
    const inv = await invokeTool(new NextTool(TITLE_SCHEMA), params, { callId: 't1' })
    expect(inv.result.details).toEqual({ result: { title: 'Fix login bug' } })
    // 只调了 next 的那一批，durable 据此结束循环、不再发下一次请求
    expect(inv.result.control).toEqual({ terminate: true })
    expect(textOf(inv.result)).toBe(RECORDED)
    expect(inv.result.isError).toBeUndefined()
    // 旧形状的顶层 terminate 不再出现
    expect('terminate' in inv.result).toBe(false)
    // 被中断的调用由 durable 按槽位里的 details 结算 —— 结果绝不早早进槽位
    expect(inv.details).toEqual([])
    params.title = 'mutated'
    expect((inv.result.details as { result: { title: string } }).result.title).toBe('Fix login bug')
  })

  it('P2-02-17 schema violation → isError、字段级指正、不带 details / control；同一实例改正后照常捕获', async () => {
    const tool = new NextTool(TITLE_SCHEMA)
    const bad = await run(tool, {})
    expect(bad.isError).toBe(true)
    expect(textOf(bad)).toMatch(/\(root\): must have required properties title/)
    expect(textOf(bad)).toMatch(/call `next` again/)
    expect('details' in bad).toBe(false)
    // 失败的一次不收尾：模型还得改了再调
    expect(bad.control).toBeUndefined()

    const ok = await run(tool, { title: 'ok now' }, 't2')
    expect(ok.details).toEqual({ result: { title: 'ok now' } })
    expect(textOf(ok)).toBe(RECORDED)
  })

  it('P2-02-17 nested constraints (minimum / enum) are checked in full; the rejection carries no details', async () => {
    const schema = {
      type: 'object',
      required: ['level'],
      properties: {
        level: { type: 'integer', minimum: 1 },
        kind: { enum: ['a', 'b'] }
      }
    }
    const tool = new NextTool(schema)
    const rejected = await run(tool, { level: 0, kind: 'c' })
    expect(rejected.isError).toBe(true)
    expect(textOf(rejected)).toMatch(/\/level: must be >= 1/)
    expect('details' in rejected).toBe(false)

    const ok = await run(tool, { level: 3, kind: 'a' }, 't2')
    expect(ok.details).toEqual({ result: { level: 3, kind: 'a' } })
  })

  it('P2-02-17 at most 8 detail lines (12 violations → exactly 8)', async () => {
    const properties: Record<string, unknown> = {}
    const bad: Record<string, unknown> = {}
    for (let i = 0; i < 12; i++) {
      properties[`k${i}`] = { type: 'string' }
      bad[`k${i}`] = i
    }
    const out = await run(new NextTool({ type: 'object', properties }), bad)
    expect(out.isError).toBe(true)
    const detailLines = textOf(out)
      .split('\n')
      .filter((l) => l.startsWith('  - '))
    expect(detailLines).toHaveLength(8)
  })

  it('P2-02-18 duplicate after a capture → already recorded、terminate、没有 details 键；新实例照常捕获（守卫按实例）', async () => {
    const tool = new NextTool(TITLE_SCHEMA)
    await run(tool, { title: 'first' })
    const again = await run(tool, { title: 'second' }, 't2')
    expect(textOf(again)).toContain('already recorded')
    expect(textOf(again)).toBe(ALREADY_RECORDED)
    // 同批两次 next：第二次也带 terminate，整批才满足「全部 terminate」
    expect(again.control).toEqual({ terminate: true })
    expect('details' in again).toBe(false)
    expect(nextResultOf(entryOf(again))).toBeUndefined()

    const fresh = await run(new NextTool(TITLE_SCHEMA), { title: 'third' }, 't3')
    expect(fresh.details).toEqual({ result: { title: 'third' } })
  })

  it('P2-02-19 one-argument constructor; replay unsafe; name / label next; parameters pass the schema through; description says exactly once', () => {
    const tool = new NextTool(TITLE_SCHEMA)
    // @ts-expect-error —— 捕获回调没有了：结果在 details 里
    void new NextTool(TITLE_SCHEMA, () => {})
    expect(tool.replay).toBe('unsafe')
    expect(tool.name).toBe(NEXT_TOOL_NAME)
    expect(tool.name).toBe('next')
    expect(tool.label).toBe('next')
    const p = tool.parameters as unknown as Record<string, unknown>
    expect(p.type).toBe('object')
    expect(p.required).toEqual(['title'])
    expect(p.properties).toEqual({ title: { type: 'string' } })
    expect(tool.description).toContain('exactly once')
  })

  describe('P2-02-20 nextResultOf(entry)', () => {
    const entry = (message: Record<string, unknown>, kind = 'pi.tool-result'): EntryRecord =>
      ({
        id: 3 as EntryId,
        conversationId: 2 as ConversationId,
        kind,
        model: [
          {
            role: 'toolResult',
            toolCallId: 'c1',
            toolName: 'next',
            content: [{ type: 'text', text: RECORDED }],
            isError: false,
            timestamp: 0,
            ...message
          }
        ]
      }) as EntryRecord

    it('a successful next result → its result object', () => {
      expect(nextResultOf(entry({ details: { result: { title: 'a' } } }))).toEqual({ title: 'a' })
    })

    it('extra keys next to result are tolerated (a host review may add them)', () => {
      expect(
        nextResultOf(entry({ details: { result: { title: 'a' }, review: { decision: 'allow' } } }))
      ).toEqual({ title: 'a' })
    })

    it.each([
      [
        'isError with details.result (interrupted / fromSlot)',
        { isError: true, details: { result: { title: 'a' } } }
      ],
      ["another tool ('probe')", { toolName: 'probe', details: { result: { title: 'a' } } }],
      ['no details', {}],
      ["details.result 'x'", { details: { result: 'x' } }],
      ['details.result null', { details: { result: null } }],
      ['details.result [1]', { details: { result: [1] } }]
    ])('%s → undefined', (_label, message) => {
      expect(nextResultOf(entry(message))).toBeUndefined()
    })

    it('an entry of another kind (pi.assistant) → undefined', () => {
      expect(
        nextResultOf(entry({ details: { result: { title: 'a' } } }, 'pi.assistant'))
      ).toBeUndefined()
    })

    it('the value is a copy, not shared with the entry', () => {
      const e = entry({ details: { result: { title: 'a' } } })
      const value = nextResultOf(e)!
      value.title = 'changed'
      expect(nextResultOf(e)).toEqual({ title: 'a' })
    })
  })
})
