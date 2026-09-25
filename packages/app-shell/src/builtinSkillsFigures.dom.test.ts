// @vitest-environment jsdom
/**
 * 教给模型的**范例图**本身得是对的 —— 作图技能的 `references/diagrams.md`、`references/style.md`
 * 与 `SKILL.md`（各三语）里的 ```svg 块，逐张过一遍它们自己教的契约与观感。
 *
 * 2026-09-24（用户裁决）：「一张完整的小图」那个范例连同契约与预算，从 visual-guide 提示片段
 * 搬进了技能的 SKILL.md —— 系统提示只留「先加载技能」。所以 SOURCES 里原先那三份片段换成了
 * 三份 SKILL.md，同一套 E1…E5 照旧逐张过；新增 E7 反过来钉「片段里一张范例图都没有」。
 * 随后技能多了一页观感（`references/style.md`，只有片段、没有整张图），diagrams.md 多了第二张
 * 「按类别上色」的图（分类浅底 `--viz-N-tint` + 同色深字 `--viz-N-ink`）—— E8…E13 钉的是观感那一页
 * 教的规矩在范例里是不是也守着：范例一旦破了自己的规矩，模型学到的是范例。
 *
 * 为什么要这一组：范例是模型最会照抄的东西。一张范例里写了十六进制颜色、`width`/`height`、
 * 一行塞三个元素、或者一个会被净化器剥掉的属性，模型就会把同样的错画进每一张图 —— 而那些错
 * 在提示词的散文里是看不出来的，只有把范例当成一张真图去检查才看得见。
 *
 * 块的分类与聊天里的 CodeBlock 同一把尺子（`svgFenceIsRenderable`）：能渲染的是**图**
 * （figure），不能的是**片段**（snippet，例如只有一个 `<defs><marker>` 的那段）。
 *
 *  - E1 在场：diagrams.md 各有两张图（带箭头，至少一张用到分类浅底），SKILL.md 各有一张图，
 *    style.md 各有片段（可以没有整张图）；图都写完了，片段里没有 `<svg`
 *    （这里的「片段」是分类名：不能单独渲染的 snippet，与提示片段无关）；
 *  - E2 契约（只对图）：viewBox、不写宽高、role/aria-label、一行一个元素、字号 ≥ 11、
 *    没有被禁的标签、`url()` 只指片段内、没有外链；
 *  - E3 取色（图与片段）：颜色只取 token（或 none / url(#…)），没有十六进制，用到的 token 在
 *    themes.css 里都有定义，每个 `<text>` 实际生效的填色是文字色、字族是 --theme-font-sans；
 *  - E4 过净化器（sanitizeAuthoredSvg，聊天里的那一档）原样通过：元素、属性一个不少，值除了
 *    按内容加前缀的 id 与对它的 url(#…) 引用之外一字不改；
 *  - E5 箭头：marker 引用在 id 加前缀之后仍指向输出里真实存在的 marker；
 *  - E6 预算（只对 diagrams.md 的图）：框数、同一行的框数、元素都在 viewBox 里、连线不穿框；
 *  - E7 范例只在技能里：三份 visual-guide 提示片段里没有任何 ```svg 块、也没有 `<svg`；
 *  - E8 画布：整张图的 viewBox 是 `0 0 640 H`（640 宽时一个单位约一个像素，字号表才成立）；
 *  - E9 字重：只有 400 / 500；13 号字是 500，11 号字不写字重或写 400；
 *  - E10 线宽（marker 里的箭头头不算）：只有 1 / 1.5，一张图至多一处 1.5（那唯一的强调）；
 *  - E11 分类浅底：ink 的字落在同一槽位的 tint 框里、tint 框里的字用这个框的 ink、框的描边是这个槽位
 *    本身、槽位从 1 起连续取且不超过 3 个；
 *  - E12 文字里没有 emoji 与带圈数字；
 *  - E13 平面：没有渐变与滤镜、文字不调透明度、没有铺满整张图的背景框。
 *
 * ⚠️ 放在这里而不是 `apps/desktop/src/main/services/__tests__`（技能资源那组 BS 用例的邻居）：
 * 那个目录由 tsconfig.node.json 做类型检查（lib 只有 ES2022），而这一组要 DOMParser，并且会把
 * svgSanitize.ts 拉进 node 那张图（它在那里被刻意排除）。app-shell 走 web / 扩展两套配置，
 * 而且隔壁的 themes.test.ts 本来就在跨包读技能文件与提示片段、比对这份 themes.css。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeAuthoredSvg } from '@shuvix/chat-protocol/utils/svgSanitize'
import { isSvgComplete, svgFenceIsRenderable } from '@shuvix/chat-protocol/utils/svgFence'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `packages/app-shell/src` 往上三层 */
const REPO_ROOT = resolve(HERE, '../../..')
const CSS = readFileSync(resolve(HERE, 'themes.css'), 'utf8')
/** css 里所有 `--name:` 形式的自定义属性定义（与 themes.test.ts 同一条） */
const DEFINED = new Set([...CSS.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]))

