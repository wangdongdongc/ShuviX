/**
 * widget 工具（桌面注册）—— agent 用组件、造组件的唯一入口（设计稿 docs/widget-tool-design.md §5、D12–D15）。钉：
 *
 *   WT4-TL-01   描述 / schema 只按根 agent 的货架（ctx.rootSkills）定：有 builtin:widget 是全量，没有只剩
 *               list / describe / call 与四个字段；描述里没有组件名单
 *   WT4-TL-02..06 造的那组动作（与 call 的 dry_run）在调用时按**发起调用的 agent 自己的**货架再核一次：
 *               它的 skill 工具没有 widget 技能 → 拒，什么都不碰；真 SkillTool 经包装器（原型链）照样读得到
 *               skillNames；没有 durable 调用（直接调钩子）按根货架；有调用但读不到工具表 → 按不能（宁可少给）
 *   WT4-TL-07..09 list：用组件的只看见有 API 的组件与它们给 agent 的操作；造组件的另见没有 API 的、老组件与
 *               源码目录；授权、转义、第一句、空表
 *   WT4-TL-10..11 describe 与 describe / call 的参数错误
 *   WT4-TL-12..16 call：先过门（读操作要读、写操作要读写）再进分发器；拒绝 / 取消；参数错误不弹卡片；
 *               纯界面操作只在 dry run 里够得着；失败的几种文案（invalid_args 附 schema、internal 说是组件的代码出错）
 *   WT4-TL-17..18 create：不问，造它的会话得到读写（来源 widget）；失败不授予
 *   WT4-TL-19..25 build / preview / sql / export / open 各自的门、参数与结果
 *   WC-S40..43 sql 的 `legacy: true`：没有旧数据 → 先过写门、再报「no data in the older shared database」，两个库都不查；
 *               有旧数据（含已换成 SQLite 的）→ 查 PGlite；不带 legacy → 组件自己的库，不管有没有旧数据；门拒绝 →
 *               不问有没有旧数据
 *   WC-S44     造组件的 list：已换成 SQLite、还留着旧数据的组件标 old-data="legacy-postgres"（不是 storage）
 *   WT4-TL-26   派生 agent 调：门的主体与调用方的 actor 都是它，不是根 agent
 *   WT4-TL-30..31 调用方的货架是它创建时（或锁里）的那份：根货架有、派生 agent 创建时 widget 技能已停用 → 照拒，
 *               用的那组照用；锁里记着、此刻停用了 → 按锁放行
 *   WT4-TL-29   注册元数据：设置页「LLM 工具」看到的是全量描述与 schema（与哪个会话无关）
 *
 * 组件服务 / 授权表 / 门 / 窗口 / 预览全部替身（门在 toolContext.assertWidgetAccess，这里只看工具怎么调它）；
 * 预览的两个参数解析器（parsePreviewSizes / parsePreviewTheme）用真的。真 SkillTool 只在 TL-04 / TL-30 / TL-31 用
 * （skillService 替身给货架）。调用经 invokeTool（假 durable api）：`api.agent()` 交回的工具表决定发起调用的 agent 能不能造组件。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  invokeTool,
  resultText,
  type InvokeArgs,
  type ToolInvocation
} from '@shuvix/agent-runtime/tools/testing/invokeTool'

const state = vi.hoisted(() => ({
  registered: [] as Array<Record<string, unknown>>,
  widgets: new Map<string, { id: string; name: string; description: string; archivedAt: number }>(),
  storage: new Map<string, 'sqlite' | 'pglite'>(),
  snapshots: new Map<string, { hash: string; builtAt: number; ops: unknown[] }>(),
  dir: (id: string) => `/home/u/.shuvix/widgets/${id}`,
  getById: vi.fn(),
  listActive: vi.fn(),
  init: vi.fn(),
  build: vi.fn(),
  dbQuery: vi.fn(),
  serviceOpen: vi.fn(),
  getWidgetDir: vi.fn(),
  widgetStorageOf: vi.fn(),
  readApiSnapshot: vi.fn(),
  callWidgetOp: vi.fn(),
  runWidgetDbQuery: vi.fn(),
  hasLegacyWidgetData: vi.fn(),
  exportWidget: vi.fn(),
  resolveExportZipPath: vi.fn(),
  widgetAccess: vi.fn(),
  grantWidget: vi.fn(),
  assertWidgetAccess: vi.fn(),
  assertWriteAllowed: vi.fn(),
  resolveProjectConfig: vi.fn(),
  windowOpen: vi.fn(),
  previewWidget: vi.fn(),
  findEnabled: vi.fn(),
  findAll: vi.fn()
}))

/** 两个错误类：工具按 `instanceof` 认它们，替身与用例得是同一个类 */
const errors = vi.hoisted(() => {
  class WidgetApiError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
  class WidgetExportError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
  return { WidgetApiError, WidgetExportError }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shuvix-widget-tool-test', isPackaged: false },
  BrowserWindow: class {},
  session: {}
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../services/toolRegistry', () => ({
  registerBuiltinTool: (meta: Record<string, unknown>) => {
    state.registered.push(meta)
  }
}))
vi.mock('../../services/widget', () => ({
  widgetService: {
    getById: state.getById,
    listActive: state.listActive,
    init: state.init,
    build: state.build,
    dbQuery: state.dbQuery,
    getWidgetDir: state.getWidgetDir,
    open: state.serviceOpen
  },
  widgetStorageOf: state.widgetStorageOf,
  // 组件在共用 PGlite 里有没有旧数据：缺省说有（beforeEach），WC-S40..S43 自己定
  hasLegacyWidgetData: state.hasLegacyWidgetData,
  readApiSnapshot: state.readApiSnapshot,
  callWidgetOp: state.callWidgetOp,
  runWidgetDbQuery: state.runWidgetDbQuery,
  exportWidget: state.exportWidget,
  resolveExportZipPath: state.resolveExportZipPath,
  WidgetApiError: errors.WidgetApiError,
  WidgetExportError: errors.WidgetExportError
}))
vi.mock('../../services/acl', () => ({
  sessionAcl: { widgetAccess: state.widgetAccess, grantWidget: state.grantWidget }
}))
vi.mock('../../services/toolContext', () => ({
  assertWidgetAccess: state.assertWidgetAccess,
  assertWriteAllowed: state.assertWriteAllowed,
  resolveProjectConfig: state.resolveProjectConfig,
  TOOL_ABORTED: 'Aborted'
}))
vi.mock('../../services/widgetWindowService', () => ({ open: state.windowOpen }))
// 两个参数解析器用真的（认不得的尺寸 / 主题怎么报，是工具「门之前就报错」的那一半）；截图本身是替身
vi.mock('../../services/widgetPreviewService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/widgetPreviewService')>()),
  previewWidget: state.previewWidget
}))
// findAll 单列一个：按锁重建的货架（{ known }）读它，停用着的技能在那里仍看得见（TL-31）；缺省同 findEnabled
vi.mock('../../services/skillService', () => ({
  skillService: {
    findEnabled: state.findEnabled,
    findModelInvocable: state.findEnabled,
    findAll: state.findAll
  }
}))

import { wrapDurableOutput } from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import {
  WIDGET_DESCRIPTION,
  WIDGET_USE_DESCRIPTION,
  WidgetParamsSchema,
  WidgetTool
} from '../widget'
import { SkillTool } from '../../services/skillTool'
import type { ToolContext } from '../../services/toolContext'

// ─── 夹具 ────────────────────────────────────────────────────────────────

const ALL_ACTIONS = [
  'list',
  'describe',
  'call',
  'create',
  'build',
  'preview',
  'sql',
  'export',
  'open'
]
const BUILD_ACTIONS = ['create', 'build', 'preview', 'sql', 'export', 'open'] as const

const LIST_BOOKS = {
  name: 'listBooks',
  mode: 'read',
  description: 'List books. Filter by status.',
  agent: true,
  input: { type: 'object', properties: { status: { type: 'string' } } },
  output: { type: 'array' }
}
const ADD_BOOK = {
  name: 'addBook',
  mode: 'write',
  description: 'Add a book.\nThe title is required.',
  agent: true,
  input: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } }
}
/** 纯界面的操作（agent: false）：只有组件自己的界面、或造组件的 agent 在 dry run 里够得着 */
const SAVE_LAYOUT = {
  name: 'saveLayout',
  mode: 'write',
  description: 'Save the layout.',
  agent: false,
  input: { type: 'object' }
}

/** 放一个组件：SQLite（有 / 没有快照）或老的 PGlite；archived 的 listActive 看不见、getById 看得见 */
function putWidget(
  id: string,
  opts: {
    name?: string
    description?: string
    storage?: 'sqlite' | 'pglite'
    ops?: unknown[] | null
    archived?: boolean
  } = {}
): void {
  state.widgets.set(id, {
    id,
    name: opts.name ?? id,
    description: opts.description ?? '',
    archivedAt: opts.archived ? 1_700_000_000_000 : 0
  })
  state.storage.set(id, opts.storage ?? 'sqlite')
  if (opts.ops) state.snapshots.set(id, { hash: 'h', builtAt: 1, ops: opts.ops })
}

