/**
 * DefaultChatGateway.listTools 的 `declaredBy` —— 会话根 Agent 的档案在 `shuvix-tools` 里声明的
 * mcp:/skill: 项对这条会话恒生效（createAgent 的名单归一：会话勾选只能在其上叠加），选择器与会话
 * 设置据此把它们画成「已勾、锁住」，悬停说是谁声明的。
 *
 * 钉的是这张表：
 *  - 档案由会话形态推导（`resolveAgentProfileName(sid)`），没有会话回落 work；
 *  - 标记的值是档案显示名，显示名为空时退回档案名；
 *  - 只标 mcp / skill 条目，内置工具条目照旧只带 `defaultEnabled`；
 *  - 只标**真的列出来**的条目：档案点了名但此刻不可用（服务器没配、技能被停用 / 不存在）不凭空
 *    造一条出来；按全名精确匹配（`skill:drawing` ≠ `skill:builtin:drawing`）。
 *
 * mock 骨架照抄 chatGatewayPrompt.test.ts（网关的 import 图带 SQLite / electron / 全部工具）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

interface McpInfo {
  name: string
  label: string
  group: string
  serverStatus?: string
  isBuiltin?: boolean
}
interface SkillShot {
  name: string
  description: string
}
interface ProfileShot {
  name: string
  displayName: string
  tools: string[]
}

const mocks = vi.hoisted(() => ({
  resolveAgentProfileName: vi.fn(),
  getProfile: vi.fn(),
  findEnabled: vi.fn(),
  findById: vi.fn(),
  projectPick: vi.fn(),
  mcpInfos: [] as McpInfo[]
}))

vi.mock('../../../tools/allTools', () => ({}))
vi.mock('../../../services/toolRegistry', () => ({
  getBuiltinToolEntries: () =>
    ['read', 'bash'].map((name) => ({
      name,
      group: 'general' as const,
      getLabel: () => name,
      getHint: () => `${name} hint`
    }))
}))
vi.mock('../../../services/sessionService', () => ({
  sessionService: {
    ensureAgentSession: vi.fn(),
    getAgentSession: vi.fn(),
    resolveAgentProfileName: mocks.resolveAgentProfileName
  }
}))
vi.mock('../../../services/messageService', () => ({ messageService: {} }))
vi.mock('../../../services/sessionStorage', () => ({
  appendModelChange: vi.fn(),
  appendThinkingLevelChange: vi.fn()
}))
vi.mock('../../../services/userInputBroker', () => ({ respondToUserInput: vi.fn() }))
vi.mock('../../../services/builtinMcp/dbConnections', () => ({
  dbManager: { getConnectionInfo: vi.fn() }
}))
vi.mock('../../../services/mcpService', () => ({
  mcpService: { getAllToolInfos: () => mocks.mcpInfos }
}))
vi.mock('../../../services/skillService', () => ({
  skillService: { findEnabled: mocks.findEnabled }
}))
vi.mock('../../../dao/sessionDao', () => ({
  sessionDao: { findById: mocks.findById, touchActive: vi.fn() }
}))
vi.mock('../../../dao/projectDao', () => ({ projectDao: { pick: mocks.projectPick } }))
vi.mock('../../../services/agentService', () => ({
  agentService: { getProfile: mocks.getProfile }
}))
vi.mock('../ChatFrontendRegistry', () => ({ chatFrontendRegistry: { broadcast: vi.fn() } }))
vi.mock('../../../services/sessionDayPromptService', () => ({
  recordUserPrompt: vi.fn(),
  recordFromUserMessageEvent: vi.fn()
}))

let chatGateway: (typeof import('../DefaultChatGateway'))['chatGateway']

beforeAll(async () => {
  ;({ chatGateway } = await import('../DefaultChatGateway'))
})

const SID = 's1'
const MCP_CTX: McpInfo = {
  name: 'mcp:ctx',
  label: 'ctx',
  group: 'mcp:ctx',
  serverStatus: 'connected'
}
const MCP_OTHER: McpInfo = { name: 'mcp:other', label: 'other', group: 'mcp:other' }
const BUILTIN_DRAWING: SkillShot = { name: 'builtin:drawing', description: 'draw inline figures' }
const USER_FOO: SkillShot = { name: 'foo', description: 'foo skill' }

const WORK: ProfileShot = {
  name: 'work',
  displayName: 'Work',
  tools: ['read', 'mcp:ctx', 'skill:builtin:drawing']
}

type Row = ReturnType<typeof chatGateway.listTools>[number]
const rowOf = (rows: Row[], name: string): Row | undefined => rows.find((r) => r.name === name)
/** 带了 declaredBy 的条目（名 → 值） */
const declaredOf = (rows: Row[]): Record<string, string> =>
  Object.fromEntries(
    rows.filter((r) => r.declaredBy !== undefined).map((r) => [r.name, r.declaredBy!])
  )

