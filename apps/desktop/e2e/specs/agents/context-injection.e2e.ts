/**
 * 上下文注入（append 进系统提示词）：顺序（body + 人设块 → AGENTS.md → CLAUDE.md → 项目提示词）、
 * 不落独立消息、环境变量零泄漏、换一份提示词块清单即换注入。
 *
 * 「读哪个指令文件、要不要项目提示词」由 agent 档案的 `shuvix-prompt-blocks` 决定（2026-11-13：
 * `agents_md` / `claude_md` / `project_prompt` 三项取代了 `shuvix-instruction-files` 与
 * `shuvix-project-awareness`；清单是集合，先后由宿主固定，两个指令文件各读各的），不再有会话级单选 ——
 * 故换文件 = 换档案。根会话的档案由形态推导、不可切换，所以「换档案」在这里用**带戳的子会话**表达
 * （seed.ts#createPinnedChildSession）：projectId 恒随父，工作目录相同，指令文件的解析一模一样，
 * 只有档案（清单）不同。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchApp, type E2EApp } from '../../harness/launch'
import {
  createAgentSession,
  createPinnedChildSession,
  createProject,
  ensureDefaultModel,
  promptAndListMessages,
  writeAgentMd
} from '../../harness/seed'

let app: E2EApp
let projectId: string
let projDir: string

const AGENTS_OPEN = '<project_instructions file="AGENTS.md">'
const CLAUDE_OPEN = '<project_instructions file="CLAUDE.md">'

/** 子串出现的次数 */
const countOf = (text: string, needle: string): number => text.split(needle).length - 1

beforeAll(async () => {
  app = await launchApp()
  await ensureDefaultModel(app.main)
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
  // 只列 claude_md 的档案：证明清单是唯一的选取依据（AGENTS.md 同样在盘上，但没被列出；
  // 也没列 project_prompt，所以项目提示词不进来）
  writeAgentMd(app, 'claude-only', {
    tools: 'read',
    promptBlocks: 'claude_md',
    body: 'CLAUDE-ONLY BODY.'
  })
  // 两项都列，只有书写顺序不同 —— 「清单是集合、先后由宿主固定」的端到端对照组
  writeAgentMd(app, 'both-claude-first', {
    tools: 'read',
    promptBlocks: 'claude_md, agents_md',
    body: 'BOTH BODY.'
  })
  writeAgentMd(app, 'both-agents-first', {
    tools: 'read',
    promptBlocks: 'agents_md, claude_md',
    body: 'BOTH BODY.'
  })
  // 只要项目提示词
  writeAgentMd(app, 'prompt-only', {
    tools: 'read',
    promptBlocks: 'project_prompt',
    body: 'PROMPT-ONLY BODY.'
  })
})
afterAll(async () => {
  await app.stop()
})

/** 钉一条该档案的子会话 → 建运行时 → 取完整系统提示词（无 LLM 调用） */
const pinnedPrompt = async (parentSid: string, agentProfile: string): Promise<string> => {
  const child = await createPinnedChildSession(app, { parentSid, agentProfile })
  return app.main.eval<string>(
    `window.api.agent
      .getInfo(${JSON.stringify(child)}, { ensure: true })
      .then((info) => info.systemPrompt)`
  )
}

