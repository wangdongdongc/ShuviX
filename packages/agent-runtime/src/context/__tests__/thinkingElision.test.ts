/**
 * 历史 thinking 剥离单测。
 *
 * 本模块的价值和风险都在**缓存**上，所以最重要的用例不是「剥对了多少」，而是
 * 「没到阈值时一个字节都没动」以及「未改动的消息仍是同一批对象」—— 那是缓存前缀
 * 逐字节稳定的可测代理。剥错了只是少省点 token；把缓存打穿会让每个请求都变成
 * 满上下文的 cache write，比不做这件事糟几百倍。
 */
import { describe, it, expect } from 'vitest'
import {
  elideHistoricalThinking,
  protectedFrom,
  type ThinkingElisionState,
  type WireMessage
} from '../thinkingElision'

const OPTS = { triggerTokens: 1000, keepTokens: 300 }
/** 造一段 ~n token 的 thinking 文本（估算是 chars/4） */
const think = (n: number, tag = 'x'): string => tag.repeat(n * 4)

type Msg = WireMessage

/** 一轮：assistant(thinking + tool_use) + user(tool_result) */
function turn(i: number, thinkingTokens: number): Msg[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: think(thinkingTokens, String(i % 10)), signature: `sig${i}` },
        { type: 'tool_use', id: `t${i}`, name: 'probe', input: { step: i } }
      ]
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] }
  ]
}

function session(turns: number, tokensPerTurn: number): Msg[] {
  const ms: Msg[] = [{ role: 'user', content: [{ type: 'text', text: '任务' }] }]
  for (let i = 0; i < turns; i++) ms.push(...turn(i, tokensPerTurn))
  return ms
}

const fresh = (): ThinkingElisionState => ({ boundary: 0 })

