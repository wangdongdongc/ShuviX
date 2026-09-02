/**
 * sessionService —— 聊天会话（`settings.bots` 非空）的「无根会话」判定。
 *
 * 契约（M3′）：
 *   - `isBotSession` / `resolveAgentProfileName` 一律看 `bots?.length`，**空数组不算** ——
 *     settings 的 JSON patch 没有删键路径，「移除全部成员」只能写 `[]`，而 `[]` 是 truthy；
 *     写成 `!!bots` 会让被写过空数组的普通会话整片变成无根会话（chat/notebook 两区一起塌）；
 *   - 聊天会话的 `resolveAgentProfileName` 返回 **null**（严格 null，不是 falsy），
 *     且判定先于 notebookPath；
 *   - `create` 只在 `bots?.length` 时写 `bots` 键；
 *   - `updateAgentProfile` 对聊天会话零副作用拒绝（先于 getProfile / 落库 / invalidate）。
 *
 * mock 面照抄 sessionServiceNotebookProfile.test.ts，另补 sessionDao.insert（create 用）。
 * 本文件**不调用** clearSessionTreeCacheForTests —— sessionService 在模块导入时就
 * addSessionTreePin，清掉会让同文件后续用例里的根会话不再被钉住（这里 sessionStorage
 * 整个是假件，谓词也从未真正注册，但纪律照旧）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi, type MockInstance } from 'vitest'

const mocks = vi.hoisted(() => ({
  daoPickSettings: vi.fn(),
  daoUpdateSettings: vi.fn(),
  daoInsert: vi.fn(),
  getProfile: vi.fn(),
  appendModelChange: vi.fn(),
  appendActiveToolsChange: vi.fn(),
  broadcastSessionConfigChanged: vi.fn(),
  seedGreetings: vi.fn(async () => {})
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pickSettings: mocks.daoPickSettings,
    updateSettings: mocks.daoUpdateSettings,
    insert: mocks.daoInsert
  }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: {} }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/projectDao', () => ({ projectDao: {} }))
vi.mock('../../dao/settingsDao', () => ({ settingsDao: {} }))
vi.mock('../messageService', () => ({ messageService: {} }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: vi.fn(),
  addSessionTreePin: vi.fn(),
  appendModelChange: mocks.appendModelChange,
  appendActiveToolsChange: mocks.appendActiveToolsChange
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({ getTempWorkspace: vi.fn(), getToolResultsBase: vi.fn() }))
vi.mock('../toolAggregator', () => ({
  getDefaultEnabledTools: vi.fn(() => []),
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../botService', () => ({
  botService: {
    abortSession: vi.fn(async () => {}),
    forgetNotesSession: vi.fn(),
    seedGreetings: mocks.seedGreetings,
    isActive: vi.fn(() => false)
  }
}))
vi.mock('../agentService', () => ({ agentService: { getProfile: mocks.getProfile } }))
vi.mock('../agentSession', () => ({ AgentSession: class {} }))
vi.mock('../bgTaskService', () => ({ killBySession: vi.fn(), setBgTaskNotifier: vi.fn() }))
vi.mock('../../agents/agentHost', () => ({ resolveProfileModelSpec: vi.fn() }))
vi.mock('../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: mocks.broadcastSessionConfigChanged,
  broadcastSessionListChanged: vi.fn(),
  broadcastSessionTitleChanged: vi.fn()
}))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../userInputBroker', () => ({ registerUserInputParticipant: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

let sessionService: (typeof import('../sessionService'))['sessionService']
let invalidateSpy: MockInstance<(sessionId: string) => Promise<void>>

beforeAll(async () => {
  ;({ sessionService } = await import('../sessionService'))
  invalidateSpy = vi.spyOn(sessionService, 'invalidateAgent')
})
beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  invalidateSpy.mockClear()
})

/** create 落库时写进 settings 的对象 */
function insertedSettings(): Record<string, unknown> {
  return mocks.daoInsert.mock.calls[0][0].settings
}