describe('append 注入', () => {
  let sid: string

  it('系统提示词按序含：body 环境块 → AGENTS.md → CLAUDE.md（两个文件都在 → 两块都进） → 项目提示词', async () => {
    // work 基座列的是 drawing, environment, agents_md, claude_md, project_prompt
    const created = await createAgentSession(app.main, { projectId })
    sid = created.sid
    const sp = created.systemPrompt
    const iEnv = sp.indexOf('Working directory:')
    const iEnvEnd = sp.indexOf('</environment>')
    const iAgents = sp.indexOf(AGENTS_OPEN)
    const iAgentRules = sp.indexOf('AGENT RULES CONTENT.')
    const iAgentsEnd = sp.indexOf('</project_instructions>')
    const iClaude = sp.indexOf(CLAUDE_OPEN)
    const iClaudeRules = sp.indexOf('CLAUDE RULES CONTENT.')
    const iClaudeEnd = sp.lastIndexOf('</project_instructions>')
    const iProj = sp.indexOf('<project_prompt>')
    const iHaiku = sp.indexOf('HAIKU MODE ONLY.')
    const iProjEnd = sp.indexOf('</project_prompt>')
    expect(sp.indexOf('<environment>')).toBeGreaterThan(-1)
    expect(iEnv).toBeGreaterThan(sp.indexOf('<environment>'))
    expect(iEnvEnd).toBeGreaterThan(iEnv)
    expect(iAgents).toBeGreaterThan(iEnvEnd)
    expect(iAgentRules).toBeGreaterThan(iAgents)
    expect(iAgentsEnd).toBeGreaterThan(iAgentRules)
    expect(iClaude).toBeGreaterThan(iAgentsEnd)
    expect(iClaudeRules).toBeGreaterThan(iClaude)
    expect(iClaudeEnd).toBeGreaterThan(iClaudeRules)
    expect(iProj).toBeGreaterThan(iClaudeEnd)
    expect(iHaiku).toBeGreaterThan(iProj)
    expect(iProjEnd).toBeGreaterThan(iHaiku)
    // 一个文件一个围栏，各一次
    expect(countOf(sp, '<project_instructions ')).toBe(2)
  })

  it('prompt 后消息树无注入消息；项目环境变量零泄漏', async () => {
    const messages = await promptAndListMessages(app.main, sid)
    expect(messages.filter((m) => m.metadata?.isInstructionInjection)).toHaveLength(0)
    const all = JSON.stringify(messages)
    expect(all).not.toContain('SECRET_FOO')
    expect(all).not.toContain('Project environment variables')
  })

  it('钉着只列 claude_md 档案的子会话（同一工作目录）→ 只有 CLAUDE.md 那一块（AGENTS.md 内容与项目提示词都不进）', async () => {
    // 子会话的 projectId 恒随父：工作目录与父会话相同，同一批文件在盘上，命中只随档案清单变
    const sp = await pinnedPrompt(sid, 'claude-only')
    expect(sp.startsWith('CLAUDE-ONLY BODY.')).toBe(true)
    expect(sp).toContain(CLAUDE_OPEN)
    expect(sp).toContain('CLAUDE RULES CONTENT.')
    expect(sp).not.toContain('AGENT RULES CONTENT.')
    expect(sp).not.toContain(AGENTS_OPEN)
    // 没列的块一块都不追加：项目提示词、环境清单都不在
    expect(sp).not.toContain('<project_prompt>')
    expect(sp).not.toContain('HAIKU MODE ONLY.')
    expect(sp).not.toContain('<environment>')
  })

  it('钉着只列 project_prompt 档案的子会话 → 只有项目提示词，没有指令文件围栏', async () => {
    const sp = await pinnedPrompt(sid, 'prompt-only')
    expect(sp.startsWith('PROMPT-ONLY BODY.')).toBe(true)
    expect(sp).toContain('<project_prompt>\nHAIKU MODE ONLY.\n</project_prompt>')
    expect(sp).not.toContain('<project_instructions')
  })
})

/**
 * 两个指令文件块的规则（都读 / 缺了空了就不出 / 内容相同只留一份），端到端一路走到 `agent.getInfo` 的
 * systemPrompt —— 单测钉的是解析器与段落函数，这里钉的是「档案里写的那串字，最后真的这样生效」。
 */
