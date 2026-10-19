// @vitest-environment jsdom
/**
 * 作图技能教给模型的 ```mermaid **范例**本身得是对的 —— 与隔壁 builtinSkillsFigures.dom.test.ts
 * 对 ```svg 范例做的事同一个理由：范例是模型最会照抄的东西。范例里写了一句 `style`、两个
 * `:::accent`、或者十几个节点，模型就会把同样的东西写进每一张图，而那在散文里看不出来。
 *
 * 2026-10-19：drawing 技能按图的种类分两种载体，约定俗成的图写 ```mermaid（pele 渲染），契约
 * 在 `references/mermaid.md`。这一组拿**真 pele**（与产品同一个版本、同一条路：
 * chat-protocol 的 renderMermaidFigure → sanitizeAuthoredSvg）把技能里每一个 ```mermaid 块渲一遍，
 * 再按那一页教的契约与预算逐张过：
 *
 *  - MM-0 前提：jsdom 有 DOMParser，净化器跑得出东西；
 *  - MM-1 在场：每种语言都有范例、en 与 zh 的张数相同、至少一张用了 `:::accent`；
 *  - MM-2 真能画：渲染得出一张图（不是错误卡），净化没有剥掉节点，`accTitle` 成了图的 `<title>`；
 *  - MM-3 契约：有 `accTitle:`、没有 frontmatter / `title:`、不写颜色（style / classDef / linkStyle /
 *    `%%{` / themeVariables / 十六进制）、类名只有 accent 且至多一个、没有 click、标注里没有 `<br>` 以外的 HTML；
 *  - MM-4 预算：流程 / 状态 / 实体 / 类图 ≤ 10 个节点；时序 ≤ 5 个参与方、≤ 12 条消息；排期 ≤ 12 个任务；
 *    节点标注约 5 个词或 10 个汉字以内，边上标注 3 个词（或 6 个汉字）以内；
 *  - MM-5 强调的着色接线：themes.css 的 `.pele .pele-node.accent` 规则依赖 pele 的三件内部细节 ——
 *    `:::accent` 原样挂到节点的 `<g class>` 上、形状的 fill / stroke 是 `var(--_s)` / `var(--_b)`、
 *    标注是 `text.pele-label` 且自己不写 fill。pele 锁定了版本，这里钉住它们过了净化还在。
 *
 * 放在 app-shell 而不是技能资源那组 BS 用例旁边：要 DOMParser（理由同 builtinSkillsFigures.dom.test.ts）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { detectType, load, render as peleRender } from 'pele/lazy'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeAuthoredSvg } from '@shuvix/chat-protocol/utils/svgSanitize'
import { renderMermaidFigure, type MermaidEngine } from '@shuvix/chat-protocol/utils/mermaidFence'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `packages/app-shell/src` 往上三层 */
const REPO_ROOT = resolve(HERE, '../../..')
const SKILLS_ROOT = join(REPO_ROOT, 'apps/desktop/resources/skills')
const LANGS = ['en', 'zh', 'ja']

// jsdom 没有画布：pele 退回自带的字宽表（与 chat-ui mermaidBlock.dom.test 同一个桩；不桩时 jsdom
// 每次量字都往控制台打一条 "Not implemented"）。必须在第一次渲染之前桩好，尺寸才确定
const realGetContext = HTMLCanvasElement.prototype.getContext
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext
})
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext
})

/** pele 的 render 就是注入给 renderMermaidFigure 的引擎（产品里两个消费方也是这样注入的） */
const ENGINE: MermaidEngine = { render: peleRender }

interface Block {
  lang: string
  label: string
  body: string
}

/** drawing 技能某种语言下的全部 md（SKILL.md + references/*.md），相对技能根 */
const drawingFiles = (lang: string): string[] => {
  const dir = join(SKILLS_ROOT, lang, 'drawing')
  const refs = existsSync(join(dir, 'references'))
    ? readdirSync(join(dir, 'references'))
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => `references/${f}`)
    : []
  return ['SKILL.md', ...refs]
}