describe('protectedFrom（保护线）', () => {
  it('取最后一条 assistant 消息 —— 正在被延续的就是它', () => {
    const ms = session(3, 10)
    const lastAssistant = ms.map((m) => m.role).lastIndexOf('assistant')
    expect(protectedFrom(ms)).toBe(lastAssistant)
  })

  it('长循环里用户只说一次话，保护线仍随循环前进', () => {
    // 回归：曾用「最后一条真正的用户消息」当保护线，长 agent 循环里它一路停在 0，
    // 模块永不生效 —— 而那正是最需要它的形状
    const ms = session(200, 10)
    expect(protectedFrom(ms)).toBeGreaterThan(300)
  })

  it('找不到 assistant 消息就返回 0 —— 全程保护，宁可不省', () => {
    expect(protectedFrom([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe(0)
  })
})

describe('缓存前缀稳定性（本模块的第一性质）', () => {
  it('未到上沿：返回同一个数组、同一批对象，一个字节都没动', () => {
    const ms = session(5, 100) // 500 tok < trigger 1000
    const r = elideHistoricalThinking(ms, fresh(), OPTS)
    expect(r.advanced).toBe(false)
    expect(r.elidedBlocks).toBe(0)
    expect(r.messages).toBe(ms) // 同一个数组引用
    expect(JSON.stringify(r.messages)).toBe(JSON.stringify(ms))
  })

  it('越过上沿后剥离一次，紧接着的调用不再动 —— 滞回让跳跃稀疏', () => {
    const state = fresh()
    const ms = [...session(20, 100), { role: 'user', content: [{ type: 'text', text: '继续' }] }]

    const first = elideHistoricalThinking(ms, state, OPTS)
    expect(first.advanced).toBe(true)
    state.boundary = first.boundary

    // 同一份历史再来一次：边界已在位，不该再跳（否则每轮都失配）
    const second = elideHistoricalThinking(first.messages, state, OPTS)
    expect(second.advanced).toBe(false)
    expect(second.messages).toBe(first.messages)
  })

  it('未被剥的消息保持同一对象引用 —— 序列化后逐字节相同', () => {
    const ms = [...session(20, 100), { role: 'user', content: [{ type: 'text', text: '继续' }] }]
    const r = elideHistoricalThinking(ms, fresh(), OPTS)
    expect(r.advanced).toBe(true)
    for (let i = r.boundary; i < ms.length; i++) expect(r.messages[i]).toBe(ms[i])
  })
})

describe('剥离行为', () => {
  it('剥到下沿为止：可剥区间内保留的 thinking 不超过 keepTokens', () => {
    // 下沿只约束**可剥区间** [0, protect)。保护线那条 assistant 的 thinking 永远
    // 额外叠在上面（契约要求），所以总保留量 = keepTokens + 被保护的那一份。
    const ms = [...session(20, 100), { role: 'user', content: [{ type: 'text', text: '继续' }] }]
    const protect = protectedFrom(ms)
    const r = elideHistoricalThinking(ms, fresh(), OPTS)
    const thinkingOf = (from: number, to: number): number => {
      let n = 0
      for (let i = from; i < to; i++) {
        const content = r.messages[i]?.content
        for (const b of Array.isArray(content) ? content : []) {
          if (b.type === 'thinking') n += Math.ceil(String(b.thinking).length / 4)
        }
      }
      return n
    }
    expect(thinkingOf(0, protect)).toBeLessThanOrEqual(OPTS.keepTokens)
    expect(thinkingOf(protect, r.messages.length)).toBe(100) // 被保护的那一份原样还在
    expect(r.elidedTokens).toBeGreaterThan(OPTS.triggerTokens - OPTS.keepTokens)
  })

  it('正在延续的那条 assistant 消息，其 thinking 绝不剥', () => {
    const ms = session(20, 100)
    const r = elideHistoricalThinking(ms, fresh(), OPTS)
    const last = protectedFrom(ms)
    const blocks = r.messages[last].content as Array<Record<string, unknown>>
    expect(blocks.some((b) => b.type === 'thinking')).toBe(true)
    expect(r.messages[last]).toBe(ms[last]) // 连对象都没换
  })

  it('thinking 之外的块原样保留，signature 不被改写', () => {
    const ms = [...session(20, 100), { role: 'user', content: [{ type: 'text', text: '继续' }] }]
    const r = elideHistoricalThinking(ms, fresh(), OPTS)
    const flat = r.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    expect(flat.filter((b) => b.type === 'tool_use')).toHaveLength(20)
    expect(flat.filter((b) => b.type === 'tool_result')).toHaveLength(20)
    // 留下来的 thinking 块必须原样带着签名（只能整块丢，不能改）
    for (const b of flat.filter((b) => b.type === 'thinking')) {
      expect(String(b.signature)).toMatch(/^sig\d+$/)
    }
  })

  it('只有 thinking 的消息整条留着 —— 剥完 content 会空，服务端会拒', () => {
    const ms: Msg[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
    for (let i = 0; i < 20; i++) {
      ms.push({
        role: 'assistant',
        content: [{ type: 'thinking', thinking: think(100), signature: 's' }]
      })
      ms.push({ role: 'user', content: [{ type: 'text', text: `第${i}问` }] })
    }
    const r = elideHistoricalThinking(ms, fresh(), OPTS)
    for (const m of r.messages) {
      if (Array.isArray(m.content)) expect(m.content.length).toBeGreaterThan(0)
    }
  })

  it('redacted_thinking 同样处理', () => {
    const ms: Msg[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
    for (let i = 0; i < 20; i++) {
      ms.push({
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', thinking: think(100), signature: 's' },
          { type: 'tool_use', id: `t${i}`, name: 'p', input: {} }
        ]
      })
      ms.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }]
      })
    }
    ms.push({ role: 'user', content: [{ type: 'text', text: '继续' }] })
    const r = elideHistoricalThinking(ms, fresh(), OPTS)
    expect(r.elidedBlocks).toBeGreaterThan(0)
  })
})

describe('与自动压缩共存', () => {
  it('压缩把列表变短后，越界的旧边界被夹回，且不误伤当前轮', () => {
    // 压缩后：历史被摘要替换，消息数骤降，而 state.boundary 还停在老位置
    const compacted: Msg[] = [
      { role: 'user', content: [{ type: 'text', text: '（摘要）之前的工作' }] },
      ...turn(99, 100)
    ]
    const state: ThinkingElisionState = { boundary: 500 } // 远超新列表长度
    const r = elideHistoricalThinking(compacted, state, OPTS)
    expect(r.boundary).toBeLessThanOrEqual(protectedFrom(compacted))
    // 当前轮的 thinking 必须还在
    const kept = r.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    expect(kept.some((b) => b.type === 'thinking')).toBe(true)
  })
})

describe('自适应：thinking 短的模型不该触发', () => {
  it('每块 26 tok（实测 kimi-k3 的均值）跑 200 轮也不跳边界', () => {
    // 为几十 token 去打穿缓存是净亏，阈值本身就是这个保护
    const ms = [...session(200, 26), { role: 'user', content: [{ type: 'text', text: '继续' }] }]
    const r = elideHistoricalThinking(ms, fresh(), { triggerTokens: 40_000, keepTokens: 4_000 })
    expect(r.advanced).toBe(false)
    expect(r.messages).toBe(ms)
  })
})