describe('指令文件块', () => {
  let sid: string

  /** 另起一个项目（自己的目录、自己的两个文件）并在里面建一条会话，回会话 id */
  const sessionIn = async (
    dirName: string,
    files: { agents?: string; claude?: string }
  ): Promise<string> => {
    const dir = join(app.home, dirName)
    mkdirSync(dir, { recursive: true })
    if (files.agents !== undefined) writeFileSync(join(dir, 'AGENTS.md'), files.agents)
    if (files.claude !== undefined) writeFileSync(join(dir, 'CLAUDE.md'), files.claude)
    const project = await createProject(app.main, { name: dirName, path: dir })
    return (await createAgentSession(app.main, { projectId: project.id, title: dirName })).sid
  }

  beforeAll(async () => {
    sid = (await createAgentSession(app.main, { projectId, title: 'e2e-list' })).sid
  })

  it('IF-E-1 两个文件都在 → 两块都进，AGENTS.md 恒在前：清单是集合，书写顺序不改变结果', async () => {
    const claudeFirst = await pinnedPrompt(sid, 'both-claude-first')
    const agentsFirst = await pinnedPrompt(sid, 'both-agents-first')
    for (const sp of [claudeFirst, agentsFirst]) {
      // 戳确实生效了（否则测的是父形态基座的清单）
      expect(sp.startsWith('BOTH BODY.')).toBe(true)
      expect(sp).toContain(`${AGENTS_OPEN}\nAGENT RULES CONTENT.\n</project_instructions>`)
      expect(sp).toContain(`${CLAUDE_OPEN}\nCLAUDE RULES CONTENT.\n</project_instructions>`)
      expect(sp.indexOf(AGENTS_OPEN)).toBeLessThan(sp.indexOf(CLAUDE_OPEN))
      expect(countOf(sp, '<project_instructions ')).toBe(2)
    }
    // 两种写法得到同一份系统提示词
    expect(claudeFirst).toBe(agentsFirst)
  })

  it('IF-E-2 缺失的不出、纯空白的也不出：只有 AGENTS.md 有内容 → 只有它那一块，没有空围栏', async () => {
    const parent = await sessionIn('proj-inject-blank', {
      agents: 'ONLY AGENTS CONTENT.',
      claude: '   \n'
    })
    const sp = await pinnedPrompt(parent, 'both-agents-first')
    expect(sp).toContain(`${AGENTS_OPEN}\nONLY AGENTS CONTENT.\n</project_instructions>`)
    // 空文件不该以「命中但空围栏」的形式出现
    expect(sp).not.toContain('file="CLAUDE.md"')
    expect(countOf(sp, '<project_instructions ')).toBe(1)

    // 两个都不在：一个围栏都没有
    const bare = await sessionIn('proj-inject-none', {})
    const none = await pinnedPrompt(bare, 'both-agents-first')
    expect(none.startsWith('BOTH BODY.')).toBe(true)
    expect(none).not.toContain('<project_instructions')
  })

  it('IF-E-3 两个文件内容相同（副本 / 链接，只差首尾空白也算）→ 只留 AGENTS.md 那一份', async () => {
    const parent = await sessionIn('proj-inject-same', {
      agents: 'SHARED RULES CONTENT.',
      claude: 'SHARED RULES CONTENT.\n'
    })
    const sp = await pinnedPrompt(parent, 'both-claude-first')
    expect(sp).toContain(`${AGENTS_OPEN}\nSHARED RULES CONTENT.\n</project_instructions>`)
    expect(sp).not.toContain('file="CLAUDE.md"')
    expect(countOf(sp, 'SHARED RULES CONTENT.')).toBe(1)

    // 只列 claude_md 时没有「另一份」可去重：CLAUDE.md 照常进
    const only = await pinnedPrompt(parent, 'claude-only')
    expect(only).toContain(`${CLAUDE_OPEN}\nSHARED RULES CONTENT.\n</project_instructions>`)
  })
})

