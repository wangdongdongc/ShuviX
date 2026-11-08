/**
 * `shuvix` 工具 —— agent 经设置 API 改 ShuviX 自己的设置（docs/mcp-config-compat-design.md）。第一批开放的是 MCP 服务器。
 *
 *   SX-1  describe：按 scope 列、读 / 改分开说；给 channel / scope 带出参数结构；不认识的名字回一览
 *   SX-2  call：不认识的通道、参数不合结构 → 失败，什么都不问、不调
 *   SX-3  mcp:list 是读：不问；env / headers 只说有没有值，地址的 query 打码；内置的只列名字；秘密不出现在结果里
 *   SX-4  mcp:add：门拿到 channel / group / scope / access（admin）与逐行预览；留空的 env 成了要填的项；卡上填的值进了处理函数；
 *         回执连一次、回工具名；结果与卡上都没有秘密
 *   SX-5  没出卡就放行了却缺值 → 单独一张只填值的卡；用户不填 / 拒绝 → 失败、不调
 *   SX-6  门拒绝 → 失败、不调；名字不存在等说不通的在问之前就失败
 *   SX-7  mcp:update：按名字找 id；env 按键合并（null 删、没提的留着）；内置服务器改结构 → 问之前失败
 *   SX-8  处理函数回 {success:false} → 失败，原因给模型；连不上 → connected:false + 原因（http 多一句 OAuth）
 *   SX-9  mcp:delete：卡上是名字和命令；按 id 删
 *
 * 门（assertChannelAccess）、处理函数（invokeAsAgent）、mcpDao / mcpService、用户输入都替身；注解（services/agentApi）、
 * cardValues、i18next（三份语言文件）用真的。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import type { AskInputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { invokeTool, resultText } from '@shuvix/agent-runtime/tools/testing/invokeTool'

const state = vi.hoisted(() => ({
  registered: [] as Array<Record<string, unknown>>,
  servers: [] as McpServer[],
  assertChannelAccess: vi.fn(),
  invokeAsAgent: vi.fn(),
  requestUserInputFor: vi.fn(),
  connect: vi.fn(),
  getError: vi.fn(),
  getServerToolInfos: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shuvix-shuvix-tool-test', isPackaged: false },
  BrowserWindow: class {},
  session: {}
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../i18n', async () => {
  const { default: real } = await import('i18next')
  return { t: (key: string, vars?: Record<string, unknown>) => real.t(key, vars ?? {}) }
})
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: (meta: Record<string, unknown>) => {
    state.registered.push(meta)
  }
}))
vi.mock('../../services/toolContext', () => ({
  assertChannelAccess: state.assertChannelAccess
}))
vi.mock('../../ipc/registry', () => ({
  invokeAsAgent: state.invokeAsAgent
}))
vi.mock('../../services/userInputBroker', () => ({
  requestUserInputFor: state.requestUserInputFor
}))
vi.mock('../../dao/mcpDao', () => ({
  mcpDao: {
    findByName: (name: string) => state.servers.find((s) => s.name === name),
    findById: (id: string) => state.servers.find((s) => s.id === id)
  }
}))
vi.mock('../../services/mcpService', () => ({
  mcpService: {
    connect: state.connect,
    getError: state.getError,
    getServerToolInfos: state.getServerToolInfos
  }
}))

import { ShuvixTool, ShuvixParamsSchema, SHUVIX_TOOL_DESCRIPTION } from '../shuvix'
import { resetCardValuesForTests, stashCardValues } from '../../services/cardValues'
import type { ToolContext } from '../../services/toolContext'

const SID = 's1'
const CTX = { sessionId: SID } as unknown as ToolContext
const SECRET = 'ghp_SECRET_VALUE_123'

function server(name: string, patch: Partial<McpServer> = {}): McpServer {
  return {
    id: `id-${name}`,
    name,
    type: 'stdio',
    command: 'npx',
    args: '["-y","pkg"]',
    env: JSON.stringify({ TOKEN: SECRET, EMPTY: '' }),
    url: '',
    headers: '{}',
    metadata: '{}',
    isEnabled: 1,
    isBuiltin: 0,
    cachedTools: '[]',
    createdAt: 0,
    updatedAt: 0,
    ...patch
  }
}

async function run(
  params: Record<string, unknown>,
  callId = 'call-1'
): Promise<{ text: string; isError: boolean }> {
  const { result } = await invokeTool(new ShuvixTool(CTX), params as never, { callId })
  return { text: resultText(result), isError: result.isError === true }
}

/** 门放行时顺手把卡上填的值交给宿主（真流程里是 AgentSession.respondToInput 收下的） */
function allowWith(values?: Record<string, string>): void {
  state.assertChannelAccess.mockImplementation(
    async (_ctx, _object, opts: { toolCallId: string }) => {
      if (values) stashCardValues(SID, opts.toolCallId, values)
    }
  )
}

beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    resources: { en: { translation: en }, zh: { translation: zh }, ja: { translation: ja } }
  })
})

beforeEach(() => {
  vi.clearAllMocks()
  resetCardValuesForTests()
  state.servers = []
  allowWith()
  state.connect.mockResolvedValue({ ok: true })
  state.getServerToolInfos.mockReturnValue([
    { name: 'mcp__github__list_issues', description: 'x' },
    { name: 'mcp__github__create_issue', description: 'y' }
  ])
  state.invokeAsAgent.mockImplementation(async (channel: string, _sid: string, args: unknown[]) => {
    if (channel === 'mcp:add') {
      const params = args[0] as { name: string; type: 'stdio' | 'http'; url?: string }
      state.servers.push(
        server(params.name, { id: 'new-id', type: params.type, url: params.url ?? '' })
      )
      return { success: true, id: 'new-id' }
    }
    return { success: true }
  })
})

describe('SX-1 describe', () => {
  it('注册的形状；一览按 scope 分组，读 / 改分开说，不带参数结构', async () => {
    expect(state.registered.map((meta) => meta.name)).toEqual(['shuvix'])
    expect(ShuvixParamsSchema).toBeTruthy()
    expect(SHUVIX_TOOL_DESCRIPTION).toContain('describe')
    const { text, isError } = await run({ action: 'describe' })
    expect(isError).toBe(false)
    expect(text).toContain('## extensions')
    expect(text).toMatch(/- mcp:list \(read\)/)
    expect(text).toMatch(/- mcp:add \(change, asks the user\)/)
    expect(text).not.toContain('args:')
    expect(state.assertChannelAccess).not.toHaveBeenCalled()
  })

  it('给 channel / scope 带出参数结构；不认识的名字回一览', async () => {
    const one = await run({ action: 'describe', channel: 'mcp:add' })
    expect(one.text).toContain('args: ')
    expect(one.text).toContain('"command"')
    const scope = await run({ action: 'describe', scope: 'extensions' })
    expect(scope.text.match(/args: /g)).toHaveLength(5)
    // 通道名的前缀也认：模型常先猜 `mcp`
    const group = await run({ action: 'describe', scope: 'mcp' })
    expect(group.text).toBe(scope.text)
    const unknown = await run({ action: 'describe', channel: 'settings:set' })
    expect(unknown.text).toContain('is not a channel you can use')
    expect(unknown.text).toContain('## extensions')
  })
})

describe('SX-2 call 前的检查', () => {
  it('不认识的通道 / 参数不合结构 → 失败，什么都不问、不调', async () => {
    const unknown = await run({ action: 'call', channel: 'settings:set', args: {} })
    expect(unknown.isError).toBe(true)
    expect(unknown.text).toContain('Call describe')
    const bad = await run({ action: 'call', channel: 'mcp:add', args: { name: 'x', type: 'ftp' } })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('do not fit')
    expect(state.assertChannelAccess).not.toHaveBeenCalled()
    expect(state.invokeAsAgent).not.toHaveBeenCalled()
  })
})

