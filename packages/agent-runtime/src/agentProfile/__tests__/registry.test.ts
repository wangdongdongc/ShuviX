/**
 * 内置档案的构建语义与内容钉板。
 *
 * 文案的唯一事实源已是 `builtinAgents/md/*.md`，所以断言一律打在**解析后的档案**上
 * （而非 TS 字面量）—— 这条链路同时覆盖了 md 格式合法性：任何一份 md 的 frontmatter
 * 写坏，buildBuiltinProfile 返回 null，下面的用例立刻失败。
 */
import { describe, it, expect } from 'vitest'
import * as builtinAgentsModule from '../../subagent/builtinAgents'
import {
  BASE_PROFILE_NAMES,
  BUILTIN_PROFILE_SPECS,
  buildBuiltinProfile,
  buildBuiltinProfiles,
  CHAT_PROFILE_NAME,
  KNOWLEDGE_WRITER_SPEC,
  NOTEBOOK_PROFILE_NAME,
  BOT_PROFILE_NAME,
  WIDGET_SPEC,
  WORK_PROFILE_NAME,
  pickLocalizedSource
} from '../../subagent/builtinAgents'
import { createInlineMdReader } from '../../subagent/builtinAgents/inlineSources'
import { KNOWLEDGE_TYPES } from '@shuvix/chat-protocol/knowledge'
import { BOT_CONTEXT_TAG } from '../../bot/botContext'
import type { AgentProfile } from '../../subagent/types'

/** 内置 md 的读取口：桌面运行时读随包目录，测试读构建期内联的**同一批文件** */
const readMd = createInlineMdReader()

/**
 * 某个内置 agent 的三语 md 原文（语言 → 原文）。文件按 `<name>[.<lang>].md` 命名，en 是无后缀
 * 那份 —— 读不到的语言不进表，于是「齐不齐三门语言」这类断言直接看键集。
 */
const sourcesOf = (name: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const language of LANGS) {
    const text = readMd(language === 'en' ? `${name}.md` : `${name}.${language}.md`)
    if (text !== null) out[language] = text
  }
  return out
}
const ALL_PARAMS = { widgetsRoot: '/w', readMd }
const LANGS = ['en', 'zh', 'ja'] as const
const profile = (name: string, language?: string): AgentProfile =>
  buildBuiltinProfiles({ ...ALL_PARAMS, language }).find((a) => a.name === name)!

describe('buildBuiltinProfile — md 解析 + 宿主参数插值', () => {
  it('en 档案解析出全部字段，宿主参数就地替换', () => {
    const built = buildBuiltinProfile(WIDGET_SPEC, { widgetsRoot: '/widgets', readMd })!
    expect(built.displayName).toBe('Widget Builder')
    expect(built.description).toBe(
      'Creates, maintains and exports ShuviX Widgets — persistent mini React apps that live in the Widget panel.'
    )
    expect(built.systemPrompt).toContain('Widgets live at /widgets/<id>/')
    expect(built.systemPrompt).not.toContain('{{widgetsRoot}}')
    expect(built.source).toBe('builtin')
    expect(built.tools).toEqual(['read', 'write', 'edit', 'ls', 'glob', 'grep', 'bash', 'git'])
  })

  it('会话级 {{shuvix:*}} 占位符不在此替换（留给 createAgent）', () => {
    expect(profile(WORK_PROFILE_NAME).systemPrompt).toContain('{{shuvix:workingDirectory}}')
  })

  it('缺必需宿主参数 → 返回 null(该端不支持此 agent)', () => {
    expect(buildBuiltinProfile(WIDGET_SPEC, { readMd })).toBeNull()
    // 给了别的参数也不算数 —— 缺的是它自己声明的那一个
    expect(buildBuiltinProfile(WIDGET_SPEC, { language: 'zh', readMd })).toBeNull()
  })
})

describe('语言解析 — 精确 → 基础 → en，按文件整体回退', () => {
  it('zh / ja 取对应语言文件；zh-CN 落回 zh', () => {
    expect(profile(WORK_PROFILE_NAME, 'zh').displayName).toBe('工作')
    expect(profile(WORK_PROFILE_NAME, 'zh-CN').displayName).toBe('工作')
    expect(profile(WORK_PROFILE_NAME, 'ja').displayName).toBe('ワーク')
  })

  it('未知语言 / 缺省 → en', () => {
    expect(profile(WORK_PROFILE_NAME, 'fr').displayName).toBe('Work')
    expect(profile(WORK_PROFILE_NAME).displayName).toBe('Work')
  })

  it('pickLocalizedSource 是纯函数形式的同一套规则', () => {
    const sources = { en: 'E', zh: 'Z' }
    expect(pickLocalizedSource(sources, 'zh-TW')).toBe('Z')
    expect(pickLocalizedSource(sources, 'ja')).toBe('E')
    expect(pickLocalizedSource(sources, undefined)).toBe('E')
  })
})

