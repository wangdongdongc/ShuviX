/**
 * wrapToolOutput —— 安全模块 L1 全工具门（enforceInvocation）的挂载点。
 * mock 惯例照 tools/__tests__/write.test.ts（toolContext/logger mock）；
 * processToolOutput 短文本直通；security 用手写 stub，W-9 走真 createSecurityContext。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { EnforceOutcome, SecurityContext } from '@shuvix/agent-runtime'
import {
  createSecurityContext,
  clearSessionDecisions,
  getSessionDecisions
} from '@shuvix/agent-runtime'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

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

  it('W-2 调用形态：opts 恰为 {toolCallId, toolName, operation, abortError, onOther}（无 missingChannel）', async () => {
    const { tool } = makeTool('ssh')
    const { security, enforceInvocation } = makeSecurity()
    const wrapped = wrapToolOutput(tool, SID, 'middle', undefined, security)

    await exec(wrapped, 'tc-2', { action: 'connect' })

    expect(enforceInvocation).toHaveBeenCalledTimes(1)
    expect(enforceInvocation.mock.calls[0][0]).toStrictEqual({
      toolCallId: 'tc-2',
      toolName: 'ssh',
      operation: 'connect',
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
          botsDir: '/tmp/shuvix-bots',
          toolResultsBase: '/tool-results',
          skillsDirs: ['/skills'],
          memoryDirs: [],
          home: '/home/u',
          systemDirs: []
        }),
        getSessionGrants: () => ({ autoAllow: false, allowList: [] }),
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
