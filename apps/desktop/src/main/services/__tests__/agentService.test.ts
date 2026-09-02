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
 *   - 工具名归一是**读时投影**，磁盘原文不因此被改写（原文编辑器不该背着用户重排文件）。
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
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ParsedAgentFile } from '@shuvix/agent-runtime'

const state = vi.hoisted(() => ({ dir: '', wikis: '', widgets: '' }))

vi.mock('electron', () => ({ shell: { openPath: vi.fn() } }))
vi.mock('../../utils/paths', () => ({
  getDefaultAgentsDir: () => state.dir,
  getDefaultWikisDir: () => state.wikis,
  getWidgetsDir: () => state.widgets
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

type AgentService = (typeof import('../agentService'))['agentService']
let agentService: AgentService

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), 'shuvix-agentsvc-'))
  state.dir = join(base, 'agents')
  state.wikis = join(base, 'wikis')
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
    const result = agentService.getSource('default', 'builtin')
    expect('text' in result).toBe(true)
    const { text } = result as { text: string }

    expect(text.split('\n')[1]).toBe('shuvix: agent v1')
    // AgentProfile.tools 是 readonly，serialize 要可变数组 —— 拷贝写漏一个条目在这里现形
    const profileTools = agentService.getProfile('default')!.tools
    expect(profileTools.length).toBeGreaterThan(0)
    expect(toolCountOf(text)).toBe(profileTools.length)
    expect(text).toContain(`shuvix-tools: ${profileTools.join(', ')}`)

    // 序列化键集是固定白名单：内置 md 的自述标记不进副本，复制一份去改不会自称内置
    expect(text).not.toContain('shuvix-builtin')
    // 自身可解析（覆盖副本的初值不能一开局就是坏文件）
    expect(agentService.getSource('default', 'builtin')).toEqual({ text })
  })

  it('AS-4 内置回写保真：{{shuvix:*}} 会话变量原样留给 createAgent，{{wikiRoot}} 宿主参数已插值', () => {
    const defaultText = (agentService.getSource('default', 'builtin') as { text: string }).text
    // 会话级变量在 createAgent 才替换 —— 副本里必须还是占位符，否则用户拿到的是别人的环境
    expect(defaultText).toContain('{{shuvix:workingDirectory}}')

    const wikiText = (agentService.getSource('wiki', 'builtin') as { text: string }).text
    // 宿主参数在构建档案时就地替换 —— 用户看到的是真实路径
    expect(wikiText).toContain(state.wikis)
    expect(wikiText).not.toContain('{{wikiRoot}}')
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
    const text = agentMd('default', ['shuvix-tools: read'])
    expect(agentService.createAgentSource(text)).toEqual({ success: true, name: 'default' })
    expect(files()).toEqual(['default.md'])

    // 合并语义：listAll 只剩用户那一份
    const merged = agentService.listAll().filter((a) => a.name === 'default')
    expect(merged).toHaveLength(1)
    expect(merged[0].source).toBe('user')
    expect(agentService.getProfile('default')!.source).toBe('user')

    const rows = agentService.listForSettings().filter((a) => a.name === 'default')
    expect(rows).toHaveLength(2)
    expect(rows.find((a) => a.source === 'builtin')!.overridden).toBe(true)
  })
})

describe('agentService.saveAgentSource —— 按原文覆写', () => {
  const V1 = agentMd('c-saved', ['shuvix-tools: read'])
  const V2 = ['---', 'shuvix: agent v1', 'name: c-saved', '---', '', 'V2 body.', ''].join('\n')

  it('AS-12 覆写成功：磁盘逐字节等于新 text，listAll 反映新内容', () => {
    expect(agentService.createAgentSource(V1).success).toBe(true)
    expect(agentService.saveAgentSource('c-saved', V2)).toEqual({ success: true })
    expect(readAgentFile('c-saved.md')).toBe(V2)

    const row = agentService.listAll().find((a) => a.name === 'c-saved')!
    expect(row.tools).toEqual([])
    expect(row.systemPrompt).toBe('V2 body.')
  })

  it('AS-13 改名以 frontmatter name 为准：文件不搬家，旧名查不到、新名回吐新原文', () => {
    // 文件名与 name 刻意不一致，改名后文件名也不会跟着变
    writeAgentFile('rename-me.md', agentMd('rename-src'))
    const renamed = agentMd('rename-dst', ['shuvix-tools: grep'])
    expect(agentService.saveAgentSource('rename-src', renamed)).toEqual({ success: true })

    expect(files()).toEqual(['rename-me.md'])
    expect(readAgentFile('rename-me.md')).toBe(renamed)
    expect(agentService.listAll().some((a) => a.name === 'rename-src')).toBe(false)
    expect(agentService.listAll().find((a) => a.name === 'rename-dst')!.basePath).toBe(
      join(state.dir, 'rename-me.md')
    )
    expect(agentService.getSource('rename-src', 'user')).toEqual({
      error: 'Agent "rename-src" not found'
    })
    expect(agentService.getSource('rename-dst', 'user')).toEqual({ text: renamed })
  })

  it('AS-14 非法覆写被拒且旧内容零损伤（磁盘逐字节不变、listAll 仍是旧内容）', () => {
    expect(agentService.createAgentSource(V1).success).toBe(true)
    const result = agentService.saveAgentSource('c-saved', INVALID_MD)
    expect(result.success).toBe(false)
    expect(result.error).toContain("'shuvix-project-awareness' must be a boolean")
    expect(result.error).toContain('the whole file is rejected')

    expect(readAgentFile('c-saved.md')).toBe(V1)
    expect(agentService.listAll().find((a) => a.name === 'c-saved')!.tools).toEqual(['read'])
  })

  it('AS-15 两类 not found：originalName 不存在 / 对内置名直接 save（未先建覆盖副本）', () => {
    expect(agentService.saveAgentSource('ghost-agent', agentMd('ghost-agent'))).toEqual({
      success: false,
      error: 'Agent "ghost-agent" not found'
    })
    // 内置档案无文件：必须先「创建覆盖副本」（createAgentSource），save 无从定位
    expect(agentService.saveAgentSource('explore', agentMd('explore'))).toEqual({
      success: false,
      error: 'Agent "explore" not found'
    })
    expect(files()).toEqual([])
    expect(agentService.listAll().find((a) => a.name === 'explore')!.source).toBe('builtin')
  })

  it('AS-16 改名撞另一份用户档案 → 拒绝且两份都不动；改名撞内置名 → 放行（覆盖是有意设计）', () => {
    expect(agentService.createAgentSource(agentMd('occupied')).success).toBe(true)
    writeAgentFile('mover.md', agentMd('mover'))

    const collide = agentService.saveAgentSource('mover', agentMd('occupied', ['shuvix-tools: ls']))
    expect(collide.success).toBe(false)
    expect(collide.error).toBe('Agent "occupied" already exists')
    expect(readAgentFile('mover.md')).toBe(agentMd('mover'))
    expect(readAgentFile('occupied.md')).toBe(agentMd('occupied'))

    const ontoBuiltin = agentMd('visualization', ['shuvix-tools: read'])
    expect(agentService.saveAgentSource('mover', ontoBuiltin)).toEqual({ success: true })
    expect(readAgentFile('mover.md')).toBe(ontoBuiltin)
    const rows = agentService.listForSettings().filter((a) => a.name === 'visualization')
    expect(rows.find((a) => a.source === 'user')!.basePath).toBe(join(state.dir, 'mover.md'))
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
    sessionAwareness: false,
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
