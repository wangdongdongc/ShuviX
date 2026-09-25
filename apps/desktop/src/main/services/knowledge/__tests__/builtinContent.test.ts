/**
 * BK —— 内置知识库的**内容**用例：随应用发布的 ShuviX 说明书
 * （`apps/desktop/resources/knowledge/shuvix/{en,ja,zh}/*.md`，一种语言一版）。
 *
 * ⚠️ 与本目录其它用例**性质不同，别照抄隔壁的写法**：
 *   - 读的是**仓库里的真实目录**，不桩 `utils/paths`、不进任何 `vi.mock` —— 这里要钉的就是仓库里
 *     那批 md 本身（隔壁 scan / entries / search 那批钉的是宿主逻辑，才需要临时根 + mock）；
 *   - **只读，一个字节都不写盘**；
 *   - 路径从 `import.meta.url` 往上找仓库根 —— vitest 的 root 是 `apps/desktop`，`process.cwd()`
 *     不能当仓库根用。
 *
 * 钉的是四件事：三语同名同数、每一份都是合规 OKF 条目（零 error 零 warning）、元数据形状
 * （自述行 / Guide / stable / 非空 title·description·tags，且**不带**机器署名 `generated` /
 * `verified` —— 说明书是人写的产品内容）、以及 `sources` 指向的解析器**真的还在那个路径上**。
 * 最后一条是「说明书跟着解析器搬家」的守护：解析器换了目录而说明书没跟上，这里先红。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildBuiltinProfiles,
  headingsOf,
  validateBundleFiles,
  HOOK_ON_KEY,
  HOOK_AGENT_KEY,
  BOT_RETIRED_PIPELINE_KEY,
  POLICY_RULES_KEY,
  POLICY_LETS_KEY,
  POLICY_SCOPE_KEY,
  type BundleFile,
  type KnowledgeConcept
} from '@shuvix/agent-runtime'
import { createInlineMdReader } from '@shuvix/agent-runtime/builtinAgents/inlineSources'
import {
  KNOWLEDGE_BUILTIN_BASE,
  KNOWLEDGE_MARKER,
  type KnowledgeType,
  type OkfStatus
} from '@shuvix/chat-protocol/knowledge'
const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/apps/desktop/src/main/services/knowledge/__tests__` 往上七层 */
const REPO_ROOT = resolve(HERE, '../../../../../../..')
/** 内置库根（打包后是 `Resources/knowledge/`，开发时就是它）下的那一个库 */
const BASE_DIR = join(REPO_ROOT, 'apps/desktop/resources/knowledge', KNOWLEDGE_BUILTIN_BASE)

/** `sources[].resource` 的形状：GitHub 上 main 分支的 blob 链接，后缀即仓库内路径 */
const SOURCE_PREFIX = 'https://github.com/wangdongdongc/ShuviX/blob/main/'

/** 说明书统一的 type / status（用词汇表类型标注：词汇表里删掉它，这里 typecheck 先红） */
const GUIDE_TYPE: KnowledgeType = 'Guide'
const GUIDE_STATUS: OkfStatus = 'stable'

/** 界面语言那三种；磁盘上多一版少一版都该在 BK-1 当场说清楚（新语言要补齐全部说明书） */
const EXPECTED_LANGS = ['en', 'ja', 'zh']

