/**
 * `themes.css` 的两条硬前提 —— 都是纯文本检查，用 fs 读 css（不经打包器）。
 *
 * 1. **作图技能里教给模型的每一个 token 都真的有定义。** 手写 SVG 的取色全靠这批
 *    `--viz-*` / `--theme-*`；`var(--viz-9)` 这种不存在的名字在 CSS 里是**静默**的 ——
 *    属性按未设置处理，图变成黑的或者干脆不见，没有任何报错。技能（`SKILL.md` + references）
 *    是模型唯一的说明书，它和这份 css 之间没有类型可以拴住，只有这条用例。
 *    2026-09-24 起（用户裁决）token 表连同契约一起从 visual-guide 提示片段搬进了 `builtin:drawing`
 *    技能，系统提示只留「先加载技能」—— 所以这条改扫技能文件，另加一条反向的：片段里一个
 *    token 都不点（点了就是契约又有了第二份，而且两份迟早只改一边）。
 *
 * 2. **每个 `[data-theme='…']` 块都声明了 `color-scheme`。** 整套调色板只定义一份，靠
 *    `light-dark()` 覆盖 11 套主题 —— 而 `light-dark()` 取的是元素**实际生效**的
 *    color-scheme。某套主题漏掉这行声明，它就静默拿到浅色档的图（深色主题上的浅色图）。
 *    css 刻意没有枚举「哪些主题是浅色」，正是因为那会变成第二份事实源；代价是这条声明
 *    成了必需项，于是需要一条用例守着。
 *
 * 刻意不测的：具体色值、对比度/色觉可分性（数值来源与校验结果写在 css 的注释里，
 * 复述一遍只是把同一批数字抄成第二份），以及真实浏览器里 `light-dark()` 的解析
 * （jsdom 没有 CSSOM 支持，已在真实 Chromium 里用一次性探针验过）。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(resolve(HERE, 'themes.css'), 'utf8')

/** 作图技能（三语）：SKILL.md + references/*.md —— 模型加载之后看到的说明书 */
const SKILL_ROOT = resolve(HERE, '../../../apps/desktop/resources/skills')
const SKILL_LANGS = ['en', 'zh', 'ja']
const SKILL_FILES = SKILL_LANGS.flatMap((lang) => {
  const dir = resolve(SKILL_ROOT, lang, 'drawing')
  const references = readdirSync(resolve(dir, 'references'))
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `references/${f}`)
  return ['SKILL.md', ...references].map((rel) => ({
    name: `${lang}/drawing/${rel}`,
    text: readFileSync(resolve(dir, rel), 'utf8')
  }))
})

/** 三份 visual-guide 提示片段 —— 系统提示里常驻的那一段，只指路，不教 token */
const FRAGMENT_DIR = resolve(HERE, '../../agent-runtime/src/agentProfile/fragments')
const FRAGMENTS = ['visual-guide.md', 'visual-guide.zh.md', 'visual-guide.ja.md'].map((name) => ({
  name,
  text: readFileSync(resolve(FRAGMENT_DIR, name), 'utf8')
}))

/** css 里所有 `--name:` 形式的自定义属性定义 */
const DEFINED = new Set([...CSS.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))

/** 文本里提到的 `--viz-*` / `--theme-*` token（末尾不带连字符的完整名） */
const tokensIn = (text: string): string[] =>
  [
    ...new Set([...text.matchAll(/--(?:viz|theme)-[a-z0-9]+(?:-[a-z0-9]+)*/g)].map((m) => m[0]))
  ].sort()

