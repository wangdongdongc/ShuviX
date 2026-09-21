// @vitest-environment jsdom
/**
 * 教给模型的**范例图**本身得是对的 —— 作图技能的 `references/diagrams.md`（三语）与三份
 * visual-guide 提示片段里的 ```svg 块，逐张过一遍它们自己教的契约。
 *
 * 为什么要这一组：范例是模型最会照抄的东西。一张范例里写了十六进制颜色、`width`/`height`、
 * 一行塞三个元素、或者一个会被净化器剥掉的属性，模型就会把同样的错画进每一张图 —— 而那些错
 * 在提示词的散文里是看不出来的，只有把范例当成一张真图去检查才看得见。
 *
 * 块的分类与聊天里的 CodeBlock 同一把尺子（`svgFenceIsRenderable`）：能渲染的是**图**
 * （figure），不能的是**片段**（snippet，例如只有一个 `<defs><marker>` 的那段）。
 *
 *  - E1 在场：diagrams.md 各有一张带箭头的图，片段各有一张图；图都写完了，片段里没有 `<svg`；
 *  - E2 契约（只对图）：viewBox、不写宽高、role/aria-label、一行一个元素、字号 ≥ 11、
 *    没有被禁的标签、`url()` 只指片段内、没有外链；
 *  - E3 取色（图与片段）：颜色只取 token（或 none / url(#…)），没有十六进制，用到的 token 在
 *    themes.css 里都有定义，每个 `<text>` 实际生效的填色是文字色、字族是 --theme-font-sans；
 *  - E4 过净化器（sanitizeAuthoredSvg，聊天里的那一档）原样通过：元素、属性一个不少，值除了
 *    按内容加前缀的 id 与对它的 url(#…) 引用之外一字不改；
 *  - E5 箭头：marker 引用在 id 加前缀之后仍指向输出里真实存在的 marker；
 *  - E6 预算（只对 diagrams.md 的图）：框数、同一行的框数、元素都在 viewBox 里、连线不穿框。
 *
 * ⚠️ 放在这里而不是 `apps/desktop/src/main/services/__tests__`（技能资源那组 BS 用例的邻居）：
 * 那个目录由 tsconfig.node.json 做类型检查（lib 只有 ES2022），而这一组要 DOMParser，并且会把
 * svgSanitize.ts 拉进 node 那张图（它在那里被刻意排除）。app-shell 走 web / 扩展两套配置，
 * 而且隔壁的 themes.test.ts 本来就在跨包读这几份片段、比对这份 themes.css。
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
}

const SOURCES: Source[] = [
  ...['en', 'zh', 'ja'].map((lang) => {
    const path = join(
      REPO_ROOT,
      'apps/desktop/resources/skills',
      lang,
      'drawing/references/diagrams.md'
    )
    return {
      name: `skills/${lang}/drawing/references/diagrams.md`,
      text: existsSync(path) ? readFileSync(path, 'utf8') : '',
      isDiagrams: true
    }
  }),
  ...['visual-guide.md', 'visual-guide.zh.md', 'visual-guide.ja.md'].map((file) => ({
    name: `fragments/${file}`,
    text: readFileSync(
      join(REPO_ROOT, 'packages/agent-runtime/src/agentProfile/fragments', file),
      'utf8'
    ),
    isDiagrams: false
  }))
]

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
    'E1 %s：有图；图都写完了；片段里没有 <svg',
    (_name, source) => {
      expect(source.text, `${source.name} 读不到`).not.toBe('')
      const blocks = blocksOf(source)
      const figures = blocks.filter((b) => svgFenceIsRenderable('svg', b.body))
      expect(figures.length, '一张图都没有').toBeGreaterThan(0)
      if (source.isDiagrams) {
        // 讲箭头的那份参考，范例里得真有一根带箭头的线
        expect(figures.some((b) => b.body.includes('marker-end'))).toBe(true)
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

    // 每个 <text> 实际生效的填色是文字色（不是系列色），字族是主题字族
    const root = parseRoot(
      svgFenceIsRenderable('svg', block.body) ? block.body : `<svg>${block.body}</svg>`
    )
    for (const text of root.querySelectorAll('text')) {
      const what = `<text>${text.textContent}</text>`
      expect(inherited(text, 'fill'), what).toMatch(/^var\(--theme-text-[a-z]+\)$/)
      expect(inherited(text, 'font-family'), what).toBe('var(--theme-font-sans)')
    }
  })

  it('非空证：分类后图与片段都扫到了，图里确实有 <text> 被检查', () => {
    expect(FIGURES.length).toBeGreaterThanOrEqual(SOURCES.length)
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
        // 非空证：迁移那张图有三根带箭头的线，`arrow` 这个 id 变成 s<hash>-arrow
        expect(refs).toHaveLength(3)
        expect([...outputMarkers].every((id) => /^s[0-9a-z]+-arrow$/.test(id))).toBe(true)
      }
    }
  )
})

describe('diagrams.md 的范例守自己的预算（E6）', () => {
  it('非空证：三语各一张带箭头的图', () => {
    expect(DIAGRAM_FIGURES.length).toBeGreaterThanOrEqual(3)
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