describe('存量档案里的旧键', () => {
  it('IF-E-5 `shuvix-instruction-files` / `shuvix-project-awareness` 按未知键忽略：档案照常在列表里，但什么都不注入', async () => {
    // 改制前的两个键（连同更早的布尔写法）。2026-11-13 起解析器不再读它们 —— 不判非法、也不生效，无迁移
    writeAgentMd(app, 'legacy-keys', {
      tools: 'read',
      rawLines: [
        'shuvix-instruction-files: AGENTS.md, CLAUDE.md',
        'shuvix-project-awareness: true'
      ],
      body: 'LEGACY KEYS BODY.'
    })
    writeAgentMd(app, 'legacy-bool', {
      tools: 'read',
      rawLines: ['shuvix-instruction-files: true'],
      body: 'LEGACY BOOL BODY.'
    })

    const names = await app.main.eval<string[]>(
      `window.api.subAgent.list().then((rows) => rows.map((r) => r.name))`
    )
    expect(names).toContain('legacy-keys')
    expect(names).toContain('legacy-bool')
    expect(names).toContain('both-agents-first')

    const parent = (await createAgentSession(app.main, { projectId, title: 'e2e-legacy' })).sid
    const sp = await pinnedPrompt(parent, 'legacy-keys')
    expect(sp.startsWith('LEGACY KEYS BODY.')).toBe(true)
    expect(sp).not.toContain('<project_instructions')
    expect(sp).not.toContain('<project_prompt>')
    expect(sp).not.toContain('AGENT RULES CONTENT.')
    expect(sp).not.toContain('HAIKU MODE ONLY.')
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
 * 覆盖 work 但**省略** `shuvix-prompt-blocks` = 一块都不追加。
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
    expect(overridden.systemPrompt).not.toContain('<project_prompt>')
    expect(overridden.systemPrompt).not.toContain('<environment>')

    const res = await app.main.eval<{ success: boolean }>(
      `window.api.subAgent.delete({ name: 'work' })`
    )
    expect(res.success).toBe(true)

    const restored = await createAgentSession(app.main, { projectId, title: 'e2e-reinject' })
    expect(restored.systemPrompt).toContain(AGENTS_OPEN)
    expect(restored.systemPrompt).toContain('AGENT RULES CONTENT.')
    expect(restored.systemPrompt).toContain(CLAUDE_OPEN)
    expect(restored.systemPrompt).toContain('<project_prompt>')
  })
})

