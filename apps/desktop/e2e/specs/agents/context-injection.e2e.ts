/**
 * 上下文注入（append 进系统提示词）：顺序（body → 指令文件 → 项目提示词）、
 * 不落独立消息、环境变量零泄漏、换一份指令文件清单经失效重建生效。
 *
 * 「读哪个指令文件」由 agent 档案的 `shuvix-instruction-files` 清单决定（顺序即优先级），
 * 不再有会话级单选 —— 故换文件 = 换档案。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createAgentSession,
  createProject,
  promptAndListMessages,
  writeAgentMd
} from '../../harness/seed'

let app: E2EApp
let projectId: string
let projDir: string

beforeAll(async () => {
  app = await launchApp()
  projDir = join(app.home, 'proj-inject')
  mkdirSync(join(projDir, 'docs'), { recursive: true })
  writeFileSync(join(projDir, 'AGENTS.md'), 'AGENT RULES CONTENT.')
  writeFileSync(join(projDir, 'CLAUDE.md'), 'CLAUDE RULES CONTENT.')
  // 存在但纯空白：降级链里「命中了文件也不算命中」的那一档
  writeFileSync(join(projDir, 'EMPTY.md'), '   \n')
  writeFileSync(join(projDir, 'docs', 'house.md'), 'HOUSE RULES CONTENT.')
  const project = await createProject(app.main, {
    name: 'InjProj',
    path: projDir,
    systemPrompt: 'HAIKU MODE ONLY.',
    envVars: [{ key: 'SECRET_FOO', value: 'v' }]
  })
  projectId = project.id
  // 只认 CLAUDE.md 的档案：证明清单是唯一的选取依据（AGENTS.md 同样在盘上，但没被列出）
  writeAgentMd(app, 'claude-only', {
    tools: 'read',
    instructionFiles: 'CLAUDE.md',
    body: 'CLAUDE-ONLY BODY.'
  })
  // 同样两份文件、只有清单顺序不同 —— 「顺序即优先级」的端到端对照组
  writeAgentMd(app, 'pref-claude', {
    tools: 'read',
    instructionFiles: 'CLAUDE.md, AGENTS.md',
    body: 'PREF BODY.'
  })
  writeAgentMd(app, 'pref-agents', {
    tools: 'read',
    instructionFiles: 'AGENTS.md, CLAUDE.md',
    body: 'PREF BODY.'
  })
  // 降级链：缺失 → 空白 → 命中
  writeAgentMd(app, 'fallback-chain', {
    tools: 'read',
    instructionFiles: 'MISSING.md, EMPTY.md, CLAUDE.md',
    body: 'FALLBACK BODY.'
  })
  // 子目录条目
  writeAgentMd(app, 'subdir-house', {
    tools: 'read',
    instructionFiles: 'docs/house.md',
    body: 'SUBDIR BODY.'
  })
})
afterAll(async () => {
  await app.stop()
})

describe('append 注入', () => {
  let sid: string

  it('系统提示词按序含：body 环境块 → 指令文件（AGENTS.md 优先） → 项目提示词', async () => {
    const created = await createAgentSession(app.main, { projectId })
    sid = created.sid
    const sp = created.systemPrompt
    const iEnv = sp.indexOf('Working directory:')
    const iIns = sp.indexOf('<project_instructions file="AGENTS.md">')
    const iRules = sp.indexOf('AGENT RULES CONTENT.')
    const iInsEnd = sp.indexOf('</project_instructions>')
    const iProj = sp.indexOf('<project_prompt>')
    const iHaiku = sp.indexOf('HAIKU MODE ONLY.')
    const iProjEnd = sp.indexOf('</project_prompt>')
    expect(iEnv).toBeGreaterThan(-1)
    expect(iIns).toBeGreaterThan(iEnv)
    expect(iRules).toBeGreaterThan(iIns)
    expect(iInsEnd).toBeGreaterThan(iRules)
    expect(iProj).toBeGreaterThan(iInsEnd)
    expect(iHaiku).toBeGreaterThan(iProj)
    expect(iProjEnd).toBeGreaterThan(iHaiku)
  })

  it('prompt 后消息树无注入消息；项目环境变量零泄漏', async () => {
    const messages = await promptAndListMessages(app.main, sid)
    expect(messages.filter((m) => m.metadata?.isInstructionInjection)).toHaveLength(0)
    const all = JSON.stringify(messages)
    expect(all).not.toContain('SECRET_FOO')
    expect(all).not.toContain('Project environment variables')
  })

  it('切到只列 CLAUDE.md 的档案 → 失效重建 → 指令文件换成 CLAUDE.md（AGENTS.md 内容消失）', async () => {
    const res = await app.main.eval<{ success: boolean }>(
      `window.api.session.updateAgentProfile({ id: ${JSON.stringify(sid)}, name: 'claude-only' })`
    )
    expect(res.success).toBe(true)
    const sp = await app.main.eval<string>(
      `window.api.agent
        .getInfo(${JSON.stringify(sid)}, { ensure: true })
        .then((info) => info.systemPrompt)`
    )
    expect(sp).toContain('<project_instructions file="CLAUDE.md">')
    expect(sp).toContain('CLAUDE RULES CONTENT.')
    expect(sp).not.toContain('AGENT RULES CONTENT.')
  })
})

/**
 * 清单本身的选取规则（顺序 / 降级 / 子目录），端到端一路走到 `agent.getInfo` 的
 * systemPrompt —— 单测钉的是解析器，这里钉的是「档案里写的那串字，最后真的按这个顺序生效」。
 */
