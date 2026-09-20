/**
 * agentService 的 md 原文读写路径单测 —— 设置页/属性卡「编辑智能体原文」链路的落盘语义。
 *
 * 关注点是**文件系统层的取舍**（解析语义归 agent-runtime 的 definitionFile.test.ts）：
 *   - getSource 逐字节回吐用户文件、按 frontmatter `name` 而非文件名定位 —— 原文编辑的前提；
 *     内置档案无文件，回写出的等价 md 必须是「创建覆盖副本」拿得出手的初值；
 *   - create/save **非法一律拒绝写盘**：一份存在但非法的档案会被扫描静默跳过
 *     （不生效也不遮蔽内置），正是编辑器要消灭的失败模式；
 *   - 文件名由 name 净化派生 —— 净化不到位会写出扫描恰好跳过的文件（点开头/路径分隔符），
 *     即「创建成功但列表里没有」这种最难排查的失败；
 *   - 工具名归一是**读时投影**，磁盘原文不因此被改写（原文编辑器不该背着用户重排文件）；
 *   - 解析不过的档案**列得出来、删得掉**（listInvalid / deleteByFile）：编辑就是笔记本在自动
 *     保存，写到一半的档案不该从设置页消失，更不能进注册表或遮蔽同名内置。
 *
 * mock 面照 policyService.test.ts：electron 只需 shell、paths 指向临时目录、logger 静音。
 * 与 policyService 的一处实现差异：AgentService 在**构造期**就把 userDir 捕获进实例
 * （policyService 每次现取 getDefaultPoliciesDir），所以目录路径必须在 import 单例之前备好
 * —— 这里用动态 import 保证顺序。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import i18next from 'i18next'
import { builtinMdFileNames } from '@shuvix/agent-runtime'
import type { AgentProfile, ParsedAgentFile } from '@shuvix/agent-runtime'

const state = vi.hoisted(() => ({
  dir: '',
  widgets: '',
  // 内置档案的事实源 —— 运行时读随包发布的目录，这里直接读仓库里那一份（同一批文件）。
  // src/main/services/__tests__ 往上六级是仓库根；hoisted 里没有 import，故不走 resolve()
  builtinDir: `${__dirname}/../../../../../../packages/agent-runtime/src/subagent/builtinAgents/md`
}))

vi.mock('electron', () => ({ shell: { openPath: vi.fn() } }))
vi.mock('../../utils/paths', () => ({
  getDefaultAgentsDir: () => state.dir,
  // 内置档案的事实源：运行时读随包发布的目录，单测直接读仓库里那一份（同一批文件）
  getBuiltinAgentsDir: () => state.builtinDir,
  getWidgetsDir: () => state.widgets,
  getShuvixKnowledgeRootDir: () => '/tmp/shuvix-knowledge-shuvix'
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

type AgentService = (typeof import('../agentService'))['agentService']
let agentService: AgentService

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), 'shuvix-agentsvc-'))
  state.dir = join(base, 'agents')
  state.widgets = join(base, 'widgets')
  ;({ agentService } = await import('../agentService'))
})
afterAll(() => {
  rmSync(join(state.dir, '..'), { recursive: true, force: true })
})
beforeEach(() => {
  // 目录整体清掉而非清空内容：懒创建语义（AS-6）要求用例起点就没有这个目录
  rmSync(state.dir, { recursive: true, force: true })
})

/** YAML 单引号标量（内部单引号成对转义）—— name 里带 `:`/`"`/emoji 时照样是一个标量 */
const yamlStr = (value: string): string => `'${value.replace(/'/g, "''")}'`

/** 最小合法 agent md（frontmatter name 为准；文件名只是默认值） */
const agentMd = (name: string, extra: string[] = []): string =>
  [
    '---',
    'shuvix: agent v1',
    `name: ${yamlStr(name)}`,
    'description: e2e unit fixture',
    ...extra,
    '---',
    '',
    `Body of ${name}.`,
    ''
  ].join('\n')

/** 注入开关写成非布尔 → 解析器判整份非法（人读原因带键名与 rejected） */
const INVALID_MD = [
  '---',
  'shuvix: agent v1',
  'name: broken',
  'shuvix-project-awareness: yes please',
  '---',
  '',
  'Invalid agent body.',
  ''
].join('\n')

const files = (): string[] => (existsSync(state.dir) ? readdirSync(state.dir).sort() : [])
const readAgentFile = (fileName: string): string => readFileSync(join(state.dir, fileName), 'utf-8')
/** 绕过 IPC 直接把文件丢进目录（构造非法/非常规文件名/名不符实的素材） */
const writeAgentFile = (fileName: string, text: string): void => {
  mkdirSync(state.dir, { recursive: true })
  writeFileSync(join(state.dir, fileName), text, 'utf-8')
}
/** 序列化产物里 shuvix-tools 的条目数 */
const toolCountOf = (text: string): number => {
  const line = text.split('\n').find((l) => l.startsWith('shuvix-tools:'))
  return line ? line.slice('shuvix-tools:'.length).split(',').length : 0
}
/** 当前生效的内置档案名（现扫随包目录，份数不硬编码） */
const builtinNames = (): string[] =>
  agentService
    .listForSettings()
    .filter((a) => a.source === 'builtin')
    .map((a) => a.name)

