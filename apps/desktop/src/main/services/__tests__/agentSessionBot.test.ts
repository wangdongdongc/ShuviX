/**
 * AgentSession.create —— 人设注入与**不泄漏**。
 *
 * 契约：一条 bot 会话的根 Agent 跑在基座 `bot` 上，而**它是谁**由绑定的那份 bot md
 * 的正文经 `renderBotContext` 围栏后追加到它的系统提示词末尾
 * （`CreateAgentParams.systemContext`）。
 *
 * **只有根 Agent 拿得到这段。** 干活的是**子会话**与**派发出去的子代理**，它们按自己的档案
 * 生成系统提示词。于是「人设影响怎么说话、不影响
 * 怎么干活」是结构保证，而不是一句提示词纪律 —— AG-5 / AG-6 守的就是这条结构。
 *
 * 判据是**解析出来的根档案名**（`profileName === 'bot'`），不是「settings 里有没有这个键」：
 * 形态推导是唯一的决定点（分支次序 笔记本 → bot，见 sessionServiceProfileResolution
 * 的 RP-13），按键判会让 `notebookPath + bot` 这种畸形组合跑出「notebook 基座 + 人设围栏」
 * 的第三种东西。
 *
 * mock 面：`agentFactory.createAgent`（注入的观测点）/ `agentService.getProfile` /
 * `botService.forSession` / `fileTime.recordRead`。**`renderBotContext` 保持真实** ——
 * 断言因此是关于真围栏的，而不是关于一个假函数的返回值。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { BOT_CONTEXT_TAG } from '@shuvix/agent-runtime'

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  getProfile: vi.fn<(name: string) => unknown>(),
  forSession: vi.fn<(sessionId: string) => unknown>(),
  recordRead: vi.fn()
}))

vi.mock('../settingsService', () => ({ settingsService: { get: () => undefined } }))
vi.mock('../../dao/providerDao', () => ({ providerDao: {} }))
vi.mock('../../dao/sessionDao', () => ({ sessionDao: {} }))
vi.mock('../agentService', () => ({ agentService: { getProfile: mocks.getProfile } }))
vi.mock('../botService', () => ({ botService: { forSession: mocks.forSession } }))
vi.mock('../../agents/agentHost', () => ({ agentFactory: { createAgent: mocks.createAgent } }))
vi.mock('../hookService', () => ({
  hookTriggers: { fire: vi.fn() },
  hookService: { abortSessionRuns: vi.fn() }
}))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(),
  isDefaultTitle: vi.fn()
}))
vi.mock('../../utils/toolUtils/fileTime', () => ({
  clearSession: vi.fn(),
  recordRead: mocks.recordRead
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

type Mod = typeof import('../agentSession')
let mod: Mod

/** 一份最小可用的档案（getProfile 的返回形状，toInProcessAgentType 读的就是这几项） */
const profileOf = (name: string): Record<string, unknown> => ({
  name,
  displayName: name,
  description: '',
  tools: [],
  systemPrompt: `${name} prompt`,
  instructionFiles: [],
  projectAwareness: false
})

/** botService.forSession 的返回形状 */
const SCOUT = {
  file: {
    name: 'scout',
    displayName: '侦察兵',
    description: '侦察与调研',
    body: '你言简意赅。\n\n- 这个仓库用 pnpm'
  },
  basePath: '/Users/u/.shuvix/bots/scout.md'
}

/** 建一条会话，返回 createAgent 收到的那份参数 */
async function createWith(profileName: string, sessionId = 's1'): Promise<Record<string, unknown>> {
  await mod.AgentSession.create({
    sessionId,
    provider: 'p',
    model: 'm',
    capabilities: {},
    workingDirectory: '/proj',
    enabledTools: [],
    profileName
  })
  return mocks.createAgent.mock.calls.at(-1)![0] as Record<string, unknown>
}

beforeAll(async () => {
  mod = await import('../agentSession')
})

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.getProfile.mockImplementation((name: string) => profileOf(name))
  mocks.forSession.mockReturnValue(null)
  mocks.createAgent.mockResolvedValue({ runtime: { prompt: vi.fn() }, dispose: vi.fn() })
})

