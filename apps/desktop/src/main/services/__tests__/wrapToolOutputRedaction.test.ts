/**
 * wrapToolOutput —— 自动脱敏的还原（docs/auto-redaction-design.md §2.2 / §3.5）：
 *   WR-1 参数里的占位符换回真值再交给工具；L1 门与工具本体里的执行点都拿到还原了哪些类别，执行完清掉
 *   WR-2 引用了解不开的占位符 → 拦下，工具不执行，告诉模型原因
 *   WR-3 还原本身抛错 → 拦下，工具不执行
 *   WR-4 没配脱敏 → 参数原样
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  AnyTool,
  EnforceOutcome,
  SecurityContext,
  SessionRedaction
} from '@shuvix/agent-runtime'
import { executeTool, failureText } from '@shuvix/agent-runtime/tools/testing/invokeTool'

vi.mock('../toolContext', () => ({ TOOL_ABORTED: 'Aborted' }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { restoredCategoriesOf } from '../redaction/restoredCalls'
import { wrapDurableTool } from '../wrapToolOutput'

const SID = 'wrap-redaction-session'

function makeTool(onRun?: (args: unknown) => void): {
  tool: AnyTool
  execute: ReturnType<typeof vi.fn>
} {
  const execute = vi.fn(async (args: unknown) => {
    onRun?.(args)
    return { output: [{ type: 'text' as const, text: 'ran' }] }
  })
  const tool = {
    name: 'bash',
    label: 'bash',
    description: 'test tool',
    parameters: {},
    replay: 'unsafe' as const,
    execute
  }
  return { tool: tool as unknown as AnyTool, execute }
}

function makeSecurity(): {
  security: SecurityContext
  enforceInvocation: ReturnType<typeof vi.fn>
} {
  const enforceInvocation = vi.fn(async (): Promise<EnforceOutcome> => ({ status: 'allowed' }))
  return { security: { enforceInvocation } as unknown as SecurityContext, enforceInvocation }
}

const redactionWith = (restoreJson: (value: unknown) => Promise<unknown>): SessionRedaction =>
  ({ restoreJson }) as unknown as SessionRedaction

describe('wrapToolOutput — 自动脱敏的还原', () => {
  it('WR-1 换回真值再执行；门与工具本体看得到还原的类别，执行完清掉', async () => {
    let seenDuringRun: string[] | undefined
    const { tool, execute } = makeTool(() => {
      seenDuringRun = restoredCategoriesOf(SID, 1)
    })
    const { security, enforceInvocation } = makeSecurity()
    const redaction = redactionWith(async () => ({
      value: { command: 'curl -H "Authorization: Bearer sk-real" x' },
      restored: ['API_KEY'],
      unavailable: []
    }))
    const wrapped = wrapDurableTool(tool, {
      sessionId: SID,
      spill: true,
      security,
      redaction: () => redaction
    })
    const result = await executeTool(wrapped, 'tc-1', {
      command: 'curl -H "Authorization: Bearer {{API_KEY_aaaaaaaa}}" x'
    } as never)
    expect(result.content).toEqual([{ type: 'text', text: 'ran' }])
    expect(execute.mock.calls[0][0]).toEqual({
      command: 'curl -H "Authorization: Bearer sk-real" x'
    })
    expect((enforceInvocation.mock.calls[0][0] as { restored?: string[] }).restored).toEqual([
      'API_KEY'
    ])
    expect(seenDuringRun).toEqual(['API_KEY'])
    expect(restoredCategoriesOf(SID, 1)).toBeUndefined()
  })

  it('WR-2 解不开的占位符 → 拦下，不执行', async () => {
    const { tool, execute } = makeTool()
    const redaction = redactionWith(async (value) => ({
      value,
      restored: [],
      unavailable: ['{{SECRET_aaaaaaaa}}']
    }))
    const wrapped = wrapDurableTool(tool, {
      sessionId: SID,
      spill: true,
      redaction: () => redaction
    })
    const text = await failureText(
      executeTool(wrapped, 'tc-2', { command: 'echo {{SECRET_aaaaaaaa}} > .env' } as never)
    )
    expect(execute).not.toHaveBeenCalled()
    expect(text).toMatch(/\{\{SECRET_aaaaaaaa\}\}.*not available/s)
  })

  it('WR-3 还原抛错 → 拦下，不执行', async () => {
    const { tool, execute } = makeTool()
    const redaction = redactionWith(async () => {
      throw new Error('boom')
    })
    const wrapped = wrapDurableTool(tool, {
      sessionId: SID,
      spill: true,
      redaction: () => redaction
    })
    const result = await executeTool(wrapped, 'tc-3', { command: 'ls' } as never)
    expect(execute).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
  })

  it('WR-4 没配脱敏 → 参数原样', async () => {
    const { tool, execute } = makeTool()
    const wrapped = wrapDurableTool(tool, {
      sessionId: SID,
      spill: true,
      redaction: () => undefined
    })
    await executeTool(wrapped, 'tc-4', { command: 'echo {{API_KEY_aaaaaaaa}}' } as never)
    expect(execute.mock.calls[0][0]).toEqual({ command: 'echo {{API_KEY_aaaaaaaa}}' })
  })
})