describe('buildBuiltinProfiles — 全集现算', () => {
  it('全参数 → 十个内置,四个基座档案居首;缺 widget 根 → 自动跳过', () => {
    // bot-notes 已退役（bot 自己维护自己的正文，没有单独的笔记段）—— 名单里不该再有它
    expect(buildBuiltinProfiles(ALL_PARAMS).map((a) => a.name)).toEqual([
      'work',
      'chat',
      'notebook',
      'bot',
      'coding',
      'browser',
      'explore',
      'widget',
      'titler',
      'knowledge-writer'
    ])
    // titler / knowledge-writer 无宿主参数依赖：缺 widget 根也在
    //（模型走 shuvix-model 通用链路，内置不声明；知识库目标由工具按会话解析，不吃参数）
    expect(buildBuiltinProfiles({ readMd }).map((a) => a.name)).toEqual([
      'work',
      'chat',
      'notebook',
      'bot',
      'coding',
      'browser',
      'explore',
      'titler',
      'knowledge-writer'
    ])
  })

  it('每个 spec 的三份语言文件都能解析成合法档案', () => {
    for (const spec of BUILTIN_PROFILE_SPECS) {
      for (const language of LANGS) {
        const built = buildBuiltinProfile(spec, { ...ALL_PARAMS, language })
        expect(built, `${spec.name}.${language}`).not.toBeNull()
        expect(built!.name, `${spec.name}.${language}`).toBe(spec.name)
        expect(built!.description.length, `${spec.name}.${language}`).toBeGreaterThan(0)
        expect(built!.systemPrompt.length, `${spec.name}.${language}`).toBeGreaterThan(0)
      }
    }
  })

  it('每份语言文件都声明 shuvix-builtin: true（新增内置 agent 漏写即红）', () => {
    for (const spec of BUILTIN_PROFILE_SPECS) {
      for (const [language, source] of Object.entries(sourcesOf(spec.name))) {
        expect(source, `${spec.name}.${language}`).toMatch(/^shuvix-builtin: true$/m)
      }
    }
  })

  it('各语言文件的 {{...}} 占位符集合与 en 完全一致（翻译时漏改/误译占位符 = 变量失效）', () => {
    const placeholders = (text: string): string[] =>
      [...new Set(text.match(/\{\{[^}]+\}\}/g) ?? [])].sort()
    for (const spec of BUILTIN_PROFILE_SPECS) {
      const sources = sourcesOf(spec.name)
      const expected = placeholders(sources.en)
      for (const [language, source] of Object.entries(sources)) {
        expect(placeholders(source), `${spec.name}.${language}`).toEqual(expected)
      }
    }
  })

  it('语言切换不改变结构字段（工具白名单/注入开关只在 en 文件里定义一次的等价物）', () => {
    for (const spec of BUILTIN_PROFILE_SPECS) {
      const en = buildBuiltinProfile(spec, { ...ALL_PARAMS, language: 'en' })!
      for (const language of ['zh', 'ja']) {
        const loc = buildBuiltinProfile(spec, { ...ALL_PARAMS, language })!
        expect(loc.tools, `${spec.name}.${language} tools`).toEqual(en.tools)
        expect(loc.instructionFiles, `${spec.name}.${language}`).toEqual(en.instructionFiles)
        expect(loc.projectAwareness, `${spec.name}.${language}`).toBe(en.projectAwareness)
      }
    }
  })
})

/**
 * knowledge-writer 档案钉板 —— OKF 知识库的派发执行侧（设计 §6.3）：经 `knowledge` 工具写条目；
 * 没有 git、没有提交协议、没有反链复查 —— 簿记归宿主，同意归策略。依赖宿主的知识库根目录参数
 * （扩展端没有 → 自动跳过）。
 *
 * 编辑规范（布局表、类型词汇表、写作规则）**住在这份提示词里**：库里不再放一份用户可编辑的
 * SCHEMA.md，因为那样它一落盘就再也更新不了，而 agent 又被要求遵循它。RG-2 因此逐条钉住
 * 提示词里必须在场的那几段。
 */
