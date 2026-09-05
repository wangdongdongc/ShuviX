/**
 * sessionService —— 新会话默认档案的**创建时解析**（`settings.agentProfile` 那个戳）。
 *
 * 三条纪律：
 *  1. 戳在 `create` 那一刻落成**显式值**，而不是留空、等 resolveAgentProfileName 再算 ——
 *     档案是粘性的，之后改设置只影响更新的会话，一条在跑的会话不该因为改了个全局默认
 *     就换人格。写不写这个键是整条改动的支点：不写的话 resolveAgentProfileName 的
 *     「无戳 ⇒ default」分支会把所有无项目会话静默拉回 default 人格，无报错也无日志。
 *  2. 读哪个设置项由**会话形态**决定：有项目 → `general.defaultProjectAgent`（缺省
 *     `default`），无项目 → `general.defaultChatAgent`（缺省 `chat`）。两个 key 一字之差，
 *     写反了在默认配置下完全无症状 —— 两边都没设时都回落基座，全套测试照绿。
 *  3. 设置指向的档案不可用（被删掉，或它根本不能当会话档案）→ 回落**对应基座**。这里与
 *     resolveAgentProfileName 的「恒回落 default」是**刻意的不对称**（那边在读一条已存在
 *     的会话，无戳 = 改动之前建的；这边在决定一条新会话从哪条路线起步，形态是已知的），
 *     把两处「统一成一个 helper」是最典型的顺手优化。
 *
 * mock 面沿用 sessionServiceSubSession.test.ts（import 图全换假件 + `sessionDao.insert`
 * 捕获），在其上把 `settingsDao.findByKey` 与 agentService 的两个谓词做成可控件。
 * `isSessionProfile` 在假件里用**真名单常量**复算：真 agentService 要 electron + 用户
 * 目录，本文件够不到；取真常量则 SWITCHABLE_BASE_PROFILE_NAMES 变了这里跟着变。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import {
  BASE_PROFILE_NAMES,
  SWITCHABLE_BASE_PROFILE_NAMES,
  type AgentProfile
} from '@shuvix/agent-runtime'
import {
  DEFAULT_CHAT_AGENT_KEY,
  DEFAULT_PROJECT_AGENT_KEY
} from '@shuvix/chat-protocol/agentProfile'

const mocks = vi.hoisted(() => ({
  daoInsert: vi.fn(),
  daoPick: vi.fn<(id: string, cols: string[]) => unknown>(),
  daoPickSettings: vi.fn<(id: string, cols: string[]) => unknown>(),
  findByKey: vi.fn<(key: string) => string | undefined>(),
  getProfile: vi.fn<(name: string) => unknown>()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    insert: mocks.daoInsert,
    pick: mocks.daoPick,
    pickSettings: mocks.daoPickSettings,
    deleteById: vi.fn(),
    findChildren: vi.fn(() => []),
    updateProjectId: vi.fn(),
    updateTitle: vi.fn(),
    updateSettings: vi.fn()
  }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: vi.fn() } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/projectDao', () => ({ projectDao: {} }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: mocks.findByKey } }))
vi.mock('../messageService', () => ({ messageService: { clear: vi.fn() } }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: vi.fn(),
  addSessionTreePin: vi.fn(),
  appendModelChange: vi.fn(),
  appendActiveToolsChange: vi.fn()
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: vi.fn(() => '/nonexistent/e2e-tmp'),
  getToolResultsBase: vi.fn(() => '/nonexistent/e2e-results')
}))
vi.mock('../toolAggregator', () => ({
  getDefaultEnabledTools: vi.fn(() => []),
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../botService', () => ({
  botService: {
    abortSession: vi.fn(async () => {}),
    forgetNotesSession: vi.fn(),
    seedGreetings: vi.fn(async () => {}),
    isActive: vi.fn(() => false)
  }
}))
vi.mock('../agentService', () => ({
  agentService: {
    getProfile: mocks.getProfile,
    // 与 agentService.isSessionProfile 同一条表达式（名单常量取真件）—— 创建入口与
    // `/<agentName>` 切换入口必须同口径，假件退化成「恒 true」会让第 14 条失去意义
    isSessionProfile: (p: AgentProfile) =>
      SWITCHABLE_BASE_PROFILE_NAMES.has(p.name) ||
      (!BASE_PROFILE_NAMES.has(p.name) && p.sessionAwareness)
  }
}))
vi.mock('../agentSession', () => ({ AgentSession: class {} }))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: vi.fn(),
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

let sessionService: typeof import('../sessionService').sessionService

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.daoPick.mockReturnValue(undefined)
  mocks.daoPickSettings.mockReturnValue(undefined)
  mocks.findByKey.mockReturnValue(undefined)
  mocks.getProfile.mockReturnValue(undefined)
})

/** 最近一次落库的 settings（戳就在这里） */
const insertedSettings = (): Record<string, unknown> =>
  (mocks.daoInsert.mock.calls.at(-1)![0] as { settings: Record<string, unknown> }).settings