/** 一套常用的组件：有 API 的 reading-list、没有 API 的 photo-wall、老的 old-notes、归档了的 gone-widget */
function putStandardWidgets(): void {
  putWidget('reading-list', {
    name: 'Reading list',
    description: 'Books to read.',
    ops: [LIST_BOOKS, ADD_BOOK, SAVE_LAYOUT]
  })
  putWidget('photo-wall', { name: 'Photo wall' })
  putWidget('old-notes', { name: 'Old notes', description: 'Notes.', storage: 'pglite' })
  putWidget('gone-widget', { name: 'Gone', ops: [LIST_BOOKS], archived: true })
}

/** 一个 agent 的身份（ToolContext['agent'] 的形状） */
const identity = (
  profileName: string,
  model: string,
  kind: 'root' | 'spawned' = 'root'
): NonNullable<ToolContext['agent']> => ({
  profileName,
  kind,
  getModelConfig: () => ({ provider: 'anthropic', model, capabilities: {} }) as never
})

/** 会话级装配的 ctx：根 agent 的货架有 widget 技能 */
const ctx: ToolContext = {
  sessionId: 's1',
  agent: identity('work', 'gpt-5'),
  rootSkills: ['builtin:drawing', 'builtin:widget']
}

/** 一个 skill 工具的桩：只有名字与（自有属性的）skillNames */
const skillStub = (names: string[]): object => ({ name: 'skill', skillNames: names })

/** durable `api.agent()` 交回的 agent：只看它的 tools */
const agentWith = (tools: object[]): unknown => ({
  thinkingLevel: 'off',
  extensions: [],
  tools,
  callable: tools,
  deferred: [],
  sections: []
})

type Args = InvokeArgs<WidgetTool>

interface RunOptions {
  /** 发起调用的 agent：'use' = 没有 skill 工具；'build' = skill 工具上架了 builtin:widget；或自给工具表 */
  caller?: 'use' | 'build' | object[]
  /** `api.agent()` 抛错 */
  agentRejects?: boolean
  signal?: AbortSignal
  callId?: string
  taskId?: number
  conversationId?: number
}

/** 调一次工具（假 durable api）；`caller` 决定发起调用的 agent 自己的货架 */
function run(
  tool: WidgetTool,
  args: Record<string, unknown>,
  o: RunOptions = {}
): Promise<ToolInvocation> {
  const caller = o.caller ?? 'use'
  const tools =
    caller === 'use'
      ? [tool]
      : caller === 'build'
        ? [tool, skillStub(['builtin:widget'])]
        : [tool, ...caller]
  return invokeTool(tool, args as Args, {
    callId: o.callId ?? 'c1',
    taskId: o.taskId ?? 7,
    ...(o.conversationId === undefined ? {} : { conversationId: o.conversationId }),
    ...(o.signal ? { signal: o.signal } : {}),
    api: {
      agent: async () => {
        if (o.agentRejects) throw new Error('no agent for this conversation')
        return agentWith(tools) as never
      }
    }
  })
}

/** 一次成功调用的文字 */
function textOf(inv: ToolInvocation): string {
  expect(inv.result.isError, resultText(inv.result)).not.toBe(true)
  return resultText(inv.result)
}

/** 一次失败调用（工具抛错收成 isError 结果）的文字 */
function errorOf(inv: ToolInvocation): string {
  expect(inv.result.isError).toBe(true)
  return resultText(inv.result)
}

/** 除了组件服务的读（getById / listActive 等）之外的一切副作用都没碰 */
function expectNothingTouched(): void {
  for (const fn of [
    state.init,
    state.build,
    state.dbQuery,
    state.callWidgetOp,
    state.runWidgetDbQuery,
    state.exportWidget,
    state.resolveExportZipPath,
    state.grantWidget,
    state.assertWidgetAccess,
    state.assertWriteAllowed,
    state.windowOpen,
    state.serviceOpen,
    state.previewWidget
  ]) {
    expect(fn).not.toHaveBeenCalled()
  }
}

let tmp = ''

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shuvix-widget-tool-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  for (const fn of Object.values(state)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as { mockReset: () => void }).mockReset()
  }
  state.widgets.clear()
  state.storage.clear()
  state.snapshots.clear()
  state.findAll.mockImplementation((projectPath?: string) => state.findEnabled(projectPath))
  state.getById.mockImplementation((id: string) => state.widgets.get(id))
  state.listActive.mockImplementation(() =>
    [...state.widgets.values()].filter((w) => w.archivedAt === 0)
  )
  state.getWidgetDir.mockImplementation((id: string) => state.dir(id))
  state.widgetStorageOf.mockImplementation((id: string) => state.storage.get(id) ?? 'pglite')
  state.readApiSnapshot.mockImplementation((id: string) => state.snapshots.get(id) ?? null)
  // 缺省照事实：还在 PGlite 上的老组件有旧数据，SQLite 组件没有（换过存储的用例自己设）
  state.hasLegacyWidgetData.mockImplementation(
    (id: string) => (state.storage.get(id) ?? 'pglite') !== 'sqlite'
  )
  state.widgetAccess.mockReturnValue('none')
  state.assertWidgetAccess.mockResolvedValue(undefined)
  state.assertWriteAllowed.mockResolvedValue(undefined)
  state.resolveProjectConfig.mockReturnValue({ workingDirectory: '/ws' })
  state.callWidgetOp.mockResolvedValue({
    op: 'x',
    mode: 'read',
    result: { outcome: { ok: true, value: { ok: 1 } }, wrote: false, logs: [] }
  })
  putStandardWidgets()
})

/** callWidgetOp 交回一个 outcome（与日志） */
function opReturns(
  outcome: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } },
  logs: string[] = []
): void {
  state.callWidgetOp.mockResolvedValue({
    op: 'x',
    mode: 'read',
    result: { outcome, wrote: false, logs }
  })
}

// ─── 描述与 schema ─────────────────────────────────────────────────────────

describe('WT4-TL-01 描述与 schema 按根 agent 的货架定', () => {
  const propsOf = (tool: WidgetTool): Record<string, unknown> =>
    (tool.parameters as unknown as { properties: Record<string, unknown> }).properties
  const enumOf = (tool: WidgetTool): unknown => (propsOf(tool).action as { enum: unknown }).enum

  it('根货架有 builtin:widget：全量描述、9 个动作、造组件的字段都在', () => {
    const tool = new WidgetTool(ctx)
    expect(tool.description).toBe(WIDGET_DESCRIPTION)
    expect(enumOf(tool)).toEqual(ALL_ACTIONS)
    for (const key of [
      'dry_run',
      'name',
      'description',
      'message',
      'sizes',
      'theme',
      'sql',
      'legacy',
      'path'
    ]) {
      expect(propsOf(tool)).toHaveProperty(key)
    }
  })

  it.each([
    ['undefined', undefined],
    ['[]', []],
    ["['builtin:drawing']", ['builtin:drawing']]
  ])('根货架 %s：只有用的那组（描述、动作、字段）', (_l, rootSkills) => {
    const tool = new WidgetTool({
      sessionId: 's1',
      ...(rootSkills === undefined ? {} : { rootSkills })
    })
    expect(tool.description).toBe(WIDGET_USE_DESCRIPTION)
    expect(enumOf(tool)).toEqual(['list', 'describe', 'call'])
    expect(Object.keys(propsOf(tool))).toEqual(['action', 'widget', 'op', 'args'])
    // 用的那一份从描述到 schema 都不提造的动作、dry_run 与技能
    const forbidden = /\b(create|build|preview|sql|export|open|dry_run|skill)\b/i
    expect(tool.description).not.toMatch(forbidden)
    expect(JSON.stringify(tool.parameters)).not.toMatch(forbidden)
  })

  it('描述里没有组件名单：注册了哪些组件都一样，构造时也不读组件表', () => {
    const first = new WidgetTool(ctx)
    state.widgets.clear()
    putWidget('other-widget', { name: 'Other', ops: [LIST_BOOKS] })
    const second = new WidgetTool(ctx)
    expect(second.description).toBe(first.description)
    const useA = new WidgetTool({ sessionId: 's1' })
    state.widgets.clear()
    const useB = new WidgetTool({ sessionId: 's1' })
    expect(useB.description).toBe(useA.description)
    expect(state.listActive).not.toHaveBeenCalled()
    expect(state.getById).not.toHaveBeenCalled()
    expect(first.description).not.toContain('reading-list')
  })
})

// ─── 造组件的动作按发起调用的 agent 核对 ─────────────────────────────────────────

const refusal = (action: string, dryRun = false): string =>
  `"${action}"${dryRun ? ' with dry_run' : ''} is for building widgets, which needs the builtin:widget skill. Use "list", "describe" and "call".`

/** 每个造的动作一份能过参数检查的参数（证明拒绝发生在参数检查之前也无妨：什么都没碰） */
const BUILD_ARGS: Record<(typeof BUILD_ACTIONS)[number], Record<string, unknown>> = {
  create: { action: 'create', widget: 'new-widget', name: 'New' },
  build: { action: 'build', widget: 'reading-list' },
  preview: { action: 'preview', widget: 'reading-list' },
  sql: { action: 'sql', widget: 'reading-list', sql: 'select 1' },
  export: { action: 'export', widget: 'reading-list', path: 'out' },
  open: { action: 'open', widget: 'reading-list' }
}

