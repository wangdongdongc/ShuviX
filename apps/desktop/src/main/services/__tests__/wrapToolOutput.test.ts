/**
 * wrapToolOutput —— 安全模块 L1 全工具门（enforceInvocation）的挂载点，同时也是「工具输出
 * 怎么截 / 落不落盘」这组参数**唯一**的穿线处（W-S*），以及结果上 `control.terminate` 的保留（W-T*）。
 * mock 惯例照 tools/__tests__/write.test.ts（toolContext/logger mock）；
 * processToolOutput 短文本直通（但把每次调用的 opts 记下来）；security 用手写 stub，
 * W-9 走真 createSecurityContext。
 *
 * P1-04（pi-durable）：包装产物是 durable 注册项，经 invokeTool 调（`execute(args, api, context)`）；
 * 手写的假工具多数仍是旧形状（`execute(toolCallId, params, signal)`，如 MCP 桥接层），包装器经
 * `fromAgentTool` 收下它们 —— 所以下面对原 execute 入参的断言仍按旧约定写。门拒绝从「抛错」变成
 * isError 结果（裁定 Q12，文字不变）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AgentTool, AnyTool } from '@shuvix/agent-runtime'
import type { EnforceOutcome, McpAgentToolMeta, SecurityContext } from '@shuvix/agent-runtime'
import {
  executeTool,
  failureText,
  type InvokedToolResult
} from '@shuvix/agent-runtime/tools/testing/invokeTool'
import {
  createSecurityContext,
  clearSessionDecisions,
  getSessionDecisions
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

/** 内置策略 md 的构建期内联读取口（W-9 走真装配链；测试进程，不进桌面 bundle） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

/** 记下每一次后处理调用的入参 —— W-S* 钉的就是「包装器交过去了什么」 */
interface ProcessCall {
  sessionId: string
  toolCallId: string
  fullText: string
  strategy: string
  maxBytes?: number
  maxLines?: number
  spill?: boolean
}

const mocks = vi.hoisted(() => ({
  processToolOutput: vi.fn(async (opts: { fullText: string }) => ({
    text: opts.fullText,
    truncated: false,
    persisted: false
  }))
}))

vi.mock('../toolContext', () => ({ TOOL_ABORTED: 'Aborted' }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// 截断/落盘内核本身与本测试无关：短文本直通（不截断、不落盘）；只把 opts 留下来
vi.mock('../../utils/toolUtils/processToolOutput', () => ({
  processToolOutput: mocks.processToolOutput
}))

import { wrapToolOutput } from '../wrapToolOutput'

const SID = 'wrap-tool-output-test-session'

/** 最小 AgentTool（execute 为可编程 vi.fn，返回单文本块 'ran'） */
function makeTool(name = 'ssh'): { tool: AgentTool; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'ran' }],
    details: undefined
  }))
  const tool = { name, label: name, description: 'test tool', parameters: {}, execute }
  return { tool: tool as unknown as AgentTool, execute }
}

/** 事实的类型走生产那条缝自己的声明，免得测试跟着它的导出面漂 */
type McpFacts = McpAgentToolMeta['mcpMeta']

/** 一份 MCP 工具事实（内置 ssh 的 exec，四个 hint 齐全） */
const SSH_EXEC_META: McpFacts = {
  server: 'ssh',
  tool: 'exec',
  trusted: true,
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: true
}

/** 带 mcpMeta 的工具（桥接层产出的那种形态） */
function makeMcpTool(meta: McpFacts = SSH_EXEC_META): {
  tool: AgentTool & { mcpMeta: McpFacts }
  execute: ReturnType<typeof vi.fn>
} {
  const { tool, execute } = makeTool('mcp__ssh__exec')
  return { tool: Object.assign(tool, { mcpMeta: meta }), execute }
}

/** 这次调用交给 L1 门的 mcp 事实 */
const mcpOf = (enforceInvocation: ReturnType<typeof vi.fn>, i = 0): unknown =>
  (enforceInvocation.mock.calls[i][0] as { mcp?: unknown }).mcp

/** 手写 security stub —— 只有 enforceInvocation 会被 wrapToolOutput 触碰 */
function makeSecurity(impl?: () => Promise<EnforceOutcome>): {
  security: SecurityContext
  enforceInvocation: ReturnType<typeof vi.fn>
} {
  const enforceInvocation = vi.fn(
    impl ?? (async (): Promise<EnforceOutcome> => ({ status: 'allowed' }))
  )
  return { security: { enforceInvocation } as unknown as SecurityContext, enforceInvocation }
}

