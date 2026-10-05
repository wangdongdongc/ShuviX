/**
 * 档案 → 运行投影的纯口径。`model` / `thinkingLevel` / 两个注入开关全链路 optional，
 * 搬运断了不会有任何类型错误、只会静默退回「跟随派发方」—— 故逐字段钉死。
 *
 * 另钉参数校验的纠错指引：错误文案必须指向真实参数名 `name` 并列出可用 agent ——
 * 旧文案写成缺 "agent" 参数，弱模型照抄传 `agent:`（未知属性被 schema 静默放行）
 * 后又收到同一条错，形成误导闭环。
 */
import { describe, it, expect, vi } from 'vitest'
import type { JsonValue } from '@earendil-works/chord'
import { createDispatchAgentTool, toInProcessAgentType } from '../dispatchTool'
import type { RunTaskOutcome, RunTaskParams, SubAgentManager } from '../manager'
import type { AgentProfile } from '../types'
import { invokeTool } from '../../tools/testing/invokeTool'

const PROFILE: AgentProfile = {
  name: 'explore',
  displayName: '探索',
  description: 'explores the codebase',
  systemPrompt: 'BODY',
  tools: ['read', 'grep'],
  instructionFiles: [],
  projectAwareness: false,
  source: 'builtin',
  basePath: ''
}

describe('toInProcessAgentType', () => {
  it('model / instructionFiles / projectAwareness 逐字段带到投影', () => {
    const projected = toInProcessAgentType({
      ...PROFILE,
      model: 'openai/gpt-4o',
      instructionFiles: ['AGENTS.md'],
      projectAwareness: true
    })
    expect(projected.model).toBe('openai/gpt-4o')
    expect(projected.instructionFiles).toEqual(['AGENTS.md'])
    expect(projected.projectAwareness).toBe(true)
  })

  it('未声明模型 → 投影的 model 为 undefined（不声明 = 继承派发方）', () => {
    expect(toInProcessAgentType(PROFILE).model).toBeUndefined()
  })

  it('thinkingLevel 带到投影：声明 off → off（「不思考」是一种声明，不是没声明）；未声明 → undefined', () => {
    // 搬运一断，titler 这类声明了 off 的档案就会静默跑在派发方的档位上（深思一个五字标题）
    expect(toInProcessAgentType({ ...PROFILE, thinkingLevel: 'off' }).thinkingLevel).toBe('off')
    expect(toInProcessAgentType(PROFILE).thinkingLevel).toBeUndefined()
  })

  it('其余字段原样投影，tools 为副本（不与档案共享数组）', () => {
    const projected = toInProcessAgentType(PROFILE)
    expect(projected).toEqual({
      name: 'explore',
      displayName: '探索',
      description: 'explores the codebase',
      tools: ['read', 'grep'],
      systemPrompt: 'BODY',
      model: undefined,
      thinkingLevel: undefined,
      instructionFiles: [],
      projectAwareness: false
    })
    expect(projected.tools).not.toBe(PROFILE.tools)
  })
})

describe('DispatchAgentTool — 参数校验错误必须给出纠错指引', () => {
  const tool = createDispatchAgentTool({
    registry: {
      list: () => [PROFILE],
      get: (name: string) => (name === PROFILE.name ? PROFILE : undefined)
    },
    manager: { runTask: async () => ({ result: 'ok' }) } as unknown as SubAgentManager,
    sessionId: 's1',
    abortError: 'ABORTED'
  })
  const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
    r.content.map((c) => c.text ?? '').join('')

  it('缺 name 且无默认 agent → 指名真实参数 `name` 并列出可用名', async () => {
    const { result: out } = await invokeTool(
      tool,
      { description: 'd', prompt: 'p' },
      { callId: 't1' }
    )
    const text = textOf(out as { content: Array<{ type: string; text?: string }> })
    expect(text).toContain('"name"')
    expect(text).toContain('explore')
    // 回归钉：旧文案把参数名写成 "agent"，曾直接教坏调用方
    expect(text).not.toContain('parameter "agent"')
  })

  it('未知 name → 列出可用名', async () => {
    const { result: out } = await invokeTool(
      tool,
      { description: 'd', name: 'nope', prompt: 'p' },
      { callId: 't2' }
    )
    const text = textOf(out as { content: Array<{ type: string; text?: string }> })
    expect(text).toContain('Unknown agent "nope"')
    expect(text).toContain('explore')
  })
})