/**
 * 知识库围栏 `<knowledge_bases>` —— 上下文注入的第三段，位置在项目提示词之后（项目记忆已退役，
 * 由项目库接替，它不再有自己的围栏）。
 *
 * 它**不跟提示词块清单走**：库是用户按会话选的，与「知不知道自己在哪个项目里」无关，所以不属于任何
 * 项目的会话照样有围栏（只要它有库）。唯一的门是档案的工具清单里有没有 `knowledge`。
 *
 * 用户库**缺省一个都不启用**（2026-09-17）；2026-10-10 起项目会话的**项目库隐式启用**、排在最前（不归选择管）；
 * 2026-11-14 起**内置说明书 `shuvix` 恒启用**、排在最后（也不归选择管：选择里写了它读时剔掉，显式的 `[]` 也去不掉它）。
 * 所以每条会话都恒有围栏（说明书的目录在 —— e2e 里就是仓库的 resources/knowledge）；要圈用户库，用例靠
 * `createAgentSession({ knowledgeBases })` 在根 Agent 起来之前把选择放好（`[]` = 不用我自己的库）。次序恒为
 * 项目库 → 选择里的用户库（照选择的次序）→ 说明书。
 *
 * 围栏里**只有清单、没有内容**：不列条目文件名、不报条目数，也**不带库目录**（2026-11-08 起：库目录只有
 * 知识库管理员知道，别的 agent 按库名 + 条目名经 `knowledge` 读、经 `submit` 交）。例外是内置说明书自己那段
 * 说明（2026-11-02）：它点名该读哪几篇（`/bot-md.md` 这样的条目名），不是库的内容，也不是计数。
 *
 * 选择改了之后围栏**不当场跟上**（2026-11-06 起整份系统提示词按对话冻结）：改选择只让提醒里出现知识库那一段，
 * 用户点重建才按此刻的来源重渲染。KBF-E-4 钉的就是这条边界；`tool` 那一面（`knowledge` 每次调用现查）照样即时。
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

  /** 内置说明书那段说明（靠它点名的第一篇认）：它是指路，不算库的内容 */
  const withoutManualNote = (body: string): string =>
    body
      .split('\n\n')
      .filter((paragraph) => !paragraph.includes('`/bot-md.md`'))
      .join('\n\n')

  /** 围栏只给入口不给内容：每行 `- 名字 — 标签`，没有路径（连库目录也没有）与计数（说明书那段说明除外） */
  const expectNoContent = (fence: string): void => {
    const body = withoutManualNote(fence)
    expect(body, 'the fence is there at all').not.toBe('')
    expect(body, 'no entry file names').not.toContain('.md')
    // 计数与路径都不该出现：数字与斜杠是它们最省事的判据（库名与项目名都不含）
    expect(/\d/.test(body), `no counts in: ${body}`).toBe(false)
    expect(body, 'no paths, not even the base directories').not.toContain('/')
    expect(body, 'no home directory').not.toContain(app.home)
  }

  const systemPromptOf = (sid: string): Promise<string> =>
    app.main.eval<string>(
      `window.api.agent
        .getInfo(${JSON.stringify(sid)}, { ensure: true })
        .then((info) => info.systemPrompt)`
    )

  it('KBF-E-1 项目会话谁都没勾：围栏照样在、排在项目提示词之后，列出 `- project — <项目名>` 与恒在的说明书，不带库目录、条目与计数；没有项目记忆那段', async () => {
    // 不传 knowledgeBases：项目库与说明书都是隐式启用的，都不用勾
    const { systemPrompt: sp } = await createAgentSession(app.main, {
      projectId,
      title: 'e2e-kbf-1'
    })

    expect(sp.indexOf(OPEN)).toBeGreaterThan(sp.indexOf('</project_prompt>'))
    const fence = fenceBodyOf(sp)
    // 项目库的标签是项目**当前**的名字（目录名是 uuid —— 从不当名字用，目录本身也不进围栏）
    expect(fence).toContain('- project — InjProj\n')
    expect(fence).not.toContain(projectId)
    expect(fence).toMatch(/\n- shuvix — .*read-only/)
    expectNoContent(fence)
    // 项目记忆已退役：项目库接替了它，不再有那一段
    expect(sp).not.toContain('<project_memory>')
  })

  it('KBF-E-2 不属于任何项目的会话照样有围栏（列出用户自己的库），且没有项目那两段', async () => {
    mkdirSync(userBaseDir(), { recursive: true })

    // 选择里只有用户库：说明书不用勾，它恒在
    const { systemPrompt: sp } = await createAgentSession(app.main, {
      title: 'e2e-kbf-2',
      knowledgeBases: [USER_BASE]
    })
    expect(sp).toContain(OPEN)
    expect(fenceBodyOf(sp)).toContain(`- ${USER_BASE}\n`)
    expect(fenceBodyOf(sp)).not.toContain(userBaseDir())
    // 内置库那一行带一句它是什么、且只读 —— 那句话本身不含路径与计数；它排在用户库之后
    expect(fenceBodyOf(sp)).toMatch(/\n- shuvix — .*read-only/)
    expect(fenceBodyOf(sp).indexOf(`- ${USER_BASE}`)).toBeLessThan(
      fenceBodyOf(sp).indexOf('- shuvix — ')
    )
    expectNoContent(fenceBodyOf(sp))
    // 项目那两段与围栏无关：没有项目就是没有，围栏照旧
    expect(sp).not.toContain('<project_prompt>')
    expect(sp).not.toContain('<project_memory>')
  })

  it('KBF-E-3 谁都没设过 → 围栏只列恒在的内置说明书、带它的说明、不教记录；明确设成空 → 围栏一字不差（说明书去不掉）', async () => {
    // 库在磁盘上 —— 「没有用户库」说的是**没启用**，不是没有
    mkdirSync(userBaseDir(), { recursive: true })

    const onlyManual = (fence: string, label: string): void => {
      const listed = fence.split('\n').filter((line) => line.startsWith('- '))
      expect(listed, label).toHaveLength(1)
      expect(listed[0], label).toMatch(/^- shuvix — .*read-only/)
      // 手头全是只读的库：不教「记下来」，只说什么时候来查
      expect(fence, label).not.toContain('submit')
      expect(fence, label).toContain('`/bot-md.md`')
      expectNoContent(fence)
    }

    // (a) 谁都没设过 —— 这是新会话的常态（用户库缺省一个都不启用，说明书恒在）
    const fence = fenceBodyOf(
      (await createAgentSession(app.main, { title: 'e2e-kbf-3-default' })).systemPrompt
    )
    onlyManual(fence, 'never chosen')

    // (b) 明确设成空：走的是另一条分支（「设过」的判据是是不是数组），说明书照样在 —— 围栏与 (a) 一字不差
    const explicitEmpty = fenceBodyOf(
      (await createAgentSession(app.main, { title: 'e2e-kbf-3-empty', knowledgeBases: [] }))
        .systemPrompt
    )
    onlyManual(explicitEmpty, 'explicitly empty')
    expect(explicitEmpty).toBe(fence)
  })

  it('KBF-E-4 改选择不动已冻结的围栏，提醒里是知识库那一段；用户点重建才换：清空 → 用户库那几行消失（项目会话剩项目库与说明书，无项目会话只剩说明书那一行），选回来再重建 → 逐字节回来', async () => {
    // 2026-11-06 用户裁决「历史状态不变」：整份系统提示词（知识库围栏在内）在这段对话第一次建 agent 时冻结，
    // 来源改了只提醒，用户点「重建」才按此刻的来源重渲染（chat-system-prompt-frozen.e2e.ts 走的是界面那条路）
    mkdirSync(userBaseDir(), { recursive: true })

    /** 建一条勾了 USER_BASE 的会话，回它的 id、创建时的系统提示词与几个助手 */
    const start = async (opts: {
      projectId?: string
      title: string
    }): Promise<{
      sid: string
      sp0: string
      setBases: (knowledgeBases: string[]) => Promise<void>
      runtimeCreated: () => Promise<boolean>
      staleKeys: () => Promise<string[]>
      rebuild: () => Promise<void>
    }> => {
      const created = await createAgentSession(app.main, { ...opts, knowledgeBases: [USER_BASE] })
      const sid = created.sid
      return {
        sid,
        sp0: created.systemPrompt,
        setBases: async (knowledgeBases) => {
          const res = await app.main.eval<{ success: boolean }>(
            `window.api.session.updateKnowledgeBases(${JSON.stringify({ id: sid, knowledgeBases })})`
          )
          expect(res.success).toBe(true)
        },
        runtimeCreated: () =>
          app.main
            .eval<{
              created: boolean
            }>(`window.api.agent.init({ sessionId: ${JSON.stringify(sid)} })`)
            .then((r) => r.created),
        staleKeys: () =>
          app.main
            .eval<{
              stale: Array<{ key: string }>
            }>(`window.api.agent.systemPromptStatus(${JSON.stringify(sid)})`)
            .then((r) => r.stale.map((section) => section.key)),
        rebuild: async () => {
          const res = await app.main.eval<{ success: boolean }>(
            `window.api.agent.rebuildSystemPrompt(${JSON.stringify(sid)})`
          )
          expect(res).toEqual({ success: true })
        }
      }
    }

    // (a) 项目会话：清空用户的选择 → 系统提示词逐字节不变，提醒里只有知识库那一段
    const proj = await start({ projectId, title: 'e2e-kbf-4-project' })
    expect(fenceBodyOf(proj.sp0)).toContain('- project — InjProj')
    expect(fenceBodyOf(proj.sp0)).toContain(`- ${USER_BASE}`)

    await proj.setBases([])
    expect(await proj.runtimeCreated()).toBe(true)
    expect(await systemPromptOf(proj.sid)).toBe(proj.sp0)
    expect(await proj.staleKeys()).toEqual(['knowledge_bases'])

    // 重建：围栏还在 —— 项目库不归选择管，只剩它那一行
    await proj.rebuild()
    const projCleared = await systemPromptOf(proj.sid)
    const projFence = fenceBodyOf(projCleared)
    expect(projFence).toContain('- project — InjProj')
    expect(projFence).not.toContain(`- ${USER_BASE}`)
    expect(projFence).toMatch(/\n- shuvix — .*read-only/)
    expect(await proj.staleKeys()).toEqual([])
    // 围栏之外逐字不动
    expect(projCleared.slice(0, projCleared.indexOf(OPEN))).toBe(
      proj.sp0.slice(0, proj.sp0.indexOf(OPEN))
    )
    expect(projCleared.slice(projCleared.indexOf(CLOSE))).toBe(
      proj.sp0.slice(proj.sp0.indexOf(CLOSE))
    )

    // 选回来：重建之前还是清空后的那一份，重建之后逐字节回到最初
    await proj.setBases([USER_BASE])
    expect(await systemPromptOf(proj.sid)).toBe(projCleared)
    expect(await proj.staleKeys()).toEqual(['knowledge_bases'])
    await proj.rebuild()
    expect(await systemPromptOf(proj.sid)).toBe(proj.sp0)

    // (b) 不属于项目的会话：清空 → 重建之前不变；重建 → 围栏还在、只剩说明书那一行（它恒启用），
    // 围栏之外逐字不动；选回来再重建 → 逐字节回来
    const free = await start({ title: 'e2e-kbf-4-free' })
    expect(fenceBodyOf(free.sp0)).toContain(`- ${USER_BASE}`)
    expect(fenceBodyOf(free.sp0)).toContain('- shuvix — ')

    await free.setBases([])
    expect(await free.runtimeCreated()).toBe(true)
    expect(await systemPromptOf(free.sid)).toBe(free.sp0)
    expect(await free.staleKeys()).toEqual(['knowledge_bases'])
    await free.rebuild()
    const cleared = await systemPromptOf(free.sid)
    const freeFence = fenceBodyOf(cleared)
    const listed = freeFence.split('\n').filter((line) => line.startsWith('- '))
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatch(/^- shuvix — .*read-only/)
    const sp0 = free.sp0
    expect(cleared.slice(0, cleared.indexOf(OPEN))).toBe(sp0.slice(0, sp0.indexOf(OPEN)))
    expect(cleared.slice(cleared.indexOf(CLOSE))).toBe(sp0.slice(sp0.indexOf(CLOSE)))

    await free.setBases([USER_BASE])
    await free.rebuild()
    const restored = await systemPromptOf(free.sid)
    expect(fenceBodyOf(restored)).toBe(fenceBodyOf(sp0))
    expect(restored).toBe(sp0)
  })

  it('KBF-E-5 项目会话的围栏次序：项目库恒打头、用户库居中、说明书恒垫底（不论选择怎么写），整段仍然无条目/计数、不带库目录', async () => {
    // 这一条要的正是「用户库 + 项目库 + 内置库」三种都在的那一屏
    mkdirSync(userBaseDir(), { recursive: true })

    const { systemPrompt: sp } = await createAgentSession(app.main, {
      projectId,
      title: 'e2e-kbf-5',
      // 存量写法：说明书写在最前、项目库写在中间 —— 两个都读时剔掉，次序由宿主定
      knowledgeBases: ['shuvix', 'project', USER_BASE]
    })
    const fence = fenceBodyOf(sp)

    const at = (line: string): number => {
      const i = fence.indexOf(line)
      expect(i, `fence lists ${JSON.stringify(line)}: ${fence}`).toBeGreaterThanOrEqual(0)
      return i
    }
    // 项目库恒打头，说明书恒垫底，用户库在中间
    expect(at('- project — InjProj')).toBeLessThan(at(`- ${USER_BASE}`))
    expect(at(`- ${USER_BASE}`)).toBeLessThan(at('- shuvix — '))
    // 项目库与说明书都只出现一次（选择里残留的那两个不会再列一遍）
    expect(fence.split('- project — ').length).toBe(2)
    expect(fence.split('- shuvix — ').length).toBe(2)
    // 内置那一行自带一句「是什么 + 只读」，好让模型知道什么问题该来这里查、又别把笔记记进来
    expect(fence).toMatch(/\n- shuvix — .*read-only/)

    // 多了一种库，「只给入口不给内容」的承诺一字不改（那句说明里既没有路径也没有版本号）；
    // 行里没有库目录 —— 库目录只有知识库管理员知道
    expectNoContent(fence)
    expect(fence).toContain(`- ${USER_BASE}\n`)
  })

  it('KBF-E-6 选择里没有 `shuvix` 的会话围栏里照样有那一行（与写了它的会话一字不差）；改已有运行时的选择，系统提示词逐字节不变', async () => {
    mkdirSync(userBaseDir(), { recursive: true })

    // (a) 先有一个选择里写了 shuvix 的运行时（存量写法）—— 它的围栏里有那一行
    const live = (
      await createAgentSession(app.main, {
        projectId,
        title: 'e2e-kbf-6-live',
        knowledgeBases: [USER_BASE, 'shuvix']
      })
    ).sid
    const before = await systemPromptOf(live)
    expect(fenceBodyOf(before)).toContain('- shuvix — ')

    // (b) 另一条会话：**先**把选择写成不含 shuvix 的一份，**再**让根 Agent 起来
    //（根 Agent 是懒创建的，围栏在那一刻定型）
    const sp = await app.main.eval<string>(
      `(async () => {
        const s = await window.api.session.create(${JSON.stringify({
          projectId,
          title: 'e2e-kbf-6-new'
        })})
        await window.api.session.updateKnowledgeBases({
          id: s.id,
          knowledgeBases: ${JSON.stringify([USER_BASE])}
        })
        const info = await window.api.agent.getInfo(s.id, { ensure: true })
        return info.systemPrompt
      })()`
    )
    const fence = fenceBodyOf(sp)
    expect(fence).toContain(`- ${USER_BASE}`)
    expect(fence).toContain('- project — InjProj')
    // 说明书恒启用：选择里没写它，围栏里照样有、垫底
    expect(fence).toMatch(/\n- shuvix — .*read-only/)
    expect(fence.indexOf(`- ${USER_BASE}`)).toBeLessThan(fence.indexOf('- shuvix — '))
    expectNoContent(fence)
    // 选择里写没写 shuvix 不影响结果：两条会话的围栏一字不差
    expect(fence).toBe(fenceBodyOf(before))

    // (c) 把已有运行时的选择改成不含 shuvix 的一份：生效的选择没变，系统提示词逐字节不变
    const res = await app.main.eval<{ success: boolean }>(
      `window.api.session.updateKnowledgeBases(${JSON.stringify({ id: live, knowledgeBases: [USER_BASE] })})`
    )
    expect(res.success).toBe(true)
    expect(await systemPromptOf(live)).toBe(before)
  })
})
