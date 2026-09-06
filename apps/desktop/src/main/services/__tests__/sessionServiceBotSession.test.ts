/**
 * sessionService —— 聊天会话（绑定了 bot 的无根会话）的形态判定。
 *
 * 契约（M3′，v3 收窄，一对一改制）：
 *   - `isBotSession` / `resolveAgentProfileName` 走 chat-protocol 的 `isChatSessionSettings`：
 *     `bot` 有值即聊天会话；群聊时代遗留的 `bots` 名单**非空**也算（未绑定、等用户重新选），
 *     空数组不算 —— settings 的 JSON patch 没有删键路径，群聊时代「移除全部成员」只能写 `[]`，
 *     而 `[]` 是 truthy；写成 `!!bots` 会让被写过空数组的普通会话整片变成无根会话；
 *   - 聊天会话的 `resolveAgentProfileName` 返回 **null**（严格 null，不是 falsy），
 *     且判定先于 notebookPath；
 *   - `create` 只在 `bot` 有值时写 `bot` 键；
 *   - `setBot` 只对聊天会话生效（含遗留会话 —— 那正是它重新选 bot 的口）、拒绝空名；
 *   - `updateAgentProfile` 对聊天会话零副作用拒绝（先于 getProfile / 落库 / invalidate）；
 *   - **没有开场白**：`create` / `setBot` 只动 settings，一个刚建好的聊天会话里零条消息；
 *   - `delete` 与 botService 只有一个会师点 `abortSession`。
 *
 * mock 面照抄 sessionServiceNotebookProfile.test.ts，另补 sessionDao.insert（create 用）与
 * delete 链上的几个 no-op。botService 的替身**只有** abortSession / isActive 两个成员：这就是
 * sessionService 今天对它的全部依赖 —— 源码若再往别处伸手，这里会以 TypeError 红掉，
 * 而不是被一个顺手 mock 出来的空函数悄悄吞掉。
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
// 消息层只留 delete 链要的 clear：create / setBot 若往消息表写任何东西，这里会以 TypeError 红掉
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

/** create / setBot 的「只动 settings」断言：没有任何一条路通向消息表或 botService */
function expectNoMessageSideEffects(): void {
  expect(mocks.messageClear).not.toHaveBeenCalled()
  expect(mocks.abortSession).not.toHaveBeenCalled()
}