describe('agentService.getSource —— 原文编辑器的数据源', () => {
  const RAW_FIDELITY = [
    '---',
    'shuvix: agent v1',
    '# 注释与非规范键序：getSource 必须逐字节回吐，不得被 serialize 规范化',
    'shuvix-tools: Read, grep',
    'name: raw-fidelity',
    'description: raw fidelity',
    'shuvix-builtin: true',
    '---',
    '',
    'Body line one.',
    '',
    '',
    'Body line two, after two blank lines.',
    ''
  ].join('\n')

  it('AS-1 用户档案逐字节回吐（注释 / 非规范键序 / 未知键 / 正文空行原样），且按 name 而非文件名定位', () => {
    // 文件名 a-file.md 与 frontmatter name: raw-fidelity 刻意不一致
    writeAgentFile('a-file.md', RAW_FIDELITY)

    // 全等而非 toContain —— 原文编辑模型的整个前提就是「读回来的就是磁盘上的字节」
    expect(agentService.getSource('raw-fidelity', 'user')).toEqual({ text: RAW_FIDELITY })
    // 文件名不是标识：按 basename 查不到
    expect(agentService.getSource('a-file', 'user')).toEqual({
      error: 'Agent "a-file" not found'
    })
  })

  it('AS-2 三种查不到：user 查无此名 / builtin 查无此名 / user 查只有内置的名字', () => {
    expect(agentService.getSource('no-such-agent', 'user')).toEqual({
      error: 'Agent "no-such-agent" not found'
    })
    expect(agentService.getSource('no-such-agent', 'builtin')).toEqual({
      error: 'Builtin agent "no-such-agent" not found'
    })
    // 关键：user 源不得回吐内置文本（否则「编辑用户档案」会静默变成编辑内置副本）
    expect(agentService.getSource('coding', 'user')).toEqual({
      error: 'Agent "coding" not found'
    })
  })

  it('AS-3 内置回写等价 md：条目数与 getProfile 的 tools 一致（readonly 数组拷贝没截断），不含自述标记', () => {
    const result = agentService.getSource('work', 'builtin')
    expect('text' in result).toBe(true)
    const { text } = result as { text: string }

    expect(text.split('\n')[1]).toBe('shuvix: agent v1')
    // AgentProfile.tools 是 readonly，serialize 要可变数组 —— 拷贝写漏一个条目在这里现形
    const profileTools = agentService.getProfile('work')!.tools
    expect(profileTools.length).toBeGreaterThan(0)
    expect(toolCountOf(text)).toBe(profileTools.length)
    expect(text).toContain(`shuvix-tools: ${profileTools.join(', ')}`)

    // 序列化键集是固定白名单：内置 md 的自述标记不进副本，复制一份去改不会自称内置
    expect(text).not.toContain('shuvix-builtin')
    // 自身可解析（覆盖副本的初值不能一开局就是坏文件）
    expect(agentService.getSource('work', 'builtin')).toEqual({ text })

    // AS-34 这条对**每一份**内置都成立 —— 随包发布的 md 里 `shuvix-builtin: true` 是自述标记，
    // 而覆盖副本落在 ~/.shuvix/agents 下，带着它就成了一份自称内置的用户文件
    for (const name of builtinNames()) {
      const copy = agentService.getSource(name, 'builtin')
      expect('text' in copy, name).toBe(true)
      expect((copy as { text: string }).text, name).not.toContain('shuvix-builtin')
    }
  })

  it('AS-4 内置回写保真：{{shuvix:*}} 会话变量原样留给 createAgent，{{widgetsRoot}} 宿主参数已插值', () => {
    const workText = (agentService.getSource('work', 'builtin') as { text: string }).text
    // 会话级变量在 createAgent 才替换 —— 副本里必须还是占位符，否则用户拿到的是别人的环境
    expect(workText).toContain('{{shuvix:workingDirectory}}')

    const widgetText = (agentService.getSource('widget', 'builtin') as { text: string }).text
    // 宿主参数在构建档案时就地替换 —— 用户看到的是真实路径
    expect(widgetText).toContain(state.widgets)
    expect(widgetText).not.toContain('{{widgetsRoot}}')
  })
})

/**
 * 内置档案的 md 随包发布、运行时按当前语言现读；`builtinSourceFile(name)` 是侧栏点内置行时
 * 「开哪份文件的只读笔记本」的唯一答案（`subAgent:openBuiltinNote` 只认它）。
 *
 * 这一组盯的是**两个读数必须同源**：运行时挑中的那份（`basePath`）与 UI 打开的那份
 * （`builtinSourceFile`）出自同一次语言回退。各挑各的，症状是「跑的是中文档案、点开看到的是
 * 英文那一份」—— 两边都不报错，也没有任何日志。
 */
