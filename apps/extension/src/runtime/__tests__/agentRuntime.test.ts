/**
 * 扩展端根会话运行时的**档案形态推导**（agentRuntime.buildRuntimeSession，经 ensureRuntimeSession 触达）
 * —— 与桌面 sessionService.resolveAgentProfileName 同口径：笔记本会话 notebook、归属项目
 * （FSA 文件夹）的会话 work、不归属项目（OPFS 隔离目录）的会话 chat。
 *
 * 扩展端没有子会话，所以 `settings.agentProfile` 在这一端**从不被写、也从不被读**：一条带着
 * 旧切换时代残留戳（`coding` / 旧基座名 `default`）的会话照样按形态推导，注册表只被以推导出的
 * 名字查一次。这是本文件真正在守的东西 —— 谁把「先看戳」加回来，EXT-4 会红。
 *
 * mock 纪律同 instructionFilesRuntime.test.ts：`agentRuntime.ts` 的 import 图带 IndexedDB /
 * chrome.* / OPFS（storage/* 与 agentHost / subAgent / titleRuntime / eventBus），在 node
 * 环境下起不来，全部顶掉；`@shuvix/agent-runtime` 用真件（SessionManager /
 * resolveInitialThinkingLevel / toInProcessAgentType 都是纯逻辑）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getHandle: vi.fn(),
  getProfile: vi.fn(),
  createAgent: vi.fn(),
  // 事件总线的出口：运行时区间事件（agent_created / agent_closing）经它送到 chat-ui
  emit: vi.fn()
}))

vi.mock('../../storage/sessionStore', () => ({
  sessionStore: { getById: mocks.getById }
}))
vi.mock('../../storage/settingsStore', () => ({
  settingsStore: {
    loadState: async () => {},
    getDefaultSelection: () => ({ provider: 'fake-provider', model: 'fake-model' })
  }
}))
vi.mock('../../storage/projectStore', () => ({
  projectStore: { loadState: async () => {}, getHandle: mocks.getHandle }
}))
vi.mock('../../storage/sessionEntryStore', () => ({
  readSessionRunConfig: async () => ({}),
  addSessionTreePin: vi.fn(),
  appendModelChange: vi.fn()
}))
vi.mock('../resolveSessionModel', () => ({ capsFor: () => ({}) }))
vi.mock('../titleRuntime', () => ({ titlerFor: () => ({ quick: () => {} }) }))
vi.mock('../eventBus', () => ({ eventBus: { emit: mocks.emit } }))
vi.mock('../agentHost', () => ({ extensionAgentFactory: { createAgent: mocks.createAgent } }))
vi.mock('../subAgent', () => ({
  clearSessionTools: vi.fn(),
  extensionSubAgentRegistry: { getProfile: mocks.getProfile, listAll: () => [] },
  subAgentManager: { destroyAll: vi.fn() }
}))

import { ensureRuntimeSession, removeRuntimeSession } from '../agentRuntime'
import { requestUserInputFor, setSessionInputChannel } from '../userInputBroker'

/** 注册表按名回一份最小档案（只有名字有信息量：断言看的是 createAgent 收到的 profile.name） */
const minimalProfile = (name: string): AgentProfile => ({
  name,
  displayName: name,
  description: `unit ${name}`,
  systemPrompt: name,
  tools: [],
  instructionFiles: [],
  projectAwareness: false,
  source: 'builtin',
  basePath: ''
})

let seq = 0
let SID = ''

beforeEach(() => {
  seq += 1
  SID = `ext-sess-${seq}`
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.getProfile.mockImplementation((name: string) => minimalProfile(name))
  mocks.getHandle.mockReturnValue(undefined)
  mocks.createAgent.mockImplementation(async (params: { profile: { name: string } }) => ({
    runtime: { abort: async () => {} },
    profile: params.profile,
    systemPrompt: '',
    dispose: () => {}
  }))
})

/** 让被测会话呈现某种形态（扩展会话行：projectId + settings） */
function session(shape: {
  projectId?: string | null
  settings?: Record<string, unknown>
  folder?: string
}): void {
  mocks.getById.mockResolvedValue({
    id: SID,
    title: 'T',
    projectId: shape.projectId ?? null,
    parentId: null,
    settings: shape.settings ?? {},
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0
  })
  if (shape.folder) mocks.getHandle.mockReturnValue({ name: shape.folder })
}

/** createAgent 唯一那次调用的入参 */
const createdWith = (): {
  kind: string
  sessionId: string
  profile: { name: string }
  cwd: string
} => {
  expect(mocks.createAgent).toHaveBeenCalledTimes(1)
  return mocks.createAgent.mock.calls[0][0]
}

