/**
 * 内置档案的构建语义与内容钉板。
 *
 * 文案的唯一事实源已是 `builtinAgents/md/*.md`，所以断言一律打在**解析后的档案**上
 * （而非 TS 字面量）—— 这条链路同时覆盖了 md 格式合法性：任何一份 md 的 frontmatter
 * 写坏，buildBuiltinProfile 返回 null，下面的用例立刻失败。
 */
import { describe, it, expect } from 'vitest'
import {
  BASE_PROFILE_NAMES,
  BUILTIN_PROFILE_SPECS,
  buildBuiltinProfile,
  buildBuiltinProfiles,
  DEFAULT_PROFILE_NAME,
  NOTEBOOK_PROFILE_NAME,
  WIDGET_SPEC,
  WIKI_SPEC,
  WIKI_WRITER_SPEC,
  WIKI_ENTRY_BANNER,
  WIKI_TOPIC_BANNER,
  pickLocalizedSource
} from '../../subagent/builtinAgents'
import {
  isWikiEntryFile,
  parseWikiEntryHead,
  WIKI_ALLOWED_TYPES_KEY,
  WIKI_CONTENT_KEY,
  WIKI_ENTRY_MARKER,
  WIKI_ENTRY_STATUSES,
  WIKI_ENTRY_TYPE_KEY,
  WIKI_ENTRY_TYPES,
  WIKI_FILE_MARKER_KEY,
  WIKI_SOURCES_KEY,
  WIKI_STATUS_KEY,
  WIKI_TOPIC_MARKER,
  WIKI_UPDATED_KEY
} from '@shuvix/chat-protocol/wikiFileContract'
import { parse as parseYaml } from 'yaml'
import type { AgentProfile } from '../../subagent/types'

const ALL_PARAMS = { widgetsRoot: '/w', wikiRoot: '/k' }
const profile = (name: string, language?: string): AgentProfile =>
  buildBuiltinProfiles({ ...ALL_PARAMS, language }).find((a) => a.name === name)!

/** 条目/章程模板与横幅都在执行侧（wiki-writer）—— 对话侧只有它们的浓缩说明 */
const wikiPrompt = (language: string): string =>
  buildBuiltinProfile(WIKI_WRITER_SPEC, { wikiRoot: '/k', language })!.systemPrompt

/** 取出提示词里的 ```markdown 围栏样例（wiki 的条目模板与章程模板都是这种块） */
const markdownSamples = (prompt: string): string[] =>
  [...prompt.matchAll(/```markdown\n([\s\S]*?)\n```/g)].map((m) => m[1])