// ─── P2-05：派发工具从 api 读调用方（docs/pi-durable/p2-05-test-design.md B 段） ───

const REGISTRY = {
  list: () => [PROFILE],
  get: (name: string) => (name === PROFILE.name ? PROFILE : undefined)
}

type RunTaskSpy = ReturnType<typeof vi.fn<(params: RunTaskParams) => Promise<RunTaskOutcome>>>

function spyTool(outcome: RunTaskOutcome = { result: 'ok' }): {
  tool: ReturnType<typeof createDispatchAgentTool>
  runTask: RunTaskSpy
} {
  const runTask = vi.fn<(params: RunTaskParams) => Promise<RunTaskOutcome>>(async () => outcome)
  const tool = createDispatchAgentTool({
    registry: REGISTRY,
    manager: { runTask } as unknown as SubAgentManager,
    sessionId: 's1',
    abortError: 'Aborted'
  })
  return { tool, runTask }
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('')
}

/** 一张可预填的 memo 表（同 durable：先到的候选值胜出），记下读 / 写的次序 */
function memoTable(seed: [string, JsonValue][] = []): {
  memos: Map<string, JsonValue>
  order: string[]
  memo: (name: string, ...rest: unknown[]) => Promise<JsonValue | undefined>
} {
  const memos = new Map<string, JsonValue>(seed)
  const order: string[] = []
  return {
    memos,
    order,
    memo: async (name, ...rest) => {
      order.push(rest.length < 2 ? `read:${name}` : `write:${name}`)
      if (rest.length < 2) return memos.get(name)
      if (!memos.has(name)) memos.set(name, rest[0] as JsonValue)
      return memos.get(name)
    }
  }
}

