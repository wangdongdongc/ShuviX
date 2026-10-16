// @vitest-environment jsdom
/**
 * MarkdownText —— 对话流里一段 markdown，**文本不变就不重新解析**（jsdom）。
 *
 * 一次渲染要把整段重新解析、重新高亮、重新排公式；卡里只要有一处跟着流式更新变，每段中间文本都会被连带
 * 重做一遍。MarkdownText 按文本 memo，钉的是：
 *
 *   MT-1 外层重渲染三次、文本不变：react-markdown 只被调一次，DOM 照常（`<em>`）
 *   MT-2 文本变了才重新解析：a → b 拿到 b；a → b → a 一共三次
 *   MT-3 交给 react-markdown 的就是生产那几张表（插件表、组件表按引用），children 就是文本
 *   MT-4 走的仍是生产管线：代码围栏有 hljs 高亮；裸 HTML 过闸（script 没了、onclick 没了）
 *   MT-5 两个兄弟实例各高亮各的语言；只重渲染其中一个，另一个原样不动（共用的高亮器不串文档）
 *
 * 探针：`react-markdown` 换成透传的包装，记下每次被渲染时的 props —— 一次即一次解析。mermaid 与包入口
 * 顶掉，i18n 走真 en 资源；文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

const probe = vi.hoisted(() => ({
  /** react-markdown 每被渲染一次记下它拿到的 props */
  calls: [] as Array<Record<string, unknown>>
}))

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: () => {} } }))
vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))
vi.mock('react-markdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-markdown')>()
  const React = await import('react')
  const Real = real.default
  return {
    ...real,
    default: (props: Parameters<typeof Real>[0]) => {
      probe.calls.push(props as unknown as Record<string, unknown>)
      return React.createElement(Real, props)
    }
  }
})

import {
  MarkdownText,
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins
} from '../markdownComponents'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

/** 外层每次都是新元素（带一个会变的属性），MarkdownText 拿到的只有 text */
function show(texts: string[], tick = 0): void {
  act(() =>
    root.render(
      createElement(
        'div',
        { 'data-tick': tick },
        texts.map((t, i) =>
          createElement(
            'section',
            { key: i, 'data-md': i },
            createElement(MarkdownText, { text: t })
          )
        )
      )
    )
  )
}

const parsed = (): string[] => probe.calls.map((p) => p.children as string)
const section = (i: number): HTMLElement =>
  container.querySelector<HTMLElement>(`[data-md="${i}"]`)!

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  probe.calls.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('按文本 memo（MT-1 / MT-2）', () => {
  it('MT-1 外层重渲染三次、文本不变：只解析一次，DOM 里是 <em>b</em>', () => {
    show(['a *b*'], 1)
    show(['a *b*'], 2)
    show(['a *b*'], 3)
    expect(probe.calls).toHaveLength(1)
    expect(section(0).querySelector('em')?.textContent).toBe('b')
    expect(section(0).textContent).toBe('a b')
  })

  it('MT-2 文本变了才重新解析：a → b 拿到 b、DOM 是 b；a → b → a 一共三次', () => {
    show(['a'], 1)
    show(['b'], 2)
    expect(parsed()).toEqual(['a', 'b'])
    expect(section(0).textContent).toBe('b')

    show(['a'], 3)
    expect(parsed()).toEqual(['a', 'b', 'a'])
    expect(section(0).textContent).toBe('a')
  })
})

describe('交给 react-markdown 的（MT-3）', () => {
  it('MT-3 插件表、组件表是生产那几份（按引用），children 就是文本', () => {
    show(['hello'])
    expect(probe.calls).toHaveLength(1)
    const props = probe.calls[0]
    expect(props.remarkPlugins).toBe(markdownRemarkPlugins)
    expect(props.rehypePlugins).toBe(markdownRehypePlugins)
    expect(props.components).toBe(markdownComponents)
    expect(props.children).toBe('hello')
  })
})

describe('生产管线照常（MT-4 / MT-5）', () => {
  it('MT-4 ```js 围栏：pre > code.hljs.language-js，const 是 hljs-keyword', () => {
    show(['```js\nconst a = 1\n```'])
    const code = section(0).querySelector('pre > code')
    expect(code).not.toBeNull()
    expect(code!.classList.contains('hljs')).toBe(true)
    expect(code!.classList.contains('language-js')).toBe(true)
    const keyword = code!.querySelector('span.hljs-keyword')
    expect(keyword?.textContent).toBe('const')
  })

  it('MT-4 裸 HTML 过闸：没有 <script>，<b> 留下但没有 onclick', () => {
    show(['<script>x</script><b onclick="x">b</b>'])
    expect(section(0).querySelector('script')).toBeNull()
    const b = section(0).querySelector('b')
    expect(b).not.toBeNull()
    expect(b!.textContent).toBe('b')
    expect(b!.getAttribute('onclick')).toBeNull()
    expect(b!.onclick).toBeNull()
  })

  it('MT-5 兄弟实例：js 与 python 各自的 language-* 与 hljs span；只重渲染一个，另一个原样（同一个节点、同样的标记）', () => {
    const js = '```js\nconst a = 1\n```'
    const py = '```python\ndef f():\n    return 1\n```'
    show([js, py])
    const jsCode = section(0).querySelector('pre > code')!
    const pyCode = section(1).querySelector('pre > code')!
    expect(jsCode.classList.contains('language-js')).toBe(true)
    expect(pyCode.classList.contains('language-python')).toBe(true)
    expect(jsCode.querySelector('span.hljs-keyword')?.textContent).toBe('const')
    expect(pyCode.querySelector('span.hljs-keyword')?.textContent).toBe('def')
    expect(probe.calls).toHaveLength(2)
    const pyHtml = pyCode.outerHTML

    const js2 = '```js\nlet b = 2\n```'
    show([js2, py], 1)
    expect(parsed()).toEqual([js, py, js2])
    const jsCode2 = section(0).querySelector('pre > code')!
    expect(jsCode2.classList.contains('language-js')).toBe(true)
    expect(jsCode2.querySelector('span.hljs-keyword')?.textContent).toBe('let')
    expect(section(1).querySelector('pre > code')).toBe(pyCode)
    expect(pyCode.outerHTML).toBe(pyHtml)
  })
})
