/**
 * suggest 工具（suggestTool.ts，2026-10-25）—— pi-durable 原生注册项。工具只校验参数、立刻交回一段结果；卡片由
 * chat-ui 按调用参数画，采纳走宿主的 `suggestion:accept`。
 *
 *   ST-1 条数：0 条 / 4 条 / suggestions 不是数组 → isError，文字说出上限（at least one / at most 3）；1 条与 3 条照常
 *   ST-2 字段：title / message 为空、只有空白、不是字符串，detail 给了却是空白 / 不是字符串 → isError，文字点名
 *        `suggestions[i].<field>`；恰好 80 / 1000 / 300 个字符照常，多一个就报错并说出两个数（实际长度与上限）；
 *        detail 不给照常
 *   ST-3 结果文字：单复数（1 suggestion / 2 suggestions）、按序编号的标题、「Do not wait」；没有 details
 *   ST-4 注册项形状：name `suggest`、`replay: 'safe'`、label 缺省 'Suggest' 可由宿主换、描述与 schema、
 *        schema 的条数上下限与 SUGGEST_LIMITS 一致；从包入口导出
 */
import { describe, expect, it } from 'vitest'
import { SUGGEST_LIMITS, SUGGEST_TOOL_NAME } from '@shuvix/chat-protocol/suggestions'
import * as runtime from '../index'
import { SUGGEST_DESCRIPTION, SuggestParamsSchema, createSuggestTool } from '../suggestTool'
import { failureText, invokeTool, resultText } from '../tools/testing/invokeTool'

type Item = { title?: unknown; message?: unknown; detail?: unknown }

const ok = (n: number): Item => ({ title: `Title ${n}`, message: `Message ${n}` })

/** 调一次工具（参数不经 schema 校验，直达 execute 里的检查） */
async function call(suggestions: unknown): ReturnType<typeof invokeTool> {
  return invokeTool(createSuggestTool(), { suggestions } as never)
}

const fails = async (suggestions: unknown): Promise<string> =>
  failureText(call(suggestions).then((r) => r.result))

describe('ST-1 · 条数', () => {
  it('ST-1 0 条 → isError，说「至少一条」', async () => {
    expect(await fails([])).toContain('at least one')
  })

  it('ST-1 4 条（每条都合法）→ isError，说出条数与上限', async () => {
    const text = await fails([ok(1), ok(2), ok(3), ok(4)])
    expect(text).toContain('4 suggestions')
    expect(text).toContain(`at most ${SUGGEST_LIMITS.maxItems}`)
  })

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['对象', { title: 'x', message: 'y' }],
    ['字符串', 'x']
  ])('ST-1 suggestions 是 %s → isError', async (_label, value) => {
    expect(await fails(value)).toContain('at least one')
  })

  it.each([1, 3])('ST-1 %i 条 → 照常（不是 isError）', async (n) => {
    const { result } = await call(Array.from({ length: n }, (_, i) => ok(i + 1)))
    expect(result.isError).not.toBe(true)
  })
})

describe('ST-2 · 字段', () => {
  it.each<[string, Item, string]>([
    ['title 空串', { title: '', message: 'm' }, 'title'],
    ['title 只有空白', { title: ' \n\t', message: 'm' }, 'title'],
    ['title 是数字', { title: 7, message: 'm' }, 'title'],
    ['title 缺省', { message: 'm' }, 'title'],
    ['message 空串', { title: 't', message: '' }, 'message'],
    ['message 只有空白', { title: 't', message: '   ' }, 'message'],
    ['message 是对象', { title: 't', message: { text: 'm' } }, 'message'],
    ['message 缺省', { title: 't' }, 'message'],
    ['detail 给了却是空串', { title: 't', message: 'm', detail: '' }, 'detail'],
    ['detail 只有空白', { title: 't', message: 'm', detail: '  ' }, 'detail'],
    ['detail 是 null', { title: 't', message: 'm', detail: null }, 'detail'],
    ['detail 是数字', { title: 't', message: 'm', detail: 3 }, 'detail']
  ])('ST-2 %s → isError 点名 suggestions[i].%s', async (_label, bad, field) => {
    // 坏项放在第二条：点名带的是它的下标
    const text = await fails([ok(1), bad])
    expect(text).toContain(`suggestions[1].${field}`)
    expect(text).toContain('non-empty string')
  })

  it.each([null, 'item', 5])('ST-2 一项不是对象（%o）→ isError 点名那一项', async (item) => {
    expect(await fails([item])).toContain('suggestions[0].')
  })

  it('ST-2 detail 不给照常', async () => {
    const { result } = await call([{ title: 't', message: 'm' }])
    expect(result.isError).not.toBe(true)
  })

  it.each([
    ['title', SUGGEST_LIMITS.title],
    ['message', SUGGEST_LIMITS.message],
    ['detail', SUGGEST_LIMITS.detail]
  ] as const)('ST-2 %s 恰好 %i 字照常，多一个字就报错并说出两个数', async (field, max) => {
    const at: Item = { title: 't', message: 'm', detail: 'd', [field]: 'x'.repeat(max) }
    const { result } = await call([at])
    expect(result.isError, `${field} at ${max}`).not.toBe(true)

    const over: Item = { title: 't', message: 'm', detail: 'd', [field]: 'x'.repeat(max + 1) }
    const text = await fails([ok(1), ok(2), over])
    expect(text).toContain(`suggestions[2].${field}`)
    expect(text).toContain(`${max + 1} characters`)
    expect(text).toContain(`at most ${max}`)
  })

  it('ST-2 长度按 JS 字符数（UTF-16）算：80 个汉字照常', async () => {
    const { result } = await call([{ title: '提'.repeat(SUGGEST_LIMITS.title), message: 'm' }])
    expect(result.isError).not.toBe(true)
  })
})

