import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_PRESENTATIONS } from './builtinToolPresentations'
import { buildToolSummary } from './toolSummaries'

describe('buildToolSummary', () => {
  it('includes the bash timeout after its description', () => {
    expect(
      buildToolSummary('bash', {
        command: 'npm run build',
        description: 'Build the desktop app',
        timeout: 300
      })
    ).toBe('Build the desktop app · 300s')
  })

  it('keeps the bash description unchanged when timeout is omitted', () => {
    expect(
      buildToolSummary('bash', {
        command: 'pwd',
        description: 'Show the working directory'
      })
    ).toBe('Show the working directory')
  })
})

describe('buildToolSummary — knowledge', () => {
  it('TS-1 action + 该 action 最有信息量的参数（write 标题 / read 路径 / search 查询词）；只有动作时不带尾巴；无参数无摘要；图标与 labelKey', () => {
    expect(
      buildToolSummary('knowledge', { action: 'write', title: 'Token traps', path: '/g/x.md' })
    ).toBe('write · Token traps')
    expect(buildToolSummary('knowledge', { action: 'read', path: '/g/x.md' })).toBe(
      'read · /g/x.md'
    )
    expect(buildToolSummary('knowledge', { action: 'search', query: 'auth' })).toBe('search · auth')
    expect(buildToolSummary('knowledge', { action: 'list' })).toBe('list')
    expect(buildToolSummary('knowledge', {})).toBeUndefined()
    expect(BUILTIN_TOOL_PRESENTATIONS.knowledge.presentation?.icon).toBe('BookOpen')
    expect(BUILTIN_TOOL_PRESENTATIONS.knowledge.labelKey).toBe('tool.knowledgeLabel')
  })
})
