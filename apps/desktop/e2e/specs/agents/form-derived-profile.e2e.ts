/**
 * 会话根 Agent 的档案**由会话形态推导**（端到端，全走 IPC，零 LLM）：
 *   - 无项目会话 → chat 基座，项目会话 → work 基座；两者的 settings 都没有 agentProfile 键；
 *   - 覆盖 ~/.shuvix/agents/work.md 只影响项目会话，无项目会话仍是 chat（两条路线不串）；
 *   - 根会话上残留的戳（含旧基座名 default）被忽略、不迁移、不清洗；
 *   - 子会话（parentId 非空）的戳生效：systemPrompt 换成该档案 body、内置工具收窄；档案被删
 *     回落**父形态**基座、重写后恢复；无戳子会话随父形态；
 *   - IPC 面没有 listAgentProfiles / updateAgentProfile；残留的 general.defaultChatAgent 设置无效；
 *   - 斜杠命令源没有 agent 项；
 *   - tools.list(sid) 的 defaultEnabled 随推导档案（含用户覆盖 chat.md）。
 *
 * 戳用 sqlite 直写（seed.ts#stampAgentProfile）：今天唯一会写 settings.agentProfile 的入口是
 * session 工具的 create-sub-session（sessions/sub-session-profile.e2e 打那条链），这里只要
 * 「带戳的行」给推导用。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createAgentSession,
  createBotSession,
  createPinnedChildSession,
  createProject,
  stampAgentProfile,
  writeAgentMd,
  writeBotMd
} from '../../harness/seed'

let app: E2EApp
let projectId: string

/** work 基座独有的两处锚点（chat 的 body 两者皆无 —— 两份 body 工具面相同，差异全在文案） */
const WORK_ANCHORS = ['Handing work to a sub-session', 'create-sub-session']
/** coding 正文独有的一句（work / chat 都没有它；"Only do what the user asked" 三份都有，不能用）—— 「戳没被读」的反向锚点 */
const CODING_ANCHOR = 'under the guise of'
const PINNED = 'e2e-pinned'
const PINNED_BODY = 'PINNED BODY.'
const NOTE_REL = 'notes/fd-note.md'

beforeAll(async () => {
  app = await launchApp()
  // 任何非基座档案都可作子会话的档案（没有开关要写）
  writeAgentMd(app, PINNED, { description: '可作子会话档案', tools: 'read', body: PINNED_BODY })
  const projDir = join(app.home, 'fd-proj')
  mkdirSync(join(projDir, 'notes'), { recursive: true })
  writeFileSync(join(projDir, 'notes', 'fd-note.md'), '# FD note\n')
  projectId = (await createProject(app.main, { name: 'FormProj', path: projDir })).id
  writeBotMd(app, 'fd-bot', { description: 'form-derived probe bot' })
})
afterAll(async () => {
  await app.stop()
})

interface RuntimeInfo {
  systemPrompt: string
  tools: { name: string }[]
}

/** 运行时快照（getInfo ensure=true 走懒创建，不请求 LLM） */
const runtimeInfo = (sid: string): Promise<RuntimeInfo | null> =>
  app.main.eval(`window.api.agent.getInfo(${JSON.stringify(sid)}, { ensure: true })`)

const settingsOf = (sid: string): Promise<Record<string, unknown>> =>
  app.main.eval(`window.api.session.getById(${JSON.stringify(sid)}).then((s) => s.settings)`)

/** 经 IPC 建会话（不 ensure —— 戳要写在运行时首次创建之前） */
const createSession = (params: Record<string, unknown>): Promise<string> =>
  app.main.eval(`window.api.session.create(${JSON.stringify(params)}).then((s) => s.id)`)

/** 失效重建：删档案 / 改戳都不会自动 invalidate，下一次 ensure 才按新状态解析 */
const clearRuntime = (sid: string): Promise<unknown> =>
  app.main.eval(`window.api.message.clear(${JSON.stringify(sid)})`)

