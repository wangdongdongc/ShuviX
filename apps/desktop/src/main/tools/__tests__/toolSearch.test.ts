/**
 * tool_search 工具 —— 模型查找这条会话没开启的 MCP 服务器，经用户确认后整台开启。
 *
 *   TS-U1  replay 'unsafe'；注册的形状；空 / 空白 / 不是字符串的 query → `query must not be empty`
 *   TS-U2  没命中 → 正好 `No matching tools found.`；不问、不连、不写
 *   TS-U3  多个都没开 → 列表；不问、不连；第三方的描述不出现
 *   TS-U4  多个命中、其中一个开着 / 被取消 → 仍是列表，带说明；不问、不连（只回卡片的只有单个命中）
 *   TS-U5  允许：预判 → 门 → 连接 `{sessionId, timeoutMs: 30000}` → 写，按这个顺序；回答的文字（单复数、只留描述首行、200 字）
 *   TS-U6  门拿到 `{server, builtin}`、signal、归属与带查询的说明；预判拿到勾选 + 这一项；`cacheLoss` 只在 `lost` 时给
 *   TS-U7  拒绝 / 取消 / 反馈 → 失败结果；不连、不写
 *   TS-U8  连接 `{ok:false, error}` → 明确的失败、不写、下一次再问；`{ok:false}` → unknown error；写了没接上 → 说清楚
 *   TS-U9  预判 / 连接 / 写永不落定：中止之后调用照样收场；连接在中止之后才答 → 不写
 *   TS-U10 连接答完、竞争已经结束之后才中止（写之前那一眼）→ 不写
 *   TS-U11 单个命中已经开着 → 回它的工具（中断之后再调一次，不再问）；被取消 → `turned x off`；勾着没连上 → `not connected: err` + retry
 *   TS-U12 恶意的服务器名与描述：列表和取消的回答里没有描述、没有夹带的换行
 *
 * 门（assertExtensionAccess）与 mcpService / sessionService 全部替身（门本身的客体、文案在 agent-runtime context.test.ts）；
 * extensionDiscovery 与 i18next 用真的（三份语言文件）。调用经 invokeTool（假 durable api）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import type { McpServer } from '@shuvix/chat-protocol/types/mcp'
import {
  invokeTool,
  resultText,
  type ToolInvocation
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const state = vi.hoisted(() => ({
  registered: [] as Array<Record<string, unknown>>,
  order: [] as string[],
  configuredServers: vi.fn(),
  ensureServerByName: vi.fn(),
  getError: vi.fn(),
  rootToolState: vi.fn(),
  previewAgentChange: vi.fn(),
  enableServer: vi.fn(),
  lockedServerTools: vi.fn(),
  assertExtensionAccess: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shuvix-tool-search-test', isPackaged: false },
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
vi.mock('../../services/mcpService', () => ({
  mcpService: {
    configuredServers: state.configuredServers,
    ensureServerByName: state.ensureServerByName,
    getError: state.getError
  }
}))
vi.mock('../../services/sessionService', () => ({
  sessionService: {
    rootToolState: state.rootToolState,
    previewAgentChange: state.previewAgentChange,
    enableServer: state.enableServer,
    lockedServerTools: state.lockedServerTools
  }
}))
vi.mock('../../services/toolContext', () => ({
  assertExtensionAccess: state.assertExtensionAccess
}))

import { TOOL_SEARCH_DESCRIPTION, ToolSearchParamsSchema, ToolSearchTool } from '../toolSearch'
import type { ToolContext } from '../../services/toolContext'

// ─── 夹具 ────────────────────────────────────────────────────────────────

const SID = 's1'
const CTX = { sessionId: SID } as unknown as ToolContext
const NO_MATCH = 'No matching tools found.'
/** 第三方服务器描述里的记号：它只参与匹配，不该到模型面前 */
const MARKER = 'SECRET_DESCRIPTION_MARKER'

