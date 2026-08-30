/**
 * bot 定义文件（`shuvix: bot v1`）的解析 / 序列化契约。
 *
 * bot md 是 **agent md 的超集**：共享六键经 parseAgentSharedFields 与 agent 解析器
 * 逐字同义（SP 组把这一点直接钉成对照表 —— 抽共享函数的全部收益就在那里），
 * 之上加 bot 专属的**管线声明**（pipeline / input）、**开放角色表**（agents）、门控与
 * 表现层键，一条比 agent 更严的规则（**description 必填非空** —— 意图段靠它判断相关性），
 * 以及正文末尾的**笔记区**（纯函数契约在 botNotes.test.ts）。
 *
 * 一条贯穿全文件的分界线：**定义区硬失败、状态区软失败**。frontmatter 与人设区的任何
 * 类型错误都整份拒绝（BR 组），而笔记区的任何结构异常都只记 warn（BN 组）—— 一次坏的
 * 笔记写入不该把 bot 连人设一起从用户正在用的会话里删掉。
 *
 * 分组：
 *   BP 合法形状与缺省 · SP 与 agent md 的共享字段同义 · BR 整份拒绝清单 ·
 *   BN 「接受但有话说」的 warn 纪律（含笔记区软失败）· BX 宽松侧（未知键/裸键/标记）·
 *   BS 序列化 · BD 属性卡描述符与解析器的对齐
 *
 * 断言到消息文本时一律用子串/正则而非全等：拒绝理由是 UI 横幅与 IPC error 的唯一
 * 文案来源，要钉的是「点名了哪个键、给没给正确写法」，不是标点。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BOT_RESPOND_MODES as PROTOCOL_RESPOND_MODES,
  SHUVIX_MD_DESCRIPTORS
} from '@shuvix/chat-protocol/shuvixMdDescriptors'
import { parseAgentDefinitionFile } from '../../agentProfile/definitionFile'
import {
  BOT_AGENTS_KEY,
  BOT_FILE_MARKER,
  BOT_FILE_MARKER_KEY,
  BOT_GREETING_KEY,
  BOT_INPUT_KEY,
  BOT_NOTES_KEY,
  BOT_PIPELINE_KEY,
  BOT_RESPOND_KEY,
  BOT_RESPOND_MODES,
  BOT_SUGGESTIONS_KEY,
  DEFAULT_BOT_PIPELINE,
  parseBotDefinitionFile,
  serializeBotDefinitionFile,
  type ParsedBotFile
} from '../botFile'
import { BOT_NOTES_MARKER, splitBotNotes } from '../botNotes'

const md = (...lines: string[]): string => lines.join('\n')

/** 最小合法 bot：description 必填 + 非空正文 */
const bot = (...fm: string[]): string => md('---', 'description: d', ...fm, '---', 'body')

/** 人设 + 一段笔记区的正文（`prose` 为线以下的散文） */
const bodyWithNotes = (persona: string, ...prose: string[]): string =>
  md(persona, '', BOT_NOTES_MARKER, '', ...prose, '')

/** 收集一次解析的全部诊断 */
const parseWithWarn = (
  raw: string,
  defaultName = 'fn'
): { result: ParsedBotFile | null; messages: string[] } => {
  const messages: string[] = []
  const result = parseBotDefinitionFile(raw, defaultName, (m) => messages.push(m))
  return { result, messages }
}

/** 只取拒绝理由（末位那条以 `; the whole file is rejected` 收尾的） */
const rejectReason = (raw: string, defaultName = 'fn'): string => {
  const { result, messages } = parseWithWarn(raw, defaultName)
  expect(result, raw).toBeNull()
  const rejects = messages.filter((m) => m.endsWith('; the whole file is rejected'))
  expect(rejects, raw).toHaveLength(1)
  return rejects[0]
}

// ────────────────────────────── BP：合法形状与缺省 ──────────────────────────────

/**
 * 人设 = `systemPrompt` 减去笔记区。解析产物**不存**这个字段（它是切片，存两份就会
 * 各说各话），需要断言「哪半边归谁」的用例在这里自行派生。
 */
function personaOf(parsed: ParsedBotFile): string {
  return splitBotNotes(parsed.systemPrompt).persona.trim()
}

