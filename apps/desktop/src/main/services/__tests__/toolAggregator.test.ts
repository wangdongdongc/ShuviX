/**
 * toolAggregator —— 「哪些工具名算可用」的唯一判据，也是会话勾选被滤掉的唯一地方。
 *
 * 惰性启动改掉的正是这里：MCP 的可用性从「连上了」变成「配置里启用了」（`getEnabledToolNames`）。
 * 按连接状态算的话，一台用户勾好的服务器会在创建 Agent 的**前一刻**被 `filterAvailableTools`
 * 抹掉 —— 而它恰恰要在下一步才被连起来，于是「勾了却没有工具」，且因为整份替换写回，勾选还会
 * 永久丢失。这条用例就钉这一点：启用但没连上的仍在，不存在的才剔除。
 *
 * 上游全是替身：真 toolRegistry 要靠工具模块自注册（会拖进整个 main 进程），
 * 真 mcpService 要 SQLite。skillService 也桩着 —— 只为钉住「技能不在可用集里、根本不去问它」：
 * 技能不按会话勾选（2026-10-28），启用着的全部上带 `skill` 工具的 agent 的货架。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getBuiltinToolEntries: vi.fn(),
  getPlatformBuiltinToolEntries: vi.fn(),
  getEnabledToolNames: vi.fn(),
  findEnabled: vi.fn()
}))

vi.mock('../toolRegistry', () => ({
  // 两份刻意不同（见 PLAT-1）：全量里有另一平台的 powershell，按平台过滤后的那份没有
  getBuiltinToolEntries: mocks.getBuiltinToolEntries,
  getPlatformBuiltinToolEntries: mocks.getPlatformBuiltinToolEntries
}))
vi.mock('../mcpService', () => ({ mcpService: { getEnabledToolNames: mocks.getEnabledToolNames } }))
vi.mock('../skillService', () => ({ skillService: { findEnabled: mocks.findEnabled } }))

import { filterAvailableTools, getAllToolNames } from '../toolAggregator'

beforeEach(() => {
  mocks.getBuiltinToolEntries.mockReturnValue([
    { name: 'bash' },
    { name: 'powershell' },
    { name: 'read' },
    { name: 'edit' }
  ])
  mocks.getPlatformBuiltinToolEntries.mockReturnValue([
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
    expect(names).toEqual(['bash', 'read', 'edit', 'mcp:a'])
    // 读的是「已启用」而不是「已连接」的那个入口
    expect(mocks.getEnabledToolNames).toHaveBeenCalled()
  })

  it('MCPL-U-15: filterAvailableTools 保留已启用但没连上的勾选，只剔除已不存在的，且保持入参序', () => {
    const kept = filterAvailableTools(['mcp:a', 'mcp:gone', 'bash'])
    expect(kept).toEqual(['mcp:a', 'bash'])
  })

  it('MCPL-U-15: 配置里停用（已启用列表为空）才算不可用', () => {
    mocks.getEnabledToolNames.mockReturnValue([])
    expect(getAllToolNames()).not.toContain('mcp:a')
    expect(filterAvailableTools(['mcp:a', 'bash'])).toEqual(['bash'])
  })
})

describe('技能不在可用集里', () => {
  it('SSG-16: 会话里存着的 skill:<name> 一律被 filterAvailableTools 抹掉 —— 不论那个技能此刻启用与否，也不去问 skillService', () => {
    // 技能不按会话勾选了（2026-10-28）：旧会话里存着的 `skill:` 条目不再是可用的工具名。
    // 侧栏的两级开关（单个技能 + 整个目录）照样有效，但它作用在货架上（SkillTool / findModelInvocable），
    // 不在这一层 —— 这里连 findEnabled 都不该调
    mocks.findEnabled.mockClear()
    expect(filterAvailableTools(['skill:x', 'bash'])).toEqual(['bash'])
    expect(getAllToolNames()).not.toContain('skill:x')
    mocks.findEnabled.mockReturnValue([])
    expect(filterAvailableTools(['skill:x', 'bash'])).toEqual(['bash'])
    expect(mocks.findEnabled).not.toHaveBeenCalled()
  })
})

describe('内置部分只算这台机器上存在的工具', () => {
  it('PLAT-1: getAllToolNames 的内置部分来自按平台过滤的视图 —— 另一平台的 powershell 不算可用', () => {
    // 调用记录跨用例累积（beforeEach 只重设返回值）—— 先清掉，下面的「调没调过」才只说这一条
    mocks.getPlatformBuiltinToolEntries.mockClear()
    mocks.getBuiltinToolEntries.mockClear()
    const names = getAllToolNames()
    expect(names.slice(0, 3)).toEqual(['bash', 'read', 'edit'])
    expect(names).not.toContain('powershell')
    expect(mocks.getPlatformBuiltinToolEntries).toHaveBeenCalled()
    expect(mocks.getBuiltinToolEntries).not.toHaveBeenCalled()
    // 勾选层面同理：会话里存着的 powershell 在这台机器上被当成不存在
    expect(filterAvailableTools(['powershell', 'bash'])).toEqual(['bash'])
  })
})

describe('取消档案声明项的记号不按可用性滤', () => {
  it('TA-OPT-1: 「-mcp:」原样留着（它说的是「不要」，那一台在不在都一样）；内置名的「-read」与旧的「-skill:」不是记号，照常剔除', () => {
    // 可用：mcp:a（外加内置 bash / read / edit）
    expect(
      filterAvailableTools(['-mcp:gone', 'mcp:a', '-mcp:a', 'skill:none', '-read', '-skill:x'])
    ).toEqual(['-mcp:gone', 'mcp:a', '-mcp:a'])
  })
})