/** 行首 ```mermaid 到行首 ``` 之间的块体（不含围栏行） */
const blocksOf = (lang: string): Block[] =>
  drawingFiles(lang).flatMap((rel) => {
    const text = readFileSync(join(SKILLS_ROOT, lang, 'drawing', rel), 'utf8')
    return [...text.matchAll(/^```mermaid\n([\s\S]*?)^```$/gm)].map((m, i) => ({
      lang,
      label: `${lang}/drawing/${rel} #${i}`,
      body: m[1]
    }))
  })

const BLOCKS = LANGS.flatMap(blocksOf)

/** 净化后的图解析成 DOM 根（按 HTML 解析，与净化器同一种解析） */
const parseRoot = (markup: string): Element => {
  const root = new DOMParser().parseFromString(markup, 'text/html').body.querySelector('svg')
  if (!root) throw new Error(`解析不出 <svg>：${markup.slice(0, 80)}`)
  return root
}

/** 按技能里的那一份真渲一次（图类型懒加载，与产品一样先 load） */
const renderBlock = async (body: string): Promise<{ svg: string; raw: string }> => {
  const type = detectType(body)
  expect(type, '认不出图类型').not.toBeNull()
  expect(await load(type!), `${type} 加载失败`).toBe(true)
  const result = renderMermaidFigure(ENGINE, body, { closed: true, fontSize: 13 })
  expect(result, '围栏是闭合的，不该返回 null').not.toBeNull()
  if (!result || 'error' in result) throw new Error(`渲染失败：${result?.error}`)
  return { svg: result.figure.svg, raw: peleRender(body, {}).svg }
}

const CJK = /[぀-ヿ㐀-鿿]/g
/** 一段标注的「长度」：拉丁文按词数，中日文按字数（两种标尺各自对上限） */
const labelSize = (text: string): { words: number; cjk: number } => {
  const cjk = (text.match(CJK) ?? []).length
  const words = text.replace(CJK, ' ').trim().split(/\s+/).filter(Boolean).length
  return { words, cjk }
}

describe('mermaid 范例：前提与在场（MM-0 / MM-1）', () => {
  it('MM-0 jsdom 有 DOMParser，净化器在这里真的能跑出东西', () => {
    expect(typeof DOMParser).toBe('function')
    expect(sanitizeAuthoredSvg('<svg viewBox="0 0 4 4"><rect/></svg>')).not.toBe('')
  })

  it.each(LANGS)('MM-1 %s：有范例，至少一张用了 :::accent', (lang) => {
    const blocks = BLOCKS.filter((b) => b.lang === lang)
    expect(blocks.length, `${lang} 一个 \`\`\`mermaid 范例都没有`).toBeGreaterThan(0)
    expect(blocks.some((b) => b.body.includes(':::accent'))).toBe(true)
  })

  it('MM-1 en 与 zh 的范例张数相同（ja 是 en 的副本，BS-12 管它）', () => {
    expect(BLOCKS.filter((b) => b.lang === 'zh').length).toBe(
      BLOCKS.filter((b) => b.lang === 'en').length
    )
  })
})

