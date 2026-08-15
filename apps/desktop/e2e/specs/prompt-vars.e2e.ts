/**
 * {{shuvix:*}} 变量表：标量替换、空块收敛、未知占位符保留、项目会话取值。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../harness/launch'
import { createAgentSession, createProject, writeAgentMd } from '../harness/seed'

let app: E2EApp

beforeAll(async () => {
  app = await launchApp()
})
afterAll(async () => {
  await app.stop()
})

describe('内置 default body 的变量替换', () => {
  it('无项目会话：已知变量全替换、空块收敛、无残留占位符', async () => {
    const { systemPrompt: sp } = await createAgentSession(app.main)
    expect(sp).not.toContain('{{shuvix:')
    expect(sp).toContain(`Platform: ${platform()}`)
    expect(sp).toContain(new Date().toISOString().slice(0, 10))
    expect(sp).toMatch(/\n- Working directory: \//)
    expect(sp).not.toMatch(/\n{3,}/)
    expect(sp).toBe(sp.trim())
  })

  it('项目会话：workingDirectory=项目路径、git 检测生效', async () => {
    const projDir = join(app.home, 'proj-vars')
    mkdirSync(join(projDir, '.git'), { recursive: true })
    const project = await createProject(app.main, { name: 'VarsProj', path: projDir })
    const { systemPrompt: sp } = await createAgentSession(app.main, { projectId: project.id })
    expect(sp).toContain(`- Working directory: ${projDir}\n`)
    expect(sp).toMatch(/: Yes\n/)
    expect(sp).not.toContain('{{shuvix:')
  })
})

describe('用户档案里的占位符', () => {
  it('已知变量替换；未知占位符原样保留（typo 可见）', async () => {
    writeAgentMd(app, 'default', {
      description: 'ovr',
      tools: 'read',
      body: 'OVR dir={{shuvix:workingDirectory}} plat={{shuvix:platform}} bad={{shuvix:typo}}'
    })
    try {
      const { systemPrompt: sp } = await createAgentSession(app.main)
      expect(sp.startsWith('OVR dir=/')).toBe(true)
      expect(sp).toContain(`plat=${platform()}`)
      expect(sp).toContain('bad={{shuvix:typo}}')
    } finally {
      await app.main.eval(`window.api.subAgent.delete({ name: 'default' })`)
    }
  })
})