describe('WT4-TL-02..06 造的动作按发起调用的 agent 自己的货架核对', () => {
  it.each(BUILD_ACTIONS)(
    'WT4-TL-02 %s：调用方的 skill 工具只有别的技能 / 根本没有 skill 工具 → 拒，什么都不碰（根货架有也不算）',
    async (action) => {
      const tool = new WidgetTool(ctx)
      for (const caller of [[skillStub(['builtin:drawing'])], []]) {
        const inv = await run(tool, BUILD_ARGS[action], { caller })
        expect(errorOf(inv)).toBe(refusal(action))
      }
      expectNothingTouched()
      expect(state.getById).not.toHaveBeenCalled()
    }
  )

  it('WT4-TL-03 不造组件的调用方用 call 的 dry_run → 拒，不过门、不调操作', async () => {
    const tool = new WidgetTool(ctx)
    const inv = await run(tool, {
      action: 'call',
      widget: 'reading-list',
      op: 'addBook',
      dry_run: true
    })
    expect(errorOf(inv)).toBe(refusal('call', true))
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
    expect(state.callWidgetOp).not.toHaveBeenCalled()
  })

  it('WT4-TL-04 调用方的工具表里是包装过的真 SkillTool：skillNames（原型上的 getter）经原型链读得到 → 放行', async () => {
    state.findEnabled.mockReturnValue([
      { name: 'builtin:widget', description: 'Build widgets.', basePath: '/skills/widget' }
    ])
    // 创建 agent 时的货架（'enabled'）：模型可调用的全部 —— 这里就是 builtin:widget 这一本
    const real = new SkillTool('enabled')
    expect(real.skillNames).toEqual(['builtin:widget'])
    // 桌面的两层包装都是 Object.create（输出内核 + 门），元数据经原型链透出
    const wrapped = Object.create(wrapDurableOutput(real, { spill: false })) as object
    expect(Object.prototype.hasOwnProperty.call(wrapped, 'skillNames')).toBe(false)

    const tool = new WidgetTool({ sessionId: 's1' })
    const inv = await run(tool, { action: 'open', widget: 'reading-list' }, { caller: [wrapped] })
    expect(textOf(inv)).toBe('Opened "Reading list" in its own window.')
    expect(state.windowOpen).toHaveBeenCalledWith('reading-list')

    // 对照：把工具展开成普通对象的包装器会丢掉 getter —— 那样每次造组件都会被悄悄拒掉
    const spread = { ...(real as unknown as Record<string, unknown>) }
    const refused = await run(
      tool,
      { action: 'open', widget: 'reading-list' },
      { caller: [spread] }
    )
    expect(errorOf(refused)).toBe(refusal('open'))
  })

  it('WT4-TL-05 没有 durable 调用（直接调钩子）：按根货架', async () => {
    type Internal = {
      executeInternal: (
        id: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
        call?: unknown
      ) => Promise<{ content: { type: string; text?: string }[] }>
    }
    const building = new WidgetTool(ctx) as unknown as Internal
    const res = await building.executeInternal('c1', { action: 'open', widget: 'reading-list' })
    expect(res.content[0].text).toBe('Opened "Reading list" in its own window.')

    const using = new WidgetTool({ sessionId: 's1', rootSkills: [] }) as unknown as Internal
    await expect(
      using.executeInternal('c1', { action: 'open', widget: 'reading-list' })
    ).rejects.toThrow(refusal('open'))
    expect(state.windowOpen).toHaveBeenCalledTimes(1)
  })

  it('WT4-TL-05 有调用但读不到它的工具表（api.agent 抛错）：按不能 —— 根货架有也不给', async () => {
    const tool = new WidgetTool(ctx)
    const inv = await run(tool, BUILD_ARGS.open, { agentRejects: true })
    expect(errorOf(inv)).toBe(refusal('open'))
    const dry = await run(
      tool,
      { action: 'call', widget: 'reading-list', op: 'addBook', dry_run: true },
      { agentRejects: true }
    )
    expect(errorOf(dry)).toBe(refusal('call', true))
    expectNothingTouched()
    // list 也按不造组件的口径：没有 API 的与源码目录都不给
    const list = await run(tool, { action: 'list' }, { agentRejects: true })
    expect(textOf(list)).not.toContain('dir=')
    expect(textOf(list)).not.toContain('photo-wall')
  })

  it('WT4-TL-06 调用方自己的货架有技能、根货架没有：执行这一层按调用方放行', async () => {
    const tool = new WidgetTool({ sessionId: 's1', rootSkills: ['builtin:drawing'] })
    expect(tool.description).toBe(WIDGET_USE_DESCRIPTION)
    const inv = await run(tool, BUILD_ARGS.open, { caller: 'build' })
    expect(textOf(inv)).toBe('Opened "Reading list" in its own window.')
  })
})

// ─── list ────────────────────────────────────────────────────────────────

describe('WT4-TL-07..09 list', () => {
  it('WT4-TL-07 用组件的调用方：只列有 API 的组件与给 agent 的操作；没有目录、没有存储、不过门', async () => {
    const tool = new WidgetTool(ctx)
    const inv = await run(tool, { action: 'list' })
    expect(textOf(inv)).toBe(
      [
        '<widgets>',
        '<widget id="reading-list" name="Reading list" access="none">',
        'Books to read.',
        '- listBooks (read): List books.',
        '- addBook (write): Add a book.',
        '</widget>',
        '</widgets>'
      ].join('\n')
    )
    expect(inv.result.details).toEqual({ action: 'list' })
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
    // 老组件不读快照（它没有 API）
    expect(state.readApiSnapshot).not.toHaveBeenCalledWith('old-notes')
  })

  it('WT4-TL-08 造组件的调用方：另见没有 API 的与老组件、每个都带源码目录，纯界面操作标出来', async () => {
    const tool = new WidgetTool(ctx)
    const inv = await run(tool, { action: 'list' }, { caller: 'build' })
    const dir = (id: string): string => state.dir(id)
    expect(textOf(inv)).toBe(
      [
        '<widgets>',
        `<widget id="reading-list" name="Reading list" access="none" dir="${dir('reading-list')}">`,
        'Books to read.',
        '- listBooks (read): List books.',
        '- addBook (write): Add a book.',
        '- saveLayout (write, screen only): Save the layout.',
        '</widget>',
        `<widget id="photo-wall" name="Photo wall" access="none" dir="${dir('photo-wall')}">`,
        '(no API)',
        '</widget>',
        `<widget id="old-notes" name="Old notes" access="none" storage="legacy-postgres" dir="${dir('old-notes')}">`,
        'Notes.',
        '(no API)',
        '</widget>',
        '</widgets>'
      ].join('\n')
    )
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
  })

  it('WT4-TL-09 access 按本会话的授权（none / read / read-write）', async () => {
    state.widgets.clear()
    putWidget('w-none', { ops: [LIST_BOOKS] })
    putWidget('w-read', { ops: [LIST_BOOKS] })
    putWidget('w-write', { ops: [LIST_BOOKS] })
    state.widgetAccess.mockImplementation((_s: string, id: string) =>
      id === 'w-read' ? 'read' : id === 'w-write' ? 'write' : 'none'
    )
    const text = textOf(await run(new WidgetTool(ctx), { action: 'list' }))
    expect(text).toContain('<widget id="w-none" name="w-none" access="none">')
    expect(text).toContain('<widget id="w-read" name="w-read" access="read">')
    expect(text).toContain('<widget id="w-write" name="w-write" access="read-write">')
    expect(state.widgetAccess.mock.calls).toEqual([
      ['s1', 'w-none'],
      ['s1', 'w-read'],
      ['s1', 'w-write']
    ])
  })

  it('WT4-TL-09 name / dir 属性里的 " & < 转义', async () => {
    state.widgets.clear()
    putWidget('odd-name', { name: 'A "quoted" & <b>', ops: [LIST_BOOKS] })
    state.getWidgetDir.mockReturnValue('/home/u/R&D "x"/<odd-name>')
    const text = textOf(await run(new WidgetTool(ctx), { action: 'list' }, { caller: 'build' }))
    expect(text).toContain(
      '<widget id="odd-name" name="A &quot;quoted&quot; &amp; &lt;b>" access="none" dir="/home/u/R&amp;D &quot;x&quot;/&lt;odd-name>">'
    )
  })

  it('WT4-TL-09 说明的第一句：句号后跟空白才断；1.5 这种不断；没有句号整行', async () => {
    state.widgets.clear()
    putWidget('first-sentence', {
      ops: [
        { ...LIST_BOOKS, name: 'a', description: 'List books. Filter by status.' },
        { ...LIST_BOOKS, name: 'b', description: 'Version 1.5 adds tags' },
        { ...LIST_BOOKS, name: 'c', description: 'Really? Yes.' },
        { ...LIST_BOOKS, name: 'd', description: '  First line only\nsecond line.' },
        { ...LIST_BOOKS, name: 'e', description: '列出书。 按状态筛选。' }
      ]
    })
    const text = textOf(await run(new WidgetTool(ctx), { action: 'list' }))
    expect(text).toContain('- a (read): List books.\n')
    expect(text).toContain('- b (read): Version 1.5 adds tags\n')
    expect(text).toContain('- c (read): Really?\n')
    expect(text).toContain('- d (read): First line only\n')
    expect(text).toContain('- e (read): 列出书。\n')
  })

  it('WT4-TL-09 中文的「。」紧跟下一句也算一句的结束（"列出书。按状态筛选。" → "列出书。"）', async () => {
    state.widgets.clear()
    putWidget('first-sentence', {
      ops: [{ ...LIST_BOOKS, name: 'f', description: '列出书。按状态筛选。' }]
    })
    const text = textOf(await run(new WidgetTool(ctx), { action: 'list' }))
    expect(text).toContain('- f (read): 列出书。\n')
  })

  it('WT4-TL-09 空表：用组件的 → 没有可调的；造组件的 → 还没有组件', async () => {
    // 只有没有 API 的组件：用组件的看来是空的
    state.widgets.clear()
    putWidget('photo-wall', { name: 'Photo wall' })
    expect(textOf(await run(new WidgetTool(ctx), { action: 'list' }))).toBe(
      'No widget has operations you can call yet.'
    )
    state.widgets.clear()
    expect(textOf(await run(new WidgetTool(ctx), { action: 'list' }, { caller: 'build' }))).toBe(
      'There are no widgets yet.'
    )
  })
})