describe('agentService.builtinSourceFile —— 内置只读笔记本开哪一份文件', () => {
  const ORIGINAL_LANGUAGE = i18next.language
  afterAll(() => {
    i18next.language = ORIGINAL_LANGUAGE
  })
  beforeEach(() => {
    i18next.language = ORIGINAL_LANGUAGE
  })

  it('AS-30 每一份内置：builtinSourceFile 逐字节等于设置页那一行 basePath 的 basename', () => {
    const rows = agentService.listForSettings().filter((a) => a.source === 'builtin')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((r) => [r.name, agentService.builtinSourceFile(r.name)])).toEqual(
      rows.map((r) => [r.name, basename(r.basePath)])
    )
  })

  it.each([
    ['zh', 'work.zh.md'],
    ['zh-CN', 'work.zh.md'],
    ['de', 'work.md'],
    ['en', 'work.md']
  ])('AS-31 界面语言 %s → %s，且 basePath 与 builtinSourceFile 一起动', (language, fileName) => {
    // 两个读数必须**同时**断：分开断的两条能各自变绿（一个跟着语言走、另一个恒 `<name>.md`），
    // 而那正是「跑的和看的不是同一份」的形态
    i18next.language = language

    const row = agentService.listForSettings().find((a) => a.name === 'work' && !a.overridden)!
    expect([basename(row.basePath), agentService.builtinSourceFile('work')]).toEqual([
      fileName,
      fileName
    ])
    // 顺带确认回退真的换了文案（否则上面那条在「三语同一份文件」时也会绿）
    expect(agentService.getProfile('work')!.displayName).toBe(
      language.startsWith('zh') ? '工作' : 'Work'
    )
  })

  it('AS-32 三种边界：纯用户档案名 / 查无此名 → null；被同名用户档案覆盖的内置 → 仍回内置那一份', () => {
    writeAgentFile('only-user.md', agentMd('only-user'))
    expect(agentService.builtinSourceFile('only-user')).toBeNull()
    expect(agentService.builtinSourceFile('no-such-agent')).toBeNull()

    // 被覆盖的内置行照样列在设置页（划线 + 已覆盖），点它开的仍是随包那份 md ——
    // 「看内置原文」与「哪一份在生效」是两个问题，这里回落到用户文件就把它们混成一个了
    writeAgentFile('explore.md', agentMd('explore'))
    const shadowed = agentService
      .listForSettings()
      .find((a) => a.name === 'explore' && a.source === 'builtin')!
    expect(shadowed.overridden).toBe(true)
    expect(agentService.builtinSourceFile('explore')).toBe(basename(shadowed.basePath))
    expect(agentService.builtinSourceFile('explore')).toBe('explore.md')
    // 同名的两份文件叫得一模一样，所以还要断目录：回落到用户目录那一份在文件名上看不出来
    expect(shadowed.basePath).toBe(join(state.builtinDir, 'explore.md'))
    expect(shadowed.basePath).not.toBe(join(state.dir, 'explore.md'))
  })

  it('AS-33 内置行的 basePath 非空、位于内置目录内、文件名是当前语言的候选之一', () => {
    // basePath 为空（`''`）时 UI 那边的 fileNameOf 会退化成空串，点行开出来的是一条
    // notebookPath 为空的会话 —— 列表看着一切正常，点开却是空白
    for (const row of agentService.listForSettings().filter((a) => a.source === 'builtin')) {
      expect(row.basePath, row.name).not.toBe('')
      expect(join(state.builtinDir, basename(row.basePath)), row.name).toBe(row.basePath)
      expect(builtinMdFileNames(row.name, i18next.language), row.name).toContain(
        basename(row.basePath)
      )
    }
  })
})