const stamp = (sid: string, name: string): Promise<void> => stampAgentProfile(app, sid, name)

const deleteAgent = (name: string): Promise<{ success: boolean }> =>
  app.main.eval(`window.api.subAgent.delete({ name: ${JSON.stringify(name)} })`)

const expectWorkBody = (sp: string): void => {
  for (const anchor of WORK_ANCHORS) expect(sp).toContain(anchor)
  expect(sp.startsWith(PINNED_BODY)).toBe(false)
}
const expectChatBody = (sp: string): void => {
  for (const anchor of WORK_ANCHORS) expect(sp).not.toContain(anchor)
  expect(sp).not.toContain(CODING_ANCHOR)
  expect(sp.startsWith(PINNED_BODY)).toBe(false)
}

describe('两条路线由会话形态决定', () => {
  it('FD-1 无项目会话拿到 chat body、项目会话拿到 work body，两者的 settings 都没有 agentProfile 键', async () => {
    // 单测只到「推导出哪个名字」为止，从名字到真正发给 LLM 的提示词还有三跳（resolve →
    // getProfile → createAgent），任何一跳丢掉 profileName 单测依旧全绿
    const chat = await createAgentSession(app.main)
    expectChatBody(chat.systemPrompt)
    expect('agentProfile' in (await settingsOf(chat.sid))).toBe(false)

    const proj = await createAgentSession(app.main, { projectId })
    expectWorkBody(proj.systemPrompt)
    expect('agentProfile' in (await settingsOf(proj.sid))).toBe(false)
  })

  it('FD-2 覆盖 work.md 只影响项目会话：新项目会话以覆盖 body 开头，新无项目会话仍是 chat', async () => {
    // 覆盖的正反两面在 agents-registry.e2e；这里钉的是「不串到另一条路线」
    writeAgentMd(app, 'work', { description: 'ovr', tools: 'read', body: 'WORK OVERRIDE.' })
    try {
      const proj = await createAgentSession(app.main, { projectId })
      expect(proj.systemPrompt.startsWith('WORK OVERRIDE.')).toBe(true)

      const chat = await createAgentSession(app.main)
      expect(chat.systemPrompt.startsWith('WORK OVERRIDE.')).toBe(false)
      expectChatBody(chat.systemPrompt)
    } finally {
      expect(await deleteAgent('work')).toEqual({ success: true })
    }
  })
})

describe('根会话残留的戳被忽略、不迁移', () => {
  it('FD-3 无项目根会话戳 e2e-pinned / 旧基座名 default，项目根会话戳 coding：一律按形态，戳原样留着', async () => {
    // 改制前「会话内切换」写下的戳是遗留数据：项目会话就是 work、无项目会话就是 chat。
    // 谁在 resolveAgentProfileName 里把「只有子会话读戳」那个条件删掉，这里会拿到 PINNED BODY
    const chatSid = await createSession({ title: 'fd-stamped-chat' })
    await stamp(chatSid, PINNED)
    const first = await runtimeInfo(chatSid)
    expect(first).not.toBeNull()
    expectChatBody(first!.systemPrompt)

    // 旧基座名不报错：既不是可解析的档案也不该让运行时建不出来
    await stamp(chatSid, 'default')
    await clearRuntime(chatSid)
    const second = await runtimeInfo(chatSid)
    expect(second).not.toBeNull()
    expectChatBody(second!.systemPrompt)
    // 不清洗、不迁移
    expect((await settingsOf(chatSid)).agentProfile).toBe('default')

    const projSid = await createSession({ title: 'fd-stamped-proj', projectId })
    await stamp(projSid, 'coding')
    const proj = await runtimeInfo(projSid)
    expectWorkBody(proj!.systemPrompt)
    expect(proj!.systemPrompt).not.toContain(CODING_ANCHOR)
    expect((await settingsOf(projSid)).agentProfile).toBe('coding')
  })
})