// ─── describe ────────────────────────────────────────────────────────────

describe('WT4-TL-10..11 describe', () => {
  const opJson = (op: typeof LIST_BOOKS | typeof ADD_BOOK | typeof SAVE_LAYOUT): unknown => ({
    name: op.name,
    mode: op.mode,
    ...(op.agent === false ? { screenOnly: true } : {}),
    description: op.description,
    input: op.input,
    ...('output' in op && op.output !== undefined ? { output: op.output } : {})
  })

  it('WT4-TL-10 用组件的调用方：缩进两格的 JSON；output 只在声明了时有；纯界面操作不在；不过门', async () => {
    state.widgetAccess.mockReturnValue('read')
    const inv = await run(new WidgetTool(ctx), { action: 'describe', widget: 'reading-list' })
    const expected = {
      id: 'reading-list',
      name: 'Reading list',
      access: 'read',
      operations: [opJson(LIST_BOOKS), opJson(ADD_BOOK)]
    }
    expect(textOf(inv)).toBe(JSON.stringify(expected, null, 2))
    const parsed = JSON.parse(textOf(inv)) as { operations: Record<string, unknown>[] }
    expect(parsed.operations[0]).toHaveProperty('output')
    expect(parsed.operations[1]).not.toHaveProperty('output')
    expect(inv.result.details).toEqual({ action: 'describe', widget: 'reading-list' })
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
  })

  it('WT4-TL-10 造组件的调用方：纯界面操作也在，带 screenOnly: true', async () => {
    const inv = await run(
      new WidgetTool(ctx),
      { action: 'describe', widget: 'reading-list' },
      { caller: 'build' }
    )
    const parsed = JSON.parse(textOf(inv)) as { operations: unknown[] }
    expect(parsed.operations).toEqual([opJson(LIST_BOOKS), opJson(ADD_BOOK), opJson(SAVE_LAYOUT)])
    expect((parsed.operations[2] as Record<string, unknown>).screenOnly).toBe(true)
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
  })

  it.each(['describe', 'call'])(
    'WT4-TL-11 %s 的参数错误：缺 widget / 不是 id / 不存在 / 归档了 / 老组件 / 没有快照',
    async (action) => {
      const tool = new WidgetTool(ctx)
      const extra = action === 'call' ? { op: 'listBooks' } : {}
      const cases: Array<[Record<string, unknown>, string]> = [
        [{}, '`widget` is required: the widget id (see "list").'],
        [{ widget: '   ' }, '`widget` is required: the widget id (see "list").'],
        [{ widget: 'nodash' }, '"nodash" is not a widget id (kebab-case with at least one dash).'],
        [{ widget: 'Bad-Id' }, '"Bad-Id" is not a widget id (kebab-case with at least one dash).'],
        [{ widget: 'no-such' }, 'There is no widget "no-such". Call "list" to see the widgets.'],
        [
          { widget: 'gone-widget' },
          'There is no widget "gone-widget". Call "list" to see the widgets.'
        ],
        [
          { widget: 'old-notes' },
          'Widget "old-notes" has no API, so it has no operations to call.'
        ],
        [
          { widget: 'photo-wall' },
          'Widget "photo-wall" has no API, so it has no operations to call.'
        ]
      ]
      for (const [args, message] of cases) {
        const inv = await run(tool, { action, ...extra, ...args })
        expect(errorOf(inv)).toBe(message)
      }
      expect(state.assertWidgetAccess).not.toHaveBeenCalled()
      expect(state.callWidgetOp).not.toHaveBeenCalled()
    }
  )

  it('WT4-TL-11 id 先去掉首尾空白再用', async () => {
    const tool = new WidgetTool(ctx)
    const inv = await run(tool, { action: 'describe', widget: '  reading-list  ' })
    expect(JSON.parse(textOf(inv)).id).toBe('reading-list')
    expect(state.getById).toHaveBeenCalledWith('reading-list')
    const called = await run(tool, { action: 'call', widget: ' reading-list ', op: ' listBooks ' })
    textOf(called)
    expect(state.callWidgetOp.mock.calls[0].slice(0, 2)).toEqual(['reading-list', 'listBooks'])
  })
})

// ─── call ────────────────────────────────────────────────────────────────

