// @vitest-environment jsdom
/**
 * 教给模型的**交互块范例**本身得是对的 —— 作图技能 `references/interactive.md`（三语；ja 是英文
 * 副本）里那块 ```interactive，逐条过一遍它自己教的契约。邻居 builtinSkillsFigures.dom.test.ts
 * 对 ```svg 范例做的是同一件事，理由也一样：范例是模型最会照抄的东西，一块范例里写了一个
 * `fetch(`、一个十六进制颜色、或者先用 `Chart` 再加载 chart.js，模型就会把同样的错写进每一块 ——
 * 而那些错在散文里看不出来，只有把范例当成一块真的交互图去检查才看得见。
 *
 *  - SK-1 在场：每份恰好一块，非空、围栏闭合（与聊天里判定闭合的是同一个函数）；
 *  - SK-2 开头是 `<title>`：它就是认领后的文件名；块里不能有一张自带 `<title>` / aria-label 的
 *    SVG —— artifact 的 `titleOf` 曾经会被它抢走整块的名字；
 *  - SK-3 库：`<script src>` 只能是 `shuvix-lib://<SANDBOX_LIBS 里的名字>`，且排在用它全局名的
 *    内联脚本之前；
 *  - SK-4 沙箱里用不了的 API 一个都不出现（网络、存储、eval、表单提交、弹框、视口高度）；
 *  - SK-5 取色：`var(--x)` 与 `shuvix.color('--x')` 用到的 token 都在注入名单里，CSS 与属性值里
 *    没有十六进制颜色；
 *  - SK-6 放进 `buildSandboxDocument` 之后，head 里恰一条 CSP、就是 SANDBOX_CSP，范例自己的
 *    `<title>` 与脚本都落在 body 里（排在 CSP 之后，改不动它）；
 *  - SK-7 技能与参考都带着那个前提：**只在系统提示讲了交互块时才写** —— tab 基座与派发出来的
 *    coding 也握着这个技能，而它们的回复显示在跑不了交互块的地方；
 *  - SK-8 同一个前提也跟着观感那一页（`references/style.md` 的交互零件）与 SKILL.md 里每一处提到
 *    交互块的地方走 —— 前提只写在一处，模型从另一处读到的就是「可以写」；
 *  - SK-9 观感那一页的每段 ```html 零件守同一套沙箱规矩（禁用 API、注入的 token、没有十六进制、
 *    两种字重、没有 emoji），而且不重新设计宿主已经给了样式的裸标签；
 *  - SK-10 交互块范例把 Chart.js 的观感（颜色、线宽、点、图例、动画）留给宿主的缺省值，只管尺寸：
 *    外层定高 + `maintainAspectRatio: false`。
 *
 * 块的抽取用行首锚定的正则：zh 那份开头的散文行就以 ```interactive 起头，不锚住会把散文当成块。
 * 放在 app-shell（而不是桌面的技能资源测试旁边）的理由同邻居：要 DOMParser，桌面 node 那张
 * tsconfig 没有 DOM。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SANDBOX_CSP,
  SANDBOX_LIBS,
  SANDBOX_THEME_TOKENS,
  buildSandboxDocument,
  fenceSourceIsClosed
} from '@shuvix/chat-protocol/utils/interactiveFence'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `packages/app-shell/src` 往上三层 */
const REPO_ROOT = resolve(HERE, '../../..')

const LANGUAGES = ['en', 'zh', 'ja'] as const

const skillFile = (lang: string, rel: string): { name: string; text: string } => ({
  name: `skills/${lang}/drawing/${rel}`,
  text: readFileSync(join(REPO_ROOT, 'apps/desktop/resources/skills', lang, 'drawing', rel), 'utf8')
})

const REFS = LANGUAGES.map((lang) => ({ lang, ...skillFile(lang, 'references/interactive.md') }))

/** 行首 ```interactive 到行首 ``` 之间的块体（不含围栏行本身） */
const blocksOf = (text: string): string[] =>
  [...text.matchAll(/^```interactive\n([\s\S]*?)^```$/gm)].map((m) => m[1])