describe('SX-3 mcp:list', () => {
  it('不问；只说有没有值；query 打码；内置只列名字；秘密不出现', async () => {
    state.invokeAsAgent.mockResolvedValue([
      { ...server('github'), status: 'connected', toolCount: 2 },
      {
        ...server('remote', {
          type: 'http',
          url: `https://mcp.example.com/sse?key=${SECRET}`,
          headers: JSON.stringify({ Authorization: `Bearer ${SECRET}` }),
          env: '{}'
        }),
        status: 'error',
        error: 'boom',
        toolCount: 0
      },
      { ...server('browser', { type: 'inproc', isBuiltin: 1 }), status: 'disconnected' }
    ])
    const { text, isError } = await run({ action: 'call', channel: 'mcp:list', args: {} })
    expect(isError).toBe(false)
    expect(state.assertChannelAccess).not.toHaveBeenCalled()
    expect(state.invokeAsAgent).toHaveBeenCalledWith('mcp:list', SID, [])
    expect(text).not.toContain(SECRET)
    const list = JSON.parse(text) as Array<Record<string, unknown>>
    expect(list[0]).toMatchObject({
      name: 'github',
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'set', EMPTY: 'empty' },
      tools: 2
    })
    expect(list[1]).toMatchObject({
      url: 'https://mcp.example.com/sse?key=***',
      headers: { Authorization: 'set' },
      error: 'boom'
    })
    expect(list[2]).toStrictEqual({
      name: 'browser',
      builtin: true,
      enabled: true,
      note: 'Built in; not changed here.'
    })
  })
})

describe('SX-4 mcp:add', () => {
  const addArgs = {
    name: 'github',
    type: 'http',
    url: 'https://api.example.com/mcp/',
    headers: { Authorization: 'Bearer {{GITHUB_TOKEN}}' },
    env: { GITHUB_TOKEN: '' }
  }

  it('门拿到事实与逐行预览；留空的 env 成了要填的项；填的值进处理函数；回执回工具名；没有秘密', async () => {
    allowWith({ 'env.GITHUB_TOKEN': ` ${SECRET}\n` })
    const { text, isError } = await run(
      { action: 'call', channel: 'mcp:add', args: addArgs },
      'call-add'
    )
    expect(isError).toBe(false)
    expect(state.assertChannelAccess).toHaveBeenCalledTimes(1)
    const [, object, opts] = state.assertChannelAccess.mock.calls[0]
    expect(object).toStrictEqual({
      channel: 'mcp:add',
      group: 'mcp',
      scope: 'extensions',
      access: 'admin'
    })
    expect(opts.toolCallId).toBe('call-add')
    expect(opts.fields).toStrictEqual([
      { key: 'env.GITHUB_TOKEN', label: 'GITHUB_TOKEN', secret: true, required: true }
    ])
    expect(opts.preview).toStrictEqual({
      kind: 'settings',
      channel: 'mcp:add',
      title: 'Add MCP server “github” to your settings',
      rows: [
        { label: 'Name', value: 'github' },
        { label: 'Address', value: 'https://api.example.com/mcp/' },
        { label: 'Environment', value: 'GITHUB_TOKEN (you fill in)' },
        { label: 'Headers', value: 'Authorization (set)' }
      ]
    })
    expect(state.invokeAsAgent).toHaveBeenCalledWith('mcp:add', SID, [
      {
        name: 'github',
        type: 'http',
        url: 'https://api.example.com/mcp/',
        headers: { Authorization: 'Bearer {{GITHUB_TOKEN}}' },
        env: { GITHUB_TOKEN: SECRET }
      }
    ])
    expect(state.connect).toHaveBeenCalledWith('new-id', { timeoutMs: 30_000 })
    expect(JSON.parse(text)).toMatchObject({
      added: 'github',
      connected: true,
      tools: ['list_issues', 'create_issue']
    })
    expect(text).not.toContain(SECRET)
    expect(JSON.stringify(opts)).not.toContain(SECRET)
  })

  it('stdio：命令行与工作目录上卡；值已给全 → 没有要填的项', async () => {
    await run({
      action: 'call',
      channel: 'mcp:add',
      args: {
        name: 'fs',
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        cwd: '/Users/me/project',
        env: { DEBUG: '1' }
      }
    })
    const [, , opts] = state.assertChannelAccess.mock.calls[0]
    expect(opts.fields).toStrictEqual([])
    expect(opts.preview.rows).toStrictEqual([
      { label: 'Name', value: 'fs' },
      { label: 'Command', value: 'npx -y @modelcontextprotocol/server-filesystem /tmp' },
      { label: 'Working folder', value: '/Users/me/project' },
      { label: 'Environment', value: 'DEBUG (set)' }
    ])
    expect(state.invokeAsAgent.mock.calls[0][2][0]).toMatchObject({ cwd: '/Users/me/project' })
  })

  it('卡片语言跟界面语言', async () => {
    await i18next.changeLanguage('zh')
    try {
      await run({ action: 'call', channel: 'mcp:add', args: { ...addArgs, env: { X: 'y' } } })
      expect(state.assertChannelAccess.mock.calls[0][2].preview.title).toBe(
        '在设置里添加 MCP 服务器「github」'
      )
    } finally {
      await i18next.changeLanguage('en')
    }
  })
})

