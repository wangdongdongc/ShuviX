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
 *
 * 带图的提议（2026-11-01，docs/show-image-design.md §6）—— 宿主注入 `presentImages` 时每条才多一个 `image`：
 *   ST-5  没注入：项里的 image 当没有 —— 不报错、没有 `(with image)`、没有 details；描述与 schema 是不带图的那份
 *   ST-6  注入了：描述是 SUGGEST_DESCRIPTION_WITH_IMAGES（以 SUGGEST_DESCRIPTION 开头、提到 `image`）；schema 是
 *         SuggestParamsWithImagesSchema，项的键恰 {detail, image, message, title}、必填 {message, title}，条数上下限同
 *         SUGGEST_LIMITS；image 的描述说出格式清单与「not sent to you」
 *   ST-7  presenter 只调一次、只带有图的项、按顺序、路径 trim、label `suggestions[i].image`
 *   ST-8  details = {type:'suggest', images:[A, null, C]}；结果文字里带图的那条后面标 `(with image)`
 *   ST-9  注入了但没有一条带图 → 不调 presenter、没有 details、没有标记
 *   ST-10 image 是 '' / 空白 / 数字 / null → isError 点名 suggestions[1].image 与 non-empty string；不调 presenter
 *   ST-11 presenter 抛错 → isError，文字是它的消息；没有 details
 *   ST-12 先校验再快照：第 0 条图合法、第 1 条标题不合法 → isError，presenter 一次都没调
 *   ST-13 presenter 交回的比请求的少 → 缺的那格是 null、不标记（钉住现状）
 *   ST-14 包入口导出 SuggestParamsWithImagesSchema 与 SUGGEST_DESCRIPTION_WITH_IMAGES
 */
import { describe, expect, it, vi } from 'vitest'
import { SUGGEST_LIMITS, SUGGEST_TOOL_NAME } from '@shuvix/chat-protocol/suggestions'
import { SHOWN_IMAGE_FORMAT_NAMES } from '@shuvix/chat-protocol/shownImages'
import type { ShownImage } from '@shuvix/chat-protocol/types/chatMessage'
import * as runtime from '../index'
import {
  SUGGEST_DESCRIPTION,
  SUGGEST_DESCRIPTION_WITH_IMAGES,
  SuggestParamsSchema,
  SuggestParamsWithImagesSchema,
  createSuggestTool,
  type SuggestImagePresenter
} from '../suggestTool'
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

// ─── 带图的提议 ─────────────────────────────────────────

const shownA: ShownImage = {
  file: `${'a'.repeat(64)}.png`,
  source: '/w/a.png',
  mimeType: 'image/png',
  width: 40,
  height: 24,
  bytes: 100
}
const shownC: ShownImage = {
  file: `${'c'.repeat(64)}.jpg`,
  source: '/w/c.jpg',
  mimeType: 'image/jpeg',
  width: 10,
  height: 10,
  bytes: 50
}

/** 按请求逐个交回 A / C 的 presenter spy（交回的条数可以少给，见 ST-13） */
function presenter(
  images: ShownImage[] = [shownA, shownC]
): ReturnType<typeof vi.fn<SuggestImagePresenter>> {
  return vi.fn<SuggestImagePresenter>(async (requests) => images.slice(0, requests.length))
}

async function callWith(
  presentImages: SuggestImagePresenter | undefined,
  suggestions: unknown
): ReturnType<typeof invokeTool> {
  return invokeTool(createSuggestTool({ presentImages }), { suggestions } as never)
}

describe('ST-5 · 宿主不能摆图', () => {
  it('ST-5 项里带 image 当没有：不报错、没有 (with image)、没有 details', async () => {
    const { result } = await callWith(undefined, [
      { title: 'T1', message: 'M1', image: 'a.png' },
      { title: 'T2', message: 'M2', image: 7 }
    ])
    expect(result.isError).not.toBe(true)
    const text = resultText(result)
    expect(text).toContain('1. T1\n2. T2\n')
    expect(text).not.toContain('(with image)')
    expect(result.details).toBeUndefined()
  })

  it('ST-5 描述与 schema 是不带图的那份', () => {
    const tool = createSuggestTool()
    expect(tool.description).toBe(SUGGEST_DESCRIPTION)
    expect(tool.parameters).toBe(SuggestParamsSchema)
  })
})