describe('BP —— 解析：合法形状与缺省', () => {
  it('BP-1 最小合法文件（仅 description + 正文）', () => {
    const parsed = parseBotDefinitionFile('---\ndescription: d\n---\nbody', 'fn')
    expect(parsed).not.toBeNull()
    // name 省略回退文件 basename，displayName 再回退 name
    expect(parsed!.name).toBe('fn')
    expect(parsed!.displayName).toBe('fn')
    expect(parsed!.description).toBe('d')
    expect(parsed!.systemPrompt).toBe('body')
  })

  it('BP-2 全字段文件逐字段落位（含管线声明、开放角色表与笔记区）', () => {
    // 角色表刻意用非「四阶段」的名字（gate）—— 角色集合归管线 workflow 定义，本层只校形状
    const raw = md(
      '---',
      `${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}`,
      'name: full-bot',
      'description: does everything',
      'shuvix-displayName: 全能 bot',
      'shuvix-tools: read, grep',
      'shuvix-model: openai/gpt-4o',
      'shuvix-instruction-files: AGENTS.md, CLAUDE.md',
      'shuvix-project-awareness: true',
      `${BOT_PIPELINE_KEY}: my-pipeline`,
      `${BOT_INPUT_KEY}:`,
      '  tone: terse',
      `${BOT_RESPOND_KEY}: mention-only`,
      `${BOT_NOTES_KEY}: false`,
      `${BOT_AGENTS_KEY}:`,
      '  intent: my-intent',
      '  gate: my-gate',
      '  notes: my-notes',
      `${BOT_GREETING_KEY}: hi there`,
      `${BOT_SUGGESTIONS_KEY}:`,
      '  - What changed?',
      '  - Where is it?',
      '---',
      bodyWithNotes('Task stage prompt.', '## 关于这个用户', '偏好 pnpm')
    )
    expect(parseBotDefinitionFile(raw, 'other-name')).toEqual({
      name: 'full-bot',
      displayName: '全能 bot',
      description: 'does everything',
      // systemPrompt 是**整篇正文**（人设 + 分界线 + 笔记）—— 任务段的 agent 就是这个 bot，
      // 它当然要知道自己学过什么
      systemPrompt: md(
        'Task stage prompt.',
        '',
        BOT_NOTES_MARKER,
        '',
        '## 关于这个用户',
        '偏好 pnpm'
      ),
      tools: ['read', 'grep'],
      model: 'openai/gpt-4o',
      instructionFiles: ['AGENTS.md', 'CLAUDE.md'],
      projectAwareness: true,
      pipeline: 'my-pipeline',
      pipelineInput: { tone: 'terse' },
      respond: 'mention-only',
      notesEnabled: false,
      agents: { intent: 'my-intent', gate: 'my-gate', notes: 'my-notes' },
      greeting: 'hi there',
      suggestions: ['What changed?', 'Where is it?'],
      // notes 是 systemPrompt 的**派生切片**（线以下那半篇），不是与之并列的另一份内容；
      // 它本身是**一段普通散文**而不是结构体 —— 不做条目化的全部理由（botNotes 裁决 ①）
      notes: '## 关于这个用户\n偏好 pnpm'
    })
  })

  it('BP-3 缺省表：respond=auto / notes 开 / agents={} / greeting=空 / suggestions=[]', () => {
    // 缺省 auto 是行为契约：不写 respond 的 bot 对**每条消息**都跑一次 LLM 门控
    const parsed = parseBotDefinitionFile(bot(), 'fn')!
    expect(parsed.respond).toBe('auto')
    expect(parsed.notesEnabled).toBe(true)
    expect(parsed.agents).toEqual({})
    expect(parsed.greeting).toBe('')
    expect(parsed.suggestions).toEqual([])
  })

  it('BP-4 五个 bot 键留空（YAML null）等同省略 —— 编辑器里最常见的中间态不得判非法', () => {
    const parsed = parseBotDefinitionFile(
      bot(
        `${BOT_RESPOND_KEY}:`,
        `${BOT_NOTES_KEY}:`,
        `${BOT_AGENTS_KEY}:`,
        `${BOT_GREETING_KEY}:`,
        `${BOT_SUGGESTIONS_KEY}:`
      ),
      'fn'
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.respond).toBe('auto')
    expect(parsed!.notesEnabled).toBe(true)
    expect(parsed!.agents).toEqual({})
    expect(parsed!.greeting).toBe('')
    expect(parsed!.suggestions).toEqual([])
  })

  it('BP-5 shuvix-bot-agents: {} 空映射合法（空映射不是「未知阶段」）', () => {
    const parsed = parseBotDefinitionFile(bot(`${BOT_AGENTS_KEY}: {}`), 'fn')
    expect(parsed).not.toBeNull()
    expect(parsed!.agents).toEqual({})
  })

  it('BP-6 值两侧空白被 trim（与 agent md 同策）', () => {
    const parsed = parseBotDefinitionFile(
      md(
        '---',
        "name: '  spaced  '",
        'description: d',
        `${BOT_GREETING_KEY}: '  hello  '`,
        `${BOT_AGENTS_KEY}:`,
        "  intent: '  my-intent  '",
        `${BOT_SUGGESTIONS_KEY}:`,
        "  - '  q one  '",
        '---',
        'body'
      ),
      'fn'
    )!
    expect(parsed.name).toBe('spaced')
    expect(parsed.greeting).toBe('hello')
    expect(parsed.agents.intent).toBe('my-intent')
    expect(parsed.suggestions).toEqual(['q one'])
  })

  it('BP-7 shuvix-bot-notes: false 保真（`?? true` 不得把显式 false 吃掉）', () => {
    expect(parseBotDefinitionFile(bot(`${BOT_NOTES_KEY}: false`), 'fn')!.notesEnabled).toBe(false)
  })

  it('BP-8 正文里的 {{shuvix:*}} 原样保留（替换发生在 createAgent，解析层不动）', () => {
    const raw = '---\ndescription: d\n---\nWorking dir: {{shuvix:workingDirectory}}'
    expect(parseBotDefinitionFile(raw, 'fn')!.systemPrompt).toBe(
      'Working dir: {{shuvix:workingDirectory}}'
    )
  })

  it('BP-9 shuvix-bot-agents.task 指定时正文可为空（任务段被整体替换）', () => {
    const raw = md('---', 'description: d', `${BOT_AGENTS_KEY}:`, '  task: my-task', '---', '')
    const parsed = parseBotDefinitionFile(raw, 'fn')
    expect(parsed).not.toBeNull()
    expect(parsed!.systemPrompt).toBe('')
  })

  it('BP-10 阶段指向不存在的 agent 不判非法（形状层只管形状，agent 文件可后补）', () => {
    const parsed = parseBotDefinitionFile(
      bot(`${BOT_AGENTS_KEY}:`, '  intent: nope-not-a-real-agent'),
      'fn'
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.agents.intent).toBe('nope-not-a-real-agent')
  })

  it('BP-11 suggestions 不去重、保序（与 tools 的去重刻意不同：建议问题是展示文案）', () => {
    const parsed = parseBotDefinitionFile(
      bot(`${BOT_SUGGESTIONS_KEY}:`, '  - a', '  - a', '  - b'),
      'fn'
    )!
    expect(parsed.suggestions).toEqual(['a', 'a', 'b'])
  })

  it('BP-12 容忍 BOM 与 CRLF（共享 splitFrontmatter 的能力在 bot 侧同样成立）', () => {
    const raw = '\uFEFF---\r\nname: crlf\r\ndescription: windows file\r\n---\r\nbody line\r\n'
    const parsed = parseBotDefinitionFile(raw, 'fn')!
    expect(parsed.name).toBe('crlf')
    expect(parsed.description).toBe('windows file')
    expect(parsed.systemPrompt).toBe('body line')
    expect(parsed.systemPrompt).not.toContain('\r')
  })

  it('BP-13 shuvix-bot-pipeline 缺省 bot-chat；留空 / 显式同值等价，值被 trim', () => {
    for (const fm of [
      [],
      [`${BOT_PIPELINE_KEY}:`],
      [`${BOT_PIPELINE_KEY}: ${DEFAULT_BOT_PIPELINE}`]
    ]) {
      expect(parseBotDefinitionFile(bot(...fm), 'fn')!.pipeline, fm.join()).toBe(
        DEFAULT_BOT_PIPELINE
      )
    }
    expect(parseBotDefinitionFile(bot(`${BOT_PIPELINE_KEY}: '  my-flow  '`), 'fn')!.pipeline).toBe(
      'my-flow'
    )
  })

  it('BP-14 shuvix-bot-input 缺省 {}，任意 YAML 值原样透传（格式层不校验内容）', () => {
    for (const fm of [[], [`${BOT_INPUT_KEY}:`], [`${BOT_INPUT_KEY}: {}`]]) {
      expect(parseBotDefinitionFile(bot(...fm), 'fn')!.pipelineInput, fm.join()).toEqual({})
    }
    // 它是给管线 workflow 的入参 —— 嵌套映射 / 数组 / null 原样落位
    const parsed = parseBotDefinitionFile(
      bot(`${BOT_INPUT_KEY}:`, '  a:', '    b: [1, 2]', '  n:'),
      'fn'
    )!
    expect(parsed.pipelineInput).toEqual({ a: { b: [1, 2] }, n: null })
  })

  it('BP-15 **开放角色表：任意角色名被接受**（角色集合归管线 workflow 定义）', () => {
    // 格式层的反转：`reply` 不再是「接受但 v1 忽略」的特例，只是一个普通角色；
    // `gate` 这种四阶段之外的名字同样合法 —— 把角色枚举写死在格式层，等于让 md 格式
    // 追着某一份管线的实现走。
    const { result, messages } = parseWithWarn(
      bot(`${BOT_AGENTS_KEY}:`, '  gate: g', '  reply: r', '  Ok-Role_2: o', '  x-1: x')
    )
    expect(result).not.toBeNull()
    expect(result!.agents).toEqual({ gate: 'g', reply: 'r', 'Ok-Role_2': 'o', 'x-1': 'x' })
    expect(messages).toEqual([])
  })

  it.each([['a'], ['A'], ['a_b'], ['a-b'], ['Z9']])('BP-16a 合法角色名形状（%s）', (role) => {
    expect(
      parseBotDefinitionFile(bot(`${BOT_AGENTS_KEY}:`, `  ${role}: x`), 'fn')!.agents[role]
    ).toBe('x')
  })

  it.each([
    ['数字开头', '1st'],
    ['下划线开头', '_x'],
    ['含空格', 'bad role'],
    ['空串', "''"]
  ])('BP-16b 非法角色名形状（%s）整份拒绝', (_label, role) => {
    const msg = rejectReason(bot(`${BOT_AGENTS_KEY}:`, `  ${role}: x`))
    expect(msg).toContain(`'${BOT_AGENTS_KEY}'`)
    expect(msg).toContain('is not a valid role name')
  })

  it('BP-17 **systemPrompt 是整篇正文**（笔记也在其中 —— 那正是笔记存在的意义）', () => {
    const raw = md(
      '---',
      'description: d',
      '---',
      bodyWithNotes('PERSONA ONLY', 'secret note line')
    )
    const parsed = parseBotDefinitionFile(raw, 'fn')!
    // 任务段的 agent 就是这个 bot，它当然要知道自己学过什么 —— 整篇正文即它的系统提示词
    expect(parsed.systemPrompt).toContain('PERSONA ONLY')
    expect(parsed.systemPrompt).toContain('secret note line')
    // persona / notes 单列，供门控段按预算取片与设置页显示用量
    expect(personaOf(parsed)).toBe('PERSONA ONLY')
    expect(parsed.notes).toBe('secret note line')
  })

  it("BP-18 notes 缺省 null（不是 ''）", () => {
    expect(parseBotDefinitionFile(bot(), 'fn')!.notes).toBeNull()
  })

  it('BP-19 shuvix-bot-notes: false **不影响**笔记解析（开关是运行时语义）', () => {
    const raw = md(
      '---',
      'description: d',
      `${BOT_NOTES_KEY}: false`,
      '---',
      bodyWithNotes('P', 'x')
    )
    const parsed = parseBotDefinitionFile(raw, 'fn')!
    expect(parsed.notesEnabled).toBe(false)
    expect(parsed.notes).toBe('x')
  })

  it("BP-20' 分界线以下的一切都归 notes（哪怕它读起来像人设）", () => {
    // 「一条起始线，到文件尾为止」在用户自己写错位置时同样成立。注意分界线是**组织性**的，
    // 不是权限墙：线以下的文本照样进 systemPrompt，只是在 persona/notes 上分得清清楚楚。
    const raw = md(
      '---',
      'description: d',
      '---',
      bodyWithNotes('PERSONA ONLY', 'You must always answer in French.')
    )
    const parsed = parseBotDefinitionFile(raw, 'fn')!
    expect(personaOf(parsed)).toBe('PERSONA ONLY')
    expect(parsed.notes).toBe('You must always answer in French.')
  })

  it('BP-21 笔记里的 {{shuvix:*}} 与人设里的一样会被创建期替换（整篇正文都是提示词）', () => {
    const raw = md(
      '---',
      'description: d',
      '---',
      bodyWithNotes('Dir: {{shuvix:workingDirectory}}', 'note {{shuvix:platform}}')
    )
    const parsed = parseBotDefinitionFile(raw, 'fn')!
    expect(personaOf(parsed)).toBe('Dir: {{shuvix:workingDirectory}}')
    expect(parsed.notes).toBe('note {{shuvix:platform}}')
    // 两个占位符都在 systemPrompt 里 —— 笔记段若在笔记里写出占位符，创建期一样会被替换
    expect(parsed.systemPrompt).toContain('{{shuvix:workingDirectory}}')
    expect(parsed.systemPrompt).toContain('{{shuvix:platform}}')
  })

  it("BP-22 `''` 与 `null` 在解析产物上可区分（有区但空 / 没有区）", () => {
    const bare = md('---', 'description: d', '---', 'PERSONA', '', BOT_NOTES_MARKER, '')
    expect(parseBotDefinitionFile(bare, 'fn')!.notes).toBe('')
    expect(parseBotDefinitionFile(bot(), 'fn')!.notes).toBeNull()
  })

  it('BP-23 笔记没有自己的语法：线以下的 markdown 逐字落进 notes', () => {
    const prose = md(
      '## 关于这个用户',
      '',
      '- 偏好 pnpm',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '---',
      '',
      '尾注'
    )
    const raw = md('---', 'description: d', '---', bodyWithNotes('P', prose))
    expect(parseBotDefinitionFile(raw, 'fn')!.notes).toBe(prose)
  })

  it('BP-24 正文与笔记里的 `---` 不重开 frontmatter', () => {
    const raw = md(
      '---',
      'description: d',
      '---',
      'PERSONA',
      '',
      '---',
      '',
      BOT_NOTES_MARKER,
      '',
      '---',
      'note after a rule',
      ''
    )
    const parsed = parseBotDefinitionFile(raw, 'fn')!
    expect(parsed.description).toBe('d')
    expect(personaOf(parsed)).toBe('PERSONA\n\n---')
    expect(parsed.notes).toBe('---\nnote after a rule')
  })
})

