/**
 * agent.getInfo 的懒创建开关（会话面板 Agent 页「打开即建」的后端契约）：
 * 默认只读已存在的 Agent（未发过消息 → null），传 { ensure: true } 就地建出运行时并返回快照，
 * 且该运行时留存下来（此后不带 ensure 也读得到）。整个过程不请求 LLM（隔离实例无 API key）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'

let app: E2EApp

beforeAll(async () => {
  app = await launchApp()
})
afterAll(async () => {
  await app.stop()
})

describe('agent.getInfo ensure', () => {
  it('未发过消息：默认返回 null；ensure 就地创建并返回完整快照，之后常规读取也可取到', async () => {
    const result = await app.main.eval<{
      before: unknown
      ensured: {
        systemPrompt: string
        toolCount: number
        model: { provider: string; id: string; contextWindow: number }
        messageCount: number
        isStreaming: boolean
      } | null
      after: { systemPrompt: string } | null
    }>(
      `(async () => {
        const s = await window.api.session.create({ title: 'e2e-agent-info' })
        const sid = s.id
        const before = await window.api.agent.getInfo(sid)
        const info = await window.api.agent.getInfo(sid, { ensure: true })
        const after = await window.api.agent.getInfo(sid)
        return {
          before,
          ensured: info && {
            systemPrompt: info.systemPrompt,
            toolCount: info.tools.length,
            model: {
              provider: info.model.provider,
              id: info.model.id,
              contextWindow: info.model.contextWindow
            },
            messageCount: info.messageCount,
            isStreaming: info.isStreaming
          },
          after: after && { systemPrompt: after.systemPrompt }
        }
      })()`
    )

    expect(result.before).toBeNull()
    expect(result.ensured).not.toBeNull()
    expect(result.ensured!.systemPrompt).toContain('Working directory:')
    expect(result.ensured!.toolCount).toBeGreaterThan(0)
    // 模型字段来自内存中的 agent.state；隔离实例未配置任何供应商，故只断言形状不断言取值
    expect(typeof result.ensured!.model.provider).toBe('string')
    expect(typeof result.ensured!.model.id).toBe('string')
    expect(typeof result.ensured!.model.contextWindow).toBe('number')
    expect(result.ensured!.messageCount).toBe(0)
    expect(result.ensured!.isStreaming).toBe(false)
    // ensure 建出的运行时留在会话管理器里 —— 之后不带 ensure 也读得到同一份系统提示词
    expect(result.after?.systemPrompt).toBe(result.ensured!.systemPrompt)
  })
})