function server(name: string, patch: Partial<McpServer> = {}): McpServer {
  return {
    id: `id-${name}`,
    name,
    type: 'stdio',
    command: 'npx',
    args: '["-y","pkg"]',
    env: '{"TOKEN":"SECRET"}',
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

const builtin = (name: string): McpServer => server(name, { type: 'inproc', isBuiltin: 1 })

/** 第三方：一个工具 take，描述里有 `quantum` 和记号 */
const thirdParty = (name: string): McpServer =>
  server(name, {
    cachedTools: JSON.stringify([{ name: 'take', description: `quantum ${MARKER}` }])
  })

const decl = (name: string, description?: string): Record<string, unknown> => ({
  name,
  ...(description === undefined ? {} : { description }),
  parameters: { type: 'object' }
})

const toolState = (
  patch: { names?: string[]; selection?: string[]; optedOut?: string[] } = {}
): { names: string[]; selection: string[]; optedOut: Set<string> } => ({
  names: patch.names ?? [],
  selection: patch.selection ?? [],
  optedOut: new Set(patch.optedOut ?? [])
})

function search(
  query: unknown,
  options: { signal?: AbortSignal; callId?: string; ctx?: ToolContext } = {}
): Promise<ToolInvocation> {
  return invokeTool(new ToolSearchTool(options.ctx ?? CTX), { query: query as string }, options)
}

async function textOf(query: unknown): Promise<string> {
  return resultText((await search(query)).result)
}

/** 一个永不落定 / 手动落定的 promise */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const ticks = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

function expectNothingHappened(): void {
  expect(state.previewAgentChange).not.toHaveBeenCalled()
  expect(state.assertExtensionAccess).not.toHaveBeenCalled()
  expect(state.ensureServerByName).not.toHaveBeenCalled()
  expect(state.enableServer).not.toHaveBeenCalled()
}

const noted = (name: string, result: unknown) => {
  return () => {
    state.order.push(name)
    return result
  }
}

beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      ja: { translation: ja }
    }
  })
})

beforeEach(() => {
  state.order.length = 0
  for (const mock of [
    state.configuredServers,
    state.ensureServerByName,
    state.getError,
    state.rootToolState,
    state.previewAgentChange,
    state.enableServer,
    state.lockedServerTools,
    state.assertExtensionAccess
  ]) {
    mock.mockReset()
  }
  state.configuredServers.mockReturnValue([builtin('browser'), builtin('ssh')])
  state.rootToolState.mockImplementation(() => toolState())
  state.previewAgentChange.mockImplementation(
    noted('preview', Promise.resolve({ locked: true, cache: 'kept', reasons: [], promptTokens: 0 }))
  )
  state.assertExtensionAccess.mockImplementation(noted('gate', Promise.resolve()))
  state.ensureServerByName.mockImplementation(noted('connect', Promise.resolve({ ok: true })))
  state.enableServer.mockImplementation(
    noted('enable', Promise.resolve([decl('list_tabs', 'List tabs.'), decl('snapshot')]))
  )
  state.lockedServerTools.mockReturnValue(undefined)
  state.getError.mockReturnValue(undefined)
})

// ─── TS-U1 ───────────────────────────────────────────────────────────────

describe('TS-U1 工具的形状与参数', () => {
  it('TS-U1 replay 是 unsafe；名字、描述、schema、标签', () => {
    const tool = new ToolSearchTool(CTX)
    expect(tool.replay).toBe('unsafe')
    expect(tool.name).toBe('tool_search')
    expect(tool.description).toBe(TOOL_SEARCH_DESCRIPTION)
    expect(tool.parameters).toBe(ToolSearchParamsSchema)
    expect(tool.label).toBe(en.tool.toolSearchLabel)
  })

  it('TS-U1 注册：名字、分组、标签 / 说明走语言文件、工厂造工具、describe 给固定的描述', () => {
    const meta = state.registered.find((entry) => entry.name === 'tool_search') as {
      group: string
      getLabel: () => string
      getHint: () => string
      factory: (ctx: ToolContext) => unknown
      presentation: { icon: string }
      describe: () => { description: string; parameters: unknown }
    }
    expect(meta).toBeDefined()
    expect(meta.group).toBe('general')
    expect(meta.getLabel()).toBe(en.tool.toolSearchLabel)
    expect(meta.getHint()).toBe(en.tool.toolSearchHint)
    expect(meta.factory(CTX)).toBeInstanceOf(ToolSearchTool)
    expect(meta.presentation.icon).toBe('Puzzle')
    expect(meta.describe()).toEqual({
      description: TOOL_SEARCH_DESCRIPTION,
      parameters: ToolSearchParamsSchema
    })
  })

  it('TS-U1 schema 只有一个必填的字符串 query', () => {
    expect(ToolSearchParamsSchema.required).toEqual(['query'])
    expect(Object.keys(ToolSearchParamsSchema.properties)).toEqual(['query'])
    expect(ToolSearchParamsSchema.properties.query.type).toBe('string')
  })

  it.each([
    ['空串', ''],
    ['空白', ' \n\t '],
    ['数字', 42],
    ['null', null],
    ['undefined', undefined],
    ['对象', { query: 'browser' }]
  ])('TS-U1 query 是%s → query must not be empty，什么都不碰', async (_label, query) => {
    const { result } = await search(query)
    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe('query must not be empty')
    expect(state.configuredServers).not.toHaveBeenCalled()
    expectNothingHappened()
  })
})

