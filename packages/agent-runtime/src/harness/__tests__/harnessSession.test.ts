/**
 * HarnessSession 集成测试 —— 假流式后端驱动真 AgentHarness + JsonlSessionStorage，
 * 覆盖「对话落盘 → 自动压缩」整条链路。压缩只剩自动这一条路径（手动入口已移除），
 * 所以下面全部经 `prompt()` 驱动。
 *
 * 判定：turn 成功结束后按 pi 的 shouldCompact 判定（tokens > contextWindow - 16k，
 * token 数优先取最近 assistant 的真实 usage），超阈值则压缩并广播 messages_reloaded。
 *
 * 前置短路：pi 的滚动压缩保留最近 keepRecentTokens(20k) 的原始消息，小会话的切点落在
 * 第一条消息上、待摘要区间为空 —— 直接调 harness.compact() 会对空对话生成一条无意义摘要，
 * 且下一次压缩抛 "Nothing to compact"。HarnessSession 用同一套 prepareCompaction 提前
 * 判定并静默跳过（见「usage 超阈值但无实质可摘要内容」一例）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JsonlSessionStorage, Session } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import type { AssistantMessage, Models, Model, Api } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat'
import { HarnessSession } from '../harnessSession'
import { createStubExecutionEnv } from '../stubEnv'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

/** 假 assistant 的 usage token 数（自动压缩阈值判定取自这里 —— 模拟 provider 真实计量） */
let fakeUsageTokens = 15

function fakeAssistant(text: string, tokens = fakeUsageTokens): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-model',
    usage: {
      input: tokens - 5,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  } as unknown as AssistantMessage
}

/** 假 Models：stream 回一条固定 assistant 消息；completeSimple 供压缩摘要用 */
let completeSimpleCalls = 0
/** LLM 调用顺序（'stream' = 正式请求，'complete' = 压缩摘要）——用于断言压缩早于请求 */
let llmCalls: string[] = []
const fakeModels = {
  streamSimple: () => {
    llmCalls.push('stream')
    const out = createAssistantMessageEventStream()
    const msg = fakeAssistant('回复内容')
    out.push({ type: 'start', partial: msg })
    out.push({ type: 'done', reason: 'stop', message: msg })
    return out
  },
  completeSimple: async () => {
    llmCalls.push('complete')
    completeSimpleCalls++
    return fakeAssistant('这是压缩摘要')
  }
} as unknown as Models

const fakeModel = {
  id: 'fake-model',
  name: 'fake',
  api: 'openai-completions' as Api,
  provider: 'fake',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096
} as unknown as Model<Api>

/** 造一条大体积 user 消息（撑 entry 层的字符启发式估算） */
const big = (n: number): never =>
  ({
    role: 'user',
    content: [{ type: 'text', text: 'x'.repeat(n) }],
    timestamp: Date.now()
  }) as never

let dir: string
let piSession: Session
let hs: HarnessSession
let events: string[]

