/**
 * 笔记本会话的根 Agent —— notebook 基座档案的端到端语义：
 *
 *   - 笔记本会话恒为 notebook 档案（由会话形态推导）：systemPrompt 内嵌 settings.notebookPath
 *     原文（{{shuvix:notebookPath}} 是 root 级变量），工具白名单取自 builtin notebook md；
 *   - 发送走普通 agent.prompt 管线，用户消息持久化到会话树；
 *   - settings 里没有 agentProfile 键；哪怕直写一个戳（coding），笔记本判定先于戳、根会话
 *     也不读戳，重建后仍是笔记本档案；
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
  stampAgentProfile,
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

  it('工具白名单来自 notebook 档案：含 ask、不含 agent / knowledge / session，也没有数据库', async () => {
    const names = (await runtimeInfo(nbSid)).tools.map((t) => t.name)
    expect(names).toContain('ask')
    expect(names).not.toContain('agent')
    expect(names).not.toContain('knowledge')
    expect(names).not.toContain('session')
    // 数据库是按会话勾选的内置 MCP 能力服务器：notebook 档案不声明它、这条会话也没勾；
    // 退役的内置工具名 database 不再存在（这一条对任何会话都成立，留着防它回来）
    expect(names.filter((n) => n.startsWith('mcp__database__'))).toEqual([])
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

  it('settings 无 agentProfile；直写一个戳（coding）并重建 → 仍是笔记本档案（判定先于戳，根会话也不读戳）', async () => {
    const settings = await app.main.eval<{ agentProfile?: string }>(
      `window.api.session.getById(${JSON.stringify(nbSid)}).then((s) => s.settings)`
    )
    expect(settings.agentProfile).toBeUndefined()

    // 会话内切换已下线，戳只能这样造出来（唯一的写入口是子会话的 pinAgentProfile）
    await stampAgentProfile(app, nbSid, 'coding')
    await app.main.eval(`window.api.message.clear(${JSON.stringify(nbSid)})`)
    const { systemPrompt } = await runtimeInfo(nbSid)
    expect(systemPrompt).toContain(NOTE_REL)
    // coding 正文里的一句 —— 戳若被读了，这里会是 coding 的 body
    expect(systemPrompt).not.toContain('Only do what the user asked')
  })
})

describe('非笔记本会话的 {{shuvix:notebookPath}}', () => {
  it('普通会话引用它：替换为空串（标记对可见，无残留占位符）', async () => {
    // 根会话的档案不可切换：覆盖无项目会话的基座 chat.md 来引用这个变量（prompt-vars.e2e 同款手法）
    writeAgentMd(app, 'chat', {
      description: 'probe',
      tools: 'read',
      body: 'NB PROBE nb=[{{shuvix:notebookPath}}] end.'
    })
    try {
      const { systemPrompt } = await createAgentSession(app.main)
      expect(systemPrompt).toContain('nb=[] end.')
      expect(systemPrompt).not.toContain('{{shuvix:notebookPath}}')
    } finally {
      await app.main.eval(`window.api.subAgent.delete({ name: 'chat' })`)
    }
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
