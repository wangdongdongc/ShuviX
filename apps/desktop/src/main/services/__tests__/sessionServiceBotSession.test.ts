/**
 * sessionService —— 聊天会话（`settings.bots` 非空）的「无根会话」判定。
 *
 * 契约（M3′，v3 收窄）：
 *   - `isBotSession` / `resolveAgentProfileName` 一律看 `bots?.length`，**空数组不算** ——
 *     settings 的 JSON patch 没有删键路径，「移除全部成员」只能写 `[]`，而 `[]` 是 truthy；
 *     写成 `!!bots` 会让被写过空数组的普通会话整片变成无根会话（chat/notebook 两区一起塌）；
 *   - 聊天会话的 `resolveAgentProfileName` 返回 **null**（严格 null，不是 falsy），
 *     且判定先于 notebookPath；
 *   - `create` 只在 `bots?.length` 时写 `bots` 键；
 *   - `updateAgentProfile` 对聊天会话零副作用拒绝（先于 getProfile / 落库 / invalidate）；
 *   - **没有开场白**：`create` / `updateBots` 只动 settings，一个刚建好的聊天会话里零条消息 ——
 *     v3 的 bot 是「管线 + 槽位表 + 正文」的绑定，没有 greeting 这个字段，也就没有要种的东西；
 *   - `delete` 与 botService 只有一个会师点 `abortSession`，没有笔记侧的 forget 钩子可调。
 *
 * mock 面照抄 sessionServiceNotebookProfile.test.ts，另补 sessionDao.insert（create 用）与
 * delete 链上的几个 no-op。botService 的替身**只有** abortSession / isActive 两个成员：这就是
 * sessionService 今天对它的全部依赖 —— 源码若再往 seedGreetings / forgetNotesSession 伸手，
 * 这里会以 TypeError 红掉，而不是被一个顺手 mock 出来的空函数悄悄吞掉。
 * 本文件**不调用** clearSessionTreeCacheForTests —— sessionService 在模块导入时就
 * addSessionTreePin，清掉会让同文件后续用例里的根会话不再被钉住（这里 sessionStorage
 * 整个是假件，谓词也从未真正注册，但纪律照旧）。
 */
import { describe, it, expect, beforeAll, beforeEach, vi, type MockInstance } from 'vitest'

const mocks = vi.hoisted(() => ({
  daoPickSettings: vi.fn(),
  daoUpdateSettings: vi.fn(),
  daoInsert: vi.fn(),
  daoFindChildren: vi.fn(() => [] as Array<{ id: string }>),
  daoDeleteById: vi.fn(),
  httpLogDelete: vi.fn(),
  messageClear: vi.fn(),
  abortSession: vi.fn(async () => {}),
  getProfile: vi.fn(),
  appendModelChange: vi.fn(),
  appendActiveToolsChange: vi.fn(),
  broadcastSessionConfigChanged: vi.fn()
}))