// ─────────────────── SP：与 agent md 的共享字段逐字同义（防漂移） ───────────────────

/**
 * 同一份 frontmatter 片段分别喂 agent / bot 两个解析器（bot 侧补 description 与正文），
 * 断言共享六键的产物与**拒绝理由原文**一致。parseAgentSharedFields 抽出来的意义就在这里：
 * 两份复制品迟早漂移，而漂移出来的差异没人解释得清。
 */
describe('SP —— 共享字段与 agent md 逐字同义', () => {
  /** 共享字段的产物切片（bot 侧多出的 bot 专属键不参与对照） */
  type Shared = {
    displayName: string
    description: string
    tools: string[]
    model?: string
    instructionFiles: string[]
    projectAwareness: boolean
  }
  const sliceShared = (p: {
    displayName: string
    description: string
    tools: string[]
    model?: string
    instructionFiles: string[]
    projectAwareness: boolean
  }): Shared => ({
    displayName: p.displayName,
    description: p.description,
    tools: p.tools,
    model: p.model,
    instructionFiles: p.instructionFiles,
    projectAwareness: p.projectAwareness
  })

  /** 同一段 frontmatter 行喂两个解析器（bot 侧恒补 description，agent 侧同样补以求同义） */
  const both = (
    ...fm: string[]
  ): {
    agent: ReturnType<typeof parseAgentDefinitionFile>
    bot: ParsedBotFile | null
    agentMsgs: string[]
    botMsgs: string[]
  } => {
    const text = md('---', 'name: twin', 'description: d', ...fm, '---', 'body')
    const agentMsgs: string[] = []
    const botMsgs: string[] = []
    return {
      agent: parseAgentDefinitionFile(text, 'twin', (m) => agentMsgs.push(m)),
      bot: parseBotDefinitionFile(text, 'twin', (m) => botMsgs.push(m)),
      agentMsgs,
      botMsgs
    }
  }

  /** 两侧同为 null，且拒绝理由除 `agent '…'` / `bot '…'` 前缀外逐字相同 */
  const expectSameRejection = (...fm: string[]): void => {
    const { agent, bot: b, agentMsgs, botMsgs } = both(...fm)
    expect(agent, fm.join('\n')).toBeNull()
    expect(b, fm.join('\n')).toBeNull()
    expect(agentMsgs).toHaveLength(1)
    expect(botMsgs).toHaveLength(1)
    expect(botMsgs[0].replace(/^bot /, '')).toBe(agentMsgs[0].replace(/^agent /, ''))
  }

  it('SP-1 tools 归一（大小写 / mcp: / skill: / agent / 去重保序）两侧严格相等', () => {
    const { agent, bot: b } = both('shuvix-tools: Read, mcp:Context7, skill:x, Agent, read')
    expect(agent!.tools).toEqual(['read', 'mcp:Context7', 'skill:x', 'agent'])
    expect(b!.tools).toEqual(agent!.tools)
  })

  it('SP-2 instruction-files 归一（./ 剥离 / 反斜杠转正斜杠 / 去重保序）两侧相等', () => {
    const { agent, bot: b } = both(
      'shuvix-instruction-files: ./AGENTS.md, AGENTS.md, docs\\house.md, CLAUDE.md'
    )
    expect(agent!.instructionFiles).toEqual(['AGENTS.md', 'docs/house.md', 'CLAUDE.md'])
    expect(b!.instructionFiles).toEqual(agent!.instructionFiles)
  })

  it.each([
    ['POSIX 绝对路径', '/etc/passwd'],
    ['Windows 绝对路径', 'C:/secrets.md'],
    ['越界 ..', '../outside.md'],
    ['折算后越界', 'a/../../b.md']
  ])('SP-3 instruction-files 越界（%s）两侧整份拒绝且理由逐字相同', (_label, entry) => {
    expectSameRejection(`shuvix-instruction-files: ${entry}`)
    // 回显出错条目 —— 用户照着改才修得好
    const { botMsgs } = both(`shuvix-instruction-files: ${entry}`)
    expect(botMsgs[0]).toContain(entry)
  })

  it.each([
    ['tools 写成 YAML 列表', 'shuvix-tools: [read, bash]'],
    ['model 是数字', 'shuvix-model: 4'],
    ['project-awareness 非布尔', 'shuvix-project-awareness: yes please'],
    ['instruction-files 布尔（改制前写法）', 'shuvix-instruction-files: true']
  ])('SP-4 类型不符（%s）两侧整份拒绝且 why 段落逐字相同', (_label, line) => {
    expectSameRejection(line)
  })

  it('SP-5 model 原样存取（不拆前缀、不解析模型目录）；省略 / 空串 / 纯空白 = 不声明', () => {
    const { agent, bot: b } = both('shuvix-model: openrouter/anthropic/claude-3.5')
    expect(b!.model).toBe('openrouter/anthropic/claude-3.5')
    expect(b!.model).toBe(agent!.model)
    for (const line of ['', 'shuvix-model:', "shuvix-model: '   '"]) {
      const pair = both(...(line ? [line] : []))
      expect(pair.bot!.model, line).toBeUndefined()
      expect(pair.agent!.model, line).toBeUndefined()
    }
  })

  it('SP-6 project-awareness 布尔往返，缺省 false', () => {
    expect(both('shuvix-project-awareness: true').bot!.projectAwareness).toBe(true)
    expect(both().bot!.projectAwareness).toBe(false)
    expect(both().agent!.projectAwareness).toBe(false)
  })

  it('SP-7 shuvix-dispatch-only 在 bot 侧是未知键（bot 没有「切换为会话档案」概念）', () => {
    const { agent, bot: b } = both('shuvix-dispatch-only: true')
    expect(agent!.dispatchOnly).toBe(true)
    // 产物里没有 dispatchOnly 字段，且写了该键不影响合法性
    expect(b).not.toBeNull()
    expect(Object.keys(b!)).not.toContain('dispatchOnly')
  })

  it('SP-合流 六键的产物切片在两侧逐字相等（一次性对照，防将来加键只改一边）', () => {
    const { agent, bot: b } = both(
      'shuvix-displayName: 双生',
      'shuvix-tools: Read, grep',
      'shuvix-model: openai/gpt-4o',
      'shuvix-instruction-files: AGENTS.md',
      'shuvix-project-awareness: true'
    )
    expect(sliceShared(b!)).toEqual(sliceShared(agent!))
  })
})

