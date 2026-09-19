/**
 * wrapToolOutput —— 安全模块 L1 全工具门（enforceInvocation）的挂载点。
 * mock 惯例照 tools/__tests__/write.test.ts（toolContext/logger mock）；
 * processToolOutput 短文本直通；security 用手写 stub，W-9 走真 createSecurityContext。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { EnforceOutcome, McpAgentToolMeta, SecurityContext } from '@shuvix/agent-runtime'
import {
  createSecurityContext,
  clearSessionDecisions,
  getSessionDecisions
} from '@shuvix/agent-runtime'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

/** 内置策略 md 的构建期内联读取口（W-9 走真装配链；测试进程，不进桌面 bundle） */
const INLINE_POLICY_MD = createInlinePolicyMdReader()

vi.mock('../toolContext', () => ({ TOOL_ABORTED: 'Aborted' }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
// 截断/落盘内核与本测试无关：短文本直通（不截断、不落盘）
vi.mock('../../utils/toolUtils/processToolOutput', () => ({
  processToolOutput: async (opts: { fullText: string }) => ({
    text: opts.fullText,
    truncated: false,
    persisted: false
  })
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

const exec = (
  wrapped: AgentTool,
  toolCallId: string,
  params: unknown
): ReturnType<AgentTool['execute']> => wrapped.execute(toolCallId, params as never)

afterEach(() => clearSessionDecisions(SID))

describe('wrapToolOutput — L1 全工具门', () => {
  it('W-1 不传 security → 不设门，原 execute 正常', async () => {
    const { tool, execute } = makeTool()
    const wrapped = wrapToolOutput(tool, SID, 'middle')
    const result = await exec(wrapped, 'tc-1', { action: 'connect' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.content).toEqual([{ type: 'text', text: 'ran' }])
  })

  it('W-2 调用形态：opts 恰为 {toolCallId, toolName, operation, mcp, abortError, onOther}（无 missingChannel）', async () => {
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
      onOther: 'return'
    })
  })

  it('W-3 时序：enforceInvocation pending 期间原 execute 未调；allowed 后原参数透传', async () => {
    const { tool, execute } = makeTool()
    let release!: (o: EnforceOutcome) => void
    const { security } = makeSecurity(
      () => new Promise<EnforceOutcome>((resolve) => (release = resolve))
    )
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    const params = { action: 'connect' }
    const signal = new AbortController().signal
    const onUpdate = vi.fn()
    const pending = wrapped.execute('tc-3', params as never, signal, onUpdate)
    await new Promise((r) => setTimeout(r, 0))
    expect(execute).not.toHaveBeenCalled()

    release({ status: 'allowed' })
    const result = await pending
    expect(execute).toHaveBeenCalledWith('tc-3', params, signal, onUpdate)
    expect(result.content).toEqual([{ type: 'text', text: 'ran' }])
  })

  it('W-4 enforceInvocation rejects → wrappedExecute rejects 同错误；原 execute 未调', async () => {
    const { tool, execute } = makeTool()
    const err = new Error("Denied by security policy rule 'tool-gate#0'")
    const { security } = makeSecurity(async () => {
      throw err
    })
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    await expect(exec(wrapped, 'tc-4', {})).rejects.toBe(err)
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

    await expect(exec(wrapped, 'tc-13', {})).rejects.toThrow(/Denied by security policy rule/)
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
        getSessionGrants: () => ({ autoAllow: false, allowList: [] }),
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