interface Source {
  /** 报错时认文件用 */
  name: string
  text: string
  /** diagrams.md 才有预算与箭头的要求 */
  isDiagrams: boolean
  /** 只有片段、不要求整张图（style.md：它教的是零件的画法） */
  snippetsOnly: boolean
  /** 语言（E11 的正控制组按语言数） */
  lang: string
}

const LANGS = ['en', 'zh', 'ja']

/** 技能里的一份 md；读不到就是空串（E1 会报出来） */
const skillSource = (
  lang: string,
  rel: string,
  flags: Pick<Source, 'isDiagrams' | 'snippetsOnly'>
): Source => {
  const path = join(REPO_ROOT, 'apps/desktop/resources/skills', lang, 'drawing', rel)
  return {
    name: `skills/${lang}/drawing/${rel}`,
    text: existsSync(path) ? readFileSync(path, 'utf8') : '',
    lang,
    ...flags
  }
}

const SOURCES: Source[] = [
  ...LANGS.map((lang) =>
    skillSource(lang, 'references/diagrams.md', { isDiagrams: true, snippetsOnly: false })
  ),
  ...LANGS.map((lang) => skillSource(lang, 'SKILL.md', { isDiagrams: false, snippetsOnly: false })),
  ...LANGS.map((lang) =>
    skillSource(lang, 'references/style.md', { isDiagrams: false, snippetsOnly: true })
  )
]

/** 三份 visual-guide 提示片段 —— 只在 E7 里用：范例图已经不该在这里 */
const FRAGMENTS = ['visual-guide.md', 'visual-guide.zh.md', 'visual-guide.ja.md'].map((file) => ({
  name: `fragments/${file}`,
  text: readFileSync(
    join(REPO_ROOT, 'packages/agent-runtime/src/agentProfile/fragments', file),
    'utf8'
  )
}))

interface Block {
  source: Source
  index: number
  body: string
  label: string
}

/** 行首 ```svg 到行首 ``` 之间的块体（不含围栏行本身） */
const blocksOf = (source: Source): Block[] =>
  [...source.text.matchAll(/^```svg\n([\s\S]*?)^```$/gm)].map((m, index) => ({
    source,
    index,
    body: m[1],
    label: `${source.name} #${index}`
  }))

const ALL_BLOCKS = SOURCES.flatMap(blocksOf)
/** 能渲染的块 = 图；与 CodeBlock 的分发同一个判定 */
const FIGURES = ALL_BLOCKS.filter((b) => svgFenceIsRenderable('svg', b.body))
const SNIPPETS = ALL_BLOCKS.filter((b) => !svgFenceIsRenderable('svg', b.body))
const DIAGRAM_FIGURES = FIGURES.filter((b) => b.source.isDiagrams)

/** 按 HTML 解析（与净化器同一种解析），取第一个 `<svg>`；片段先包一层 `<svg>` */
const parseRoot = (markup: string): Element => {
  const root = new DOMParser().parseFromString(markup, 'text/html').body.querySelector('svg')
  if (!root) throw new Error(`解析不出 <svg>：${markup.slice(0, 80)}`)
  return root
}
const elementsOf = (root: Element): Element[] => [root, ...root.querySelectorAll('*')]

