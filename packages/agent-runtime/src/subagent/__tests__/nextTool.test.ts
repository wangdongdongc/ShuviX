/**
 * NextTool —— 结果契约协议的工具侧：schema 校验挡回、一次性捕获、契约段文案。
 *
 * 这里钉的是「结果即参数」的可信度：校验失败**必须交回失败结果且不置 captured**（模型同轮
 * 看到字段级指正后重试，重试的才是结果）；捕获成功后的重复调用**必须温和拒绝**（并联
 * 双发防护）。错误文案遵循 5250adc 的纠正性引导纪律 —— 说清哪个字段、期望什么、
 * 下一步做什么（call `next` again），而不是一句 invalid。
 *
 * P1-04（pi-durable）：工具经 durable 的 `execute(args, api, context)` 调（测试里经 invokeTool）；
 * 校验失败从「抛错」变成 BaseTool 模板收口的 isError 结果（裁定 Q12，模型看到的文字不变），
 * 收尾从结果上的 `terminate` 变成 `control: { terminate: true }`。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  NextTool,
  buildResultContractNote,
  validateContractSchema,
  NEXT_TOOL_NAME
} from '../nextTool'
import { invokeTool, type InvokedToolResult } from '../../tools/testing/invokeTool'

const TITLE_SCHEMA = {
  type: 'object',
  required: ['title'],
  properties: { title: { type: 'string' } }
}

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

describe('NextTool — 经 BaseTool 模板 execute 的捕获协议', () => {
  const textOf = (r: InvokedToolResult): string =>
    r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
  const run = async (
    tool: NextTool,
    params: Record<string, unknown>,
    callId = 't1'
  ): Promise<InvokedToolResult> => (await invokeTool(tool, params, { callId })).result

  it('合法参数 → onCapture 收到原参数、返回文本含 Result recorded、带 control.terminate', async () => {
    const onCapture = vi.fn()
    const tool = new NextTool(TITLE_SCHEMA, onCapture)
    const params = { title: 'Fix login bug' }
    const out = await run(tool, params)
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(onCapture).toHaveBeenCalledWith(params)
    expect(textOf(out)).toContain('Result recorded')
    expect(out.isError).toBeUndefined()
    // 只调了 next 的那一批，durable 据此结束循环、不再发下一次请求
    expect(out.control).toEqual({ terminate: true })
    // 旧形状的顶层 terminate 不再出现
    expect('terminate' in out).toBe(false)
  })

  it('缺 required 字段 → isError 结果（原 throw），文字含字段位置与期望、含 call `next` again', async () => {
    const tool = new NextTool(TITLE_SCHEMA, vi.fn())
    const out = await run(tool, {})
    expect(out.isError).toBe(true)
    expect(textOf(out)).toMatch(/call `next` again/)
    expect(textOf(out)).toMatch(/\(root\): must have required properties title/)
    // 失败的一次不收尾：模型还得改了再调
    expect(out.control).toBeUndefined()
  })

  it('校验失败不置 captured：先非法调用（isError）后合法调用仍能捕获', async () => {
    const onCapture = vi.fn()
    const tool = new NextTool(TITLE_SCHEMA, onCapture)
    expect((await run(tool, { title: 42 })).isError).toBe(true)
    expect(onCapture).not.toHaveBeenCalled()

    const out = await run(tool, { title: 'ok now' }, 't2')
    expect(onCapture).toHaveBeenCalledTimes(1)
    expect(onCapture).toHaveBeenCalledWith({ title: 'ok now' })
    expect(textOf(out)).toContain('Result recorded')
  })

  it('重复调用防护：捕获后二次 execute → already recorded 文本、onCapture 恰一次', async () => {
    const onCapture = vi.fn()
    const tool = new NextTool(TITLE_SCHEMA, onCapture)
    await run(tool, { title: 'first' })
    const again = await run(tool, { title: 'second' }, 't2')
    expect(textOf(again)).toContain('already recorded')
    expect(onCapture).toHaveBeenCalledTimes(1)
    // 同批两次 next：第二次也带 terminate，整批才满足「全部 terminate」
    expect(again.control).toEqual({ terminate: true })
  })

  it('错误明细上限 8 条（12 处违例 → 恰 8 行明细）', async () => {
    const properties: Record<string, unknown> = {}
    const bad: Record<string, unknown> = {}
    for (let i = 0; i < 12; i++) {
      properties[`k${i}`] = { type: 'string' }
      bad[`k${i}`] = i
    }
    const tool = new NextTool({ type: 'object', properties }, vi.fn())
    const out = await run(tool, bad)
    expect(out.isError).toBe(true)
    const detailLines = textOf(out)
      .split('\n')
      .filter((l) => l.startsWith('  - '))
    expect(detailLines).toHaveLength(8)
  })

  it('parameters 即传入 schema 原样透传（required/properties 可从 tool.parameters 读回）', () => {
    const tool = new NextTool(TITLE_SCHEMA, vi.fn())
    const p = tool.parameters as unknown as Record<string, unknown>
    expect(p.type).toBe('object')
    expect(p.required).toEqual(['title'])
    expect(p.properties).toEqual({ title: { type: 'string' } })
  })

  it('name/label 恒 next、description 含 exactly once', () => {
    const tool = new NextTool(TITLE_SCHEMA, vi.fn())
    expect(tool.name).toBe(NEXT_TOOL_NAME)
    expect(tool.name).toBe('next')
    expect(tool.label).toBe('next')
    expect(tool.description).toContain('exactly once')
  })

  it('嵌套约束生效（properties 内 minimum/enum 违例也被完整校验拦下）', async () => {
    const schema = {
      type: 'object',
      required: ['level'],
      properties: {
        level: { type: 'integer', minimum: 1 },
        kind: { enum: ['a', 'b'] }
      }
    }
    const onCapture = vi.fn()
    const tool = new NextTool(schema, onCapture)
    const rejected = await run(tool, { level: 0, kind: 'c' })
    expect(rejected.isError).toBe(true)
    expect(textOf(rejected)).toMatch(/\/level: must be >= 1/)
    expect(onCapture).not.toHaveBeenCalled()

    await run(tool, { level: 3, kind: 'a' }, 't2')
    expect(onCapture).toHaveBeenCalledWith({ level: 3, kind: 'a' })
  })
})