describe('agentService.createAgentSource —— 按原文新建', () => {
  it('AS-5 合法新建：落盘逐字节等于传入 text（不重序列化），返回 frontmatter name', () => {
    const text = agentMd('created-by-source', ['shuvix-tools: read, grep'])
    expect(agentService.createAgentSource(text)).toEqual({
      success: true,
      name: 'created-by-source'
    })
    expect(readAgentFile('created-by-source.md')).toBe(text)
    expect(agentService.getSource('created-by-source', 'user')).toEqual({ text })
  })

  it('AS-6 非法拒绝：原因即解析器原文、目录零新增，且**不懒创建目录**', () => {
    expect(existsSync(state.dir)).toBe(false)
    const result = agentService.createAgentSource(INVALID_MD)
    expect(result.success).toBe(false)
    expect(result.error).toContain("'shuvix-project-awareness' must be a boolean")
    expect(result.error).toContain('the whole file is rejected')
    // 解析在 ensureUserDir 之前 —— 一次失败的新建不该在用户家目录里留下空目录
    expect(existsSync(state.dir)).toBe(false)
    expect(files()).toEqual([])
  })

  it('AS-7 无 name 键时 defaultName 为 `agent`：档案名与文件名都落 agent', () => {
    const text = ['---', 'shuvix: agent v1', 'description: nameless', '---', '', 'Body.', ''].join(
      '\n'
    )
    expect(agentService.createAgentSource(text)).toEqual({ success: true, name: 'agent' })
    expect(files()).toEqual(['agent.md'])
    expect(agentService.listAll().find((a) => a.name === 'agent')?.source).toBe('user')
  })

  it('AS-8 文件名净化矩阵：路径分隔/非法字符→`-`、前导点去除、全点回退 agent，且不越出 agents 目录', () => {
    // 关键是 `.hidden`：不去前导点会写出点开头文件，而扫描恰好跳过点开头 = 创建即消失
    const cases: Array<[string, string]> = [
      ['a/b', 'a-b.md'],
      ['a:b*?"<>|', 'a-b------.md'],
      ['.hidden', 'hidden.md'],
      ['...', 'agent.md'],
      ['../../evil', '-..-evil.md']
    ]
    for (const [name, fileName] of cases) {
      // name 本身不被净化改写（净化只作用于文件名）
      expect(agentService.createAgentSource(agentMd(name))).toEqual({ success: true, name })
      expect({ name, exists: existsSync(join(state.dir, fileName)) }).toEqual({
        name,
        exists: true
      })
    }
    // 路径穿越防线：`../../evil` 也必须落在 agents 目录内
    expect(files()).toEqual(['-..-evil.md', 'a-b------.md', 'a-b.md', 'agent.md', 'hidden.md'])
  })

  it('AS-9 冲突后缀循环：净化到同一基名的三个 name → a-b.md / a-b-1.md / a-b-2.md，三条并存', () => {
    for (const name of ['a/b', 'a:b', 'a?b']) {
      expect(agentService.createAgentSource(agentMd(name)).success).toBe(true)
    }
    expect(files()).toEqual(['a-b-1.md', 'a-b-2.md', 'a-b.md'])

    // 标识是 frontmatter name —— 三份文件对应三个互异的档案
    const names = agentService
      .listAll()
      .filter((a) => a.source === 'user')
      .map((a) => a.name)
      .sort()
    expect(names).toEqual(['a/b', 'a:b', 'a?b'])
  })

  it('AS-10 与既有用户档案重名 → 拒绝，不产生第二个文件', () => {
    expect(agentService.createAgentSource(agentMd('dup-me')).success).toBe(true)
    const before = files()

    const result = agentService.createAgentSource(agentMd('dup-me', ['shuvix-tools: read']))
    expect(result.success).toBe(false)
    expect(result.error).toBe('Agent "dup-me" already exists')
    expect(files()).toEqual(before)
    expect(readAgentFile('dup-me.md')).toBe(agentMd('dup-me'))
  })

  it('AS-11 覆盖内置放行：同名用户档案生效，listForSettings 里内置转 overridden', () => {
    const text = agentMd('work', ['shuvix-tools: read'])
    expect(agentService.createAgentSource(text)).toEqual({ success: true, name: 'work' })
    expect(files()).toEqual(['work.md'])

    // 合并语义：listAll 只剩用户那一份
    const merged = agentService.listAll().filter((a) => a.name === 'work')
    expect(merged).toHaveLength(1)
    expect(merged[0].source).toBe('user')
    expect(agentService.getProfile('work')!.source).toBe('user')

    const rows = agentService.listForSettings().filter((a) => a.name === 'work')
    expect(rows).toHaveLength(2)
    expect(rows.find((a) => a.source === 'builtin')!.overridden).toBe(true)
  })
})

describe('agentService —— 读时投影与文件名边界', () => {
  it('AS-17 工具名归一是读时投影：磁盘原文一字不动，listAll 才给归一后的名字', () => {
    const text = agentMd('normalize-me', ['shuvix-tools: Read, GREP , read, MCP:Ctx7'])
    expect(agentService.createAgentSource(text)).toEqual({ success: true, name: 'normalize-me' })

    // 原文编辑器不该背着用户重排文件：磁盘上保留他写的大小写与空格
    expect(readAgentFile('normalize-me.md')).toBe(text)
    expect(agentService.getSource('normalize-me', 'user')).toEqual({ text })

    // 读时才归一：内置名小写、mcp: 前缀小写而 server 名保留大小写、去重保序
    expect(agentService.listAll().find((a) => a.name === 'normalize-me')!.tools).toEqual([
      'read',
      'grep',
      'mcp:Ctx7'
    ])
  })

  it('AS-18 超长 name（>255 字节）→ 写盘失败被捕获，目录不留半截文件', () => {
    const longName = 'a'.repeat(300)
    const result = agentService.createAgentSource(agentMd(longName))
    expect(result.success).toBe(false)
    expect(result.error, '写盘异常原因应原样回传').toBeTruthy()
    expect(files()).toEqual([])
  })

  it('AS-19 非 ASCII name（中文 / emoji）不被净化改写：落盘文件名与 name 一致且可回读', () => {
    for (const name of ['代码审查', '🔎-explorer']) {
      expect(agentService.createAgentSource(agentMd(name))).toEqual({ success: true, name })
      expect(agentService.getSource(name, 'user')).toEqual({ text: agentMd(name) })
    }
    expect(files()).toEqual(['代码审查.md', '🔎-explorer.md'].sort())
  })
})