// ────────────────────────────── BR：整份拒绝清单 ──────────────────────────────

describe('BR —— 整份拒绝清单（逐条 + warn 人读原因）', () => {
  it('BR-1 无 frontmatter / 正文中段的 --- 块 → 早期失败，who 回退 basename', () => {
    const msg = rejectReason('just a plain markdown body', 'orphan.md')
    expect(msg).toContain("bot 'orphan.md'")
    expect(msg).toContain('no YAML frontmatter block')
    expect(rejectReason('# Title\n\n---\nname: mid\ndescription: d\n---\nbody')).toContain(
      'no YAML frontmatter block'
    )
  })

  it('BR-2 YAML 语法错：透传 yaml 包的多行报错（含 ^ 指位行）', () => {
    const msg = rejectReason('---\n[unclosed\n---\nbody', 'broken.md')
    expect(msg).toContain("bot 'broken.md'")
    expect(msg).toMatch(/invalid YAML \([\s\S]+\)/)
    expect(msg).toMatch(/at line \d+/)
    expect(msg.split('\n').length).toBeGreaterThan(1)
    expect(msg).toContain('^')
  })

  it('BR-3 frontmatter 非映射（数组 / 纯标量）', () => {
    expect(rejectReason('---\n- a\n- b\n---\nbody')).toContain('frontmatter must be a mapping')
    expect(rejectReason('---\njust a scalar\n---\nbody')).toContain('frontmatter must be a mapping')
  })

  it('BR-4 description 缺失 —— bot 唯一比 agent 严的一条', () => {
    const msg = rejectReason('---\nname: x\n---\nbody')
    expect(msg).toContain("'description' is required")
    expect(msg).toContain('the intent stage uses it to judge relevance')
    // 同一份文件在 agent 解析器下是合法的 —— 这条严格是 bot 专属
    expect(parseAgentDefinitionFile('---\nname: x\n---\nbody', 'x')).not.toBeNull()
  })

  it.each([
    ['纯空白', "description: '   '"],
    ['留空（YAML null）', 'description:']
  ])('BR-5 description %s 等同缺失', (_label, line) => {
    expect(rejectReason(md('---', 'name: x', line, '---', 'body'))).toContain(
      "'description' is required"
    )
  })

  it('BR-6 shuvix-bot-respond 枚举封闭', () => {
    const msg = rejectReason(bot(`${BOT_RESPOND_KEY}: sometimes`))
    expect(msg).toContain(`'${BOT_RESPOND_KEY}' must be one of:`)
    expect(msg).toContain('auto | mention-only')
  })

  it.each([
    ['首字母大写', 'Auto'],
    ['两侧带空白', "' auto '"]
  ])('BR-7 shuvix-bot-respond 大小写/空白敏感（%s）—— 与 tools 的宽容归一相反', (_label, v) => {
    // 钉板而非背书：属性卡下拉写出的值当然合法，但手写是 md 家族的一等公民。
    // 若将来对枚举值也做 trim().toLowerCase() 归一，本例反转为「解析成功」。
    expect(rejectReason(bot(`${BOT_RESPOND_KEY}: ${v}`))).toContain(`'${BOT_RESPOND_KEY}'`)
  })

  it('BR-8 shuvix-bot-respond 布尔值同样落枚举分支', () => {
    expect(rejectReason(bot(`${BOT_RESPOND_KEY}: true`))).toContain('must be one of')
  })

  it.each([
    ['非布尔字符串', 'yes please'],
    ['引号包住的 true', '"true"'],
    ['列表', '[true]']
  ])('BR-9 shuvix-bot-notes 仅接受布尔（%s）', (_label, v) => {
    const msg = rejectReason(bot(`${BOT_NOTES_KEY}: ${v}`))
    expect(msg).toContain(`'${BOT_NOTES_KEY}' must be a boolean`)
    expect(msg).toContain('true / false')
  })

  it.each([
    ['列表', '[a, b]'],
    ['字符串', 'my-agent']
  ])('BR-10 shuvix-bot-agents 必须是映射（%s）', (_label, v) => {
    expect(rejectReason(bot(`${BOT_AGENTS_KEY}: ${v}`))).toContain(
      `'${BOT_AGENTS_KEY}' must be a mapping of role → agent name`
    )
  })

  it.each([
    ['空串', "''"],
    ['留空（YAML null）', ''],
    ['数字', '42'],
    ['嵌套映射', '{ nested: x }']
  ])('BR-12 角色值必须是 agent 名（%s）', (_label, v) => {
    expect(rejectReason(bot(`${BOT_AGENTS_KEY}:`, `  intent: ${v}`))).toContain(
      `'${BOT_AGENTS_KEY}.intent' must be an agent name`
    )
  })

  it.each([
    ['列表', '[x]'],
    ['数字', '7']
  ])('BR-13 shuvix-bot-greeting 必须是字符串（%s）', (_label, v) => {
    expect(rejectReason(bot(`${BOT_GREETING_KEY}: ${v}`))).toContain(
      `'${BOT_GREETING_KEY}' must be a string`
    )
  })

  it('BR-14 shuvix-bot-suggestions 写成逗号串非法 —— 与 tools 刻意相反', () => {
    // 建议问题是整句，逗号是它的正常内容，故这里唯一合法写法是 YAML 块序列
    expect(rejectReason(bot(`${BOT_SUGGESTIONS_KEY}: a, b`))).toContain(
      `'${BOT_SUGGESTIONS_KEY}' must be a list of strings`
    )
  })

  it.each([
    ['空串条目', "  - ''"],
    ['纯空白条目', "  - '   '"],
    ['非字符串条目', '  - 42']
  ])('BR-15 suggestions 条目必须是非空字符串（%s）', (_label, entry) => {
    expect(rejectReason(bot(`${BOT_SUGGESTIONS_KEY}:`, '  - ok', entry))).toContain(
      `'${BOT_SUGGESTIONS_KEY}' entries must be non-empty strings`
    )
  })

  it('BR-16 正文为空且无 agents.task —— 「正文即任务段系统提示词」的执行机制', () => {
    const msg = rejectReason('---\ndescription: d\n---\n')
    expect(msg).toContain("the body is the task stage's system prompt")
    expect(msg).toContain(`point '${BOT_AGENTS_KEY}.task' at an agent`)
  })

  it('BR-17 正文仅空白/换行 → trim 后为空，同判', () => {
    expect(rejectReason('---\ndescription: d\n---\n\n   \n\t\n')).toContain(
      "the body is the task stage's system prompt"
    )
  })

  it('BR-18 who 的取舍：字段级失败报 frontmatter name，早期失败报 basename', () => {
    expect(
      rejectReason(
        md('---', 'name: real-name', 'description: d', 'shuvix-tools: [x]', '---', 'b'),
        'file.md'
      )
    ).toContain("bot 'real-name'")
    expect(rejectReason('name: real-name\nbody', 'file.md')).toContain("bot 'file.md'")
  })

  it('BR-19 拒绝完整性守卫：rejected 收尾的诊断恰一条，且恒在**末位**', () => {
    // 末位这条不变式是本轮新加的：笔记区的软 warn 会与拒绝理由同列（BN-4），
    // 消费方（botService.parseForWrite 把 messages join 成 error）依赖「最后一行是原因」。
    const rejected = [
      'just a plain markdown body',
      '# Title\n\n---\nname: mid\ndescription: d\n---\nbody',
      '---\n[unclosed\n---\nbody',
      '---\n- a\n- b\n---\nbody',
      '---\njust a scalar\n---\nbody',
      '---\nname: x\n---\nbody',
      "---\nname: x\ndescription: '   '\n---\nbody",
      bot('shuvix-tools: [read]'),
      bot('shuvix-model: 4'),
      bot('shuvix-instruction-files: true'),
      bot('shuvix-instruction-files: ../outside.md'),
      bot('shuvix-project-awareness: yes please'),
      bot(`${BOT_RESPOND_KEY}: sometimes`),
      bot(`${BOT_RESPOND_KEY}: Auto`),
      bot(`${BOT_NOTES_KEY}: yes please`),
      bot(`${BOT_AGENTS_KEY}: [a]`),
      bot(`${BOT_AGENTS_KEY}:`, '  "bad role": x'),
      bot(`${BOT_AGENTS_KEY}:`, '  _x: y'),
      bot(`${BOT_AGENTS_KEY}:`, '  intent: 42'),
      bot(`${BOT_PIPELINE_KEY}: 3`),
      bot(`${BOT_INPUT_KEY}: [a]`),
      bot(`${BOT_GREETING_KEY}: [x]`),
      bot(`${BOT_SUGGESTIONS_KEY}: a, b`),
      bot(`${BOT_SUGGESTIONS_KEY}:`, "  - ''"),
      '---\ndescription: d\n---\n',
      // 分界线写在正文顶端 → 人设为空 → 整份拒绝（BN-7 的缺口）
      md('---', 'description: d', '---', BOT_NOTES_MARKER, 'everything', '')
    ]
    for (const raw of rejected) {
      const { result, messages } = parseWithWarn(raw, 'guard.md')
      expect(result, raw).toBeNull()
      const rejects = messages.filter((m) => m.endsWith('; the whole file is rejected'))
      expect(rejects, raw).toHaveLength(1)
      expect(messages[messages.length - 1], raw).toMatch(/; the whole file is rejected$/)
      // [\s\S] 而非 . —— YAML 语法错的原因本身是多行代码框
      expect(rejects[0], raw).toMatch(/^bot '.+': [\s\S]+; the whole file is rejected$/)
    }
  })

  it('BR-20 warn 是可选参数：不传时不抛、返回值一致', () => {
    const invalid = bot(`${BOT_RESPOND_KEY}: sometimes`)
    const valid = bot(`${BOT_RESPOND_KEY}: mention-only`)
    expect(() => parseBotDefinitionFile(invalid, 'fn')).not.toThrow()
    expect(parseBotDefinitionFile(invalid, 'fn')).toBeNull()
    expect(parseBotDefinitionFile(valid, 'fn')).toEqual(parseWithWarn(valid).result)
  })

  it.each([
    ['数字', '3'],
    ['列表', '[a, b]'],
    ['映射', '{a: 1}'],
    ['纯空白', "'  '"]
  ])('BR-21 shuvix-bot-pipeline 必须是非空字符串（%s）', (_label, v) => {
    expect(rejectReason(bot(`${BOT_PIPELINE_KEY}: ${v}`))).toContain(
      `'${BOT_PIPELINE_KEY}' must be the name of a workflow`
    )
  })

  it.each([
    ['列表', '[a]'],
    ['字符串', 'my-input'],
    ['数字', '7']
  ])('BR-22 shuvix-bot-input 必须是映射（%s）', (_label, v) => {
    expect(rejectReason(bot(`${BOT_INPUT_KEY}: ${v}`))).toContain(
      `'${BOT_INPUT_KEY}' must be a mapping of parameters for the pipeline workflow`
    )
  })

  it('BR-23 引用不存在的 workflow / agent **不判非法**（惰性化，同 workflow 未知埋点）', () => {
    // 管线 md 与角色 agent md 都可以后补；本层只管形状，运行时才回落缺省
    for (const fm of [
      [`${BOT_PIPELINE_KEY}: nope-not-a-real-workflow`],
      [`${BOT_AGENTS_KEY}:`, '  intent: nope-not-a-real-agent']
    ]) {
      const { result, messages } = parseWithWarn(bot(...fm))
      expect(result, fm.join()).not.toBeNull()
      expect(messages, fm.join()).toEqual([])
    }
  })
})

