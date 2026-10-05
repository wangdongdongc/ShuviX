/**
 * bot 会话的人设注入与**不泄漏**（pi-durable 切换之后的形态）。
 *
 * 契约：一条 bot 会话的根 Agent 跑在基座 `bot` 上，而**它是谁**由绑定的那份 bot md 的正文经
 * `renderBotContext` 围栏后成为系统提示词的一个活段落（`shuvix.prompt.bot`，只选给 bot 档案上的根
 * agent —— agent-runtime 的 `promptExtensionsFor`）。段落内容由桌面的 `PromptHost.resolveBotContext`
 * 每次请求现解析；它也是「正文视同已读」（fileTime `recordRead`）的**唯一**授予点 —— P1-11 的 agentHost
 * 实现它，那边的单测钉注入面（AG-1/2/3/5 在这里暂记 todo）。
 *
 * 这一份留下的两条：
 *  - AG-4（D10-33 的否定面）：会话门面（AgentSession）**从不**调 `recordRead`；
 *  - AG-6：桌面主进程里没有任何一处在对象字面量里供给 `systemContext`（旧的透传通道已随
 *    createAgent 退场），派发装配的两份文件尤其不能。P1-11 会把这条扫描改指 `resolveBotContext`。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

const mocks = vi.hoisted(() => ({
  recordRead: vi.fn(),
  forSession: vi.fn<(sessionId: string) => unknown>()
}))

vi.mock('../../utils/toolUtils/fileTime', () => ({
  clearSession: vi.fn(),
  recordRead: mocks.recordRead
}))
vi.mock('../botService', () => ({ botService: { forSession: mocks.forSession } }))
vi.mock('../sessionHost', async () =>
  (await import('./support/fakeSessionHost')).sessionHostModuleMock()
)
vi.mock('../sessionService', () => ({
  sessionService: { resolveAgentProfileName: () => 'bot' }
}))
vi.mock('../hookService', () => ({
  hookTriggers: { fire: vi.fn() },
  hookService: { abortSessionRuns: vi.fn() }
}))
vi.mock('../sessionTriggerFacts', () => ({
  buildTurnCompletedFacts: vi.fn(async () => null),
  isDefaultTitle: vi.fn(() => false)
}))
vi.mock('../sessionDayPromptService', () => ({ recordPromptAdmitted: vi.fn() }))
vi.mock('../sessionRecords', () => ({
  sessionRecords: { pick: () => ({ title: 't' }), isEphemeral: () => false }
}))
vi.mock('../sandbox', () => ({ unpinSession: vi.fn() }))
vi.mock('../../frontend/core/ChatFrontendRegistry', () => ({
  chatFrontendRegistry: { broadcast: vi.fn() }
}))
vi.mock('../../i18n', () => ({ t: (key: string) => key }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { AgentSession } from '../agentSession'
import { FakeDurableSession, lockRecord } from './support/fakeSessionHost'

const SCOUT = {
  file: { name: 'scout', displayName: '侦察兵', description: '', body: '你言简意赅。' },
  basePath: '/Users/u/.shuvix/bots/scout.md'
}

beforeEach(() => {
  mocks.recordRead.mockReset()
  mocks.forSession.mockReset()
  mocks.forSession.mockReturnValue(SCOUT)
})

describe('AG-1 / AG-2 / AG-3 / AG-5 —— 注入面（P1-11）', () => {
  it.todo(
    'AG-1 bot 会话 → bot 段落恰含一块围栏（名字 / 绝对路径 / 正文）(pi-durable P1-11: PromptHost.resolveBotContext)'
  )
  it.todo(
    'AG-2 非 bot 会话（work / chat / notebook / coding）→ 没有 bot 段落 (pi-durable P1-11: PromptHost.resolveBotContext)'
  )
  it.todo(
    'AG-3 绑定的 md 被删 → 段落缺席，会话仍建在 bot 基座上 (pi-durable P1-11: PromptHost.resolveBotContext)'
  )
  it.todo(
    'AG-5 子会话 / 派发出去的子代理拿不到人设 (pi-durable P1-11: PromptHost.resolveBotContext)'
  )
})

describe('AG-4 / D10-33 —— 门面从不授予「已读」', () => {
  it('AG-4 bot 会话的门面：首次发送（K3 上锁）、再发送、销毁 agent，都不调 recordRead，也不问 botService', async () => {
    const durable = new FakeDurableSession('bot-1')
    durable.lockOnFirstUse = lockRecord({ profileName: 'bot' })
    const facade = AgentSession.of(durable)

    expect(await facade.prompt('hi')).toEqual({})
    expect(durable.lock?.profileName).toBe('bot')
    expect(await facade.prompt('again')).toEqual({})
    await facade.invalidate()

    expect(mocks.recordRead).not.toHaveBeenCalled()
    expect(mocks.forSession).not.toHaveBeenCalled()
  })

  it('D10-33 模型被拒的发送、打开时已锁的会话：同样不调', async () => {
    const refused = new FakeDurableSession('bot-2')
    refused.submitResults = [{ error: 'no model', code: 'no_model' }]
    await AgentSession.of(refused).prompt('hi')

    const reopened = new FakeDurableSession('bot-3')
    reopened.lock = lockRecord({ profileName: 'bot' })
    await AgentSession.of(reopened).prompt('hi')

    expect(mocks.recordRead).not.toHaveBeenCalled()
  })

  it('D10-33 静态：agentSession.ts 不调 recordRead、不引 botService', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../agentSession.ts', import.meta.url)),
      'utf-8'
    )
    expect(source).not.toMatch(/recordRead\s*\(/)
    expect(source).not.toMatch(/import\s*\{[^}]*\brecordRead\b/)
    expect(source).not.toMatch(/from '\.\/botService'/)
  })
})

describe('AG-6 —— 不泄漏（静态扫描）', () => {
  it('AG-6 桌面主进程里没有任何一处供给 systemContext；派发装配的两份文件尤其不能', () => {
    // 旧的根会话创建（createAgent 的 systemContext 透传）已退场：人设走 bot 段落，段落只选给
    // bot 档案上的根 agent。派发路径（AgentManager / AgentTool）从来不该往那条路上塞东西 ——
    // 「把根会话的上下文往下传给它派出去的子代理」这个看起来很对的重构会在这里撞红。
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

    // 「供给点」= 在对象字面量里写出这个属性（`systemContext:` 或简写 `systemContext,`）
    const suppliers = sources
      .filter((s) => s.text.split('\n').some((l) => /^\s*systemContext[,:]/.test(l)))
      .map((s) => s.path.slice(mainDir.length))
      .sort()
    expect(suppliers).toEqual([])

    for (const file of ['agents/AgentManager.ts', 'agents/AgentTool.ts']) {
      const text = sources.find((s) => s.path.endsWith(file))!.text
      expect(text, `${file} 不得供给 systemContext`).not.toMatch(/^\s*systemContext[,:]/m)
    }
  })
})