describe('buildBuiltinProfile — md 解析 + 宿主参数插值', () => {
  it('en 档案解析出全部字段，宿主参数就地替换', () => {
    const built = buildBuiltinProfile(WIKI_WRITER_SPEC, { wikiRoot: '/wikis' })!
    expect(built.displayName).toBe('Knowledge Base Writer')
    expect(built.description).toBe(
      'Executes changes to the local wiki knowledge base: entries, topics, lifecycle and git history.'
    )
    expect(built.systemPrompt).toContain('The wiki root is: /wikis')
    expect(built.systemPrompt).not.toContain('{{wikiRoot}}')
    expect(built.source).toBe('builtin')
    expect(built.tools).toEqual(['read', 'grep', 'glob', 'ls', 'write', 'edit', 'git', 'ask'])
  })

  it('会话级 {{shuvix:*}} 占位符不在此替换（留给 createAgent）', () => {
    expect(profile(DEFAULT_PROFILE_NAME).systemPrompt).toContain('{{shuvix:workingDirectory}}')
  })

  it('缺必需宿主参数 → 返回 null(该端不支持此 agent)', () => {
    expect(buildBuiltinProfile(WIDGET_SPEC, {})).toBeNull()
    expect(buildBuiltinProfile(WIKI_SPEC, { widgetsRoot: '/w' })).toBeNull()
  })

  it('wiki 两个横幅常量与三语 md 模板互为副本（改一处即失败）', () => {
    for (const language of ['en', 'zh', 'ja']) {
      const prompt = wikiPrompt(language)
      expect(prompt, `wiki.${language} entry banner`).toContain(WIKI_ENTRY_BANNER)
      expect(prompt, `wiki.${language} topic banner`).toContain(WIKI_TOPIC_BANNER)
    }
  })

  it('wiki 模板逐字使用契约的标记与字段名（契约改名而提示词未跟进即失败）', () => {
    const keys = [
      WIKI_CONTENT_KEY,
      WIKI_STATUS_KEY,
      WIKI_ENTRY_TYPE_KEY,
      WIKI_UPDATED_KEY,
      WIKI_SOURCES_KEY,
      WIKI_ALLOWED_TYPES_KEY
    ]
    for (const language of ['en', 'zh', 'ja']) {
      const prompt = wikiPrompt(language)
      for (const key of keys) expect(prompt, `wiki.${language} ${key}`).toContain(`${key}:`)
      for (const marker of [WIKI_ENTRY_MARKER, WIKI_TOPIC_MARKER]) {
        expect(prompt, `wiki.${language} ${marker}`).toContain(`${WIKI_FILE_MARKER_KEY}: ${marker}`)
      }
      // 枚举全集也钉住 —— 契约里加一个状态/页面类型而三语提示词没跟进即失败
      expect(prompt, `wiki.${language} statuses`).toContain(WIKI_ENTRY_STATUSES.join(' | '))
      expect(prompt, `wiki.${language} types`).toContain(WIKI_ENTRY_TYPES.join(' | '))
    }
  })

  it('wiki 拆分的结构性保证：对话侧无任何写入工具，执行侧不可切换', () => {
    for (const language of ['en', 'zh', 'ja']) {
      const desk = buildBuiltinProfile(WIKI_SPEC, { wikiRoot: '/k', language })!
      const writer = buildBuiltinProfile(WIKI_WRITER_SPEC, { wikiRoot: '/k', language })!
      // 拆分的意义就在这份清单上：对话侧拿不到写入类工具，长对话把上下文稀释掉时也不会
      // 顺手改坏知识库（真要保证不被改坏得靠 security 策略，这里是少给工具少跑偏）。
      // git 也不给 —— 它是单个工具带 commit 子命令，给了就等于把写入动作放回对话侧的清单里。
      for (const forbidden of ['write', 'edit', 'git']) {
        expect(desk.tools, `wiki.${language} 不得持有 ${forbidden}`).not.toContain(forbidden)
      }
      expect(desk.tools, `wiki.${language} 需能派发`).toContain('agent')
      expect(desk.dispatchOnly, `wiki.${language} 必须可切换`).toBe(false)
      expect(writer.dispatchOnly, `wiki-writer.${language} 必须只可派发`).toBe(true)
      // 对话侧必须点名执行侧 —— 派发工具不枚举 agent 名，名字只能来自提示词
      expect(desk.systemPrompt, `wiki.${language} 需点名 wiki-writer`).toContain('wiki-writer')
      // 派发调用形状与确认通道必须写明 —— 弱模型曾靠猜参数名连番失败、把批准确认写成纯文本
      expect(desk.systemPrompt, `wiki.${language} 需给出派发参数形状`).toContain(
        'name: "wiki-writer"'
      )
      expect(desk.systemPrompt, `wiki.${language} 确认须走 ask 工具`).toContain('`ask`')
    }
  })

  it('模板里的条目样例本身就是合法契约文件（提示词与解析器不漂移）', () => {
    for (const language of ['en', 'zh', 'ja']) {
      const sample = markdownSamples(wikiPrompt(language)).find((s) =>
        s.includes(WIKI_ENTRY_MARKER)
      )!
      expect(sample, `wiki.${language} 缺条目样例`).toBeDefined()
      expect(isWikiEntryFile(sample), `wiki.${language}`).toBe(true)
      // 样例的占位正文必须能被取出 —— 取不到说明块标量写法与解析器不一致
      expect(parseWikiEntryHead(sample)?.content, `wiki.${language}`).toBeTruthy()
    }
  })

  it('模板 frontmatter 必须是合法 YAML（宽容解析器放得过，预览/校验的真 YAML 放不过）', () => {
    // 上一条走 wikiFileContract 的零依赖宽容解析器 —— 它按规范形态取值,不做 YAML 合法性
    // 判定,曾放过条目横幅里的 ": "（裸标量禁止冒号+空格）,LLM 逐字照抄后每个生成条目
    // 都被 frontmatter 卡判为 YAML 语法错。这里用真 YAML 解析器把每个模板样例钉死,并
    // round-trip 断言横幅逐字还原（防引号/特殊字符被解析改写）。
    for (const language of ['en', 'zh', 'ja']) {
      for (const sample of markdownSamples(wikiPrompt(language))) {
        const fm = /^---\n([\s\S]*?)\n---/.exec(sample)?.[1]
        expect(fm, `wiki.${language} 样例缺 frontmatter`).toBeTruthy()
        const doc = parseYaml(fm!) as Record<string, unknown>
        const banner = sample.includes(WIKI_ENTRY_MARKER) ? WIKI_ENTRY_BANNER : WIKI_TOPIC_BANNER
        expect(doc.description, `wiki.${language} banner round-trip`).toBe(banner)
      }
    }
  })
})

