/**
 * 档案注册表语义（IPC 层）：内置全集与默认开关、同名覆盖（展示标记 + 运行时生效 + 删除恢复）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createAgentSession, createProject, writeAgentMd } from '../../harness/seed'

let app: E2EApp
/** 项目会话用的项目 —— `default` 是**项目会话**的基座，覆盖断言必须落在项目会话上 */
let projectId: string

beforeAll(async () => {
  app = await launchApp()
  const path = join(app.home, 'registry-proj')
  mkdirSync(path, { recursive: true })
  projectId = (await createProject(app.main, { name: 'RegistryProj', path })).id
})
afterAll(async () => {
  await app.stop()
})

interface AgentRow {
  name: string
  source: 'builtin' | 'user'
  description: string
  instructionFiles: string[]
  projectAwareness: boolean
  sessionAwareness: boolean
  overridden?: boolean
}

const listAgents = (): Promise<AgentRow[]> => app.main.eval('window.api.subAgent.list()')

describe('内置档案', () => {
  it('十二个内置齐全，上下文注入默认全开（notebook 只开项目感知、派发专用档案全关），描述非空；无启用开关字段', async () => {
    const builtins = (await listAgents()).filter((a) => a.source === 'builtin')
    // bot-notes 随「笔记」这个概念一并退场（v3）：bot 自己维护自己的正文，
    // 由任务段槽位里那份普通 agent 用文件工具就地改，没有专职的笔记段了
    expect(builtins.map((a) => a.name).sort()).toEqual([
      'bot-intent',
      'browser',
      'chat',
      'coding',
      'default',
      'explore',
      'notebook',
      'titler',
      'visualization',
      'widget',
      'wiki',
      'wiki-writer'
    ])
    // 派发专用的窄档案两样都不要：AGENTS.md/CLAUDE.md 是写代码的工程约定，
    // 而给一条聊天消息定意图（bot-intent）、拟一个标题（titler）都不是工程活，
    // 项目上下文对它们只是噪声
    const narrow = ['titler', 'bot-intent']
    for (const a of builtins) {
      // notebook 是笔记本会话根 Agent 的基座：开项目感知（笔记就写在项目里），但不吃指令文件
      const instructionsOn = a.name !== 'notebook' && !narrow.includes(a.name)
      const awarenessOn = !narrow.includes(a.name)
      // 指令文件清单顺序即优先级 —— 内置沿用改制前的 AGENTS.md 优先、CLAUDE.md 次之
      expect(a.instructionFiles, a.name).toEqual(instructionsOn ? ['AGENTS.md', 'CLAUDE.md'] : [])
      expect(a.projectAwareness, a.name).toBe(awarenessOn)
      // 会话感知 = 用户能否在输入框把会话切成它。派发专用的执行体一律不声明：
      // 三个窄档案，外加 wiki-writer（写入政策的有效性依赖每次派发都是新鲜上下文）
      const switchable = !narrow.includes(a.name) && a.name !== 'wiki-writer'
      expect(a.sessionAwareness, a.name).toBe(switchable)
      expect(a.description.length, a.name).toBeGreaterThan(0)
      expect('isEnabled' in a, a.name).toBe(false)
    }
  })
})

describe('default 覆盖（用户同名档案）', () => {
  it('覆盖后：设置页两行并存（内置带 overridden），运行时用覆盖 body', async () => {
    writeAgentMd(app, 'default', {
      description: 'my override',
      tools: 'read',
      body: 'OVERRIDE BODY.'
    })
    const rows = (await listAgents()).filter((a) => a.name === 'default')
    expect(rows.map((r) => [r.source, !!r.overridden]).sort()).toEqual([
      ['builtin', true],
      ['user', false]
    ])
    const { systemPrompt } = await createAgentSession(app.main, { projectId })
    expect(systemPrompt.startsWith('OVERRIDE BODY.')).toBe(true)
  })

  it('删除覆盖档案：内置恢复单行、无 overridden；新会话回到内置 body', async () => {
    const res = await app.main.eval<{ success: boolean }>(
      `window.api.subAgent.delete({ name: 'default' })`
    )
    expect(res.success).toBe(true)
    const rows = (await listAgents()).filter((a) => a.name === 'default')
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('builtin')
    expect(rows[0].overridden).toBeFalsy()
    const { systemPrompt } = await createAgentSession(app.main, { projectId })
    expect(systemPrompt.startsWith('OVERRIDE BODY.')).toBe(false)
  })
})

/**
 * 与上面 default 那两条对称 —— `chat` 是**不归属项目**的会话的基座，所以这里的会话
 * 必须**不带 projectId**（上面两条正相反）。覆盖链上刚发生过一批连带改动
 * （getProfile 的内置兜底扩到全部基座名、builtinProfiles 的按名合并），而 default
 * 有 e2e 守着、chat 一条都没有。
 */
describe('chat 覆盖（用户同名档案）', () => {
  it('覆盖后：设置页两行并存（内置带 overridden），无项目会话用覆盖 body', async () => {
    writeAgentMd(app, 'chat', {
      description: 'my chat override',
      tools: 'read',
      body: 'CHAT OVERRIDE.'
    })
    const rows = (await listAgents()).filter((a) => a.name === 'chat')
    expect(rows.map((r) => [r.source, !!r.overridden]).sort()).toEqual([
      ['builtin', true],
      ['user', false]
    ])
    const { systemPrompt } = await createAgentSession(app.main)
    expect(systemPrompt.startsWith('CHAT OVERRIDE.')).toBe(true)
  })

  it('删除覆盖档案：内置恢复单行、无 overridden；新会话回到内置 body', async () => {
    const res = await app.main.eval<{ success: boolean }>(
      `window.api.subAgent.delete({ name: 'chat' })`
    )
    expect(res.success).toBe(true)
    const rows = (await listAgents()).filter((a) => a.name === 'chat')
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('builtin')
    expect(rows[0].overridden).toBeFalsy()
    const { systemPrompt } = await createAgentSession(app.main)
    expect(systemPrompt.startsWith('CHAT OVERRIDE.')).toBe(false)
  })
})