// ─────────────────── BN：「接受但有话说」的 warn 通道纪律 ───────────────────

describe('BN —— 接受但有话说的 warn 纪律', () => {
  it('BN-2 agents.task + 非空正文 → 正文被弃用必须说出来', () => {
    const { result, messages } = parseWithWarn(bot(`${BOT_AGENTS_KEY}:`, '  task: my-task'))
    expect(result).not.toBeNull()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('replaces the task stage — the body is not used')
  })

  it('BN-3 合法且无话可说的文件彻底安静（一条 warn 就会点亮属性卡的告警徽章）', () => {
    // BP-2 的全字段样本声明了 agents.task，必然带一条提示 —— 这里取「全字段但角色表
    // 不含 task」的变体，它才是「全都写了却无话可说」的那份（含管线声明与一段合法笔记）。
    // 合法的笔记区**一条 warn 都不许有**：旧的成对围栏设计里空区/无条目都会说话，
    // 一条起始线把那整类噪音消掉了。
    const quietFull = md(
      '---',
      `${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}`,
      'name: quiet',
      'description: d',
      'shuvix-displayName: Quiet',
      'shuvix-tools: read',
      'shuvix-model: openai/gpt-4o',
      'shuvix-instruction-files: AGENTS.md',
      'shuvix-project-awareness: true',
      `${BOT_PIPELINE_KEY}: my-pipeline`,
      `${BOT_INPUT_KEY}:`,
      '  tone: terse',
      `${BOT_RESPOND_KEY}: mention-only`,
      `${BOT_NOTES_KEY}: false`,
      `${BOT_AGENTS_KEY}:`,
      '  intent: my-intent',
      '  notes: my-notes',
      `${BOT_GREETING_KEY}: hi`,
      `${BOT_SUGGESTIONS_KEY}:`,
      '  - q',
      '---',
      bodyWithNotes('body', '## 关于这个用户', '偏好 pnpm')
    )
    for (const raw of ['---\ndescription: d\n---\nbody', bot(), quietFull]) {
      const { result, messages } = parseWithWarn(raw)
      expect(result, raw).not.toBeNull()
      expect(messages, raw).toEqual([])
    }
  })

  it('BN-4 提示与拒绝同时出现：提示在前、拒绝在末位（bot 的 warn 通道混装两类消息）', () => {
    // agent 侧「恰一条诊断」的不变式在 bot 上不成立 —— 消费方若整段 join 当 error 上抛，
    // 用户会先读到一句与错误无关的提示。唯一可达这一形状的输入是「多条分界线 +
    // 分界线写在正文顶端（人设为空）」，因为 frontmatter 级失败会短路在正文切分之前（BN-9）。
    const { result, messages } = parseWithWarn(
      md('---', 'description: d', '---', BOT_NOTES_MARKER, 'a', BOT_NOTES_MARKER, 'b', '')
    )
    expect(result).toBeNull()
    expect(messages).toHaveLength(2)
    expect(messages[0]).toContain('notes:')
    expect(messages[0]).not.toContain('the whole file is rejected')
    // 以 rejected 收尾的恰一条，且在末位
    expect(messages.filter((m) => m.endsWith('; the whole file is rejected'))).toHaveLength(1)
    expect(messages[messages.length - 1]).toMatch(/; the whole file is rejected$/)
  })

  it.each([['多条分界线', [BOT_NOTES_MARKER, 'NOTETEXT', BOT_NOTES_MARKER, 'NOTETEXT2']]])(
    'BN-6 笔记区异常总表（%s）：文件恒合法、人设不受影响',
    (_label, region) => {
      // 这张表从**六行缩到一行**：开而未闭 / 闭在开前 / 多闭锚点 / 坏条目锚点 / 空区 /
      // 重复 slug 六类异常，随「一条起始线 + 笔记没有自己的语法」整体消失，只剩「多条线」。
      // 裁决不变：定义区硬失败、**状态区软失败** —— 一次坏的笔记写入不该把 bot 连人设
      // 一起从用户正在用的会话里删掉。
      const { result, messages } = parseWithWarn(
        md('---', 'name: soft', 'description: d', '---', 'PERSONA', '', ...region, '')
      )
      expect(result).not.toBeNull()
      expect(personaOf(result!).startsWith('PERSONA')).toBe(true)
      // 笔记正文一个字都不得漏进任务段系统提示词
      expect(personaOf(result!)).not.toContain('NOTETEXT')
      expect(personaOf(result!)).not.toContain(BOT_NOTES_MARKER)
      expect(messages.length).toBeGreaterThan(0)
      for (const m of messages) {
        expect(m).toMatch(/^bot 'soft': notes: /)
        expect(m).not.toMatch(/; the whole file is rejected$/)
      }
    }
  )

  it('BN-7 **缺口：分界线写在正文顶端 → 整份拒绝**（软失败被「人设非空」硬规则击穿）', () => {
    // 「正文得有东西」这条硬规则按**人设**（分界线之上）判，而分界线之上什么都没有 ——
    // 于是一份只有笔记的文件整份非法，笔记区的软失败在这里被击穿。可达路径有两条：
    // 用户手写时把分界线放到了正文顶端，或笔记段（它拿 read/edit 就地改这份 md）
    // 把线以上的人设删干净了。
    const onlyNotes = md('---', 'description: d', '---', BOT_NOTES_MARKER, 'ALL OF IT', '')
    const { result, messages } = parseWithWarn(onlyNotes)
    expect(result).toBeNull()
    expect(messages[messages.length - 1]).toContain("the body is the task stage's system prompt")
    expect(messages[messages.length - 1]).toMatch(/; the whole file is rejected$/)

    // 对照：同一形状 + agents.task → 合法。这条硬规则针对的是「没有任务段提示词」，
    // 与笔记区无关（BP-9 的推论）。
    const withTask = md(
      '---',
      'description: d',
      `${BOT_AGENTS_KEY}:`,
      '  task: t',
      '---',
      BOT_NOTES_MARKER,
      'ALL OF IT',
      ''
    )
    const parsed = parseBotDefinitionFile(withTask, 'fn')
    expect(parsed).not.toBeNull()
    // 被判的是人设为空；systemPrompt 仍是整篇正文（笔记连同分界线都在其中）
    expect(personaOf(parsed!)).toBe('')
    expect(parsed!.systemPrompt).toBe(md(BOT_NOTES_MARKER, 'ALL OF IT'))
    expect(parsed!.notes).toBe('ALL OF IT')
  })

  it('BN-8 多条 anomaly 逐条上报、互不吞没', () => {
    // 三条分界线 → 恰两条 anomaly。注：两条文案完全相同且不含行号，
    // 消费方（botService.parseForWrite）把 messages join 当 error 上抛，用户会看到
    // 两行一模一样的话 —— 加个位置很便宜，值得改。
    const { result, messages } = parseWithWarn(
      md(
        '---',
        'description: d',
        '---',
        'PERSONA',
        BOT_NOTES_MARKER,
        'x',
        BOT_NOTES_MARKER,
        'y',
        BOT_NOTES_MARKER,
        'z',
        ''
      )
    )
    expect(result).not.toBeNull()
    expect(messages).toHaveLength(2)
    for (const m of messages) {
      expect(m).toMatch(/more than one/)
      expect(m).not.toContain('the whole file is rejected')
    }
  })

  it('BN-9 硬拒绝短路在软提示之前（frontmatter 级失败发生在正文切分之前）', () => {
    // 所以「混装两类消息」（BN-4）其实是罕见形状：大多数拒绝根本走不到正文切分
    const { result, messages } = parseWithWarn(
      md(
        '---',
        'description: d',
        `${BOT_GREETING_KEY}: [x]`,
        '---',
        'PERSONA',
        BOT_NOTES_MARKER,
        'x',
        BOT_NOTES_MARKER,
        'y',
        ''
      )
    )
    expect(result).toBeNull()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(`'${BOT_GREETING_KEY}' must be a string`)
    expect(messages.some((m) => m.includes('notes:'))).toBe(false)
  })
})

