/**
 * 笔记本会话的根 Agent —— notebook 基座档案的端到端语义：
 *
 *   - 创建即钉死 notebook 档案：systemPrompt 内嵌 settings.notebookPath 原文
 *     （{{shuvix:notebookPath}} 是 root 级变量），工具白名单取自 builtin notebook md；
 *   - 发送走普通 agent.prompt 管线，用户消息持久化到会话树；
 *   - updateAgentProfile 对笔记本会话一律 pinned 拒绝，设置与运行时分毫不动；
 *   - 非笔记本会话引用 {{shuvix:notebookPath}} 替换为空串（不是残留占位符）；
 *   - `~/.shuvix/agents/notebook.md` 按名覆盖 builtin，对新笔记本会话生效。
 *
 * 断言全走 IPC（window.api.*），无 DOM；不种任何模型/提供商 —— 运行时创建与
 * prompt 前副作用都不需要 LLM 真正应答。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
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
/** 首个用例建的笔记本会话，工具白名单 / 钉死用例复用它 */
let nbSid: string

/** settings.notebookPath 原文（相对项目根）—— 变量替换取它原样，不做绝对化 */
const NOTE_REL = 'notes/e2e-note.md'

const runtimeInfo = (sid: string): Promise<{ systemPrompt: string; tools: { name: string }[] }> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`)

beforeAll(async () => {
  app = await launchApp()
  const projDir = join(app.home, 'proj-notebook-agent')
  mkdirSync(join(projDir, 'notes'), { recursive: true })
  writeFileSync(join(projDir, 'notes', 'e2e-note.md'), '# E2E note\n\nSeed body.\n')
  const project = await createProject(app.main, { name: 'NotebookAgentProj', path: projDir })
  projectId = project.id
})
afterAll(async () => {
  await app.stop()
})

describe('笔记本会话的根 Agent', () => {
  it('systemPrompt 内嵌 notebookPath 原文，{{shuvix:*}} 全部替换干净', async () => {
    const res = await createAgentSession(app.main, { projectId, notebookPath: NOTE_REL })
    nbSid = res.sid
    expect(res.systemPrompt).toContain(NOTE_REL)
    expect(res.systemPrompt).not.toContain('{{shuvix:')
  })

  it('工具白名单来自 notebook 档案：含 ask、不含 agent / database', async () => {
    const names = (await runtimeInfo(nbSid)).tools.map((t) => t.name)
    expect(names).toContain('ask')
    expect(names).not.toContain('agent')
    expect(names).not.toContain('database')
  })

  it('发送走普通 prompt 管线：用户消息持久化到会话树', async () => {
    const { sid } = await createAgentSession(app.main, { projectId, notebookPath: NOTE_REL })
    const before = await app.main.eval<unknown[]>(`window.api.message.list(${JSON.stringify(sid)})`)
    expect(before).toEqual([])

    const messages = (await promptAndListMessages(app.main, sid, 'notebook e2e hello')) as Array<{
      role?: string
      content?: unknown
    }>
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(messages.some((m) => m.role === 'user' && m.content === 'notebook e2e hello')).toBe(true)
  })

  it('updateAgentProfile 被 pinned 拒绝：设置不落、systemPrompt 仍是笔记本档案', async () => {
    const res = await app.main.eval<{ success: boolean; error?: string }>(
      `window.api.session.updateAgentProfile({ id: ${JSON.stringify(nbSid)}, name: 'coding' })`
    )
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/pinned/)

    const settings = await app.main.eval<{ agentProfile?: string }>(
      `window.api.session.getById(${JSON.stringify(nbSid)}).then((s) => s.settings)`
    )
    expect(settings.agentProfile).toBeUndefined()
    expect((await runtimeInfo(nbSid)).systemPrompt).toContain(NOTE_REL)
  })
})

describe('非笔记本会话的 {{shuvix:notebookPath}}', () => {
  it('普通会话引用它：替换为空串（标记对可见，无残留占位符）', async () => {
    writeAgentMd(app, 'nb-probe', {
      description: 'probe',
      tools: 'read',
      body: 'NB PROBE nb=[{{shuvix:notebookPath}}] end.'
    })
    const { sid } = await createAgentSession(app.main)
    const switched = await app.main.eval<{ success: boolean }>(
      `window.api.session.updateAgentProfile({ id: ${JSON.stringify(sid)}, name: 'nb-probe' })`
    )
    expect(switched.success).toBe(true)

    const { systemPrompt } = await runtimeInfo(sid)
    expect(systemPrompt).toContain('nb=[] end.')
    expect(systemPrompt).not.toContain('{{shuvix:notebookPath}}')
  })
})

describe('用户覆盖 notebook 档案', () => {
  it('~/.shuvix/agents/notebook.md 按名覆盖 builtin，对新笔记本会话生效', async () => {
    writeAgentMd(app, 'notebook', {
      description: 'ovr',
      tools: 'read, ask',
      body: 'NOTEBOOK OVERRIDE nb={{shuvix:notebookPath}}'
    })
    try {
      const { systemPrompt } = await createAgentSession(app.main, {
        projectId,
        notebookPath: NOTE_REL
      })
      expect(systemPrompt.startsWith(`NOTEBOOK OVERRIDE nb=${NOTE_REL}`)).toBe(true)
    } finally {
      await app.main.eval(`window.api.subAgent.delete({ name: 'notebook' })`)
    }
  })
})
