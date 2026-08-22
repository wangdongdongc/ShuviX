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

/** 假 assistant 的 usage token 数（自动压缩阈值判定取自这里 —— 模拟 provider 真实计量） */
let fakeUsageTokens = 15

function fakeAssistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-model',
    usage: {
      input: fakeUsageTokens - 5,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: fakeUsageTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  } as unknown as AssistantMessage
}

/** 假 Models：stream 回一条固定 assistant 消息；completeSimple 供压缩摘要用 */
let completeSimpleCalls = 0
const fakeModels = {
  streamSimple: () => {
    const out = createAssistantMessageEventStream()
    const msg = fakeAssistant('回复内容')
    out.push({ type: 'start', partial: msg })
    out.push({ type: 'done', reason: 'stop', message: msg })
    return out
  },
  completeSimple: async () => {
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

function makeHarness(autoCompact = false): HarnessSession {
  return new HarnessSession({
    sessionId: 's1',
    session: piSession,
    env: createStubExecutionEnv(),
    models: fakeModels,
    model: fakeModel,
    systemPrompt: 'test',
    tools: [],
    eventSink: { broadcast: (e) => events.push(e.type), hasUserInputCapability: () => false },
    autoCompact
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'shuvix-harness-'))
  completeSimpleCalls = 0
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