describe('WT4-TL-12..16 call', () => {
  it.each([
    ['listBooks', 'read'],
    ['addBook', 'write']
  ])(
    'WT4-TL-12 %s：先过门（按操作的读写），再进分发器；结果是缩进两格的 JSON',
    async (op, mode) => {
      opReturns({ ok: true, value: [{ title: 'Dune' }] })
      const inv = await run(new WidgetTool(ctx), {
        action: 'call',
        widget: 'reading-list',
        op,
        args: { title: 'Dune' }
      })
      expect(textOf(inv)).toBe(JSON.stringify([{ title: 'Dune' }], null, 2))
      expect(inv.result.details).toEqual({ action: 'call', widget: 'reading-list' })

      expect(state.assertWidgetAccess).toHaveBeenCalledTimes(1)
      const [gateCtx, access, object, opts] = state.assertWidgetAccess.mock.calls[0]
      // 没有 agentOf：withCallAgent 原样交回会话的 ctx
      expect(gateCtx).toBe(ctx)
      expect(access).toBe(mode)
      expect(object).toStrictEqual({
        widgetId: 'reading-list',
        name: 'Reading list',
        operation: op
      })
      expect(opts).toStrictEqual({
        toolCallId: 'c1',
        toolName: 'widget',
        operation: 'call',
        owner: { taskId: 7, conversationId: 1 }
      })

      expect(state.callWidgetOp).toHaveBeenCalledTimes(1)
      expect(state.callWidgetOp).toHaveBeenCalledWith(
        'reading-list',
        op,
        { title: 'Dune' },
        {
          kind: 'agent',
          sessionId: 's1',
          actor: 'shuvix-work/gpt-5',
          label: 'shuvix-work/gpt-5'
        },
        { dryRun: false, allowUiOnly: false, expectedMode: mode }
      )
      expect(state.assertWidgetAccess.mock.invocationCallOrder[0]).toBeLessThan(
        state.callWidgetOp.mock.invocationCallOrder[0]
      )
    }
  )

  it('WT4-TL-12 没给 args → {}；value 是 undefined → null；有日志附在 <logs> 里；带着 signal 进门', async () => {
    opReturns({ ok: true, value: undefined }, ['first', 'second'])
    const controller = new AbortController()
    const inv = await run(
      new WidgetTool(ctx),
      { action: 'call', widget: 'reading-list', op: 'listBooks' },
      { signal: controller.signal }
    )
    expect(textOf(inv)).toBe('null\n<logs>\nfirst\nsecond\n</logs>')
    expect(state.callWidgetOp.mock.calls[0][2]).toEqual({})
    expect(state.assertWidgetAccess.mock.calls[0][3].signal).toBe(controller.signal)
  })

  it('WT4-TL-13 门拒绝：拒绝的话原样交给模型，不调操作', async () => {
    state.assertWidgetAccess.mockRejectedValue(
      new Error('User denied changing data in widget "Reading list" (reading-list)')
    )
    const inv = await run(new WidgetTool(ctx), {
      action: 'call',
      widget: 'reading-list',
      op: 'addBook',
      args: { title: 'x' }
    })
    expect(errorOf(inv)).toBe('User denied changing data in widget "Reading list" (reading-list)')
    expect(state.callWidgetOp).not.toHaveBeenCalled()
  })

  it('WT4-TL-13 门挂着时取消：门放行之后也不调操作，以取消收场', async () => {
    const controller = new AbortController()
    state.assertWidgetAccess.mockImplementation(async () => {
      controller.abort()
    })
    await expect(
      run(
        new WidgetTool(ctx),
        { action: 'call', widget: 'reading-list', op: 'addBook' },
        { signal: controller.signal }
      )
    ).rejects.toThrow('Aborted')
    expect(state.assertWidgetAccess).toHaveBeenCalledTimes(1)
    expect(state.callWidgetOp).not.toHaveBeenCalled()
  })

  it('WT4-TL-13 一开始就取消了：什么都不查', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      run(
        new WidgetTool(ctx),
        { action: 'call', widget: 'reading-list', op: 'addBook' },
        { signal: controller.signal }
      )
    ).rejects.toThrow('Aborted')
    expect(state.getById).not.toHaveBeenCalled()
    expect(state.readApiSnapshot).not.toHaveBeenCalled()
    expectNothingTouched()
  })

  it('WT4-TL-14 参数错误从不弹卡片：缺 op / 没有这个操作（只列给 agent 的）/ 没有组件 / 没有 API', async () => {
    const tool = new WidgetTool(ctx)
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ widget: 'reading-list' }, '`op` is required: the operation to call (see "describe").'],
      [
        { widget: 'reading-list', op: '  ' },
        '`op` is required: the operation to call (see "describe").'
      ],
      [
        { widget: 'reading-list', op: 'nope' },
        'Widget "reading-list" has no operation "nope". Its operations: listBooks, addBook.'
      ],
      [
        { widget: 'no-such', op: 'listBooks' },
        'There is no widget "no-such". Call "list" to see the widgets.'
      ],
      [
        { widget: 'photo-wall', op: 'listBooks' },
        'Widget "photo-wall" has no API, so it has no operations to call.'
      ]
    ]
    for (const [args, message] of cases) {
      expect(errorOf(await run(tool, { action: 'call', ...args }))).toBe(message)
    }
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
    expect(state.callWidgetOp).not.toHaveBeenCalled()
  })

  it('WT4-TL-15 纯界面操作：不带 dry_run 连造组件的调用方也够不着（不过门）', async () => {
    const inv = await run(
      new WidgetTool(ctx),
      { action: 'call', widget: 'reading-list', op: 'saveLayout' },
      { caller: 'build' }
    )
    expect(errorOf(inv)).toBe(
      'Widget "reading-list" has no operation "saveLayout". Its operations: listBooks, addBook.'
    )
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
  })

  it('WT4-TL-15 dry_run：纯界面操作够得着，按它自己的读写过门；dryRun + allowUiOnly；结果末尾说明回滚了', async () => {
    opReturns({ ok: true, value: { saved: true } })
    const inv = await run(
      new WidgetTool(ctx),
      { action: 'call', widget: 'reading-list', op: 'saveLayout', args: { a: 1 }, dry_run: true },
      { caller: 'build' }
    )
    const text = textOf(inv)
    expect(text).toBe(
      `${JSON.stringify({ saved: true }, null, 2)}\n(dry run: everything it wrote was rolled back)`
    )
    expect(state.assertWidgetAccess.mock.calls[0][1]).toBe('write')
    expect(state.assertWidgetAccess.mock.calls[0][2]).toEqual({
      widgetId: 'reading-list',
      name: 'Reading list',
      operation: 'saveLayout'
    })
    expect(state.callWidgetOp.mock.calls[0][4]).toEqual({
      dryRun: true,
      allowUiOnly: true,
      expectedMode: 'write'
    })
  })

  it('WT4-TL-15 dry_run 下认不得的操作：列出的名字含纯界面的', async () => {
    const inv = await run(
      new WidgetTool(ctx),
      { action: 'call', widget: 'reading-list', op: 'nope', dry_run: true },
      { caller: 'build' }
    )
    expect(errorOf(inv)).toBe(
      'Widget "reading-list" has no operation "nope". Its operations: listBooks, addBook, saveLayout.'
    )
  })

  it('WT4-TL-16 invalid_args：附上这个操作的 input schema', async () => {
    opReturns({ ok: false, error: { code: 'invalid_args', message: 'title: Required' } })
    const inv = await run(new WidgetTool(ctx), {
      action: 'call',
      widget: 'reading-list',
      op: 'addBook',
      args: {}
    })
    expect(errorOf(inv)).toBe(
      `[invalid_args] title: Required\nInput schema: ${JSON.stringify(ADD_BOOK.input)}`
    )
  })

  it('WT4-TL-16 ctx.fail 的业务失败：[code] message，不附 schema', async () => {
    opReturns({ ok: false, error: { code: 'not_found', message: 'No such book' } })
    const inv = await run(new WidgetTool(ctx), {
      action: 'call',
      widget: 'reading-list',
      op: 'addBook'
    })
    expect(errorOf(inv)).toBe('[not_found] No such book')
  })

  it('WT4-TL-16 handler 意外抛错（internal）：说清楚是组件的代码出了错', async () => {
    opReturns({ ok: false, error: { code: 'internal', message: 'TypeError: x is undefined' } })
    const inv = await run(new WidgetTool(ctx), {
      action: 'call',
      widget: 'reading-list',
      op: 'listBooks'
    })
    expect(errorOf(inv)).toBe('Widget operation failed: TypeError: x is undefined')
  })

  it('WT4-TL-16 失败也附上 dry run 的说明与日志', async () => {
    opReturns({ ok: false, error: { code: 'not_found', message: 'No such book' } }, ['l1', 'l2'])
    const inv = await run(
      new WidgetTool(ctx),
      { action: 'call', widget: 'reading-list', op: 'addBook', dry_run: true },
      { caller: 'build' }
    )
    expect(errorOf(inv)).toBe(
      '[not_found] No such book\n(dry run: everything it wrote was rolled back)\n<logs>\nl1\nl2\n</logs>'
    )
  })

  it('WT4-TL-16 分发器抛 WidgetApiError（含其间被重新构建的 changed）→ [code] message；别的错误原样', async () => {
    const tool = new WidgetTool(ctx)
    state.callWidgetOp.mockRejectedValueOnce(
      new errors.WidgetApiError('timeout', 'The operation took too long.')
    )
    expect(
      errorOf(await run(tool, { action: 'call', widget: 'reading-list', op: 'listBooks' }))
    ).toBe('[timeout] The operation took too long.')

    state.callWidgetOp.mockRejectedValueOnce(
      new errors.WidgetApiError(
        'changed',
        'Operation "listBooks" of widget "reading-list" is now a write operation (the widget was rebuilt). Look at it again before calling it.'
      )
    )
    expect(
      errorOf(await run(tool, { action: 'call', widget: 'reading-list', op: 'listBooks' }))
    ).toBe(
      '[changed] Operation "listBooks" of widget "reading-list" is now a write operation (the widget was rebuilt). Look at it again before calling it.'
    )

    state.callWidgetOp.mockRejectedValueOnce(new Error('host process exited'))
    expect(
      errorOf(await run(tool, { action: 'call', widget: 'reading-list', op: 'listBooks' }))
    ).toBe('host process exited')
  })
})

// ─── create ──────────────────────────────────────────────────────────────

describe('WT4-TL-17..18 create', () => {
  it('WT4-TL-17 不问：init（id 去空白、空模板）之后授予本会话读写（来源 widget）；结果列出目录、文件与首次构建', async () => {
    state.init.mockResolvedValue({
      id: 'my-widget',
      projectDir: '/home/u/.shuvix/widgets/my-widget',
      url: 'http://127.0.0.1:1/w/my-widget/',
      buildSuccess: true,
      files: ['index.html', 'src/App.tsx']
    })
    const inv = await run(
      new WidgetTool(ctx),
      { action: 'create', widget: ' my-widget ', name: '  Books ' },
      { caller: 'build' }
    )
    expect(textOf(inv)).toBe(
      [
        'Created widget "my-widget" in /home/u/.shuvix/widgets/my-widget.',
        'Files: index.html, src/App.tsx',
        'First build: OK.'
      ].join('\n')
    )
    expect(inv.result.details).toEqual({ action: 'create', widget: 'my-widget' })
    expect(state.init).toHaveBeenCalledWith({
      id: 'my-widget',
      name: 'Books',
      description: '',
      template: 'blank'
    })
    expect(state.grantWidget).toHaveBeenCalledWith('s1', 'my-widget', 'write', 'widget')
    expect(state.init.mock.invocationCallOrder[0]).toBeLessThan(
      state.grantWidget.mock.invocationCallOrder[0]
    )
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
  })

  it('WT4-TL-17 首次构建失败：列出错误，但不是失败的结果（组件已经造好、已授予）', async () => {
    state.init.mockResolvedValue({
      id: 'my-widget',
      projectDir: '/d/my-widget',
      url: '',
      buildSuccess: false,
      buildErrors: ['src/App.tsx: unexpected token', 'api.ts: missing export'],
      files: ['index.html']
    })
    const inv = await run(
      new WidgetTool(ctx),
      { action: 'create', widget: 'my-widget', name: 'Books', description: '  For books. ' },
      { caller: 'build' }
    )
    expect(textOf(inv)).toBe(
      [
        'Created widget "my-widget" in /d/my-widget.',
        'Files: index.html',
        'First build failed:',
        '- src/App.tsx: unexpected token',
        '- api.ts: missing export'
      ].join('\n')
    )
    expect(state.init.mock.calls[0][0].description).toBe('For books.')
    expect(state.grantWidget).toHaveBeenCalledTimes(1)
  })

  it('WT4-TL-18 缺 widget / 缺 name：init 之前就报错', async () => {
    const tool = new WidgetTool(ctx)
    expect(errorOf(await run(tool, { action: 'create', name: 'Books' }, { caller: 'build' }))).toBe(
      "`widget` is required: the new widget's id (kebab-case with a dash)."
    )
    expect(
      errorOf(
        await run(tool, { action: 'create', widget: 'my-widget', name: ' ' }, { caller: 'build' })
      )
    ).toBe('`name` is required for "create".')
    expect(state.init).not.toHaveBeenCalled()
    expect(state.grantWidget).not.toHaveBeenCalled()
  })

  it('WT4-TL-18 init 失败（重名 / id 不合法）：错误原样，不授予', async () => {
    const tool = new WidgetTool(ctx)
    for (const message of [
      'Widget "my-widget" already exists.',
      'Invalid widget id "bad" (kebab-case with at least one dash).'
    ]) {
      state.init.mockRejectedValueOnce(new Error(message))
      const inv = await run(
        tool,
        { action: 'create', widget: 'my-widget', name: 'Books' },
        { caller: 'build' }
      )
      expect(errorOf(inv)).toBe(message)
    }
    expect(state.grantWidget).not.toHaveBeenCalled()
  })
})