describe('knowledge-writer 档案钉板（OKF 知识库的派发执行侧）', () => {
  it('RG-1 三语结构钉板：工具面恰为 knowledge/read/grep/glob/ls/ask，项目感知开、指令文件默认、不声明模型、不是基座、不依赖任何宿主参数', () => {
    expect(KNOWLEDGE_WRITER_SPEC.name).toBe('knowledge-writer')
    // 它从不点名文件系统路径 —— 目标 bundle 由 knowledge 工具按会话解析，所以零参数也建得出来
    expect(KNOWLEDGE_WRITER_SPEC.requiredParams).toBeUndefined()
    expect(buildBuiltinProfile(KNOWLEDGE_WRITER_SPEC, { readMd })).not.toBeNull()
    expect(BASE_PROFILE_NAMES.has('knowledge-writer')).toBe(false)
    for (const language of LANGS) {
      const built = buildBuiltinProfile(KNOWLEDGE_WRITER_SPEC, { language, readMd })
      expect(built, language).not.toBeNull()
      // 条目用普通 write/edit 写（knowledge 工具只读）；没有 git —— 簿记归宿主
      expect(built!.tools, language).toEqual([
        'knowledge',
        'read',
        'write',
        'edit',
        'grep',
        'glob',
        'ls',
        'ask'
      ])
      expect(built!.projectAwareness, language).toBe(true)
      expect(built!.instructionFiles, language).toEqual(['AGENTS.md', 'CLAUDE.md'])
      expect(built!.model, language).toBeUndefined()
    }
  })

  it('RG-2 三语正文接线：不点名任何文件系统路径、点名四步流程的动作、两个宿主章、会话资源 URI', () => {
    for (const language of LANGS) {
      const body = buildBuiltinProfile(KNOWLEDGE_WRITER_SPEC, { language, readMd })!.systemPrompt
      // 一个项目一个 bundle，路径由工具按会话解析 —— 提示词里不该再有根目录占位符
      expect(body, `${language} 占位符`).not.toContain('{{knowledgeRoot}}')
      // search → create → edit → validate：四步缺一步，agent 就写不出能被收录的条目
      for (const anchor of [
        '`knowledge`',
        '`search`',
        '`create`',
        '`edit`',
        '`validate`',
        '`generated`',
        '`verified`',
        'shuvix://session/'
      ]) {
        expect(body, `${language} 需含 ${anchor}`).toContain(anchor)
      }
      // 两个状态词只查裸词：提示词里它们以 `status: deprecated` 这类整句出现，钉反引号形态太脆
      for (const word of ['draft', 'deprecated', 'stable']) {
        expect(body, `${language} 需讲状态 ${word}`).toContain(word)
      }
      // 已退役的 action：教它们就是教不存在的东西
      for (const gone of ['set-status', '`locate`']) {
        expect(body, `${language} 不得再点名退役的 ${gone}`).not.toContain(gone)
      }
      // 库里不再放 SCHEMA.md：提示词也不该再指着它（指了就是指向一个不存在的文件）
      expect(body, `${language} 不得再点名 SCHEMA.md`).not.toContain('SCHEMA.md')
    }
  })

  /**
   * 编辑规范内联在提示词里 —— 它曾经住在用户目录的 SCHEMA.md 里，那份文件已撤销。
   * 三语都得带上类型词汇表（拼不出合法 `type` 就写不成条目）与跨 bundle 的引用规矩。
   */
  it('RG-3 三语正文自带编辑规范：类型词汇齐全、跨 bundle 用 shuvix:// URI；不再提退役的目录作用域', () => {
    for (const language of LANGS) {
      const body = buildBuiltinProfile(KNOWLEDGE_WRITER_SPEC, { language, readMd })!.systemPrompt
      for (const type of KNOWLEDGE_TYPES) {
        expect(body, `${language} 需含类型 ${type}`).toContain(`\`${type}\``)
      }
      // 路径只在自己 bundle 内成立，跨库要用 URI —— 这条不说清楚，agent 会写出解析不了的链接
      expect(body, `${language} 需讲跨 bundle 引用`).toContain('shuvix://')
      // 目录作用域已退役：提示词里再教 global/ 之类，agent 就会往宿主不认识的目录写
      for (const gone of ['global/', 'bots/', 'wiki/', 'raw/']) {
        expect(body, `${language} 不得再提退役作用域 ${gone}`).not.toContain(gone)
      }
    }
  })

  /**
   * 库由用户按会话选定，多数是用户自己按主题切开的库 —— 项目库只是 `bases` 里可能有的一个名字。
   * 提示词要是仍以「这个项目的库」开篇（或在任何地方点名 `"project"`），agent 就会把用户库当成
   * 边角料，而那正是本轮要主推的形态。工具描述侧有 KT-12 钉同一件事，这里钉执行侧的正文。
   */
  it('RG-4 三语正文都不再把项目库摆在第一位：指向 `bases`，不点名 "project"', () => {
    for (const language of LANGS) {
      const body = buildBuiltinProfile(KNOWLEDGE_WRITER_SPEC, { language, readMd })!.systemPrompt
      // 「有哪几个库」只能从 `bases` 得知 —— 不教这一条，agent 只能瞎猜一个名字
      expect(body, `${language} 需指向 \`bases\``).toContain('`bases`')
      expect(body, `${language} 不得点名 "project"`).not.toContain('"project"')
    }
    // 旧开篇（静态围栏的框架句）不得从执行侧提示词里借尸还魂
    expect(
      buildBuiltinProfile(KNOWLEDGE_WRITER_SPEC, { language: 'en', readMd })!.systemPrompt
    ).not.toContain('Each project has')
  })
})

