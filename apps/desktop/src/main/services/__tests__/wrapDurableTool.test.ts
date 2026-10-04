/**
 * WD —— `wrapDurableTool`：超长输出的去处、落不落盘的逐次判断、`api.output()` 与「(no output)」、
 * 包装后工具的 `outputLimits`，以及一轮真的 pi-durable（结果落进存储时模型看到的到底是什么）。
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
 * 只桩 electron 的 userData（落盘走真实的 utils/paths.ts → tool_results/<sid>/）。
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
import { BaseTool, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type AnyTool } from '@shuvix/agent-runtime'
import {
  invokeTool,
  resultText,
  type InvokedToolResult
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const USER_DATA_DIR = join(tmpdir(), `shuvix-wd-test-${Date.now()}`)

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA_DIR, getVersion: () => '9.9.9' }
}))
vi.mock('../toolContext', () => ({ TOOL_ABORTED: 'Aborted' }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { wrapDurableTool, type WrapDurableToolOptions } from '../wrapToolOutput'

afterAll(() => rmSync(USER_DATA_DIR, { recursive: true, force: true }))

const resultsDir = (sid: string): string => join(USER_DATA_DIR, 'tool_results', sid)
const byteLen = (s: string): number => new TextEncoder().encode(s).length
const lineCount = (s: string): number => s.split('\n').length

/** 3000 行、每行唯一（`<tag>-0000` …）—— 任何缺省上限下都必然超限 */
const big = (tag = 'L', lines = 3000): string =>
  Array.from({ length: lines }, (_, i) => `${tag}-${String(i).padStart(4, '0')}`).join('\n')

/** 预览上限（spill.ts 的 PREVIEW_MAX_*） */
const PREVIEW_MAX_LINES = 200
const PREVIEW_MAX_BYTES = 10 * 1024

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

const wrap = (
  tool: AnyTool,
  opts: Partial<WrapDurableToolOptions> & { sessionId: string }
): AnyTool => wrapDurableTool(tool, { spill: true, ...opts })

const run = async (
  tool: AnyTool,
  options: Parameters<typeof invokeTool>[2] = {}
): Promise<InvokedToolResult> => (await invokeTool(tool, {} as never, options)).result

const codes = (result: { diagnostics?: readonly ToolDiagnostic[] }): (string | undefined)[] =>
  (result.diagnostics ?? []).map((d) => d.code)

/** spilled 诊断里的落盘路径 */
const locatorOf = (d: ToolDiagnostic): string => {
  const m = /full output saved to (.+)\. Use the read tool \(not bash\) to view it\.$/.exec(
    d.message
  )
  expect(m, d.message).not.toBeNull()
  return m![1]
}