describe('agentService.getProfile —— 一份写坏的同名用户档案不该把会话堵死', () => {
  it('AS-20 三个基座名（work / chat / notebook）各写坏一份：仍拿得到内置档案', () => {
    // 用户手改 ~/.shuvix/agents/chat.md 写出语法错，是完全够得着的操作。它若让
    // getProfile 返回 undefined，无项目会话就整片建不出根 Agent，而项目会话完全正常
    // —— 一个只影响一半会话、且没有任何报错的失败模式。
    for (const name of ['work', 'chat', 'notebook']) {
      writeAgentFile(`${name}.md`, INVALID_MD.replace('name: broken', `name: ${name}`))
    }
    for (const name of ['work', 'chat', 'notebook']) {
      const profile = agentService.getProfile(name)
      expect(profile, name).toBeDefined()
      expect(profile!.source, name).toBe('builtin')
      expect(profile!.systemPrompt.length, name).toBeGreaterThan(0)
    }
  })

  it('AS-21 没有内置同名可退的名字仍是 undefined：写坏的纯用户档案 / 查无此人', () => {
    // 「兜底」只对有内置同名的档案成立 —— 一份写坏的用户自建档案没有任何东西可退，
    // 它就该消失（扫描静默跳过），而不是被伪造成一份空档案
    writeAgentFile('myprof.md', INVALID_MD.replace('name: broken', 'name: myprof'))
    expect(agentService.getProfile('myprof')).toBeUndefined()
    expect(agentService.getProfile('nope-not-there')).toBeUndefined()
  })

  it('AS-22 旧基座名 default 已彻底不存在：getProfile 为 undefined，内置名单里没有它，也没有别名', () => {
    // 项目会话的基座从 default 改名为 work，spec 没有留别名：谁把旧名 spec 留成别名，
    // 这里会先撞红。三个基座名的兜底（AS-20）也不再覆盖它
    expect(agentService.getProfile('default')).toBeUndefined()
    expect(agentService.listAll().some((a) => a.name === 'default')).toBe(false)
    expect(
      agentService.listForSettings().some((a) => a.name === 'default' && a.source === 'builtin')
    ).toBe(false)

    // 一份用户自己写的 default.md 只是一份普通用户档案：没有内置行被它「覆盖」
    writeAgentFile('default.md', agentMd('default'))
    const rows = agentService.listForSettings().filter((a) => a.name === 'default')
    expect(rows.map((r) => r.source)).toEqual(['user'])
    expect(rows[0].overridden).toBeFalsy()
  })
})

/**
 * `isSessionProfile` —— 子会话钉档案（sessionService.pinAgentProfile）准入的唯一判据：
 * 只判名字 —— 基座（work / chat / notebook）恒不算，其余任何档案都算。曾经的第二道门
 * `shuvix-session-awareness` 已退役（解析器把它当未知键忽略）。用真件：内置全集与用户覆盖
 * 都要穿透真注册表。
 */
describe('agentService.isSessionProfile —— 可作子会话档案的判据表', () => {
  const judge = (name: string): boolean => {
    const profile = agentService.getProfile(name)
    expect(profile, name).toBeDefined()
    return agentService.isSessionProfile(profile!)
  }

  it('AS-23a 三个基座恒 false —— 用户覆盖 work.md 也一样（判名字）', () => {
    for (const name of ['work', 'chat', 'notebook']) {
      expect(judge(name), name).toBe(false)
    }
    writeAgentFile('work.md', agentMd('work'))
    expect(agentService.getProfile('work')!.source).toBe('user')
    expect(judge('work')).toBe(false)
  })

  it('AS-23b 其余内置全部为 true —— 含曾经只可派发的 titler', () => {
    for (const name of ['coding', 'browser', 'explore', 'widget', 'knowledge-writer', 'titler']) {
      expect(judge(name), name).toBe(true)
    }
  })

  it('AS-23c 用户档案：不声明任何开关也是 true；老文件里的 shuvix-session-awareness 只是未知键', () => {
    writeAgentFile('plain.md', agentMd('plain'))
    writeAgentFile('legacy-off.md', agentMd('legacy-off', ['shuvix-session-awareness: false']))
    expect(judge('plain')).toBe(true)
    expect(judge('legacy-off')).toBe(true)
    expect(agentService.getProfile('legacy-off')).not.toHaveProperty('sessionAwareness')
  })
})

/**
 * 设置页「无法解析」分组的数据源与它的删除通道。编辑一份档案就是它的笔记本在自动保存，写到
 * 一半解析不过是常态：这份文件不能从列表里消失（用户正对着它改），也绝不能进注册表、遮蔽同名
 * 内置。它解析不出 name，于是删除按文件名寻址 —— 而文件名来自渲染进程。
 */
