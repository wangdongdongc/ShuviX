/**
 * `svgFenceIsRenderable` —— ```svg 围栏「要不要按图渲染」的分发判定。
 *
 * 两件事钉在这里：
 *  - **开标签闭合**是渲染的前提，而不是整段闭合。图是流式期间一帧一帧画出来的（那是这条
 *    载体最好的一点），但门必须开在开标签处：`viewBox` 写在开标签里，没拿到它就画，整张图
 *    会先按错的比例画一遍再跳；拿到之后宽高比就定了，于是从第一帧起零布局位移。
 *    开标签都没闭合则落回普通代码块 —— 「模型写坏了」因此停在**源码可见**的状态。
 *  - **语言名**只认小写 `svg`，与 mermaid 那档一致：提示词教的是小写，两档在这点上
 *    不该有分歧（提示片段里的围栏串与这里的 lang 值是同一个字面量）。
 *
 * 组件本身要 DOM，判定不要 —— 所以判定单独住在 chat-protocol 里（2026-09-18 从 CodeBlock
 * 搬下来：笔记本 live preview 的 ```svg 围栏要用同一套判定，而 atomic-editor 不能反向
 * 依赖 chat-ui）。搬下来顺带掉了一件脏活 —— 这份用例原本得 `vi.mock('mermaid')`，只因为
 * CodeBlock 在模块加载期 `initialize()`，而被测函数与 mermaid 毫无关系。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { authoredSvgFrame, svgFenceIsRenderable } from './svgFence'

/** 提示片段里教给模型的围栏语言串 —— 与分发用的 lang 值必须是同一个字面量 */
const FENCE_LANG = 'svg'

/** 引用围栏的语言串 —— 与 CodeBlock 的 `lang === 'artifact'` 分发同一个字面量 */
const ARTIFACT_FENCE_LANG = 'artifact'

/**
 * 三份 visual-guide 片段（`?raw` 内联的那批）—— 用 fs 读，**不 import**：chat-protocol 是
 * 零依赖叶子包，一条 import 会凭空造出一个反向的包依赖。读文本不会。
 */
const FRAGMENT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../agent-runtime/src/agentProfile/fragments'
)
const FRAGMENTS = ['visual-guide.md', 'visual-guide.zh.md', 'visual-guide.ja.md'].map((name) =>
  readFileSync(resolve(FRAGMENT_DIR, name), 'utf8')
)

describe('svgFenceIsRenderable', () => {
  it.each([
    ['闭合的完整图', '<svg viewBox="0 0 4 4"><rect/></svg>'],
    ['闭合标签带空格', '<svg><rect/></svg >'],
    ['闭合标签内换行', '<svg><rect/></svg\n>'],
    ['尾随空白', '<svg><rect/></svg>\n\n  '],
    ['前导空白', '\n  <svg><rect/></svg>'],
    ['大写闭合标签', '<svg><rect/></SVG>'],
    ['闭合后还有文字', '<svg><rect/></svg>\ntrailing note'],
    // 以下是**流式中间态**：开标签已闭合就该开始画
    ['仅开标签（占住宽高比的第一帧）', '<svg viewBox="0 0 4 4">'],
    ['一个完整元素', '<svg viewBox="0 0 4 4"><rect/>'],
    ['尾部半截的元素', '<svg viewBox="0 0 4 4"><rect/><circle cx='],
    ['尾部半截的属性值', '<svg viewBox="0 0 4 4"><rect width="2'],
    ['自闭合根', '<svg viewBox="0 0 4 4"/>']
  ])('渲染：lang=svg 且开标签已闭合 —— %s', (_label, code) => {
    expect(svgFenceIsRenderable(FENCE_LANG, code)).toBe(true)
  })

  it.each([
    ['开标签还没闭合', '<svg viewBox="0 0 4'],
    ['连 svg 都还没写出来', '<sv'],
    ['正文里根本没有 svg', 'flowchart TD\n A --> B'],
    ['空串', ''],
    ['纯空白', '   \n\t '],
    ['只有换行', '\n']
  ])('不渲染，落回普通代码块 —— %s', (_label, code) => {
    expect(svgFenceIsRenderable(FENCE_LANG, code)).toBe(false)
  })

  it.each(['mermaid', 'xml', 'html', 'SVG', 'Svg', 'svg ', 'svgx', '', 'text'])(
    '语言名不是小写 svg 就不渲染，即便正文是一张完整的 SVG：%j',
    (lang) => {
      expect(svgFenceIsRenderable(lang, '<svg viewBox="0 0 4 4"><rect/></svg>')).toBe(false)
    }
  )

  it('大小写敏感是刻意的：提示词教小写，与 mermaid 那档同口径', () => {
    // 谁把判定改成 lang.toLowerCase() === 'svg'，上面那条 'SVG' 会红 —— 那是行为变更，
    // 两档要一起改（mermaid 分支同样是 lang === 'mermaid'）。
    expect(svgFenceIsRenderable('SVG', '<svg></svg>')).toBe(false)
    expect(svgFenceIsRenderable(FENCE_LANG, '<svg></svg>')).toBe(true)
  })
})

