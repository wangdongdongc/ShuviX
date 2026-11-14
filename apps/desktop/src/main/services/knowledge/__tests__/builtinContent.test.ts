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
 *
 * BK-26 反过来守笔记本提示词那一头：`document` 提示词块里的种类说明（agent-runtime `renderDocumentKind`）按文件种类
 * 指向说明书里的某几篇，用的是这里的真实目录 —— 说明书改了文件名而片段没跟上，这里先红。
 *
 * BK-27 / BK-28 守 bot 定时运行的权限核对（设计稿 docs/bot-access-check-design.md）在说明书里的那两处：policy-md
 * 「放宽与收紧」里给一个 bot 配的配套策略模板（三语的判定字段逐字相同、每条规则都是带三个条件的 force-allow、
 * 拿真实引擎核对恰是它说的样子），以及 bot-md「定时运行与权限」一节讲到 force-allow、daily-bot-access、根 agent
 * 的条件与 `shuvix policy check [<file>] --bot`。
 *
 * BK-29..BK-40 守 bot-md「替用户新建 bot」那一节的完整示例（`recap` bot + `recap-access` 策略，2026-11-02）：agent 会
 * 照抄这两份文件，所以这里拿真解析器、真排期、真引擎核对它们恰是说明书说的样子，且三语只差人读的话。BK-41 不做
 * （示例刻意用 `==`，Windows 原生路径另有散文给替代写法）。BK-42 守 shuvix-files 那句「`write` 会建目录」。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  botAccessNote,
  botIdentitiesNamedBy,
  botScheduleNote,
  buildBuiltinPolicies,
  buildBuiltinProfiles,
  createSecurityContext,
  parseBotDefinitionFile,
  parsePolicyDefinitionFile,
  policyNamesBot,
  previewTimerBinding,
  resolvePolicyFiles,
  reviewShuvixMdWrite,
  type ParsedBotFile,
  type ParsedPolicyFile,
  type PolicyRuleSpec,
  headingsOf,
  renderDocumentKind,
  validateBundleFiles,
  HOOK_ON_KEY,
  HOOK_AGENT_KEY,
  BOT_RETIRED_PIPELINE_KEY,
  POLICY_RULES_KEY,
  POLICY_LETS_KEY,
  POLICY_SCOPE_KEY,
  BUILTIN_POLICY_SPECS,
  BUILTIN_BOT_SEEDS,
  BUILTIN_PROFILE_SPECS,
  BUILTIN_HOOK_SPECS,
  type BundleFile,
  type KnowledgeConcept
} from '@shuvix/agent-runtime'
import { createInlineMdReader } from '@shuvix/agent-runtime/builtinAgents/inlineSources'
import { createInlinePolicyMdReader } from '@shuvix/agent-runtime/security/builtinPolicies/inlineSources'
import {
  KNOWLEDGE_BUILTIN_BASE,
  KNOWLEDGE_MARKER,
  type KnowledgeType,
  type OkfStatus
} from '@shuvix/chat-protocol/knowledge'
import { SELECTABLE_THINKING_LEVELS } from '@shuvix/chat-protocol/types/thinking'
import { AGENT_PROMPT_BLOCKS_KEY } from '@shuvix/chat-protocol/agentPromptBlocks'
import { parseObjectId } from '@shuvix/chat-protocol/mdMeta'
import type { ShuvixFileKind } from '@shuvix/chat-protocol/shuvixFileNotes'
import enLocale from '@shuvix/chat-protocol/i18n/locales/en.json'
import jaLocale from '@shuvix/chat-protocol/i18n/locales/ja.json'
import zhLocale from '@shuvix/chat-protocol/i18n/locales/zh.json'
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