const langDirs = (): string[] =>
  existsSync(BASE_DIR)
    ? readdirSync(BASE_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : []

const mdFiles = (lang: string): string[] =>
  readdirSync(join(BASE_DIR, lang))
    .filter((name) => name.endsWith('.md'))
    .sort()

/** 一种语言那一版就是一个 bundle：路径即文件名（语言目录不进 bundle 内路径） */
const bundleOf = (lang: string): BundleFile[] =>
  mdFiles(lang).map((name) => ({
    path: name,
    text: readFileSync(join(BASE_DIR, lang, name), 'utf8')
  }))

const LANGS = langDirs()

describe('BK 内置知识库：随应用发布的说明书', () => {
  it('BK-1 三语同名同数：语言目录就是界面语言那三种，各自的 md 文件名集合逐字相等', () => {
    expect(LANGS).toEqual(EXPECTED_LANGS)
    const [first, ...rest] = LANGS
    const names = mdFiles(first)
    // 份数不硬编码：只要求三者相等（加一篇 Guide 不该让用例变红）
    expect(names.length).toBeGreaterThan(0)
    for (const lang of rest) {
      expect({ lang, names: mdFiles(lang) }).toEqual({ lang, names })
    }
  })
})

describe.each(LANGS)('BK 内置知识库 · %s', (lang) => {
  const files = bundleOf(lang)
  const paths = files.map((f) => f.path)
  const { diagnostics, concepts } = validateBundleFiles(files)
  const byPath = new Map(concepts.map((c) => [c.path, c]))
  const conceptOf = (path: string): KnowledgeConcept => {
    const concept = byPath.get(path)
    if (!concept) throw new Error(`${lang}/${path} 没有解析成 OKF 条目（见 BK-2）`)
    return concept
  }

  it('BK-2 每一份都是合规 OKF 条目：整包校验零 error，条目集合就是文件集合', () => {
    expect(diagnostics.filter((d) => d.level === 'error')).toEqual([])
    expect([...byPath.keys()].sort()).toEqual(paths)
  })

  it('BK-7 整包校验零 warning（正文里的示例链接指向本库里真实存在的条目）', () => {
    expect(diagnostics.filter((d) => d.level === 'warning')).toEqual([])
  })

  it.each(paths)(
    'BK-3 %s 元数据齐全：自述行 / type: Guide / status: stable / 非空 title·description·tags',
    (path) => {
      const concept = conceptOf(path)
      expect(concept.fields.shuvix).toBe(KNOWLEDGE_MARKER)
      expect(concept.type).toBe(GUIDE_TYPE)
      expect(concept.status).toBe(GUIDE_STATUS)
      expect(concept.title.trim()).not.toBe('')
      expect(concept.description.trim()).not.toBe('')
      expect(concept.tags.length).toBeGreaterThan(0)
    }
  )

  it.each(paths)('BK-4 %s 不带机器署名：没有 generated、没有 verified', (path) => {
    const concept = conceptOf(path)
    expect(concept.generated).toBeUndefined()
    expect(concept.verified).toEqual([])
    // frontmatter 原文里也不许有这两个键：写坏的 `generated` 会被归一成 undefined，
    // 只查归一后的值查不出「写了但写坏了」
    expect(
      Object.keys(concept.fields).filter((k) => k === 'generated' || k === 'verified')
    ).toEqual([])
  })

  it.each(paths)('BK-5 %s sources 非空，每条 resource 都是仓库里的 blob 链接', (path) => {
    const concept = conceptOf(path)
    expect(concept.sources.length).toBeGreaterThan(0)
    const malformed = concept.sources
      .map((s) => s.resource)
      .filter((r) => !r.startsWith(SOURCE_PREFIX) || r.length === SOURCE_PREFIX.length)
    expect(malformed).toEqual([])
  })

  it.each(paths)('BK-6 %s 引用的解析器真的在：每条 resource 的仓库内路径存在', (path) => {
    // 钉的是「说明书跟着解析器搬家」：文件或目录都算（有几条指向 md 目录整体）
    const missing = conceptOf(path)
      .sources.map((s) => s.resource.slice(SOURCE_PREFIX.length))
      .filter((rel) => !existsSync(join(REPO_ROOT, rel)))
    expect(missing).toEqual([])
  })

  /**
   * BK-8 键漂移守护，**只钉一个方向**：解析器导出的键 → 对应那篇 Guide 的正文提到它。
   * 反方向（正文里的每个 `shuvix-*` 都得是解析器认的键）**刻意不钉** —— 正文有意提到一批已退役的键
   * （`shuvix-dispatch-only` / `shuvix-session-awareness` / `shuvix-project-prompt` /
   * `shuvix-project-memory` / `shuvix-prompt-sections` / `shuvix-bot-pipeline`）与条目名
   * `shuvix-files`，钉反方向就得维护白名单，而白名单本身就是下一次假红的来源。
   */
  const AGENT_KEY_GUIDE = [
    // agent 解析器（agentProfile/definitionFile.ts）把这些键写成内联字面量，没有导出常量可引，
    // 所以这里退而求其次写字面量；改名时这里不会自动红 —— 改 definitionFile 的键请同步这张表。
    'shuvix-tools',
    'shuvix-model',
    'shuvix-displayName',
    'shuvix-instruction-files',
    'shuvix-project-awareness'
  ]
  const KEY_GUIDES: [file: string, keys: readonly string[]][] = [
    ['hook-md.md', [HOOK_ON_KEY, HOOK_AGENT_KEY]],
    ['policy-md.md', [POLICY_RULES_KEY, POLICY_LETS_KEY, POLICY_SCOPE_KEY]],
    ['agent-md.md', AGENT_KEY_GUIDE],
    ['bot-md.md', [BOT_RETIRED_PIPELINE_KEY]]
  ]

  it.each(KEY_GUIDES.flatMap(([file, keys]) => keys.map((key): [string, string] => [file, key])))(
    'BK-8 %s 正文提到解析器的键 `%s`',
    (file, key) => {
      // 查的是正文而不是全文：frontmatter 里的 tags 蒙混不过去
      expect(conceptOf(file).body).toContain(key)
    }
  )

  /**
   * BK-9..BK-11 —— 2026-09-17 起检索是**两步走**（设计附录 Q）：`search` 只回答「哪几条可能相关」，
   * 正文由 `read` 取，找字面串用 `grep`。说明书是 agent 读完之后照着做的那一份，所以这三件事必须
   * 都写在里面，而且写在**同一段**里 —— 拆开写就等于让模型自己拼。
   */
  const ENTRY_GUIDE = 'knowledge-entry.md'
  /**
   * 讲检索那一段里指认索引面的五个词。en 就是键名本身，ja / zh 是本地化的说法（说明书是给人读的，
   * 不是键名表）—— 所以这张表得手维护：改了措辞请同步，这里不会自动红。
   */
  const FACE_TERMS: Record<string, readonly string[]> = {
    en: ['title', 'description', 'tags', 'type', 'headings'],
    ja: ['タイトル', '説明', 'タグ', 'type', '見出し行'],
    zh: ['标题', '描述', '标签', 'type', '标题行']
  }
  /** 正文按空行切段 */
  const paragraphs = (body: string): string[] =>
    body
      .split(/\n[ \t]*\n/)
      .map((p) => p.trim())
      .filter(Boolean)

  it(`BK-9 ${ENTRY_GUIDE} 教两步走：search / read / grep 三个动作词都出现`, () => {
    const body = conceptOf(ENTRY_GUIDE).body
    for (const verb of ['search', 'read', 'grep']) {
      expect(body, verb).toContain(`\`${verb}\``)
    }
  })

  it(`BK-10 ${ENTRY_GUIDE} 点名索引面：四个键名与「标题行」都在讲检索的同一段里`, () => {
    // 讲检索的那一段 = 提到 `grep` 的那一段（BK-11 钉住它只有一段）
    const [retrieval] = paragraphs(conceptOf(ENTRY_GUIDE).body).filter((p) => p.includes('`grep`'))
    expect(retrieval).toBeDefined()
    expect(retrieval).toContain('`search`')
    for (const term of FACE_TERMS[lang]) {
      expect(retrieval, term).toContain(term)
    }
  })

  it(`BK-11 ${ENTRY_GUIDE} 里 grep 只出现在讲检索的那一段：含它的段落必同时含 read`, () => {
    const withGrep = paragraphs(conceptOf(ENTRY_GUIDE).body).filter((p) => p.includes('`grep`'))
    expect(withGrep).toHaveLength(1)
    // 两步走的两半必须挨在一起：grep 是「索引里没有散文」的出口，read 是第二步本身
    expect(withGrep[0]).toContain('`read`')
  })

  /**
   * BK-12 索引面只有门面 + 正文标题行，所以一份没有任何 ATX 标题的说明书在库里只剩 title /
   * description / tags 可搜 —— 说明书恰恰是最该被搜到的那一批。
   */
  it.each(paths)('BK-12 %s 正文里至少有一个 ATX 标题（否则新索引里只剩门面可搜）', (path) => {
    expect(headingsOf(conceptOf(path).body).length).toBeGreaterThan(0)
  })

  /**
   * BK-13 / BK-14 —— 说明书里抄着两份「内置档案的工具清单」事实：work / chat / coding 共用的那份
   * 清单原文，以及「哪几个档案点了作图技能的名」。档案 md 一改（加一个工具、多一个档案点名），
   * 说明书不跟就是在教用户一份过期的清单 —— 事实源是同语言的内置档案本身（运行时读的同一批 md）。
   */
  const profilesOf = (): ReturnType<typeof buildBuiltinProfiles> =>
    buildBuiltinProfiles({
      language: lang,
      widgetsRoot: '/w/widgets',
      readMd: createInlineMdReader()
    })

  it('BK-13 agent-md.md 里那份以 `bash,` 开头的清单 = 同语言 work / chat / coding 的 shuvix-tools', () => {
    const body = conceptOf('agent-md.md').body
    const match = /`(bash,[^`]*)`/.exec(body)
    expect(match, '正文里找不到以 `bash,` 开头的清单').not.toBeNull()
    // 清单在正文里会折行：空白一律压成一个空格再按「, 」切
    const listed = match![1].replace(/\s+/g, ' ').trim().split(', ')
    const profiles = profilesOf()
    for (const name of ['work', 'chat', 'coding']) {
      const profile = profiles.find((p) => p.name === name)
      expect(profile, `${name}.${lang} 应当存在`).toBeDefined()
      expect(listed, `${name}.${lang}`).toEqual(profile!.tools)
    }
  })

  it('BK-14 skills.md 恰有一段提到 builtin:drawing，那段点名的内置档案 = 声明了 skill:builtin:drawing 的档案', () => {
    const withDrawing = paragraphs(conceptOf('skills.md').body).filter((p) =>
      p.includes('builtin:drawing')
    )
    expect(withDrawing).toHaveLength(1)
    const profiles = profilesOf()
    const builtinNames = new Set(profiles.map((p) => p.name))
    // 那段里用反引号圈出来、且恰是某个内置档案名的那些
    const named = [...withDrawing[0].matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((token) => builtinNames.has(token))
    const declaring = profiles
      .filter((p) => p.tools.includes('skill:builtin:drawing'))
      .map((p) => p.name)
    expect(declaring.length, '语料自检：应当有档案点了作图技能').toBeGreaterThan(0)
    expect([...new Set(named)].sort()).toEqual([...declaring].sort())
  })

  /**
   * BK-15 / BK-16 —— 浏览器、ssh 与数据库改成按会话勾选的内置 MCP 能力服务器（`mcp:browser` /
   * `mcp:ssh` / `mcp:database`）之后，说明书里跟着变的两处事实：agent-md.md 里「内置工具名」那一条不再列
   * `browser` / `ssh` / `database`、并点名三台内置 server；bot-md.md 抄的 bot 基座工具清单与 bot 档案的
   * shuvix-tools 一致、并说明三台 server 都没被声明（用户仍可在会话里勾上）。
   */
  /** 列表项：`- ` 开头的一行 + 其后缩进的续行（续行之外的段落不算这一条） */
  const bulletsOf = (body: string): string[] => {
    const out: string[] = []
    let current: string[] | null = null
    for (const line of body.split('\n')) {
      if (line.startsWith('- ')) {
        if (current) out.push(current.join('\n'))
        current = [line]
      } else if (current && /^ {2,}\S/.test(line)) {
        current.push(line)
      } else {
        if (current) out.push(current.join('\n'))
        current = null
      }
    }
    if (current) out.push(current.join('\n'))
    return out
  }
  /** 现役的内置工具名（agent md 里能写的那一批；`agent` 是派发开关，单独一条） */
  const BUILTIN_TOOL_NAMES = [
    'bash',
    'powershell',
    'read',
    'write',
    'edit',
    'ls',
    'glob',
    'grep',
    'ask',
    'git',
    'session',
    'knowledge',
    'artifact'
  ]

  it('BK-15 agent-md.md「内置工具名」那一条列的恰是现役内置工具（没有 browser / ssh / database），全文点名三台内置 server', () => {
    const body = conceptOf('agent-md.md').body
    const toolBullets = bulletsOf(body).filter((b) => b.includes('`bash`'))
    expect(toolBullets, '应当恰有一条列表项列出内置工具名').toHaveLength(1)
    const names = [...toolBullets[0].matchAll(/`([^`]+)`/g)].map((m) => m[1])
    expect([...new Set(names)].sort()).toEqual([...BUILTIN_TOOL_NAMES].sort())
    expect(body).toContain('`mcp:browser`')
    expect(body).toContain('`mcp:ssh`')
    expect(body).toContain('`mcp:database`')
  })

  it('BK-16 bot-md.md 抄的 bot 基座工具清单 = 同语言 bot 档案的 shuvix-tools（按集合比），并点名三台内置 server', () => {
    const body = conceptOf('bot-md.md').body
    const match = /`(read,[^`]*)`/.exec(body)
    expect(match, '正文里找不到以 `read,` 开头的清单').not.toBeNull()
    // 清单在正文里会折行：空白一律压成一个空格再按「, 」切
    const listed = match![1].replace(/\s+/g, ' ').trim().split(', ')
    const bot = profilesOf().find((p) => p.name === 'bot')
    expect(bot, `bot.${lang} 应当存在`).toBeDefined()
    expect([...new Set(listed)].sort()).toEqual([...new Set(bot!.tools)].sort())
    expect(body).toContain('`mcp:ssh`')
    expect(body).toContain('`mcp:browser`')
    expect(body).toContain('`mcp:database`')
  })
})
