/**
 * BaseTool —— pi-durable 原生的工具模板（P1-04）。
 *
 * 契约（tools/baseTool.ts 文件头、phase1-plan 裁定 Q1 / Q12、durable 的 ToolRegistration）：
 *   BT-1  execute(args, api, context) 依次跑 preExecute → securityCheck → executeInternal，第一个参数都是 api.callId
 *   BT-2/3/4/5  钩子抛错（调用没被取消）→ 恰为 `{ isError: true, content: [{ type: 'text', text: message }] }`，
 *         后面的钩子不再跑；不带 details、不带诊断（诊断会渲染成 `<harness>` 段 —— Q12 要避开的那段文字）
 *   BT-6  调用已取消（context.abortSignal aborted）时钩子的抛错原样抛出 —— durable 的中止语义靠它
 *   BT-7  取消了但工具正常交回 → 结果照常交回（只有抛错才重抛）
 *   BT-8  工具自己交回的 isError 结果原样交回，不再包一层
 *   BT-9/10 每个钩子拿到同一个 ToolCallScope：callId / taskId / conversationId 来自 api，signal = context.abortSignal
 *   BT-11 结果映射：content / details / isError / control / diagnostics 带出；没给的字段不出现
 *   BT-12 details 在边界上收成严格 JSON
 *   BT-13 缺省 replay 'unsafe'、executionMode 不设；outputLimits 恒在工具自己的上限之上；保留端跟着策略走
 *   BT-14 BaseTool 实例就是 durable 的 ToolRegistration（类型层）
 *   RT    重跑表（agent-runtime 这一半）：read 'safe'；write / edit / knowledge（Q1）/ next / agent 'unsafe'
 */
import { describe, expect, it, vi } from 'vitest'
import { Type } from 'typebox'
import type { ToolRegistration } from '@earendil-works/pi-durable'
import { BaseTool, type ToolReplay } from '../baseTool'
import type { ToolCallScope } from '../toolCall'
import type { ToolResult } from '../toolResult'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '../../fileTools/truncate'
import type { TruncateStrategy } from '../../toolOutput/spill'
import { invokeTool } from '../testing/invokeTool'
import { createFileToolSuite, type FileToolDeps } from '../fileToolSuite'
import { createKnowledgeTool } from '../../knowledge/knowledgeTool'
import { NextTool } from '../../subagent/nextTool'
import { createDispatchAgentTool } from '../../subagent/dispatchTool'
import type { SubAgentManager } from '../../subagent/manager'
import type { SubAgentModelConfig } from '../../subagent/types'
import type { KnowledgeToolDeps } from '../../knowledge/knowledgeTool'

const Params = Type.Object({ value: Type.Optional(Type.String()) })

type Hook = 'preExecute' | 'securityCheck' | 'executeInternal'
interface HookCall {
  hook: Hook
  toolCallId: string
  params: unknown
  signal?: AbortSignal
  call: ToolCallScope
}

/** 每个钩子的行为都可编程的探针工具；钩子的入参逐次记下 */
class ProbeTool extends BaseTool<typeof Params> {
  readonly name = 'probe'
  readonly label = 'Probe'
  readonly description = 'probe tool'
  readonly parameters = Params
  readonly calls: HookCall[] = []
  failAt?: Hook
  thrown: unknown = new Error('boom')
  /** 抛错之前先做的事（如中止 signal） */
  beforeThrow?: () => void
  result: ToolResult = { content: [{ type: 'text', text: 'ran' }], details: undefined }

  private hit(hook: Hook, entry: Omit<HookCall, 'hook'>): void {
    this.calls.push({ hook, ...entry })
    if (this.failAt === hook) {
      this.beforeThrow?.()
      throw this.thrown
    }
  }

  async preExecute(
    toolCallId: string,
    params: Record<string, unknown>,
    call: ToolCallScope
  ): Promise<void> {
    this.hit('preExecute', { toolCallId, params, call })
  }

  protected async securityCheck(
    toolCallId: string,
    params: { value?: string },
    signal: AbortSignal | undefined,
    call: ToolCallScope
  ): Promise<void> {
    this.hit('securityCheck', { toolCallId, params, signal, call })
  }

  protected async executeInternal(
    toolCallId: string,
    params: { value?: string },
    signal: AbortSignal | undefined,
    call: ToolCallScope
  ): Promise<ToolResult> {
    this.hit('executeInternal', { toolCallId, params, signal, call })
    return this.result
  }
}