/** 判定字段（剥掉人读的 prompt / description / body）—— 三语只该差人读的话 */
const machine = (p: ParsedPolicyFile): Record<string, unknown> => ({
  name: p.name,
  scope: p.scope,
  lets: p.lets,
  rules: p.rules.map(({ prompt: _prompt, ...rest }: PolicyRuleSpec) => rest)
})

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
    'shuvix-thinking',
    'shuvix-displayName',
    AGENT_PROMPT_BLOCKS_KEY
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
   * 正文由 `read` 取。说明书是 agent 读完之后照着做的那一份，所以两步必须写在**同一段**里 —— 拆开写就
   * 等于让模型自己拼。2026-11-08 起 `read` 是 knowledge 工具的动作（按条目名），库目录只有知识库管理员知道：
   * 「用 `grep` 在库目录里找字面串」那句退役，`grep` 只出现在管理员的文件工具清单里。
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

  it(`BK-9 ${ENTRY_GUIDE} 教两步走：search / read 两个动作词都出现`, () => {
    const body = conceptOf(ENTRY_GUIDE).body
    for (const verb of ['search', 'read']) {
      expect(body, verb).toContain(`\`${verb}\``)
    }
  })

  it(`BK-10 ${ENTRY_GUIDE} 点名索引面：四个键名与「标题行」和 search / read 两步都在讲检索的同一段里`, () => {
    // 讲检索的那一段 = 同时点名 `search` 与五个索引面词的那一段
    const retrieval = paragraphs(conceptOf(ENTRY_GUIDE).body).filter(
      (p) => p.includes('`search`') && FACE_TERMS[lang].every((term) => p.includes(term))
    )
    expect(retrieval).toHaveLength(1)
    // 两步走的两半必须挨在一起：read 是第二步本身
    expect(retrieval[0]).toContain('`read`')
  })

  it(`BK-11 ${ENTRY_GUIDE} 不再教 agent 去 grep 库目录：grep 只出现在管理员的文件工具清单里`, () => {
    const withGrep = paragraphs(conceptOf(ENTRY_GUIDE).body).filter((p) => p.includes('`grep`'))
    expect(withGrep).toHaveLength(1)
    // 那一段是管理员的工具清单：同段列着 move / delete
    expect(withGrep[0]).toContain('`move`')
    expect(withGrep[0]).toContain('`delete`')
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
   * 清单原文，以及「哪几个档案带技能工具」（作图技能就在它们的货架上）。档案 md 一改（加一个工具、多一个档案带它），
   * 说明书不跟就是在教用户一份过期的清单 —— 事实源是同语言的内置档案本身（运行时读的同一批 md）。
   */
  const profilesOf = (): ReturnType<typeof buildBuiltinProfiles> =>
    buildBuiltinProfiles({
      language: lang,
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

  it('BK-14 skills.md 恰有一段提到 builtin:drawing，那段点名的内置档案 = shuvix-tools 里带 `skill` 的档案', () => {
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
    const declaring = profiles.filter((p) => p.tools.includes('skill')).map((p) => p.name)
    expect(declaring.length, '语料自检：应当有档案带技能工具').toBeGreaterThan(0)
    expect([...new Set(named)].sort()).toEqual([...declaring].sort())
  })

  /**
   * BK-15 / BK-16 —— 浏览器、ssh 与数据库改成按会话勾选的内置 MCP 能力服务器（`mcp:browser` /
   * `mcp:ssh` / `mcp:database`）之后，说明书里跟着变的两处事实：agent-md.md 里「内置工具名」那一条不再列
   * `browser` / `ssh` / `database`、并点名三台内置 server；bot-md.md 抄的 bot 基座工具清单与 bot 档案的
   * shuvix-tools 一致、并说明三台 server 都没被声明（用户仍可在会话里勾上）。
   */
  /** 现役的内置工具名（agent md 里能写的那一批；`agent` 是派发开关，单独一条） */
  const BUILTIN_TOOL_NAMES = [
    'bash',
    'powershell',
    'read',
    'write',
    'edit',
    'move',
    'delete',
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

  /**
   * BK-17 —— `shuvix-thinking` 的合法值是一份共享清单（`SELECTABLE_THINKING_LEVELS`：选择器、解析器、
   * 属性卡共用）。说明书的字段表抄着这份清单：解析器多收一档而说明书没跟上，用户照着写就写不出来；
   * 少收一档而说明书还列着，照着写就是一份非法文件。循环常量，清单改了这里跟着红。
   */
  it('BK-17 agent-md.md 字段表里 `shuvix-thinking` 那一行逐一列出每个可选档位', () => {
    const rows = conceptOf('agent-md.md')
      .body.split('\n')
      .filter((line) => line.trimStart().startsWith('|') && line.includes('`shuvix-thinking`'))
    expect(rows, '字段表里应当恰有一行讲 shuvix-thinking').toHaveLength(1)
    for (const level of SELECTABLE_THINKING_LEVELS) {
      expect(rows[0], level).toContain(`\`${level}\``)
    }
  })
  /**
   * BK-18 / BK-19 —— policy-md.md 抄着两份事实：内置策略的清单（名字 + 份数）与宿主变量表。
   * 策略删了几份（2026-09-30 删了 ask-on-read，2026-10-01 只剩 ask-on-external-path / ask-on-command）、
   * 变量表退役了一批（沙箱的 sandbox* 与工作区的 workspaceWritable 等，换成 sessionDirs）时说明书不跟，
   * 就是在教用户去覆盖一份不存在的策略、引用一个永远没值的变量。
   * 事实源：BUILTIN_POLICY_SPECS，以及内置策略自己的规则（它们引用的每个 `vars.x` 都得在表里）。
   */
  const POLICY_SECTION_HEADING: Record<string, string> = {
    en: '## Builtin policies',
    zh: '## 内置策略',
    ja: '## 組み込みポリシー'
  }
  /** 内置策略份数在正文里的写法（份数一变这张表先红，提醒把说明书的那个数一起改） */
  const POLICY_COUNT_WORD: Record<number, Record<string, string>> = {
    2: { en: 'Two', zh: '两', ja: '二' },
    3: { en: 'Three', zh: '三', ja: '三' },
    4: { en: 'Four', zh: '四', ja: '四' },
    5: { en: 'Five', zh: '五', ja: '五' },
    6: { en: 'Six', zh: '六', ja: '六' },
    7: { en: 'Seven', zh: '七', ja: '七' },
    8: { en: 'Eight', zh: '八', ja: '八' },
    9: { en: 'Nine', zh: '九', ja: '九' },
    10: { en: 'Ten', zh: '十', ja: '十' }
  }

  /** 从某个标题起、到下一个同级或更高标题为止的那一段 */
  const sectionFrom = (body: string, heading: string): string => {
    const lines = body.split('\n')
    const start = lines.findIndex((l) => l.trim() === heading || l.startsWith(`${heading} `))
    expect(start, `${lang}: 找不到标题 ${heading}`).toBeGreaterThanOrEqual(0)
    const level = heading.match(/^#+/)![0].length
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((l) => {
      const m = /^(#+) /.exec(l)
      return m !== null && m[1].length <= level
    })
    return (end < 0 ? rest : rest.slice(0, end)).join('\n')
  }

  /** 表格行第一格里用反引号圈出来的名字（一格里有两个名字的，两个都算） */
  const firstCellNames = (section: string): string[] =>
    section
      .split('\n')
      .filter((l) => l.startsWith('| `'))
      .flatMap((l) => [...l.split('|')[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]))

  it('BK-18 policy-md.md「内置策略」那张表列的恰是 BUILTIN_POLICY_SPECS（没有 ask-on-read），开头那句的份数也对', () => {
    const section = sectionFrom(conceptOf('policy-md.md').body, POLICY_SECTION_HEADING[lang])
    const listed = firstCellNames(section)
    const expected = BUILTIN_POLICY_SPECS.map((s) => s.name)
    expect(new Set(listed).size, `${lang}: 表里有重复的行`).toBe(listed.length)
    expect([...listed].sort()).toEqual([...expected].sort())
    expect(listed).not.toContain('ask-on-read')

    const word = POLICY_COUNT_WORD[BUILTIN_POLICY_SPECS.length]?.[lang]
    expect(
      word,
      `份数 ${BUILTIN_POLICY_SPECS.length} 在 ${lang} 里怎么写？补 POLICY_COUNT_WORD`
    ).toBeDefined()
    const intro = section.split('\n| ')[0]
    expect(intro, `${lang}: 表格前那句应当写 ${word}`).toContain(word!)
  })

  /** 2026-10-01 起宿主不再给策略的沙箱 / 工作区派生变量：正文里一个都不该再出现 */
  const RETIRED_VARS =
    /\b(sandbox(Active|WritableRoots|WriteDenied|ProtectedPatterns|ReadDenied|ReadAllowed)|workspace(Writable|WriteDenied|ProtectedPatterns))\b/

  it('BK-19 policy-md.md 变量表收齐内置策略引用的每个 vars.x，且没有已退役的 sandbox* / workspace* 派生变量', () => {
    const body = conceptOf('policy-md.md').body
    const listed = firstCellNames(sectionFrom(body, '### `vars`'))
    // 事实源是规则本身（match 与 lets），不是手抄的一张表：内置策略改引用一个新变量，这里先红
    const referenced = new Set(
      buildBuiltinPolicies({ language: lang, readMd: createInlinePolicyMdReader() }).flatMap(
        (policy) =>
          [...policy.rules.map((rule) => rule.match ?? ''), ...Object.values(policy.lets ?? {})]
            .flatMap((expr) => [...expr.matchAll(/\bvars\.(\w+)/g)])
            .map((m) => m[1])
      )
    )
    expect(referenced.size, '语料自检：内置策略应当引用了宿主变量').toBeGreaterThan(0)
    expect([...referenced].filter((name) => !listed.includes(name))).toEqual([])
    expect(listed.filter((name) => name.startsWith('sandbox') || /^workspace./.test(name))).toEqual(
      []
    )
    expect(body).not.toMatch(RETIRED_VARS)
  })
  /**
   * 对象 id（`shuvix-id`，md 扩展元数据只认它）：四类文件的说明书各在字段表里有它的一行，总览页提到它；
   * 正文里举的每一个具体内置 id（如 `agent:builtin:explore`）都是合法 id、且点名的内置真实存在 ——
   * 说明书举一个不存在的内置当例子，用户照着找会扑空。占位写法（`<type>:builtin:<name>`）与
   * 非对象类型的 `skill:builtin:<name>` 不在此列。
   */
  it.each(['agent-md.md', 'bot-md.md', 'hook-md.md', 'policy-md.md'])(
    'BK-20 %s 的字段表有 `shuvix-id` 那一行',
    (path) => {
      const rows = conceptOf(path)
        .body.split('\n')
        .filter((line) => /^\|\s*`shuvix-id`\s*\|/.test(line))
      expect(rows, `${lang}/${path}`).toHaveLength(1)
    }
  )

  it('BK-21 shuvix-files.md 讲到 shuvix-id；全库正文里举的具体内置 id 都合法、点名的内置都存在', () => {
    expect(conceptOf('shuvix-files.md').body).toContain('`shuvix-id`')

    const known: Record<string, Set<string>> = {
      agent: new Set(BUILTIN_PROFILE_SPECS.map((s) => s.name)),
      hook: new Set(BUILTIN_HOOK_SPECS.map((s) => s.name)),
      policy: new Set(BUILTIN_POLICY_SPECS.map((s) => s.name)),
      // 随应用提供的 bot（第一次启动时写进用户目录的那几份，今天只有 daily）
      bot: new Set(BUILTIN_BOT_SEEDS.map((s) => s.name))
    }
    const examples = files.flatMap((f) =>
      [...f.text.matchAll(/`((?:agent|bot|hook|policy):builtin:[^`<][^`]*)`/g)].map((m) => [
        f.path,
        m[1]
      ])
    )
    expect(examples.length, `${lang}: 语料自检 —— 说明书里应当至少举了一个内置 id`).toBeGreaterThan(
      0
    )
    for (const [path, example] of examples) {
      const parsed = parseObjectId(example)
      expect(parsed, `${lang}/${path}: ${example}`).not.toBeNull()
      expect(parsed!.form, `${lang}/${path}: ${example}`).toBe('builtin')
      if (parsed!.form === 'builtin') {
        expect(known[parsed!.kind].has(parsed!.name), `${lang}/${path}: ${example}`).toBe(true)
      }
    }
  })
  /**
   * BK-22 停用开关（2026-10-10）：hook-md / policy-md 讲到它，用的是界面上那两个词（侧栏菜单的「禁用」=
   * common.disable、属性卡开关那一行 = notebook.frontmatter.metaEnabled）—— 说明书照着界面写，界面改了词这里先红；
   * agent-md 讲补缺值时用的名字是 metaTitle（那两行本身已不挂文字小标，只换样式），不再有「设置条」或「换新 id」
   */
  it('BK-22 hook-md / policy-md 用界面上的词讲停用开关；agent-md 不再讲设置条与换新 id', () => {
    const locale = { en: enLocale, ja: jaLocale, zh: zhLocale }[lang as 'en' | 'ja' | 'zh']
    expect(locale, lang).toBeDefined()
    for (const path of ['hook-md.md', 'policy-md.md']) {
      const body = conceptOf(path).body
      expect(body, `${lang}/${path}`).toContain(locale.common.disable)
      expect(body, `${lang}/${path}`).toContain(locale.notebook.frontmatter.metaEnabled)
    }
    const agent = conceptOf('agent-md.md').body
    expect(agent, `${lang}/agent-md.md`).toContain(locale.notebook.frontmatter.metaTitle)
    expect(agent, `${lang}/agent-md.md`).not.toMatch(/\bstrip\b|new id/i)
  })
  /**
   * BK-23 / BK-24 / BK-25 —— 权限审查员能 `read` 了（2026-10-12）：它读文件是为了判断被运行的脚本，它的读取
   * 从不问人（会询问的一律拒绝）。说明书抄着这两件事：hook-md「内置 hook」那段写审查员的工具清单，
   * `permission.request` 那节写判定型 hook 派出的 agent 的询问怎么处置；policy-md 讲自动审查时不再指向已删掉的
   * 设置项（设置 → 通用 → 安全，2026-10-08 删）。正文会折行：比对前把换行折掉（en 折成空格，zh / ja 直接拼上）。
   */
  const flat = (text: string): string => text.replace(/\s*\n\s*/g, lang === 'en' ? ' ' : '')
  /** 「审查员没有工具」的旧说法 */
  const NO_TOOLS: Record<string, string> = { en: 'no tools', zh: '没有工具', ja: 'ツールを持たず' }
  /** 指认「判定型 hook 派出的 agent」的说法、它「从不问人」、它的操作「被拒绝」、旧的「交给用户」 */
  const DECIDE_AGENT: Record<
    string,
    { who: string; never: string; refused: string; stale: string }
  > = {
    en: {
      who: 'agent dispatched by a decide hook',
      never: 'never asks anyone',
      refused: 'is refused',
      stale: 'straight to the user'
    },
    zh: {
      who: '判定型 hook 派出的 agent',
      never: '从不询问任何人',
      refused: '拒绝',
      stale: '直接交给用户'
    },
    ja: {
      who: '判定型 hook が派遣したエージェント',
      never: '誰にも確認を求めません',
      refused: '拒否',
      stale: 'そのままユーザーに渡る'
    }
  }

  it('BK-23 hook-md.md 讲 auto-review 的那段：反引号圈出的内置工具名（按集合）= 内置 permission-reviewer 档案的工具；不再说它没有工具', () => {
    const reviewer = profilesOf().find((p) => p.name === 'permission-reviewer')
    expect(reviewer, `permission-reviewer.${lang} 应当存在`).toBeDefined()
    expect(reviewer!.tools, '语料自检：审查员声明了工具').not.toEqual([])
    const withBoth = paragraphs(conceptOf('hook-md.md').body).filter(
      (p) => p.includes('`permission-reviewer`') && p.includes('`auto-review`')
    )
    expect(withBoth, '应当恰有一段同时点名 auto-review 与 permission-reviewer').toHaveLength(1)
    const named = [...withBoth[0].matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((token) => BUILTIN_TOOL_NAMES.includes(token))
    expect([...new Set(named)].sort()).toEqual([...new Set(reviewer!.tools)].sort())
    expect(flat(withBoth[0])).not.toContain(NO_TOOLS[lang])
  })

  it('BK-24 hook-md.md 的 `permission.request` 一节：判定型 hook 派出的 agent 的询问被拒绝、谁都不问，不再说交给用户', () => {
    const body = conceptOf('hook-md.md').body
    const start = body.indexOf('## `permission.request`')
    expect(start, '找不到 `permission.request` 一节').toBeGreaterThanOrEqual(0)
    const rest = body.slice(start + 3)
    const end = rest.search(/^## /m)
    const section = end < 0 ? rest : rest.slice(0, end)
    const phrases = DECIDE_AGENT[lang]
    const hits = paragraphs(section)
      .map(flat)
      .filter((p) => p.includes(phrases.who))
    expect(hits, `应当恰有一段讲「${phrases.who}」`).toHaveLength(1)
    // 从点名它的地方起往后读（同段前面讲 deny 的那句也有「拒绝」，不算）
    const tail = hits[0].slice(hits[0].indexOf(phrases.who))
    expect(tail).toContain(phrases.never)
    expect(tail).toContain(phrases.refused)
    // 旧说法「它自己的询问交给用户」（同一节别处讲「连续被拒之后交给用户」的那条不算）
    expect(tail).not.toContain(phrases.stale)
  })

  it('BK-25 policy-md.md 讲自动审查：不再指向已删掉的「设置 → 通用 → 安全」，说的是停用内置 hook auto-review', () => {
    const body = flat(conceptOf('policy-md.md').body)
    const removed = { en: 'General → Security', zh: '通用 → 安全', ja: '一般 → セキュリティ' }[
      lang as 'en' | 'zh' | 'ja'
    ]
    expect(removed, lang).toBeDefined()
    expect(body).not.toContain(removed)
    expect(body).toContain('`auto-review`')
  })
})

describe('BK-26 笔记本提示词指向的说明书条目真的在', () => {
  /** 全部文件种类（Record：新增一个种类时这里先在类型上红） */
  const KINDS = Object.keys({
    agent: true,
    bot: true,
    policy: true,
    hook: true,
    skill: true,
    knowledge: true
  } satisfies Record<ShuvixFileKind, true>) as ShuvixFileKind[]

  it('BK-26 三语 × 六种文件：渲染里点名的每个说明书条目（`/name.md`）都在那门语言的说明书里；合起来至少点到 8 篇', () => {
    // 正控制组：三种语言都在（否则下面那圈只查了一部分）
    expect(LANGS).toEqual(EXPECTED_LANGS)
    const referenced = new Set<string>()
    for (const lang of LANGS) {
      const manualDir = join(BASE_DIR, lang)
      for (const kind of KINDS) {
        const out = renderDocumentKind(lang, { kind, manual: true, knowledge: true })
        // 2026-11-08 起按条目名点（经 knowledge 的 read，库 `shuvix`），目录不进提示词
        const entries = [...out.matchAll(/`\/([\w.-]+\.md)`/g)].map((m) => m[1])
        expect(entries.length, `${lang}/${kind} 一篇都没指到`).toBeGreaterThan(0)
        for (const entry of entries) {
          expect(existsSync(join(manualDir, entry)), `${lang}/${kind} 指向不存在的 /${entry}`).toBe(
            true
          )
          referenced.add(entry)
        }
      }
    }
    // agent / bot / policy（含远程访问、自动脱敏）/ hook / skills / knowledge-entry
    expect(referenced.size).toBeGreaterThanOrEqual(8)
  })
})

describe('BK-27 policy-md 里给一个 bot 配的配套策略模板', () => {
  /** 某种语言 policy-md.md 里那份模板（```markdown 块里带 `name: xiaozhou-access` 的那一块）解析出的策略 */
  const templateOf = (lang: string): ParsedPolicyFile => {
    const md = readFileSync(join(BASE_DIR, lang, 'policy-md.md'), 'utf8')
    const block = [...md.matchAll(/```markdown\n([\s\S]*?)```/g)]
      .map((m) => m[1])
      .find((b) => b.includes('name: xiaozhou-access'))
    expect(block, `${lang}/policy-md.md 没有 xiaozhou-access 模板`).toBeDefined()
    const reasons: string[] = []
    const parsed = parsePolicyDefinitionFile(block!, 'xiaozhou-access', (m) => reasons.push(m))
    expect(reasons, lang).toEqual([])
    expect(parsed, lang).not.toBeNull()
    return parsed!
  }
  it.each(EXPECTED_LANGS)(
    'BK-27 %s：解析得过；每条规则都是 force-allow，带 has(subject.bot)、身份与根 agent 三个条件',
    (lang) => {
      const template = templateOf(lang)
      expect(template.rules.length).toBeGreaterThan(0)
      for (const rule of template.rules) {
        expect(rule.effect).toBe('force-allow')
        expect(rule.match).toContain('has(subject.bot)')
        expect(rule.match).toContain("subject.bot == '")
        expect(rule.match).toContain("subject.agentKind == 'root'")
      }
      expect(policyNamesBot(template, 'xiaozhou')).toBe(true)
    }
  )

  it('BK-27 三语的判定字段逐字相同', () => {
    const [first, ...rest] = EXPECTED_LANGS.map((lang) => ({
      lang,
      fields: machine(templateOf(lang))
    }))
    for (const other of rest) {
      expect({ lang: other.lang, fields: other.fields }).toEqual({
        lang: other.lang,
        fields: first.fields
      })
    }
  })

  it.each(EXPECTED_LANGS)(
    'BK-27 %s：拿真实引擎核对 —— 会话读放行、发消息会停、那份笔记读写放行，没有更宽的',
    (lang) => {
      const READ_MD = createInlinePolicyMdReader()
      const HOME = '/Users/u'
      const WORKDIR = '/Users/u/work/tiny-cli'
      const BOT_FILE = '/Users/u/.shuvix/bots/xiaozhou.md'
      const user = { ...templateOf(lang), fileName: 'xiaozhou-access.md' }
      const vars = {
        home: HOME,
        workspace: WORKDIR,
        aclRead: [WORKDIR, BOT_FILE],
        aclWrite: [WORKDIR, BOT_FILE],
        aclSessionRead: [],
        aclSessionWrite: [],
        aclWidgetRead: [],
        aclWidgetWrite: [],
        now: '2026-10-31T10:00:00.000Z',
        dailyDir: '/Users/u/.shuvix/daily'
      }
      const warnings: string[] = []
      const context = createSecurityContext(
        {
          kind: 'agent',
          sessionId: '',
          agentKind: 'root',
          profileName: 'bot',
          attrs: { bot: 'xiaozhou' }
        },
        { host: 'desktop' },
        {
          host: 'desktop',
          pathSep: '/',
          getVars: () => vars,
          readBuiltinPolicyMd: READ_MD,
          getUserPolicies: () => [user],
          logger: {
            info: () => {},
            warn: (m) => void warnings.push(m),
            error: (m) => void warnings.push(m)
          }
        }
      )
      const naming = resolvePolicyFiles(buildBuiltinPolicies({ readMd: READ_MD }), [user])
        .filter((e) => !e.shadowedBy)
        .map((e) => e.policy)
        .filter((p) => policyNamesBot(p, 'xiaozhou'))
      const note = botAccessNote({
        botName: 'xiaozhou',
        identity: 'xiaozhou',
        identityFrom: 'name',
        naming,
        locations: [
          {
            label: 'a temporary folder',
            vars,
            judge: (action, object, tool) => context.judgeGate(action, object, { tool })
          }
        ],
        reviewActive: true,
        host: { home: HOME, root: '/', sep: '/', vars, isDirectory: () => false },
        policiesDirLabel: '~/.shuvix/policies/',
        now: new Date('2026-10-31T10:00:00.000Z'),
        warnings: () => warnings
      })
      const lines = note.split('\n')
      expect(lines).toContain('- read other sessions: allowed (xiaozhou-access).')
      expect(lines).toContain(
        '- send messages into other sessions: asks (ask-on-session-access; only the user can answer, so the run would stop).'
      )
      expect(lines).toContain(
        '- ~/notes/daily-summary.md: read and write allowed (xiaozhou-access).'
      )
      expect(note).toContain('Policies that name it: xiaozhou-access.')
      expect(note).not.toContain('also allowed')
      expect(note).not.toContain('plain `allow`')
      expect(note).not.toContain('companion policy')
      expect(note).not.toContain('Some rules failed')
    }
  )
})

describe.each(LANGS)('BK-28 bot-md「定时运行与权限」 · %s', (lang) => {
  const HEADINGS: Record<string, string> = {
    en: '### Scheduled runs and access',
    zh: '### 定时运行与权限',
    ja: '### 定時実行と権限'
  }

  it('BK-28 那一节讲到 force-allow、daily-bot-access、根 agent 的条件与 `shuvix policy check [<file>] --bot`', () => {
    const heading = HEADINGS[lang]
    expect(heading, lang).toBeDefined()
    const md = readFileSync(join(BASE_DIR, lang, 'bot-md.md'), 'utf8')
    const all = md.split('\n')
    const start = all.indexOf(heading)
    expect(start, `${lang}/bot-md.md 没有「${heading}」`).toBeGreaterThanOrEqual(0)
    // 一节到下一个同级或更高的标题为止（代码块里的行不算标题）
    let fenced = false
    let end = all.length
    for (let i = start + 1; i < all.length; i++) {
      if (all[i].startsWith('```')) fenced = !fenced
      if (!fenced && /^#{1,3} /.test(all[i])) {
        end = i
        break
      }
    }
    const section = all.slice(start, end).join('\n')
    for (const needle of [
      'force-allow',
      'daily-bot-access',
      "subject.agentKind == 'root'",
      'shuvix policy check [<file>] --bot'
    ]) {
      expect(section, `${lang}: ${needle}`).toContain(needle)
    }
  })
})

/**
 * BK-29..BK-40 bot-md「替用户新建 bot」那一节的完整示例：`~/.shuvix/bots/recap.md` + `~/.shuvix/policies/recap-access.md`。
 * 找块要认 `/^name: recap$/m` —— `name: recap` 是 `recap-access` 的前缀。
 */
const RECAP_BOT = /^name: recap$/m
const RECAP_POLICY = /^name: recap-access$/m
const RECAP_SUMMARY = '~/notes/daily-summary.md'
const recapMd = (lang: string): string => readFileSync(join(BASE_DIR, lang, 'bot-md.md'), 'utf8')

/** 这一语言 bot-md.md 里所有 ```markdown 块（块里可以有 `## ` 标题，所以不能按标题切） */
const markdownBlocksOf = (md: string): string[] =>
  [...md.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1])

const recapBlock = (lang: string, pattern: RegExp): string => {
  const hits = markdownBlocksOf(recapMd(lang)).filter((block) => pattern.test(block))
  expect(hits, `${lang}/bot-md.md：${pattern} 应当恰有一块`).toHaveLength(1)
  return hits[0]
}

const parseRecapBot = (lang: string): ParsedBotFile => {
  const warnings: string[] = []
  const bot = parseBotDefinitionFile(recapBlock(lang, RECAP_BOT), 'recap', (m) => warnings.push(m))
  expect(warnings, lang).toEqual([])
  expect(bot, lang).not.toBeNull()
  return bot!
}

const parseRecapPolicy = (lang: string): ParsedPolicyFile => {
  const warnings: string[] = []
  const policy = parsePolicyDefinitionFile(recapBlock(lang, RECAP_POLICY), 'recap-access', (m) =>
    warnings.push(m)
  )
  expect(warnings, lang).toEqual([])
  expect(policy, lang).not.toBeNull()
  return policy!
}

/** 引擎核对用的固定时刻与家目录（BK-27 的夹具） */
const RECAP_NOW = '2026-06-10T10:00:00.000Z'
const RECAP_HOME = '/Users/u'
const RECAP_WORKDIR = '/Users/u/work/recap-run'
const RECAP_BOT_FILE = '/Users/u/.shuvix/bots/recap.md'
const RECAP_POLICY_FILE = '/Users/u/.shuvix/policies/recap-access.md'
const SUMMARY_PATH = '/Users/u/notes/daily-summary.md'
const HOUR = 3_600_000
const MINUTE = 60_000
const ago = (ms: number): string => new Date(Date.parse(RECAP_NOW) - ms).toISOString()

type SessionObjectShape = { type: string } & Record<string, string | boolean>
type PathObjectShape = { type: string; path: string; displayPath: string }

const sessionObject = (lastActiveAt: string): SessionObjectShape => ({
  type: 'session',
  sessionId: 'someone-else',
  title: '',
  ownTurn: false,
  lastActiveAt,
  bot: ''
})
const pathObject = (path: string): PathObjectShape => ({
  type: 'path',
  path,
  displayPath: path
})
const READ_SESSION = { name: 'session', operation: 'read-session' }
const RECAP_VARS = {
  home: RECAP_HOME,
  workspace: RECAP_WORKDIR,
  aclRead: [RECAP_WORKDIR, RECAP_BOT_FILE],
  aclWrite: [RECAP_WORKDIR, RECAP_BOT_FILE],
  aclSessionRead: [],
  aclSessionWrite: [],
  aclWidgetRead: [],
  aclWidgetWrite: [],
  now: RECAP_NOW,
  dailyDir: '/Users/u/.shuvix/daily'
}

interface RecapSubject {
  attrs?: Record<string, unknown>
  agentKind?: 'root' | 'spawned'
}

interface RecapContext {
  context: ReturnType<typeof createSecurityContext>
  vars: typeof RECAP_VARS
  warnings: string[]
  user: ParsedPolicyFile & { fileName: string }
  readMd: ReturnType<typeof createInlinePolicyMdReader>
}

/** 这一语言的 recap-access 装进真实引擎（内置策略 + 它）；`subject` 是这次运行的主体 */
const recapContext = (
  lang: string,
  subject: RecapSubject = { attrs: { bot: 'recap' } }
): RecapContext => {
  const readMd = createInlinePolicyMdReader()
  const user = { ...parseRecapPolicy(lang), fileName: 'recap-access.md' }
  const vars = RECAP_VARS
  const warnings: string[] = []
  const context = createSecurityContext(
    {
      kind: 'agent',
      sessionId: '',
      agentKind: subject.agentKind ?? 'root',
      profileName: 'bot',
      ...(subject.attrs ? { attrs: subject.attrs } : {})
    },
    { host: 'desktop' },
    {
      host: 'desktop',
      pathSep: '/',
      getVars: () => vars,
      readBuiltinPolicyMd: readMd,
      getUserPolicies: () => [user],
      logger: {
        info: () => {},
        warn: (m) => void warnings.push(m),
        error: (m) => void warnings.push(m)
      }
    }
  )
  return { context, vars, warnings, user, readMd }
}

describe.each(EXPECTED_LANGS)('BK-29..BK-33 bot-md 的完整示例 · %s', (lang) => {
  it('BK-29 两块各恰一处、在同一个 `## ` 节里；节里两个路径各排在自己那一块之前', () => {
    const botBlock = recapBlock(lang, RECAP_BOT)
    const policyBlock = recapBlock(lang, RECAP_POLICY)
    // 按 `## ` 切节要认代码块：bot 那一块里自己就有 `## ` 标题（同 BK-28 的循环）
    const sections: string[][] = [[]]
    let fenced = false
    for (const line of recapMd(lang).split('\n')) {
      if (line.startsWith('```')) fenced = !fenced
      if (!fenced && /^#{1,2} /.test(line)) sections.push([])
      sections[sections.length - 1].push(line)
    }
    const holding = sections
      .map((lines) => lines.join('\n'))
      .filter((text) => text.includes(botBlock) || text.includes(policyBlock))
    expect(holding, '两块应当落在同一节').toHaveLength(1)
    const section = holding[0]
    expect(section).toContain(botBlock)
    expect(section).toContain(policyBlock)

    const botPath = section.indexOf('~/.shuvix/bots/recap.md')
    const policyPath = section.indexOf('~/.shuvix/policies/recap-access.md')
    expect(botPath, '节里点名 bot 文件的路径').toBeGreaterThanOrEqual(0)
    expect(policyPath, '节里点名策略文件的路径').toBeGreaterThanOrEqual(0)
    expect(botPath).toBeLessThan(section.indexOf(botBlock))
    expect(policyPath).toBeLessThan(section.indexOf(policyBlock))
  })

  it('BK-30 bot 那一块解析得过：零警告、没有 objectId、一条 timer.fired 绑定（有 message、没有 project）、正文两个 `## ` 标题', () => {
    const bot = parseRecapBot(lang)
    expect(bot.name).toBe('recap')
    expect(bot.objectId).toBeUndefined()
    expect(bot.bindings).toHaveLength(1)
    const [binding] = bot.bindings!
    expect(binding.trigger).toBe('timer.fired')
    expect(binding.message.trim()).not.toBe('')
    expect(binding.project).toBeUndefined()
    expect(bot.body.split('\n').filter((line) => line.startsWith('## '))).toHaveLength(2)
  })

  it('BK-31 排期：14 天里每天 09:00 触发一次、七个星期几都有；此刻正好 09:00 时从明天起；回执里没有报错的话', () => {
    const { bindings } = parseRecapBot(lang)
    const when = bindings![0].when
    const before = previewTimerBinding(when, { now: new Date(2026, 5, 1, 8, 59, 30), limit: 100 })
    expect(before.kind).toBe('fires')
    if (before.kind !== 'fires') return
    expect(before.error).toBeUndefined()
    expect(before.at).toHaveLength(14)
    expect(before.at.every((hit) => hit.local.time === '09:00')).toBe(true)
    expect(before.at[0].local.date).toBe('2026-06-01')
    expect(before.at[13].local.date).toBe('2026-06-14')
    expect(new Set(before.at.map((hit) => hit.local.weekday)).size).toBe(7)

    const onTheDot = previewTimerBinding(when, { now: new Date(2026, 5, 1, 9, 0, 0), limit: 100 })
    expect(onTheDot.kind).toBe('fires')
    if (onTheDot.kind !== 'fires') return
    expect(onTheDot.at[0].local.date).toBe('2026-06-02')

    const note = botScheduleNote(bindings!, { now: new Date(2026, 5, 1, 8, 59, 30) })
    expect(note).toContain('09:00')
    for (const trouble of ['never fires', 'fails to evaluate', 'fires every minute']) {
      expect(note, trouble).not.toContain(trouble)
    }
  })

  it('BK-32 策略那一块解析得过：只有两条 force-allow（会话读 / 路径读写），每条都带三个条件、不按会话 id 选；点名的 bot 恰是 recap', () => {
    const policy = parseRecapPolicy(lang)
    expect(policy.name).toBe('recap-access')
    expect(policy.scope).toEqual({ 'subject.kind': ['agent'], 'env.host': ['desktop'] })
    expect(policy.lets).toBeUndefined()
    expect(policy.rules).toHaveLength(2)
    const [session, path] = policy.rules
    expect(session.conditions).toMatchObject({ 'object.type': ['session'], action: ['read'] })
    expect(path.conditions).toMatchObject({ 'object.type': ['path'], action: ['read', 'write'] })
    for (const rule of policy.rules) {
      expect(rule.effect).toBe('force-allow')
      expect(rule.disposition).toBeUndefined()
      expect(rule.match).toContain('has(subject.bot)')
      expect(rule.match).toContain("subject.bot == 'recap'")
      expect(rule.match).toContain("subject.agentKind == 'root'")
      // 按 id 选会话的规则盖不到以后每一次运行的会话（accessCheck 也会指出这一点）
      expect(rule.match).not.toContain('object.sessionId')
    }
    expect(botIdentitiesNamedBy(policy)).toEqual(['recap'])
  })

  it('BK-33 两份文件对得上：身份 = bot 的 name，策略名 = <bot>-access，那份笔记的路径处处是同一个（规则里拼出来的也是）', () => {
    const bot = parseRecapBot(lang)
    const policy = parseRecapPolicy(lang)
    expect(botIdentitiesNamedBy(policy)).toEqual([bot.name])
    expect(policy.name).toBe(`${bot.name}-access`)

    expect(bot.bindings![0].message).toContain(RECAP_SUMMARY)
    expect(bot.description).toContain(RECAP_SUMMARY)
    expect(policy.description).toContain(RECAP_SUMMARY)

    const literal = /vars\.home \+ '([^']+)'/.exec(policy.rules[1].match ?? '')?.[1]
    expect(`~${literal}`).toBe(RECAP_SUMMARY)
  })
})

describe('BK-34 完整示例的三语只差人读的话', () => {
  it('BK-34 策略的判定字段逐字相同，bot 的 name / trigger / when 逐字相同；message 三语各不相同（漏翻会露馅）', () => {
    const [firstLang, ...restLangs] = EXPECTED_LANGS
    const fieldsOf = (lang: string): Record<string, unknown> => {
      const bot = parseRecapBot(lang)
      const { trigger, when } = bot.bindings![0]
      return { policy: machine(parseRecapPolicy(lang)), name: bot.name, trigger, when }
    }
    const first = fieldsOf(firstLang)
    for (const lang of restLangs) {
      expect({ lang, fields: fieldsOf(lang) }).toEqual({ lang, fields: first })
    }
    const messages = EXPECTED_LANGS.map((lang) => parseRecapBot(lang).bindings![0].message)
    expect(new Set(messages).size).toBe(EXPECTED_LANGS.length)
  })
})

describe.each(EXPECTED_LANGS)('BK-35..BK-40 完整示例过真实引擎 · %s', (lang) => {
  it('BK-35 读会话看最后活跃的时刻：48 小时以内放行（recap-access#0，force-allow），恰好 48 小时及更早照旧询问', () => {
    const { context, warnings } = recapContext(lang)
    const read = (lastActiveAt: string): ReturnType<typeof context.judgeGate> =>
      context.judgeGate('read', sessionObject(lastActiveAt), { tool: READ_SESSION })

    for (const age of [0, 24 * HOUR, 33 * HOUR, 47 * HOUR + 59 * MINUTE]) {
      const verdict = read(ago(age))
      expect(verdict.allowed, `${age}ms`).toBe(true)
      expect(verdict.decision.winning, `${age}ms`).toBe('recap-access#0')
      expect(verdict.decision.tier, `${age}ms`).toBe('force-allow')
    }
    for (const lastActiveAt of [ago(48 * HOUR), ago(49 * HOUR), new Date(0).toISOString()]) {
      const verdict = read(lastActiveAt)
      expect(verdict.allowed, lastActiveAt).toBe(false)
      expect(verdict.decision.winning, lastActiveAt).toBe('ask-on-session-access#0')
    }
    expect(warnings).toEqual([])
  })

  it('BK-36 路径只放行那一份笔记（recap-access#1）；旁边的文件、前缀相同的、它底下的、家目录别处和策略文件自己都照旧询问', () => {
    const { context, warnings } = recapContext(lang)

    for (const [action, tool] of [
      ['read', 'read'],
      ['write', 'write'],
      ['write', 'edit']
    ] as const) {
      const verdict = context.judgeGate(action, pathObject(SUMMARY_PATH), { tool: { name: tool } })
      expect(verdict.allowed, tool).toBe(true)
      expect(verdict.decision.winning, tool).toBe('recap-access#1')
    }

    const stillAsks = [
      '/Users/u/notes/other.md',
      `${SUMMARY_PATH}.bak`,
      `${SUMMARY_PATH}/x`,
      '/Users/u/.ssh/id_rsa',
      // bot 不能放宽它自己的策略
      RECAP_POLICY_FILE
    ]
    for (const path of stillAsks) {
      for (const action of ['read', 'write']) {
        const what = `${action} ${path}`
        const verdict = context.judgeGate(action, pathObject(path), { tool: { name: action } })
        expect(verdict.allowed, what).toBe(false)
        expect(verdict.decision.winning, what).toMatch(/^ask-on-external-path#/)
      }
    }
    const outside = context.judgeGate('write', pathObject('/etc/x'), { tool: { name: 'write' } })
    expect(outside.allowed).toBe(false)
    expect(outside.decision.winning).toMatch(/^ask-on-external-path#/)

    // 读家目录以外的文件本来就不问：这是缺省（no policy = allow），不是这份策略放的
    const hosts = context.judgeGate('read', pathObject('/etc/hosts'), { tool: { name: 'read' } })
    expect(hosts.allowed).toBe(true)
    expect(hosts.decision.winning).toBe('default:path')
    expect(warnings).toEqual([])
  })

  it.each(['prompt-session', 'steer-session'])(
    'BK-37 %s：往别的会话里写不放行（ask-on-session-access#1，tier ask），哪怕它一小时前还活跃',
    (operation) => {
      const { context, warnings } = recapContext(lang)
      const verdict = context.judgeGate('write', sessionObject(ago(HOUR)), {
        tool: { name: 'session', operation }
      })
      expect(verdict.allowed).toBe(false)
      expect(verdict.decision.winning).toBe('ask-on-session-access#1')
      expect(verdict.decision.tier).toBe('ask')
      expect(warnings).toEqual([])
    }
  )

  it.each<[string, RecapSubject]>([
    ['别的 bot', { attrs: { bot: 'other' } }],
    ['名字以 recap 开头的 bot', { attrs: { bot: 'recap2' } }],
    ['空串身份', { attrs: { bot: '' } }],
    ['没有 attrs', {}],
    ['recap 派出的子 agent', { attrs: { bot: 'recap' }, agentKind: 'spawned' }]
  ])('BK-38 %s：同样的操作一条都不放行，胜出的是内置规则；不产生求值警告', (_label, subject) => {
    const { context, warnings } = recapContext(lang, subject)
    const session = context.judgeGate('read', sessionObject(ago(HOUR)), {
      tool: READ_SESSION
    })
    expect(session.allowed).toBe(false)
    expect(session.decision.winning).toMatch(/^ask-on-session-access#/)
    for (const action of ['read', 'write']) {
      const path = context.judgeGate(action, pathObject(SUMMARY_PATH), { tool: { name: action } })
      expect(path.allowed, action).toBe(false)
      expect(path.decision.winning, action).toMatch(/^ask-on-external-path#/)
    }
    expect(warnings).toEqual([])
  })

  it('BK-39 真实的 botAccessNote：读会话放行、发消息会停、那份笔记读写放行，其余询问；没有多放，也不再提示要配策略', () => {
    const { context, vars, warnings, user, readMd } = recapContext(lang)
    const naming = resolvePolicyFiles(buildBuiltinPolicies({ readMd }), [user])
      .filter((e) => !e.shadowedBy)
      .map((e) => e.policy)
      .filter((p) => policyNamesBot(p, 'recap'))
    const note = botAccessNote({
      botName: 'recap',
      identity: 'recap',
      identityFrom: 'name',
      naming,
      locations: [
        {
          label: 'a temporary folder',
          vars,
          judge: (action, object, tool) => context.judgeGate(action, object, { tool })
        }
      ],
      reviewActive: true,
      host: { home: RECAP_HOME, root: '/', sep: '/', vars, isDirectory: () => false },
      policiesDirLabel: '~/.shuvix/policies/',
      now: new Date(RECAP_NOW),
      warnings: () => warnings
    })
    const lines = note.split('\n')
    expect(lines).toContain('- read other sessions: allowed (recap-access).')
    expect(lines).toContain(
      '- send messages into other sessions: asks (ask-on-session-access; only the user can answer, so the run would stop).'
    )
    expect(lines).toContain('- ~/notes/daily-summary.md: read and write allowed (recap-access).')
    expect(note).toContain('Policies that name it: recap-access.')
    const elsewhere = lines.filter((line) => line.startsWith('- elsewhere'))
    expect(elsewhere).toHaveLength(1)
    expect(elsewhere[0]).toContain('asks (ask-on-external-path')
    for (const trouble of [
      'also allowed',
      'plain `allow`',
      'companion policy',
      'Some rules failed',
      'object.sessionId'
    ]) {
      expect(note, trouble).not.toContain(trouble)
    }
  })

  it('BK-40 写入回执没话说也不改文件（没盖 shuvix-id —— 盖了 subject.bot 就不再是名字）；示例用的 vars 都在 policy-md 的变量表里', () => {
    const ctx = { today: '2026-06-10' }
    expect(reviewShuvixMdWrite(recapBlock(lang, RECAP_BOT), 'recap.md', ctx)).toBeNull()
    expect(reviewShuvixMdWrite(recapBlock(lang, RECAP_POLICY), 'recap-access.md', ctx)).toBeNull()

    const lines = readFileSync(join(BASE_DIR, lang, 'policy-md.md'), 'utf8').split('\n')
    const start = lines.findIndex((line) => line.startsWith('### `vars`'))
    expect(start, `${lang}/policy-md.md 没有变量表`).toBeGreaterThanOrEqual(0)
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((line) => /^#{1,3} /.test(line))
    const names = (end < 0 ? rest : rest.slice(0, end)).flatMap((line) => {
      const cell = /^\| `([^`]+)`/.exec(line)
      return cell ? [cell[1]] : []
    })
    expect(names).toContain('home')
    expect(names).toContain('now')
  })
})

describe.each(EXPECTED_LANGS)('BK-42 shuvix-files 讲写这些文件 · %s', (lang) => {
  const REMOVED: Record<string, string> = {
    en: 'create it',
    zh: '建出来',
    ja: '作成してください'
  }

  it('BK-42 恰有一条列表项同时讲 `write` 与 `mkdir`（write 会建目录），这一条里不再叫人自己建', () => {
    const body = readFileSync(join(BASE_DIR, lang, 'shuvix-files.md'), 'utf8')
    const bullets = bulletsOf(body).filter((b) => b.includes('`write`') && b.includes('`mkdir`'))
    expect(bullets, lang).toHaveLength(1)
    expect(REMOVED[lang], lang).toBeDefined()
    expect(bullets[0]).not.toContain(REMOVED[lang])
  })
})