describe('SX-5 没出卡却缺值', () => {
  const args = { name: 'x', type: 'stdio', command: 'run', env: { KEY: '' } }

  it('单独一张只填值的卡；填了就用', async () => {
    state.requestUserInputFor.mockImplementation(async (sid: string, request: AskInputRequest) => {
      stashCardValues(sid, request.id, { 'env.KEY': 'v' })
      return { kind: 'ask', allowed: true } satisfies InputResponse
    })
    const { isError } = await run({ action: 'call', channel: 'mcp:add', args }, 'call-fill')
    expect(isError).toBe(false)
    const [sid, request] = state.requestUserInputFor.mock.calls[0]
    expect(sid).toBe(SID)
    expect(request).toMatchObject({
      id: 'call-fill',
      kind: 'ask',
      toolName: 'shuvix',
      fields: [{ key: 'env.KEY', label: 'KEY', secret: true, required: true }],
      preview: { kind: 'settings', channel: 'mcp:add' }
    })
    expect(state.invokeAsAgent.mock.calls[0][2][0]).toMatchObject({ env: { KEY: 'v' } })
  })

  it('拒绝 / 写了别的 / 批准却没填 → 失败、不调', async () => {
    for (const response of [
      { kind: 'ask', allowed: false },
      { kind: 'other', text: 'later' },
      { kind: 'ask', allowed: true }
    ] as InputResponse[]) {
      state.requestUserInputFor.mockResolvedValueOnce(response)
      const { isError, text } = await run({ action: 'call', channel: 'mcp:add', args })
      expect(isError, JSON.stringify(response)).toBe(true)
      expect(text).toContain('Nothing was changed')
    }
    expect(state.invokeAsAgent).not.toHaveBeenCalled()
  })
})

describe('SX-6 门与预检', () => {
  it('门拒绝 → 失败、不调', async () => {
    state.assertChannelAccess.mockRejectedValue(
      new Error('User denied this change (channel mcp:add)')
    )
    const { isError, text } = await run({
      action: 'call',
      channel: 'mcp:add',
      args: { name: 'x', type: 'stdio', command: 'run' }
    })
    expect(isError).toBe(true)
    expect(text).toContain('User denied')
    expect(state.invokeAsAgent).not.toHaveBeenCalled()
  })

  it('名字不存在 / 缺 command → 问之前就失败', async () => {
    const missing = await run({ action: 'call', channel: 'mcp:update', args: { name: 'nope' } })
    expect(missing.text).toContain('No MCP server named "nope"')
    const noCommand = await run({
      action: 'call',
      channel: 'mcp:add',
      args: { name: 'x', type: 'stdio' }
    })
    expect(noCommand.text).toContain('needs "command"')
    expect(state.assertChannelAccess).not.toHaveBeenCalled()
  })
})