/** 每份参考里那唯一的一块（SK-1 先钉「恰一块」，其余用例直接取） */
const EXAMPLES = REFS.map((ref) => ({ ...ref, body: blocksOf(ref.text)[0] ?? '' }))

const parse = (markup: string): Document => new DOMParser().parseFromString(markup, 'text/html')

/** 去掉 frontmatter 后按空行切段 */
const bodyParagraphs = (text: string): string[] =>
  text
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean)

/** 沙箱里用不了的 API（SK-4 与 SK-9 共用）：网络、存储、eval、表单提交、弹框、视口高度 */
const FORBIDDEN_APIS: ReadonlyArray<readonly [string, RegExp]> = [
  ['http(s)://', /https?:\/\//i],
  ['协议相对的 //', /(["'(=]\s*)\/\/[A-Za-z0-9]/],
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['localStorage', /localStorage/],
  ['sessionStorage', /sessionStorage/],
  ['indexedDB', /indexedDB/],
  ['eval(', /\beval\s*\(/],
  ['new Function', /new\s+Function\b/],
  ['csvParse', /csvParse/],
  ['<form', /<form\b/i],
  ['alert(', /\balert\s*\(/],
  ['confirm(', /\bconfirm\s*\(/],
  ['prompt(', /\bprompt\s*\(/],
  ['100vh', /100vh/],
  ['height: 100%', /height\s*:\s*100%/]
]

/** 文本里用到的 token：`var(--x)` 与 `shuvix.color('--x')` */
const tokensUsed = (text: string): string[] => [
  ...[...text.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*\)/g)].map((m) => m[1]),
  ...[...text.matchAll(/shuvix\.color\(\s*['"](--[A-Za-z0-9-]+)['"]\s*\)/g)].map((m) => m[1])
]

/** 一份文档里所有 `<style>` 的声明值（`prop: value` 的 value） */
const cssValuesOf = (doc: Document): string[] =>
  [...doc.querySelectorAll('style')].flatMap((style) =>
    [...(style.textContent ?? '').matchAll(/:\s*([^;{}]+)/g)].map((m) => m[1])
  )

/** 一份文档里所有 `<style>` 的 font-weight 取值 */
const cssWeightsOf = (doc: Document): string[] =>
  [...doc.querySelectorAll('style')].flatMap((style) =>
    [...(style.textContent ?? '').matchAll(/font-weight\s*:\s*([^;{}]+)/g)].map((m) => m[1].trim())
  )

interface CssRule {
  selectors: string[]
  decls: Array<[string, string]>
}
/** 一份文档里所有 `<style>` 的平铺规则（范例里没有 @ 规则与嵌套） */
const cssRulesOf = (doc: Document): CssRule[] =>
  [...doc.querySelectorAll('style')].flatMap((style) =>
    [...(style.textContent ?? '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selectors: m[1].split(',').map((sel) => sel.trim()),
      decls: m[2]
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const at = d.indexOf(':')
          return [d.slice(0, at).trim(), d.slice(at + 1).trim()] as [string, string]
        })
    }))
  )

const HEX = /#[0-9a-f]{3,8}\b/i

describe('交互块范例：在场与标题（SK-1 / 2）', () => {
  it.each(REFS.map((r) => [r.name, r] as const))(
    'SK-1 %s：恰一块 ```interactive，非空，围栏闭合',
    (_name, ref) => {
      const blocks = blocksOf(ref.text)
      expect(blocks, ref.name).toHaveLength(1)
      expect(blocks[0].trim().length).toBeGreaterThan(100)
      expect(fenceSourceIsClosed('```interactive\n' + blocks[0] + '```')).toBe(true)
    }
  )

  it.each(EXAMPLES.map((e) => [e.name, e] as const))(
    'SK-2 %s：以非空的 <title> 开头；块里没有自带 <title> / aria-label 的 <svg>',
    (_name, example) => {
      const lead = /^<title>([^<]*)<\/title>/.exec(example.body.trim())
      expect(lead, '范例没有以 <title> 开头').not.toBeNull()
      expect(lead![1].trim()).not.toBe('')
      for (const svg of parse(example.body).querySelectorAll('svg')) {
        expect(svg.hasAttribute('aria-label'), 'svg 带 aria-label').toBe(false)
        expect(svg.querySelector('title'), 'svg 带 <title>').toBeNull()
      }
      // 文本层再兜一次（DOMParser 之外的写法也挡住）
      expect(example.body).not.toMatch(/<svg\b[^>]*\saria-label\s*=/i)
      expect(example.body).not.toMatch(/<svg\b[^>]*>\s*<title/i)
    }
  )
})

describe('交互块范例：库、禁用 API、取色（SK-3…5）', () => {
  it.each(EXAMPLES.map((e) => [e.name, e] as const))(
    'SK-3 %s：<script src> 只指向 shuvix-lib://<库名>，且排在用它全局名的内联脚本之前',
    (_name, example) => {
      const scripts = [...parse(example.body).querySelectorAll('script')]
      const loadedAt = new Map<string, number>()
      scripts.forEach((script, i) => {
        const src = script.getAttribute('src')
        if (src === null) return
        const lib = /^shuvix-lib:\/\/(.+)$/.exec(src)?.[1]
        expect(lib, `外部脚本 ${src}`).toBeDefined()
        expect(Object.keys(SANDBOX_LIBS), `未知库 ${src}`).toContain(lib)
        loadedAt.set(lib!, i)
      })
      expect(loadedAt.size, '范例一个库都没加载 —— 这条在测什么？').toBeGreaterThan(0)

      let uses = 0
      scripts.forEach((script, i) => {
        if (script.hasAttribute('src')) return
        for (const [lib, { global }] of Object.entries(SANDBOX_LIBS)) {
          if (!new RegExp(`\\b${global}\\b`).test(script.textContent ?? '')) continue
          uses++
          expect(loadedAt.has(lib), `用了 ${global} 却没加载 ${lib}`).toBe(true)
          expect(loadedAt.get(lib)!, `${lib} 排在用它的内联脚本之后`).toBeLessThan(i)
        }
      })
      expect(uses, '内联脚本一个库全局名都没用').toBeGreaterThan(0)
    }
  )

  it.each(EXAMPLES.map((e) => [e.name, e] as const))(
    'SK-4 %s：沙箱里用不了的 API 一个都不出现',
    (_name, example) => {
      for (const [what, re] of FORBIDDEN_APIS) expect(example.body, what).not.toMatch(re)
      // 正控制组：范例确实会跟宿主说话（sendPrompt 不被上面的 `prompt(` 误伤）
      expect(example.body).toContain('shuvix.sendPrompt(')
    }
  )

  it.each(EXAMPLES.map((e) => [e.name, e] as const))(
    'SK-5 %s：var(--x) 与 shuvix.color(--x) 用到的 token 都在注入名单里；CSS 与属性值里没有十六进制颜色；字重只有 400 / 500',
    (_name, example) => {
      const used = tokensUsed(example.body)
      expect(used.length, '范例一个 token 都没用').toBeGreaterThan(0)
      for (const token of used) expect(SANDBOX_THEME_TOKENS, token).toContain(token)

      const doc = parse(example.body)
      const declarations = cssValuesOf(doc)
      expect(declarations.length, '范例没有样式声明 —— 这条在测什么？').toBeGreaterThan(0)
      for (const value of declarations) expect(value, `CSS 值 ${value}`).not.toMatch(HEX)
      // SK-5b 两种字重：CSS 里的 font-weight 只有 400 / 500
      for (const w of cssWeightsOf(doc)) expect(['400', '500'], `font-weight: ${w}`).toContain(w)
      for (const el of doc.querySelectorAll('*')) {
        for (const attr of el.getAttributeNames()) {
          const value = el.getAttribute(attr) ?? ''
          expect(value, `${el.localName}[${attr}]`).not.toMatch(HEX)
        }
      }
    }
  )
})

describe('交互块范例：放进沙箱文档（SK-6）', () => {
  it.each(EXAMPLES.map((e) => [e.name, e] as const))(
    'SK-6 %s：head 里恰一条 CSP 且就是 SANDBOX_CSP；范例的 <title> 与脚本都落在 body 里',
    (_name, example) => {
      const doc = parse(
        buildSandboxDocument({ body: example.body, tokens: {}, colorScheme: 'light' })
      )
      const csp = doc.head.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')
      expect(csp).toHaveLength(1)
      expect(csp[0].getAttribute('content')).toBe(SANDBOX_CSP)
      expect(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')).toHaveLength(1)

      // head 里只有宿主的桥那一个脚本；范例自己的每个脚本都在 body 里
      expect(doc.head.querySelectorAll('script')).toHaveLength(1)
      const ownScripts = parse(example.body).querySelectorAll('script').length
      expect(ownScripts).toBeGreaterThan(0)
      expect(doc.body.querySelectorAll('script')).toHaveLength(ownScripts)
      expect(doc.head.querySelector('title')).toBeNull()
      expect(doc.body.querySelector('title')?.textContent?.trim()).not.toBe('')
    }
  )
})

describe('只在系统提示讲了交互块时才写（SK-7）', () => {
  /** 各语言里那个前提的说法（技能正文 / 参考开头） */
  const CONDITION: Record<string, { skill: string; reference: string }> = {
    en: {
      skill: 'only if your system prompt describes',
      reference: 'only where your system prompt describes'
    },
    ja: {
      skill: 'only if your system prompt describes',
      reference: 'only where your system prompt describes'
    },
    zh: { skill: '前提是你的系统提示里讲了', reference: '只在你的系统提示讲了它的时候' }
  }

  it.each(LANGUAGES)(
    'SK-7 %s：SKILL.md 正文里凡提到 ```interactive 或 interactive.md 的段落都带着前提；参考开头那段也带着',
    (lang) => {
      const skill = skillFile(lang, 'SKILL.md')
      const mentioning = bodyParagraphs(skill.text).filter(
        (p) => p.includes('```interactive') || p.includes('references/interactive.md')
      )
      expect(mentioning.length, `${skill.name} 一处都没提到交互块`).toBeGreaterThan(0)
      for (const p of mentioning) expect(p, skill.name).toContain(CONDITION[lang].skill)

      const ref = REFS.find((r) => r.lang === lang)!
      const [heading, lead] = bodyParagraphs(ref.text)
      expect(heading.startsWith('# '), ref.name).toBe(true)
      expect(lead, `${ref.name} 开头那段`).toContain(CONDITION[lang].reference)
    }
  )
})

/** 段落再按列表项切开：一个列表是一段，但每一项是各说各的一句话 */
const units = (paragraphs: string[]): string[] =>
  paragraphs.flatMap((p) => p.split(/\n(?=[ \t]*(?:[-*]|\d+\.)\s)/)).map((u) => u.trim())

const STYLE = LANGUAGES.map((lang) => ({ lang, ...skillFile(lang, 'references/style.md') }))

describe('观感那一页与 SKILL.md 讲交互块时都带着前提（SK-8）', () => {
  /** 各语言里那个前提的说法：style.md 的零件段 / SKILL.md 正文 / SKILL.md 的 description */
  const CONDITION: Record<string, { style: string; skill: string; description: string }> = {
    en: {
      style: 'only where your system prompt describes',
      skill: 'only if your system prompt describes',
      description: 'where your system prompt describes them'
    },
    ja: {
      style: 'only where your system prompt describes',
      skill: 'only if your system prompt describes',
      description: 'where your system prompt describes them'
    },
    zh: {
      style: '只在你的系统提示讲了',
      skill: '前提是你的系统提示里讲了',
      description: '仅限系统提示里讲了它的场合'
    }
  }
  /** 零件那一节的小标题（ja 是英文副本） */
  const COMPONENTS_HEADING: Record<string, string> = {
    en: '## Interactive blocks — components',
    ja: '## Interactive blocks — components',
    zh: '## 交互块 —— 零件'
  }
  /** SKILL.md 里「提到交互块」的认法 */
  const MENTIONS: Record<string, RegExp> = {
    en: /interactive block/i,
    ja: /interactive block/i,
    zh: /交互块/
  }

  it.each(LANGUAGES)(
    'SK-8 %s：style.md 里凡提到 ```interactive 的段落都带前提，零件一节的开头那段也带着',
    (lang) => {
      const style = STYLE.find((s) => s.lang === lang)!
      const paragraphs = bodyParagraphs(style.text)
      const mentioning = paragraphs.filter((p) => p.includes('```interactive'))
      expect(mentioning.length, `${style.name} 一处都没提到 \`\`\`interactive`).toBeGreaterThan(0)
      for (const p of mentioning) expect(p, style.name).toContain(CONDITION[lang].style)

      const at = paragraphs.indexOf(COMPONENTS_HEADING[lang])
      expect(at, `${style.name} 找不到「${COMPONENTS_HEADING[lang]}」`).toBeGreaterThanOrEqual(0)
      expect(paragraphs[at + 1], `${style.name} 零件一节的开头`).toContain(CONDITION[lang].style)
    }
  )

  it.each(LANGUAGES)(
    'SK-8 %s：SKILL.md 正文里凡提到交互块的段落（列表逐项算）都带前提；description 用自己的话也说了',
    (lang) => {
      const skill = skillFile(lang, 'SKILL.md')
      const mentioning = units(bodyParagraphs(skill.text)).filter((u) => MENTIONS[lang].test(u))
      // 正控制组：参考入口那段、观感那段、步骤第 5 条 —— 至少三处
      expect(mentioning.length, `${skill.name} 提到交互块的段落`).toBeGreaterThanOrEqual(3)
      for (const u of mentioning) expect(u, skill.name).toContain(CONDITION[lang].skill)

      // description 不是正文的段落（它是技能架上那一行），措辞不同，但前提也在
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill.text)?.[1] ?? ''
      const description = /^description:\s*(.*)$/m.exec(frontmatter)?.[1] ?? ''
      expect(description, `${skill.name} 的 description`).toMatch(MENTIONS[lang])
      expect(description, `${skill.name} 的 description`).toContain(CONDITION[lang].description)
    }
  )
})

describe('观感那一页的交互零件（SK-9）', () => {
  /** 行首 ```html 到行首 ``` 之间的块体 */
  const htmlBlocksOf = (text: string): string[] =>
    [...text.matchAll(/^```html\n([\s\S]*?)^```$/gm)].map((m) => m[1])
  /** 宿主已经给了样式的裸标签 —— 零件只管排版，不重新设计它们 */
  const BARE = new Set(['button', 'input', 'select', 'textarea', 'table', 'th', 'td'])
  const isLookProp = (prop: string): boolean =>
    /^(background|border|padding)/.test(prop) ||
    ['color', 'font-family', 'font-weight', 'height'].includes(prop)
  const EMOJI = /\p{Extended_Pictographic}/u

  it.each(STYLE.map((s) => [s.name, s] as const))(
    'SK-9 %s：每段 ```html 零件都守沙箱与观感的规矩',
    (_name, style) => {
      const blocks = htmlBlocksOf(style.text)
      // 正控制组：控件行、读数、主数字、指标卡、图例条、分段、步进、表格 —— 一批零件
      expect(blocks.length, `${style.name} 的零件数`).toBeGreaterThanOrEqual(5)
      for (const [i, body] of blocks.entries()) {
        const what = `${style.name} 零件 #${i}`
        for (const [api, re] of FORBIDDEN_APIS) expect(body, `${what}：${api}`).not.toMatch(re)
        for (const token of tokensUsed(body)) {
          expect(SANDBOX_THEME_TOKENS, `${what} 用了 ${token}`).toContain(token)
        }
        const doc = parse(body)
        for (const value of cssValuesOf(doc)) expect(value, `${what} CSS 值`).not.toMatch(HEX)
        for (const el of doc.querySelectorAll('*')) {
          for (const attr of el.getAttributeNames()) {
            expect(el.getAttribute(attr) ?? '', `${what} ${el.localName}[${attr}]`).not.toMatch(HEX)
          }
        }
        for (const w of cssWeightsOf(doc))
          expect(['400', '500'], `${what} font-weight`).toContain(w)
        expect(body, `${what} 有 emoji`).not.toMatch(EMOJI)
        // 裸标签不重新设计：选择器恰是一个裸标签的规则里，不碰底色 / 边框 / 字色 / 字体 / 高度 / 内边距
        for (const rule of cssRulesOf(doc)) {
          if (!rule.selectors.some((sel) => BARE.has(sel))) continue
          for (const [prop] of rule.decls) {
            expect(isLookProp(prop), `${what}：${rule.selectors.join(', ')} 设了 ${prop}`).toBe(
              false
            )
          }
        }
      }
      // 至少有一段真的用到了 token（否则取色那条在空转）
      expect(blocks.some((b) => tokensUsed(b).length > 0)).toBe(true)
    }
  )

  it('SK-9 自检：裸标签那条认得出 `button { background … }`，放过 `td + td { text-align … }`', () => {
    const rules = cssRulesOf(
      parse('<style>button { background: none; } td + td, th + th { text-align: right; }</style>')
    )
    const offending = rules.flatMap((r) =>
      r.selectors.some((sel) => BARE.has(sel)) ? r.decls.filter(([p]) => isLookProp(p)) : []
    )
    expect(offending).toEqual([['background', 'none']])
  })
})

describe('交互块范例把 Chart.js 的观感留给宿主（SK-10）', () => {
  it.each(EXAMPLES.map((e) => [e.name, e] as const))(
    'SK-10 %s：内联脚本不设颜色、线宽、点、图例、动画；图按外层定高 + maintainAspectRatio: false',
    (_name, example) => {
      const doc = parse(example.body)
      const inline = [...doc.querySelectorAll('script')]
        .filter((s) => !s.hasAttribute('src'))
        .map((s) => s.textContent ?? '')
        .join('\n')
      // 正控制组：确实是一张 Chart.js 图
      expect(inline).toMatch(/new Chart\(/)
      for (const key of [
        'backgroundColor',
        'borderColor',
        'pointRadius',
        'borderWidth',
        'legend',
        'animation:'
      ]) {
        expect(inline, `范例脚本里写了 ${key}`).not.toContain(key)
      }
      expect(inline).toContain('maintainAspectRatio: false')

      // canvas 的父元素按 class 规则定高、相对定位（Chart.js 的 responsive 按父元素量尺寸）
      const canvas = doc.querySelector('canvas')
      expect(canvas, '范例里没有 canvas').not.toBeNull()
      const parent = canvas!.parentElement!
      expect(parent.localName, 'canvas 直接挂在 body 上').not.toBe('body')
      const classes = [...parent.classList]
      expect(classes.length, 'canvas 的父元素没有 class').toBeGreaterThan(0)
      const decls = cssRulesOf(doc)
        .filter((r) => r.selectors.some((sel) => classes.some((c) => sel === `.${c}`)))
        .flatMap((r) => r.decls)
      const valueOf = (prop: string): string | undefined =>
        decls
          .filter(([p]) => p === prop)
          .map(([, v]) => v)
          .at(-1)
      expect(valueOf('height'), '外层没有固定高度').toMatch(/^\d+px$/)
      expect(valueOf('position')).toBe('relative')
    }
  )
})
