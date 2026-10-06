/**
 * WD —— `wrapDurableOutput`（durable 工具输出包装器的宿主无关内核）：超长输出的去处、落不落盘的
 * 逐次判断、`api.output()` 与「(no output)」、包装后工具的 `outputLimits`，以及一轮真的 pi-durable
 * （结果落进存储时模型看到的到底是什么）。
 *
 * 契约（迁移决定「Tools (#7)」、phase1-plan Verified fact 2）：
 *  - ShuviX 的落盘先于 durable 自己的截断做完；正文只留预览（≤ 200 行 / 10 KB）或内存截断后的文字，
 *    **落盘位置 / 截断说明不进正文**，作为 diagnostic 交回（`spilled` / `truncated`，severity info），
 *    durable 把诊断渲染成结果末尾的 `<harness>\n[info] …\n</harness>`；
 *  - 包装后的 `outputLimits` 让 durable 不再截已经截好的正文；
 *  - `spill: 'auto'` 按这次调用的 agent 工具表（`api.agent(context)`）里有没有 `read` 现判；
 *  - 工具没给 content、靠 `api.output()` 汇报时不补「(no output)」；
 *  - isError 结果原样交回。
 *
 * P1-06b：这些用例原在桌面的 wrapDurableTool.test.ts（编号不变），随内核搬到这里；落盘口换成内存表
 * （`memorySink`），「目录没建」改成「落盘口一次都没被写」。真 `tool_results/` 路径那一半留在桌面。
 * W-S1..S3 原在桌面的 wrapToolOutput.test.ts（「交给后处理的参数」），后处理现在在内核里调，一起搬来：
 * 原先断言的 `spill` / `sessionId` 换成「交没交落盘口」—— 会话归属绑在宿主的落盘口上，内核不知道。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Type } from 'typebox'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type ToolResultMessage
} from '@earendil-works/pi-ai'
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  ToolResultEntry,
  type Agent,
  type ToolDiagnostic,
  type ToolExecutionApi
} from '@earendil-works/pi-durable'
import { BaseTool } from '../../tools/baseTool'
import type { AnyTool } from '../../tools/toolResult'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '../../fileTools/truncate'
import { invokeTool, resultText, type InvokedToolResult } from '../../tools/testing/invokeTool'
import type { SpillSink } from '../spill'

/** 后处理照常调真实现，只把每次的入参记下来（W-S* 钉的就是「包装器交过去了什么」） */
const spy = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('../spill', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../spill')>()
  return {
    ...actual,
    processToolOutput: (opts: Parameters<typeof actual.processToolOutput>[0]) => {
      spy.calls.push({ ...opts })
      return actual.processToolOutput(opts)
    }
  }
})

import { wrapDurableOutput, type WrapDurableOutputOptions } from '../wrapDurableOutput'

beforeEach(() => {
  spy.calls = []
})

const byteLen = (s: string): number => new TextEncoder().encode(s).length
const lineCount = (s: string): number => s.split('\n').length

/** 3000 行、每行唯一（`<tag>-0000` …）—— 任何缺省上限下都必然超限 */
const big = (tag = 'L', lines = 3000): string =>
  Array.from({ length: lines }, (_, i) => `${tag}-${String(i).padStart(4, '0')}`).join('\n')

/** 预览上限（spill.ts 的 PREVIEW_MAX_*） */
const PREVIEW_MAX_LINES = 200
const PREVIEW_MAX_BYTES = 10 * 1024

/** 内存落盘口：locator = `mem://<prefix>/<spillId>.txt`，全文记在 files 里 */
function memorySink(prefix = 'wd'): {
  sink: SpillSink
  files: Map<string, string>
  writes: () => number
} {
  const files = new Map<string, string>()
  let writes = 0
  return {
    files,
    writes: () => writes,
    sink: {
      write: async (spillId, fullText) => {
        writes++
        const locator = `mem://${prefix}/${spillId}.txt`
        files.set(locator, fullText)
        return { locator }
      }
    }
  }
}