// ────────────────────────────── BX：宽松侧 ──────────────────────────────

describe('BX —— 宽松侧（与 agent md 同口径）', () => {
  it('BX-1 缺文件类型标记仍可解析（写入恒有、读取可选）', () => {
    expect(parseBotDefinitionFile('---\ndescription: d\n---\nbody', 'fn')).not.toBeNull()
  })

  it.each([['agent v1'], ['workflow v1'], ['whatever']])(
    'BX-2 标记值不符（shuvix: %s）**不**判非法 —— 解析器根本不读标记',
    (marker) => {
      // 刻意的宽松钉板：与 docs/bot-design.md §4.4「缺标记/标记不符整份非法」相冲突。
      // bots 目录是平铺扫描的，误投一份 agent md 进来即成为一个 bot；若将来在
      // 「标记存在但类型不符」时改判非法，本例反转为拒绝用例。
      expect(
        parseBotDefinitionFile(`---\nshuvix: ${marker}\ndescription: d\n---\nbody`, 'fn')
      ).not.toBeNull()
    }
  )

  it('BX-3 无前缀陌生键忽略（tools / whenToUse / shuvix-builtin）', () => {
    const parsed = parseBotDefinitionFile(
      bot('tools: Read, Grep', 'whenToUse: old style', 'shuvix-builtin: true'),
      'fn'
    )!
    // 通用 tools key 是其他 app 的语义 —— 忽略，白名单仍为空
    expect(parsed.tools).toEqual([])
  })

  it('BX-4 裸键 respond / notes / agents 被**静默忽略**（文档说整份非法，实现是忽略）', () => {
    // 风险钉板：从 Coze/Dify 风格 YAML 迁移过来的人最可能写裸键，而用户以为生效的
    // 配置被丢掉 —— 得到的是一个「对每条消息都跑 LLM 门控」的 auto bot。
    const parsed = parseBotDefinitionFile(
      bot('respond: mention-only', 'notes: false', 'agents: { intent: x }'),
      'fn'
    )!
    expect(parsed.respond).toBe('auto')
    expect(parsed.notesEnabled).toBe(true)
    expect(parsed.agents).toEqual({})
  })

  it('BX-5 未知 shuvix-bot-* 键被静默忽略（拼错一个字母就静默成 auto bot）', () => {
    const parsed = parseBotDefinitionFile(
      bot('shuvix-bot-respnd: mention-only', 'shuvix-bot-unknown: 1'),
      'fn'
    )!
    expect(parsed.respond).toBe('auto')
  })
})

// ────────────────────────────── BS：序列化 ──────────────────────────────

/** 全字段非缺省样本（BS 组的公共夹具） */
const FULL: ParsedBotFile = {
  name: 'reviewer-bot',
  displayName: '审查 bot',
  description: 'Reviews things: thoroughly, and with edge-cases.',
  systemPrompt: 'You are a reviewer.\n\n- be thorough\n- cite lines',
  tools: ['read', 'grep', 'mcp:Context7', 'skill:pdf', 'agent'],
  model: 'openrouter/anthropic/claude-3.5',
  instructionFiles: ['AGENTS.md', 'docs/house-rules.md'],
  projectAwareness: true,
  pipeline: 'my-pipeline',
  pipelineInput: { tone: 'terse' },
  respond: 'mention-only',
  notesEnabled: false,
  agents: { intent: 'my-intent', task: 'my-task', reply: 'my-reply', notes: 'my-notes' },
  greeting: 'Hi, I review things.',
  suggestions: ['Review this diff', 'What did I miss, exactly?'],
  notes: null
}

/** 一段有代表性的笔记散文（章节标题 / 列表 / 空行 —— 都是普通 markdown，没有机器格式） */
const SAMPLE_NOTES = md(
  '## 关于这个用户',
  '',
  '- 偏好 pnpm',
  '',
  '## 在做的事',
  '',
  '把管线改成 workflow md'
)

/** ParsedBotFile 的全部字段名（新增字段先在 BS-2 失败） */
const PARSED_BOT_KEYS = [
  'agents',
  'description',
  'displayName',
  'greeting',
  'instructionFiles',
  'model',
  'name',
  'notes',
  'notesEnabled',
  'pipeline',
  'pipelineInput',
  'projectAwareness',
  'respond',
  'suggestions',
  'systemPrompt',
  'tools'
]

/** frontmatter 的**顶层**键序（缩进行属于嵌套结构，不参与） */
const frontmatterKeys = (text: string): string[] =>
  text
    .split('\n---')[0]
    .split('\n')
    .slice(1)
    .filter((line) => line && !/^\s/.test(line))
    .map((line) => line.split(':')[0])