// ─── TS-U2..4 ────────────────────────────────────────────────────────────

describe('TS-U2 没命中', () => {
  it('TS-U2 正好是 No matching tools found.；不问、不连、不写', async () => {
    const { result } = await search('nothing-like-this')
    expect(result.isError).toBeFalsy()
    expect(resultText(result)).toBe(NO_MATCH)
    expectNothingHappened()
  })

  it('TS-U2 候选排除 chrome / plan：叫它们的名字也是没命中', async () => {
    state.configuredServers.mockReturnValue([builtin('chrome'), builtin('plan')])
    expect(await textOf('chrome')).toBe(NO_MATCH)
    expect(await textOf('plan')).toBe(NO_MATCH)
    expectNothingHappened()
  })
})

describe('TS-U3 多个命中', () => {
  it('TS-U3 都没开 → 列表；不问、不连；描述不出现', async () => {
    state.configuredServers.mockReturnValue([thirdParty('alpha'), thirdParty('beta')])

    const { result } = await search('quantum')

    expect(result.isError).toBeFalsy()
    expect(resultText(result)).toBe(
      'Several extensions match. Call tool_search again with the exact name of the one you need:\n' +
        '- alpha (tools: take)\n' +
        '- beta (tools: take)'
    )
    expect(resultText(result)).not.toContain(MARKER)
    expect(resultText(result)).not.toContain('quantum')
    expectNothingHappened()
  })
})

describe('TS-U4 多个命中、其中有开着的', () => {
  it('TS-U4 一个开着一个没开 → 仍是列表，带说明；不问、不连', async () => {
    state.configuredServers.mockReturnValue([thirdParty('alpha'), thirdParty('beta')])
    state.rootToolState.mockReturnValue(toolState({ names: ['mcp:alpha'] }))

    const text = await textOf('quantum')

    expect(text.split('\n').slice(1)).toEqual([
      '- alpha (tools: take) (already on)',
      '- beta (tools: take)'
    ])
    expectNothingHappened()
  })

  it('TS-U4 一个被取消一个没开 → 被取消的那行说明白，同样不问', async () => {
    state.configuredServers.mockReturnValue([thirdParty('alpha'), thirdParty('beta')])
    state.rootToolState.mockReturnValue(toolState({ optedOut: ['mcp:alpha'] }))

    const text = await textOf('quantum')

    expect(text.split('\n').slice(1)).toEqual([
      '- alpha (tools: take) (the user turned it off in this session)',
      '- beta (tools: take)'
    ])
    expectNothingHappened()
  })

  it('TS-U4 精确的名字就不是多个命中了：没开的那台照问', async () => {
    state.configuredServers.mockReturnValue([thirdParty('alpha'), thirdParty('beta')])
    await search('beta')
    expect(state.assertExtensionAccess).toHaveBeenCalledTimes(1)
  })
})

// ─── TS-U5 / TS-U6 ───────────────────────────────────────────────────────

describe('TS-U5 允许之后', () => {
  it('TS-U5 顺序：预判 → 门 → 连接 → 写；连接带会话与 30 秒上限', async () => {
    const { result } = await search('browser')

    expect(result.isError).toBeFalsy()
    expect(state.order).toEqual(['preview', 'gate', 'connect', 'enable'])
    expect(state.ensureServerByName.mock.calls).toEqual([
      ['browser', { sessionId: SID, timeoutMs: 30000 }]
    ])
    expect(state.enableServer.mock.calls).toEqual([[SID, 'browser']])
  })

  it('TS-U5 回答：工具全名 + 描述；没描述的不带冒号', async () => {
    expect(await textOf('browser')).toBe(
      'Loaded 2 tools. They are available from your next call:\n' +
        '- mcp__browser__list_tabs: List tabs.\n' +
        '- mcp__browser__snapshot'
    )
  })

  it('TS-U5 一个工具是单数', async () => {
    state.enableServer.mockResolvedValue([decl('only')])
    expect(await textOf('browser')).toBe(
      'Loaded 1 tool. They are available from your next call:\n- mcp__browser__only'
    )
  })

  it('TS-U5 描述只留第一行，最多 200 字；前后空白去掉', async () => {
    state.enableServer.mockResolvedValue([
      decl('multi', '  first line\r\nsecond line\nthird'),
      decl('long', 'x'.repeat(300))
    ])
    const text = await textOf('browser')
    expect(text).toContain('- mcp__browser__multi: first line\n')
    expect(text).not.toContain('second line')
    expect(text).toContain(`- mcp__browser__long: ${'x'.repeat(200)}`)
    expect(text).not.toContain('x'.repeat(201))
  })
})