describe('buildRuntimeSession —— 档案由会话形态推导', () => {
  it("EXT-1 笔记本会话（notebookPath 非空，且有项目）→ profile.name 为 'notebook'", async () => {
    session({ projectId: 'proj-1', settings: { notebookPath: 'notes/a.md' }, folder: 'Folder' })
    await ensureRuntimeSession(SID)
    expect(createdWith().profile.name).toBe('notebook')
  })

  it("EXT-2 归属项目 → 'work'，cwd 是项目句柄的文件夹名", async () => {
    session({ projectId: 'proj-1', folder: 'MyFolder' })
    await ensureRuntimeSession(SID)
    const params = createdWith()
    expect(params.profile.name).toBe('work')
    expect(params.cwd).toBe('MyFolder')
  })

  it.each([
    ['null', null],
    ['undefined', undefined]
  ])("EXT-3 projectId 为 %s → 'chat'，cwd 是 'scratch'", async (_l, projectId) => {
    session({ projectId })
    await ensureRuntimeSession(SID)
    const params = createdWith()
    expect(params.profile.name).toBe('chat')
    expect(params.cwd).toBe('scratch')
  })

  it.each([
    ['笔记本', { projectId: 'proj-1', notebookPath: 'n.md' }, 'notebook'],
    ['项目', { projectId: 'proj-1' }, 'work'],
    ['无项目', { projectId: null }, 'chat']
  ] as const)(
    'EXT-4 %s会话带残留戳（coding / 旧基座名 default）：结果不变，注册表只被以推导名查过',
    async (_l, shape, expected) => {
      for (const stamped of ['coding', 'default']) {
        seq += 1
        SID = `ext-sess-${seq}-${stamped}`
        mocks.createAgent.mockClear()
        mocks.getProfile.mockClear()
        session({
          projectId: shape.projectId,
          settings: {
            ...('notebookPath' in shape ? { notebookPath: shape.notebookPath } : {}),
            agentProfile: stamped
          },
          folder: 'Folder'
        })
        await ensureRuntimeSession(SID)
        expect(createdWith().profile.name, stamped).toBe(expected)
        // 扩展端「从不读它」：getProfile 只被以推导名调用，从未以戳调用
        expect(
          mocks.getProfile.mock.calls.map((c) => c[0]),
          stamped
        ).toEqual([expected])
      }
    }
  )

  it("EXT-5 createAgent 收到 kind 'root' 与正确的 sessionId", async () => {
    session({ projectId: 'proj-1', folder: 'Folder' })
    await ensureRuntimeSession(SID)
    const params = createdWith()
    expect(params.kind).toBe('root')
    expect(params.sessionId).toBe(SID)
  })
})

describe('运行时区间事件（与桌面同一对事件，chat-ui 的扩展能力只读态据此切换）', () => {
  /** eventBus 收到的本会话运行时生命周期事件（按到达顺序） */
  const lifecycle = (): Array<{ type: string; sessionId: string; closing?: boolean }> =>
    mocks.emit.mock.calls
      .map((c) => c[0] as { type: string; sessionId: string; closing?: boolean })
      .filter(
        (e) => e.sessionId === SID && (e.type === 'agent_created' || e.type === 'agent_closing')
      )

  it('EXT-U-17 ensure → remove：依次发 agent_created（恰一次）、agent_closing true、agent_closing false', async () => {
    // 扩展端自己没有会话级扩展能力，但只读态机制在 chat-ui 里两端共用：这一端漏发
    // agent_created，同一份前端代码就会一直以为「没有运行时」
    session({ projectId: 'proj-1', folder: 'Folder' })
    await ensureRuntimeSession(SID)
    await ensureRuntimeSession(SID)
    await removeRuntimeSession(SID)
    expect(lifecycle()).toEqual([
      { type: 'agent_created', sessionId: SID },
      { type: 'agent_closing', sessionId: SID, closing: true },
      { type: 'agent_closing', sessionId: SID, closing: false }
    ])
  })
})

/**
 * 询问通道的寿命跟着运行时走：装配工具那一刻（agentHost.resolveTools，这里由 createAgent 替身代为登记）
 * 登记进 userInputBroker，运行时销毁时注销 —— 此后内置 browser 的安全门按「没人能答」fail-closed，
 * 而不是把询问送进一个已经不在的运行时。注销只动这一条会话。
 */
describe('运行时销毁时注销本会话的询问通道', () => {
  const req = {
    id: 'tc-1',
    kind: 'ask' as const,
    toolName: 'mcp__browser__open_tab',
    command: 'https://a.example/',
    createdAt: 0
  }

  it('EXT-U-18 ensure → remove：本会话的通道没了（NO_INTERACTIVE_INPUT），别的会话的通道照旧', async () => {
    const OTHER = `${SID}-other`
    const mine = vi.fn(async () => ({ kind: 'ask' as const, allowed: true }))
    const other = vi.fn(async () => ({ kind: 'ask' as const, allowed: false }))
    mocks.createAgent.mockImplementation(
      async (params: { sessionId: string; profile: { name: string } }) => {
        setSessionInputChannel(params.sessionId, mine)
        return {
          runtime: { abort: async () => {} },
          profile: params.profile,
          systemPrompt: '',
          dispose: () => {}
        }
      }
    )
    setSessionInputChannel(OTHER, other)
    session({ projectId: 'proj-1', folder: 'Folder' })

    await ensureRuntimeSession(SID)
    // 运行时活着时通道可用
    await expect(requestUserInputFor(SID, req)).resolves.toEqual({ kind: 'ask', allowed: true })
    expect(mine).toHaveBeenCalledTimes(1)

    await removeRuntimeSession(SID)
    await expect(requestUserInputFor(SID, req)).rejects.toThrow('NO_INTERACTIVE_INPUT')
    expect(mine).toHaveBeenCalledTimes(1)
    await expect(requestUserInputFor(OTHER, req)).resolves.toEqual({ kind: 'ask', allowed: false })
  })
})
