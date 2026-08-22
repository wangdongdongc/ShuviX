/**
 * 上下文注入（append 进系统提示词）：顺序（body → 指令文件 → 项目提示词）、
 * 不落独立消息、环境变量零泄漏、切换指令文件经失效重建生效。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createAgentSession, createProject, promptAndListMessages } from '../../harness/seed'

let app: E2EApp
let projectId: string
let projDir: string

beforeAll(async () => {
  app = await launchApp()
  projDir = join(app.home, 'proj-inject')
  mkdirSync(projDir, { recursive: true })
  writeFileSync(join(projDir, 'AGENTS.md'), 'AGENT RULES CONTENT.')
  writeFileSync(join(projDir, 'CLAUDE.md'), 'CLAUDE RULES CONTENT.')
  const project = await createProject(app.main, {
    name: 'InjProj',
    path: projDir,
    systemPrompt: 'HAIKU MODE ONLY.',
    envVars: [{ key: 'SECRET_FOO', value: 'v' }]
  })
  projectId = project.id
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

  it('切换指令文件 → 失效重建 → 新系统提示词用 CLAUDE.md（AGENTS.md 内容消失）', async () => {
    await app.main.eval(
      `window.api.session.updateInstructionFile({ id: ${JSON.stringify(sid)}, filename: 'CLAUDE.md' })`
    )
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
