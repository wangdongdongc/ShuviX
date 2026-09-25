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
 * 3. **分类框的「浅底 + 同色深字」在每套主题、每个槽位上都读得清（TH-1…6）。** `--viz-N-tint` /
 *    `--viz-N-ink` 从 `--viz-N` **派生**、不逐主题调 —— 于是「11 套主题 × 8 槽都过 AA」不是某个人
 *    调出来的结果，而是一个公式的推论，改一个槽位色、加一套主题、换一下卡片底色都可能悄悄打破它。
 *    这组用例从 css 里把公式的每一项（槽位色、混合比例、极点、各主题的底色与 color-scheme）解析出来，
 *    再从聊天卡片的组件源码里取卡片底的比例，按同一公式逐套主题复算 ink 对 tint 的对比度。数值本身
 *    不从 css 注释里抄：注释里的 5.16 只是「现在最差的那一格」，这里只守门槛 4.5。
 *
 * 刻意不测的：调色板本身的具体色值与色觉可分性（数值来源与校验结果写在 css 的注释里，复述一遍只是
 * 把同一批数字抄成第二份），以及真实浏览器里 `light-dark()` / `color-mix()` 的解析（jsdom 没有 CSSOM
 * 支持，已在真实 Chromium 里用一次性探针验过；e2e 的 chat-interactive E-3 比对宿主与沙箱的解析值）。
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

// ─── 分类框的浅底与同色深字（TH-1…6） ─────────────────────────────────────

/** `:root` 上某个自定义属性的声明值（第一处；调色板只挂在 :root 上，见上一组最后一条） */
const declOf = (name: string): string | undefined =>
  new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(CSS)?.[1]?.trim()

/** 八个分类槽位 */
const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8]

type Rgb = [number, number, number]

/** `#abc` / `#aabbcc` → 伽马编码的 sRGB 分量（0…1）；三位写法按位展开 */
const hexRgb = (hex: string): Rgb => {
  const h = hex.replace(/^#/, '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  expect(full, `不是十六进制颜色：${hex}`).toMatch(/^[0-9a-f]{6}$/i)
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb
}

/** 在伽马编码的 sRGB 里按分量混合：t·a + (1−t)·b（color-mix in srgb 与 alpha 叠加都是这个式子） */
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => t * v + (1 - t) * b[i]) as Rgb

