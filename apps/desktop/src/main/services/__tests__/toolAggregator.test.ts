/**
 * toolAggregator —— 「哪些工具名算可用」的唯一判据，也是会话勾选被滤掉的唯一地方。
 *
 * 惰性启动改掉的正是这里：MCP 的可用性从「连上了」变成「配置里启用了」（`getEnabledToolNames`）。
 * 按连接状态算的话，一台用户勾好的服务器会在创建 Agent 的**前一刻**被 `filterAvailableTools`
 * 抹掉 —— 而它恰恰要在下一步才被连起来，于是「勾了却没有工具」，且因为整份替换写回，勾选还会
 * 永久丢失。这条用例就钉这一点：启用但没连上的仍在，不存在的才剔除。
 *
 * 三个上游全是替身：真 toolRegistry 要靠工具模块自注册（会拖进整个 main 进程），
 * 真 mcpService/skillService 要 SQLite 与文件系统。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getBuiltinToolEntries: vi.fn(),
  getEnabledToolNames: vi.fn(),
  findEnabled: vi.fn()
}))

vi.mock('../toolRegistry', () => ({ getBuiltinToolEntries: mocks.getBuiltinToolEntries }))
vi.mock('../mcpService', () => ({ mcpService: { getEnabledToolNames: mocks.getEnabledToolNames } }))
vi.mock('../skillService', () => ({ skillService: { findEnabled: mocks.findEnabled } }))

import { filterAvailableTools, getAllToolNames } from '../toolAggregator'

beforeEach(() => {
  mocks.getBuiltinToolEntries.mockReturnValue([
    { name: 'bash' },
    { name: 'read' },
    { name: 'edit' }
  ])
  // 「启用但从没连上」—— 惰性启动下这是常态，不是不可用
  mocks.getEnabledToolNames.mockReturnValue(['mcp:a'])
  mocks.findEnabled.mockReturnValue([{ name: 'x' }])
})

describe('MCP 可用性按配置算，不按连接状态', () => {
  it('MCPL-U-15: getAllToolNames 收下已启用（未连接）的 MCP', () => {
    const names = getAllToolNames()
    expect(names).toContain('mcp:a')
    expect(names).toEqual(['bash', 'read', 'edit', 'mcp:a', 'skill:x'])
    // 读的是「已启用」而不是「已连接」的那个入口
    expect(mocks.getEnabledToolNames).toHaveBeenCalled()
  })

  it('MCPL-U-15: filterAvailableTools 保留已启用但没连上的勾选，只剔除已不存在的，且保持入参序', () => {
    const kept = filterAvailableTools(['mcp:a', 'mcp:gone', 'skill:x', 'skill:none', 'bash'])
    expect(kept).toEqual(['mcp:a', 'skill:x', 'bash'])
  })

  it('MCPL-U-15: 配置里停用（已启用列表为空）才算不可用', () => {
    mocks.getEnabledToolNames.mockReturnValue([])
    expect(getAllToolNames()).not.toContain('mcp:a')
    expect(filterAvailableTools(['mcp:a', 'bash'])).toEqual(['bash'])
  })
})

describe('技能的两级开关同样落在这里', () => {
  it('SSG-16: 整组关掉后，会话里存着的 skill:<name> 被 filterAvailableTools 抹掉', () => {
    // 技能的可用性入口只有一个：`skillService.findEnabled()`，而它已经把两级开关（单个技能 +
    // 整个目录）算完了 —— 侧栏把一整个目录关掉，模型的工具表里就不该再有那一族。
    // 这里**只桩 findEnabled**、不写 `.config.json`：两级开关怎么算是 skillServiceGroups 的活
    // （SSG-3/5/6），这一条只钉「算完之后工具层跟着变」这半段接缝
    expect(filterAvailableTools(['skill:x', 'bash'])).toEqual(['skill:x', 'bash'])

    mocks.findEnabled.mockReturnValue([])
    expect(filterAvailableTools(['skill:x', 'bash'])).toEqual(['bash'])
    expect(getAllToolNames()).not.toContain('skill:x')
  })
})