describe('mermaid 范例守自己教的契约（MM-2 / MM-3）', () => {
  it.each(BLOCKS.map((b) => [b.label, b] as const))('MM-2 %s 真能画', async (_label, block) => {
    const { svg, raw } = await renderBlock(block.body)
    const root = parseRoot(svg)
    expect(root.getAttribute('class') ?? '').toMatch(/\bpele\b/)
    // 净化没剥掉节点：净化前后 .pele-node 一样多
    const rawNodes = parseRoot(raw).querySelectorAll('.pele-node').length
    expect(rawNodes).toBeGreaterThan(0)
    expect(root.querySelectorAll('.pele-node').length).toBe(rawNodes)
    // accTitle 是图的标题（技能说它就像 ```svg 的 aria-label）
    const accTitle = /^\s*accTitle:\s*(.+)$/m.exec(block.body)?.[1].trim()
    expect(accTitle).toBeTruthy()
    expect(root.querySelector('title')?.textContent?.trim()).toBe(accTitle)
  })

  it.each(BLOCKS.map((b) => [b.label, b] as const))('MM-3 %s', (_label, block) => {
    const body = block.body
    expect(body, '名字用 accTitle:').toMatch(/^\s*accTitle:\s*\S/m)
    expect(body.trimStart().startsWith('---'), '写了 frontmatter').toBe(false)
    expect(body, 'title: 会在图里画一个标题').not.toMatch(/^\s*title\s*:/m)
    // 一个颜色都不写
    expect(body, 'style').not.toMatch(/^\s*style\s/m)
    expect(body, 'classDef').not.toMatch(/classDef/)
    expect(body, 'linkStyle').not.toMatch(/linkStyle/)
    expect(body, '%%{init}%%').not.toContain('%%{')
    expect(body, 'themeVariables').not.toMatch(/themeVariables/)
    expect(body, '十六进制颜色').not.toMatch(/#[0-9a-f]{3,8}\b/i)
    // 类名只有 accent，至多一个
    const classes = [...body.matchAll(/:::([\w-]+)/g)].map((m) => m[1])
    expect(
      classes.filter((c) => c !== 'accent'),
      '除 accent 之外的类名'
    ).toEqual([])
    expect(classes.length, ':::accent 的个数').toBeLessThanOrEqual(1)
    expect(body, 'class 语句').not.toMatch(/^\s*class\s+\S+\s+\S+/m)
    // 不出图的东西
    expect(body, 'click').not.toMatch(/^\s*click\s/m)
    expect(body.replace(/<br\s*\/?>/gi, ''), '<br> 之外的 HTML').not.toMatch(/<[a-z/][^>]*>/i)
  })
})

describe('mermaid 范例守预算（MM-4）', () => {
  it.each(BLOCKS.map((b) => [b.label, b] as const))('MM-4 %s', async (_label, block) => {
    const { svg } = await renderBlock(block.body)
    const root = parseRoot(svg)
    const kind = /\bpele-([\w-]+)/.exec(
      (root.getAttribute('class') ?? '').replace(/\bpele\b/, '')
    )?.[1]
    expect(kind, '根上认不出图的种类').toBeTruthy()

    const textOf = (el: Element): string => (el.textContent ?? '').trim()
    if (kind === 'sequence') {
      const participants = new Set(
        [...root.querySelectorAll('.pele-actor')].map((el) => el.getAttribute('data-id'))
      )
      expect(participants.size, '参与方').toBeGreaterThan(0)
      expect(participants.size, '参与方').toBeLessThanOrEqual(5)
      const messages = root.querySelectorAll('.pele-message').length
      expect(messages, '消息').toBeGreaterThan(0)
      expect(messages, '消息').toBeLessThanOrEqual(12)
    } else if (kind === 'gantt' || kind === 'timeline') {
      const tasks = root.querySelectorAll(kind === 'gantt' ? '.pele-task' : '.pele-event').length
      expect(tasks, '任务').toBeGreaterThan(0)
      expect(tasks, '任务').toBeLessThanOrEqual(12)
    } else {
      // 流程 / 状态 / 实体 / 类：状态图的起止圆点不算节点
      const nodes = new Set(
        [...root.querySelectorAll('.pele-node')]
          .filter(
            (el) =>
              !el.classList.contains('pele-state-start') && !el.classList.contains('pele-state-end')
          )
          .map((el) => el.getAttribute('data-id'))
      )
      expect(nodes.size, '节点').toBeGreaterThan(0)
      expect(nodes.size, '节点').toBeLessThanOrEqual(10)
    }

    // 节点标注：约 5 个词，或 10 个汉字
    const nodeLabels = [...root.querySelectorAll('.pele-node .pele-label')].map(textOf)
    expect(nodeLabels.length, '节点标注').toBeGreaterThan(0)
    for (const label of nodeLabels) {
      const { words, cjk } = labelSize(label)
      expect(words, `节点标注「${label}」`).toBeLessThanOrEqual(5)
      expect(cjk, `节点标注「${label}」`).toBeLessThanOrEqual(10)
    }
    // 边上标注（时序图的消息另算，上面已经数过条数）：3 个词，或 6 个汉字
    if (kind !== 'sequence') {
      for (const el of root.querySelectorAll('.pele-edge-label')) {
        const { words, cjk } = labelSize(textOf(el))
        expect(words, `边上标注「${textOf(el)}」`).toBeLessThanOrEqual(3)
        expect(cjk, `边上标注「${textOf(el)}」`).toBeLessThanOrEqual(6)
      }
    }
  })
})

describe('强调节点的着色接线：pele 的内部细节（MM-5）', () => {
  const ACCENT_SOURCES = [
    // 最小的一张：一个矩形节点强调
    'flowchart LR\n  accTitle: t\n  a[Plan] --> b[Ship]:::accent',
    // 几种形状各强调一张（菱形、圆角、圆柱）
    'flowchart TD\n  accTitle: t\n  a[Start] --> b{Check}:::accent',
    'flowchart TD\n  accTitle: t\n  a[Start] --> b(Round):::accent',
    'flowchart TD\n  accTitle: t\n  a[Start] --> b[(Store)]:::accent',
    // 技能里真写了 :::accent 的那些范例
    ...BLOCKS.filter((b) => b.body.includes(':::accent')).map((b) => b.body)
  ]

  it.each(ACCENT_SOURCES.map((s) => [s.split('\n')[0], s] as const))(
    'MM-5 %s：accent 过了净化仍挂在节点 <g> 上，形状取 var(--_s) / var(--_b)，标注是不写 fill 的 .pele-label',
    async (_head, source) => {
      const { svg } = await renderBlock(source)
      const root = parseRoot(svg)

      // 根上声明了 --_s / --_b 这两个中转变量（.pele-node.accent 改的就是它们）
      const rootStyle = root.getAttribute('style') ?? ''
      expect(rootStyle).toMatch(/--_s\s*:\s*var\(--pele-surface/)
      expect(rootStyle).toMatch(/--_b\s*:\s*var\(--pele-border/)

      const accents = root.querySelectorAll('g.pele-node.accent')
      expect(accents, '恰好一个 g.pele-node.accent').toHaveLength(1)
      const node = accents[0]

      // 形状：至少一个用 var(--_s) 填色，描边都是 var(--_b)（fill="none" 的装饰线不算填色）
      const shapes = [...node.children].filter((el) =>
        ['rect', 'path', 'polygon', 'circle', 'ellipse'].includes(el.tagName.toLowerCase())
      )
      expect(shapes.length, '节点里的形状').toBeGreaterThan(0)
      expect(shapes.some((el) => el.getAttribute('fill') === 'var(--_s)')).toBe(true)
      for (const el of shapes) {
        const fill = el.getAttribute('fill')
        expect(fill === 'var(--_s)' || fill === 'none', `形状 fill=${fill}`).toBe(true)
        expect(el.getAttribute('stroke'), '形状描边').toBe('var(--_b)')
      }

      // 标注：text.pele-label，自己不写 fill（颜色要交给 .pele-node.accent .pele-label）
      const labels = node.querySelectorAll('text.pele-label')
      expect(labels.length, '节点标注').toBeGreaterThan(0)
      for (const label of labels) {
        expect(label.hasAttribute('fill'), '标注自己写了 fill').toBe(false)
        expect(label.getAttribute('style') ?? '').not.toMatch(/fill/)
      }

      // 别的节点不带 accent
      const others = [...root.querySelectorAll('g.pele-node')].filter((g) => g !== node)
      expect(others.length).toBeGreaterThan(0)
      for (const g of others) expect(g.classList.contains('accent')).toBe(false)
    }
  )
})