describe('子会话（parentId 非空）才读戳', () => {
  it('FD-4 带戳的子会话：systemPrompt 换成该档案 body，内置工具收窄到其白名单', async () => {
    const root = await createSession({ title: 'fd-root-chat' })
    const child = await createPinnedChildSession(app, { parentSid: root, agentProfile: PINNED })
    const info = (await runtimeInfo(child))!
    expect(info.systemPrompt.startsWith(PINNED_BODY)).toBe(true)
    // shuvix-tools: read —— 内置工具收窄到白名单（SkillTool 由装配固定附加，不受白名单管辖）
    const names = info.tools.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).not.toContain('bash')
    expect(names).not.toContain('write')
  })

  it('FD-5 戳的档案被删：回落父形态基座（无项目父 chat / 项目父 work），戳留着；重写档案后恢复', async () => {
    const chatRoot = await createSession({ title: 'fd-root-chat-2' })
    const projRoot = await createSession({ title: 'fd-root-proj-2', projectId })
    const chatChild = await createPinnedChildSession(app, {
      parentSid: chatRoot,
      agentProfile: PINNED
    })
    const projChild = await createPinnedChildSession(app, {
      parentSid: projRoot,
      agentProfile: PINNED
    })
    expect((await runtimeInfo(chatChild))!.systemPrompt.startsWith(PINNED_BODY)).toBe(true)
    expect((await runtimeInfo(projChild))!.systemPrompt.startsWith(PINNED_BODY)).toBe(true)

    expect(await deleteAgent(PINNED)).toEqual({ success: true })
    try {
      // 删档案不会自动 invalidate；失效重建后按回落解析 —— 回落的是**父形态**的基座，
      // 不是一律 work：无项目父级开的子会话没有理由突然变成项目人格
      await clearRuntime(chatChild)
      await clearRuntime(projChild)
      expectChatBody((await runtimeInfo(chatChild))!.systemPrompt)
      expectWorkBody((await runtimeInfo(projChild))!.systemPrompt)
      // 戳不被顺手清掉：档案放回来就恢复
      expect((await settingsOf(chatChild)).agentProfile).toBe(PINNED)
      expect((await settingsOf(projChild)).agentProfile).toBe(PINNED)
    } finally {
      writeAgentMd(app, PINNED, { description: '可作子会话档案', tools: 'read', body: PINNED_BODY })
    }
    await clearRuntime(chatChild)
    expect((await runtimeInfo(chatChild))!.systemPrompt.startsWith(PINNED_BODY)).toBe(true)
  })

  it('FD-6 无戳子会话随父形态：项目根的子会话 work、无项目根的子会话 chat，settings 无 agentProfile', async () => {
    const projRoot = await createSession({ title: 'fd-root-proj-3', projectId })
    const chatRoot = await createSession({ title: 'fd-root-chat-3' })
    const projChild = await createSession({ title: 'fd-child-proj', parentId: projRoot })
    const chatChild = await createSession({ title: 'fd-child-chat', parentId: chatRoot })
    expectWorkBody((await runtimeInfo(projChild))!.systemPrompt)
    expectChatBody((await runtimeInfo(chatChild))!.systemPrompt)
    expect('agentProfile' in (await settingsOf(projChild))).toBe(false)
    expect('agentProfile' in (await settingsOf(chatChild))).toBe(false)
  })
})

