/**
 * 上下文注入（append 进系统提示词）：顺序（body → 指令文件 → 项目提示词）、
 * 不落独立消息、环境变量零泄漏、换一份指令文件清单经失效重建生效。
 *
 * 「读哪个指令文件」由 agent 档案的 `shuvix-instruction-files` 清单决定（顺序即优先级），
 * 不再有会话级单选 —— 故换文件 = 换档案。根会话的档案由形态推导、不可切换，所以「换档案」
 * 在这里用**带戳的子会话**表达（seed.ts#createPinnedChildSession）：projectId 恒随父，
 * 工作目录相同，指令文件的解析一模一样，只有档案（清单）不同。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { until } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createAgentSession,
  createPinnedChildSession,
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

  it('钉着只列 CLAUDE.md 档案的子会话（同一工作目录）→ 指令文件换成 CLAUDE.md（AGENTS.md 内容消失）', async () => {
    // 子会话的 projectId 恒随父：工作目录与父会话相同，同一批文件在盘上，命中只随档案清单变
    const child = await createPinnedChildSession(app, {
      parentSid: sid,
      agentProfile: 'claude-only'
    })
    const sp = await app.main.eval<string>(
      `window.api.agent
        .getInfo(${JSON.stringify(child)}, { ensure: true })
        .then((info) => info.systemPrompt)`
    )
    expect(sp.startsWith('CLAUDE-ONLY BODY.')).toBe(true)
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

  /** 在项目会话下钉一条该档案的子会话 → 建运行时 → 取完整系统提示词（无 LLM 调用） */
  const switchTo = async (name: string): Promise<string> => {
    const child = await createPinnedChildSession(app, { parentSid: sid, agentProfile: name })
    const sp = await app.main.eval<string>(
      `window.api.agent
        .getInfo(${JSON.stringify(child)}, { ensure: true })
        .then((info) => info.systemPrompt)`
    )
    // 戳确实生效了（否则下面测的是父形态基座的清单，而它恰好也是 AGENTS.md 优先）
    expect(
      sp.startsWith(
        name === 'subdir-house'
          ? 'SUBDIR BODY.'
          : name === 'fallback-chain'
            ? 'FALLBACK BODY.'
            : 'PREF BODY.'
      ),
      `pinned ${name}`
    ).toBe(true)
    return sp
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
  it('IF-E-6 session IPC 面上不再有 scanInstructionFiles / updateInstructionFile，也没有档案切换', async () => {
    const keys = await app.main.eval<string[]>('Object.keys(window.api.session)')
    expect(keys).not.toContain('scanInstructionFiles')
    expect(keys).not.toContain('updateInstructionFile')
    // 会话内切换档案（连同它的选择器列表）随「档案由形态推导」一并下线
    expect(keys).not.toContain('updateAgentProfile')
    expect(keys).not.toContain('listAgentProfiles')
    // 面本身还在（不是因为 window.api.session 整个没了才「不含」）
    expect(keys).toContain('create')
  })
})

/**
 * 覆盖 work 但**省略** `shuvix-instruction-files` = 不注入。
 *
 * 独立 describe + 自清理：这条会往 `~/.shuvix/agents/work.md` 落一份覆盖档案，
 * 它对同实例后续所有新项目会话都生效，漏删就会把别的用例带成「无端不注入」。
 */
describe('覆盖 work 的清单省略语义', () => {
  const workMd = (): string => join(app.agentsDir, 'work.md')

  afterAll(() => {
    rmSync(workMd(), { force: true })
  })

  it('IF-E-4 省略键 → 新会话零注入；删掉覆盖档案 → 内置清单恢复生效', async () => {
    writeAgentMd(app, 'work', { tools: 'read', body: 'NO-INJECTION WORK BODY.' })

    const overridden = await createAgentSession(app.main, { projectId, title: 'e2e-no-inject' })
    expect(overridden.systemPrompt.startsWith('NO-INJECTION WORK BODY.')).toBe(true)
    expect(overridden.systemPrompt).not.toContain('<project_instructions')
    expect(overridden.systemPrompt).not.toContain('AGENT RULES CONTENT.')

    const res = await app.main.eval<{ success: boolean }>(
      `window.api.subAgent.delete({ name: 'work' })`
    )
    expect(res.success).toBe(true)

    const restored = await createAgentSession(app.main, { projectId, title: 'e2e-reinject' })
    expect(restored.systemPrompt).toContain('<project_instructions file="AGENTS.md">')
    expect(restored.systemPrompt).toContain('AGENT RULES CONTENT.')
  })
})

/**
 * 知识库围栏 `<knowledge_bases>` —— 上下文注入的第三段，位置在项目提示词之后、项目记忆之前。
 *
 * 它**不跟项目感知走**：库是用户按会话选的，与「知不知道自己在哪个项目里」无关，所以不属于任何
 * 项目的会话照样有围栏（只要它有库）。唯一的门是档案的工具清单里有没有 `knowledge`。
 *
 * 围栏里**只有清单、没有内容**：不列条目文件名、不报条目数、不印知识库根的绝对路径 —— 印了路径
 * 就等于邀请 agent 直接 `write` 过去，绕开只有 `create` 才担保的元数据形状。
 *
 * 选择改了之后围栏**不会当场跟上**（系统提示词在创建 Agent 那一刻定型，改选择刻意不失效运行时）：
 * KBF-E-4 走的是「清空 → 下一个运行时」这条既有手法，钉的正是这个已接受的边界。
 */