describe('SX-7 mcp:update', () => {
  it('按名字找 id；env 按键合并；卡上是新旧对比', async () => {
    state.servers = [server('github')]
    const { isError } = await run({
      action: 'call',
      channel: 'mcp:update',
      args: { name: 'github', args: ['-y', 'pkg@2'], env: { EMPTY: null, NEW: 'n' } }
    })
    expect(isError).toBe(false)
    expect(state.invokeAsAgent).toHaveBeenCalledWith('mcp:update', SID, [
      { id: 'id-github', args: ['-y', 'pkg@2'], env: { TOKEN: SECRET, NEW: 'n' } }
    ])
    const rows = state.assertChannelAccess.mock.calls[0][2].preview.rows
    expect(rows).toContainEqual({ label: 'Command', value: 'npx -y pkg → npx -y pkg@2' })
    expect(rows).toContainEqual({ label: 'Environment', value: 'EMPTY (removed), NEW (set)' })
    expect(JSON.stringify(rows)).not.toContain(SECRET)
  })

  it('内置服务器改结构 → 问之前失败；只改 env 可以', async () => {
    state.servers = [server('tavily', { isBuiltin: 1, type: 'http', url: 'https://x' })]
    const structural = await run({
      action: 'call',
      channel: 'mcp:update',
      args: { name: 'tavily', url: 'https://evil' }
    })
    expect(structural.isError).toBe(true)
    expect(structural.text).toContain('is built in')
    expect(state.assertChannelAccess).not.toHaveBeenCalled()
    const envOnly = await run({
      action: 'call',
      channel: 'mcp:update',
      args: { name: 'tavily', env: { TAVILY_API_KEY: 'k' } }
    })
    expect(envOnly.isError).toBe(false)
  })
})

describe('SX-8 失败', () => {
  it('处理函数回 success:false → 失败，原因给模型', async () => {
    state.invokeAsAgent.mockResolvedValue({
      success: false,
      error: 'An MCP server named "x" already exists'
    })
    const { isError, text } = await run({
      action: 'call',
      channel: 'mcp:add',
      args: { name: 'x', type: 'stdio', command: 'run' }
    })
    expect(isError).toBe(true)
    expect(text).toContain('already exists')
  })

  it('连不上 → connected:false + 原因；http 多一句 OAuth', async () => {
    state.connect.mockResolvedValue({ ok: false, error: 'HTTP 401' })
    const { isError, text } = await run({
      action: 'call',
      channel: 'mcp:add',
      args: { name: 'notion', type: 'http', url: 'https://mcp.notion.com/mcp' }
    })
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toMatchObject({ added: 'notion', connected: false, error: 'HTTP 401' })
    expect(text).toContain('OAuth')
  })
})

describe('SX-9 mcp:delete', () => {
  it('卡上是名字和命令；按 id 删', async () => {
    state.servers = [server('github')]
    const { isError, text } = await run({
      action: 'call',
      channel: 'mcp:delete',
      args: { name: 'github' }
    })
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toStrictEqual({ removed: 'github' })
    expect(state.invokeAsAgent).toHaveBeenCalledWith('mcp:delete', SID, ['id-github'])
    expect(state.assertChannelAccess.mock.calls[0][2].preview.rows).toStrictEqual([
      { label: 'Name', value: 'github' },
      { label: 'Command', value: 'npx -y pkg' }
    ])
  })
})