/** 某个属性的**生效值**：自己没写就沿祖先往上找（SVG 的表现属性是继承的） */
const inherited = (el: Element, attr: string): string | null => {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const value = cur.getAttribute(attr)
    if (value !== null) return value
  }
  return null
}

const num = (el: Element, attr: string): number => Number(el.getAttribute(attr) ?? '0')

describe('范例图：在场与分类（E0 / E1）', () => {
  it('E0 前提：jsdom 有 DOMParser，净化器在这里真的能跑出东西', () => {
    // 净化器在没有 DOMParser 时一律返回空串（失败关闭）—— 那样下面所有「净化后原样」都会假红，
    // 而「净化后什么都不剩」那类断言会假绿
    expect(typeof DOMParser).toBe('function')
    expect(sanitizeAuthoredSvg('<svg viewBox="0 0 4 4"><rect/></svg>')).not.toBe('')
  })

  it.each(SOURCES.map((s) => [s.name, s] as const))(
    'E1 %s：有图（style.md 只要有片段）；图都写完了；片段里没有 <svg',
    (_name, source) => {
      expect(source.text, `${source.name} 读不到`).not.toBe('')
      const blocks = blocksOf(source)
      const figures = blocks.filter((b) => svgFenceIsRenderable('svg', b.body))
      if (source.snippetsOnly) {
        // 观感那一页只教零件：得真有 ```svg 片段，E3 才有东西可扫
        expect(blocks.length, '一段 ```svg 都没有').toBeGreaterThan(0)
      } else {
        expect(figures.length, '一张图都没有').toBeGreaterThan(0)
      }
      if (source.isDiagrams) {
        // 讲箭头的那份参考：两张范例（一张中性 + 强调，一张按类别上色），都有带箭头的线
        expect(figures, '范例图的张数').toHaveLength(2)
        expect(figures.every((b) => b.body.includes('marker-end'))).toBe(true)
        expect(figures.some((b) => /var\(--viz-\d+-tint\)/.test(b.body))).toBe(true)
      }
      for (const figure of figures) expect(isSvgComplete(figure.body), figure.label).toBe(true)
      for (const snippet of blocks.filter((b) => !svgFenceIsRenderable('svg', b.body))) {
        expect(snippet.body, snippet.label).not.toContain('<svg')
      }
    }
  )
})