describe('AG-1 / AG-2 / AG-3 —— 注入面', () => {
  it('AG-1 bot 会话 → kind root、bot 档案、恰含一块的 systemContext（名字 / 绝对路径 / 正文）', async () => {
    mocks.forSession.mockReturnValue(SCOUT)
    const params = await createWith('bot')

    expect(params.kind).toBe('root')
    expect(params.sessionId).toBe('s1')
    expect((params.profile as { name: string }).name).toBe('bot')
    // forSession 按**这条会话**问，不是按名字 —— 绑定住在 settings 里
    expect(mocks.forSession.mock.calls).toEqual([['s1']])

    // 恰一块：两块会让模型看到两段自相矛盾的「你是谁」
    const blocks = params.systemContext as string[]
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks).toHaveLength(1)

    // 真围栏（renderBotContext 未被替身）：名字、绝对路径、正文都在里面
    const block = blocks[0]
    expect(block).toContain(
      `<${BOT_CONTEXT_TAG} name="scout" file="/Users/u/.shuvix/bots/scout.md">`
    )
    expect(block).toContain('You are "侦察兵" (scout).')
    expect(block).toContain('这个仓库用 pnpm')
    expect(block.trimEnd().endsWith(`</${BOT_CONTEXT_TAG}>`)).toBe(true)
  })

  it('AG-2 非 bot 会话（work / chat / notebook）→ systemContext 属性**不存在**', async () => {
    // 断「属性不存在」而不只是「空」：误传 `[]` 同样会让下游的 `?? []` 全绿，而那正是
    // `forSession` 接错线（比如永远返回一个空条目）时的表现
    for (const name of ['work', 'chat', 'notebook', 'coding']) {
      mocks.createAgent.mockClear()
      mocks.forSession.mockReturnValue(SCOUT) // 就算注册表里有这个 bot 也不该被取用
      const params = await createWith(name)
      expect(params.systemContext, name).toBeUndefined()
      expect('systemContext' in params && params.systemContext !== undefined, name).toBe(false)
      // 根本没去问过 —— 判据是档案名，不是 settings 里的键
      expect(mocks.forSession, name).not.toHaveBeenCalled()
    }
  })

  it('AG-3 绑定的 md 被删 → 无 systemContext，会话仍建在 bot 基座上', async () => {
    // 用户删了一个文件不是数据损坏：会话照常打开、照常跑，只是没有人设可注入
    // （基座正文里那段「如果没有 <bot> 块就别编角色」正是为这一刻写的）
    mocks.forSession.mockReturnValue(null)
    const params = await createWith('bot')
    expect(params.systemContext).toBeUndefined()
    expect((params.profile as { name: string }).name).toBe('bot')
    expect(params.kind).toBe('root')
    expect(mocks.recordRead).not.toHaveBeenCalled()
  })

  it('AG-4 注入时按会话 recordRead 那份文件；没有人设时不记', async () => {
    // 正文就在系统提示词里 = 视同「已读」：bot 用 `edit` 改自己这份文件时不必先 `read`
    // （少一张询问卡，而围栏前言也是这么告诉它的）。读后被改的检测仍然有效 ——
    // 注入之后被别人改过，edit 照样拒绝。派生 agent 的 fileTime 归根会话，故按 sessionId 记
    mocks.forSession.mockReturnValue(SCOUT)
    await createWith('bot', 'sess-42')
    expect(mocks.recordRead.mock.calls).toEqual([['sess-42', SCOUT.basePath]])

    mocks.recordRead.mockClear()
    mocks.forSession.mockReturnValue(null)
    await createWith('bot', 'sess-43')
    expect(mocks.recordRead).not.toHaveBeenCalled()
  })
})

