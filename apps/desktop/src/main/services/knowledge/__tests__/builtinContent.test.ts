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
})
