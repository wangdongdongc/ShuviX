import { describe, it, expect, vi, type Mock } from 'vitest'
import { SessionTitler, type SessionTitlerDeps, type TitleSourceMessage } from '../sessionTitler'

const DEFAULT_TITLE = '新对话'

interface Harness {
  state: {
    title: string
    messages: TitleSourceMessage[]
    /** 依次写入的标题（applyTitle 调用序列） */
    applied: string[]
    /** 依次送入模型的对话文本 */
    prompts: string[]
  }
  deps: SessionTitlerDeps
  generate: Mock<(conversationText: string) => Promise<string | null>>
  titler: SessionTitler
}

/** 可控的宿主桩：内存标题 + 消息表 + 可编排的 generate 返回值 */
function makeHarness(opts?: {
  initialTitle?: string
  messages?: TitleSourceMessage[]
  generate?: (text: string) => Promise<string | null>
}): Harness {
  const state = {
    title: opts?.initialTitle ?? DEFAULT_TITLE,
    messages: opts?.messages ?? [],
    applied: [] as string[],
    prompts: [] as string[]
  }
  // 默认每次产出不同标题（标题1 / 标题2 …），便于区分 quick 与 refine 的写入
  let calls = 0
  const generate = vi.fn(async (conversationText: string) => {
    state.prompts.push(conversationText)
    calls += 1
    return opts?.generate ? opts.generate(conversationText) : `标题${calls}`
  })
  const deps: SessionTitlerDeps = {
    getCurrentTitle: () => state.title,
    getDefaultTitle: () => DEFAULT_TITLE,
    listMessages: () => state.messages,
    generate,
    applyTitle: (title) => {
      state.title = title
      state.applied.push(title)
    },
    warn: vi.fn()
  }
  return { state, deps, generate, titler: new SessionTitler(deps) }
}

/** 构造 n 条 user/assistant 交替的文本消息 */
function textMessages(n: number): TitleSourceMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    type: 'text',
    content: `消息 ${i}`
  }))
}

describe('SessionTitler — quick 阶段', () => {
  it('会话仍是默认标题时生成并落库', async () => {
    const h = makeHarness()
    await h.titler.quick('帮我修下登录按钮')

    expect(h.state.applied).toEqual(['标题1'])
    expect(h.generate).toHaveBeenCalledOnce()
    expect(h.state.prompts[0]).toBe('User: 帮我修下登录按钮')
  })

  it('标题非默认值（用户已改名 / 笔记本会话文件名）时跳过', async () => {
    const h = makeHarness({ initialTitle: 'notes.md' })
    await h.titler.quick('帮我修下登录按钮')

    expect(h.generate).not.toHaveBeenCalled()
    expect(h.state.title).toBe('notes.md')
  })

  it('只跑一次 —— 第二轮 prompt 不再触发', async () => {
    const h = makeHarness()
    await h.titler.quick('第一句')
    h.state.title = DEFAULT_TITLE // 即便标题被重置回默认值也不重跑
    await h.titler.quick('第二句')

    expect(h.generate).toHaveBeenCalledOnce()
  })

  it('空输入不触发，且不消耗 quick 名额', async () => {
    const h = makeHarness()
    await h.titler.quick('   ')
    expect(h.generate).not.toHaveBeenCalled()

    await h.titler.quick('真实输入')
    expect(h.generate).toHaveBeenCalledOnce()
  })

  it('会话已不存在（标题为 null）时跳过', async () => {
    const h = makeHarness()
    h.deps.getCurrentTitle = () => null
    await h.titler.quick('帮我修下登录按钮')

    expect(h.generate).not.toHaveBeenCalled()
  })

  it('未配置标题模型（generate → null）时不覆盖默认标题', async () => {
    const h = makeHarness({ generate: async () => null })
    await h.titler.quick('帮我修下登录按钮')

    expect(h.state.applied).toEqual([])
    expect(h.state.title).toBe(DEFAULT_TITLE)
  })

  it('generate 抛错时吞掉并告警，不影响会话主流程', async () => {
    const h = makeHarness({
      generate: async () => {
        throw new Error('boom')
      }
    })
    await expect(h.titler.quick('帮我修下登录按钮')).resolves.toBeUndefined()
    expect(h.deps.warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })
})

describe('SessionTitler — refine 阶段', () => {
  /** 跑完 quick 并铺够上下文，进入可精修状态 */
  async function primed(messageCount = 4): Promise<Harness> {
    const h = makeHarness()
    await h.titler.quick('第一句')
    h.state.messages = textMessages(messageCount)
    return h
  }

  it('上下文够时用整段对话重生成并覆盖粗标题', async () => {
    const h = await primed()
    await h.titler.refine()

    expect(h.state.applied).toEqual(['标题1', '标题2'])
    expect(h.state.prompts[1]).toContain('User: 消息 0')
    expect(h.state.prompts[1]).toContain('Assistant: 消息 1')
  })

  it('上下文不足（<3 条文本消息）时跳过，之后补够仍可精修', async () => {
    const h = await primed(2)
    await h.titler.refine()
    expect(h.generate).toHaveBeenCalledOnce()

    h.state.messages = textMessages(4)
    await h.titler.refine()
    expect(h.generate).toHaveBeenCalledTimes(2)
  })

  it('工具调用等非文本消息不计入上下文门槛', async () => {
    const h = await primed(0)
    h.state.messages = [
      { role: 'user', type: 'text', content: '问题' },
      { role: 'assistant', type: 'tool_use', content: '工具' },
      { role: 'assistant', type: 'step_thinking', content: '思考' }
    ]
    await h.titler.refine()

    expect(h.generate).toHaveBeenCalledOnce() // 仅 quick 那次
  })

  it('用户在 quick 后手动改名则不覆盖', async () => {
    const h = await primed()
    h.state.title = '我自己起的名字'
    await h.titler.refine()

    expect(h.generate).toHaveBeenCalledOnce()
    expect(h.state.title).toBe('我自己起的名字')
  })

  it('quick 未跑过（如 hook deny 了首个 prompt）时不精修', async () => {
    const h = makeHarness({ messages: textMessages(4) })
    await h.titler.refine()

    expect(h.generate).not.toHaveBeenCalled()
  })

  it('只精修一次', async () => {
    const h = await primed()
    await h.titler.refine()
    await h.titler.refine()

    expect(h.generate).toHaveBeenCalledTimes(2) // quick + refine 各一次
  })

  it('对话文本截断到末尾 1000 字', async () => {
    const h = await primed(0)
    h.state.messages = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      type: 'text',
      content: 'x'.repeat(500)
    }))
    await h.titler.refine()

    expect(h.state.prompts[1]).toHaveLength(1000)
  })
})