// ─── build ───────────────────────────────────────────────────────────────

describe('WT4-TL-19 build', () => {
  const build = (args: Record<string, unknown> = {}): Promise<ToolInvocation> =>
    run(
      new WidgetTool(ctx),
      { action: 'build', widget: 'reading-list', ...args },
      { caller: 'build' }
    )

  it('门：读写，客体操作名与工具维度都是 build；拒绝 → 不构建', async () => {
    state.assertWidgetAccess.mockRejectedValue(new Error('denied'))
    expect(errorOf(await build())).toBe('denied')
    const [, access, object, opts] = state.assertWidgetAccess.mock.calls[0]
    expect(access).toBe('write')
    expect(object).toEqual({ widgetId: 'reading-list', name: 'Reading list', operation: 'build' })
    expect(opts).toMatchObject({ toolName: 'widget', operation: 'build' })
    expect(state.build).not.toHaveBeenCalled()
  })

  it('成功：有提交说提交；操作列表（纯界面的标出来）；每条提醒一行；message 去空白、空白不传', async () => {
    state.build.mockResolvedValue({
      id: 'reading-list',
      url: '',
      buildSuccess: true,
      commit: 'abc1234',
      api: [
        { op: 'a', mode: 'read', agent: true },
        { op: 'b', mode: 'write', agent: false }
      ],
      warnings: ['Operation "c" disappeared.', 'Operation "a" changed its input.']
    })
    const inv = await build({ message: ' fix ' })
    expect(textOf(inv)).toBe(
      [
        'Built "reading-list". Committed abc1234.',
        'Operations: a (read), b (write, screen only)',
        'Warning: Operation "c" disappeared.',
        'Warning: Operation "a" changed its input.'
      ].join('\n')
    )
    expect(state.build).toHaveBeenCalledWith('reading-list', { message: 'fix' })

    state.build.mockResolvedValue({ id: 'reading-list', url: '', buildSuccess: true })
    const plain = await build({ message: '   ' })
    expect(textOf(plain)).toBe('Built "reading-list".')
    expect(state.build).toHaveBeenLastCalledWith('reading-list', {})
  })

  it('构建失败：交回（不是抛出）一个 isError 结果，带 details 与每条错误', async () => {
    state.build.mockResolvedValue({
      id: 'reading-list',
      url: '',
      buildSuccess: false,
      buildErrors: ['src/App.tsx(3): x', 'api.ts: y']
    })
    const inv = await build()
    expect(inv.result.isError).toBe(true)
    expect(resultText(inv.result)).toBe(
      'The build of "reading-list" failed:\n- src/App.tsx(3): x\n- api.ts: y'
    )
    // 交回的结果才带 details（抛错收成的失败没有）
    expect(inv.result.details).toEqual({ action: 'build', widget: 'reading-list' })
  })
})

// ─── preview ─────────────────────────────────────────────────────────────

describe('WT4-TL-20..21 preview', () => {
  const preview = (args: Record<string, unknown> = {}): Promise<ToolInvocation> =>
    run(
      new WidgetTool(ctx),
      { action: 'preview', widget: 'reading-list', ...args },
      { caller: 'build' }
    )

  it('WT4-TL-20 认不得的尺寸 / 主题：门之前就报错（不弹卡片）', async () => {
    expect(errorOf(await preview({ sizes: ['huge'] }))).toBe(
      'unknown size "huge" (use panel, window, phone)'
    )
    expect(errorOf(await preview({ theme: 'blue' }))).toBe(
      'unknown theme "blue" (use light or dark)'
    )
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
    expect(state.previewWidget).not.toHaveBeenCalled()
  })

  it('WT4-TL-20 门：读，操作名 preview；拒绝 → 不截图', async () => {
    state.assertWidgetAccess.mockRejectedValue(new Error('denied'))
    expect(errorOf(await preview())).toBe('denied')
    const [, access, object, opts] = state.assertWidgetAccess.mock.calls[0]
    expect(access).toBe('read')
    expect(object).toEqual({ widgetId: 'reading-list', name: 'Reading list', operation: 'preview' })
    expect(opts).toMatchObject({ toolName: 'widget', operation: 'preview' })
    expect(state.previewWidget).not.toHaveBeenCalled()
  })

  it('WT4-TL-20 成功：按解析后的尺寸、主题与本会话截；没给主题就没有 theme 键', async () => {
    state.previewWidget.mockResolvedValue({
      id: 'reading-list',
      theme: 'dark',
      images: [],
      errors: []
    })
    await preview({ sizes: ['phone', 'Panel'], theme: 'Dark' })
    expect(state.previewWidget).toHaveBeenLastCalledWith('reading-list', {
      sizes: ['panel', 'phone'],
      theme: 'dark',
      sessionId: 's1'
    })
    await preview()
    expect(state.previewWidget.mock.calls[1][1]).toStrictEqual({
      sizes: ['panel', 'window', 'phone'],
      sessionId: 's1'
    })
  })

  it('WT4-TL-21 结果：每张图一行说明 + PNG（base64）；页面错误收进一个 <errors>；details', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const pathA = join(tmp, 'a.png')
    const pathB = join(tmp, 'b.png')
    writeFileSync(pathA, png)
    writeFileSync(pathB, Buffer.from([9, 8, 7]))
    state.previewWidget.mockResolvedValue({
      id: 'reading-list',
      theme: 'dark',
      images: [
        { size: 'panel', width: 380, height: 760, path: pathA },
        { size: 'phone', width: 390, height: 780, path: pathB }
      ],
      errors: ['TypeError: a', 'ReferenceError: b']
    })
    const inv = await preview()
    expect(inv.result.isError).not.toBe(true)
    expect(inv.result.content).toEqual([
      { type: 'text', text: 'panel (380×760, dark theme):' },
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: 'phone (390×780, dark theme):' },
      { type: 'image', data: Buffer.from([9, 8, 7]).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: '<errors>\nTypeError: a\nReferenceError: b\n</errors>' }
    ])
    expect(inv.result.details).toEqual({ action: 'preview', widget: 'reading-list' })
  })

  it('WT4-TL-21 没有图也没有错误 → Nothing was captured.；只有错误 → 只有 <errors>', async () => {
    state.previewWidget.mockResolvedValue({
      id: 'reading-list',
      theme: 'app',
      images: [],
      errors: []
    })
    expect((await preview()).result.content).toEqual([
      { type: 'text', text: 'Nothing was captured.' }
    ])
    state.previewWidget.mockResolvedValue({
      id: 'reading-list',
      theme: 'app',
      images: [],
      errors: ['Widget "reading-list" failed to build.']
    })
    expect((await preview()).result.content).toEqual([
      { type: 'text', text: '<errors>\nWidget "reading-list" failed to build.\n</errors>' }
    ])
  })
})

// ─── sql ─────────────────────────────────────────────────────────────────

