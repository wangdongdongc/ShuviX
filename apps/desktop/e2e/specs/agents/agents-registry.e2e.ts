/**
 * 档案注册表语义（IPC 层）：内置全集与默认开关、同名覆盖（展示标记 + 运行时生效 + 删除恢复）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createAgentSession, writeAgentMd } from '../../harness/seed'

let app: E2EApp

beforeAll(async () => {
  app = await launchApp()
})
afterAll(async () => {
  await app.stop()
})

interface AgentRow {
  name: string
  source: 'builtin' | 'user'
  description: string
  instructionFiles: string[]
  projectPrompt: boolean
  overridden?: boolean
}

const listAgents = (): Promise<AgentRow[]> => app.main.eval('window.api.subAgent.list()')

describe('内置档案', () => {
  it('八个内置齐全，上下文注入默认全开（notebook 除外），描述非空；无启用开关字段', async () => {
    const builtins = (await listAgents()).filter((a) => a.source === 'builtin')
    expect(builtins.map((a) => a.name).sort()).toEqual([
      'coding',
      'default',
      'explore',
      'notebook',
      'visualization',
      'widget',
      'wiki',
      'wiki-writer'
    ])
    for (const a of builtins) {
      // notebook 是笔记本一次性子代理的基座，两项注入刻意默认关（维持迁移前行为）
      const expected = a.name !== 'notebook'
      // 指令文件清单顺序即优先级 —— 内置沿用改制前的 AGENTS.md 优先、CLAUDE.md 次之
      expect(a.instructionFiles, a.name).toEqual(expected ? ['AGENTS.md', 'CLAUDE.md'] : [])
      expect(a.projectPrompt, a.name).toBe(expected)
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
    const { systemPrompt } = await createAgentSession(app.main)
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
    const { systemPrompt } = await createAgentSession(app.main)
    expect(systemPrompt.startsWith('OVERRIDE BODY.')).toBe(false)
  })
})