type Execute = AnyTool['execute']

/** 一个 durable 形状的探针工具（execute 由用例给） */
function probe(execute: Execute, extra: Record<string, unknown> = {}): AnyTool {
  return {
    name: 'probe',
    label: 'probe',
    description: 'probe tool',
    parameters: Type.Object({}),
    replay: 'unsafe',
    execute,
    ...extra
  } as unknown as AnyTool
}

/** 回给定文本块的探针 */
const textProbe = (...texts: string[]): AnyTool =>
  probe(async () => ({ content: texts.map((text) => ({ type: 'text' as const, text })) }))

/** api.agent 的替身：交出一张只含这些工具名的工具表，并数被问了几次 */
function agentWith(names: string[]): { agent: ToolExecutionApi['agent']; calls: () => number } {
  let calls = 0
  const agent: Agent = {
    thinkingLevel: 'off',
    extensions: [],
    tools: names.map((name) => ({ name }) as unknown as AnyTool),
    sections: []
  }
  return {
    agent: async () => {
      calls++
      return agent
    },
    calls: () => calls
  }
}

/** 缺省 spill:true + 一个内存落盘口 */
const wrap = (tool: AnyTool, opts: Partial<WrapDurableOutputOptions> = {}): AnyTool =>
  wrapDurableOutput(tool, { spill: true, sink: memorySink().sink, ...opts })

const run = async (
  tool: AnyTool,
  options: Parameters<typeof invokeTool>[2] = {}
): Promise<InvokedToolResult> => (await invokeTool(tool, {} as never, options)).result

const codes = (result: { diagnostics?: readonly ToolDiagnostic[] }): (string | undefined)[] =>
  (result.diagnostics ?? []).map((d) => d.code)

/** spilled 诊断里的落盘位置 */
const locatorOf = (d: ToolDiagnostic): string => {
  const m = /full output saved to (.+)\. Use the read tool \(not bash\) to view it\.$/.exec(
    d.message
  )
  expect(m, d.message).not.toBeNull()
  return m![1]
}