/** 只声明截断策略 / 上限的工具（看 outputLimits 用） */
class DeclaredTool extends BaseTool<typeof Params> {
  readonly name = 'declared'
  readonly label = 'Declared'
  readonly description = 'declared tool'
  readonly parameters = Params
  readonly outputStrategy: TruncateStrategy
  readonly outputMaxBytes?: number
  readonly outputMaxLines?: number
  readonly replay: ToolReplay

  constructor(decl: {
    strategy?: TruncateStrategy
    maxBytes?: number
    maxLines?: number
    replay?: ToolReplay
  }) {
    super()
    this.outputStrategy = decl.strategy ?? 'middle'
    this.outputMaxBytes = decl.maxBytes
    this.outputMaxLines = decl.maxLines
    this.replay = decl.replay ?? 'unsafe'
  }

  async preExecute(): Promise<void> {
    /* no-op */
  }
  protected async securityCheck(): Promise<void> {
    /* no-op */
  }
  protected async executeInternal(): Promise<ToolResult> {
    return { content: [], details: undefined }
  }
}

describe('BT 模板的顺序与入参', () => {
  it('BT-1 preExecute → securityCheck → executeInternal 各恰一次，第一个参数都是 api.callId、第二个是参数', async () => {
    const tool = new ProbeTool()
    const args = { value: 'x' }
    await invokeTool(tool, args, { callId: 'call-42' })

    expect(tool.calls.map((c) => c.hook)).toEqual([
      'preExecute',
      'securityCheck',
      'executeInternal'
    ])
    for (const c of tool.calls) {
      expect(c.toolCallId, c.hook).toBe('call-42')
      expect(c.params, c.hook).toEqual(args)
    }
  })

  it('BT-9 三个钩子拿到的是同一个 scope：身份来自 api、signal 即 context 的、api / context 就是工具拿到的那两个', async () => {
    const tool = new ProbeTool()
    const ac = new AbortController()
    const run = await invokeTool(
      tool,
      {},
      { callId: 'c-9', taskId: 77, conversationId: 5, signal: ac.signal }
    )

    const [pre, sec, exe] = tool.calls.map((c) => c.call)
    expect(sec).toBe(pre)
    expect(exe).toBe(pre)
    expect(pre.callId).toBe('c-9')
    expect(pre.taskId).toBe(77)
    expect(pre.conversationId).toBe(5)
    expect(pre.api).toBe(run.api)
    expect(pre.context).toBe(run.context)
    expect(pre.signal).toBe(run.context.abortSignal)
    expect(pre.signal?.aborted).toBe(false)
    // context 带的就是传进去的那个 signal（invokeTool 原样挂上）
    ac.abort()
    expect(pre.signal?.aborted).toBe(true)
  })

  it('BT-10 signal 参数就是 context.abortSignal；context 不带信号时为 undefined', async () => {
    const withSignal = new ProbeTool()
    const ac = new AbortController()
    const run = await invokeTool(withSignal, {}, { signal: ac.signal })
    const sec = withSignal.calls.find((c) => c.hook === 'securityCheck')!
    const exe = withSignal.calls.find((c) => c.hook === 'executeInternal')!
    expect(sec.signal).toBe(run.context.abortSignal)
    expect(exe.signal).toBe(run.context.abortSignal)

    const without = new ProbeTool()
    await invokeTool(without, {})
    expect(without.calls.find((c) => c.hook === 'securityCheck')!.signal).toBeUndefined()
    expect(without.calls.find((c) => c.hook === 'executeInternal')!.call.signal).toBeUndefined()
  })
})