/**
 * `authoredSvgFrame` —— 每一帧真正交给净化器的那段文本。
 *
 * 分发判定只回答「画不画」，这里钉的是「画什么」：帧必须是**结构完整的一张图**，
 * 否则逐帧渲染就会看到半截元素忽隐忽现。
 */
describe('authoredSvgFrame', () => {
  it('已完成时原样交出（不重排、不补标签）', () => {
    const done = '<svg viewBox="0 0 4 4"><rect/></svg>'
    expect(authoredSvgFrame(done)).toBe(done)
    expect(authoredSvgFrame('<svg viewBox="0 0 4 4"/>')).toBe('<svg viewBox="0 0 4 4"/>')
  })

  it('未完成时切到最后一个完整标签，并补上 </svg>', () => {
    expect(authoredSvgFrame('<svg viewBox="0 0 4 4"><rect/><circle cx=')).toBe(
      '<svg viewBox="0 0 4 4"><rect/></svg>'
    )
    // 只有开标签：一张空图，正是用来占住宽高比的第一帧
    expect(authoredSvgFrame('<svg viewBox="0 0 4 4">')).toBe('<svg viewBox="0 0 4 4"></svg>')
  })

  it('未闭合的容器交给解析器收尾，不自己补 </g>', () => {
    expect(authoredSvgFrame('<svg viewBox="0 0 4 4"><g><rect/>')).toBe(
      '<svg viewBox="0 0 4 4"><g><rect/></svg>'
    )
  })

  it('属性值里的 / 不会被误判成自闭合根（否则会被当成已完成、提前定稿）', () => {
    const streaming = '<svg viewBox="0 0 4 4" data-a="a/b"><rect/>'
    expect(authoredSvgFrame(streaming)).toBe('<svg viewBox="0 0 4 4" data-a="a/b"><rect/></svg>')
  })

  it('开标签未闭合 / 没有 svg → null', () => {
    for (const code of ['<svg viewBox="0 0 4', '<sv', '', '  ', 'no svg here']) {
      expect(authoredSvgFrame(code), JSON.stringify(code)).toBeNull()
    }
  })

  it('帧是 code 的纯函数：同一输入恒得同一帧（渲染层据此免掉节流）', () => {
    const c = '<svg viewBox="0 0 4 4"><rect/><circle cx='
    expect(authoredSvgFrame(c)).toBe(authoredSvgFrame(c))
  })
})

/**
 * 提示片段教的围栏语言串，必须正是这里分发用的那个值。
 *
 * 这两个字面量分住两个包，中间没有类型把它们拴在一起：片段里写成 ```SVG 或 ```xml，
 * 模型会照写，而 CodeBlock 一个字都不认，图变成一坨源码 —— 全绿，没有报错。
 */
describe('片段教的围栏语言串 ↔ 分发用的 lang 值', () => {
  it('三份片段里的围栏开头都是小写 svg，且这个值可渲染', () => {
    for (const [i, text] of FRAGMENTS.entries()) {
      // md 里的代码围栏开头行（```<lang>）
      const openers = [...text.matchAll(/^```([A-Za-z][\w+-]*)\s*$/gm)].map((m) => m[1])
      expect(openers.length, `片段 #${i} 应含至少一个示例围栏`).toBeGreaterThan(0)
      // 片段现在教两种围栏：```svg（画）与 ```artifact（引用一件已落盘的产物）。
      // 只有这两个是 CodeBlock 认识的，多出第三种就是提示词在教一个渲染不出来的写法。
      for (const lang of openers) {
        expect([FENCE_LANG, ARTIFACT_FENCE_LANG], `片段 #${i}: 未知围栏 ${lang}`).toContain(lang)
      }
      expect(openers, `片段 #${i} 应含 svg 示例`).toContain(FENCE_LANG)
      expect(svgFenceIsRenderable(FENCE_LANG, '<svg viewBox="0 0 4 4"><rect/></svg>')).toBe(true)
      // 散文里介绍围栏的那句也是同一个串（「A ```svg fenced block…」）
      expect(text, `片段 #${i}`).toContain('```' + FENCE_LANG)
    }
  })
})