describe('知识库围栏', () => {
  const OPEN = '<knowledge_bases>'
  const CLOSE = '</knowledge_bases>'
  /** 用户库就是 ~/.shuvix/knowledge 下的一个目录（名字不带数字 —— 围栏里断「没有计数」时要干净） */
  const USER_BASE = 'kbf-user-base'
  const userBaseDir = (): string => join(app.home, '.shuvix', 'knowledge', USER_BASE)

  /**
   * 围栏**里面**那段正文（不含两个标签 —— 闭合标签自带一个斜杠，会把「不含路径」那条断废）。
   * 没有围栏回空串。整份提示词里 `.md` 到处都是（指令文件的围栏就带一个），只能就这一段断。
   */
  const fenceBodyOf = (sp: string): string => {
    const start = sp.indexOf(OPEN)
    const end = sp.indexOf(CLOSE)
    return start === -1 || end === -1 ? '' : sp.slice(start + OPEN.length, end)
  }

  /** 围栏只给入口不给内容 */
  const expectNoContent = (body: string): void => {
    expect(body, 'the fence is there at all').not.toBe('')
    expect(body, 'no entry file names').not.toContain('.md')
    // 计数与路径都不该出现：数字与斜杠是它们最省事的判据（库名与项目名都不含）
    expect(/\d/.test(body), `no counts in: ${body}`).toBe(false)
    expect(body, 'no paths').not.toContain('/')
  }

  const systemPromptOf = (sid: string): Promise<string> =>
    app.main.eval<string>(
      `window.api.agent
        .getInfo(${JSON.stringify(sid)}, { ensure: true })
        .then((info) => info.systemPrompt)`
    )

  it('KBF-E-1 项目会话：围栏排在项目提示词之后，列出 `- project — <项目名>`，不带任何条目/路径/计数', async () => {
    const { systemPrompt: sp } = await createAgentSession(app.main, {
      projectId,
      title: 'e2e-kbf-1'
    })

    expect(sp.indexOf(OPEN)).toBeGreaterThan(sp.indexOf('</project_prompt>'))
    const fence = fenceBodyOf(sp)
    // 项目库的标签是项目**当前**的名字（目录名是 uuid，永远不该出现在提示词里）
    expect(fence).toContain('- project — InjProj')
    expectNoContent(fence)
    expect(fence).not.toContain(app.home)
  })

  it('KBF-E-2 不属于任何项目的会话照样有围栏（列出用户自己的库），且没有项目那两段', async () => {
    mkdirSync(userBaseDir(), { recursive: true })

    const { systemPrompt: sp } = await createAgentSession(app.main, { title: 'e2e-kbf-2' })
    expect(sp).toContain(OPEN)
    expect(fenceBodyOf(sp)).toContain(`- ${USER_BASE}`)
    // 随应用发布的内置库垫底，带一句它是什么、且只读 —— 那句话本身不含路径与计数
    expect(fenceBodyOf(sp)).toMatch(/\n- shuvix — .*read-only/)
    expectNoContent(fenceBodyOf(sp))
    // 项目感知那两段与围栏无关：没有项目就是没有，围栏照旧
    expect(sp).not.toContain('<project_prompt>')
    expect(sp).not.toContain('<project_memory>')
  })

  it('KBF-E-3 一个库都没有（明确设成空）→ 整段不注入，也不因此多出空行', async () => {
    rmSync(userBaseDir(), { recursive: true, force: true })

    // 随应用发布的内置库 `shuvix` 总在缺省里，所以「一个库都没有」只能是明确设成空：
    // 先建会话、把选择写成 []，再让根 Agent 起来（它是懒创建的，围栏在这一刻定型）
    const sp = await app.main.eval<string>(
      `(async () => {
        const s = await window.api.session.create(${JSON.stringify({ title: 'e2e-kbf-3' })})
        await window.api.session.updateKnowledgeBases({ id: s.id, knowledgeBases: [] })
        const info = await window.api.agent.getInfo(s.id, { ensure: true })
        return info.systemPrompt
      })()`
    )
    expect(sp).not.toContain(OPEN)
    expect(sp).not.toContain(CLOSE)
    // 无项目会话里知识库是**最后**一段：注入一个空围栏、或只追加了那个空行分隔符，
    // 都会在末尾留下一个空行 —— 这是「整段不注入」与「注入了一段空东西」的分界
    expect(sp, 'no dangling blank line from an empty append').not.toMatch(/\n[ \t]*\n[ \t]*$/)
  })

  it('KBF-E-4 改选择不动已有的运行时；下一个运行时的围栏才跟上（这里：整段消失）', async () => {
    const sid = (await createAgentSession(app.main, { projectId, title: 'e2e-kbf-4' })).sid
    expect(await systemPromptOf(sid)).toContain(OPEN)

    const res = await app.main.eval<{ success: boolean }>(
      `window.api.session.updateKnowledgeBases(${JSON.stringify({ id: sid, knowledgeBases: [] })})`
    )
    expect(res.success).toBe(true)
    // 已存在的运行时里那一段不变 —— 已接受的边界（工具面改完立刻生效，围栏要等重建）
    expect(await systemPromptOf(sid)).toContain(OPEN)

    // 清空 = 关停运行时（本区既有手法）：下一个运行时按新选择重新组装
    await app.main.eval(`window.api.message.clear(${JSON.stringify(sid)})`)
    await until(
      async () =>
        !(
          await app.main.eval<{ created: boolean }>(
            `window.api.agent.init({ sessionId: ${JSON.stringify(sid)} })`
          )
        ).created,
      'runtime closed after clear'
    )
    expect(await systemPromptOf(sid)).not.toContain(OPEN)
  })
})
