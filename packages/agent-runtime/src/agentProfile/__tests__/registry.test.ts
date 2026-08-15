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
      // 整套拆分的效力不靠提示词自觉，靠这条：对话侧的上下文被长对话稀释也损坏不了知识库。
      // git 也不给 —— 它是单个工具带 commit 子命令，无法只授读权限。
      for (const forbidden of ['write', 'edit', 'git']) {
        expect(desk.tools, `wiki.${language} 不得持有 ${forbidden}`).not.toContain(forbidden)
      }
      expect(desk.tools, `wiki.${language} 需能派发`).toContain('Agent')
      expect(desk.dispatchOnly, `wiki.${language} 必须可切换`).toBe(false)
      expect(writer.dispatchOnly, `wiki-writer.${language} 必须只可派发`).toBe(true)
      // 对话侧必须点名执行侧 —— 派发工具不枚举 agent 名，名字只能来自提示词
      expect(desk.systemPrompt, `wiki.${language} 需点名 wiki-writer`).toContain('wiki-writer')
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
  it('全参数 → 七个内置,两个基座档案居首;缺 widget/wiki 根 → 自动跳过', () => {
    expect(buildBuiltinProfiles(ALL_PARAMS).map((a) => a.name)).toEqual([
      'default',
      'notebook',
      'explore',
      'visualization',
      'widget',
      'wiki',
      'wiki-writer'
    ])
    expect(buildBuiltinProfiles({}).map((a) => a.name)).toEqual([
      'default',
      'notebook',
      'explore',
      'visualization'
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
        expect(loc.instructionFiles, `${spec.name}.${language}`).toBe(en.instructionFiles)
        expect(loc.projectPrompt, `${spec.name}.${language}`).toBe(en.projectPrompt)
      }
    }
  })
})

describe('default 档案钉板(主会话默认工具集/环境段的唯一事实源)', () => {
  it('tools 按桌面注册序列出 + Agent 居末;不含 git/preview(用户可覆盖 default.md 加入)', () => {
    // 顺序与 apps/desktop/src/main/tools/allTools.ts 的注册序一致(bash→read→write→edit→ask→
    // browser→ls→grep→glob→ssh→database)——LLM 所见工具序列的稳定性依赖它;
    // 工具注册表导入链含 electron/native 模块无法在测试内加载,故硬编码钉住,改动需同步两侧。
    const built = profile(DEFAULT_PROFILE_NAME)
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
      'Agent'
    ])
    expect(built.tools).not.toContain('git')
    expect(built.tools).not.toContain('preview')
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

  it('内置档案注入开关默认开启（notebook 除外 —— 维持迁移前的笔记本行为）', () => {
    for (const spec of BUILTIN_PROFILE_SPECS) {
      const built = buildBuiltinProfile(spec, ALL_PARAMS)!
      const expected = spec.name !== NOTEBOOK_PROFILE_NAME
      expect(built.instructionFiles, spec.name).toBe(expected)
      expect(built.projectPrompt, spec.name).toBe(expected)
    }
  })
})

describe('notebook 档案钉板(笔记本一次性子代理的基座)', () => {
  it('工具集不含 ask / Agent —— 面板只读无法应答,且不嵌套派发', () => {
    const built = profile(NOTEBOOK_PROFILE_NAME)
    expect(built.tools).not.toContain('ask')
    expect(built.tools).not.toContain('Agent')
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
