/**
 * 档案 → 运行投影的纯口径。`model` / 两个注入开关全链路 optional，
 * 搬运断了不会有任何类型错误、只会静默退回「跟随会话模型」—— 故逐字段钉死。
 */
import { describe, it, expect } from 'vitest'
import { toInProcessAgentType } from '../dispatchTool'
import type { AgentProfile } from '../types'

const PROFILE: AgentProfile = {
  name: 'explore',
  displayName: '探索',
  description: 'explores the codebase',
  systemPrompt: 'BODY',
  tools: ['read', 'grep'],
  instructionFiles: [],
  projectPrompt: false,
  projectMemory: false,
  dispatchOnly: false,
  source: 'builtin',
  basePath: ''
}

describe('toInProcessAgentType', () => {
  it('model / instructionFiles / projectPrompt 逐字段带到投影', () => {
    const projected = toInProcessAgentType({
      ...PROFILE,
      model: 'openai/gpt-4o',
      instructionFiles: ['AGENTS.md'],
      projectPrompt: true
    })
    expect(projected.model).toBe('openai/gpt-4o')
    expect(projected.instructionFiles).toEqual(['AGENTS.md'])
    expect(projected.projectPrompt).toBe(true)
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
      projectPrompt: false,
      projectMemory: false
    })
    expect(projected.tools).not.toBe(PROFILE.tools)
  })
})