describe('语言解析 — 精确 → 基础 → en，按文件整体回退', () => {
  it('zh / ja 取对应语言文件；zh-CN 落回 zh', () => {
    expect(profile(DEFAULT_PROFILE_NAME, 'zh').displayName).toBe('默认')
    expect(profile(DEFAULT_PROFILE_NAME, 'zh-CN').displayName).toBe('默认')
    expect(profile(DEFAULT_PROFILE_NAME, 'ja').displayName).toBe('デフォルト')
  })

  it('未知语言 / 缺省 → en', () => {
    expect(profile(DEFAULT_PROFILE_NAME, 'fr').displayName).toBe('Default')
    expect(profile(DEFAULT_PROFILE_NAME).displayName).toBe('Default')
  })

  it('pickLocalizedSource 是纯函数形式的同一套规则', () => {
    const sources = { en: 'E', zh: 'Z' }
    expect(pickLocalizedSource(sources, 'zh-TW')).toBe('Z')
    expect(pickLocalizedSource(sources, 'ja')).toBe('E')
    expect(pickLocalizedSource(sources, undefined)).toBe('E')
  })
})

describe('buildBuiltinProfiles — 全集现算', () => {
  it('全参数 → 十二个内置,两个基座档案居首;缺 widget/wiki 根 → 自动跳过', () => {
    expect(buildBuiltinProfiles(ALL_PARAMS).map((a) => a.name)).toEqual([
      'default',
      'notebook',
      'coding',
      'browser',
      'explore',
      'visualization',
      'widget',
      'wiki',
      'wiki-writer',
      'titler',
      'bot-intent',
      'bot-notes'
    ])
    // titler 与两个 bot 阶段档案无宿主参数依赖：缺 widget/wiki 根也在
    //（模型走 shuvix-model 通用链路，内置不声明）
    expect(buildBuiltinProfiles({}).map((a) => a.name)).toEqual([
      'default',
      'notebook',
      'coding',
      'browser',
      'explore',
      'visualization',
      'titler',
      'bot-intent',
      'bot-notes'
    ])
  })

  it('每个 spec 的三份语言文件都能解析成合法档案', () => {
    for (const spec of BUILTIN_PROFILE_SPECS) {
      for (const language of ['en', 'zh', 'ja']) {
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
      for (const [language, source] of Object.entries(spec.sources)) {
        expect(source, `${spec.name}.${language}`).toMatch(/^shuvix-builtin: true$/m)
      }
    }
  })

  it('各语言文件的 {{...}} 占位符集合与 en 完全一致（翻译时漏改/误译占位符 = 变量失效）', () => {
    const placeholders = (text: string): string[] =>
      [...new Set(text.match(/\{\{[^}]+\}\}/g) ?? [])].sort()
    for (const spec of BUILTIN_PROFILE_SPECS) {
      const expected = placeholders(spec.sources.en)
      for (const [language, source] of Object.entries(spec.sources)) {
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

describe('default 档案钉板(主会话默认工具集/环境段的唯一事实源)', () => {
  it('tools 按桌面注册序列出 + Agent 居末;检索/远程/数据库类工具已随工程人格拆去 coding', () => {
    // 顺序与 apps/desktop/src/main/tools/allTools.ts 的注册序一致(bash→read→write→edit→ask→
    // browser→ls→grep→glob→ssh→database)——LLM 所见工具序列的稳定性依赖它;
    // 工具注册表导入链含 electron/native 模块无法在测试内加载,故硬编码钉住,改动需同步两侧。
    const built = profile(DEFAULT_PROFILE_NAME)
    expect(built.tools).toEqual(['bash', 'read', 'write', 'edit', 'ask', 'browser', 'agent'])
    // ls/grep/glob 亦不在（通用会话里检索走 bash,成规模的调研切 /coding）
    for (const gone of ['ls', 'grep', 'glob', 'ssh', 'database', 'git', 'preview']) {
      expect(built.tools, `default 不应持有 ${gone}`).not.toContain(gone)
    }
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

  it('内置档案默认认 AGENTS.md → CLAUDE.md（notebook/titler/bot 阶段档案除外）、项目感知默认开（同上除外）', () => {
    /** 两样注入都不要的执行型档案（上下文无关的一次性任务，注入整份项目文档纯属浪费 token 且稀释指令） */
    const NO_INJECTION = ['titler', 'bot-intent', 'bot-notes']
    for (const spec of BUILTIN_PROFILE_SPECS) {
      const built = buildBuiltinProfile(spec, ALL_PARAMS)!
      // 两项注入的开关面不同：
      //  - 指令文件：notebook 不吃 —— AGENTS.md/CLAUDE.md 是写代码的工程约定，改一篇笔记用不上；
      //  - 项目感知：notebook 照常开 —— 笔记就写在项目里，项目提示词与项目记忆正是它的上下文；
      //  - titler 两样都不要；bot-intent / bot-notes 同一取舍：门控段跑在每条消息的首字节
      //    路径上、记忆段异步跑在回复之后，两者都不该背项目提示词与记忆索引。
      const instructionsOn =
        spec.name !== NOTEBOOK_PROFILE_NAME && !NO_INJECTION.includes(spec.name)
      const awarenessOn = !NO_INJECTION.includes(spec.name)
      // 清单顺序即优先级：两份都在时取 AGENTS.md（正是改制前那条内置默认优先级）
      expect(built.instructionFiles, spec.name).toEqual(
        instructionsOn ? ['AGENTS.md', 'CLAUDE.md'] : []
      )
      expect(built.projectAwareness, spec.name).toBe(awarenessOn)
    }
  })
})

describe('coding 档案钉板(从 default 拆出的工程人格)', () => {
  it('握有完整工具链 —— default 让出的 ssh/database 在这里', () => {
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
      'ssh',
      'database',
      'agent'
    ])
  })

  it('是可切换的具名档案（/coding），不是基座档案也不是 dispatch-only', () => {
    expect(BASE_PROFILE_NAMES.has('coding')).toBe(false)
    expect(profile('coding').dispatchOnly).toBe(false)
  })

  it('三语 default 都点名 coding —— 切换入口只能从提示词被用户知晓', () => {
    for (const language of ['en', 'zh', 'ja']) {
      expect(profile(DEFAULT_PROFILE_NAME, language).systemPrompt, `default.${language}`).toContain(
        '`coding`'
      )
    }
  })

  it('两侧派发清单各按场景裁剪（派发工具不枚举 agent 名，名字只能来自提示词）', () => {
    for (const language of ['en', 'zh', 'ja']) {
      const coding = profile('coding', language).systemPrompt
      const def = profile(DEFAULT_PROFILE_NAME, language).systemPrompt
      // coding：工程场景只要广域调研 + 作图
      for (const named of ['explore', 'visualization']) {
        expect(coding, `coding.${language} 需点名 ${named}`).toContain(named)
      }
      for (const gone of ['widget', 'wiki-writer']) {
        expect(coding, `coding.${language} 不应点名 ${gone}`).not.toContain(gone)
      }
      // default：通用场景要作图/小工具/知识库，广域调研留给 /coding
      for (const named of ['visualization', 'widget', 'wiki-writer']) {
        expect(def, `default.${language} 需点名 ${named}`).toContain(named)
      }
      expect(def, `default.${language} 不应点名 explore`).not.toContain('explore')
    }
  })
})

describe('titler 档案钉板（auto-title 的执行侧）', () => {
  it('tools 恰为 [session-config] —— 命名任务只需要改自己会话的标题这一件事', () => {
    expect(profile('titler').tools).toEqual(['session-config'])
  })

  it('dispatchOnly：只可派发、不可 /titler 切换，也不是基座档案', () => {
    expect(profile('titler').dispatchOnly).toBe(true)
    expect(BASE_PROFILE_NAMES.has('titler')).toBe(false)
  })

  it('不声明 shuvix-model（内置跟随派发方；钉便宜模型走用户覆盖 titler.md）', () => {
    expect(profile('titler').model).toBeUndefined()
  })

  it('三语 body 都含 session-config / next / set-title 与 60（工具协议与长度上限不因翻译走样）', () => {
    for (const language of ['en', 'zh', 'ja']) {
      const body = profile('titler', language).systemPrompt
      for (const anchor of ['session-config', 'next', 'set-title', '60']) {
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
    for (const language of ['en', 'zh', 'ja']) {
      expect(profile(NOTEBOOK_PROFILE_NAME, language).systemPrompt).toContain(
        '{{shuvix:notebookPath}}'
      )
    }
  })

  it('是基座档案,不进派发/切换名单', () => {
    expect(BASE_PROFILE_NAMES.has(NOTEBOOK_PROFILE_NAME)).toBe(true)
    expect(BASE_PROFILE_NAMES.has(DEFAULT_PROFILE_NAME)).toBe(true)
  })
})