describe('WT4-TL-22 sql', () => {
  const sql = (args: Record<string, unknown>): Promise<ToolInvocation> =>
    run(
      new WidgetTool(ctx),
      { action: 'sql', widget: 'reading-list', ...args },
      { caller: 'build' }
    )

  it('空的 sql：门之前就报错', async () => {
    expect(errorOf(await sql({}))).toBe('`sql` is required for "sql".')
    expect(errorOf(await sql({ sql: '  \n ' }))).toBe('`sql` is required for "sql".')
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
  })

  it('门：读写，操作名 sql；拒绝 → 不查', async () => {
    state.assertWidgetAccess.mockRejectedValue(new Error('denied'))
    expect(errorOf(await sql({ sql: 'select 1' }))).toBe('denied')
    const [, access, object, opts] = state.assertWidgetAccess.mock.calls[0]
    expect(access).toBe('write')
    expect(object).toEqual({ widgetId: 'reading-list', name: 'Reading list', operation: 'sql' })
    expect(opts).toMatchObject({ toolName: 'widget', operation: 'sql' })
    expect(state.dbQuery).not.toHaveBeenCalled()
    expect(state.runWidgetDbQuery).not.toHaveBeenCalled()
  })

  it('缺省查组件自己的库；legacy: true 查共用 PostgreSQL；空输出 → OK；error → 原样抛', async () => {
    state.dbQuery.mockResolvedValue({ output: 'id | title\n1 | Dune' })
    expect(textOf(await sql({ sql: 'select * from books' }))).toBe('id | title\n1 | Dune')
    expect(state.dbQuery).toHaveBeenCalledWith('reading-list', 'select * from books')
    expect(state.runWidgetDbQuery).not.toHaveBeenCalled()

    state.runWidgetDbQuery.mockResolvedValue({ output: '' })
    state.hasLegacyWidgetData.mockReturnValue(true)
    const legacy = await sql({ sql: 'select 1', legacy: true })
    expect(textOf(legacy)).toBe('OK')
    expect(state.runWidgetDbQuery).toHaveBeenCalledWith('reading-list', 'select 1')
    expect(legacy.result.details).toEqual({ action: 'sql', widget: 'reading-list' })

    state.dbQuery.mockResolvedValue({ output: '', error: 'near "selec": syntax error' })
    expect(errorOf(await sql({ sql: 'selec 1' }))).toBe('near "selec": syntax error')
  })
})

describe('WC-S40..S44 sql 的 legacy 与换过存储的组件', () => {
  const sql = (args: Record<string, unknown>): Promise<ToolInvocation> =>
    run(
      new WidgetTool(ctx),
      { action: 'sql', widget: 'reading-list', ...args },
      { caller: 'build' }
    )

  it('WC-S40 legacy: true 但没有旧数据 → 先过写门，再报错；两个库都不查', async () => {
    state.hasLegacyWidgetData.mockReturnValue(false)

    const inv = await sql({ sql: 'select * from books', legacy: true })

    expect(errorOf(inv)).toBe('Widget "reading-list" has no data in the older shared database.')
    expect(state.assertWidgetAccess).toHaveBeenCalledTimes(1)
    expect(state.assertWidgetAccess.mock.calls[0][1]).toBe('write')
    expect(state.hasLegacyWidgetData.mock.calls).toEqual([['reading-list']])
    expect(state.assertWidgetAccess.mock.invocationCallOrder[0]).toBeLessThan(
      state.hasLegacyWidgetData.mock.invocationCallOrder[0]
    )
    expect(state.runWidgetDbQuery).not.toHaveBeenCalled()
    expect(state.dbQuery).not.toHaveBeenCalled()
  })

  it('WC-S41 legacy: true、有旧数据、组件已是 SQLite → 查 PGlite（runWidgetDbQuery），不查自己的库', async () => {
    state.storage.set('reading-list', 'sqlite')
    state.hasLegacyWidgetData.mockReturnValue(true)
    state.runWidgetDbQuery.mockResolvedValue({ output: ' id \n----\n 1\n(1 row)' })

    const inv = await sql({ sql: 'select id from notes', legacy: true })

    expect(textOf(inv)).toBe(' id \n----\n 1\n(1 row)')
    expect(state.runWidgetDbQuery.mock.calls).toEqual([['reading-list', 'select id from notes']])
    expect(state.dbQuery).not.toHaveBeenCalled()
  })

  it.each<[string, Record<string, unknown>, boolean]>([
    ['不带 legacy、有旧数据', {}, true],
    ['不带 legacy、没有旧数据', {}, false],
    ['legacy: false、有旧数据', { legacy: false }, true],
    ['legacy: false、没有旧数据', { legacy: false }, false]
  ])('WC-S42 %s → 组件自己的库（dbQuery）', async (_l, extra, legacyData) => {
    state.hasLegacyWidgetData.mockReturnValue(legacyData)
    state.dbQuery.mockResolvedValue({ output: 'OK (1 row changed)' })

    const inv = await sql({ sql: "insert into books(title) values ('x')", ...extra })

    expect(textOf(inv)).toBe('OK (1 row changed)')
    expect(state.dbQuery.mock.calls).toEqual([
      ['reading-list', "insert into books(title) values ('x')"]
    ])
    expect(state.runWidgetDbQuery).not.toHaveBeenCalled()
  })

  it('WC-S43 门拒绝（legacy: true）→ 不问有没有旧数据', async () => {
    state.assertWidgetAccess.mockRejectedValue(new Error('denied'))

    expect(errorOf(await sql({ sql: 'select 1', legacy: true }))).toBe('denied')
    expect(state.hasLegacyWidgetData).not.toHaveBeenCalled()
    expect(state.runWidgetDbQuery).not.toHaveBeenCalled()
    expect(state.dbQuery).not.toHaveBeenCalled()
  })

  it('WC-S44 造组件的 list 里，换过存储、还有旧数据的组件标 old-data="legacy-postgres"（不是 storage）', async () => {
    state.widgets.clear()
    putWidget('switched', { name: 'Switched', ops: [LIST_BOOKS] })
    state.hasLegacyWidgetData.mockReturnValue(true)

    const text = textOf(await run(new WidgetTool(ctx), { action: 'list' }, { caller: 'build' }))

    expect(text).toContain(
      `<widget id="switched" name="Switched" access="none" old-data="legacy-postgres" dir="${state.dir('switched')}">`
    )
    expect(text).not.toContain('storage="legacy-postgres"')
  })
})

// ─── export ──────────────────────────────────────────────────────────────