describe('themes.css —— 作图技能教的 token 都有定义', () => {
  it.each(SKILL_FILES)('$name 里的每个 --viz-* / --theme-* 都能在 css 里找到', ({ text }) => {
    const tokens = tokensIn(text)
    expect(tokens.length, '这份技能文件里应当真的点名了 token').toBeGreaterThan(0)
    for (const token of tokens) {
      expect(DEFINED.has(token), `${token} 在 themes.css 里没有定义`).toBe(true)
    }
  })

  it.each(SKILL_LANGS)('%s 的 SKILL.md 自己就把 token 表讲全了（契约段那张表）', (lang) => {
    // 模型加载技能时先读的是 SKILL.md；references 按需才读 —— token 表不能只在 references 里
    const skill = SKILL_FILES.find((f) => f.name === `${lang}/drawing/SKILL.md`)
    expect(skill, `${lang}/drawing/SKILL.md 读不到`).toBeDefined()
    expect(tokensIn(skill!.text).length).toBeGreaterThan(5)
  })

  it.each(FRAGMENTS)(
    '$name 一个 --viz-* / --theme-* 都不点，也不写十六进制颜色 —— token 表只在技能里',
    ({ name, text }) => {
      // 正控制组：读到的是那份片段（它叫模型先加载作图技能）
      expect(text, name).toContain('builtin:drawing')
      expect(tokensIn(text), name).toEqual([])
      expect(text, name).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    }
  )

  it('自检：css 解析出的定义集合像话（否则上面整圈都是空转）', () => {
    // 去重后的名字数（同一批 --theme-* 在 11 套主题里各出现一次）
    expect(DEFINED.size).toBeGreaterThan(30)
    expect(DEFINED.has('--viz-1')).toBe(true)
    expect(DEFINED.has('--viz-nonexistent')).toBe(false)
  })

  it('分类色 1..8、顺序色 seq-1..5、状态四档、结构两项都齐 —— 技能按「范围」介绍它们', () => {
    // 技能写的是 `--viz-1` … `--viz-8` 这种区间写法，中间几个字面量不出现在 md 里，
    // 上面那圈检查不到；而模型会按区间去用。区间的每一格都得真的存在。
    for (let i = 1; i <= 8; i++) expect(DEFINED.has(`--viz-${i}`), `--viz-${i}`).toBe(true)
    for (let i = 1; i <= 5; i++) expect(DEFINED.has(`--viz-seq-${i}`), `--viz-seq-${i}`).toBe(true)
    for (const name of ['good', 'warn', 'serious', 'critical', 'mid', 'grid', 'axis']) {
      expect(DEFINED.has(`--viz-${name}`), `--viz-${name}`).toBe(true)
    }
    expect(DEFINED.has('--viz-9')).toBe(false) // 第 9 个系列归入「其他」，不是再造一个色
  })
})

describe('themes.css —— 每套主题都声明 color-scheme', () => {
  /** 各 `[data-theme='x'] { … }` 块（选择器在行首、右花括号在行首收尾，与本文件的书写约定一致） */
  const blocks = [...CSS.matchAll(/^\[data-theme='([^']+)'\]\s*\{([\s\S]*?)^\}/gm)].map((m) => ({
    theme: m[1],
    body: m[2]
  }))

  it('自检：11 套主题块都被解析出来了', () => {
    expect(blocks.map((b) => b.theme)).toHaveLength(11)
    expect(new Set(blocks.map((b) => b.theme)).size).toBe(11) // 没有重名块
  })

  it.each([
    'github-dark',
    'nord',
    'tokyo-night',
    'dracula',
    'one-dark',
    'catppuccin-mocha',
    'gruvbox-dark',
    'github-light',
    'solarized-light',
    'one-light',
    'catppuccin-latte'
  ])('%s 声明了 color-scheme（light-dark() 靠它取档）', (theme) => {
    const block = blocks.find((b) => b.theme === theme)
    expect(block, `themes.css 里找不到 ${theme}`).toBeDefined()
    const declared = /color-scheme\s*:\s*(dark|light)\s*;/.exec(block!.body)
    expect(declared, `${theme} 缺 color-scheme —— 这套主题会静默拿到浅色档的图`).not.toBeNull()
  })

  it('调色板只定义一份（挂在 :root 上），不随主题重复 —— 重复一份就是漂移的起点', () => {
    for (const block of blocks) {
      expect(block.body, `${block.theme} 不该重新定义 --viz-*`).not.toMatch(/--viz-/)
    }
    expect(CSS).toMatch(/--viz-1:\s*light-dark\(/)
  })
})