describe('agentService.listInvalid / deleteByFile —— 解析不过的档案', () => {
  /** 第二种坏法（没有 frontmatter）：理由与 INVALID_MD 互不相同，AS-26 靠它看理由串没串 */
  const NO_FRONTMATTER_MD = 'Just a paragraph of prose, no frontmatter at all.\n'

  it('AS-24 非法文件带解析器理由列出、合法文件照常进注册表；目录不存在 → []，且不懒创建目录', () => {
    writeAgentFile('broken.md', INVALID_MD)
    writeAgentFile('ok.md', agentMd('ok'))

    const invalid = agentService.listInvalid()
    expect(invalid).toEqual([{ fileName: 'broken.md', error: expect.any(String) }])
    // 理由就是属性卡横幅上的那句话：丢了它，用户只看到一个不生效的文件名
    expect(invalid[0].error).toContain("'shuvix-project-awareness' must be a boolean")
    expect(invalid[0].error).toContain('the whole file is rejected')

    const names = agentService.listAll().map((a) => a.name)
    expect(names).toContain('ok')
    expect(names).not.toContain('broken')

    // 首次启动没有这个目录：列一次「无法解析」不该往 ~/.shuvix 里撒一个空目录
    rmSync(state.dir, { recursive: true, force: true })
    expect(agentService.listInvalid()).toEqual([])
    expect(existsSync(state.dir)).toBe(false)
  })

  it('AS-25 扫描口径与注册表同一套：点文件 / 非 .md / 叫 dir.md 的目录一律不列；后缀大小写不敏感（LOUD.MD 照列、文件名原样）', () => {
    // 点文件（macOS 的 `._x.md` 之类）与目录要是被列进来，「无法解析」分组里就多出几行
    // 用户既打不开也修不好的东西；文件名原样，是因为它就是打开与删除的寻址键
    writeAgentFile('.hidden.md', INVALID_MD)
    writeAgentFile('notes.txt', INVALID_MD)
    mkdirSync(join(state.dir, 'dir.md'), { recursive: true })
    writeAgentFile('LOUD.MD', INVALID_MD)

    expect(agentService.listInvalid().map((f) => f.fileName)).toEqual(['LOUD.MD'])
  })

  it('AS-26 理由不串：两份各坏各的，各自只带自己的理由', () => {
    // 理由按文件收集；收集器要是被几份文件共用，第二份坏文件的横幅上会叠着第一份的理由
    writeAgentFile('bad-flag.md', INVALID_MD)
    writeAgentFile('no-frontmatter.md', NO_FRONTMATTER_MD)

    const errorOf = Object.fromEntries(agentService.listInvalid().map((f) => [f.fileName, f.error]))
    expect(Object.keys(errorOf).sort()).toEqual(['bad-flag.md', 'no-frontmatter.md'])
    expect(errorOf['bad-flag.md']).toContain('must be a boolean')
    expect(errorOf['bad-flag.md']).not.toContain('no YAML frontmatter block')
    expect(errorOf['no-frontmatter.md']).toContain('no YAML frontmatter block')
    expect(errorOf['no-frontmatter.md']).not.toContain('must be a boolean')
  })

  it('AS-27 写坏的覆盖不遮蔽内置：explore.md 列进无法解析；设置页只有一行未被覆盖的内置 explore；getProfile 拿到的是内置', () => {
    // 覆盖副本写到一半是最常见的坏文件。它若遮蔽了内置，explore 就在用户打字的这几秒里整个消失
    writeAgentFile('explore.md', INVALID_MD.replace('name: broken', 'name: explore'))

    expect(agentService.listInvalid().map((f) => f.fileName)).toEqual(['explore.md'])
    const rows = agentService.listForSettings().filter((a) => a.name === 'explore')
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('builtin')
    expect(rows[0].overridden).toBeFalsy()
    expect(agentService.getProfile('explore')?.source).toBe('builtin')
  })

  it('AS-28 同名两份合法文件：设置页两份都列出 —— 文件名就是名字的那份生效（哪怕另一份更短、排序更前），另一份标被覆盖并指向它；注册表认的是同一份', () => {
    // 输的那份以前被扫描静默跳过：既不生效，也不出现在任何分组里。现在它照常列出、换一种样子，
    // 而「谁生效」与注册表出自同一次裁决。`a.md` 比 `twin.md` 短、码点序也靠前，
    // 只有「文件名即名字」这一条能让 twin.md 胜出
    writeAgentFile('a.md', agentMd('twin'))
    writeAgentFile('twin.md', agentMd('twin'))

    expect(agentService.listInvalid()).toEqual([])
    const rows = agentService.listForSettings().filter((a) => a.name === 'twin')
    expect(rows.map((r) => [r.basePath, r.source, !!r.overridden, r.overriddenBy])).toEqual([
      [join(state.dir, 'twin.md'), 'user', false, undefined],
      [join(state.dir, 'a.md'), 'user', true, 'twin.md']
    ])
    expect(agentService.getProfile('twin')?.basePath).toBe(join(state.dir, 'twin.md'))
    expect(agentService.listAll().filter((a) => a.name === 'twin')).toHaveLength(1)
  })

  it('AS-29 deleteByFile：越界 / 子路径 / 点文件 / 非 .md / 无后缀 / 不存在一律 not found 且一个文件都不动；目录里的坏文件与好文件都按文件名删得掉', () => {
    // 这条通道会**删**它指到的文件，而文件名来自渲染进程。能放真文件的都放上：
    // 拒绝得是白名单拒的，而不是恰好不存在
    const outside = join(state.dir, '..', 'x.md')
    writeAgentFile('.hidden.md', agentMd('hidden'))
    writeAgentFile('x.txt', agentMd('txt'))
    writeAgentFile('x', agentMd('bare'))
    mkdirSync(join(state.dir, 'sub'), { recursive: true })
    writeFileSync(join(state.dir, 'sub', 'x.md'), agentMd('nested'))
    writeFileSync(outside, agentMd('outside'))

    for (const fileName of [
      '../x.md',
      '..\\x.md',
      'sub/x.md',
      '.hidden.md',
      'x.txt',
      'x',
      'nope.md'
    ]) {
      expect(agentService.deleteByFile(fileName), fileName).toEqual({
        success: false,
        error: `Agent file "${fileName}" not found`
      })
    }
    expect(readFileSync(outside, 'utf-8')).toBe(agentMd('outside'))
    expect(readAgentFile(join('sub', 'x.md'))).toBe(agentMd('nested'))
    for (const fileName of ['.hidden.md', 'x.txt', 'x']) {
      expect(existsSync(join(state.dir, fileName)), fileName).toBe(true)
    }

    // 解析不过的文件没有 name，走不了 deleteAgent —— 这是它唯一的删除入口
    writeAgentFile('broken.md', INVALID_MD)
    expect(agentService.deleteByFile('broken.md')).toEqual({ success: true })
    expect(existsSync(join(state.dir, 'broken.md'))).toBe(false)
    expect(agentService.listInvalid()).toEqual([])

    // 合法文件按文件名同样删得掉（文件名与 name 刻意不同），删完即从注册表消失
    writeAgentFile('valid-file.md', agentMd('deletable'))
    expect(agentService.listAll().some((a) => a.name === 'deletable')).toBe(true)
    expect(agentService.deleteByFile('valid-file.md')).toEqual({ success: true })
    expect(existsSync(join(state.dir, 'valid-file.md'))).toBe(false)
    expect(agentService.listAll().some((a) => a.name === 'deletable')).toBe(false)

    rmSync(outside, { force: true })
  })
})

