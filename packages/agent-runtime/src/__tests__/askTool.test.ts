/**
 * ask 工具（askTool.ts）—— pi-durable 原生注册项。
 *
 * 契约（文件头 + 裁定 Q12）：
 *   ASK-1 注册项形状：name 'ask'、`replay: 'safe'`（问一句不改任何东西，中断后重跑 = 再问一遍）、
 *         schema / 描述、label 缺省 'Ask' 可由宿主换、durable 兜底截断取 2× 缺省
 *   ASK-2 询问 id = `api.callId`；请求的其余字段（choice / ask / question / options / allowMultiple 缺省 false）
 *   ASK-3 应答 → 结果文字与 details（选了 / 没选 / 写了反馈 / 意外的应答种类）
 *   ASK-4 用户取消卡片（调用没被取消）→ isError 结果，文字是 abortError（缺省 'Aborted'），不抛
 *   ASK-5 询问通道出错（requestUserInput 抛 / reject）→ isError 结果，文字即那条错误
 *   ASK-6 context 已取消 → 调用拒绝（取消照旧抛），根本不发起询问
 *   ASK-7 等待中被取消 → 立刻拒绝，哪怕询问永远没人应答
 *   ASK-8 应答到了、但此时调用已被取消 → 拒绝（不交回结果）
 */
import { describe, expect, it, vi } from 'vitest'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { AskParamsSchema, ASK_DESCRIPTION, createAskTool } from '../askTool'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from '../fileTools/truncate'
import { invokeTool, resultText } from '../tools/testing/invokeTool'

const ARGS = {
  question: 'Which style?',
  options: [
    { label: 'Terse', description: 'Short answers' },
    { label: 'Verbose', description: 'Long answers' }
  ]
}

/** 记下每一次询问、按给定应答作答的通道 */
function channel(answer: (req: InputRequest) => InputResponse | Promise<InputResponse>): {
  requestUserInput: ReturnType<typeof vi.fn<(req: InputRequest) => Promise<InputResponse>>>
} {
  return { requestUserInput: vi.fn(async (req: InputRequest) => answer(req)) }
}

describe('ASK 注册项形状', () => {
  it('ASK-1 name / replay safe / schema / 描述 / label（缺省与宿主给的）/ 兜底截断', () => {
    const tool = createAskTool({ requestUserInput: vi.fn() })
    expect(tool).toMatchObject({
      name: 'ask',
      label: 'Ask',
      replay: 'safe',
      description: ASK_DESCRIPTION,
      outputLimits: {
        maxBytes: 2 * DEFAULT_MAX_BYTES,
        maxLines: 2 * DEFAULT_MAX_LINES,
        retain: 'head'
      }
    })
    expect(tool.parameters).toBe(AskParamsSchema)
    expect(createAskTool({ requestUserInput: vi.fn(), label: '询问' }).label).toBe('询问')
  })
})

describe('ASK 询问与应答', () => {
  it('ASK-2 询问 id 就是 api.callId；其余字段照参数填，allowMultiple 缺省 false', async () => {
    const { requestUserInput } = channel(() => ({ kind: 'choice', selections: ['Terse'] }))
    const tool = createAskTool({ requestUserInput })

    await invokeTool(tool, ARGS, { callId: 'call-ask-1', taskId: 7 })
    await invokeTool(tool, { ...ARGS, allowMultiple: true }, { callId: 'call-ask-2' })

    expect(requestUserInput).toHaveBeenCalledTimes(2)
    expect(requestUserInput.mock.calls[0][0]).toStrictEqual({
      id: 'call-ask-1',
      kind: 'choice',
      toolName: 'ask',
      question: 'Which style?',
      options: ARGS.options,
      allowMultiple: false,
      createdAt: expect.any(Number)
    })
    expect(requestUserInput.mock.calls[1][0]).toMatchObject({
      id: 'call-ask-2',
      allowMultiple: true
    })
  })

  it.each([
    [
      '选了两项',
      { kind: 'choice', selections: ['Terse', 'Verbose'] },
      'User selected: Terse, Verbose',
      ['Terse', 'Verbose']
    ],
    ['一项没选', { kind: 'choice', selections: [] }, 'User made no selection', []],
    [
      '写了反馈',
      { kind: 'other', text: 'neither, be funny' },
      'User did not select any option and responded with feedback instead:\nneither, be funny',
      []
    ],
    [
      '意外的应答种类',
      { kind: 'ask', allowed: true },
      'User input error: unexpected response kind',
      []
    ]
  ])('ASK-3 %s → 文字与 details', async (_label, response, text, selections) => {
    const { requestUserInput } = channel(() => response as InputResponse)
    const { result } = await invokeTool(createAskTool({ requestUserInput }), ARGS)

    expect(result).toStrictEqual({
      content: [{ type: 'text', text }],
      details: { type: 'ask', question: 'Which style?', selections }
    })
  })
})