describe('work 档案钉板(项目会话基座：工具集/环境段的唯一事实源)', () => {
  it('tools 按桌面注册序列出 + Agent/session 居末;git 不进任何基座', () => {
    // 顺序与 apps/desktop/src/main/tools/allTools.ts 的注册序一致(bash→read→write→edit→ask→
    // browser→ls→grep→glob→ssh→database)——LLM 所见工具序列的稳定性依赖它;
    // 工具注册表导入链含 electron/native 模块无法在测试内加载,故硬编码钉住,改动需同步两侧。
    const built = profile(WORK_PROFILE_NAME)
    // session 在末尾：它是「管自己这条会话」的工具（改标题 / 开子会话并驱动它），
    // 与前面那些「对外干活」的工具不同类，所以列在 agent 之后
    expect(built.tools).toEqual([
      'bash',
      'read',
      'write',
      'edit',
      'ask',
      'browser',
      'ls',
      'grep',
      'glob',
      'database',
      'agent',
      'session',
      'knowledge',
      'artifact'
    ])
    // git 不进任何基座（见 allTools.ts 的注释：主 Agent 默认无，用户可覆盖
    // work.md 加入，子代理经白名单解析不受默认集限制）
    expect(built.tools, 'work 不应持有 git').not.toContain('git')
    // 环境/工作区模板已内化进 body（{{shuvix:*}} 占位符,createAgent 时替换）
    for (const v of [
      'isGitRepo',
      'platform',
      'shell',
      'os',
      'date',
      'language',
      'appVersion',
      'workingDirectory'
    ]) {
      expect(built.systemPrompt).toContain(`{{shuvix:${v}}}`)
    }
    for (const gone of ['referenceDirs', 'projectEnvVars', 'projectPromptSections']) {
      expect(built.systemPrompt).not.toContain(`{{shuvix:${gone}}}`)
    }
  })

  it('内置档案默认认 AGENTS.md → CLAUDE.md（notebook / bot / titler 除外）、项目感知默认开（titler 除外）', () => {
    /** 两样注入都不要的执行型档案（上下文无关的一次性任务，注入整份项目文档纯属浪费 token 且稀释指令） */
    const NO_INJECTION = ['titler']
    for (const spec of BUILTIN_PROFILE_SPECS) {
      const built = buildBuiltinProfile(spec, ALL_PARAMS)!
      // 两项注入的开关面不同：
      //  - 指令文件：notebook 不吃 —— AGENTS.md/CLAUDE.md 是写代码的工程约定，改一篇笔记用不上；
      //  - 项目感知：notebook 照常开 —— 笔记就写在项目里，项目提示词与项目记忆正是它的上下文；
      //  - titler 两样都不要：拟一个标题用不上项目文档，注入只是噪声。
      // bot 与 notebook 同一取舍：bot 是对话人格，AGENTS.md/CLAUDE.md 是写代码的工程
      // 约定 —— 真正写代码的是它派出去的子会话，那条会话自己会吃这份文件。
      const instructionsOn =
        spec.name !== NOTEBOOK_PROFILE_NAME &&
        spec.name !== BOT_PROFILE_NAME &&
        !NO_INJECTION.includes(spec.name)
      const awarenessOn = !NO_INJECTION.includes(spec.name)
      // 清单顺序即优先级：两份都在时取 AGENTS.md（正是改制前那条内置默认优先级）
      expect(built.instructionFiles, spec.name).toEqual(
        instructionsOn ? ['AGENTS.md', 'CLAUDE.md'] : []
      )
      expect(built.projectAwareness, spec.name).toBe(awarenessOn)
    }
  })

  it('三语 description 都点名 "work"、不再提 "default"（覆盖提示指向正确的文件名）', () => {
    // description 是设置页里用户看到的那句「创建名为 X 的自定义智能体即可覆盖」——
    // 改名后它若还指着 default.md，用户照做就会得到一份不起作用的用户档案
    for (const language of LANGS) {
      const desc = profile(WORK_PROFILE_NAME, language).description
      expect(desc, `work.${language}`).toContain('work')
      expect(desc, `work.${language}`).not.toContain('default')
    }
  })
})

