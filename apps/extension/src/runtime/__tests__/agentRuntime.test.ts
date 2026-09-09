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
  createAgent: vi.fn()
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
vi.mock('../eventBus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('../agentHost', () => ({ extensionAgentFactory: { createAgent: mocks.createAgent } }))
vi.mock('../subAgent', () => ({
  clearSessionTools: vi.fn(),
  extensionSubAgentRegistry: { getProfile: mocks.getProfile, listAll: () => [] },
  subAgentManager: { destroyAll: vi.fn() }
}))

import { ensureRuntimeSession } from '../agentRuntime'

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
    updatedAt: 0
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