describe('ASK 失败与取消', () => {
  it('ASK-4 用户取消卡片（调用本身没被取消）→ isError，文字是 abortError；不抛', async () => {
    const cancel = (): InputResponse => ({ kind: 'cancel', reason: 'aborted' })

    const byDefault = await invokeTool(createAskTool(channel(cancel)), ARGS)
    expect(byDefault.result).toStrictEqual({
      isError: true,
      content: [{ type: 'text', text: 'Aborted' }]
    })

    const custom = await invokeTool(
      createAskTool({ ...channel(cancel), abortError: 'TOOL_ABORTED' }),
      ARGS
    )
    expect(custom.result.isError).toBe(true)
    expect(resultText(custom.result)).toBe('TOOL_ABORTED')
  })

  it('ASK-5 询问通道出错 → isError，文字即那条错误（同步抛与 reject 一样）', async () => {
    const throwing = createAskTool({
      requestUserInput: () => {
        throw new Error('requestUserInput callback not available')
      }
    })
    const { result } = await invokeTool(throwing, ARGS)
    expect(result).toStrictEqual({
      isError: true,
      content: [{ type: 'text', text: 'requestUserInput callback not available' }]
    })

    const rejecting = createAskTool({
      requestUserInput: () => Promise.reject(new Error('frontend gone'))
    })
    expect(resultText((await invokeTool(rejecting, ARGS)).result)).toBe('frontend gone')
  })

  it('ASK-6 context 已取消 → 调用拒绝，根本不发起询问', async () => {
    const { requestUserInput } = channel(() => ({ kind: 'choice', selections: [] }))
    const ac = new AbortController()
    ac.abort()

    await expect(
      invokeTool(createAskTool({ requestUserInput }), ARGS, { signal: ac.signal })
    ).rejects.toThrow('Aborted')
    expect(requestUserInput).not.toHaveBeenCalled()
  })

  it('ASK-7 等待中被取消 → 立刻拒绝，哪怕询问永远没人应答', async () => {
    const requestUserInput = vi.fn(() => new Promise<InputResponse>(() => {}))
    const ac = new AbortController()

    const call = invokeTool(createAskTool({ requestUserInput }), ARGS, { signal: ac.signal })
    await vi.waitFor(() => expect(requestUserInput).toHaveBeenCalledTimes(1))
    ac.abort()

    await expect(call).rejects.toBeDefined()
    expect(ac.signal.aborted).toBe(true)
  })

  it('ASK-8 应答到了、但调用已在这之前被取消 → 拒绝，不交回结果', async () => {
    const ac = new AbortController()
    const requestUserInput = vi.fn(async (): Promise<InputResponse> => {
      // 会话中止的顺序：先撤询问（这里以「选了」作答模拟应答抢先到达），同一刻取消调用
      ac.abort()
      return { kind: 'choice', selections: ['Terse'] }
    })

    await expect(
      invokeTool(createAskTool({ requestUserInput }), ARGS, { signal: ac.signal })
    ).rejects.toBeDefined()
  })
})