describe('WD 落盘位置走 diagnostics', () => {
  it('WD-1 spill:true、一段超长文本 → 正文里没有路径也没有表头；恰一条 info/spilled 诊断，写明行数、路径与「用 read（不是 bash）取」；盘上是全文', async () => {
    const sid = 'wd-1'
    const full = big('one')
    const result = await run(wrap(textProbe(full), { sessionId: sid }), { callId: 'wd-1-call' })

    const text = resultText(result)
    expect(text).not.toContain('Output truncated')
    expect(text).not.toContain('saved to')
    expect(text).not.toContain(resultsDir(sid))
    expect(text.startsWith('one-0000')).toBe(true)

    expect(result.diagnostics).toHaveLength(1)
    const [d] = result.diagnostics!
    expect(d.severity).toBe('info')
    expect(d.code).toBe('spilled')
    expect(d.message.startsWith('Output truncated: 3000 lines / ')).toBe(true)
    const path = locatorOf(d)
    expect(path.startsWith(resultsDir(sid))).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe(full)
  })

  it('WD-2 预览恰在落盘预览上限内（≤ 200 行 / 10 KB）；包装后的 outputLimits 盖得住预览与内存截断的上限', async () => {
    const wrapped = wrap(textProbe(big()), { sessionId: 'wd-2' })
    const text = resultText(await run(wrapped))

    expect(lineCount(text)).toBeLessThanOrEqual(PREVIEW_MAX_LINES)
    expect(byteLen(text)).toBeLessThanOrEqual(PREVIEW_MAX_BYTES)
    const limits = wrapped.outputLimits!
    expect(limits.maxLines!).toBeGreaterThanOrEqual(DEFAULT_MAX_LINES)
    expect(limits.maxBytes!).toBeGreaterThanOrEqual(DEFAULT_MAX_BYTES)
  })

  it('WD-3 spill:false → 内存截断：正文 ≤ 工具上限、恰一条 info/truncated 诊断（说清留的是哪段、全文没留），不指路、目录不建', async () => {
    const sid = 'wd-3'
    const result = await run(
      wrap(textProbe(big()), { sessionId: sid, spill: false, strategy: 'keep-start' })
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
    expect(existsSync(resultsDir(sid))).toBe(false)
  })

  it('WD-3b 截断说明跟着策略说留下的是哪段：middle → beginning and end，keep-end → end', async () => {
    const middle = await run(wrap(textProbe(big()), { sessionId: 'wd-3b', spill: false }))
    expect(middle.diagnostics?.[0].message).toContain('showing the beginning and end only')
    const end = await run(
      wrap(textProbe(big()), { sessionId: 'wd-3b', spill: false, strategy: 'keep-end' })
    )
    expect(end.diagnostics?.[0].message).toContain('showing the end only')
    expect(resultText(end).endsWith('L-2999')).toBe(true)
  })

  it('WD-4 两段超长文本 → 两条 spilled 诊断、两份文件，各指各的', async () => {
    const sid = 'wd-4'
    const result = await run(wrap(textProbe(big('a'), big('b')), { sessionId: sid }), {
      callId: 'wd-4-call'
    })
    expect(codes(result)).toEqual(['spilled', 'spilled'])
    const [a, b] = result.diagnostics!.map(locatorOf)
    expect(a).not.toBe(b)
    expect(readFileSync(a, 'utf-8')).toBe(big('a'))
    expect(readFileSync(b, 'utf-8')).toBe(big('b'))
  })

  it('WD-5 工具自己的诊断在前、截断说明在后；未超限的结果不多出 diagnostics 键', async () => {
    const own: ToolDiagnostic = { severity: 'warn', code: 'own', message: 'tool remark' }
    const tool = probe(async () => ({
      content: [{ type: 'text' as const, text: big() }],
      diagnostics: [own]
    }))
    const result = await run(wrap(tool, { sessionId: 'wd-5' }))
    expect(codes(result)).toEqual(['own', 'spilled'])

    const small = await invokeTool(wrap(textProbe('fine'), { sessionId: 'wd-5' }), {} as never)
    expect(small.result.diagnostics).toBeUndefined()
    expect(small.result.content).toEqual([{ type: 'text', text: 'fine' }])
  })

  it('WD-6 details 声明了 truncated / persisted 才合并（落盘 → 两个都 true）', async () => {
    const tool = probe(async () => ({
      content: [{ type: 'text' as const, text: big() }],
      details: { truncated: false, persisted: false, other: 1 }
    }))
    const result = await run(wrap(tool, { sessionId: 'wd-6' }))
    expect(result.details).toEqual({ truncated: true, persisted: true, other: 1 })
  })
})

describe('WD spill:auto —— 按这次调用的 agent 工具表现判', () => {
  it('WD-7 工具表里有 read → 落盘（spilled、文件在）', async () => {
    const sid = 'wd-7'
    const { agent } = agentWith(['read', 'probe'])
    const result = await run(wrap(textProbe(big()), { sessionId: sid, spill: 'auto' }), {
      api: { agent }
    })
    expect(codes(result)).toEqual(['spilled'])
    expect(existsSync(locatorOf(result.diagnostics![0]))).toBe(true)
  })

  it('WD-8 工具表里没有 read → 内存截断（truncated），正文给到工具上限而不是预览上限，目录不建', async () => {
    const sid = 'wd-8'
    const { agent } = agentWith(['probe', 'ask'])
    const result = await run(wrap(textProbe(big()), { sessionId: sid, spill: 'auto' }), {
      api: { agent }
    })
    expect(codes(result)).toEqual(['truncated'])
    expect(lineCount(resultText(result))).toBeGreaterThan(PREVIEW_MAX_LINES)
    expect(existsSync(resultsDir(sid))).toBe(false)
  })

  it('WD-9 同一个包装后的注册项挂在两张工具表下：每次调用各判各的', async () => {
    const sid = 'wd-9'
    const wrapped = wrap(textProbe(big()), { sessionId: sid, spill: 'auto' })
    const withRead = await run(wrapped, { api: { agent: agentWith(['read']).agent } })
    const without = await run(wrapped, { api: { agent: agentWith(['grep']).agent } })
    expect(codes(withRead)).toEqual(['spilled'])
    expect(codes(without)).toEqual(['truncated'])
  })

  it('WD-10 没超限不问工具表；两段超长文本只问一次', async () => {
    const quiet = agentWith(['read'])
    await run(wrap(textProbe('short'), { sessionId: 'wd-10', spill: 'auto' }), {
      api: { agent: quiet.agent }
    })
    expect(quiet.calls()).toBe(0)

    const twice = agentWith(['read'])
    const result = await run(
      wrap(textProbe(big('x'), big('y')), { sessionId: 'wd-10', spill: 'auto' }),
      {
        api: { agent: twice.agent }
      }
    )
    expect(codes(result)).toEqual(['spilled', 'spilled'])
    expect(twice.calls()).toBe(1)
  })

  it('WD-11 问工具表失败 → 当作不落盘（内存截断），调用照常成功', async () => {
    const sid = 'wd-11'
    const result = await run(wrap(textProbe(big()), { sessionId: sid, spill: 'auto' }), {
      api: {
        agent: async () => {
          throw new Error('agent unavailable')
        }
      }
    })
    expect(result.isError).toBeUndefined()
    expect(codes(result)).toEqual(['truncated'])
    expect(existsSync(resultsDir(sid))).toBe(false)
  })
})

describe('WD api.output() 与「(no output)」', () => {
  it('WD-12 工具只经 api.output() 汇报、不给 content → 不补 (no output)：结果正文就是汇报的输出，且确实交到了外层 api', async () => {
    const tool = probe(async (_args, api) => {
      api.output('line one\n')
      api.output(new TextEncoder().encode('line two\n'))
      return {}
    })
    const inv = await invokeTool(wrap(tool, { sessionId: 'wd-12' }), {} as never)

    expect(inv.output).toBe('line one\nline two\n')
    expect(inv.result.content).toEqual([{ type: 'text', text: 'line one\nline two\n' }])
    expect(resultText(inv.result)).not.toContain('(no output)')
  })

  it('WD-13 既没 content、也没汇报过看得见的输出（空白不算）→ (no output)', async () => {
    const silent = probe(async () => ({}))
    expect((await run(wrap(silent, { sessionId: 'wd-13' }))).content).toEqual([
      { type: 'text', text: '(no output)' }
    ])

    const blank = probe(async (_args, api) => {
      api.output(' \n\t')
      return {}
    })
    expect((await run(wrap(blank, { sessionId: 'wd-13' }))).content).toEqual([
      { type: 'text', text: '(no output)' }
    ])
  })

  it('WD-14 显式给了空 content（哪怕汇报过输出）→ (no output)：durable 只在 content 缺省时才拿留存的输出当正文', async () => {
    const tool = probe(async (_args, api) => {
      api.output('progress…\n')
      return { content: [] }
    })
    expect((await run(wrap(tool, { sessionId: 'wd-14' }))).content).toEqual([
      { type: 'text', text: '(no output)' }
    ])
  })
})

describe('WD 失败结果与元数据', () => {
  it('WD-15 isError 结果原样交回：超长也不截、不落盘、不加诊断、不补 (no output)', async () => {
    const sid = 'wd-15'
    const failure = { isError: true, content: [{ type: 'text' as const, text: big() }] }
    const result = await run(
      wrap(
        probe(async () => failure),
        { sessionId: sid }
      )
    )
    expect(result).toStrictEqual(failure)
    expect(existsSync(resultsDir(sid))).toBe(false)

    const empty = { isError: true, content: [] }
    expect(
      await run(
        wrap(
          probe(async () => empty),
          { sessionId: sid }
        )
      )
    ).toStrictEqual(empty)
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
      async preExecute(): Promise<void> {}
      protected async securityCheck(): Promise<void> {}
      protected async executeInternal(): Promise<{ content: []; details: undefined }> {
        return { content: [], details: undefined }
      }
    }
    const tool = new Probe()
    const wrapped = wrapDurableTool(tool, { sessionId: 'wd-16', spill: true })

    expect(wrapped.name).toBe('probe')
    expect(wrapped.description).toBe('dynamic description')
    expect(wrapped.replay).toBe('safe')
    expect(Object.prototype.hasOwnProperty.call(wrapped, 'execute')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(wrapped, 'outputLimits')).toBe(true)
    // 缺省策略与上限取工具自己的声明：留尾 → retain tail；上限是它的两倍（兜底）
    expect(wrapped.outputLimits).toEqual({ maxBytes: 8192, maxLines: 200, retain: 'tail' })
    // 显式给的上限 / 策略覆盖声明
    expect(
      wrapDurableTool(tool, {
        sessionId: 'wd-16',
        spill: true,
        strategy: 'middle',
        maxBytes: 1000,
        maxLines: 10
      }).outputLimits
    ).toEqual({ maxBytes: 2000, maxLines: 20, retain: 'head' })
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
  it('WD-R1 spill:auto + 工具表里有 read：落库的正文就是预览（durable 没再截），末尾 <harness> 段写着 [info] 与落盘路径', async () => {
    const sid = 'wd-r1'
    const wrapped = wrapDurableTool(textProbe(big()), { sessionId: sid, spill: 'auto' })

    const { message, diagnostics } = await durableRound(wrapped, [readStub])

    expect(diagnostics.map((d) => d.code)).toEqual(['spilled'])
    const texts = textsOf(message)
    expect(texts).toHaveLength(2)
    const [preview, harnessBlock] = texts
    expect(lineCount(preview)).toBeLessThanOrEqual(PREVIEW_MAX_LINES)
    expect(byteLen(preview)).toBeLessThanOrEqual(PREVIEW_MAX_BYTES)
    expect(preview.startsWith('L-0000')).toBe(true)
    expect(preview).not.toContain('saved to')
    const path = locatorOf(diagnostics[0])
    expect(harnessBlock).toBe(`<harness>\n[info] ${diagnostics[0].message}\n</harness>`)
    expect(harnessBlock).toContain(path)
    expect(harnessBlock).not.toContain('[warn]')
    expect(readFileSync(path, 'utf-8')).toBe(big())
  })

  it('WD-R2 spill:auto + 没有 read：内存截断到工具上限，durable 照样不再截（没有它自己的 truncated 诊断）', async () => {
    const sid = 'wd-r2'
    const wrapped = wrapDurableTool(textProbe(big('m', 60_000)), { sessionId: sid, spill: 'auto' })

    const { message, diagnostics } = await durableRound(wrapped)

    expect(diagnostics.map((d) => d.code)).toEqual(['truncated'])
    expect(diagnostics.every((d) => d.severity === 'info')).toBe(true)
    const [body] = textsOf(message)
    expect(lineCount(body)).toBeLessThanOrEqual(DEFAULT_MAX_LINES)
    expect(byteLen(body)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
    expect(existsSync(resultsDir(sid))).toBe(false)
  })

  it('WD-R4 工具上限高于 durable 的缺省（read 的 80 KB 那种）：截好的正文超过 50 KB，durable 也不再截 —— 靠的是包装后的 outputLimits', async () => {
    const sid = 'wd-r4'
    // 3000 行 × 40 字节 ≈ 120 KB：内存截断到 80 KB，正好落在 durable 缺省 50 KB 之上
    const line = (i: number): string => `${String(i).padStart(4, '0')}-${'x'.repeat(34)}`
    const text = Array.from({ length: 3000 }, (_, i) => line(i)).join('\n')
    const tool = probe(async () => ({ content: [{ type: 'text' as const, text }] }), {
      outputMaxBytes: 80 * 1024
    })
    const wrapped = wrapDurableTool(tool, { sessionId: sid, spill: false })

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
    const { message } = await durableRound(
      wrapDurableTool(tool, { sessionId: 'wd-r3', spill: 'auto' })
    )
    expect(textsOf(message)).toEqual(['streamed result\n'])
  })
})