describe('chat 档案钉板(不归属项目的会话的创建基座)', () => {
  it('工具面与 work **逐字相等** —— 两条路线的全部差异在正文，不在工具', () => {
    // 与 work / coding 的清单同一惯例：硬编码钉住（工具注册表导入链含 electron/native
    // 模块，测试内加载不了），改动需同步 apps/desktop/src/main/tools/allTools.ts
    expect(profile(CHAT_PROFILE_NAME).tools).toEqual([
      'bash',
      'read',
      'write',
      'edit',
      'ask',
      'browser',
      'ls',
      'grep',
      'glob',
      'database',
      'agent',
      'session',
      'knowledge',
      'artifact'
    ])
    // 这是裁决过的形态：两个基座工具面完全相同，「自己干活 / 把活交给 coding 子会话」
    // 全靠正文表达（下面那条钉的就是正文差异）。谁想靠收窄 work 的工具来"强制"它
    // 派活，会在这里撞红 —— 那等于让主会话连验收都做不了。
    expect(profile(CHAT_PROFILE_NAME).tools).toEqual(profile(WORK_PROFILE_NAME).tools)
  })

  it('三语 body 都不含任何派发/子会话引导 —— 拆分的唯一产品差异就是这段文案', () => {
    // 工具面逐字相同，「自己干活 / 把活交出去」全靠正文表达，而文案没有类型。
    // 既有用例只断言了 work 点名 coding，没有一条断言 chat **不**点名它。
    const HANDOFF = [
      'coding',
      'create-sub-session',
      'sub-session',
      '子会话',
      'サブセッション',
      '派发',
      'ディスパッチ'
    ]
    for (const language of LANGS) {
      const body = profile(CHAT_PROFILE_NAME, language).systemPrompt
      for (const term of HANDOFF) {
        expect(body, `chat.${language} 不应出现 ${term}`).not.toContain(term)
      }
      // 对照组：同一批词在 work 里是必须有的（否则这条用例可能只是在测一份空 body）
      const work = profile(WORK_PROFILE_NAME, language).systemPrompt
      for (const term of ['`coding`', 'create-sub-session', 'wait-for-sub-sessions']) {
        expect(work, `work.${language} 需点名 ${term}`).toContain(term)
      }
    }
  })
})

/**
 * 基座名单钉板 —— 会话根 Agent 的档案**由形态推导**（项目 work / 无项目 chat / 笔记本
 * notebook / bot 会话 bot），四者都不可被点名：不进派发名单，也不可作子会话的 `agent_profile`。
 * 曾经存在的「可切换基座名单」（SWITCHABLE_BASE_PROFILE_NAMES）与旧基座名 `default`
 * 已随会话内切换一并下线，这里钉住导出面，防它们悄悄复活。
 */
describe('基座名单钉板', () => {
  it('恰为 bot / chat / notebook / work 四个名字', () => {
    expect([...BASE_PROFILE_NAMES].sort()).toEqual(['bot', 'chat', 'notebook', 'work'])
    expect(BASE_PROFILE_NAMES.has(WORK_PROFILE_NAME)).toBe(true)
    expect(BASE_PROFILE_NAMES.has(CHAT_PROFILE_NAME)).toBe(true)
    expect(BASE_PROFILE_NAMES.has(NOTEBOOK_PROFILE_NAME)).toBe(true)
    // bot 是 bot 会话的基座：同样由形态推导、同样不可被点名
    expect(BASE_PROFILE_NAMES.has(BOT_PROFILE_NAME)).toBe(true)
  })

  it('没有任何内置 md 还带着退役的 shuvix-session-awareness（三语全集）', () => {
    // 这个键随会话内切换档案一并退役：子会话的 agent_profile 只看「不是基座」，解析器把它当
    // 未知键忽略。内置 md 是用户「创建覆盖副本」的样板，样板里留一行死键等于教用户去写它
    for (const spec of BUILTIN_PROFILE_SPECS) {
      for (const [language, source] of Object.entries(sourcesOf(spec.name))) {
        expect(source, `${spec.name}.${language}`).not.toContain('shuvix-session-awareness')
      }
    }
  })

  it("内置 spec 名单里没有旧基座名 'default'，导出面上没有切换名单与旧名常量", () => {
    expect(BUILTIN_PROFILE_SPECS.map((s) => s.name)).not.toContain('default')
    const exported = Object.keys(builtinAgentsModule)
    for (const gone of ['SWITCHABLE_BASE_PROFILE_NAMES', 'DEFAULT_PROFILE_NAME', 'DEFAULT_SPEC']) {
      expect(exported, `${gone} 不该再导出`).not.toContain(gone)
    }
    // 正控制组：新名字在
    expect(exported).toContain('WORK_PROFILE_NAME')
    expect(exported).toContain('WORK_SPEC')
  })
})