describe('agentService —— 结构化写路径（属性卡/表单的 saveAgent / createAgent）', () => {
  /** ParsedAgentFile 的最小合法形状；各用例只覆盖它关心的字段 */
  const parsed = (name: string, extra: Partial<ParsedAgentFile> = {}): ParsedAgentFile => ({
    name,
    displayName: name,
    description: 'structured write fixture',
    systemPrompt: `Body of ${name}.`,
    tools: ['read'],
    instructionFiles: [],
    projectAwareness: false,
    ...extra
  })

  it('IF-U-22 越界的指令文件条目一律拒绝：save 磁盘逐字节不变、create 目录零新增', () => {
    // 结构化写路径的自检是「序列化 → 回读」：`..` 在解析侧判整份非法，于是写盘被挡在门外。
    // 这里只钉「不写出不可读文件」这一条 —— 拒绝的**原因文案**当前把用户输入错误报成了
    // 内部错误（serializer/parser 漂移与用户输错共用一句话），那是实现待修的账，
    // 钉住文案只会把这笔账焊死在测试里。
    const outside = { instructionFiles: ['../outside.md'] }

    // save 路径：先有一份合法档案，非法覆写后磁盘必须一个字节都没动
    expect(agentService.createAgentSource(agentMd('gui-target')).success).toBe(true)
    const before = readAgentFile('gui-target.md')
    expect(agentService.saveAgent('gui-target', parsed('gui-target', outside)).success).toBe(false)
    expect(readAgentFile('gui-target.md')).toBe(before)
    expect(files()).toEqual(['gui-target.md'])

    // create 路径：目录里不该多出任何文件（半截的坏档案会被扫描静默跳过，最难排查）
    expect(agentService.createAgent(parsed('gui-created', outside)).success).toBe(false)
    expect(files()).toEqual(['gui-target.md'])
  })

  it('IF-U-23 合法子路径照常落盘：`docs/house.md` 写进 shuvix-instruction-files（正斜杠原样）', () => {
    const result = agentService.createAgent(
      parsed('gui-subpath', { instructionFiles: ['docs/house.md'] })
    )
    expect(result).toEqual({ success: true, name: 'gui-subpath' })
    expect(readAgentFile('gui-subpath.md')).toContain('shuvix-instruction-files: docs/house.md')

    // 落盘后读得回来 —— 「写出去的是可读文件」才是这条写路径的合同
    expect(agentService.listAll().find((a) => a.name === 'gui-subpath')!.instructionFiles).toEqual([
      'docs/house.md'
    ])
  })
})

/**
 * 同名的几份（AGT-SH*）：注册表（listAll / getProfile / 按名读写删）与设置页全量列表出自同一次
 * resolveShadowing。夹具用真文件名 ——「文件名就是名字」只在真文件名上成立；大小写那一半在
 * agent-runtime 的 registryShadowing.test.ts（macOS 默认文件系统不分大小写，真目录里放不下两份）。
 *
 *   explore.md（EXPLORE CANON）+ explore copy.md  —— 覆盖内置 explore 的两份
 *   twin.md + aa.md + zz.md                       —— 纯用户同名三份；aa.md 更短、码点序也更前
 *   broken.md                                      —— 解析不过、写着 name: explore（遮蔽不了任何东西）
 */