describe('BT 抛错收口（裁定 Q12）', () => {
  it('BT-2 securityCheck 抛错 → executeInternal 不跑；结果恰为 isError + 原话，没有 details / 诊断', async () => {
    const tool = new ProbeTool()
    tool.failAt = 'securityCheck'
    tool.thrown = new Error('Access denied: /etc/shadow')
    const { result } = await invokeTool(tool, {})

    expect(tool.calls.map((c) => c.hook)).toEqual(['preExecute', 'securityCheck'])
    expect(result).toStrictEqual({
      isError: true,
      content: [{ type: 'text', text: 'Access denied: /etc/shadow' }]
    })
  })

  it('BT-3 preExecute 抛错 → 后两个钩子都不跑；同一口径', async () => {
    const tool = new ProbeTool()
    tool.failAt = 'preExecute'
    tool.thrown = new Error('container failed to start')
    const { result } = await invokeTool(tool, {})

    expect(tool.calls.map((c) => c.hook)).toEqual(['preExecute'])
    expect(result).toStrictEqual({
      isError: true,
      content: [{ type: 'text', text: 'container failed to start' }]
    })
  })

  it('BT-4 executeInternal 抛 Error("boom") → 文字恰是 boom（与 pi 0.80 的 createErrorToolResult 同一段字）', async () => {
    const tool = new ProbeTool()
    tool.failAt = 'executeInternal'
    const run = await invokeTool(tool, {})

    expect(run.result).toStrictEqual({ isError: true, content: [{ type: 'text', text: 'boom' }] })
    // 不经 api 报诊断：没有任何会变成 `<harness>` 段的东西
    expect(run.diagnostics).toEqual([])
    expect(JSON.stringify(run.result)).not.toContain('<harness>')
  })

  it.each([
    ['字符串', 'plain string failure', 'plain string failure'],
    ['数字', 42, '42'],
    ['对象', { code: 'E' }, '[object Object]']
  ])('BT-5 抛出非 Error（%s）→ 文字按 String 化', async (_label, thrown, text) => {
    const tool = new ProbeTool()
    tool.failAt = 'executeInternal'
    tool.thrown = thrown
    const { result } = await invokeTool(tool, {})
    expect(result).toStrictEqual({ isError: true, content: [{ type: 'text', text }] })
  })

  it('BT-6 调用开始前就已取消：钩子的抛错原样抛出（同一个对象），不收成结果', async () => {
    const tool = new ProbeTool()
    tool.failAt = 'securityCheck'
    const err = new Error('Aborted')
    tool.thrown = err
    const ac = new AbortController()
    ac.abort()

    await expect(invokeTool(tool, {}, { signal: ac.signal })).rejects.toBe(err)
    expect(tool.calls.map((c) => c.hook)).toEqual(['preExecute', 'securityCheck'])
  })

  it('BT-6 执行途中被取消：executeInternal 的抛错原样抛出', async () => {
    const tool = new ProbeTool()
    const ac = new AbortController()
    tool.failAt = 'executeInternal'
    const err = new Error('TOOL_ABORTED')
    tool.thrown = err
    tool.beforeThrow = () => ac.abort()

    await expect(invokeTool(tool, {}, { signal: ac.signal })).rejects.toBe(err)
  })

  it('BT-6 取消之后抛出的是别的错也照样重抛（判据是 context 已取消，不是错误长什么样）', async () => {
    const tool = new ProbeTool()
    const ac = new AbortController()
    tool.failAt = 'executeInternal'
    const err = new TypeError('socket hang up')
    tool.thrown = err
    tool.beforeThrow = () => ac.abort()

    await expect(invokeTool(tool, {}, { signal: ac.signal })).rejects.toBe(err)
  })

  it('BT-7 signal 已取消但工具正常交回 → 结果照常交回', async () => {
    const tool = new ProbeTool()
    const ac = new AbortController()
    ac.abort()
    const { result } = await invokeTool(tool, {}, { signal: ac.signal })
    expect(result).toEqual({ content: [{ type: 'text', text: 'ran' }] })
  })

  it('BT-8 工具自己交回 isError → 原样交回，不再包一层', async () => {
    const tool = new ProbeTool()
    tool.result = {
      content: [{ type: 'text', text: 'Exit code: 2' }],
      details: { exitCode: 2 },
      isError: true
    }
    const { result } = await invokeTool(tool, {})
    expect(result).toStrictEqual({
      content: [{ type: 'text', text: 'Exit code: 2' }],
      details: { exitCode: 2 },
      isError: true
    })
  })
})