describe('ST-3 · 结果文字', () => {
  it('ST-3 一条：单数，标题编号 1.', async () => {
    const { result } = await call([{ title: 'Add tests', message: 'Yes, add tests' }])
    const text = resultText(result)
    expect(text).toContain('Shown 1 suggestion to the user')
    expect(text).not.toContain('1 suggestions')
    expect(text).toContain('1. Add tests')
    expect(text).toContain('Do not wait')
    // 交回给模型的是标题，不是采纳时要发的那句话
    expect(text).not.toContain('Yes, add tests')
  })

  it('ST-3 三条：复数，按参数顺序逐行编号；没有 details', async () => {
    const { result } = await call([
      { title: 'Add tests', message: 'm1' },
      { title: 'Update docs', message: 'm2', detail: 'why' },
      { title: 'Ship it', message: 'm3' }
    ])
    const text = resultText(result)
    expect(text).toContain('Shown 3 suggestions to the user:')
    expect(text).toContain('1. Add tests\n2. Update docs\n3. Ship it\n')
    expect(text).toContain('Do not wait')
    expect(text).toContain('do not list them again in your reply')
    expect(result.details).toBeUndefined()
  })

  it('ST-3 两条：复数', async () => {
    expect(resultText((await call([ok(1), ok(2)])).result)).toContain('Shown 2 suggestions')
  })
})

describe('ST-4 · 注册项形状', () => {
  it("ST-4 name / replay safe / label（缺省 'Suggest' 与宿主给的）/ 描述 / schema", () => {
    const tool = createSuggestTool()
    expect(tool).toMatchObject({
      name: SUGGEST_TOOL_NAME,
      label: 'Suggest',
      replay: 'safe',
      description: SUGGEST_DESCRIPTION,
      parameters: SuggestParamsSchema
    })
    expect(tool.name).toBe('suggest')
    expect(createSuggestTool({ label: '提议' }).label).toBe('提议')
  })

  it('ST-4 schema 的条数上下限与 SUGGEST_LIMITS 一致；必填 title / message，detail 可选', () => {
    const list = SuggestParamsSchema.properties.suggestions
    // 条数上下限是 JSON Schema 的选项，typebox 的类型上不带它们：按普通对象读
    const bounds = list as unknown as { minItems?: number; maxItems?: number }
    expect(bounds.minItems).toBe(1)
    expect(bounds.maxItems).toBe(SUGGEST_LIMITS.maxItems)
    expect([...(list.items.required ?? [])].sort()).toStrictEqual(['message', 'title'])
    expect(Object.keys(list.items.properties).sort()).toStrictEqual(['detail', 'message', 'title'])
  })

  it('ST-4 描述说出上限、不阻塞、与 ask 的分工', () => {
    expect(SUGGEST_DESCRIPTION).toContain(`up to ${SUGGEST_LIMITS.maxItems} suggestions`)
    expect(SUGGEST_DESCRIPTION).toContain('It does not wait')
    expect(SUGGEST_DESCRIPTION).toContain('use ask')
  })

  it('ST-4 从包入口导出', () => {
    expect(runtime.createSuggestTool).toBe(createSuggestTool)
    expect(runtime.SuggestParamsSchema).toBe(SuggestParamsSchema)
    expect(runtime.SUGGEST_DESCRIPTION).toBe(SUGGEST_DESCRIPTION)
  })
})