describe('agentService —— 同名的几份：注册表与设置页是同一次裁决的两种投影', () => {
  const EXPLORE_CANON = agentMd('explore').replace('Body of explore.', 'EXPLORE CANON')

  function seedShadowFixture(): void {
    writeAgentFile('explore.md', EXPLORE_CANON)
    writeAgentFile('explore copy.md', agentMd('explore'))
    writeAgentFile('twin.md', agentMd('twin'))
    writeAgentFile('aa.md', agentMd('twin'))
    writeAgentFile('zz.md', agentMd('twin'))
    writeAgentFile('broken.md', INVALID_MD.replace('name: broken', 'name: explore'))
  }

  /** 行的文件身份：内置没有文件，记空串 */
  const fileOf = (row: { source: string; basePath: string }): string =>
    row.source === 'builtin' ? '' : basename(row.basePath)

  /** 码点序（不随 locale 漂） */
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const byIdentity = (a: AgentProfile, b: AgentProfile): number =>
    cmp(a.name, b.name) || cmp(a.source, b.source) || cmp(a.basePath, b.basePath)

  /** 核心等式：运行时生效集 == 设置页里没被覆盖的那些行；生效集里名字不重复 */
  function expectRegistryMatchesSettings(): void {
    const registry = [...agentService.listAll()].sort(byIdentity)
    const active = agentService
      .listForSettings()
      .filter((row) => !row.overridden)
      .sort(byIdentity)
    expect(registry).toStrictEqual(active)
    const names = registry.map((a) => a.name)
    expect(new Set(names).size).toBe(names.length)
  }

  it('AGT-SH1 运行时生效集 == 设置页未被覆盖的行；文件名即名字的那份生效（哪怕另一份更短）；输的几份指向胜者，排在它后面；非法文件哪边都不出现', () => {
    seedShadowFixture()
    expectRegistryMatchesSettings()

    const explore = agentService.getProfile('explore')!
    expect(explore.basePath).toBe(join(state.dir, 'explore.md'))
    expect(explore.systemPrompt).toContain('EXPLORE CANON')
    // twin.md 胜过更短、码点序也更前的 aa.md
    expect(agentService.getProfile('twin')?.basePath).toBe(join(state.dir, 'twin.md'))

    const rows = agentService.listForSettings()
    expect(
      rows.filter((r) => r.overridden).map((r) => [r.source, fileOf(r), r.overriddenBy])
    ).toEqual([
      ['builtin', '', 'explore.md'],
      ['user', 'explore copy.md', 'explore.md'],
      ['user', 'aa.md', 'twin.md'],
      ['user', 'zz.md', 'twin.md']
    ])
    // 同名里生效的在前，输的按路径跟在后面
    expect(rows.filter((r) => r.name === 'twin').map(fileOf)).toEqual(['twin.md', 'aa.md', 'zz.md'])

    expect(agentService.listInvalid().map((f) => f.fileName)).toEqual(['broken.md'])
    const brokenPath = join(state.dir, 'broken.md')
    expect(agentService.listAll().some((a) => a.basePath === brokenPath)).toBe(false)
    expect(rows.some((r) => r.basePath === brokenPath)).toBe(false)
  })

  it('AGT-SH2 按名寻址的读 / 写 / 删只碰生效的那份：getSource / saveAgent 落在 twin.md，另两份逐字节不动；deleteAgent 删掉它之后 aa.md 按码点序接班', () => {
    seedShadowFixture()
    expect(agentService.getSource('twin', 'user')).toEqual({ text: readAgentFile('twin.md') })

    const twinBefore = readAgentFile('twin.md')
    const aaBefore = readAgentFile('aa.md')
    const zzBefore = readAgentFile('zz.md')
    expect(
      agentService.saveAgent('twin', {
        name: 'twin',
        displayName: 'twin',
        description: 'saved through the registry',
        systemPrompt: 'TWIN SAVED',
        tools: ['read'],
        instructionFiles: [],
        projectAwareness: false
      })
    ).toEqual({ success: true })
    expect(readAgentFile('twin.md')).not.toBe(twinBefore)
    expect(readAgentFile('twin.md')).toContain('TWIN SAVED')
    expect(readAgentFile('aa.md')).toBe(aaBefore)
    expect(readAgentFile('zz.md')).toBe(zzBefore)
    expect(agentService.getProfile('twin')?.systemPrompt).toContain('TWIN SAVED')

    expect(agentService.deleteAgent('twin')).toEqual({ success: true })
    expect(files()).toEqual(['aa.md', 'broken.md', 'explore copy.md', 'explore.md', 'zz.md'])
    // aa.md 与 zz.md 都不是名字本身、长度相同 —— 码点序定胜负
    expect(agentService.getProfile('twin')?.basePath).toBe(join(state.dir, 'aa.md'))
    expect(
      agentService
        .listForSettings()
        .filter((r) => r.name === 'twin')
        .map((r) => [fileOf(r), !!r.overridden, r.overriddenBy])
    ).toEqual([
      ['aa.md', false, undefined],
      ['zz.md', true, 'aa.md']
    ])
    expectRegistryMatchesSettings()
  })

  it('AGT-SH3 按文件名删输的那份不动胜者；再按名删掉覆盖，内置 explore 恢复生效 —— 写着 explore 的 broken.md 始终遮蔽不了它', () => {
    seedShadowFixture()

    expect(agentService.deleteByFile('explore copy.md')).toEqual({ success: true })
    expect(files()).toEqual(['aa.md', 'broken.md', 'explore.md', 'twin.md', 'zz.md'])
    expect(agentService.getProfile('explore')?.basePath).toBe(join(state.dir, 'explore.md'))
    expect(
      agentService
        .listForSettings()
        .filter((r) => r.name === 'explore')
        .map((r) => [r.source, fileOf(r), !!r.overridden, r.overriddenBy])
    ).toEqual([
      ['user', 'explore.md', false, undefined],
      ['builtin', '', true, 'explore.md']
    ])

    expect(agentService.deleteAgent('explore')).toEqual({ success: true })
    expect(agentService.getProfile('explore')?.source).toBe('builtin')
    expect(
      agentService
        .listForSettings()
        .filter((r) => r.name === 'explore')
        .map((r) => [r.source, !!r.overridden])
    ).toEqual([['builtin', false]])
    expect(agentService.listInvalid().map((f) => f.fileName)).toEqual(['broken.md'])
    expectRegistryMatchesSettings()
  })
})