describe('WT4-TL-23..24 export', () => {
  const exportCall = (args: Record<string, unknown>): Promise<ToolInvocation> =>
    run(
      new WidgetTool(ctx),
      { action: 'export', widget: 'reading-list', ...args },
      { caller: 'build' }
    )

  beforeEach(() => {
    state.resolveExportZipPath.mockImplementation((id: string, target: string) =>
      target.endsWith('.zip') ? target : `${target}/${id}.zip`
    )
    state.exportWidget.mockImplementation(async ({ targetPath }: { targetPath: string }) => ({
      zipPath: targetPath
    }))
  })

  it('WT4-TL-23 缺 path：任何门之前就报错', async () => {
    expect(errorOf(await exportCall({}))).toBe(
      '`path` is required for "export": a folder or a .zip path.'
    )
    expect(errorOf(await exportCall({ path: '  ' }))).toBe(
      '`path` is required for "export": a folder or a .zip path.'
    )
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
    expect(state.assertWriteAllowed).not.toHaveBeenCalled()
  })

  it('WT4-TL-23 相对路径落在工作目录里；先归一化成最终 zip，组件的读门之后路径的写门判的就是它', async () => {
    const inv = await exportCall({ path: 'out' })
    expect(textOf(inv)).toBe('Exported "reading-list" to /ws/out/reading-list.zip.')
    expect(state.resolveProjectConfig).toHaveBeenCalledWith('s1')
    expect(state.resolveExportZipPath).toHaveBeenCalledWith('reading-list', '/ws/out')

    const [, access, object, opts] = state.assertWidgetAccess.mock.calls[0]
    expect(access).toBe('read')
    expect(object).toEqual({ widgetId: 'reading-list', name: 'Reading list', operation: 'export' })
    expect(opts).toMatchObject({ toolName: 'widget', operation: 'export' })

    expect(state.assertWriteAllowed).toHaveBeenCalledWith(
      ctx,
      { workingDirectory: '/ws' },
      'c1',
      'widget',
      '/ws/out/reading-list.zip',
      undefined,
      { taskId: 7, conversationId: 1 }
    )
    expect(state.exportWidget).toHaveBeenCalledWith({
      id: 'reading-list',
      targetPath: '/ws/out/reading-list.zip'
    })
    const order = [
      state.resolveExportZipPath.mock.invocationCallOrder[0],
      state.assertWidgetAccess.mock.invocationCallOrder[0],
      state.assertWriteAllowed.mock.invocationCallOrder[0],
      state.exportWidget.mock.invocationCallOrder[0]
    ]
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('WT4-TL-23 绝对路径原样；WidgetExportError → [code] message', async () => {
    await exportCall({ path: '/tmp/books.zip' })
    expect(state.resolveExportZipPath).toHaveBeenCalledWith('reading-list', '/tmp/books.zip')
    expect(state.assertWriteAllowed.mock.calls[0][4]).toBe('/tmp/books.zip')

    state.exportWidget.mockRejectedValueOnce(
      new errors.WidgetExportError('target_exists', 'There is already a file at /tmp/books.zip.')
    )
    expect(errorOf(await exportCall({ path: '/tmp/books.zip' }))).toBe(
      '[target_exists] There is already a file at /tmp/books.zip.'
    )
  })

  it('WT4-TL-24 组件的读门拒绝：不问路径、不导出；路径的写门拒绝：不导出', async () => {
    state.assertWidgetAccess.mockRejectedValueOnce(new Error('widget denied'))
    expect(errorOf(await exportCall({ path: 'out' }))).toBe('widget denied')
    expect(state.assertWriteAllowed).not.toHaveBeenCalled()
    expect(state.exportWidget).not.toHaveBeenCalled()

    state.assertWriteAllowed.mockRejectedValueOnce(new Error('path denied'))
    expect(errorOf(await exportCall({ path: 'out' }))).toBe('path denied')
    expect(state.exportWidget).not.toHaveBeenCalled()
  })
})

// ─── open ────────────────────────────────────────────────────────────────

describe('WT4-TL-25 open', () => {
  it('打开它自己的窗口（不经 widgetService.open），不过门', async () => {
    const inv = await run(
      new WidgetTool(ctx),
      { action: 'open', widget: 'reading-list' },
      { caller: 'build' }
    )
    expect(textOf(inv)).toBe('Opened "Reading list" in its own window.')
    expect(inv.result.details).toEqual({ action: 'open', widget: 'reading-list' })
    expect(state.windowOpen).toHaveBeenCalledWith('reading-list')
    expect(state.serviceOpen).not.toHaveBeenCalled()
    expect(state.assertWidgetAccess).not.toHaveBeenCalled()
  })

  it('归档了的：没有这个组件，不开窗口', async () => {
    const inv = await run(
      new WidgetTool(ctx),
      { action: 'open', widget: 'gone-widget' },
      { caller: 'build' }
    )
    expect(errorOf(inv)).toBe('There is no widget "gone-widget". Call "list" to see the widgets.')
    expect(state.windowOpen).not.toHaveBeenCalled()
  })
})

// ─── 调用方身份 ──────────────────────────────────────────────────────────────

describe('WT4-TL-26 派生 agent 调用', () => {
  it('门的主体与分发器的 actor 都是发起调用的那个 agent（按对话认），不是根 agent', async () => {
    const spawned = identity('explore', 'claude-haiku-4-5', 'spawned')
    const agentOf = vi.fn((c: number) => (c === 2 ? spawned : identity('work', 'gpt-5')))
    const sessionCtx: ToolContext = { sessionId: 's1', agentOf, rootSkills: [] }
    await run(
      new WidgetTool(sessionCtx),
      { action: 'call', widget: 'reading-list', op: 'listBooks' },
      { conversationId: 2 }
    )
    const gateCtx = state.assertWidgetAccess.mock.calls[0][0] as ToolContext
    expect(gateCtx.agent).toBe(spawned)
    expect(gateCtx.sessionId).toBe('s1')
    expect(state.assertWidgetAccess.mock.calls[0][3].owner).toEqual({
      taskId: 7,
      conversationId: 2
    })
    expect(state.callWidgetOp.mock.calls[0][3]).toEqual({
      kind: 'agent',
      sessionId: 's1',
      actor: 'shuvix-explore/claude-haiku-4-5',
      label: 'shuvix-explore/claude-haiku-4-5'
    })
    expect(agentOf).toHaveBeenCalledWith(2)
  })
})

// ─── 侧栏开关与锁 ──────────────────────────────────────────────────────────

/**
 * 货架在 agent 创建时定下（`'enabled'`），按锁重建时照锁（`{ known }`）：侧栏的开关只作用于之后新建的 agent。
 * 于是根 agent 的货架（会话级描述）与发起调用的 agent 的货架可以不一样 —— 造的动作按后者核对。
 */
describe('WT4-TL-30..31 调用方的货架是它创建时（或锁里）的那份', () => {
  /** 桌面那两层包装（输出内核 + 门）都是 Object.create：skillNames 经原型链透出（同 TL-04） */
  const wrap = (real: SkillTool): object =>
    Object.create(wrapDurableOutput(real, { spill: false })) as object

  const WIDGET_SKILL_ROW = {
    name: 'builtin:widget',
    description: 'Build widgets.',
    basePath: '/skills/widget'
  }
  const DRAWING_SKILL_ROW = {
    name: 'builtin:drawing',
    description: 'Draw figures.',
    basePath: '/skills/drawing'
  }

  it('WT4-TL-30 根货架有 builtin:widget（描述给全量），派生 agent 创建时 widget 技能已停用：build 照拒；list / describe / call 照用', async () => {
    // 派生 agent 创建时侧栏里只剩作图技能：它的真 SkillTool 货架上没有 widget 技能
    state.findEnabled.mockReturnValue([DRAWING_SKILL_ROW])
    const real = new SkillTool('enabled')
    expect(real.skillNames).toEqual(['builtin:drawing'])
    const caller = [wrap(real)]

    const spawned = identity('explore', 'claude-haiku-4-5', 'spawned')
    const sessionCtx: ToolContext = {
      sessionId: 's1',
      agentOf: (c: number) => (c === 2 ? spawned : identity('work', 'gpt-5')),
      rootSkills: ['builtin:drawing', 'builtin:widget']
    }
    const tool = new WidgetTool(sessionCtx)
    // 会话级描述按根 agent 的货架：造的动作都在
    expect(tool.description).toBe(WIDGET_DESCRIPTION)

    const refused = await run(tool, BUILD_ARGS.build, { caller, conversationId: 2 })
    expect(errorOf(refused)).toBe(refusal('build'))
    expectNothingTouched()

    // 用的那组照常：list 按不造组件的口径（没有目录、没有 API 的不列），describe 不列纯界面操作
    const list = textOf(await run(tool, { action: 'list' }, { caller, conversationId: 2 }))
    expect(list).toContain('<widget id="reading-list" name="Reading list" access="none">')
    expect(list).not.toContain('dir=')
    expect(list).not.toContain('photo-wall')

    const described = JSON.parse(
      textOf(
        await run(
          tool,
          { action: 'describe', widget: 'reading-list' },
          { caller, conversationId: 2 }
        )
      )
    ) as { operations: { name: string }[] }
    expect(described.operations.map((o) => o.name)).toEqual(['listBooks', 'addBook'])

    opReturns({ ok: true, value: [{ title: 'Dune' }] })
    const called = await run(
      tool,
      { action: 'call', widget: 'reading-list', op: 'listBooks' },
      { caller, conversationId: 2 }
    )
    expect(textOf(called)).toBe(JSON.stringify([{ title: 'Dune' }], null, 2))
    expect(state.assertWidgetAccess).toHaveBeenCalledTimes(1)
    expect(state.callWidgetOp).toHaveBeenCalledTimes(1)
    expect(state.callWidgetOp.mock.calls[0][3]).toMatchObject({
      actor: 'shuvix-explore/claude-haiku-4-5'
    })
  })

  it('WT4-TL-31 锁里记着 builtin:widget、它此刻在侧栏里停用了：按锁重建的货架（{ known }）照样有它 → build 放行（锁赢）', async () => {
    // 此刻：启用着的 / 模型可调用的里没有 widget 技能，findAll 仍看得见它（停用 ≠ 删除）
    state.findEnabled.mockReturnValue([DRAWING_SKILL_ROW])
    state.findAll.mockReturnValue([DRAWING_SKILL_ROW, { ...WIDGET_SKILL_ROW, isEnabled: false }])

    const locked = new SkillTool({ known: ['builtin:widget'] })
    expect(locked.skillNames).toEqual(['builtin:widget'])
    // 对照：此刻新建一个 agent 的货架上就没有它了
    expect(new SkillTool('enabled').skillNames).toEqual(['builtin:drawing'])

    state.build.mockResolvedValue({ id: 'reading-list', url: '', buildSuccess: true })
    const inv = await run(new WidgetTool(ctx), BUILD_ARGS.build, { caller: [wrap(locked)] })
    expect(textOf(inv)).toBe('Built "reading-list".')
    expect(state.assertWidgetAccess).toHaveBeenCalledTimes(1)
    expect(state.assertWidgetAccess.mock.calls[0][1]).toBe('write')
    expect(state.build).toHaveBeenCalledWith('reading-list', {})
  })
})

// ─── 注册 ────────────────────────────────────────────────────────────────

describe('WT4-TL-29 注册元数据', () => {
  it('设置页看到全量描述与全量 schema（与会话无关）；工厂造的是 WidgetTool；标签 / 提示 / 呈现', () => {
    const meta = state.registered.find((m) => m.name === 'widget')
    expect(meta).toBeDefined()
    const described = (meta!.describe as () => { description: string; parameters: unknown })()
    expect(described.description).toBe(WIDGET_DESCRIPTION)
    expect(described.parameters).toBe(WidgetParamsSchema)
    expect(meta!.group).toBe('general')
    expect((meta!.getLabel as () => string)()).toBe('tool.widgetLabel')
    expect((meta!.getHint as () => string)()).toBe('tool.widgetHint')
    expect(meta!.presentation).toBe(BUILTIN_TOOL_PRESENTATIONS.widget.presentation)
    const made = (meta!.factory as (c: ToolContext) => unknown)({ sessionId: 's1' })
    expect(made).toBeInstanceOf(WidgetTool)
    expect((made as WidgetTool).label).toBe('tool.widgetLabel')
  })
})