describe('work body 与 session 工具的动作枚举', () => {
  it('三语都逐字点名三个动作与两个参数名（改名后三份 md 会静默失效）', () => {
    // 提示词里的动作名是模型唯一的调用依据 —— 硬编码钉住，事实源在
    // apps/desktop/src/main/tools/session.ts 的 ACTIONS 与参数 schema
    //（与该文件既有的「工具注册序硬编码」同一惯例：那边导入链在测试内加载不了）
    const ANCHORS = [
      'create-sub-session',
      'prompt-sub-session',
      'wait-for-sub-sessions',
      'agent_profile',
      'run_in_background'
    ]
    for (const language of LANGS) {
      const body = profile(WORK_PROFILE_NAME, language).systemPrompt
      for (const anchor of ANCHORS) {
        expect(body, `work.${language} 需含 ${anchor}`).toContain(anchor)
      }
    }
  })
})

describe('coding 档案钉板(从 work 拆出的工程人格)', () => {
  it('工具面与两个基座**逐字相同** —— 三份档案共用一套工具，分工全在正文', () => {
    const built = profile('coding')
    expect(built.tools).toEqual([
      'bash',
      'read',
      'write',
      'edit',
      'ask',
      'browser',
      'ls',
      'grep',
      'glob',
      'database',
      'agent',
      'session',
      'knowledge',
      'artifact'
    ])
    // 拆分之初 coding 的卖点之一是「基座让出的 ssh/database 在这里」，那条理由已经
    // 作废：收窄工具从来不是表达分工的手段（收窄 work 只会让它拿 bash 绕一圈做同一件
    // 事）。现在 work / chat / coding 三份清单逐字相同，区别全部由正文承担 —— 谁想
    // 靠改工具面重新制造分工，会在这里撞红。
    expect(built.tools).toEqual(profile(WORK_PROFILE_NAME).tools)
    expect(built.tools).toEqual(profile(CHAT_PROFILE_NAME).tools)
  })

  it('不是基座档案 —— 可作 agent_profile 的唯一判据', () => {
    // coding 是子会话的档案（work 开 `coding` 子会话把活交过去），不是用户切换的目标：
    // 它只需过 pinAgentProfile 的那一道门 —— 不是基座名
    expect(BASE_PROFILE_NAMES.has('coding')).toBe(false)
  })

  it('三语 description 都指向 work 与子会话、不再提 /coding 切换', () => {
    // 描述是设置页里对这份档案的定位说明：会话内切换已下线，「/coding」这条入口不存在了
    const SUB_SESSION_WORD: Record<(typeof LANGS)[number], string> = {
      en: 'sub-session',
      zh: '子会话',
      ja: 'サブセッション'
    }
    for (const language of LANGS) {
      const desc = profile('coding', language).description
      expect(desc, `coding.${language}`).not.toContain('/coding')
      expect(desc, `coding.${language}`).toContain('work')
      expect(desc, `coding.${language}`).toContain(SUB_SESSION_WORD[language])
    }
  })

  it('三语 work 都点名 coding —— 子会话该用哪份档案，只能从提示词被模型知晓', () => {
    for (const language of LANGS) {
      expect(profile(WORK_PROFILE_NAME, language).systemPrompt, `work.${language}`).toContain(
        '`coding`'
      )
    }
  })

  it('两侧派发清单各按场景裁剪（派发工具不枚举 agent 名，名字只能来自提示词）', () => {
    for (const language of LANGS) {
      const coding = profile('coding', language).systemPrompt
      const work = profile(WORK_PROFILE_NAME, language).systemPrompt
      // coding：工程场景只要广域调研（结构图走对话 mermaid，不派子智能体）
      expect(coding, `coding.${language} 需点名 explore`).toContain('explore')
      expect(coding, `coding.${language} 不应点名 widget`).not.toContain('widget')
      // work：通用场景要小工具，广域调研留给 coding 子会话
      expect(work, `work.${language} 需点名 widget`).toContain('widget')
      expect(work, `work.${language} 不应点名 explore`).not.toContain('explore')
    }
  })
})

describe('titler 档案钉板（auto-title 的执行侧）', () => {
  it('tools 恰为 [session] —— 命名任务只需要改自己会话的标题这一件事', () => {
    expect(profile('titler').tools).toEqual(['session'])
  })

  it('不是基座档案', () => {
    expect(BASE_PROFILE_NAMES.has('titler')).toBe(false)
  })

  it('不声明 shuvix-model（内置跟随派发方；钉便宜模型走用户覆盖 titler.md）', () => {
    expect(profile('titler').model).toBeUndefined()
  })

  it('三语 body 都含 session / set-title 与 60（工具协议与长度上限不因翻译走样）', () => {
    for (const language of LANGS) {
      const body = profile('titler', language).systemPrompt
      for (const anchor of ['`session`', 'set-title', '60']) {
        expect(body, `titler.${language} 需含 ${anchor}`).toContain(anchor)
      }
    }
  })
})