const exec = (wrapped: AnyTool, toolCallId: string, params: unknown): Promise<InvokedToolResult> =>
  executeTool(wrapped, toolCallId, params as never)

/** 这一次跑下来，后处理收到的全部入参（按调用顺序） */
const processCalls = (): ProcessCall[] =>
  mocks.processToolOutput.mock.calls.map(([opts]) => opts as unknown as ProcessCall)

afterEach(() => {
  clearSessionDecisions(SID)
  mocks.processToolOutput.mockClear()
})

describe('wrapToolOutput — L1 全工具门', () => {
  it('W-1 不传 security → 不设门，原 execute 正常', async () => {
    const { tool, execute } = makeTool()
    const wrapped = wrapToolOutput(tool, SID, 'middle')
    const result = await exec(wrapped, 'tc-1', { action: 'connect' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.content).toEqual([{ type: 'text', text: 'ran' }])
  })

  it('W-2 调用形态：opts 恰为 {toolCallId, toolName, operation, mcp, abortError, onOther, signal}（无 missingChannel）', async () => {
    const { tool } = makeTool('ssh')
    const { security, enforceInvocation } = makeSecurity()
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    await exec(wrapped, 'tc-2', { action: 'connect' })

    expect(enforceInvocation).toHaveBeenCalledTimes(1)
    expect(enforceInvocation.mock.calls[0][0]).toStrictEqual({
      toolCallId: 'tc-2',
      toolName: 'ssh',
      operation: 'connect',
      // 内置工具没有 MCP 事实可报 —— 这个键在也是 undefined
      mcp: undefined,
      abortError: 'Aborted',
      onOther: 'return',
      // 工具调用的中止信号原样交给门（询问点的审查随它一起中止）；这次调用没给，键在也是 undefined
      signal: undefined
    })
  })

  it('W-SG1 工具调用的中止信号原样交给 L1 门：opts.signal 与 execute 收到的是同一个对象', async () => {
    const { tool, execute } = makeTool('ssh')
    const { security, enforceInvocation } = makeSecurity()
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const ac = new AbortController()
    await executeTool(wrapped, 'tc-sg1', { action: 'connect' } as never, ac.signal)

    expect(enforceInvocation).toHaveBeenCalledTimes(1)
    // toBe：询问点的审查随这次工具调用一起中止 —— 包装器若另造一个 signal（或丢掉它），
    // 用户点停止时审查就只能跑到超时
    expect((enforceInvocation.mock.calls[0][0] as { signal?: AbortSignal }).signal).toBe(ac.signal)
    // 放行之后，原 execute 拿到的仍是同一个
    expect(execute.mock.calls[0][2]).toBe(ac.signal)
  })

  it('W-3 时序：enforceInvocation pending 期间原 execute 未调；allowed 后原参数透传（旧形状桥：恰三个入参）', async () => {
    const { tool, execute } = makeTool()
    let release!: (o: EnforceOutcome) => void
    const { security } = makeSecurity(
      () => new Promise<EnforceOutcome>((resolve) => (release = resolve))
    )
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const params = { action: 'connect' }
    const signal = new AbortController().signal
    const pending = executeTool(wrapped, 'tc-3', params as never, signal)
    await new Promise((r) => setTimeout(r, 0))
    expect(execute).not.toHaveBeenCalled()

    release({ status: 'allowed' })
    const result = await pending
    // durable 没有 onUpdate（中途汇报走 api.output / api.details）—— 旧形状桥只按旧约定交三个入参
    expect(execute).toHaveBeenCalledWith('tc-3', params, signal)
    expect(result.content).toEqual([{ type: 'text', text: 'ran' }])
  })

  it('W-4 enforceInvocation rejects → isError 结果、文字即那条错误（原为原样 reject，裁定 Q12）；原 execute 未调', async () => {
    const { tool, execute } = makeTool()
    const err = new Error("Denied by security policy rule 'tool-gate#0'")
    const { security } = makeSecurity(async () => {
      throw err
    })
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const result = await exec(wrapped, 'tc-4', {})
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: err.message }] })
    expect(execute).not.toHaveBeenCalled()
  })

  it('W-4b 调用已被取消时门的拒绝照旧抛出（取消不收成失败结果，durable 的中止语义靠它）', async () => {
    const { tool, execute } = makeTool()
    const ac = new AbortController()
    const err = new Error('Aborted')
    const { security } = makeSecurity(async () => {
      ac.abort()
      throw err
    })
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    await expect(executeTool(wrapped, 'tc-4b', {} as never, ac.signal)).rejects.toBe(err)
    expect(execute).not.toHaveBeenCalled()
  })

  it('W-5 feedback → 非 isError 单文本块逐字；原 execute 未调', async () => {
    const { tool, execute } = makeTool()
    const { security } = makeSecurity(async () => ({
      status: 'feedback',
      text: 'try the browser tool'
    }))
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const result = await exec(wrapped, 'tc-5', { action: 'connect' })
    expect(execute).not.toHaveBeenCalled()
    expect((result as { isError?: boolean }).isError).toBeUndefined()
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Tool was not executed. User responded with feedback instead:\ntry the browser tool'
      }
    ])
  })

  it('W-6 operation 提取：action 为数字/对象/缺失 → operation undefined', async () => {
    const { tool } = makeTool()
    const { security, enforceInvocation } = makeSecurity()
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    await exec(wrapped, 'tc-6a', { action: 42 })
    await exec(wrapped, 'tc-6b', { action: { nested: true } })
    await exec(wrapped, 'tc-6c', {})

    expect(enforceInvocation).toHaveBeenCalledTimes(3)
    for (const [opts] of enforceInvocation.mock.calls) {
      expect((opts as { operation?: string }).operation).toBeUndefined()
    }
  })

  // ── MCP 事实的透传 ──
  //
  // 包装器是 L1 门唯一的挂载点，而门对第三方 MCP 工具能说的话全部来自这一次透传：
  // 少传一次，那台 server 就退回到「有人要调工具」这一句，按 server / 按只读写的策略
  // 全部失效 —— 而失效的方式是**静默放行**，UI 上一点痕迹都没有。

  it('W-10 MCP 工具的 mcpMeta 原样成为 opts.mcp（同一个对象，不复制不改写）', async () => {
    const { tool } = makeMcpTool()
    const { security, enforceInvocation } = makeSecurity()
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    await exec(wrapped, 'tc-10', { q: 'x' })

    // toBe 而不是 toEqual：中间只要有人「顺手」重建一遍对象，
    // 以后新增一个 hint 就会在这里被静默丢掉
    expect(mcpOf(enforceInvocation)).toBe(tool.mcpMeta)
    expect(mcpOf(enforceInvocation)).toEqual(SSH_EXEC_META)
  })

  it('W-11 原型链上的 mcpMeta 也读得到 —— 包装器自己就是一层 Object.create', async () => {
    const { tool } = makeMcpTool()
    // 桥接层的工具可能已经被包过一层（子代理工具表就是这么装的），于是 mcpMeta
    // 不在自身属性上；`{...tool}` 式的读法在这里会读到 undefined
    const layered = Object.create(Object.create(tool)) as AgentTool
    const { security, enforceInvocation } = makeSecurity()
    const wrapped = wrapToolOutput(layered, SID, 'middle', undefined, security)

    await exec(wrapped, 'tc-11', {})
    expect(mcpOf(enforceInvocation)).toBe(tool.mcpMeta)
  })

  it('W-12 每次调用现读，不是包装那一刻抄一份', async () => {
    const { tool } = makeMcpTool()
    const { security, enforceInvocation } = makeSecurity()
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    await exec(wrapped, 'tc-12a', {})
    // tools/list 重新发现之后事实会换（server 改了 annotations、或换成另一台）
    tool.mcpMeta = { server: 'evil', tool: 'read-file', trusted: false }
    await exec(wrapped, 'tc-12b', {})

    expect(mcpOf(enforceInvocation, 0)).toEqual(SSH_EXEC_META)
    expect(mcpOf(enforceInvocation, 1)).toEqual({
      server: 'evil',
      tool: 'read-file',
      trusted: false
    })
  })

  it('W-13 门拦下时事实也已经上报过了 —— 原 execute 一次没跑', async () => {
    const { tool, execute } = makeMcpTool()
    const { security, enforceInvocation } = makeSecurity(async () => {
      throw new Error("Denied by security policy rule 'no-evil#0'")
    })
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    expect(await failureText(exec(wrapped, 'tc-13', {}))).toMatch(/Denied by security policy rule/)
    // 「按 server 拒绝」要成立，事实必须在判定**之前**就到了门上
    expect(mcpOf(enforceInvocation)).toEqual(SSH_EXEC_META)
    expect(execute).not.toHaveBeenCalled()
  })

  it('W-9 端到端：真 createSecurityContext + ask×invocation + other 反馈 → feedback 文本结果 + 日志 1 条', async () => {
    const requestUserInput = vi.fn(
      async (_req: InputRequest): Promise<InputResponse> => ({
        kind: 'other',
        text: 'do not connect'
      })
    )
    const security = createSecurityContext(
      { kind: 'agent', sessionId: SID, agentKind: 'root' },
      { host: 'desktop', workspaceDir: '/ws' },
      {
        host: 'desktop',
        pathSep: '/',
        getVars: () => ({
          workspace: '/ws',
          toolResultsBase: '/tool-results',
          skillsDirs: ['/skills'],
          memoryDirs: [],
          knowledgeRoot: '/kb',
          knowledgeSessionDirs: [],
          home: '/home/u',
          systemDirs: []
        }),
        getSessionGrants: () => ({ allowList: [] }),
        readBuiltinPolicyMd: INLINE_POLICY_MD,
        getUserPolicies: () => [
          {
            name: 'tool-gate',
            displayName: 'tool-gate',
            description: '',
            rules: [{ effect: 'ask', object: { kind: 'invocation' } }],
            body: ''
          }
        ],
        requestUserInput
      }
    )
    const { tool, execute } = makeTool('ssh')
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const result = await exec(wrapped, 'tc-9', { action: 'connect' })
    expect(execute).not.toHaveBeenCalled()
    expect(requestUserInput).toHaveBeenCalledTimes(1)
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tc-9', kind: 'ask', command: 'ssh: connect' })
    )
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Tool was not executed. User responded with feedback instead:\ndo not connect'
      }
    ])

    const logs = getSessionDecisions(SID)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      effect: 'ask',
      objectKind: 'invocation',
      objectSummary: 'ssh: connect',
      toolName: 'ssh',
      tool: { name: 'ssh', operation: 'connect' },
      userResponse: 'feedback'
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// W-S —— 截断 / 落盘参数的穿线。
//
// `spill` 是宿主**按 agent** 下的判断（手里有没有 read 取回全文），包装器是它唯一的通道：
// 这里漏传一次，那个 agent 就会拿到一段指向它没有的工具的预览 —— 而且从结果上看不出异常，
// 只是正文比它本该拿到的短得多。所以钉的是「每一个文本块都带着同一组参数过去」。
// ─────────────────────────────────────────────────────────────────────────────