describe('AG-5 / AG-6 —— 不泄漏', () => {
  it('AG-5 子会话：settings 里没有 bot → forSession 为 null → 拿不到 systemContext', async () => {
    // 从一条 bot 会话开出来的子会话是**干活的地方**：它按自己的档案（多半是 coding）
    // 生成系统提示词，人设一个字都不跟过去。创建侧那一半（`create({parentId})` 不抄
    // bot 键）在 sessionServiceBotSession.test.ts 的 PSess-Sub；这里是注入侧。
    //
    // forSession 的实现就是「读这条会话的 settings.bot」，所以「子会话 settings 里
    // 没有这个键」在这一层的等价表述就是「forSession(child) → null」
    const world: Record<string, unknown> = {
      'bot-root': SCOUT, // 父：绑着 scout
      'sub-1': null // 子：settings 里没有 bot
    }
    mocks.forSession.mockImplementation((id: string) => world[id] ?? null)

    const root = await createWith('bot', 'bot-root')
    expect((root.systemContext as string[])[0]).toContain(`<${BOT_CONTEXT_TAG} name="scout"`)

    // 子会话的根 Agent：形态推导给它 work / coding 之类，注入侧因此连问都不问
    mocks.createAgent.mockClear()
    mocks.forSession.mockClear()
    const child = await createWith('coding', 'sub-1')
    expect(child.systemContext).toBeUndefined()
    expect(mocks.forSession).not.toHaveBeenCalled()

    // 即便某天子会话被钉成 bot 基座，它自己的 settings 里没有绑定，围栏也仍然缺席
    mocks.createAgent.mockClear()
    const pinned = await createWith('bot', 'sub-1')
    expect(pinned.systemContext).toBeUndefined()
  })

  it('AG-6 派发：整个桌面主进程里只有一处给得出 systemContext，且不在 spawned 路径上', () => {
    // `CreateAgentParams.systemContext` 在共享核心里是一条**透传**通道：派发路径
    // （AgentManager → createSubAgentManager → createAgent({kind:'spawned'})）原样转交
    // 调用方给的块（agent-runtime 的 managerSystemContext.test.ts 钉那条透传）。于是
    // 「子代理拿不到人设」不是共享核心保证的，而是**桌面这一侧从不往那条路上塞东西**。
    //
    // 将来那个看起来很对的重构 ——「把根会话的上下文往下传给它派出去的子代理」——
    // 会在这里撞红，而别处一条都不会。
    const mainDir = fileURLToPath(new URL('../../', import.meta.url))
    const sources: Array<{ path: string; text: string }> = []
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === '__tests__' || ent.name === 'node_modules') continue
        const full = join(dir, ent.name)
        if (ent.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(ent.name))
          sources.push({ path: full.replace(/\\/g, '/'), text: readFileSync(full, 'utf-8') })
      }
    }
    walk(mainDir)
    expect(sources.length).toBeGreaterThan(50)

    // 「供给点」= 在对象字面量里写出这个属性（`systemContext:` 或简写 `systemContext,`），
    // 而不是只在注释或类型声明里提到它
    const suppliers = sources
      .filter((s) => s.text.split('\n').some((l) => /^\s*systemContext[,:]/.test(l)))
      .map((s) => s.path.slice(mainDir.length))
      .sort()
    // 只此一处，且就在 kind:'root' 那次调用上（下面那条断言钉它）
    expect(suppliers).toEqual(['services/agentSession.ts'])

    // 派发装配的两份文件一个字都不该提供它
    for (const file of ['agents/AgentManager.ts', 'agents/AgentTool.ts']) {
      const text = sources.find((s) => s.path.endsWith(file))!.text
      expect(text, `${file} 不得供给 systemContext`).not.toMatch(/^\s*systemContext[,:]/m)
    }

    // 唯一那处供给点就在根会话的创建调用里（kind: 'root' 与它同属一个对象字面量）
    const agentSession = sources.find((s) => s.path.endsWith('services/agentSession.ts'))!.text
    expect(agentSession).toMatch(/kind: 'root',[\s\S]*?systemContext,/)
    expect(agentSession).not.toContain("kind: 'spawned'")
  })
})