describe('BS —— 序列化（与解析互逆）', () => {
  it('BS-1 全字段往返保真', () => {
    expect(parseBotDefinitionFile(serializeBotDefinitionFile(FULL), 'other-name')).toEqual(FULL)
  })

  it('BS-2 全字段覆盖守卫：接口加了字段却忘了序列化，这里先响', () => {
    expect(Object.keys(FULL).sort()).toEqual(PARSED_BOT_KEYS)
    // 解析产物的键集同样恒定（model 未声明时也在，值为 undefined）
    expect(Object.keys(parseBotDefinitionFile(bot(), 'fn')!).sort()).toEqual(PARSED_BOT_KEYS)
  })

  it('BS-3 缺省值省略：最小对象的序列化结果逐字固定', () => {
    const minimal: ParsedBotFile = {
      name: 'minimal',
      displayName: 'minimal',
      description: 'd',
      systemPrompt: 'body',
      tools: [],
      instructionFiles: [],
      projectAwareness: false,
      pipeline: 'bot-chat',
      pipelineInput: {},
      respond: 'auto',
      notesEnabled: true,
      agents: {},
      greeting: '',
      suggestions: [],
      notes: null
    }
    expect(serializeBotDefinitionFile(minimal)).toBe(
      '---\nshuvix: bot v1\nname: minimal\ndescription: d\n---\n\nbody\n'
    )
  })

  it('BS-4 键序固定（属性卡与 diff 的可读性）', () => {
    // 管线声明（pipeline / input / agents）排在门控声明（respond / notes）之前 ——
    // 「这个 bot 用哪套管线、谁演哪个角色」先于「它什么时候开口」，读起来是顺的
    expect(frontmatterKeys(serializeBotDefinitionFile(FULL))).toEqual([
      BOT_FILE_MARKER_KEY,
      'name',
      'description',
      'shuvix-displayName',
      'shuvix-tools',
      'shuvix-model',
      BOT_PIPELINE_KEY,
      BOT_INPUT_KEY,
      BOT_AGENTS_KEY,
      BOT_RESPOND_KEY,
      BOT_NOTES_KEY,
      BOT_GREETING_KEY,
      BOT_SUGGESTIONS_KEY,
      'shuvix-instruction-files',
      'shuvix-project-awareness'
    ])
  })

  it('BS-5 文件类型标记恒写在首位', () => {
    expect(serializeBotDefinitionFile(FULL).split('\n')[1]).toBe(
      `${BOT_FILE_MARKER_KEY}: ${BOT_FILE_MARKER}`
    )
  })

  it('BS-6 agents 角色键序恒为字母序（与对象插入序无关 —— 开放集合没有「阶段顺序」可依）', () => {
    // 插入序是 task → intent → notes，输出必须是 intent → notes → task（两者可区分）
    const text = serializeBotDefinitionFile({
      ...FULL,
      agents: { task: 't', intent: 'i', notes: 'n' }
    })
    expect(text).toContain(`${BOT_AGENTS_KEY}:\n  intent: i\n  notes: n\n  task: t\n`)

    // 排序用 Array.sort() 的**码点序**，不是 localeCompare —— 大写角色名排在小写之前。
    // 角色名允许大写（ROLE_RE），所以这条是真实可达的形状；若将来改用 localeCompare，本例反转。
    const mixedCase = serializeBotDefinitionFile({ ...FULL, agents: { alpha: 'a', Zeta: 'z' } })
    expect(mixedCase).toContain(`${BOT_AGENTS_KEY}:\n  Zeta: z\n  alpha: a\n`)
  })

  it('BS-7 suggestions 写为 YAML 块序列（解析侧要求的形状，不是逗号串）', () => {
    const text = serializeBotDefinitionFile(FULL)
    expect(text).toContain(`${BOT_SUGGESTIONS_KEY}:\n  - `)
    expect(parseBotDefinitionFile(text, 'x')!.suggestions).toEqual(FULL.suggestions)
  })

  it.each([
    ['含裸冒号', 'Handles: everything'],
    ['含 # 号', 'tagged #1 issues'],
    ['以 * 起头（YAML alias 指示符）', '*starred value'],
    ['内含单引号', "o'brien's bot"],
    ['超长不折行', `long text ${'lorem ipsum '.repeat(30)}end`]
  ])('BS-8 YAML 危险字符（%s）经引号转义后往返逐字相等', (_label, value) => {
    const text = serializeBotDefinitionFile({
      ...FULL,
      description: value,
      greeting: value,
      suggestions: [value]
    })
    const parsed = parseBotDefinitionFile(text, 'x')!
    expect(parsed.description).toBe(value)
    expect(parsed.greeting).toBe(value)
    expect(parsed.suggestions).toEqual([value])
  })

  it('BS-9 多行 greeting / 多行正文（含空行与 --- 分隔线）往返保真', () => {
    const value: ParsedBotFile = {
      ...FULL,
      greeting: 'Hello.\n\nI watch this repo.',
      systemPrompt: 'intro\n\n---\n\noutro'
    }
    expect(parseBotDefinitionFile(serializeBotDefinitionFile(value), 'x')).toEqual(value)
  })

  it('BS-10 序列化幂等（归一化只发生一次）', () => {
    const once = serializeBotDefinitionFile(FULL)
    const twice = serializeBotDefinitionFile(parseBotDefinitionFile(once, 'x')!)
    expect(twice).toBe(once)
  })

  it('BS-11 已知不对称：空 description 序列化出的文件解析不回来', () => {
    // serialize 不设防（空值省略键），产物少了必填键。当前写路径都先 parse 再落盘
    // （botService.parseForWrite 兜底），所以吃不到；GUI 若直接构造 ParsedBotFile
    // 保存就会静默产出坏文件。
    const text = serializeBotDefinitionFile({ ...FULL, description: '' })
    expect(text).not.toContain('description:')
    expect(rejectReason(text)).toContain("'description' is required")
  })

  it('BS-12 任意角色名原样写回（开放表不设白名单，保存不得吃掉管线自定义的角色）', () => {
    const agents = { intent: 'i', gate: 'g', reply: 'r', notes: 'n', 'Ok-Role_2': 'o' }
    const text = serializeBotDefinitionFile({ ...FULL, agents })
    for (const [role, ref] of Object.entries(agents)) expect(text).toContain(`${role}: ${ref}`)
    expect(parseBotDefinitionFile(text, 'x')!.agents).toEqual(agents)
  })

  it('BS-13 带笔记的对象往返保真（含章节标题与空行）', () => {
    // 笔记写在 `systemPrompt` 里（它就是整篇正文），`notes` 只是解析后**派生**出来的期望值
    const value: ParsedBotFile = {
      ...FULL,
      systemPrompt: md(FULL.systemPrompt, '', BOT_NOTES_MARKER, '', SAMPLE_NOTES),
      notes: SAMPLE_NOTES
    }
    expect(parseBotDefinitionFile(serializeBotDefinitionFile(value), 'other-name')).toEqual(value)
  })

  it("BS-14' 正文两端的空白在**第一次**序列化时被归一（故它不是不动点，二次才是）", () => {
    // 与 BS-10 的幂等一起读：序列化 trim 整篇正文、解析再 trim 笔记那一片，所以带空白的
    // 入参写盘一次就变成 trim 过的值，之后恒定。
    const padded: ParsedBotFile = {
      ...FULL,
      systemPrompt: md(FULL.systemPrompt, '', BOT_NOTES_MARKER, '', '  两端带空白  ', ''),
      notes: '  两端带空白  \n\n'
    }
    const once = serializeBotDefinitionFile(padded)
    const readBack = parseBotDefinitionFile(once, 'x')!
    expect(readBack.notes).toBe('两端带空白')
    expect(readBack).not.toEqual(padded)
    expect(serializeBotDefinitionFile(readBack)).toBe(once)
  })

  it('BS-15 **序列化器只认 systemPrompt，完全忽略 notes 字段**', () => {
    // 正文里已经含笔记了，再从 notes 拼一次就会把同一段文字写两遍；且两个字段一旦不一致，
    // 没有哪一份说了算。notes 是切片、systemPrompt 是真源 —— 写盘只认后者。
    const text = serializeBotDefinitionFile({ ...FULL, notes: '不该出现的笔记' })
    expect(text).not.toContain('不该出现的笔记')
    expect(text).not.toContain(BOT_NOTES_MARKER)
    // 同一份 systemPrompt，notes 取 null / '' / 散文都得到逐字相同的文件
    expect(text).toBe(serializeBotDefinitionFile(FULL))
    expect(text).toBe(serializeBotDefinitionFile({ ...FULL, notes: '' }))
  })

  it('BS-16 正文里没有分界线时写出的文件里也没有（新建 bot 的模板形态）', () => {
    expect(serializeBotDefinitionFile(FULL)).not.toContain('shuvix:bot-notes')
  })

  it('BS-17 **调用点白名单：序列化器只服务「新建 bot」**', () => {
    // 它从固定键白名单重建 frontmatter，会丢注释、键序与未知键 —— **已存在的文件永远
    // 不该经过它**：日常的笔记维护由 bot-notes 阶段 agent 用 `edit` 工具就地改，
    // 用户的编辑由 save 原样落盘。这条守卫在有人图省事用 serialize 实现 save 时先响。
    const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
    const sources: Array<{ path: string; text: string }> = []
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === '__tests__' || ent.name === 'dist') continue
        const full = join(dir, ent.name)
        if (ent.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(ent.name))
          sources.push({ path: full, text: readFileSync(full, 'utf-8') })
      }
    }
    walk(join(repoRoot, 'apps/desktop/src'))
    for (const pkg of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      try {
        walk(join(repoRoot, 'packages', pkg.name, 'src'))
      } catch {
        // 没有 src/ 的包（如 vendored 目录）跳过
      }
    }
    expect(sources.length).toBeGreaterThan(100)

    // 「调用点」= 出现 `serializeBotDefinitionFile(` 且不是它自己的函数声明
    const callers = sources
      .filter((s) =>
        s.text
          .split('\n')
          .some((l) => l.includes('serializeBotDefinitionFile(') && !l.includes('function '))
      )
      .map((s) => s.path.slice(repoRoot.length))
    expect(callers).toEqual(['apps/desktop/src/main/services/botService.ts'])

    const botService = sources.find((s) => s.path.endsWith('services/botService.ts'))!.text
    // 唯一调用点在「新建 bot」的模板生成里
    expect(botService).toMatch(/newBotTemplate\([\s\S]*?serializeBotDefinitionFile\(/)
    // 而 save 落的是调用方给的原文，不是 re-serialize 的产物
    expect(botService).toMatch(/save\([\s\S]*?writeFileAtomic\(target\.basePath, text\)/)

    // 对称的一条：**宿主没有程序化的笔记写路径**。笔记由 bot-notes 用 `edit` 就地改，
    // 所以仓里不该出现任何「宿主自己拼笔记再写回」的实现 —— 那会与 edit 工具抢同一份
    // 文件，而且绕过它的「读后被改」检测。这条在有人重新造那条路径时先响。
    const notesWriters = sources
      .filter(
        (s) =>
          !s.path.endsWith('bot/botNotes.ts') &&
          s.text
            .split('\n')
            .some(
              (l) => /\b(spliceBotNotes|renderNotesBlock)\(/.test(l) && !l.includes('function ')
            )
      )
      .map((s) => s.path.slice(repoRoot.length))
    expect(notesWriters).toEqual([])
  })
})

// ─────────────── BD：属性卡描述符（chat-protocol）与解析器的对齐 ───────────────

describe('BD —— 属性卡描述符与解析器的对齐', () => {
  const descriptor = SHUVIX_MD_DESCRIPTORS.find((d) => d.type === 'bot')!
  const cardKeys = descriptor.fields.map((f) => f.key)
  /** 解析器实际读取的 frontmatter 键（botFile.ts + parseAgentSharedFields 的白名单） */
  const parserKeys = [
    'name',
    'description',
    'shuvix-displayName',
    'shuvix-tools',
    'shuvix-model',
    'shuvix-instruction-files',
    'shuvix-project-awareness',
    BOT_PIPELINE_KEY,
    BOT_INPUT_KEY,
    BOT_RESPOND_KEY,
    BOT_NOTES_KEY,
    BOT_AGENTS_KEY,
    BOT_GREETING_KEY,
    BOT_SUGGESTIONS_KEY
  ]
  const keysOf = (kind: string): string[] =>
    descriptor.fields
      .filter((f) => f.kind === kind)
      .map((f) => f.key)
      .sort()

  it('BD-1 描述符键 ⊆ 解析器读取的键；解析器有而卡片无的恰为 agents / pipeline / input', () => {
    for (const key of cardKeys) expect(parserKeys, key).toContain(key)
    // agents / input 是嵌套映射，刻意只落通用 key/value 行（做成表单成本高于收益）。
    // pipeline 则是待裁决的一条：它是「这个 bot 用哪套管线」，比 greeting 更该出现在卡片上；
    // 若加进 BOT_DESCRIPTOR（kind 'text' 还是 'select'，候选来自 workflow 注册表这个运行时
    // 事实，同 shuvix-model），本例的期望减去 BOT_PIPELINE_KEY。
    expect(parserKeys.filter((k) => !cardKeys.includes(k)).sort()).toEqual(
      [BOT_AGENTS_KEY, BOT_INPUT_KEY, BOT_PIPELINE_KEY].sort()
    )
  })

  it('BD-2 boolean 键 = 解析器强制布尔的键', () => {
    const booleanKeys = keysOf('boolean')
    expect(booleanKeys).toEqual([BOT_NOTES_KEY, 'shuvix-project-awareness'].sort())
    for (const key of booleanKeys) {
      expect(parseBotDefinitionFile(bot(`${key}: nope please`), 'x'), key).toBeNull()
      expect(parseBotDefinitionFile(bot(`${key}: true`), 'x'), key).not.toBeNull()
    }
  })

  it('BD-3 csv 键 = 逗号串键（写成 YAML 列表即整份非法）', () => {
    const csvKeys = keysOf('csv')
    expect(csvKeys).toEqual(['shuvix-instruction-files', 'shuvix-tools'])
    for (const key of csvKeys) {
      expect(parseBotDefinitionFile(bot(`${key}: [a, b]`), 'x'), key).toBeNull()
    }
  })

  it('BD-4 list 键 = YAML 列表键（与 csv 相反 —— bot 描述符里最容易搞反的一行）', () => {
    expect(keysOf('list')).toEqual([BOT_SUGGESTIONS_KEY])
    expect(parseBotDefinitionFile(bot(`${BOT_SUGGESTIONS_KEY}: a, b`), 'x')).toBeNull()
    expect(
      parseBotDefinitionFile(bot(`${BOT_SUGGESTIONS_KEY}:`, '  - a', '  - b'), 'x')
    ).not.toBeNull()
  })

  it('BD-5 select 的枚举候选来自 BOT_RESPOND_MODES（解析器与下拉共用单一真源）', () => {
    // 模型键也是 select，但它的候选是运行时事实（模型目录），不归本契约
    expect(keysOf('select').filter((k) => k !== 'shuvix-model')).toEqual([BOT_RESPOND_KEY])
    for (const mode of BOT_RESPOND_MODES) {
      expect(parseBotDefinitionFile(bot(`${BOT_RESPOND_KEY}: ${mode}`), 'x')!.respond).toBe(mode)
    }
    expect(parseBotDefinitionFile(bot(`${BOT_RESPOND_KEY}: whenever`), 'x')).toBeNull()
    // botFile 的再导出与 chat-protocol 的常量必须是同一引用
    expect(BOT_RESPOND_MODES).toBe(PROTOCOL_RESPOND_MODES)
  })

  it('BD-6 弱守卫：botFile.ts 里每一个 BOT_*_KEY 常量都在 parserKeys 清单里', () => {
    // 上面的 parserKeys 是手维护清单，加了新键却忘了补它，BD-1 就会静默失真
    // （pipeline / input 落地时正是这样绿着的）。这条从源码里抓键常量，让漏补先在这里响。
    const source = readFileSync(fileURLToPath(new URL('../botFile.ts', import.meta.url)), 'utf-8')
    const declared = [...source.matchAll(/export const (BOT_\w*_KEY) = '([^']+)'/g)]
    expect(declared.length).toBeGreaterThan(3)
    for (const [, constName, key] of declared) {
      // 文件类型标记不是解析器读取的字段（BX-2：解析器根本不读标记）
      if (constName === 'BOT_FILE_MARKER_KEY') continue
      expect(parserKeys, constName).toContain(key)
    }
    // 从 chat-protocol 再导出的门控键同样在册
    expect(parserKeys).toContain(BOT_RESPOND_KEY)
  })
})