describe('isBotSession —— 非空 bots 才是聊天会话', () => {
  it('bots 非空 → true', () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a'] })
    expect(sessionService.isBotSession('s1')).toBe(true)
  })

  it('bots 为空数组 → false，且档案照常解析为 default（`!!bots` 会红）', () => {
    mocks.daoPickSettings.mockReturnValue({ bots: [] })
    expect(sessionService.isBotSession('s1')).toBe(false)
    expect(sessionService.resolveAgentProfileName('s1')).toBe('default')
  })

  it('无 bots 键 → false', () => {
    mocks.daoPickSettings.mockReturnValue({})
    expect(sessionService.isBotSession('s1')).toBe(false)
  })

  it('会话不存在（pickSettings 返回 undefined）→ false，不抛', () => {
    mocks.daoPickSettings.mockReturnValue(undefined)
    expect(() => sessionService.isBotSession('missing')).not.toThrow()
    expect(sessionService.isBotSession('missing')).toBe(false)
  })
})

describe('resolveAgentProfileName —— 聊天会话没有根 Agent', () => {
  it('bots 非空 → 严格 null（不是 falsy 的空串/undefined）', () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a'] })
    expect(sessionService.resolveAgentProfileName('s1')).toBeNull()
  })

  it('bots 先于 notebookPath 判定：两者同时存在仍返回 null', () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a'], notebookPath: 'notes/a.md' })
    expect(sessionService.resolveAgentProfileName('s1')).toBeNull()
  })

  it("bots 为空数组 + notebookPath → 'notebook'（空数组不劫持笔记本）", () => {
    mocks.daoPickSettings.mockReturnValue({ bots: [], notebookPath: 'notes/a.md' })
    expect(sessionService.resolveAgentProfileName('s1')).toBe('notebook')
  })

  it('bots 为空数组 + agentProfile → 该档案名（空数组不劫持普通会话）', () => {
    mocks.daoPickSettings.mockReturnValue({ bots: [], agentProfile: 'coding' })
    mocks.getProfile.mockReturnValue({ tools: [], sessionAwareness: true })
    expect(sessionService.resolveAgentProfileName('s1')).toBe('coding')
  })
})

describe('create —— bots 键只在非空时写', () => {
  it('bots 非空 → settings 带 bots', () => {
    sessionService.create({ bots: ['a', 'b'] })
    expect(insertedSettings()).toMatchObject({ bots: ['a', 'b'] })
  })

  it('bots 为空数组 → 不写 bots 键（缺省即无键）', () => {
    sessionService.create({ bots: [] })
    expect('bots' in insertedSettings()).toBe(false)
  })

  it('不传 bots → 不写键；与 notebookPath / memorySlug 组合时互不干扰', () => {
    sessionService.create({ notebookPath: 'notes/a.md', memorySlug: 'mem' })
    const settings = insertedSettings()
    expect('bots' in settings).toBe(false)
    expect(settings).toMatchObject({ notebookPath: 'notes/a.md', memorySlug: 'mem' })

    mocks.daoInsert.mockReset()
    sessionService.create({ bots: ['a'], notebookPath: 'notes/a.md', memorySlug: 'mem' })
    expect(insertedSettings()).toMatchObject({
      bots: ['a'],
      notebookPath: 'notes/a.md',
      memorySlug: 'mem'
    })
  })
})