describe('WD 落盘位置走 diagnostics', () => {
  it('WD-1 spill:true、一段超长文本 → 正文里没有位置也没有表头；恰一条 info/spilled 诊断，写明行数、位置与「用 read（不是 bash）取」；落盘口里是全文', async () => {
    const mem = memorySink()
    const full = big('one')
    const result = await run(wrap(textProbe(full), { sink: mem.sink }), { callId: 'wd-1-call' })

    const text = resultText(result)
    expect(text).not.toContain('Output truncated')
    expect(text).not.toContain('saved to')
    expect(text).not.toContain('mem://')
    expect(text.startsWith('one-0000')).toBe(true)

    expect(result.diagnostics).toHaveLength(1)
    const [d] = result.diagnostics!
    expect(d.severity).toBe('info')
    expect(d.code).toBe('spilled')
    expect(d.message.startsWith('Output truncated: 3000 lines / ')).toBe(true)
    // 这次调用的 callId 就是落盘口收到的 id
    expect(locatorOf(d)).toBe('mem://wd/wd-1-call.txt')
    expect(mem.files.get(locatorOf(d))).toBe(full)
  })

  it('WD-2 预览恰在落盘预览上限内（≤ 200 行 / 10 KB）；包装后的 outputLimits 盖得住预览与内存截断的上限', async () => {
    const wrapped = wrap(textProbe(big()))
    const text = resultText(await run(wrapped))

    expect(lineCount(text)).toBeLessThanOrEqual(PREVIEW_MAX_LINES)
    expect(byteLen(text)).toBeLessThanOrEqual(PREVIEW_MAX_BYTES)
    const limits = wrapped.outputLimits!
    expect(limits.maxLines!).toBeGreaterThanOrEqual(DEFAULT_MAX_LINES)
    expect(limits.maxBytes!).toBeGreaterThanOrEqual(DEFAULT_MAX_BYTES)
  })

  it('WD-3 spill:false → 内存截断：正文 ≤ 工具上限、恰一条 info/truncated 诊断（说清留的是哪段、全文没留），不指路、落盘口一次都没写', async () => {
    const mem = memorySink()
    const result = await run(
      wrap(textProbe(big()), { sink: mem.sink, spill: false, strategy: 'keep-start' })
    )

    const text = resultText(result)
    expect(lineCount(text)).toBeLessThanOrEqual(DEFAULT_MAX_LINES)
    expect(byteLen(text)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
    expect(text.startsWith('L-0000')).toBe(true)
    expect(text).not.toContain('Output truncated')
    expect(result.diagnostics).toEqual([
      {
        severity: 'info',
        code: 'truncated',
        message: expect.stringMatching(
          /^Output truncated: 3000 lines \/ .+; showing the beginning only\. The full output was not kept\.$/
        )
      }
    ])
    expect(mem.writes()).toBe(0)
  })

  it('WD-3b 截断说明跟着策略说留下的是哪段：middle → beginning and end，keep-end → end', async () => {
    const middle = await run(wrap(textProbe(big()), { spill: false }))
    expect(middle.diagnostics?.[0].message).toContain('showing the beginning and end only')
    const end = await run(wrap(textProbe(big()), { spill: false, strategy: 'keep-end' }))
    expect(end.diagnostics?.[0].message).toContain('showing the end only')
    expect(resultText(end).endsWith('L-2999')).toBe(true)
  })

  it('WD-4 两段超长文本 → 两条 spilled 诊断、落盘口里两份全文，各指各的（第二段的 id 是 <callId>-2）', async () => {
    const mem = memorySink()
    const result = await run(wrap(textProbe(big('a'), big('b')), { sink: mem.sink }), {
      callId: 'wd-4-call'
    })
    expect(codes(result)).toEqual(['spilled', 'spilled'])
    const [a, b] = result.diagnostics!.map(locatorOf)
    expect([a, b]).toEqual(['mem://wd/wd-4-call.txt', 'mem://wd/wd-4-call-2.txt'])
    expect(mem.files.get(a)).toBe(big('a'))
    expect(mem.files.get(b)).toBe(big('b'))
  })

  it('WD-5 工具自己的诊断在前、截断说明在后；未超限的结果不多出 diagnostics 键', async () => {
    const own: ToolDiagnostic = { severity: 'warn', code: 'own', message: 'tool remark' }
    const tool = probe(async () => ({
      content: [{ type: 'text' as const, text: big() }],
      diagnostics: [own]
    }))
    const result = await run(wrap(tool))
    expect(codes(result)).toEqual(['own', 'spilled'])

    const small = await invokeTool(wrap(textProbe('fine')), {} as never)
    expect(small.result.diagnostics).toBeUndefined()
    expect(small.result.content).toEqual([{ type: 'text', text: 'fine' }])
  })

  it('WD-6 details 声明了 truncated / persisted 才合并（落盘 → 两个都 true）', async () => {
    const tool = probe(async () => ({
      content: [{ type: 'text' as const, text: big() }],
      details: { truncated: false, persisted: false, other: 1 }
    }))
    const result = await run(wrap(tool))
    expect(result.details).toEqual({ truncated: true, persisted: true, other: 1 })
  })

  it('WD-17 没给落盘口 → spill:true 也只在内存里截断（truncated）', async () => {
    const result = await run(wrapDurableOutput(textProbe(big()), { spill: true }))
    expect(codes(result)).toEqual(['truncated'])
  })
})

describe('WD spill:auto —— 按这次调用的 agent 工具表现判', () => {
  it('WD-7 工具表里有 read → 落盘（spilled、落盘口里有全文）', async () => {
    const mem = memorySink()
    const { agent } = agentWith(['read', 'probe'])
    const result = await run(wrap(textProbe(big()), { sink: mem.sink, spill: 'auto' }), {
      api: { agent }
    })
    expect(codes(result)).toEqual(['spilled'])
    expect(mem.files.get(locatorOf(result.diagnostics![0]))).toBe(big())
  })

  it('WD-8 工具表里没有 read → 内存截断（truncated），正文给到工具上限而不是预览上限，落盘口没写', async () => {
    const mem = memorySink()
    const { agent } = agentWith(['probe', 'ask'])
    const result = await run(wrap(textProbe(big()), { sink: mem.sink, spill: 'auto' }), {
      api: { agent }
    })
    expect(codes(result)).toEqual(['truncated'])
    expect(lineCount(resultText(result))).toBeGreaterThan(PREVIEW_MAX_LINES)
    expect(mem.writes()).toBe(0)
  })

  it('WD-9 同一个包装后的注册项挂在两张工具表下：每次调用各判各的', async () => {
    const wrapped = wrap(textProbe(big()), { spill: 'auto' })
    const withRead = await run(wrapped, { api: { agent: agentWith(['read']).agent } })
    const without = await run(wrapped, { api: { agent: agentWith(['grep']).agent } })
    expect(codes(withRead)).toEqual(['spilled'])
    expect(codes(without)).toEqual(['truncated'])
  })

  it('WD-10 没超限不问工具表；两段超长文本只问一次', async () => {
    const quiet = agentWith(['read'])
    await run(wrap(textProbe('short'), { spill: 'auto' }), { api: { agent: quiet.agent } })
    expect(quiet.calls()).toBe(0)

    const twice = agentWith(['read'])
    const result = await run(wrap(textProbe(big('x'), big('y')), { spill: 'auto' }), {
      api: { agent: twice.agent }
    })
    expect(codes(result)).toEqual(['spilled', 'spilled'])
    expect(twice.calls()).toBe(1)
  })

  it('WD-11 问工具表失败 → 当作不落盘（内存截断），调用照常成功', async () => {
    const mem = memorySink()
    const result = await run(wrap(textProbe(big()), { sink: mem.sink, spill: 'auto' }), {
      api: {
        agent: async () => {
          throw new Error('agent unavailable')
        }
      }
    })
    expect(result.isError).toBeUndefined()
    expect(codes(result)).toEqual(['truncated'])
    expect(mem.writes()).toBe(0)
  })
})

describe('WD api.output() 与「(no output)」', () => {
  it('WD-12 工具只经 api.output() 汇报、不给 content → 不补 (no output)：结果正文就是汇报的输出，且确实交到了外层 api', async () => {
    const tool = probe(async (_args, api) => {
      api.output('line one\n')
      api.output(new TextEncoder().encode('line two\n'))
      return {}
    })
    const inv = await invokeTool(wrap(tool), {} as never)

    expect(inv.output).toBe('line one\nline two\n')
    expect(inv.result.content).toEqual([{ type: 'text', text: 'line one\nline two\n' }])
    expect(resultText(inv.result)).not.toContain('(no output)')
  })

  it('WD-13 既没 content、也没汇报过看得见的输出（空白不算）→ (no output)', async () => {
    const silent = probe(async () => ({}))
    expect((await run(wrap(silent))).content).toEqual([{ type: 'text', text: '(no output)' }])

    const blank = probe(async (_args, api) => {
      api.output(' \n\t')
      return {}
    })
    expect((await run(wrap(blank))).content).toEqual([{ type: 'text', text: '(no output)' }])
  })

  it('WD-14 显式给了空 content（哪怕汇报过输出）→ (no output)：durable 只在 content 缺省时才拿留存的输出当正文', async () => {
    const tool = probe(async (_args, api) => {
      api.output('progress…\n')
      return { content: [] }
    })
    expect((await run(wrap(tool))).content).toEqual([{ type: 'text', text: '(no output)' }])
  })
})

describe('WD 失败结果与元数据', () => {
  it('WD-15 isError 结果原样交回：超长也不截、不落盘、不加诊断、不补 (no output)', async () => {
    const mem = memorySink()
    const failure = { isError: true, content: [{ type: 'text' as const, text: big() }] }
    const result = await run(
      wrap(
        probe(async () => failure),
        { sink: mem.sink }
      )
    )
    expect(result).toStrictEqual(failure)
    expect(mem.writes()).toBe(0)

    const empty = { isError: true, content: [] }
    expect(await run(wrap(probe(async () => empty)))).toStrictEqual(empty)
  })

  it('WD-18 工具抛错 → isError 结果、文字即错误消息（裁定 Q12）；调用已取消时照旧抛', async () => {
    const boom = probe(async () => {
      throw new Error('connection refused')
    })
    expect(await run(wrap(boom))).toStrictEqual({
      isError: true,
      content: [{ type: 'text', text: 'connection refused' }]
    })

    const ac = new AbortController()
    const err = new Error('Aborted')
    const cancelled = probe(async () => {
      ac.abort()
      throw err
    })
    await expect(run(wrap(cancelled), { signal: ac.signal })).rejects.toBe(err)
  })

  it('WD-16 元数据经原型链透出（getter 也在），execute 与 outputLimits 是包装器自己的 own 属性', () => {
    class Probe extends BaseTool {
      readonly name = 'probe'
      readonly label = 'Probe'
      readonly parameters = Type.Object({})
      readonly replay = 'safe' as const
      readonly outputStrategy = 'keep-end' as const
      readonly outputMaxBytes = 4096
      readonly outputMaxLines = 100
      get description(): string {
        return 'dynamic description'
      }
      async preExecute(): Promise<void> {
        /* no-op */
      }
      protected async securityCheck(): Promise<void> {
        /* no-op */
      }
      protected async executeInternal(): Promise<{ content: []; details: undefined }> {
        return { content: [], details: undefined }
      }
    }
    const tool = new Probe()
    const wrapped = wrapDurableOutput(tool, { spill: true })

    expect(wrapped.name).toBe('probe')
    expect(wrapped.description).toBe('dynamic description')
    expect(wrapped.replay).toBe('safe')
    expect(Object.prototype.hasOwnProperty.call(wrapped, 'execute')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(wrapped, 'outputLimits')).toBe(true)
    // 缺省策略与上限取工具自己的声明：留尾 → retain tail；上限是它的两倍（兜底）
    expect(wrapped.outputLimits).toEqual({ maxBytes: 8192, maxLines: 200, retain: 'tail' })
    // 显式给的上限 / 策略覆盖声明
    expect(
      wrapDurableOutput(tool, { spill: true, strategy: 'middle', maxBytes: 1000, maxLines: 10 })
        .outputLimits
    ).toEqual({ maxBytes: 2000, maxLines: 20, retain: 'head' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// W-S —— 截断 / 落盘参数的穿线（原在桌面 wrapToolOutput.test.ts）。
// 「落不落盘」是宿主**按 agent** 下的判断，内核是它唯一的通道：漏传一次，那个 agent 就会拿到一段
// 指向它没有的工具的预览。所以钉的是「每一个文本块都带着同一组参数过去」。
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_BLOCK = { type: 'image' as const, data: 'AAAABBBBCCCC', mimeType: 'image/png' }

/** 一次调用回「文本 + 图片 + 文本」—— 图片块不该进后处理 */
const multiBlockProbe = (): AnyTool =>
  probe(async () => ({
    content: [
      { type: 'text' as const, text: 'first block' },
      IMAGE_BLOCK,
      { type: 'text' as const, text: 'second block' }
    ]
  }))

describe('wrapDurableOutput — 截断 / 落盘参数的穿线', () => {
  it('W-S1 spill:false → 每个文本块都不带落盘口过去（原：都带 spill:false），说明一律不进正文；图片块直通不进后处理', async () => {
    const result = await run(wrap(multiBlockProbe(), { spill: false }), { callId: 'tc-s1' })

    expect(spy.calls).toHaveLength(2)
    expect(spy.calls.map((c) => c.fullText)).toEqual(['first block', 'second block'])
    for (const call of spy.calls) {
      expect(call.sink).toBeUndefined()
      expect(call.locatorInText).toBe(false)
    }
    // 图片原样待在原位
    expect(result.content[1]).toBe(IMAGE_BLOCK)
    expect(result.content).toHaveLength(3)
  })

  it('W-S2 三个覆写原样到达；首个文本块用的就是这一次的 callId，后面每段各自一个 id', async () => {
    await run(
      wrap(multiBlockProbe(), {
        strategy: 'keep-start',
        maxBytes: 4096,
        maxLines: 10,
        spill: false
      }),
      { callId: 'tc-s2' }
    )

    expect(spy.calls).toHaveLength(2)
    for (const call of spy.calls) {
      expect(call.maxBytes).toBe(4096)
      expect(call.maxLines).toBe(10)
      expect(call.strategy).toBe('keep-start')
    }
    // 第一段用本次调用 id；后面每段各自一个文件名，否则后一段会盖掉前一段的全文
    expect(spy.calls[0].toolCallId).toBe('tc-s2')
    expect(spy.calls[1].toolCallId).toBe('tc-s2-2')
  })

  it('W-S3 不传上限与策略 → 两个上限不凭空冒出来、策略 middle；spill:true 有落盘口（原：交 spill:true / undefined）', async () => {
    await run(wrap(textProbe('ran')), { callId: 'tc-s3' })

    expect(spy.calls).toHaveLength(1)
    expect(spy.calls[0].maxBytes).toBeUndefined()
    expect(spy.calls[0].maxLines).toBeUndefined()
    expect(spy.calls[0].strategy).toBe('middle')
    expect(spy.calls[0].sink).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WD-R —— 一轮真的 pi-durable：结果落进存储时，模型看到的就是落库的 toolResult 消息。
// 断言它的正文没被 durable 再截一刀（没有 durable 自己的 [warn] truncated），说明在末尾的
// `<harness>` 段里，结构化的诊断在 entry 的 data 上。
// ─────────────────────────────────────────────────────────────────────────────

const context = BACKGROUND_CONTEXT

/** 跑一轮：模型先调 probe、再收尾；交回落库的 toolResult 消息与它的诊断 */
async function durableRound(
  wrapped: AnyTool,
  others: AnyTool[] = []
): Promise<{ message: ToolResultMessage; diagnostics: ToolDiagnostic[] }> {
  const faux = fauxProvider({ models: [{ id: 'faux-1' }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(wrapped.name, {}, { id: 'call-probe' })], {
      stopReason: 'toolUse'
    }),
    fauxAssistantMessage([fauxText('done')])
  ])
  const registry = createRegistry()
  registry.install(defineExtension({ name: 'wd', tools: [wrapped, ...others] }))
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context)
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: 'faux', modelId: 'faux-1' } }
    })
    const submission = await root.submit({ type: 'input', content: 'go' }, context)
    const settled = await submission.wait(context)
    expect(settled.status).toBe('done')
    const page = await root.entries({}, 20, undefined, context)
    const record = page.items.find((entry) => entry.kind === ToolResultEntry.kind)
    expect(record, 'tool result entry').toBeDefined()
    const message = record!.model![0] as ToolResultMessage
    const data = record!.data as { diagnostics: ToolDiagnostic[] }
    return { message, diagnostics: data.diagnostics }
  } finally {
    await harness.close(context)
  }
}

/** 落库消息里的文本块 */
const textsOf = (message: ToolResultMessage): string[] =>
  message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))

/** 一个只为出现在工具表里的 read（spill:auto 据此判断） */
const readStub = defineTool({
  name: 'read',
  description: 'read stub',
  parameters: Type.Object({}),
  execute: async () => ({ content: [{ type: 'text', text: 'unused' }] })
}) as unknown as AnyTool

describe('WD-R 一轮真的 pi-durable', () => {
  it('WD-R1 spill:auto + 工具表里有 read：落库的正文就是预览（durable 没再截），末尾 <harness> 段写着 [info] 与落盘位置', async () => {
    const mem = memorySink('wd-r1')
    const wrapped = wrapDurableOutput(textProbe(big()), { sink: mem.sink, spill: 'auto' })

    const { message, diagnostics } = await durableRound(wrapped, [readStub])

    expect(diagnostics.map((d) => d.code)).toEqual(['spilled'])
    const texts = textsOf(message)
    expect(texts).toHaveLength(2)
    const [preview, harnessBlock] = texts
    expect(lineCount(preview)).toBeLessThanOrEqual(PREVIEW_MAX_LINES)
    expect(byteLen(preview)).toBeLessThanOrEqual(PREVIEW_MAX_BYTES)
    expect(preview.startsWith('L-0000')).toBe(true)
    expect(preview).not.toContain('saved to')
    const locator = locatorOf(diagnostics[0])
    expect(harnessBlock).toBe(`<harness>\n[info] ${diagnostics[0].message}\n</harness>`)
    expect(harnessBlock).toContain(locator)
    expect(harnessBlock).not.toContain('[warn]')
    expect(mem.files.get(locator)).toBe(big())
  })

  it('WD-R2 spill:auto + 没有 read：内存截断到工具上限，durable 照样不再截（没有它自己的 truncated 诊断）', async () => {
    const mem = memorySink('wd-r2')
    const wrapped = wrapDurableOutput(textProbe(big('m', 60_000)), {
      sink: mem.sink,
      spill: 'auto'
    })

    const { message, diagnostics } = await durableRound(wrapped)

    expect(diagnostics.map((d) => d.code)).toEqual(['truncated'])
    expect(diagnostics.every((d) => d.severity === 'info')).toBe(true)
    const [body] = textsOf(message)
    expect(lineCount(body)).toBeLessThanOrEqual(DEFAULT_MAX_LINES)
    expect(byteLen(body)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
    expect(mem.writes()).toBe(0)
  })

  it('WD-R4 工具上限高于 durable 的缺省（read 的 80 KB 那种）：截好的正文超过 50 KB，durable 也不再截 —— 靠的是包装后的 outputLimits', async () => {
    // 3000 行 × 40 字节 ≈ 120 KB：内存截断到 80 KB，正好落在 durable 缺省 50 KB 之上
    const line = (i: number): string => `${String(i).padStart(4, '0')}-${'x'.repeat(34)}`
    const text = Array.from({ length: 3000 }, (_, i) => line(i)).join('\n')
    const tool = probe(async () => ({ content: [{ type: 'text' as const, text }] }), {
      outputMaxBytes: 80 * 1024
    })
    const wrapped = wrapDurableOutput(tool, { spill: false })

    const { message, diagnostics } = await durableRound(wrapped)

    expect(diagnostics.map((d) => d.code)).toEqual(['truncated'])
    const [body, harnessBlock] = textsOf(message)
    expect(byteLen(body)).toBeGreaterThan(DEFAULT_MAX_BYTES)
    expect(byteLen(body)).toBeLessThanOrEqual(80 * 1024)
    expect(harnessBlock).not.toContain('[warn]')
  })

  it('WD-R3 只经 api.output() 汇报的工具：落库的正文是它的输出，不是 (no output)', async () => {
    const tool = probe(async (_args, api) => {
      api.output('streamed result\n')
      return {}
    })
    const { message } = await durableRound(wrapDurableOutput(tool, { spill: 'auto' }))
    expect(textsOf(message)).toEqual(['streamed result\n'])
  })
})