describe('notebook 档案钉板(笔记本会话根 Agent 的基座)', () => {
  it('工具集含 ask（对话抽屉可应答审批/提问）但不含 agent —— 不嵌套派发', () => {
    const built = profile(NOTEBOOK_PROFILE_NAME)
    expect(built.tools).toContain('ask')
    expect(built.tools).not.toContain('agent')
    expect(built.tools).toContain('read')
    expect(built.tools).toContain('edit')
  })

  it('body 引用 notebookPath 占位符 —— 端在渲染时替换为当前笔记路径', () => {
    for (const language of LANGS) {
      expect(profile(NOTEBOOK_PROFILE_NAME, language).systemPrompt).toContain(
        '{{shuvix:notebookPath}}'
      )
    }
  })

  it('是基座档案,不进派发名单、不可作 agent_profile', () => {
    expect(BASE_PROFILE_NAMES.has(NOTEBOOK_PROFILE_NAME)).toBe(true)
    expect(BASE_PROFILE_NAMES.has(WORK_PROFILE_NAME)).toBe(true)
  })
})

/**
 * bot 档案钉板（bot 会话的基座）——「看得见、动不了」的那半个保证住在这里。
 *
 * 一条 bot 会话是普通有根会话，根 Agent 跑的就是这份档案；**它是谁**由会话绑定的那份
 * bot md 经 systemContext 追加（渲染见 bot/botContext.ts）。三条钉板对应
 * 这份设计的三个支点：窄工具清单（RPer-1）、交接流程活在散文里（RPer-2）、围栏标签名
 * 两处一致（RPer-3）。
 */
describe('bot 档案钉板（bot 会话的基座）', () => {
  it('RPer-1 三语工具清单恰为十件、不含 bash/write/ssh/database/browser、不声明模型', () => {
    // 这份窄清单**就是**「看得见、动不了」那半个保证：它能读能查能问、能改自己那份
    // bot md（edit），但没有 shell、没有创建文件的路 —— 真要干活只能开子会话，
    // 而子会话按自己的档案生成提示词、拿不到人设围栏。谁想「顺手给它一个 bash」，
    // 那条结构保证当场作废（work/chat/coding 三份清单相同的那条惯例在这里刻意不适用）
    for (const language of LANGS) {
      const built = profile(BOT_PROFILE_NAME, language)
      expect(built.tools, `bot.${language}`).toEqual([
        'read',
        'ls',
        'grep',
        'glob',
        'ask',
        'edit',
        'session',
        'agent',
        'knowledge',
        'artifact'
      ])
      for (const forbidden of ['bash', 'write', 'database', 'browser', 'git']) {
        expect(built.tools, `bot.${language} 不得持有 ${forbidden}`).not.toContain(forbidden)
      }
      // 不声明 shuvix-model：模型是**会话**的事（用户在模型选择器里选），不是档案的事
      expect(built.model, `bot.${language}`).toBeUndefined()
    }
    // 是基座档案：由形态推导、不可被点名（不进派发名单，也不能当子会话的 agent_profile）
    expect(BASE_PROFILE_NAMES.has(BOT_PROFILE_NAME)).toBe(true)
  })

  it('RPer-2 三语正文都点名三个子会话动作与 coding —— 整套交接设计活在散文里', () => {
    // 工具清单只说「它有 session 工具」，说不出「把活整包交出去、验收完再用自己的口吻汇报」。
    // 那套流程没有任何机制承载，全部由这段正文表达 —— 翻译漏一个词就等于在那门语言里
    // 静默关掉它（对照 work 档案的同名钉板）
    for (const language of LANGS) {
      const body = profile(BOT_PROFILE_NAME, language).systemPrompt
      for (const anchor of [
        'create-sub-session',
        'prompt-sub-session',
        'wait-for-sub-sessions',
        'agent_profile',
        'run_in_background',
        '`coding`'
      ]) {
        expect(body, `bot.${language} 需点名 ${anchor}`).toContain(anchor)
      }
    }
  })

  it('RPer-3 三语正文都点名 <bot_profile> 标签，且该字符串等于 BOT_CONTEXT_TAG', () => {
    // 正文里写着「你是谁在末尾的 <bot_profile> 块里」，而那个块由 renderBotContext 生成。
    // 两处对不上，模型就会去找一个不存在的块 —— 而缺块时的正文分支恰恰教它「别编角色」，
    // 于是每条 bot 会话都以「我的 bot 文件没了」开场
    for (const language of LANGS) {
      const body = profile(BOT_PROFILE_NAME, language).systemPrompt
      expect(body, `bot.${language}`).toContain(`\`<${BOT_CONTEXT_TAG}>\``)
    }
    expect(BOT_CONTEXT_TAG).toBe('bot_profile')
  })
})