vi.mock('../../dao/sessionDao', () => ({
  sessionDao: {
    pickSettings: mocks.daoPickSettings,
    updateSettings: mocks.daoUpdateSettings,
    insert: mocks.daoInsert,
    findChildren: mocks.daoFindChildren,
    deleteById: mocks.daoDeleteById
  }
}))
vi.mock('../../dao/httpLogDao', () => ({ httpLogDao: { deleteBySessionId: mocks.httpLogDelete } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/projectDao', () => ({ projectDao: {} }))
// create 会读默认档案设置（general.default*Agent）；未设 ⇒ 回落基座 default / chat
vi.mock('../../dao/settingsDao', () => ({ settingsDao: { findByKey: vi.fn() } }))
// 消息层只留 delete 链要的 clear：create / updateBots 若往消息表写任何东西，这里会以 TypeError 红掉
vi.mock('../messageService', () => ({ messageService: { clear: mocks.messageClear } }))
vi.mock('../sessionStorage', () => ({
  readSessionRunConfig: vi.fn(),
  addSessionTreePin: vi.fn(),
  appendModelChange: mocks.appendModelChange,
  appendActiveToolsChange: mocks.appendActiveToolsChange
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../utils/paths', () => ({
  // delete 链会拿这两个目录去 rm —— 指到一个不存在的路径，existsSync 为假即跳过
  getTempWorkspace: vi.fn((id: string) => `/nonexistent/shuvix-unit/tmp/${id}`),
  getToolResultsBase: vi.fn(() => '/nonexistent/shuvix-unit/tool-results')
}))
vi.mock('../toolAggregator', () => ({
  getDefaultEnabledTools: vi.fn(() => []),
  filterAvailableTools: vi.fn((tools: string[]) => tools)
}))
vi.mock('../../utils/toolUtils/allowList', () => ({ buildAllowEntry: vi.fn() }))
vi.mock('../botService', () => ({
  // 恰两个成员 —— 见文件头：这就是 sessionService 对 botService 的全部依赖
  botService: {
    abortSession: mocks.abortSession,
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
  mocks.daoFindChildren.mockReturnValue([])
  invalidateSpy.mockClear()
})

/** create 落库时写进 settings 的对象 */
function insertedSettings(): Record<string, unknown> {
  return mocks.daoInsert.mock.calls[0][0].settings
}

/** create / updateBots 的「只动 settings」断言：没有任何一条路通向消息表或 botService */
function expectNoMessageSideEffects(): void {
  expect(mocks.messageClear).not.toHaveBeenCalled()
  expect(mocks.abortSession).not.toHaveBeenCalled()
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

  it('新建聊天会话只落一行 settings —— 不种开场白、不碰消息表、不叫 botService', () => {
    // 没有 greeting 这个字段，也就没有要种的东西：会话建好那一刻消息表里是零条，
    // 第一条消息永远是用户说的
    sessionService.create({ bots: ['a', 'b'] })
    expect(mocks.daoInsert).toHaveBeenCalledTimes(1)
    expect(insertedSettings()).toMatchObject({ bots: ['a', 'b'] })
    expectNoMessageSideEffects()
  })
})

describe('updateAgentProfile —— 聊天会话拒绝一切切换', () => {
  it('拒绝且零副作用：getProfile / 落库 / invalidate / 广播一个都不许发生', async () => {
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
    mocks.daoUpdateSettings.mockClear()
  })

  it('改名单：落库、广播、返回实际名单与新增集 —— 新增成员不再补开场白', async () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a', 'b'] })
    const res = await sessionService.updateBots('s1', ['a', 'c'])

    expect(res).toMatchObject({ success: true, bots: ['a', 'c'], added: ['c'] })
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith('s1', { bots: ['a', 'c'] })
    expect(mocks.broadcastSessionConfigChanged).toHaveBeenCalledWith('s1')
    // added 只是给调用方的差集事实；宿主自己不拿它做任何事（v2 曾用它挑谁播开场白）
    expectNoMessageSideEffects()
  })

  it('名单没变化时 added 为空（差集为空），落库照旧', async () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a', 'b'] })
    const res = await sessionService.updateBots('s1', ['b', 'a'])
    expect(res.added).toEqual([])
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith('s1', { bots: ['b', 'a'] })
  })

  it('去重但保序 —— 名单顺序就是成员展示的顺序', async () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a'] })
    const res = await sessionService.updateBots('s1', ['c', 'b', 'c', ' b ', 'a'])
    expect(res.bots).toEqual(['c', 'b', 'a'])
    expect(res.added).toEqual(['c', 'b'])
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
      expectNoMessageSideEffects()
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
    expectNoMessageSideEffects()
  })
})

describe('delete —— 与 botService 只有 abortSession 一个会师点', () => {
  it('删除聊天会话：先会师 abortSession，再清消息 / 日志 / 行；没有笔记侧的 forget 钩子', async () => {
    // v2 的 delete 还要顺手 forgetNotesSession（笔记检查点按会话记）；v3 没有笔记段，
    // botService 替身也没有那个成员 —— 源码若还在调它，这里就是一条 TypeError
    mocks.daoPickSettings.mockReturnValue({ bots: ['a'] })
    await expect(sessionService.delete('s1')).resolves.toBeUndefined()

    expect(mocks.abortSession).toHaveBeenCalledWith('s1')
    expect(mocks.messageClear).toHaveBeenCalledWith('s1')
    expect(mocks.httpLogDelete).toHaveBeenCalledWith('s1')
    expect(mocks.daoDeleteById).toHaveBeenCalledWith('s1')
    // 顺序：会师点在动数据之前 —— 否则一个还在跑的 run 会往刚删掉的会话里继续写
    const order = [mocks.abortSession, mocks.messageClear, mocks.daoDeleteById].map(
      (m) => m.mock.invocationCallOrder[0]
    )
    expect(order).toEqual([...order].sort((x, y) => x - y))
  })
})