const IMAGE_BLOCK = { type: 'image' as const, data: 'AAAABBBBCCCC', mimeType: 'image/png' }

/** 一次调用回「文本 + 图片 + 文本」—— 图片块不该进后处理 */
function makeMultiBlockTool(): { tool: AgentTool; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async () => ({
    content: [
      { type: 'text' as const, text: 'first block' },
      IMAGE_BLOCK,
      { type: 'text' as const, text: 'second block' }
    ],
    details: undefined
  }))
  const tool = { name: 'shot', label: 'shot', description: 'test tool', parameters: {}, execute }
  return { tool: tool as unknown as AgentTool, execute }
}

describe('wrapToolOutput — 截断 / 落盘参数的穿线', () => {
  it('W-S1 overrides {spill:false} → 每个文本块都带着 spill:false 过去；图片块直通不进后处理', async () => {
    const { tool } = makeMultiBlockTool()
    const wrapped = wrapToolOutput(tool, SID, 'middle', { spill: false })

    const result = await exec(wrapped, 'tc-s1', {})

    const calls = processCalls()
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.fullText)).toEqual(['first block', 'second block'])
    for (const call of calls) expect(call.spill).toBe(false)
    // 图片原样待在原位
    expect(result.content[1]).toBe(IMAGE_BLOCK)
    expect(result.content).toHaveLength(3)
  })

  it('W-S2 三个覆写原样到达；首个文本块用的就是这一次的 toolCallId 与会话 id', async () => {
    const { tool } = makeMultiBlockTool()
    const wrapped = wrapToolOutput(tool, SID, 'keep-start', {
      maxBytes: 4096,
      maxLines: 10,
      spill: false
    })

    await exec(wrapped, 'tc-s2', {})

    const calls = processCalls()
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.maxBytes).toBe(4096)
      expect(call.maxLines).toBe(10)
      expect(call.spill).toBe(false)
      expect(call.sessionId).toBe(SID)
      expect(call.strategy).toBe('keep-start')
    }
    // 第一段用本次调用 id；后面每段各自一个文件名，否则后一段会盖掉前一段的全文
    expect(calls[0].toolCallId).toBe('tc-s2')
    expect(calls[1].toolCallId).toBe('tc-s2-2')
  })

  it('W-S3 不传 overrides → spill 为 undefined（= 缺省落盘），另两个上限也不凭空冒出来', async () => {
    const { tool } = makeTool()
    const wrapped = wrapToolOutput(tool, SID, 'middle')

    await exec(wrapped, 'tc-s3', {})

    const calls = processCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].spill).toBeUndefined()
    expect(calls[0].maxBytes).toBeUndefined()
    expect(calls[0].maxLines).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// W-T —— `control.terminate` 的保留。