describe('updateAgentProfile —— 聊天会话拒绝一切切换', () => {
  it('拒绝且零副作用：getProfile / 落库 / invalidate / 种子 / 广播一个都不许发生', async () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a'] })
    const res = await sessionService.updateAgentProfile('s1', 'coding')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/no root agent/i)

    expect(mocks.getProfile).not.toHaveBeenCalled()
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(invalidateSpy).not.toHaveBeenCalled()
    expect(mocks.appendModelChange).not.toHaveBeenCalled()
    expect(mocks.appendActiveToolsChange).not.toHaveBeenCalled()
    expect(mocks.broadcastSessionConfigChanged).not.toHaveBeenCalled()
  })

  it("切 'default' 也被拒 —— 没有「切回去」的后门", async () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a'] })
    const res = await sessionService.updateAgentProfile('s1', 'default')
    expect(res.success).toBe(false)
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
  })

  it('bots 为空数组的会话照常切换成功（空数组不误伤）', async () => {
    mocks.daoPickSettings.mockReturnValue({ bots: [] })
    mocks.getProfile.mockReturnValue({ tools: ['read'], sessionAwareness: true })
    const res = await sessionService.updateAgentProfile('s1', 'coding')
    expect(res.success).toBe(true)
    expect(mocks.daoUpdateSettings).toHaveBeenCalledTimes(1)
    expect(invalidateSpy).toHaveBeenCalledTimes(1)
  })

  it('笔记本的拒绝语句仍在 bots 之后生效（不回归）', async () => {
    mocks.daoPickSettings.mockReturnValue({ notebookPath: 'notes/a.md' })
    const res = await sessionService.updateAgentProfile('s1', 'coding')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/pinned/)
  })
})

describe('updateBots —— 成员管理，也是名单写坏之后的逃生口', () => {
  beforeEach(() => {
    mocks.seedGreetings.mockClear()
    mocks.daoUpdateSettings.mockClear()
  })

  it('改名单：落库、只对新增成员补开场白、返回实际名单与新增集', async () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a', 'b'] })
    const res = await sessionService.updateBots('s1', ['a', 'c'])

    expect(res).toMatchObject({ success: true, bots: ['a', 'c'], added: ['c'] })
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith('s1', { bots: ['a', 'c'] })
    // 老成员 a 不重播开场白，被移除的 b 也不播
    expect(mocks.seedGreetings).toHaveBeenCalledWith('s1', ['c'])
  })

  it('名单没变化时不补任何开场白（差集为空即不调）', async () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a', 'b'] })
    const res = await sessionService.updateBots('s1', ['b', 'a'])
    expect(res.added).toEqual([])
    expect(mocks.seedGreetings).not.toHaveBeenCalled()
  })

  it('去重但保序 —— 名单顺序就是开场白顺序', async () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a'] })
    const res = await sessionService.updateBots('s1', ['c', 'b', 'c', ' b ', 'a'])
    expect(res.bots).toEqual(['c', 'b', 'a'])
    expect(mocks.seedGreetings).toHaveBeenCalledWith('s1', ['c', 'b'])
  })

  it('**这就是逃生口**：成员 md 全被删也照样能把名单改回可用的', async () => {
    // 名单里全是已经不存在的 bot —— 会话仍是聊天会话（判定只看非空），
    // 于是这个接口够得着它。校验「名字是否存在」等于把逃生口一起锁上
    mocks.daoPickSettings.mockReturnValue({ bots: ['deleted-1', 'typo'] })
    const res = await sessionService.updateBots('s1', ['alive'])
    expect(res).toMatchObject({ success: true, bots: ['alive'] })
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith('s1', { bots: ['alive'] })
  })

  it.each([[[]], [['', '   ']]])(
    '空名单被拒（%j）：形态不该被「管理成员」顺手改掉',
    async (next) => {
      mocks.daoPickSettings.mockReturnValue({ bots: ['a'] })
      const res = await sessionService.updateBots('s1', next as string[])
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/at least one member/i)
      expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
      expect(mocks.seedGreetings).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['普通会话', {}],
    ['空数组的会话', { bots: [] }],
    ['笔记本会话', { notebookPath: 'a.md' }]
  ])('非聊天会话被拒（%s）：零副作用', async (_label, settings) => {
    mocks.daoPickSettings.mockReturnValue(settings)
    const res = await sessionService.updateBots('s1', ['a'])
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not a chat session/i)
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expect(mocks.seedGreetings).not.toHaveBeenCalled()
  })
})