describe('BT 结果映射', () => {
  it('BT-11 content / details / isError / control / diagnostics 都给了 → 原样带出', async () => {
    const tool = new ProbeTool()
    const diagnostics = [{ severity: 'warn' as const, message: 'partial listing', code: 'partial' }]
    tool.result = {
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      ],
      details: { type: 'ls', count: 3 },
      isError: false,
      control: { terminate: true },
      diagnostics
    }
    const { result } = await invokeTool(tool, {})
    expect(result).toStrictEqual({
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      ],
      details: { type: 'ls', count: 3 },
      isError: false,
      control: { terminate: true },
      diagnostics
    })
  })

  it('BT-11 没给的字段不出现：details undefined、无 control、空诊断 → 结果里只有 content', async () => {
    const tool = new ProbeTool()
    tool.result = { content: [{ type: 'text', text: 'ok' }], details: undefined, diagnostics: [] }
    const { result } = await invokeTool(tool, {})
    expect(Object.keys(result)).toEqual(['content'])
  })

  it('BT-12 details 收成严格 JSON：对象属性上的 undefined 丢掉，结果经 JSON 往返不变', async () => {
    const tool = new ProbeTool()
    tool.result = {
      content: [{ type: 'text', text: 'ok' }],
      details: { type: 'bash', exitCode: 0, cwd: undefined, nested: { a: 1, b: undefined } }
    }
    const { result } = await invokeTool(tool, {})
    expect(result.details).toStrictEqual({ type: 'bash', exitCode: 0, nested: { a: 1 } })
    expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result)
  })

  it('BT-12 真不是 JSON 的 details（Date）→ 按 JSON.stringify 的口径转一遍并告警，调用照常成功', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tool = new ProbeTool()
      const at = new Date('2026-10-04T00:00:00.000Z')
      tool.result = { content: [{ type: 'text', text: 'ok' }], details: { at } }
      const { result } = await invokeTool(tool, {})
      expect(result.isError).toBeUndefined()
      expect(result.details).toStrictEqual({ at: '2026-10-04T00:00:00.000Z' })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('probe')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('BT durable 注册项的字段', () => {
  it('BT-13 缺省 replay unsafe、executionMode 不设', () => {
    const tool = new ProbeTool()
    expect(tool.replay).toBe('unsafe')
    expect(tool.executionMode).toBeUndefined()
  })

  it('BT-13 outputLimits 恒在工具上限之上：没声明 → 缺省上限之上；声明了 → 那个上限之上', () => {
    const plain = new DeclaredTool({})
    expect(plain.outputLimits.maxBytes).toBeGreaterThan(DEFAULT_MAX_BYTES)
    expect(plain.outputLimits.maxLines).toBeGreaterThan(DEFAULT_MAX_LINES)

    const big = new DeclaredTool({ maxBytes: 80 * 1024, maxLines: DEFAULT_MAX_LINES + 5 })
    expect(big.outputLimits.maxBytes).toBeGreaterThan(80 * 1024)
    expect(big.outputLimits.maxLines).toBeGreaterThan(DEFAULT_MAX_LINES + 5)
  })

  it.each([
    ['keep-start', 'head'],
    ['middle', 'head'],
    ['keep-end', 'tail']
  ] as const)('BT-13 策略 %s → durable 兜底截断保留 %s', (strategy, retain) => {
    expect(new DeclaredTool({ strategy }).outputLimits.retain).toBe(retain)
  })

  it('BT-14 BaseTool 实例可直接当 durable 的 ToolRegistration 用（类型层 + 必要字段在位）', () => {
    const tool = new ProbeTool()
    const registration: ToolRegistration<typeof Params> = tool
    expect(registration.name).toBe('probe')
    expect(registration.description).toBe('probe tool')
    expect(registration.parameters).toBe(Params)
    expect(typeof registration.execute).toBe('function')
  })
})

// ─── 重跑表（agent-runtime 这一半；桌面工具在 apps/desktop 的 toolReplay.test.ts） ───

function fileDeps(): FileToolDeps {
  return {
    port: {} as FileToolDeps['port'],
    guards: {} as FileToolDeps['guards'],
    resolvePath: (p) => p,
    security: {} as FileToolDeps['security'],
    labels: { read: 'Read', write: 'Write', edit: 'Edit' },
    descriptions: { read: 'r', write: 'w', edit: 'e' }
  }
}

describe('RT 重跑表（agent-runtime）', () => {
  it('RT-1 read 是 safe（只读，恢复时重读无害）', () => {
    expect(createFileToolSuite(fileDeps()).read.replay).toBe('safe')
  })

  it('RT-2 write / edit 是 unsafe', () => {
    const suite = createFileToolSuite(fileDeps())
    expect(suite.write.replay).toBe('unsafe')
    expect(suite.edit.replay).toBe('unsafe')
  })

  it('RT-2 knowledge 是 unsafe（裁定 Q1：一个工具兼管 search 与会写文件的 create）', () => {
    const tool = createKnowledgeTool({ label: 'Knowledge' } as unknown as KnowledgeToolDeps)
    expect(tool.replay).toBe('unsafe')
  })

  it('RT-2 next / agent（派发）是 unsafe', () => {
    expect(new NextTool({ type: 'object' }).replay).toBe('unsafe')
    const dispatch = createDispatchAgentTool({
      registry: { list: () => [], get: () => undefined },
      manager: {} as SubAgentManager,
      modelConfig: {} as SubAgentModelConfig,
      parentSessionId: 's1',
      abortError: 'Aborted'
    })
    expect(dispatch.replay).toBe('unsafe')
  })
})