beforeEach(() => {
  mocks.resolveAgentProfileName.mockReset()
  mocks.resolveAgentProfileName.mockReturnValue('work')
  mocks.getProfile.mockReset()
  mocks.getProfile.mockImplementation((name: string) => (name === 'work' ? WORK : undefined))
  mocks.findEnabled.mockReset()
  mocks.findEnabled.mockReturnValue([BUILTIN_DRAWING, USER_FOO])
  mocks.findById.mockReset()
  mocks.findById.mockReturnValue({ id: SID, projectId: null })
  mocks.projectPick.mockReset()
  mocks.mcpInfos = [MCP_CTX, MCP_OTHER]
})

describe('DefaultChatGateway.listTools —— 档案声明的 mcp:/skill: 项', () => {
  it('LT-1 档案声明的 mcp:ctx 与 skill:builtin:drawing 标上档案显示名，其余 mcp / skill 条目不标', () => {
    const rows = chatGateway.listTools(SID)
    expect(mocks.resolveAgentProfileName).toHaveBeenCalledWith(SID)
    expect(rowOf(rows, 'mcp:ctx')?.declaredBy).toBe('Work')
    expect(rowOf(rows, 'skill:builtin:drawing')?.declaredBy).toBe('Work')
    // 条目确实列出来了（不是因为不在列表里才读到 undefined）
    expect(rowOf(rows, 'mcp:other')).toBeDefined()
    expect(rowOf(rows, 'skill:foo')).toBeDefined()
    expect(rowOf(rows, 'mcp:other')?.declaredBy).toBeUndefined()
    expect(rowOf(rows, 'skill:foo')?.declaredBy).toBeUndefined()
  })

  it('LT-2 内置工具条目（read）从不带 declaredBy —— 它们照旧只用 defaultEnabled 表达档案白名单', () => {
    const rows = chatGateway.listTools(SID)
    const read = rowOf(rows, 'read')
    expect(read).toBeDefined()
    expect(read?.defaultEnabled).toBe(true)
    expect(read?.declaredBy).toBeUndefined()
    expect('declaredBy' in read!).toBe(false)
    // 档案没点名的内置工具：不勾，也不标
    expect(rowOf(rows, 'bash')).toMatchObject({ defaultEnabled: false })
    expect(rowOf(rows, 'bash')?.declaredBy).toBeUndefined()
  })

  it('LT-3 没有会话（项目编辑页那种调用）→ 回落 work 档案，不去推导形态；声明项照样标', () => {
    const rows = chatGateway.listTools()
    expect(mocks.resolveAgentProfileName).not.toHaveBeenCalled()
    expect(mocks.getProfile).toHaveBeenCalledWith('work')
    expect(declaredOf(rows)).toEqual({ 'mcp:ctx': 'Work', 'skill:builtin:drawing': 'Work' })
  })

  it('LT-4 会话形态推导出 bot → 用 bot 档案的声明与显示名', () => {
    const BOT: ProfileShot = {
      name: 'bot',
      displayName: 'Bot Persona',
      tools: ['read', 'skill:builtin:drawing']
    }
    mocks.resolveAgentProfileName.mockReturnValue('bot')
    mocks.getProfile.mockImplementation((name: string) =>
      name === 'bot' ? BOT : name === 'work' ? WORK : undefined
    )
    const rows = chatGateway.listTools(SID)
    expect(mocks.getProfile).toHaveBeenCalledWith('bot')
    // 标的是 bot 自己声明的那一项：work 声明的 mcp:ctx 在 bot 会话里不锁
    expect(declaredOf(rows)).toEqual({ 'skill:builtin:drawing': 'Bot Persona' })
  })

  it('LT-5 档案显示名为空串 → 退回档案名（悬停提示总得说出是谁声明的）', () => {
    mocks.getProfile.mockImplementation((name: string) =>
      name === 'work' ? { ...WORK, displayName: '' } : undefined
    )
    const rows = chatGateway.listTools(SID)
    expect(declaredOf(rows)).toEqual({ 'mcp:ctx': 'work', 'skill:builtin:drawing': 'work' })
  })

  it('LT-6 档案解析不出来（getProfile 回 undefined）→ 不抛、一个条目都不标', () => {
    mocks.getProfile.mockReturnValue(undefined)
    let rows: Row[] = []
    expect(() => {
      rows = chatGateway.listTools(SID)
    }).not.toThrow()
    expect(rows.length).toBeGreaterThan(0)
    expect(declaredOf(rows)).toEqual({})
  })

  it('LT-7 档案点了名但此刻不可用的 mcp:gone / skill:missing → 不凭空造条目，列表长度不变', () => {
    const baseline = chatGateway.listTools(SID).length
    mocks.getProfile.mockImplementation((name: string) =>
      name === 'work' ? { ...WORK, tools: [...WORK.tools, 'mcp:gone', 'skill:missing'] } : undefined
    )
    const rows = chatGateway.listTools(SID)
    expect(rows).toHaveLength(baseline)
    expect(rowOf(rows, 'mcp:gone')).toBeUndefined()
    expect(rowOf(rows, 'skill:missing')).toBeUndefined()
    expect(declaredOf(rows)).toEqual({ 'mcp:ctx': 'Work', 'skill:builtin:drawing': 'Work' })
  })

  it('LT-8 声明的技能被全局停用（findEnabled 不再返回它）→ 列表里没有这一条，更谈不上锁', () => {
    mocks.findEnabled.mockReturnValue([USER_FOO])
    const rows = chatGateway.listTools(SID)
    expect(rowOf(rows, 'skill:builtin:drawing')).toBeUndefined()
    expect(declaredOf(rows)).toEqual({ 'mcp:ctx': 'Work' })
  })

  it('LT-9 按全名精确匹配：档案点的是 skill:drawing，就不锁 skill:builtin:drawing', () => {
    mocks.getProfile.mockImplementation((name: string) =>
      name === 'work' ? { ...WORK, tools: ['read', 'skill:drawing'] } : undefined
    )
    const rows = chatGateway.listTools(SID)
    expect(rowOf(rows, 'skill:builtin:drawing')).toBeDefined()
    expect(rowOf(rows, 'skill:builtin:drawing')?.declaredBy).toBeUndefined()
    expect(declaredOf(rows)).toEqual({})
  })
})