describe('面与设置项', () => {
  const setSetting = (key: string, value: string): Promise<unknown> =>
    app.main.eval(
      `window.api.settings.set({ key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} })`
    )

  it('FD-7 session IPC 面上没有 listAgentProfiles / updateAgentProfile；残留的默认聊天智能体设置无效', async () => {
    const keys = await app.main.eval<string[]>('Object.keys(window.api.session)')
    expect(keys).not.toContain('listAgentProfiles')
    expect(keys).not.toContain('updateAgentProfile')
    // 面本身还在（不是因为 window.api.session 整个没了才「不含」）
    for (const kept of ['create', 'getById', 'list']) expect(keys).toContain(kept)

    // 旧设置项（改制前「新会话默认档案」）：写进去什么也不发生
    await setSetting('general.defaultChatAgent', PINNED)
    try {
      const { systemPrompt } = await createAgentSession(app.main)
      expectChatBody(systemPrompt)
    } finally {
      await setSetting('general.defaultChatAgent', '')
    }
  })

  it('FD-8 斜杠命令源里没有 agent 项（会话内切换档案这个入口不存在）', async () => {
    const { sid } = await createAgentSession(app.main)
    const commands = await app.main.eval<Array<{ commandId: string }>>(
      `window.api.command.list({ sessionId: ${JSON.stringify(sid)} })`
    )
    const ids = commands.map((c) => c.commandId)
    for (const name of [PINNED, 'coding', 'work', 'chat', 'default']) {
      expect(ids, name).not.toContain(name)
    }
  })
})

/**
 * `tools.list(sid)` 的 `defaultEnabled` = 这条会话根 Agent 档案的白名单 —— 档案由形态推导，
 * 含用户覆盖。只有内置条目带这个键（mcp / skill 条目没有），所以按「键在不在」筛。
 * 探针工具选 `ssh`：work / chat 白名单有它、notebook 没有，且它在清单里（`agent` 是 hidden
 * 工具，根本不进 tools.list，拿它当探针只会读到 undefined）。
 */
describe('FD-9 tools.list 的 defaultEnabled 随推导档案', () => {
  interface ToolRow {
    name: string
    defaultEnabled?: boolean
  }
  const toolsOf = (sid?: string): Promise<ToolRow[]> =>
    app.main.eval(`window.api.tools.list(${sid === undefined ? '' : JSON.stringify(sid)})`)
  const flag = (rows: ToolRow[], name: string): boolean | undefined =>
    rows.find((t) => t.name === name)?.defaultEnabled
  const defaultOn = (rows: ToolRow[]): string[] =>
    rows.filter((t) => 'defaultEnabled' in t && t.defaultEnabled).map((t) => t.name)

  it('项目会话 work：ssh 默认勾选、git 不进任何基座', async () => {
    const sid = await createSession({ title: 'fd-tools-proj', projectId })
    const rows = await toolsOf(sid)
    expect(flag(rows, 'ssh')).toBe(true)
    // git 是内置工具（列表里有它），但不进任何基座的白名单
    expect(flag(rows, 'git')).toBe(false)
    expect(defaultOn(rows).length).toBeGreaterThan(1)
  })

  it('笔记本会话 notebook：ssh 不勾选、ask 勾选', async () => {
    const sid = await createSession({ title: 'fd-tools-nb', projectId, notebookPath: NOTE_REL })
    const rows = await toolsOf(sid)
    expect(flag(rows, 'ssh')).toBe(false)
    expect(flag(rows, 'ask')).toBe(true)
  })

  it('bot 会话落在 bot 基座：ssh 不勾选、read 勾选；不传 sid 回落 work：ssh 勾选', async () => {
    const sid = await createBotSession(app.main, { bot: 'fd-bot' })
    const rows = await toolsOf(sid)
    expect(flag(rows, 'ssh')).toBe(false)
    expect(flag(rows, 'read')).toBe(true)
    expect(flag(await toolsOf(), 'ssh')).toBe(true)
  })

  it('覆盖 chat.md 为 tools: read 之后，无项目会话只有 read 默认勾选', async () => {
    writeAgentMd(app, 'chat', { description: 'ovr', tools: 'read', body: 'CHAT OVERRIDE.' })
    try {
      const sid = await createSession({ title: 'fd-tools-chat-ovr' })
      expect(defaultOn(await toolsOf(sid))).toEqual(['read'])
      // 项目会话不受 chat 覆盖影响
      const proj = await createSession({ title: 'fd-tools-proj-2', projectId })
      expect(flag(await toolsOf(proj), 'ssh')).toBe(true)
    } finally {
      expect(await deleteAgent('chat')).toEqual({ success: true })
    }
  })
})