describe('DispatchAgentTool — P2-05 deps and the caller from api', () => {
  it('P2-05-08 deps take the session id, no model config or parent id; replay is safe', () => {
    const base = { registry: REGISTRY, manager: {} as SubAgentManager, abortError: 'A' }
    const tool = createDispatchAgentTool({ ...base, sessionId: 's1' })
    // @ts-expect-error -- the caller's model comes from api.agent(), never from deps
    createDispatchAgentTool({ ...base, sessionId: 's1', modelConfig: {} })
    // @ts-expect-error -- the caller comes from api, never from deps
    createDispatchAgentTool({ ...base, sessionId: 's1', parentSessionId: 's1' })
    expect(tool.replay).toBe('safe')
  })

  it('P2-05-09 runTask gets the session, the call scope as owner and the projected profile', async () => {
    const { tool, runTask } = spyTool()
    const invoked = await invokeTool(
      tool,
      { name: 'explore', prompt: 'p', description: 'd' },
      { callId: 'tc-7', taskId: 42, conversationId: 3 }
    )
    expect(runTask).toHaveBeenCalledTimes(1)
    const params = runTask.mock.calls[0]![0]
    expect(Object.keys(params).sort()).toEqual([
      'agentType',
      'description',
      'owner',
      'parentToolCallId',
      'prompt',
      'sessionId'
    ])
    expect(params.sessionId).toBe('s1')
    expect(params.parentToolCallId).toBe('tc-7')
    expect(params.prompt).toBe('p')
    expect(params.description).toBe('d')
    const owner = params.owner as Extract<RunTaskParams['owner'], { tool: unknown }>
    expect(owner.tool.api).toBe(invoked.api)
    expect(owner.tool.taskId).toBe(invoked.api.taskId)
    expect(owner.tool.conversationId).toBe(invoked.api.conversationId)
    expect(owner.tool.callId).toBe('tc-7')
    expect(params.agentType).toEqual(toInProcessAgentType(PROFILE))
  })

  it('P2-05-15 a structured outcome: the text is result; no details from structured; no resultContract passed', async () => {
    const { tool, runTask } = spyTool({ result: 'R', structured: { x: 1 } })
    const { result } = await invokeTool(
      tool,
      { name: 'explore', prompt: 'p', description: 'd' },
      { callId: 'tc-8' }
    )
    expect(resultText(result)).toBe('R')
    expect(result.details).toBeUndefined()
    expect(result.isError).toBeUndefined()
    expect('resultContract' in runTask.mock.calls[0]![0]).toBe(false)
  })

  it.each([
    ['no child + error → Error: prefix', { result: 'Failed', error: 'boom' }, 'Error: boom'],
    [
      'child + error → the result text',
      { result: 'noted', error: 'boom', conversationId: 2, agentId: 'sub-1' },
      'noted'
    ],
    ['clean → the result text', { result: 'found', conversationId: 2, agentId: 'sub-1' }, 'found']
  ] as const)(
    'P2-05-12 PIN-04 model-visible text: %s; never isError',
    async (_label, outcome, text) => {
      const { tool } = spyTool(outcome)
      const { result } = await invokeTool(tool, { name: 'explore', prompt: 'p', description: 'd' })
      expect(resultText(result)).toBe(text)
      expect(result.isError).toBeUndefined()
    }
  )

  it('P2-05-20 PIN-10 the memoised agentType wins on a rerun: no registry lookup, no Unknown agent', async () => {
    const { tool, runTask } = spyTool()
    const table = memoTable([
      ['agentType', JSON.parse(JSON.stringify(toInProcessAgentType(PROFILE))) as JsonValue]
    ])
    const { result } = await invokeTool(
      tool,
      { name: 'gone', prompt: 'p', description: 'd' },
      { api: { memo: table.memo as never } }
    )
    expect(resultText(result)).toBe('ok')
    expect(table.order).toEqual(['read:agentType'])
    expect(runTask.mock.calls[0]![0].agentType).toEqual(toInProcessAgentType(PROFILE))
  })

  it('P2-05-20 PIN-10 the first run memoises the projection (strict JSON) before dispatching', async () => {
    const { tool, runTask } = spyTool()
    const table = memoTable()
    runTask.mockImplementation(async () => {
      table.order.push('runTask')
      return { result: 'ok' }
    })
    await invokeTool(
      tool,
      { name: 'explore', prompt: 'p', description: 'd' },
      { api: { memo: table.memo as never } }
    )
    expect(table.order).toEqual(['read:agentType', 'write:agentType', 'runTask'])
    const stored = table.memos.get('agentType') as Record<string, unknown>
    expect(stored).toEqual(toInProcessAgentType(PROFILE))
    expect(Object.values(stored)).not.toContain(undefined)
  })

  it('P2-05-12 an unknown name is not memoised (nothing to re-attach to)', async () => {
    const { tool, runTask } = spyTool()
    const table = memoTable()
    const { result } = await invokeTool(
      tool,
      { name: 'nope', prompt: 'p', description: 'd' },
      { api: { memo: table.memo as never } }
    )
    expect(resultText(result)).toContain('Unknown agent "nope"')
    expect(table.memos.has('agentType')).toBe(false)
    expect(runTask).not.toHaveBeenCalled()
  })

  it('P2-05-23 PIN-20 an already-aborted call throws abortError before reaching the router', async () => {
    const { tool, runTask } = spyTool()
    const controller = new AbortController()
    controller.abort()
    await expect(
      invokeTool(
        tool,
        { name: 'explore', prompt: 'p', description: 'd' },
        { signal: controller.signal }
      )
    ).rejects.toThrow('Aborted')
    expect(runTask).not.toHaveBeenCalled()
  })

  it('P2-05-16 the signal falls during runTask → the tool rethrows abortError', async () => {
    const controller = new AbortController()
    const { tool, runTask } = spyTool()
    runTask.mockImplementation(async () => {
      controller.abort()
      return { result: 'ABORTED_NOTE', error: 'aborted', conversationId: 2, agentId: 'sub-1' }
    })
    await expect(
      invokeTool(
        tool,
        { name: 'explore', prompt: 'p', description: 'd' },
        { signal: controller.signal }
      )
    ).rejects.toThrow('Aborted')
  })
})