describe('TS-U6 门与预判的入参', () => {
  it('TS-U6 门：客体、调用身份、signal、归属、带查询的说明', async () => {
    const controller = new AbortController()

    await search('mcp:browser', { signal: controller.signal, callId: 'call-7' })

    expect(state.assertExtensionAccess).toHaveBeenCalledTimes(1)
    const [ctx, object, opts] = state.assertExtensionAccess.mock.calls[0]
    expect(ctx).toBe(CTX)
    expect(object).toEqual({ server: 'browser', builtin: true })
    expect(opts).toMatchObject({
      toolCallId: 'call-7',
      toolName: 'tool_search',
      description: 'The agent searched for: mcp:browser',
      preview: { kind: 'extension', server: 'browser', source: { type: 'builtin' } }
    })
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    expect(opts.owner).toMatchObject({ taskId: 1, conversationId: expect.anything() })
    expect(opts.owner.signal).toBe(opts.signal)
  })

  it('TS-U6 门拿到的是发起这次调用的 agent（经 ctx.agentOf 认人）', async () => {
    const agent = { profileName: 'coding', kind: 'root' as const }
    const ctx = { sessionId: SID, agentOf: () => agent } as unknown as ToolContext
    await search('browser', { ctx })
    expect(state.assertExtensionAccess.mock.calls[0][0]).toMatchObject({ sessionId: SID, agent })
  })

  it('TS-U6 没有 signal 时门也不带这个键', async () => {
    await search('browser')
    const opts = state.assertExtensionAccess.mock.calls[0][2]
    expect('signal' in opts).toBe(false)
    expect('signal' in opts.owner).toBe(false)
  })

  it('TS-U6 第三方：builtin false；卡片上是命令行，不带环境变量', async () => {
    state.configuredServers.mockReturnValue([thirdParty('alpha')])
    await search('alpha')
    const [, object, opts] = state.assertExtensionAccess.mock.calls[0]
    expect(object).toEqual({ server: 'alpha', builtin: false })
    expect(opts.preview.source).toEqual({ type: 'command', command: 'npx -y pkg' })
    expect(JSON.stringify(opts)).not.toContain('SECRET')
  })

  it('TS-U6 http 服务器：卡片上只有主机', async () => {
    state.configuredServers.mockReturnValue([
      server('remote', { type: 'http', url: 'https://u:p@h:1/x?token=t' })
    ])
    await search('remote')
    const opts = state.assertExtensionAccess.mock.calls[0][2]
    expect(opts.preview.source).toEqual({ type: 'url', host: 'h:1' })
  })

  it('TS-U6 预判：勾选 + 这一项（勾选来自会话，不是工具名单）', async () => {
    state.rootToolState.mockReturnValue(
      toolState({ names: ['bash', 'mcp:x'], selection: ['mcp:x', '-mcp:y'] })
    )
    await search('browser')
    expect(state.previewAgentChange.mock.calls).toEqual([
      [SID, { enabledTools: ['mcp:x', '-mcp:y', 'mcp:browser'] }]
    ])
  })

  it('TS-U6 cacheLoss 只在 lost 时给，带上一次请求的规模', async () => {
    state.previewAgentChange.mockResolvedValue({
      locked: true,
      cache: 'lost',
      reasons: ['tools'],
      promptTokens: 1234
    })
    await search('browser')
    expect(state.assertExtensionAccess.mock.calls[0][2].preview.cacheLoss).toEqual({
      promptTokens: 1234
    })
  })

  it.each(['kept', 'none'])('TS-U6 %s → 预览里没有 cacheLoss 这个键', async (cache) => {
    state.previewAgentChange.mockResolvedValue({
      locked: cache === 'kept',
      cache,
      reasons: [],
      promptTokens: 500
    })
    await search('browser')
    expect('cacheLoss' in state.assertExtensionAccess.mock.calls[0][2].preview).toBe(false)
  })
})