/**
 * 内置档案的**多语言交付面** —— 逐份内置 × 三门语言扫一遍，守的是「每份内置都真有三门
 * 语言、每门语言都真有一个给人读的名字」。逐份的内容纪律（工具面 / 注入开关 / 正文锚点）
 * 归上面各自的钉板，这里只管交付面，不重复那边的用例。
 *
 * 三条写法上的纪律，都是为了不让用例空转：
 *  - 语言表**硬编码** `['en','zh','ja']`，不取 `Object.keys(spec.sources)` —— 后者会让一份
 *    只有 en 的内置「按自己声明的语言全绿」，而漏交的两门语言正是本节要抓的东西；
 *  - 一律 `buildBuiltinProfile(spec, …)` 逐份构建并先断非 null，不遍历 `buildBuiltinProfiles()`
 *    的结果 —— 后者 filter 掉解析失败的项，一份写坏的本地化 md 会直接从数组里消失，
 *    循环于是照样全绿；
 *  - 宿主参数一律给全（ALL_PARAMS）—— 缺参的 spec 构建即返回 null，widget 那一份会当场
 *    跳过检查，那正是本节要堵的洞。
 *
 * 用例清单：
 *  - AD-1 每份内置 × 每门语言都有真名字：构建非 null、displayName 非空且不等于 slug
 *  - AD-2 名字确实翻译过：zh / ja 的 displayName 各自与 en 不同
 *  - AD-3 每份内置都齐三门语言：sources 键恰 {en, ja, zh}
 */
describe('内置档案 —— 三语言交付面（逐份 × 逐语言）', () => {
  /** 逐份构建并断非 null → {内置名: displayName} */
  const displayNames = (language: string): Record<string, string> =>
    Object.fromEntries(
      BUILTIN_PROFILE_SPECS.map((spec) => {
        const built = buildBuiltinProfile(spec, { ...ALL_PARAMS, language })
        expect(built, `${spec.name} @ ${language} 构建失败`).not.toBeNull()
        return [spec.name, built!.displayName]
      })
    )

  it('AD-1 每份内置 × 每门语言都有一个真名字（非空且不等于 slug）', () => {
    // 解析器对「缺 shuvix-displayName」「写了空串」「只有空白」一律回落到 slug，所以这一条
    // 断言就把三种漏译形态一起抓了。bot-intent 正是这么漏出去的：三门语言一个名字都没写，
    // 设置页的 agent 列表里就裸着一个 slug
    for (const spec of BUILTIN_PROFILE_SPECS) {
      for (const language of LANGS) {
        const built = buildBuiltinProfile(spec, { ...ALL_PARAMS, language })
        expect(built, `${spec.name} 的 ${language} 版构建失败`).not.toBeNull()
        expect(
          built!.displayName.trim(),
          `${spec.name} @ ${language} 的 displayName 为空`
        ).not.toBe('')
        expect(
          built!.displayName,
          `${spec.name} @ ${language} 的 displayName 回落成了 slug`
        ).not.toBe(spec.name)
      }
    }
  })

  it('AD-2 名字确实翻译过：zh / ja 的 displayName 与 en 不同', () => {
    // 这条正是「只放了一份 .md 就交差」的破绽：整文件回退会把 en 那份原样发给 zh，AD-1
    // 仍然全绿（名字非空、也不等于 slug），只有这里能看出没翻。
    // 只与 en 比，不断言 zh ≠ ja —— 两门语言正好落在同一个词上不是缺陷（explore 的
    // zh / ja 都是「探索」）
    const en = displayNames('en')
    for (const language of ['zh', 'ja'] as const) {
      const localized = displayNames(language)
      for (const spec of BUILTIN_PROFILE_SPECS) {
        expect(
          localized[spec.name],
          `${spec.name} 的 ${language} displayName 与 en 相同（多半是漏了 ${language} 那份 md）`
        ).not.toBe(en[spec.name])
      }
    }
  })

  it('AD-3 每份内置都齐三门语言：md 目录里恰有 en / ja / zh 三份', () => {
    // 恰等而非包含：应用就三门语言，多出第四份文件应当是一次有意的编辑，顺手改这里。
    // 读的是运行时同一批文件（桌面读随包目录，这里读构建期内联的同一批）
    for (const spec of BUILTIN_PROFILE_SPECS) {
      expect(Object.keys(sourcesOf(spec.name)).sort(), `${spec.name} 的语言集合漂移`).toEqual([
        'en',
        'ja',
        'zh'
      ])
    }
  })
})