/** 一份能当会话档案的用户档案（声明了会话感知） */
const sessionAware = (name: string): Partial<AgentProfile> => ({ name, sessionAwareness: true })

describe('create —— 默认档案在创建那一刻定型', () => {
  it('两个设置项都没设：有项目戳 default、无项目戳 chat，且是**写进去的显式值**', () => {
    sessionService.create({ projectId: 'p1' })
    // toBe 而不是 toMatchObject：缺省的 undefined 也能过 toMatchObject 的宽松比较，
    // 而「键在不在」正是这条改动的支点
    expect(insertedSettings().agentProfile).toBe('default')

    sessionService.create({})
    expect(insertedSettings().agentProfile).toBe('chat')
  })

  it('戳落下之后 resolveAgentProfileName 原样回吐它（创建与解析对得上）', () => {
    sessionService.create({})
    const stamped = insertedSettings().agentProfile
    expect(stamped).toBe('chat')

    // 解析侧只读这个戳（非 default 的名字会查一次档案是否还在）
    mocks.daoPickSettings.mockReturnValue({ agentProfile: stamped })
    mocks.getProfile.mockReturnValue(sessionAware('chat'))
    expect(sessionService.resolveAgentProfileName('s1')).toBe('chat')
  })

  it('两个设置项按会话形态各管一边，且只读对应的那一个 key', () => {
    mocks.findByKey.mockImplementation((key) =>
      key === DEFAULT_PROJECT_AGENT_KEY
        ? 'coding'
        : key === DEFAULT_CHAT_AGENT_KEY
          ? 'browser'
          : undefined
    )
    mocks.getProfile.mockImplementation((name) => sessionAware(name))

    sessionService.create({ projectId: 'p1' })
    expect(insertedSettings().agentProfile).toBe('coding')
    // 只读项目那一个 key —— 两个 key 写反了在默认配置下完全无症状
    expect(mocks.findByKey.mock.calls.map((c) => c[0])).toEqual([DEFAULT_PROJECT_AGENT_KEY])

    mocks.findByKey.mockClear()
    sessionService.create({})
    expect(insertedSettings().agentProfile).toBe('browser')
    expect(mocks.findByKey.mock.calls.map((c) => c[0])).toEqual([DEFAULT_CHAT_AGENT_KEY])
  })
})

describe('create —— 设置指向的档案不可用时回落**对应基座**', () => {
  it('档案已被删（getProfile 查无此人）：无项目回 chat 而非 default', () => {
    mocks.findByKey.mockReturnValue('ghost')
    mocks.getProfile.mockReturnValue(undefined)

    sessionService.create({})
    expect(insertedSettings().agentProfile).toBe('chat')

    sessionService.create({ projectId: 'p1' })
    expect(insertedSettings().agentProfile).toBe('default')
  })

  it('设置里留着一个不可切换的基座（notebook）：同样回落对应基座', () => {
    // 设置页只提供可切换名单，所以这只能由旧值或手改 DB 造成；放行的话新会话拿到的是
    // 一个 {{shuvix:notebookPath}} 被替换成空串的笔记本人格
    mocks.findByKey.mockReturnValue('notebook')
    mocks.getProfile.mockReturnValue({ name: 'notebook', sessionAwareness: true })

    sessionService.create({})
    expect(insertedSettings().agentProfile).toBe('chat')

    sessionService.create({ projectId: 'p1' })
    expect(insertedSettings().agentProfile).toBe('default')
  })

  it('档案后来被去掉了 shuvix-session-awareness：创建入口与切换入口同口径地拒绝它', () => {
    // 切换会拒、创建却照戳 = 同一条规则只实现了一半
    mocks.findByKey.mockReturnValue('wiki-writer')
    mocks.getProfile.mockReturnValue({ name: 'wiki-writer', sessionAwareness: false })

    sessionService.create({})
    expect(insertedSettings().agentProfile).toBe('chat')

    sessionService.create({ projectId: 'p1' })
    expect(insertedSettings().agentProfile).toBe('default')
  })
})