/**
 * 内置 `chrome`（用户真实的 Chrome）不是会话可勾选的扩展能力：只出现在声明它的档案那里 ——
 * Chrome 标签页会话的基座 `tab` —— 而且是锁住的已勾形态。桌面自己的会话（以及没有会话的
 * 项目编辑页）的选择器里根本见不到它。
 */
describe('DefaultChatGateway.listTools —— 内置 mcp:chrome 只给声明它的档案', () => {
  const MCP_BROWSER: McpInfo = {
    name: 'mcp:browser',
    label: 'browser',
    group: 'mcp:browser',
    isBuiltin: true
  }
  const MCP_CHROME: McpInfo = {
    name: 'mcp:chrome',
    label: 'chrome',
    group: 'mcp:chrome',
    isBuiltin: true
  }
  const TAB: ProfileShot = {
    name: 'tab',
    displayName: 'Chrome Tab',
    tools: ['mcp:chrome', 'ask', 'skill:builtin:drawing']
  }

  beforeEach(() => {
    mocks.mcpInfos = [MCP_BROWSER, MCP_CHROME, MCP_CTX]
    mocks.getProfile.mockImplementation((name: string) =>
      name === 'work' ? WORK : name === 'tab' ? TAB : undefined
    )
  })

  it('LT-C1 work 档案的会话：没有 mcp:chrome 这一行；browser 与别的 MCP 照列', () => {
    const rows = chatGateway.listTools(SID)
    expect(rowOf(rows, 'mcp:chrome')).toBeUndefined()
    expect(rowOf(rows, 'mcp:browser')).toBeDefined()
    expect(rowOf(rows, 'mcp:ctx')?.declaredBy).toBe('Work')
  })

  it("LT-C2 tab 档案的会话：mcp:chrome 在，锁成 'Chrome Tab' 声明的；mcp:browser 不锁", () => {
    mocks.resolveAgentProfileName.mockReturnValue('tab')
    const rows = chatGateway.listTools(SID)
    expect(rowOf(rows, 'mcp:chrome')).toMatchObject({
      name: 'mcp:chrome',
      label: 'chrome',
      isBuiltin: true,
      declaredBy: 'Chrome Tab'
    })
    expect(rowOf(rows, 'mcp:browser')).toBeDefined()
    expect(rowOf(rows, 'mcp:browser')?.declaredBy).toBeUndefined()
    expect(declaredOf(rows)).toEqual({
      'mcp:chrome': 'Chrome Tab',
      'skill:builtin:drawing': 'Chrome Tab'
    })
  })

  it('LT-C3 没有会话（项目编辑页）→ 回落 work，没有 mcp:chrome', () => {
    const rows = chatGateway.listTools()
    expect(rowOf(rows, 'mcp:chrome')).toBeUndefined()
    expect(mocks.resolveAgentProfileName).not.toHaveBeenCalled()
  })

  it('LT-C4 tab 档案声明了但内置 chrome 行不在（被删 / 停用）→ 不凭空造一条', () => {
    mocks.resolveAgentProfileName.mockReturnValue('tab')
    mocks.mcpInfos = [MCP_BROWSER, MCP_CTX]
    const rows = chatGateway.listTools(SID)
    expect(rowOf(rows, 'mcp:chrome')).toBeUndefined()
    expect(declaredOf(rows)).toEqual({ 'skill:builtin:drawing': 'Chrome Tab' })
  })

  it('LT-C5 别的档案（bot / 子会话钉的 coding）同样见不到 mcp:chrome', () => {
    mocks.getProfile.mockImplementation((name: string) =>
      name === 'coding'
        ? { name: 'coding', displayName: 'Coding', tools: ['read', 'bash'] }
        : undefined
    )
    mocks.resolveAgentProfileName.mockReturnValue('coding')
    expect(rowOf(chatGateway.listTools(SID), 'mcp:chrome')).toBeUndefined()
  })
})