describe('ST-6 · 宿主能摆图时的描述与 schema', () => {
  it('ST-6 描述以 SUGGEST_DESCRIPTION 开头、多一句提到 `image`', () => {
    const tool = createSuggestTool({ presentImages: presenter() })
    expect(tool.description).toBe(SUGGEST_DESCRIPTION_WITH_IMAGES)
    expect(SUGGEST_DESCRIPTION_WITH_IMAGES.startsWith(SUGGEST_DESCRIPTION)).toBe(true)
    expect(SUGGEST_DESCRIPTION_WITH_IMAGES.length).toBeGreaterThan(SUGGEST_DESCRIPTION.length)
    expect(SUGGEST_DESCRIPTION_WITH_IMAGES.slice(SUGGEST_DESCRIPTION.length)).toContain('`image`')
    expect(SUGGEST_DESCRIPTION).not.toContain('`image`')
  })

  it('ST-6 schema：项的键恰 {detail, image, message, title}，必填 {message, title}，条数上下限同 SUGGEST_LIMITS', () => {
    const tool = createSuggestTool({ presentImages: presenter() })
    expect(tool.parameters).toBe(SuggestParamsWithImagesSchema)
    const list = SuggestParamsWithImagesSchema.properties.suggestions
    const bounds = list as unknown as { minItems?: number; maxItems?: number }
    expect(bounds.minItems).toBe(1)
    expect(bounds.maxItems).toBe(SUGGEST_LIMITS.maxItems)
    expect(Object.keys(list.items.properties).sort()).toStrictEqual([
      'detail',
      'image',
      'message',
      'title'
    ])
    expect([...(list.items.required ?? [])].sort()).toStrictEqual(['message', 'title'])
  })

  it('ST-6 image 的描述说出格式清单，并说它不会发给模型', () => {
    // description 是 JSON Schema 的选项，typebox 的类型上不带它：按普通对象读
    const image = SuggestParamsWithImagesSchema.properties.suggestions.items.properties
      .image as unknown as { description?: string }
    const description = image.description ?? ''
    expect(description).toContain(SHOWN_IMAGE_FORMAT_NAMES)
    expect(description).toContain('not sent to you')
  })
})

describe('ST-7 / ST-8 · 摆图', () => {
  const ITEMS = [
    { title: 'T1', message: 'M1', image: '  a.png  ' },
    { title: 'T2', message: 'M2' },
    { title: 'T3', message: 'M3', image: 'c.png' }
  ]

  it('ST-7 presenter 只调一次，只带有图的项，按顺序、路径 trim、label 点名那一项', async () => {
    const spy = presenter()
    await callWith(spy, ITEMS)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toStrictEqual([
      { path: 'a.png', label: 'suggestions[0].image' },
      { path: 'c.png', label: 'suggestions[2].image' }
    ])
  })

  it('ST-8 details 与参数按下标对应（没带图的是 null）；带图的那条标 (with image)', async () => {
    const { result } = await callWith(presenter(), ITEMS)
    expect(result.isError).not.toBe(true)
    expect(result.details).toStrictEqual({ type: 'suggest', images: [shownA, null, shownC] })
    const text = resultText(result)
    expect(text).toContain('1. T1 (with image)\n2. T2\n3. T3 (with image)\n')
  })
})

describe('ST-9 · 注入了但没有一条带图', () => {
  it('ST-9 不调 presenter、没有 details、没有标记', async () => {
    const spy = presenter()
    const { result } = await callWith(spy, [ok(1), ok(2)])
    expect(spy).not.toHaveBeenCalled()
    expect(result.details).toBeUndefined()
    expect(resultText(result)).not.toContain('(with image)')
  })
})

describe('ST-10 · image 字段', () => {
  it.each<[string, unknown]>([
    ['空串', ''],
    ['只有空白', '   '],
    ['数字', 3],
    ['null', null]
  ])('ST-10 image 是 %s → isError 点名 suggestions[1].image，不调 presenter', async (_l, image) => {
    const spy = presenter()
    const text = await failureText(
      callWith(spy, [ok(1), { title: 'T', message: 'M', image }]).then((r) => r.result)
    )
    expect(text).toContain('suggestions[1].image')
    expect(text).toContain('non-empty string')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('ST-11 / ST-12 / ST-13 · 出错与边界', () => {
  it('ST-11 presenter 抛错 → isError，文字是它的消息；没有 details', async () => {
    const spy = vi.fn<SuggestImagePresenter>(async () => {
      throw new Error('suggestions[1].image: no such file: /x')
    })
    const { result } = await callWith(spy, [ok(1), { title: 'T', message: 'M', image: '/x' }])
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('suggestions[1].image: no such file: /x')
    expect(result.details).toBeUndefined()
  })

  it('ST-12 先校验再快照：第 0 条图合法、第 1 条标题不合法 → isError，presenter 一次都没调', async () => {
    const spy = presenter()
    const text = await failureText(
      callWith(spy, [
        { title: 'T', message: 'M', image: 'a.png' },
        { title: '', message: 'M' }
      ]).then((r) => r.result)
    )
    expect(text).toContain('suggestions[1].title')
    expect(spy).not.toHaveBeenCalled()
  })

  it('ST-13 presenter 交回的比请求的少 → 缺的那格是 null、不标记', async () => {
    const spy = presenter([shownA])
    const { result } = await callWith(spy, [
      { title: 'T1', message: 'M1', image: 'a.png' },
      { title: 'T2', message: 'M2', image: 'b.png' }
    ])
    expect(result.isError).not.toBe(true)
    expect(result.details).toStrictEqual({ type: 'suggest', images: [shownA, null] })
    const text = resultText(result)
    expect(text).toContain('1. T1 (with image)\n2. T2\n')
  })
})

describe('ST-14 · 包入口', () => {
  it('ST-14 导出带图的 schema 与描述', () => {
    expect(runtime.SuggestParamsWithImagesSchema).toBe(SuggestParamsWithImagesSchema)
    expect(runtime.SUGGEST_DESCRIPTION_WITH_IMAGES).toBe(SUGGEST_DESCRIPTION_WITH_IMAGES)
  })
})