describe('isBotSession —— 绑定了 bot、或带着遗留的 bots 名单，才是聊天会话', () => {
  it('bot 有值 → true', () => {
    mocks.daoPickSettings.mockReturnValue({ bot: 'a' })
    expect(sessionService.isBotSession('s1')).toBe(true)
  })

  it('遗留：bots 非空、没有 bot → true（未绑定，等用户重新选；没有迁移）', () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a'] })
    expect(sessionService.isBotSession('s1')).toBe(true)
  })

  it('bot 为空串 / 空白 → false（不是聊天会话）', () => {
    mocks.daoPickSettings.mockReturnValue({ bot: '  ' })
    expect(sessionService.isBotSession('s1')).toBe(false)
  })

  it('bots 为空数组 → false，且档案照常解析为 default（`!!bots` 会红）', () => {
    mocks.daoPickSettings.mockReturnValue({ bots: [] })
    expect(sessionService.isBotSession('s1')).toBe(false)
    expect(sessionService.resolveAgentProfileName('s1')).toBe('default')
  })

  it('无 bot / bots 键 → false', () => {
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
  it('bot 有值 → 严格 null（不是 falsy 的空串/undefined）', () => {
    mocks.daoPickSettings.mockReturnValue({ bot: 'a' })
    expect(sessionService.resolveAgentProfileName('s1')).toBeNull()
  })

  it('遗留：bots 非空 → 同样 null（未绑定的聊天会话也没有根 Agent）', () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a'] })
    expect(sessionService.resolveAgentProfileName('s1')).toBeNull()
  })

  it('bot 先于 notebookPath 判定：两者同时存在仍返回 null', () => {
    mocks.daoPickSettings.mockReturnValue({ bot: 'a', notebookPath: 'notes/a.md' })
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

describe('create —— bot 键只在有值时写', () => {
  it('bot 有值 → settings 带 bot（trim 后落库），不写 agentProfile（无根会话没有档案）', () => {
    sessionService.create({ bot: ' a ' })
    expect(insertedSettings()).toMatchObject({ bot: 'a' })
    expect('agentProfile' in insertedSettings()).toBe(false)
  })

  it('bot 为空串 / 空白 → 不写 bot 键（缺省即无键），是普通会话', () => {
    sessionService.create({ bot: '  ' })
    expect('bot' in insertedSettings()).toBe(false)
    expect('agentProfile' in insertedSettings()).toBe(true)
  })

  it('不传 bot → 不写键；与 notebookPath / memorySlug 组合时互不干扰', () => {
    sessionService.create({ notebookPath: 'notes/a.md', memorySlug: 'mem' })
    const settings = insertedSettings()
    expect('bot' in settings).toBe(false)
    expect(settings).toMatchObject({ notebookPath: 'notes/a.md', memorySlug: 'mem' })

    mocks.daoInsert.mockReset()
    sessionService.create({ bot: 'a', notebookPath: 'notes/a.md', memorySlug: 'mem' })
    expect(insertedSettings()).toMatchObject({
      bot: 'a',
      notebookPath: 'notes/a.md',
      memorySlug: 'mem'
    })
  })

  it('新建聊天会话只落一行 settings —— 不种开场白、不碰消息表、不叫 botService', () => {
    // 没有 greeting 这个字段，也就没有要种的东西：会话建好那一刻消息表里是零条，
    // 第一条消息永远是用户说的
    sessionService.create({ bot: 'a' })
    expect(mocks.daoInsert).toHaveBeenCalledTimes(1)
    expect(insertedSettings()).toMatchObject({ bot: 'a' })
    expectNoMessageSideEffects()
  })
})

describe('updateAgentProfile —— 聊天会话拒绝一切切换', () => {
  it('拒绝且零副作用：getProfile / 落库 / invalidate / 广播一个都不许发生', async () => {
    mocks.daoPickSettings.mockReturnValue({ bot: 'a' })
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
    mocks.daoPickSettings.mockReturnValue({ bot: 'a' })
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

  it('遗留会话（只有 bots 名单）同样被拒：它仍是聊天会话', async () => {
    mocks.daoPickSettings.mockReturnValue({ bots: ['a'] })
    const res = await sessionService.updateAgentProfile('s1', 'coding')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/no root agent/i)
  })

  it('笔记本的拒绝语句仍在 bot 之后生效（不回归）', async () => {
    mocks.daoPickSettings.mockReturnValue({ notebookPath: 'notes/a.md' })
    const res = await sessionService.updateAgentProfile('s1', 'coding')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/pinned/)
  })
})

describe('setBot —— 绑定 bot，也是遗留会话重新选 bot 的口', () => {
  beforeEach(() => {
    mocks.daoUpdateSettings.mockClear()
  })

  it('遗留会话（只有 bots 名单）→ 写 bot、广播；名单不动、不碰消息表', () => {
    // 没有迁移：老会话靠这里重新选。遗留名单留在原处只读（bot 一旦有值就压过它）
    mocks.daoPickSettings.mockReturnValue({ bots: ['deleted-1', 'typo'] })
    const res = sessionService.setBot('s1', 'alive')
    expect(res).toEqual({ success: true })
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith('s1', { bot: 'alive' })
    expect(mocks.broadcastSessionConfigChanged).toHaveBeenCalledWith('s1')
    expectNoMessageSideEffects()
  })

  it('已绑定的会话可以换绑（名字 trim 后落库）', () => {
    mocks.daoPickSettings.mockReturnValue({ bot: 'a' })
    expect(sessionService.setBot('s1', ' b ')).toEqual({ success: true })
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith('s1', { bot: 'b' })
  })

  it('**不校验名字是否存在**：md 已删的名字照样能绑（缺失在会话里可见地失败）', () => {
    mocks.daoPickSettings.mockReturnValue({ bot: 'a' })
    expect(sessionService.setBot('s1', 'ghost').success).toBe(true)
    expect(mocks.daoUpdateSettings).toHaveBeenCalledWith('s1', { bot: 'ghost' })
  })

  it.each([[''], ['   ']])('空名被拒（%j）：聊天会话不能没有 bot', (next) => {
    mocks.daoPickSettings.mockReturnValue({ bot: 'a' })
    const res = sessionService.setBot('s1', next)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/needs a bot/i)
    expect(mocks.daoUpdateSettings).not.toHaveBeenCalled()
    expectNoMessageSideEffects()
  })

  it.each([
    ['普通会话', {}],
    ['空数组的会话', { bots: [] }],
    ['笔记本会话', { notebookPath: 'a.md' }]
  ])('非聊天会话被拒（%s）：形态不被顺手改掉，零副作用', (_label, settings) => {
    mocks.daoPickSettings.mockReturnValue(settings)
    const res = sessionService.setBot('s1', 'a')
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
    mocks.daoPickSettings.mockReturnValue({ bot: 'a' })
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