function makeHarness(autoCompact = false, model: Model<Api> = fakeModel): HarnessSession {
  return new HarnessSession({
    sessionId: 's1',
    session: piSession,
    env: createStubExecutionEnv(),
    models: fakeModels,
    model,
    systemPrompt: 'test',
    tools: [],
    eventSink: { broadcast: (e) => events.push(e.type), hasUserInputCapability: () => false },
    autoCompact
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shuvix-harness-'))
  completeSimpleCalls = 0
  llmCalls = []
  fakeUsageTokens = 15
  events = []
  const env = new NodeExecutionEnv({ cwd: dir })
  const storage = await JsonlSessionStorage.create(env, join(dir, 's1.jsonl'), {
    cwd: dir,
    sessionId: 's1'
  })
  piSession = new Session(storage)
  hs = makeHarness()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('HarnessSession', () => {
  it('一轮对话落盘为 user + assistant entry，并广播完整事件序列', async () => {
    const { error } = await hs.prompt('你好')
    expect(error).toBeUndefined()
    const types = (await piSession.getBranch()).map((e) => e.type)
    expect(types).toEqual(['message', 'message'])
    expect(events).toContain('agent_start')
    expect(events).toContain('agent_end')
  })

  // ─── 中止后的用户输入窗口 ─────────────────────────────

  it('中止后新到的询问直接判为已取消（否则关停与工具互等，会话永远停在「正在停止」）', async () => {
    // 关停链路是「abort() 等 run 跑完」+「宿主按当前绑定的运行时路由用户应答」。
    // 正在关停的运行时已不在绑定表里，此时若还接受新询问，那条挂起就再也没人应答 ——
    // 双方互等，会话卡死。所以中止之后到下一次 prompt 之前，一律当作已取消。
    const withInput = new HarnessSession({
      sessionId: 's1',
      session: piSession,
      env: createStubExecutionEnv(),
      models: fakeModels,
      model: fakeModel,
      systemPrompt: 'test',
      tools: [],
      eventSink: { broadcast: (e) => events.push(e.type), hasUserInputCapability: () => true },
      autoCompact: false
    })
    const ask = (id: string): Promise<InputResponse> =>
      withInput.requestUserInput({ id, kind: 'ask', toolName: 'bash', command: 'ls', createdAt: 0 })

    // 中止前：正常挂起，等用户应答
    let settled: InputResponse | undefined
    void ask('r1').then((r) => (settled = r))
    await Promise.resolve()
    expect(settled).toBeUndefined()

    await withInput.abort()
    expect(settled).toEqual({ kind: 'cancel', reason: 'aborted' })

    // 中止后新到的询问：立刻取消，不再挂起
    await expect(ask('r2')).resolves.toEqual({ kind: 'cancel', reason: 'aborted' })

    // 下一轮开始后恢复受理
    await withInput.prompt('继续')
    let afterPrompt: InputResponse | undefined
    void ask('r3').then((r) => (afterPrompt = r))
    await Promise.resolve()
    expect(afterPrompt).toBeUndefined()
  })

  // ─── 自动压缩 ────────────────────────────────────────

  it('自动压缩：turn 结束后 usage 超阈值 → 生成摘要 + compaction entry + messages_reloaded', async () => {
    // 结构：一条旧的超大消息（~30k tokens）+ 足够撑满保留窗口（20k）的近期消息 ——
    // 切点会落在近期消息的起点，旧消息进入待摘要区间。
    // （注意：从尾部累加时"跨越 20k 的那条"本身会被保留，所以近期尾部必须自己 ≥ 20k）
    const auto = makeHarness(true)
    await piSession.appendMessage(big(120_000)) // 旧历史 ~30k tokens
    await piSession.appendMessage(big(48_000)) // 近期 ~12k tokens
    await piSession.appendMessage(big(48_000)) // 近期 ~12k tokens
    // 本轮 provider 真实 usage 超阈值：128k 窗口 - 16k 预留 = 111616
    fakeUsageTokens = 120_000

    const { error } = await auto.prompt('继续')
    expect(error).toBeUndefined()
    expect(completeSimpleCalls).toBeGreaterThan(0)

    const types = (await piSession.getBranch()).map((e) => e.type)
    expect(types[types.length - 1]).toBe('compaction')
    // 压缩提交后广播 messages_reloaded 供前端重拉
    expect(events).toContain('messages_reloaded')

    // 压缩后上下文回落，下一轮不会再触发（幂等收敛）
    completeSimpleCalls = 0
    fakeUsageTokens = 15
    await auto.prompt('再来一轮')
    expect(completeSimpleCalls).toBe(0)
  })

  it('自动压缩：低于阈值不触发（零 LLM 调用、树不变）', async () => {
    const auto = makeHarness(true)
    await auto.prompt('你好')
    expect(completeSimpleCalls).toBe(0)
    const types = (await piSession.getBranch()).map((e) => e.type)
    expect(types).toEqual(['message', 'message'])
  })

  /**
   * 回归：provider 偶发空回复（text:''、output 1 token）带回来的 usage 是坏数据
   * ——`cacheRead` 归零、`prompt_tokens` 少算系统提示词+工具 schema（实测 -24k）。
   * pi 的 estimateContextTokens 锚定「最后一条有效 assistant 的 usage」，而空回复的
   * stopReason 恰好是 'stop'（pi 只排除 error/aborted），于是它会把估算拽回阈值以下，
   * 压缩永不触发 —— 真实现场连着 3 次 continue 都因此没压，最后 400 撞窗口。
   */
  it('自动压缩：末尾的空回复不当估算锚点（回归）', async () => {
    const auto = makeHarness(true)
    await piSession.appendMessage(big(120_000)) // 旧历史 ~30k tokens，供摘要
    await piSession.appendMessage(big(48_000)) // 近期 ~12k
    await piSession.appendMessage(big(48_000)) // 近期 ~12k
    // 真实调用：usage 已越阈值（128k 窗口，本模型阈值 111104）
    await piSession.appendMessage(fakeAssistant('真实回复', 120_000) as never)
    // 紧随其后的空回复：usage 少报到 15
    await piSession.appendMessage(fakeAssistant('', 15) as never)

    await auto.prompt('继续')

    // 锚点回落到前一条真实调用 → 压缩照常触发
    expect(completeSimpleCalls).toBeGreaterThan(0)
    const types = (await piSession.getBranch()).map((e) => e.type)
    expect(types).toContain('compaction')
  })

  /**
   * 轮内顶爆上下文时补救不了（pi 的 compact() 要求 harness 空闲），所以下一发请求
   * 出门前必须先称一次 —— 断言摘要调用排在正式请求之前。
   */
  it('自动压缩：发送前判定，压缩早于本轮请求发出', async () => {
    const auto = makeHarness(true)
    await piSession.appendMessage(big(120_000))
    await piSession.appendMessage(big(48_000))
    await piSession.appendMessage(big(48_000))
    await piSession.appendMessage(fakeAssistant('上一轮把上下文顶爆了', 120_000) as never)

    await auto.prompt('继续')

    expect(llmCalls[0]).toBe('complete') // 压缩摘要
    expect(llmCalls).toContain('stream') // 之后才是正式请求
  })

  /**
   * pi 默认 reserve 16k 恰好等于我们给模型的默认 maxTokens —— 阈值只够模型写完自己那条
   * 回复，留给本轮工具结果的余量是 0。阈值须额外让出「maxTokens + 窗口的 10%」。
   */
  it('压缩阈值：reserve 覆盖模型输出预算 + 一轮工具结果余量', async () => {
    // 窗口 128k、maxTokens 32k → reserve = max(16384, 32000+12800) = 44800 → 阈值 83200；
    // pi 默认 reserve 16384 → 阈值 111616。取 100k：pi 默认不会压，我们会。
    const auto = makeHarness(true, { ...fakeModel, maxTokens: 32_000 } as Model<Api>)
    await piSession.appendMessage(big(120_000))
    await piSession.appendMessage(big(48_000))
    await piSession.appendMessage(big(48_000))
    fakeUsageTokens = 100_000

    await auto.prompt('继续')

    expect(completeSimpleCalls).toBeGreaterThan(0)
    const types = (await piSession.getBranch()).map((e) => e.type)
    expect(types).toContain('compaction')
  })

  it('自动压缩：usage 超阈值但无实质可摘要内容时静默跳过', async () => {
    // 现实对应：巨型系统提示词/工具定义把 usage 顶过阈值，但对话本身很小 ——
    // 滚动压缩没有早于保留窗口的历史可摘，应静默跳过而不是压出空摘要。
    const auto = makeHarness(true)
    fakeUsageTokens = 120_000
    await auto.prompt('你好')
    expect(completeSimpleCalls).toBe(0)
    const types = (await piSession.getBranch()).map((e) => e.type)
    expect(types).toEqual(['message', 'message'])
  })
})