describe('范例图守自己教的契约（E2）', () => {
  it.each(FIGURES.map((b) => [b.label, b] as const))('E2 %s', (_label, block) => {
    const root = parseRoot(block.body)

    // viewBox 四个数，宽高为正；根上不写 width / height（图按栏宽缩放）
    const viewBox = (root.getAttribute('viewBox') ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    expect(viewBox, 'viewBox').toHaveLength(4)
    expect(viewBox.every(Number.isFinite), 'viewBox').toBe(true)
    expect(viewBox[2]).toBeGreaterThan(0)
    expect(viewBox[3]).toBeGreaterThan(0)
    expect(root.hasAttribute('width'), '根上写了 width').toBe(false)
    expect(root.hasAttribute('height'), '根上写了 height').toBe(false)

    // 可访问名：这个标签同时就是图的标题
    expect(root.getAttribute('role')).toBe('img')
    expect((root.getAttribute('aria-label') ?? '').trim()).not.toBe('')

    // 一个元素一行 —— `edit` 需要锚点
    for (const line of block.body.split('\n')) {
      expect((line.match(/<[A-Za-z]/g) ?? []).length, line).toBeLessThanOrEqual(1)
    }

    // 字号不小于 11
    const sizes = elementsOf(root)
      .map((el) => el.getAttribute('font-size'))
      .filter((v): v is string => v !== null)
    for (const size of sizes)
      expect(parseFloat(size), `font-size=${size}`).toBeGreaterThanOrEqual(11)

    // 被禁的标签（上屏前会被剥掉）
    expect(block.body).not.toMatch(/<(style|foreignObject|script)\b/i)

    // url() 只指片段内
    for (const [, inner] of block.body.matchAll(/url\(([^)]*)\)/gi)) {
      expect(inner.trim().replace(/^['"]/, ''), `url(${inner})`).toMatch(/^#/)
    }

    // 没有外链：href / xlink:href / src 只能是 #片段
    for (const el of elementsOf(root)) {
      for (const name of el.getAttributeNames()) {
        if (!['href', 'xlink:href', 'src'].includes(name.toLowerCase())) continue
        expect(el.getAttribute(name), `${el.localName}[${name}]`).toMatch(/^#/)
      }
    }
  })
})

describe('范例图的取色只走 token（E3）', () => {
  const PAINT_ATTR =
    /\s(fill|stroke|stop-color|color|flood-color|lighting-color)\s*=\s*(["'])(.*?)\2/g
  const PAINT_VALUE = /^(none|var\(--(viz|theme)-[a-z0-9-]+\)|url\(#[^)]+\))$/

  it.each(ALL_BLOCKS.map((b) => [b.label, b] as const))('E3 %s', (_label, block) => {
    const paints = [...block.body.matchAll(PAINT_ATTR)]
    expect(paints.length, '一个取色属性都没有 —— 这张图/片段在测什么？').toBeGreaterThan(0)
    for (const [, attr, , value] of paints) {
      expect(value, `${attr}="${value}"`).toMatch(PAINT_VALUE)
    }

    // 十六进制颜色（url(#id) 里的 # 不算）
    expect(block.body).not.toMatch(/(?<!url\()#[0-9a-f]{3,8}\b/i)

    // 用到的每个 token 在 themes.css 里都有定义 —— 未定义的 var() 在 CSS 里是静默的
    for (const [, token] of block.body.matchAll(/var\((--[\w-]+)\)/g)) {
      expect(DEFINED.has(token), `${token} 在 themes.css 里没有定义`).toBe(true)
    }

    // 每个 <text> 实际生效的填色是文字色（不是系列色），字族是主题字族 ——
    // 唯一的例外是分类浅底上的字：那个槽位的 ink（--viz-N-ink，按对比度派生的深字）
    const root = parseRoot(
      svgFenceIsRenderable('svg', block.body) ? block.body : `<svg>${block.body}</svg>`
    )
    for (const text of root.querySelectorAll('text')) {
      const what = `<text>${text.textContent}</text>`
      expect(inherited(text, 'fill'), what).toMatch(/^var\(--(theme-text-[a-z]+|viz-[1-8]-ink)\)$/)
      expect(inherited(text, 'font-family'), what).toBe('var(--theme-font-sans)')
    }
  })

  it('非空证：分类后图与片段都扫到了，图里确实有 <text> 被检查', () => {
    // diagrams.md 两张、SKILL.md 一张（各三语）；style.md 只有片段
    expect(FIGURES.length).toBeGreaterThanOrEqual(9)
    expect(SNIPPETS.some((b) => b.source.snippetsOnly)).toBe(true)
    expect(SNIPPETS.length).toBeGreaterThan(0)
    const texts = FIGURES.reduce((n, b) => n + parseRoot(b.body).querySelectorAll('text').length, 0)
    expect(texts).toBeGreaterThan(0)
  })
})

describe('范例图原样通过聊天里的净化器（E4 / E5）', () => {
  it.each(FIGURES.map((b) => [b.label, b] as const))(
    'E4 %s：元素与属性一个不少，值除了 id 与 url(#…) 之外一字不改',
    (_label, block) => {
      const clean = sanitizeAuthoredSvg(block.body)
      expect(clean).not.toBe('')
      const before = elementsOf(parseRoot(block.body))
      const after = elementsOf(parseRoot(clean))
      expect(after.map((el) => el.localName)).toEqual(before.map((el) => el.localName))
      before.forEach((el, i) => {
        const out = after[i]
        const names = el.getAttributeNames().sort()
        expect(out.getAttributeNames().sort(), `${el.localName} #${i}`).toEqual(names)
        for (const name of names) {
          const value = el.getAttribute(name) ?? ''
          if (name === 'id' || value.includes('url(#')) continue
          expect(out.getAttribute(name), `${el.localName} #${i} [${name}]`).toBe(value)
        }
      })
    }
  )

  it.each(FIGURES.map((b) => [b.label, b] as const))(
    'E5 %s：id 加前缀之后，每个 marker 引用仍指向输出里真实存在的 marker',
    (_label, block) => {
      const MARKER_ATTRS = ['marker-start', 'marker-mid', 'marker-end']
      const refsOf = (root: Element): string[] =>
        elementsOf(root).flatMap((el) =>
          MARKER_ATTRS.map((a) => el.getAttribute(a)).filter((v): v is string => v !== null)
        )
      const input = parseRoot(block.body)
      const output = parseRoot(sanitizeAuthoredSvg(block.body))
      const outputMarkers = new Set([...output.querySelectorAll('marker')].map((m) => m.id))

      const refs = refsOf(output)
      expect(refs).toHaveLength(refsOf(input).length)
      for (const ref of refs) {
        const id = /^url\(#([^)]+)\)$/.exec(ref)?.[1]
        expect(id, ref).toBeDefined()
        expect(outputMarkers.has(id!), `${ref} 指向不存在的 marker`).toBe(true)
      }
      // 输入里的每个 marker 在输出里都换了名（按内容加前缀，两张图的同名 id 不再互相打架）
      for (const marker of input.querySelectorAll('marker')) {
        expect(outputMarkers.has(marker.id), `marker#${marker.id} 没被加前缀`).toBe(false)
        expect([...outputMarkers].some((id) => id.endsWith(`-${marker.id}`))).toBe(true)
      }
      if (block.source.isDiagrams) {
        // 非空证：两张范例图各有三根带箭头的线，`arrow` 这个 id 变成 s<hash>-arrow
        expect(refs).toHaveLength(3)
        expect([...outputMarkers].every((id) => /^s[0-9a-z]+-arrow$/.test(id))).toBe(true)
      }
    }
  )
})

describe('diagrams.md 的范例守自己的预算（E6）', () => {
  it('非空证：三语各两张带箭头的图', () => {
    expect(DIAGRAM_FIGURES.length).toBeGreaterThanOrEqual(6)
  })

  it.each(DIAGRAM_FIGURES.map((b) => [b.label, b] as const))('E6 %s', (_label, block) => {
    const root = parseRoot(block.body)
    const [minX, minY, width, height] = (root.getAttribute('viewBox') ?? '')
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    const inside = (x: number, y: number): boolean =>
      x >= minX && x <= minX + width && y >= minY && y <= minY + height

    const rects = [...root.querySelectorAll('rect')].map((r) => ({
      x: num(r, 'x'),
      y: num(r, 'y'),
      w: num(r, 'width'),
      h: num(r, 'height')
    }))
    // 最多 5 个框、一行最多 4 个
    expect(rects.length).toBeGreaterThan(0)
    expect(rects.length).toBeLessThanOrEqual(5)
    const perRow = new Map<number, number>()
    for (const r of rects) perRow.set(r.y, (perRow.get(r.y) ?? 0) + 1)
    expect(Math.max(...perRow.values())).toBeLessThanOrEqual(4)

    // 一切都在 viewBox 以内
    for (const r of rects) {
      expect(inside(r.x, r.y) && inside(r.x + r.w, r.y + r.h), `rect ${JSON.stringify(r)}`).toBe(
        true
      )
    }
    const lines = [...root.querySelectorAll('line')].map((l) => ({
      x1: num(l, 'x1'),
      y1: num(l, 'y1'),
      x2: num(l, 'x2'),
      y2: num(l, 'y2')
    }))
    for (const l of lines) {
      expect(inside(l.x1, l.y1) && inside(l.x2, l.y2), `line ${JSON.stringify(l)}`).toBe(true)
    }
    for (const t of root.querySelectorAll('text')) {
      expect(inside(num(t, 'x'), num(t, 'y')), `text「${t.textContent}」`).toBe(true)
    }

    // 箭头不穿过任何框的内部（停在边上可以）：沿线取点，严格落在框内即算穿过
    const EPS = 0.5
    const STEPS = 200
    const crossings = lines.flatMap((l) =>
      rects
        .filter((r) =>
          Array.from({ length: STEPS + 1 }, (_, i) => ({
            x: l.x1 + ((l.x2 - l.x1) * i) / STEPS,
            y: l.y1 + ((l.y2 - l.y1) * i) / STEPS
          })).some(
            ({ x, y }) =>
              x > r.x + EPS && x < r.x + r.w - EPS && y > r.y + EPS && y < r.y + r.h - EPS
          )
        )
        .map((r) => `line ${JSON.stringify(l)} 穿过 rect ${JSON.stringify(r)}`)
    )
    expect(lines.length).toBeGreaterThan(0)
    expect(crossings).toEqual([])
  })
})

describe('范例图只在技能里（E7）', () => {
  it.each(FRAGMENTS.map((f) => [f.name, f] as const))(
    'E7 %s：提示片段里没有 ```svg 块，也没有 <svg',
    (_name, fragment) => {
      // 正控制组：读到的是那份片段（它讲 ```svg 围栏、并叫模型先加载作图技能）
      expect(fragment.text, `${fragment.name} 读不到`).toContain('```svg')
      expect(fragment.text, fragment.name).toContain('builtin:drawing')
      // 范例搬进了 SKILL.md（E1 在那里钉它在场）；片段里再出现一张，就是契约又有了第二份
      expect(
        blocksOf({ ...fragment, isDiagrams: false, snippetsOnly: false, lang: '' }),
        fragment.name
      ).toEqual([])
      expect(fragment.text, fragment.name).not.toMatch(/<svg\b/i)
    }
  )
})

// ─── 观感（E8…E13）：style.md 教的规矩，范例自己先守 ─────────────────────────

/** 块的根：整张图就是它自己的 `<svg>`，片段先包一层 */
const rootOf = (block: Block): Element =>
  parseRoot(svgFenceIsRenderable('svg', block.body) ? block.body : `<svg>${block.body}</svg>`)

/** 元素自己 `style` 属性里某个声明的值；没有 = null */
const styleProp = (el: Element, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(el.getAttribute('style') ?? '')
  return m ? m[1].trim() : null
}

/** 某个表现属性的生效值：自己或祖先上的 style 声明或属性（同一元素上 style 优先） */
const effective = (el: Element, prop: string): string | null => {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const value = styleProp(cur, prop) ?? cur.getAttribute(prop)
    if (value !== null) return value.trim()
  }
  return null
}

/** 元素自己写的值（style 或属性），不沿祖先找 */
const own = (el: Element, prop: string): string | null =>
  styleProp(el, prop) ?? el.getAttribute(prop)

const viewBoxOf = (root: Element): number[] =>
  (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)

const BLOCK_CASES = ALL_BLOCKS.map((b) => [b.label, b] as const)
const FIGURE_CASES = FIGURES.map((b) => [b.label, b] as const)

describe('范例图的画布与字重（E8 / E9）', () => {
  it.each(FIGURE_CASES)('E8 %s：viewBox 是 0 0 640 H', (_label, block) => {
    const [minX, minY, width, height] = viewBoxOf(rootOf(block))
    expect([minX, minY, width], 'viewBox 的前三个数').toEqual([0, 0, 640])
    expect(height).toBeGreaterThan(0)
  })

  it.each(BLOCK_CASES)(
    'E9 %s：字重只有 400 / 500；13 号字是 500，11 号字不写字重或写 400',
    (_label, block) => {
      // 文本层扫一遍：属性写法与 style 里的写法都算
      const weights = [
        ...block.body.matchAll(/font-weight\s*(?:=\s*(["'])(.*?)\1|:\s*([^;"'}]+))/g)
      ].map((m) => (m[2] ?? m[3] ?? '').trim())
      for (const w of weights) expect(['400', '500'], `font-weight ${w}`).toContain(w)

      for (const text of rootOf(block).querySelectorAll('text')) {
        const what = `<text>${text.textContent}</text>`
        const size = parseFloat(effective(text, 'font-size') ?? '')
        const weight = effective(text, 'font-weight')
        if (size === 13) expect(weight, `${what} 13 号字`).toBe('500')
        if (size === 11) expect([null, '400'], `${what} 11 号字`).toContain(weight)
      }
    }
  )

  it('非空证：13 号与 11 号的 <text> 都扫到过（否则 E9 的两条字号规则在空转）', () => {
    const sizes = ALL_BLOCKS.flatMap((b) =>
      [...rootOf(b).querySelectorAll('text')].map((t) =>
        parseFloat(effective(t, 'font-size') ?? '')
      )
    )
    expect(sizes).toContain(13)
    expect(sizes).toContain(11)
  })
})

describe('范例图的线宽（E10）', () => {
  it.each(BLOCK_CASES)(
    'E10 %s：marker 之外的 stroke-width 只有 1 / 1.5，至多一处 1.5',
    (_label, block) => {
      const widths = [...rootOf(block).querySelectorAll('*')]
        // 箭头头的描边在 marker 自己的坐标里，不是图上的线宽
        .filter((el) => el.localName !== 'marker' && !el.closest('marker'))
        .map((el) => ({ el: el.localName, width: own(el, 'stroke-width') }))
        .filter((w): w is { el: string; width: string } => w.width !== null)
      for (const { el, width } of widths) {
        expect(['1', '1.5'], `${el} stroke-width=${width}`).toContain(width.trim())
      }
      const accents = widths.filter((w) => w.width.trim() === '1.5')
      expect(accents.length, `1.5 出现在 ${JSON.stringify(accents)}`).toBeLessThanOrEqual(1)
    }
  )
})

describe('分类浅底与同色深字（E11）', () => {
  interface TintBox {
    n: number
    x: number
    y: number
    w: number
    h: number
    stroke: string | null
    strokeWidth: string | null
  }
  const tintBoxes = (root: Element): TintBox[] =>
    [...root.querySelectorAll('rect')].flatMap((r) => {
      const slot = /^var\(--viz-(\d+)-tint\)$/.exec(effective(r, 'fill') ?? '')
      if (!slot) return []
      return [
        {
          n: Number(slot[1]),
          x: num(r, 'x'),
          y: num(r, 'y'),
          w: num(r, 'width'),
          h: num(r, 'height'),
          stroke: effective(r, 'stroke'),
          strokeWidth: own(r, 'stroke-width')
        }
      ]
    })
  const usesTint = (block: Block): boolean => /var\(--viz-\d+-tint\)/.test(block.body)

  it.each(BLOCK_CASES)(
    'E11 %s：ink 的字落在同槽位的 tint 框里、tint 框里的字用它的 ink、框描边是槽位本身、槽位从 1 连续取且 ≤ 3',
    (_label, block) => {
      const root = rootOf(block)
      const boxes = tintBoxes(root)
      for (const box of boxes) {
        const what = `tint 框 ${JSON.stringify(box)}`
        expect(box.stroke, what).toBe(`var(--viz-${box.n})`)
        expect([null, '1'], what).toContain(box.strokeWidth)
      }
      for (const text of root.querySelectorAll('text')) {
        const what = `<text>${text.textContent}</text>`
        const fill = effective(text, 'fill') ?? ''
        const x = num(text, 'x')
        const y = num(text, 'y')
        const around = boxes.filter((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h)
        const ink = /^var\(--viz-(\d+)-ink\)$/.exec(fill)
        if (ink) {
          expect(
            around.some((b) => b.n === Number(ink[1])),
            `${what} 用 ${fill}，却不在同槽位的 tint 框里`
          ).toBe(true)
        }
        for (const box of around)
          expect(fill, `${what} 在 viz-${box.n} 的 tint 框里`).toBe(`var(--viz-${box.n}-ink)`)
      }
      // 槽位按顺序取：用到的 tint 是 1..k，k ≤ 3
      const slots = [
        ...new Set([...block.body.matchAll(/var\(--viz-(\d+)-tint\)/g)].map((m) => Number(m[1])))
      ].sort((a, b) => a - b)
      if (slots.length > 0) {
        expect(slots.length, `用到的 tint 槽位 ${slots}`).toBeLessThanOrEqual(3)
        expect(slots).toEqual(slots.map((_, i) => i + 1))
      }
    }
  )

  it.each(LANGS)('正控制组 %s：至少一张整图与一段片段用到了 tint（否则 E11 在空转）', (lang) => {
    const mine = ALL_BLOCKS.filter((b) => b.source.lang === lang && usesTint(b))
    expect(mine.filter((b) => FIGURES.includes(b)).length, `${lang} 的整图`).toBeGreaterThan(0)
    expect(mine.filter((b) => SNIPPETS.includes(b)).length, `${lang} 的片段`).toBeGreaterThan(0)
    // 用到 tint 的块里真有 ink 字被检查
    const inks = mine.flatMap((b) =>
      [...rootOf(b).querySelectorAll('text')].filter((t) =>
        /^var\(--viz-\d+-ink\)$/.test(effective(t, 'fill') ?? '')
      )
    )
    expect(inks.length).toBeGreaterThan(0)
  })
})

describe('范例图的文字与平面（E12 / E13）', () => {
  const EMOJI = /\p{Extended_Pictographic}/u
  const CIRCLED = /[①-⓿]/

  it.each(BLOCK_CASES)(
    'E12 %s：<text> 与根的 aria-label 里没有 emoji、没有带圈数字',
    (_label, block) => {
      const root = rootOf(block)
      const strings = [
        ...[...root.querySelectorAll('text')].map((t) => t.textContent ?? ''),
        root.getAttribute('aria-label') ?? ''
      ]
      for (const s of strings) {
        expect(s, `emoji：${s}`).not.toMatch(EMOJI)
        expect(s, `带圈数字：${s}`).not.toMatch(CIRCLED)
      }
    }
  )

  it('E12 自检：两条正则真的认得出 emoji 与带圈数字', () => {
    expect('\u{1F680} launch').toMatch(EMOJI)
    expect('① step').toMatch(CIRCLED)
    expect('Step 1 · 订单 · 12.5%').not.toMatch(EMOJI)
    expect('Step 1 · 订单 · 12.5%').not.toMatch(CIRCLED)
  })

  it.each(BLOCK_CASES)(
    'E13 %s：没有渐变与滤镜；文字不调透明度；没有铺满整张图的背景框',
    (_label, block) => {
      expect(block.body).not.toMatch(/<(linearGradient|radialGradient|filter|fe[A-Z][A-Za-z]*)\b/)
      const root = rootOf(block)
      for (const el of root.querySelectorAll('*')) {
        expect(el.localName, '渐变 / 滤镜元素').not.toMatch(
          /^(lineargradient|radialgradient|filter|fe[a-z]+)$/i
        )
      }
      for (const text of root.querySelectorAll('text')) {
        for (
          let cur: Element | null = text;
          cur && cur !== root.parentElement;
          cur = cur.parentElement
        ) {
          for (const prop of ['opacity', 'fill-opacity']) {
            expect(own(cur, prop), `<text>${text.textContent}</text> 的 ${prop}`).toBeNull()
          }
        }
      }
      if (!FIGURES.includes(block)) return
      const [minX, minY, width, height] = viewBoxOf(root)
      for (const r of root.querySelectorAll('rect')) {
        const full =
          (r.getAttribute('width') === '100%' && r.getAttribute('height') === '100%') ||
          (num(r, 'x') <= minX &&
            num(r, 'y') <= minY &&
            num(r, 'x') + num(r, 'width') >= minX + width &&
            num(r, 'y') + num(r, 'height') >= minY + height)
        expect(full, `铺满整张图的 rect：${r.outerHTML}`).toBe(false)
      }
    }
  )
})