/** WCAG 相对亮度 */
const luminance = ([r, g, b]: Rgb): number => {
  const lin = (x: number): number => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 对比度（与前后景顺序无关） */
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const TINT_RE = /^color-mix\(in srgb, var\(--viz-(\d+)\) (\d+(?:\.\d+)?)%, transparent\)$/
const INK_RE =
  /^color-mix\(in srgb, var\(--viz-(\d+)\) (\d+(?:\.\d+)?)%, light-dark\((#[0-9a-f]{3,6}), (#[0-9a-f]{3,6})\)\)$/i
const WASH_RE = /^color-mix\(in srgb, var\(--theme-text-primary\) (\d+(?:\.\d+)?)%, transparent\)$/

/** 聊天里画图的两张卡片：```svg（CodeBlock 的 AuthoredSvgBlock）与 ```interactive（InteractiveBlock） */
const CARD_SOURCES = ['CodeBlock.tsx', 'InteractiveBlock.tsx'].map((file) => ({
  file,
  text: readFileSync(resolve(HERE, '../../chat-ui/src/components/chat', file), 'utf8')
}))
const CARD_RE = /color-mix\(in srgb, var\(--color-bg-tertiary\) (\d+(?:\.\d+)?)%, transparent\)/g

/** 各卡片源码里卡片底的百分比（去重） */
const cardPercents = CARD_SOURCES.map(({ file, text }) => ({
  file,
  percents: [...new Set([...text.matchAll(CARD_RE)].map((m) => Number(m[1])))]
}))

/** 各主题块里的底色与明暗（与上一组同一种块切法） */
const THEMES = [...CSS.matchAll(/^\[data-theme='([^']+)'\]\s*\{([\s\S]*?)^\}/gm)].map((m) => {
  const body = m[2]
  const read = (name: string): string | undefined =>
    new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body)?.[1]?.trim()
  return {
    theme: m[1],
    scheme: read('color-scheme'),
    bgPrimary: read('--theme-bg-primary'),
    bgTertiary: read('--theme-bg-tertiary')
  }
})

/** 解析好的公式各项 —— TH-2 钉形状，这里只管取数（取不到就是 NaN / undefined，TH-2 会先红） */
const parseFormula = (): {
  slot: Record<number, { light: string; dark: string }>
  tintPct: number
  inkPct: number
  pole: { light: string; dark: string }
} => {
  const slot: Record<number, { light: string; dark: string }> = {}
  for (const n of SLOTS) {
    const m = /^light-dark\((#[0-9a-f]{3,6}),\s*(#[0-9a-f]{3,6})\)$/i.exec(
      declOf(`--viz-${n}`) ?? ''
    )
    slot[n] = { light: m?.[1] ?? '', dark: m?.[2] ?? '' }
  }
  const tint = TINT_RE.exec(declOf('--viz-1-tint') ?? '')
  const ink = INK_RE.exec(declOf('--viz-1-ink') ?? '')
  return {
    slot,
    tintPct: Number(tint?.[2]),
    inkPct: Number(ink?.[2]),
    pole: { light: ink?.[3] ?? '', dark: ink?.[4] ?? '' }
  }
}

interface InkPair {
  theme: string
  slot: number
  /** ink 对「tint 叠在卡片上、卡片叠在页面上」的对比度 */
  ratio: number
  /** 同一块底上直接拿 --viz-N 当字色的对比度（TH-5 的对照） */
  rawRatio: number
}

/**
 * 11 套主题 × 8 槽的 ink / tint 对比度。c = 卡片底里 bg-tertiary 的比例（取自卡片源码，TH-6）。
 *   card = c·T + (1−c)·P        （卡片底：bg-tertiary 按 c 叠在 bg-primary 上）
 *   surf = p·V + (1−p)·card     （tint：--viz-N 按 p 叠在卡片上）
 *   ink  = q·V + (1−q)·K        （ink：--viz-N 往极点 K 混，浅档 K=黑、深档 K=白）
 */
const inkPairs = (cardFraction: number): InkPair[] => {
  const { slot, tintPct, inkPct, pole } = parseFormula()
  const p = tintPct / 100
  const q = inkPct / 100
  return THEMES.flatMap(({ theme, scheme, bgPrimary, bgTertiary }) => {
    const side = scheme === 'light' ? 'light' : 'dark'
    const card = mixRgb(hexRgb(bgTertiary ?? ''), hexRgb(bgPrimary ?? ''), cardFraction)
    const K = hexRgb(pole[side])
    return SLOTS.map((n) => {
      const V = hexRgb(slot[n][side])
      const surf = mixRgb(V, card, p)
      const ink = mixRgb(V, K, q)
      return { theme, slot: n, ratio: contrast(ink, surf), rawRatio: contrast(V, surf) }
    })
  })
}

describe('themes.css —— 分类框的 tint / ink 与中性 wash（TH-1…6）', () => {
  it('TH-1 --viz-N-tint / --viz-N-ink 恰好覆盖 1..8，另有 --viz-wash；没有第 9 对', () => {
    for (const n of SLOTS) {
      expect(DEFINED.has(`--viz-${n}-tint`), `--viz-${n}-tint`).toBe(true)
      expect(DEFINED.has(`--viz-${n}-ink`), `--viz-${n}-ink`).toBe(true)
    }
    expect(DEFINED.has('--viz-wash')).toBe(true)
    expect(DEFINED.has('--viz-9-tint')).toBe(false)
    expect(DEFINED.has('--viz-9-ink')).toBe(false)
  })

  it('TH-2 形状：tint / ink 各从自己那个槽位派生，比例 8 个槽位一致；wash 取文字色的一小份', () => {
    const tintPcts = new Set<string>()
    const inkPcts = new Set<string>()
    const poles = new Set<string>()
    for (const n of SLOTS) {
      const tint = TINT_RE.exec(declOf(`--viz-${n}-tint`) ?? '')
      expect(tint, `--viz-${n}-tint 的写法变了：${declOf(`--viz-${n}-tint`)}`).not.toBeNull()
      expect(Number(tint![1]), `--viz-${n}-tint 取的是别的槽位`).toBe(n)
      tintPcts.add(tint![2])

      const ink = INK_RE.exec(declOf(`--viz-${n}-ink`) ?? '')
      expect(ink, `--viz-${n}-ink 的写法变了：${declOf(`--viz-${n}-ink`)}`).not.toBeNull()
      expect(Number(ink![1]), `--viz-${n}-ink 取的是别的槽位`).toBe(n)
      inkPcts.add(ink![2])
      poles.add(`${ink![3]},${ink![4]}`.toLowerCase())
    }
    // 一个公式，不是八个调出来的数
    expect([...tintPcts], 'tint 的比例各槽不一').toHaveLength(1)
    expect([...inkPcts], 'ink 的比例各槽不一').toHaveLength(1)
    expect([...poles], 'ink 的极点各槽不一').toHaveLength(1)
    const [p] = [...tintPcts].map(Number)
    const [q] = [...inkPcts].map(Number)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(100)
    expect(q).toBeGreaterThan(0)
    expect(q).toBeLessThan(100)

    const wash = WASH_RE.exec(declOf('--viz-wash') ?? '')
    expect(wash, `--viz-wash 的写法变了：${declOf('--viz-wash')}`).not.toBeNull()
    expect(Number(wash![1])).toBeGreaterThan(0)
    expect(Number(wash![1])).toBeLessThan(100)
  })

  it('TH-6 卡片底的比例从两张卡片的源码里取：两处都找得到、而且相同；两个宿主的 --color-bg-tertiary 都指向 --theme-bg-tertiary', () => {
    for (const { file, percents } of cardPercents) {
      expect(percents, `${file} 里找不到卡片底的 color-mix`).toHaveLength(1)
    }
    const [svgCard, interactiveCard] = cardPercents.map((c) => c.percents[0])
    expect(interactiveCard, '两张卡片的底色比例不一致').toBe(svgCard)
    expect(svgCard).toBeGreaterThan(0)
    expect(svgCard).toBeLessThanOrEqual(100)
    // 卡片取的是 Tailwind 的 --color-bg-tertiary；复算用的是 --theme-bg-tertiary，两者之间这条映射得在
    for (const host of [
      '../../../apps/desktop/src/renderer/src/assets/main.css',
      '../../../apps/extension/src/sidepanel/styles.css'
    ]) {
      const text = readFileSync(resolve(HERE, host), 'utf8')
      expect(text, host).toMatch(/--color-bg-tertiary\s*:\s*var\(--theme-bg-tertiary\)\s*;/)
    }
  })

  it('TH-3 11 套主题 × 8 槽：tint 上的 ink 对比度都 ≥ 4.5（按 css 里的公式与卡片源码里的底色比例复算）', () => {
    const card = cardPercents[0].percents[0]
    expect(Number.isFinite(card), '卡片底比例没取到（见 TH-6）').toBe(true)
    // 前提：11 套主题的底色与明暗都解析出来了（缺一项，下面那套主题会变成 NaN 而不是报错）
    expect(THEMES).toHaveLength(11)
    for (const t of THEMES) {
      expect(t.scheme, t.theme).toMatch(/^(dark|light)$/)
      expect(t.bgPrimary, t.theme).toMatch(/^#[0-9a-f]{3,6}$/i)
      expect(t.bgTertiary, t.theme).toMatch(/^#[0-9a-f]{3,6}$/i)
    }
    const failures = inkPairs(card / 100)
      .filter((pair) => !(pair.ratio >= 4.5))
      .map((pair) => `${pair.theme} viz-${pair.slot} ${pair.ratio.toFixed(2)}`)
    expect(failures).toEqual([])
  })

  it('TH-4 自检：对比度公式对得上 WCAG 的已知值；恰好算了 88 对、都是有限数', () => {
    const black = hexRgb('#000')
    const white = hexRgb('#fff')
    expect(contrast(black, white)).toBeCloseTo(21, 5)
    expect(contrast(white, black)).toBeCloseTo(21, 5)
    expect(contrast(white, white)).toBe(1)
    // AA 门槛两侧的那对经典灰：#767676 刚过、#777777 刚不过
    expect(contrast(hexRgb('#767676'), white)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(hexRgb('#777777'), white)).toBeLessThan(4.5)
    // 三位写法按位展开
    expect(hexRgb('#abc')).toEqual(hexRgb('#aabbcc'))

    const pairs = inkPairs(cardPercents[0].percents[0] / 100)
    expect(pairs).toHaveLength(88)
    expect(new Set(pairs.map((p) => `${p.theme}/${p.slot}`)).size).toBe(88)
    for (const pair of pairs) {
      expect(Number.isFinite(pair.ratio), `${pair.theme} viz-${pair.slot}`).toBe(true)
      expect(pair.ratio).toBeGreaterThanOrEqual(1)
    }
  })

  it('TH-5 这道门真的会关：同一块底上直接拿 --viz-N 当字色，至少有一格过不了 4.5', () => {
    // 否则 TH-3 的全绿可能只是算法恒真（比如底色取错成与字色无关的常量）
    const pairs = inkPairs(cardPercents[0].percents[0] / 100)
    const raw = pairs.filter((pair) => pair.rawRatio < 4.5)
    expect(raw.length).toBeGreaterThan(0)
  })
})