describe('指令文件清单', () => {
  let sid: string

  /** 切档案 → 失效重建 → 取重建后的完整系统提示词（无 LLM 调用） */
  const switchTo = async (name: string): Promise<string> => {
    const res = await app.main.eval<{ success: boolean }>(
      `window.api.session.updateAgentProfile({ id: ${JSON.stringify(sid)}, name: ${JSON.stringify(name)} })`
    )
    expect(res.success, `switch to ${name}`).toBe(true)
    return app.main.eval<string>(
      `window.api.agent
        .getInfo(${JSON.stringify(sid)}, { ensure: true })
        .then((info) => info.systemPrompt)`
    )
  }

  beforeAll(async () => {
    sid = (await createAgentSession(app.main, { projectId, title: 'e2e-list' })).sid
  })

  it('IF-E-1 顺序即优先级：同样两份文件在盘上，命中随清单顺序翻转', async () => {
    const claudeFirst = await switchTo('pref-claude')
    expect(claudeFirst).toContain('<project_instructions file="CLAUDE.md">')
    expect(claudeFirst).toContain('CLAUDE RULES CONTENT.')
    expect(claudeFirst).not.toContain('AGENT RULES CONTENT.')

    const agentsFirst = await switchTo('pref-agents')
    expect(agentsFirst).toContain('<project_instructions file="AGENTS.md">')
    expect(agentsFirst).toContain('AGENT RULES CONTENT.')
    expect(agentsFirst).not.toContain('CLAUDE RULES CONTENT.')
  })

  it('IF-E-2 降级链：缺失的跳过、纯空白的也跳过，落到第三条 CLAUDE.md', async () => {
    const sp = await switchTo('fallback-chain')
    expect(sp).toContain('<project_instructions file="CLAUDE.md">')
    expect(sp).toContain('CLAUDE RULES CONTENT.')
    // 空文件不该以「命中但空围栏」的形式出现
    expect(sp).not.toContain('file="EMPTY.md"')
    expect(sp).not.toContain('file="MISSING.md"')
  })

  it('IF-E-3 子目录条目：围栏的 file= 原样是 docs/house.md（正斜杠不被改写）', async () => {
    const sp = await switchTo('subdir-house')
    expect(sp).toContain('<project_instructions file="docs/house.md">')
    expect(sp).toContain('HOUSE RULES CONTENT.')
  })
})

describe('布尔存量档案', () => {
  it('IF-E-5 `shuvix-instruction-files: true` 整份被判非法：该档案不出现在列表里，邻居照常', async () => {
    // 改制前的写法（开关而非清单）。解析器判整份非法 → 扫描静默跳过：
    // 「不生效也不遮蔽内置」是有意设计，但它必须只连累自己这一份文件
    writeAgentMd(app, 'legacy-bool', {
      tools: 'read',
      rawLines: ['shuvix-instruction-files: true'],
      body: 'LEGACY BOOL BODY.'
    })

    const names = await app.main.eval<string[]>(
      `window.api.subAgent.list().then((rows) => rows.map((r) => r.name))`
    )
    expect(names).not.toContain('legacy-bool')
    expect(names).toContain('pref-claude')
    expect(names).toContain('subdir-house')
  })
})

describe('会话级选取项已下线', () => {
  it('IF-E-6 session IPC 面上不再有 scanInstructionFiles / updateInstructionFile', async () => {
    const keys = await app.main.eval<string[]>('Object.keys(window.api.session)')
    expect(keys).not.toContain('scanInstructionFiles')
    expect(keys).not.toContain('updateInstructionFile')
    // 面本身还在（不是因为 window.api.session 整个没了才「不含」）
    expect(keys).toContain('updateAgentProfile')
  })
})

/**
 * 覆盖 default 但**省略** `shuvix-instruction-files` = 不注入。
 *
 * 独立 describe + 自清理：这条会往 `~/.shuvix/agents/default.md` 落一份覆盖档案，
 * 它对同实例后续所有新会话都生效，漏删就会把别的用例带成「无端不注入」。
 */
describe('覆盖 default 的清单省略语义', () => {
  const defaultMd = (): string => join(app.agentsDir, 'default.md')

  afterAll(() => {
    rmSync(defaultMd(), { force: true })
  })

  it('IF-E-4 省略键 → 新会话零注入；删掉覆盖档案 → 内置清单恢复生效', async () => {
    writeAgentMd(app, 'default', { tools: 'read', body: 'NO-INJECTION DEFAULT BODY.' })

    const overridden = await createAgentSession(app.main, { projectId, title: 'e2e-no-inject' })
    expect(overridden.systemPrompt.startsWith('NO-INJECTION DEFAULT BODY.')).toBe(true)
    expect(overridden.systemPrompt).not.toContain('<project_instructions')
    expect(overridden.systemPrompt).not.toContain('AGENT RULES CONTENT.')

    const res = await app.main.eval<{ success: boolean }>(
      `window.api.subAgent.delete({ name: 'default' })`
    )
    expect(res.success).toBe(true)

    const restored = await createAgentSession(app.main, { projectId, title: 'e2e-reinject' })
    expect(restored.systemPrompt).toContain('<project_instructions file="AGENTS.md">')
    expect(restored.systemPrompt).toContain('AGENT RULES CONTENT.')
  })
})
