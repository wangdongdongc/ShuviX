/**
 * `cacheHitRate` —— 提示词缓存命中率的纯算术：命中 / （未命中 + 命中 + 写入），按 token 加权。
 *
 * 钉三件事：
 *  - **没有数据不是 0%**：分母为 0 回 null，与「真 0%」（有输入、一次没命中）分开 ——
 *    面板靠这一点把「尚无调用」画成空占位，而不是 0%。
 *  - **写入进分母、不进分子**：只有写入（Anthropic 首次调用的形状）是 0%，不是 null，也不是
 *    被忽略；三项都进分母，分母既不是 input + cacheRead，也不是只有 input。
 *  - **只做算术**：传入完整的 `AgentMonitorCacheUsage` 时不看 `reported` / `calls`
 *    （「provider 从不上报」由调用方用 reported 门掉），也不修改入参。
 *
 * 负数 / NaN 入参不钉：上游注册中心已按 `|| 0` 归零，这里的行为不是契约。
 *
 *   C-1  全 0 → null
 *   C-2  只有 input → 0（且不是 null）
 *   C-3  只有 cacheRead → 1
 *   C-4  只有 cacheWrite → 0（且不是 null）
 *   C-5  三项都有 → cacheRead / 三项之和
 *   C-6  三项各 1 → 1/3
 *   C-7  超大数不溢出
 *   C-8  完整的 AgentMonitorCacheUsage：reported=false / calls=0 不影响算术
 *   C-9  不修改入参（冻结对象不抛、前后深比较相等）
 */
import { describe, expect, it } from 'vitest'
import { cacheHitRate } from './cacheHitRate'
import type { AgentMonitorCacheUsage } from '../types/agentMonitor'

describe('cacheHitRate', () => {
  it('C-1 三项全 0：null（没有数据不是 0%）', () => {
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull()
  })

  it('C-2 只有未命中的输入：真 0%，与「没有数据」区分开', () => {
    const rate = cacheHitRate({ input: 100, cacheRead: 0, cacheWrite: 0 })
    expect(rate).not.toBeNull()
    expect(rate).toBe(0)
  })

  it('C-3 全部命中：1', () => {
    expect(cacheHitRate({ input: 0, cacheRead: 500, cacheWrite: 0 })).toBe(1)
  })

  it('C-4 只有写入：0 且不是 null —— 写入计进分母、不计进分子', () => {
    const rate = cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 200 })
    expect(rate).not.toBeNull()
    expect(rate).toBe(0)
  })

  it('C-5 三项都进分母：300 / (100 + 300 + 100) = 0.6', () => {
    // 分母若是 input + cacheRead 会得 0.75，只有 input 会得 3
    expect(cacheHitRate({ input: 100, cacheRead: 300, cacheWrite: 100 })).toBe(0.6)
  })

  it('C-6 三项各 1：1/3', () => {
    expect(cacheHitRate({ input: 1, cacheRead: 1, cacheWrite: 1 })).toBeCloseTo(1 / 3)
  })

  it('C-7 超大数：结果有限、不溢出', () => {
    const rate = cacheHitRate({ input: 3e9, cacheRead: 1e9, cacheWrite: 0 })
    expect(rate).toBe(0.25)
    expect(Number.isFinite(rate)).toBe(true)
  })

  it('C-8 完整的 AgentMonitorCacheUsage：只用三项做算术，不看 reported 与 calls', () => {
    const usage: AgentMonitorCacheUsage = {
      calls: 0,
      input: 100,
      cacheRead: 100,
      cacheWrite: 0,
      reported: false,
      last: { input: 7, cacheRead: 0, cacheWrite: 0 }
    }
    expect(cacheHitRate(usage)).toBe(0.5)
  })

  it('C-9 不修改入参：冻结对象不抛，调用前后深比较相等', () => {
    const usage = Object.freeze({
      calls: 3,
      input: 100,
      cacheRead: 300,
      cacheWrite: 100,
      reported: true,
      last: Object.freeze({ input: 1, cacheRead: 2, cacheWrite: 3 })
    })
    const copy = JSON.parse(JSON.stringify(usage)) as typeof usage
    expect(() => cacheHitRate(usage)).not.toThrow()
    expect(usage).toEqual(copy)
  })
})
