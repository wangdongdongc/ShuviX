/**
 * 档案 → 运行投影的纯口径。`model` / 两个注入开关全链路 optional，
 * 搬运断了不会有任何类型错误、只会静默退回「跟随会话模型」—— 故逐字段钉死。
 *
 * 另钉参数校验的纠错指引：错误文案必须指向真实参数名 `name` 并列出可用 agent ——
 * 旧文案写成缺 "agent" 参数，弱模型照抄传 `agent:`（未知属性被 schema 静默放行）
 * 后又收到同一条错，形成误导闭环。
 */
import { describe, it, expect } from 'vitest'
import { createDispatchAgentTool, toInProcessAgentType } from '../dispatchTool'
import type { SubAgentManager } from '../manager'
import type { AgentProfile, SubAgentModelConfig } from '../types'

const PROFILE: AgentProfile = {
  name: 'explore',
  displayName: '探索',
  description: 'explores the codebase',
  systemPrompt: 'BODY',
  tools: ['read', 'grep'],
  instructionFiles: [],
  projectAwareness: false,
  sessionAwareness: false,
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

  it('其余字段原样投影，tools 为副本（不与档案共享数组）', () => {
    const projected = toInProcessAgentType(PROFILE)
    expect(projected).toEqual({
      name: 'explore',
      displayName: '探索',
      description: 'explores the codebase',
      tools: ['read', 'grep'],
      systemPrompt: 'BODY',
      model: undefined,
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
    modelConfig: {} as SubAgentModelConfig,
    parentSessionId: 's1',
    abortError: 'ABORTED'
  })
  const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
    r.content.map((c) => c.text ?? '').join('')

  it('缺 name 且无默认 agent → 指名真实参数 `name` 并列出可用名', async () => {
    const out = await tool.execute('t1', { description: 'd', prompt: 'p' })
    const text = textOf(out as { content: Array<{ type: string; text?: string }> })
    expect(text).toContain('"name"')
    expect(text).toContain('explore')
    // 回归钉：旧文案把参数名写成 "agent"，曾直接教坏调用方
    expect(text).not.toContain('parameter "agent"')
  })

  it('未知 name → 列出可用名', async () => {
    const out = await tool.execute('t2', { description: 'd', name: 'nope', prompt: 'p' })
    const text = textOf(out as { content: Array<{ type: string; text?: string }> })
    expect(text).toContain('Unknown agent "nope"')
    expect(text).toContain('explore')
  })
})