//
// 结果契约的 `next` 靠 `control: { terminate: true }` 让 durable 在「这一批只有 next」时直接结束循环
// （判定型 hook 的审查 agent 因此一次请求出结论）；它在派生 agent 的工具表里同样过这层包装。包装器用
// 展开重建结果，这里钉的是每条出口都把它原样带出去 —— 丢了它不会报错，只会让每次审查悄悄多花一次请求。
// 假工具是 durable 形状（next 是 BaseTool）；旧形状结果上的 `terminate` 由桥换成 control（见 W-T3）。
// ─────────────────────────────────────────────────────────────────────────────

/** execute 交回给定 content、并带 control.terminate 的 durable 形状工具 */
function makeTerminatingTool(content: Array<{ type: 'text'; text: string }>): {
  tool: AnyTool
  execute: ReturnType<typeof vi.fn>
} {
  const execute = vi.fn(async () => ({ content, control: { terminate: true as const } }))
  const tool = {
    name: 'next',
    label: 'next',
    description: 'test tool',
    parameters: {},
    replay: 'unsafe' as const,
    execute
  }
  return { tool: tool as unknown as AnyTool, execute }
}

const terminateOf = (result: unknown): unknown =>
  (result as { control?: { terminate?: unknown } }).control?.terminate

describe('wrapToolOutput — control.terminate 原样带出', () => {
  it('W-T1 普通文本路径：包装后仍带 terminate:true，文本照常过后处理', async () => {
    const { tool } = makeTerminatingTool([{ type: 'text', text: 'Result recorded.' }])
    const wrapped = wrapToolOutput(tool, SID, 'middle')

    const result = await exec(wrapped, 'tc-t1', {})

    expect(terminateOf(result)).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Result recorded.' }])
    expect(processCalls()).toHaveLength(1)
  })

  it.each([
    ['空 content', []],
    ['只有空白文本', [{ type: 'text' as const, text: '   ' }]]
  ])('W-T1 %s → 补上 (no output) 之后仍带 terminate:true', async (_label, content) => {
    const { tool } = makeTerminatingTool(content)
    const wrapped = wrapToolOutput(tool, SID, 'middle')

    const result = await exec(wrapped, 'tc-t1b', {})

    expect(terminateOf(result)).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: '(no output)' }])
  })

  it('W-T1 带 security 且放行：L1 门过了之后结果仍带 terminate:true', async () => {
    const { tool, execute } = makeTerminatingTool([{ type: 'text', text: 'Result recorded.' }])
    const { security, enforceInvocation } = makeSecurity()
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const result = await exec(wrapped, 'tc-t1c', {})

    expect(enforceInvocation).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(terminateOf(result)).toBe(true)
  })

  it('W-T2 原结果没有 terminate → 包装后也没有 control 这个键（不凭空多出）', async () => {
    const { tool } = makeTool()
    const { security } = makeSecurity()
    for (const wrapped of [
      wrapToolOutput(tool, SID, 'middle'),
      wrapToolOutput(tool, SID, 'middle', undefined, security)
    ]) {
      const result = await exec(wrapped, 'tc-t2', {})
      expect('terminate' in (result as object)).toBe(false)
      expect('control' in (result as object)).toBe(false)
    }
  })

  it('W-T3 旧形状工具结果上的 terminate:true → 桥换成 control.terminate，包装后照样带出', async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'done' }],
      details: undefined,
      terminate: true
    }))
    const legacy = { name: 'old', label: 'old', description: 'test tool', parameters: {}, execute }
    const wrapped = wrapToolOutput(legacy as unknown as AgentTool, SID, 'middle')

    const result = await exec(wrapped, 'tc-t3', {})
    expect(terminateOf(result)).toBe(true)
    expect('terminate' in (result as object)).toBe(false)
  })
})
