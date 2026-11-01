/**
 * {{shuvix:*}} 变量表：标量替换、空块收敛、未知占位符保留、项目会话取值；「临时文件」那一行
 * （主进程启动时注入的会话临时目录解析器 —— 单测替身够不到这处接线）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { platform } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import { createAgentSession, createProject, writeAgentMd } from '../../harness/seed'

let app: E2EApp

beforeAll(async () => {
  app = await launchApp()
})
afterAll(async () => {
  await app.stop()
})

describe('内置基座 body 的变量替换', () => {
  it('无项目会话（chat 基座）：已知变量全替换、空块收敛、无残留占位符', async () => {
    const { systemPrompt: sp } = await createAgentSession(app.main)
    expect(sp).not.toContain('{{shuvix:')
    expect(sp).toContain(`Platform: ${platform()}`)
    // 提示词里的日期是**本地**日期（agent-runtime dateNotice 的写法）；toISOString 是 UTC，在美西的
    // 17:00–24:00 两者差一天，这条曾因此每晚失败
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    expect(sp).toContain(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)
    expect(sp).toMatch(/\n- Working directory: \//)
    expect(sp).not.toMatch(/\n{3,}/)
    expect(sp).toBe(sp.trim())
  })

  it('「临时文件」一行：紧跟工作目录那一行，路径是本会话的临时目录、已经建好（启动时注入的解析器接上了）', async () => {
    const { sid, systemPrompt: sp } = await createAgentSession(app.main)
    // chat 基座带 bash：那一行连「命令的临时目录也是它」一起说
    const line = sp.match(
      /^- Temporary files: `([^`]+)` — .*, also its commands' temp directory\./m
    )
    expect(line, sp).not.toBeNull()
    const dir = line![1]
    if (process.platform === 'darwin') {
      expect(sp).toMatch(
        /^- Temporary files: `\/private\/tmp\/shuvix-\d+\/[0-9a-f]{8}` — .*, also its commands' temp directory\./m
      )
    }
    // 是这条会话自己的那一个（目录名按会话 id 算）
    expect(basename(dir)).toBe(createHash('sha256').update(sid).digest('hex').slice(0, 8))
    expect(existsSync(dir)).toBe(true)
    // 环境清单里紧跟工作目录那一行
    expect(sp).toMatch(/\n- Working directory: [^\n]+\n- Temporary files: `/)
  })

  it('项目会话（work 基座）：workingDirectory=项目路径、git 检测生效', async () => {
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
    // 覆盖 chat：这条断言用的是**无项目**会话，它的基座是 chat 而非 work
    writeAgentMd(app, 'chat', {
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
      await app.main.eval(`window.api.subAgent.delete({ name: 'chat' })`)
    }
  })
})
