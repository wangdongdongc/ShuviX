import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_PRESENTATIONS } from './builtinToolPresentations'
import { TOOL_SUMMARY_BUILDERS, buildToolSummary } from './toolSummaries'

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

/** Windows 上的命令工具 `powershell` 与 bash 共用一个摘要：模型写的用途说明 + 自定义超时 */
describe('buildToolSummary — powershell', () => {
  it('F2 — 说明 + 超时；没有超时只有说明；空参数没有摘要', () => {
    expect(buildToolSummary('powershell', { description: 'List files', timeout: 30 })).toBe(
      'List files · 30s'
    )
    expect(buildToolSummary('powershell', { description: 'List files' })).toBe('List files')
    expect(buildToolSummary('powershell', {})).toBeUndefined()
  })

  it('F2 — 与 bash 的摘要逐条一致', () => {
    const table: Record<string, unknown>[] = [
      {},
      { command: 'Get-Date' },
      { description: 'Build' },
      { description: 'Build', timeout: 300 },
      { description: 'Build', timeout: 0 },
      { timeout: 45 },
      { description: '', timeout: '10' },
      { description: 'Tail log', run_in_background: true }
    ]
    for (const args of table) {
      expect(buildToolSummary('powershell', args), JSON.stringify(args)).toBe(
        buildToolSummary('bash', args)
      )
    }
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

/**
 * 内置 MCP 能力服务器（`mcp__browser__*` / `mcp__ssh__*`）按前缀认、不逐个登记 —— 表里没有的
 * 名字才去问它；退役的 multiplex `browser` 工具仍按自己的条目给历史会话出摘要。
 */
describe('buildToolSummary — 内置 MCP 工具与退役的 browser 工具', () => {
  it('TS-MCP-1 内置 MCP 工具有摘要；第三方 MCP 工具与未知工具没有', () => {
    expect(buildToolSummary('mcp__browser__click', { uid: 'e1' })).toBe('click e1')
    expect(buildToolSummary('mcp__ssh__exec', { host: 'prod', description: 'Uptime' })).toBe(
      'prod · Uptime'
    )
    expect(buildToolSummary('mcp__tavily__search', { query: 'x' })).toBeUndefined()
    expect(buildToolSummary('unknown_tool', { url: 'https://a.example' })).toBeUndefined()
  })

  it('TS-MCP-2 退役的 multiplex browser 工具：历史会话里的摘要照旧（动作 + 参数）', () => {
    expect(buildToolSummary('browser', { action: 'click', uid: 'e5' })).toBe('click e5')
    expect(buildToolSummary('browser', { action: 'cdp', method: 'Fetch.enable' })).toBe(
      'cdp Fetch.enable'
    )
    expect(buildToolSummary('browser', {})).toBeUndefined()
  })

  it('TS-MCP-3 参数的 getter 抛错 → 没有摘要，不把异常抛进渲染', () => {
    const args = Object.defineProperty({}, 'url', {
      enumerable: true,
      get() {
        throw new Error('boom')
      }
    }) as Record<string, unknown>
    expect(() => buildToolSummary('mcp__browser__open_tab', args)).not.toThrow()
    expect(buildToolSummary('mcp__browser__open_tab', args)).toBeUndefined()
  })

  it('TS-MCP-4 表里为某个 MCP 名登记了摘要函数时，它优先于按前缀的兜底', () => {
    const name = 'mcp__browser__click'
    expect(Object.prototype.hasOwnProperty.call(TOOL_SUMMARY_BUILDERS, name)).toBe(false)
    TOOL_SUMMARY_BUILDERS[name] = () => 'registered'
    try {
      expect(buildToolSummary(name, { uid: 'e1' })).toBe('registered')
    } finally {
      delete TOOL_SUMMARY_BUILDERS[name]
    }
    // 还原后回到兜底
    expect(buildToolSummary(name, { uid: 'e1' })).toBe('click e1')
  })
})

/**
 * session 工具卡的折叠摘要 —— 旧会话的历史里还留着 2026-10-20 之前的动作名（`*-sub-session`），
 * 它们与现在的名字出同一种摘要（只有动作名本身不同）。
 * XS-63
 */
describe('buildToolSummary — session 的旧动作名', () => {
  const summary = (args: Record<string, unknown>): string | undefined =>
    buildToolSummary('session', args)

  it('XS-63 answer-sub-session：选项以逗号相连；用自己的话答时取首个非空行', () => {
    expect(summary({ action: 'answer-sub-session', selections: ['A', 'B'] })).toBe(
      'answer-sub-session · A, B'
    )
    expect(summary({ action: 'answer-sub-session', message: '\n  keep the shim\nmore' })).toBe(
      'answer-sub-session · keep the shim'
    )
  })

  it('XS-63 steer-sub-session：消息首行，超过 48 字截到 47 字加省略号，恰 48 字不截', () => {
    expect(summary({ action: 'steer-sub-session', message: 'x'.repeat(60) })).toBe(
      `steer-sub-session · ${'x'.repeat(47)}…`
    )
    expect(summary({ action: 'steer-sub-session', message: 'y'.repeat(48) })).toBe(
      `steer-sub-session · ${'y'.repeat(48)}`
    )
    expect(summary({ action: 'steer-sub-session', message: '  use v2\nthen rerun' })).toBe(
      'steer-sub-session · use v2'
    )
  })

  it('XS-63 prompt-sub-session 不显示 message（那是一整段派活）', () => {
    expect(summary({ action: 'prompt-sub-session', message: 'Refactor the parser' })).toBe(
      'prompt-sub-session'
    )
  })

  it('XS-63 新名 answer-session / steer-session / prompt-session 与旧名逐条同形', () => {
    expect(summary({ action: 'answer-session', selections: ['A', 'B'] })).toBe(
      'answer-session · A, B'
    )
    expect(summary({ action: 'steer-session', message: 'x'.repeat(60) })).toBe(
      `steer-session · ${'x'.repeat(47)}…`
    )
    expect(summary({ action: 'prompt-session', message: 'Refactor the parser' })).toBe(
      'prompt-session'
    )

    const table: Record<string, unknown>[] = [
      { selections: ['A', 'B'] },
      { selections: ['A', 3] },
      { message: '\n  keep the shim\nmore' },
      { message: 'x'.repeat(60) },
      { message: 'Refactor the parser' },
      {}
    ]
    for (const [legacy, current] of [
      ['answer-sub-session', 'answer-session'],
      ['steer-sub-session', 'steer-session'],
      ['prompt-sub-session', 'prompt-session']
    ]) {
      for (const args of table) {
        const label = `${legacy} ${JSON.stringify(args)}`
        const viaCurrent = summary({ ...args, action: current })
        expect(viaCurrent?.startsWith(current), label).toBe(true)
        expect(summary({ ...args, action: legacy }), label).toBe(
          `${legacy}${viaCurrent!.slice(current.length)}`
        )
      }
    }
  })
})