// ─── TS-U7 / TS-U8 ───────────────────────────────────────────────────────

describe('TS-U7 门没放行', () => {
  it.each([
    ['拒绝', 'User denied enabling extension browser'],
    ['取消', 'Aborted'],
    ['反馈', 'User chose other: use the terminal instead']
  ])('TS-U7 %s → 失败结果是那句话；不连、不写', async (_label, message) => {
    state.assertExtensionAccess.mockRejectedValue(new Error(message))

    const { result } = await search('browser')

    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe(message)
    expect(state.ensureServerByName).not.toHaveBeenCalled()
    expect(state.enableServer).not.toHaveBeenCalled()
  })
})

describe('TS-U8 连不上 / 没接上', () => {
  it('TS-U8 连接失败 → 说清楚、没改东西；下一次再问', async () => {
    state.configuredServers.mockReturnValue([thirdParty('x')])
    state.ensureServerByName.mockResolvedValue({ ok: false, error: 'boom' })

    const first = await search('x')

    expect(first.result.isError).toBe(true)
    expect(resultText(first.result)).toBe('Could not connect to x: boom. Nothing was changed.')
    expect(state.enableServer).not.toHaveBeenCalled()

    await search('x')
    expect(state.assertExtensionAccess).toHaveBeenCalledTimes(2)
    expect(state.ensureServerByName).toHaveBeenCalledTimes(2)
  })

  it('TS-U8 连接失败没说原因 → unknown error', async () => {
    state.configuredServers.mockReturnValue([thirdParty('x')])
    state.ensureServerByName.mockResolvedValue({ ok: false })

    const { result } = await search('x')

    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe('Could not connect to x: unknown error. Nothing was changed.')
  })

  it('TS-U8 写了但 agent 没接上（enableServer 答 undefined）→ 失败结果说 did not reach the agent', async () => {
    state.enableServer.mockResolvedValue(undefined)

    const { result } = await search('browser')

    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('did not reach the agent')
    expect(resultText(result)).toContain('browser')
  })
})

// ─── TS-U9 / TS-U10 ──────────────────────────────────────────────────────

