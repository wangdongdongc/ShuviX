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
 *    coding 也握着这个技能，而它们的回复显示在跑不了交互块的地方。
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
      const forbidden: Array<[string, RegExp]> = [
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
      for (const [what, re] of forbidden) expect(example.body, what).not.toMatch(re)
      // 正控制组：范例确实会跟宿主说话（sendPrompt 不被上面的 `prompt(` 误伤）
      expect(example.body).toContain('shuvix.sendPrompt(')
    }
  )

  it.each(EXAMPLES.map((e) => [e.name, e] as const))(
    'SK-5 %s：var(--x) 与 shuvix.color(--x) 用到的 token 都在注入名单里；CSS 与属性值里没有十六进制颜色',
    (_name, example) => {
      const used = [
        ...[...example.body.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*\)/g)].map((m) => m[1]),
        ...[...example.body.matchAll(/shuvix\.color\(\s*['"](--[A-Za-z0-9-]+)['"]\s*\)/g)].map(
          (m) => m[1]
        )
      ]
      expect(used.length, '范例一个 token 都没用').toBeGreaterThan(0)
      for (const token of used) expect(SANDBOX_THEME_TOKENS, token).toContain(token)

      const HEX = /#[0-9a-f]{3,8}\b/i
      const doc = parse(example.body)
      const declarations = [...doc.querySelectorAll('style')].flatMap((style) =>
        [...(style.textContent ?? '').matchAll(/:\s*([^;{}]+)/g)].map((m) => m[1])
      )
      expect(declarations.length, '范例没有样式声明 —— 这条在测什么？').toBeGreaterThan(0)
      for (const value of declarations) expect(value, `CSS 值 ${value}`).not.toMatch(HEX)
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

  /** 去掉 frontmatter 后按空行切段 */
  const bodyParagraphs = (text: string): string[] =>
    text
      .replace(/^---\n[\s\S]*?\n---\n/, '')
      .split(/\n[ \t]*\n/)
      .map((p) => p.trim())
      .filter(Boolean)

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