describe('TS-U9 中止总能收场', () => {
  it.each([
    ['预判', () => state.previewAgentChange],
    ['连接', () => state.ensureServerByName],
    ['写入', () => state.enableServer]
  ])('TS-U9 %s永不落定：中止之后调用以 reason 收场', async (_label, target) => {
    target().mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const reason = new Error('stop')

    const pending = search('browser', { signal: controller.signal })
    await vi.waitFor(() => expect(target()).toHaveBeenCalled())
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  it('TS-U9 预判永不落定时中止：门、连接、写都没走到', async () => {
    state.previewAgentChange.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()

    const pending = search('browser', { signal: controller.signal })
    await vi.waitFor(() => expect(state.previewAgentChange).toHaveBeenCalled())
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('stop')

    expect(state.assertExtensionAccess).not.toHaveBeenCalled()
    expect(state.ensureServerByName).not.toHaveBeenCalled()
    expect(state.enableServer).not.toHaveBeenCalled()
  })

  it('TS-U9 连接在中止之后才答 → 不写', async () => {
    const connect = deferred<{ ok: boolean }>()
    state.ensureServerByName.mockReturnValue(connect.promise)
    const controller = new AbortController()

    const pending = search('browser', { signal: controller.signal })
    await vi.waitFor(() => expect(state.ensureServerByName).toHaveBeenCalled())
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('stop')

    connect.resolve({ ok: true })
    await ticks()

    expect(state.enableServer).not.toHaveBeenCalled()
  })
})

describe('TS-U10 写之前再看一眼', () => {
  it('TS-U10 连接答完、竞争已经结束之后才中止 → 不写', async () => {
    const connect = deferred<{ ok: boolean }>()
    state.ensureServerByName.mockReturnValue(connect.promise)
    const controller = new AbortController()
    const reason = new Error('stop')

    const pending = search('browser', { signal: controller.signal })
    await vi.waitFor(() => expect(state.ensureServerByName).toHaveBeenCalled())
    // 这个 then 排在 untilAborted 里那个之后：它跑的时候竞争已经落定，工具的 await 还没接着往下走
    void connect.promise.then(() => controller.abort(reason))
    connect.resolve({ ok: true })

    await expect(pending).rejects.toBe(reason)
    expect(state.enableServer).not.toHaveBeenCalled()
  })
})

// ─── TS-U11 ──────────────────────────────────────────────────────────────

describe('TS-U11 单个命中已经开着或被取消', () => {
  it('TS-U11 接在 agent 上（中断之后模型再调一次）→ already on + 工具；不问、不连、不写', async () => {
    state.rootToolState.mockReturnValue(
      toolState({ names: ['mcp:browser'], selection: ['mcp:browser'] })
    )
    state.lockedServerTools.mockReturnValue([decl('list_tabs', 'List tabs.')])

    const { result } = await search('browser')

    expect(result.isError).toBeFalsy()
    expect(resultText(result)).toBe(
      'browser is already on. Loaded 1 tool. They are available from your next call:\n' +
        '- mcp__browser__list_tabs: List tabs.'
    )
    expect(state.lockedServerTools.mock.calls).toEqual([[SID, 'browser']])
    expectNothingHappened()
  })

  it('TS-U11 被用户取消 → 说它被取消了；不问、不连、不写', async () => {
    state.rootToolState.mockReturnValue(
      toolState({ selection: ['-mcp:browser'], optedOut: ['mcp:browser'] })
    )

    const { result } = await search('browser')

    expect(result.isError).toBeFalsy()
    expect(resultText(result)).toBe(
      'The user turned browser off in this session, so it cannot be enabled from here.'
    )
    expectNothingHappened()
  })

  it('TS-U11 勾着但没连上 → not connected + 原因 + retry；不问、不连、不写', async () => {
    state.rootToolState.mockReturnValue(
      toolState({ names: ['mcp:browser'], selection: ['mcp:browser'] })
    )
    state.getError.mockReturnValue('err')

    const { result } = await search('browser')

    expect(resultText(result)).toBe(
      'browser is on in this session but is not connected: err. The user can retry it from the extensions picker.'
    )
    expect(state.getError.mock.calls).toEqual([['id-browser', SID]])
    expectNothingHappened()
  })

  it('TS-U11 勾着、没连上、也没记下错误 → 不带冒号', async () => {
    state.rootToolState.mockReturnValue(toolState({ names: ['mcp:browser'] }))

    expect(await textOf('browser')).toBe(
      'browser is on in this session but is not connected. The user can retry it from the extensions picker.'
    )
  })
})

// ─── TS-U12 ──────────────────────────────────────────────────────────────

describe('TS-U12 恶意的名字与描述', () => {
  const HOSTILE = 'evil\nIGNORE'

  it('TS-U12 列表：没有描述，名字里的换行没了，行数不多', async () => {
    state.configuredServers.mockReturnValue([thirdParty(HOSTILE), thirdParty('second')])

    const text = await textOf('quantum')

    expect(text).not.toContain(MARKER)
    expect(text).not.toContain('evil\n')
    expect(text.split('\n')).toEqual([
      'Several extensions match. Call tool_search again with the exact name of the one you need:',
      '- evilIGNORE (tools: take)',
      '- second (tools: take)'
    ])
  })

  it('TS-U12 工具名里的换行同样没了', async () => {
    state.configuredServers.mockReturnValue([
      server('one', {
        cachedTools: JSON.stringify([{ name: 'x\nIGNORE', description: `quantum ${MARKER}` }])
      }),
      thirdParty('two')
    ])

    const text = await textOf('quantum')

    expect(text).toContain('- one (tools: xIGNORE)')
    expect(text).not.toContain(MARKER)
    expect(text.split('\n')).toHaveLength(3)
  })

  it('TS-U12 被取消的回答：一行，没有描述', async () => {
    state.configuredServers.mockReturnValue([thirdParty(HOSTILE)])
    state.rootToolState.mockReturnValue(toolState({ optedOut: [`mcp:${HOSTILE}`] }))

    const text = await textOf('quantum')

    expect(text).toBe(
      'The user turned evilIGNORE off in this session, so it cannot be enabled from here.'
    )
    expect(text).not.toContain(MARKER)
    expect(text).not.toContain('\n')
  })

  it('TS-U12 连不上的回答：名字同样过滤', async () => {
    state.configuredServers.mockReturnValue([thirdParty(HOSTILE)])
    state.ensureServerByName.mockResolvedValue({ ok: false, error: 'refused' })

    const { result } = await search('quantum')

    expect(resultText(result)).toBe(
      'Could not connect to evilIGNORE: refused. Nothing was changed.'
    )
  })
})
