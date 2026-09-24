// @vitest-environment jsdom
/**
 * InteractiveBlock（```interactive 围栏 → 沙箱 iframe 里跑的一块交互图）DOM 测试（jsdom）。
 *
 * 渲染走**生产同一条路**：ReactMarkdown + `markdownComponents` + 生产那两张插件表，外面套
 * ChatHostProvider 与 AssistantBubble 给的那对上下文（MarkdownStreamingContext /
 * MarkdownSourceContext）—— 于是 hast 节点的 position 是真的，「流式中围栏闭合没有」判的是
 * 真实切回来的那截源文本，而不是测试手搭的节点。组件头注释里的两条约定就是这里的主轴：
 *
 *   - **sandbox 恰是 `allow-scripts`**（IB-1）：整道边界里唯一写在组件里的一环；
 *   - **只认自己那个 iframe 发来的消息**（IB-8…14）：同一页上有好几块交互图，还有 PDF / widget
 *     的 iframe；消息的形状再过 parseSandboxMessage。sendPrompt 只**填**输入框，从不发送。
 * 外加：围栏闭合才挂（IB-2…5）、长得像的围栏不跑（IB-6）、宿主跑不了时说清楚（IB-7）、
 * 源码切换 / 重跑 / 切主题三种重挂（IB-15…17）、卸载后监听摘干净（IB-18），以及 `.html` 的
 * artifact 引用走同一个沙箱、按**名字**判（IB-20…24）。
 *
 * 桩的形状：
 *   - `getComputedStyle` 换成桩：jsdom 不做级联。桩按**当前 data-theme** 给每个 token 一个可辨认的
 *     值（`v-<主题>-<token>`），于是「srcdoc 里写的是哪个主题的颜色」直接可读，也能用
 *     `buildSandboxDocument` 算出期望的整份 srcdoc 逐字节比；
 *   - `setChatApi` 注入一个记录一切调用的间谍：artifact.read 按用例回内容，其余任何调用都记下来 ——
 *     IB-12 断言除了 artifact.read 之外一个都没有；
 *   - `mermaid` 顶掉：CodeBlock 经 MermaidBlock 引入它，这里用不到。
 *
 * ⚠️ 组件的视图状态（按源码）与主题 token 缓存（按主题 id）都是**模块级**的，跨用例共享：
 * 每条用例用自己独有的源码，也用自己独有的 data-theme id（与 mermaidBlock.dom.test.tsx 同一条纪律）。
 *
 * jsdom 不跑 srcdoc（iframe 里是 about:blank），属性一律用 getAttribute 读。沙箱里真跑起来的样子
 * 由 e2e 的 chat-interactive 钉。i18n 走真 en 资源；文件是 .tsx 但不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'
import {
  SANDBOX_THEME_TOKENS,
  buildSandboxDocument
} from '@shuvix/chat-protocol/utils/interactiveFence'

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: () => {} } }))

import {
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins
} from '../markdownComponents'
import { MarkdownSourceContext, MarkdownStreamingContext } from '../markdownStreaming'
import { ChatHostProvider } from '../../../host/ChatHost'
import type { ChatHostValue } from '../../../host/chatHostContext'
import { setChatApi } from '../../../api/chatApi'
import { useChatStore } from '../../../stores/chatStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ─── 宿主通道间谍 ───────────────────────────────────────────

/** artifact.read 的回答（用例自己拨） */
const artifactRead = vi.fn<(params: { sessionId: string; name: string }) => Promise<unknown>>()
/** 除 artifact.read 之外，任何经 ChatApi 的调用都记在这里（IB-12 要它为空） */
const apiCalls: string[] = []

/**
 * 每条路径一个固定的代理：身份必须稳定 —— ArtifactRefBlock 的 effect 依赖 `artifact.read`
 * 这个函数本身，每次取都换一个新对象的话 effect 每帧重跑、setState、再重跑，永不停
 * （真的 window.api 上它当然是同一个函数）。
 */
const spyCache = new Map<string, unknown>()
function spyNamespace(path: string): unknown {
  const hit = spyCache.get(path)
  if (hit) return hit
  const proxy = new Proxy(
    function spy(): void {
      // 只作代理的靶子：调用都走下面的 apply 陷阱
    },
    {
      get(_target, key) {
        if (typeof key === 'symbol' || key === 'then') return undefined
        return spyNamespace(`${path}.${key}`)
      },
      apply(_target, _this, args: unknown[]) {
        if (path === 'api.artifact.read') {
          return artifactRead(args[0] as { sessionId: string; name: string })
        }
        apiCalls.push(path)
        return Promise.resolve(undefined)
      }
    }
  )
  spyCache.set(path, proxy)
  return proxy
}

// ─── 主题桩 ────────────────────────────────────────────────

/** 某主题下某个 token 的桩值（形状过得了 buildSandboxDocument 的过滤） */
const tokenValue = (themeId: string, name: string): string => `v-${themeId}-${name.slice(2)}`
const schemeOf = (themeId: string): string => (themeId.endsWith('-dark') ? 'dark' : 'light')
const tokensOf = (themeId: string): Record<string, string> =>
  Object.fromEntries(SANDBOX_THEME_TOKENS.map((name) => [name, tokenValue(themeId, name)]))
/** 某主题下这段源码应得的整份 srcdoc */
const expectedDoc = (code: string, themeId: string): string =>
  buildSandboxDocument({ body: code, tokens: tokensOf(themeId), colorScheme: schemeOf(themeId) })

const currentTheme = (): string => document.documentElement.getAttribute('data-theme') ?? ''

const realGetComputedStyle = window.getComputedStyle

// ─── 挂载 ──────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root

type HostFlag = boolean | 'omit' | 'no-provider'

/**
 * 就是 ChatHostProvider，只是把 children 在类型上标成可选：它的 props 里 children 是必填的，
 * 而 createElement 从第三个参数传进来的 children 类型检查看不见（写进 props 又过不了
 * react/no-children-prop）。
 */
const HostProvider = ChatHostProvider as (props: {
  value: ChatHostValue
  children?: ReactNode
}) => React.JSX.Element

const hostValue = (flag: boolean | 'omit'): ChatHostValue => ({
  appearance: {
    theme: 'light',
    darkTheme: 'd',
    lightTheme: 'l',
    fontSize: 14,
    focusMode: false
  },
  models: {
    activeProvider: '',
    activeModel: '',
    setActiveProvider: () => {},
    setActiveModel: () => {}
  },
  ...(flag === 'omit' ? {} : { interactiveFigures: flag })
})

interface ShowOptions {
  /** AssistantBubble 的 isStreaming（缺省 false） */
  streaming?: boolean
  /** 流式时是否给源文本（AssistantBubble 流式时总给；IB-4 拿掉它） */
  withSource?: boolean
  /** 宿主开关（缺省 true）；'omit' = 值里没这个键；'no-provider' = 外面根本没有 ChatHostProvider */
  host?: HostFlag
}

/** 与 AssistantBubble 同形的一棵树 */
function tree(md: string, opts: ShowOptions = {}): ReactNode {
  const { streaming = false, withSource = true, host = true } = opts
  const markdown = createElement(
    MarkdownStreamingContext.Provider,
    { value: streaming },
    createElement(
      MarkdownSourceContext.Provider,
      { value: streaming && withSource ? md : null },
      createElement(
        ReactMarkdown,
        {
          remarkPlugins: markdownRemarkPlugins,
          rehypePlugins: markdownRehypePlugins,
          components: markdownComponents
        },
        md
      )
    )
  )
  if (host === 'no-provider') return markdown
  return createElement(HostProvider, { value: hostValue(host) }, markdown)
}

function show(md: string, opts?: ShowOptions): void {
  act(() => {
    root.render(tree(md, opts))
  })
}

function clear(): void {
  act(() => {
    root.render(createElement('div'))
  })
}

/** 让挂起的 promise（artifact.read）与随之而来的 setState 都落定 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function setTheme(themeId: string): Promise<void> {
  await act(async () => {
    document.documentElement.setAttribute('data-theme', themeId)
  })
}

/** ```interactive 围栏 */
const fence = (code: string, lang = 'interactive'): string => `\`\`\`${lang}\n${code}\n\`\`\``

// ─── DOM 读取 ──────────────────────────────────────────────

const frames = (): HTMLIFrameElement[] => [
  ...container.querySelectorAll<HTMLIFrameElement>('[data-interactive-figure] iframe')
]
const onlyFrame = (): HTMLIFrameElement => {
  const all = frames()
  expect(all, '应当恰好挂着一个交互图 iframe').toHaveLength(1)
  return all[0]
}
const figures = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-interactive-figure]')
]
const pendingOf = (scope: ParentNode = container): HTMLElement | null =>
  scope.querySelector<HTMLElement>('[data-interactive-pending]')
const unsupportedOf = (): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-interactive-unsupported]')
/** 卡片工具栏上的名字（第一个 span） */
const toolbarTitle = (figure: Element): string =>
  figure.querySelector('span')?.textContent?.trim() ?? ''
const frameHeight = (frame: HTMLIFrameElement): string => frame.style.height

const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/**
 * 以 `source` 的名义给宿主窗口发一条 message（iframe 里 `parent.postMessage` 在宿主这边
 * 就是这个形状）。jsdom 的 MessageEventInit 若不收某个 source，就补一个属性上去。
 */
function post(source: unknown, data: unknown): void {
  let event: MessageEvent
  try {
    event = new MessageEvent('message', { data, source: source as Window })
  } catch {
    event = new MessageEvent('message', { data })
    Object.defineProperty(event, 'source', { value: source })
  }
  act(() => {
    window.dispatchEvent(event)
  })
}

const resize = (height: unknown): Record<string, unknown> => ({
  __shuvix: 1,
  type: 'resize',
  height
})
const prompt = (text: unknown): Record<string, unknown> => ({ __shuvix: 1, type: 'prompt', text })

const inputText = (): string => useChatStore.getState().inputText
const setInput = (text: string): void => useChatStore.setState({ inputText: text })

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } }
  })
  setChatApi(spyNamespace('api') as ChatApi)
})

beforeEach(() => {
  apiCalls.length = 0
  artifactRead.mockReset()
  artifactRead.mockResolvedValue(null)
  setInput('')
  document.documentElement.setAttribute('data-theme', 'unset')
  // jsdom 不做级联：根元素上按当前主题给每个 token 一个可辨认的值；别的元素给个空壳
  window.getComputedStyle = ((el: Element) => {
    const themeId = currentTheme()
    if (el === document.documentElement) {
      return {
        colorScheme: schemeOf(themeId),
        getPropertyValue: (name: string) =>
          SANDBOX_THEME_TOKENS.includes(name) ? ` ${tokenValue(themeId, name)} ` : '',
        color: '',
        fontFamily: 'Test Sans'
      }
    }
    return {
      color: `${themeId}:${(el as HTMLElement).style?.color ?? ''}`,
      colorScheme: schemeOf(themeId),
      getPropertyValue: () => '',
      fontFamily: 'Test Sans'
    }
  }) as unknown as typeof window.getComputedStyle
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  window.getComputedStyle = realGetComputedStyle
  vi.restoreAllMocks()
})

describe('挂载与沙箱（IB-1）', () => {
  it('IB-1 闭合的围栏：恰一个 iframe，sandbox 恰是 allow-scripts、no-referrer、没有 src；srcdoc 逐字节等于按当前主题拼的那份', async () => {
    await setTheme('ib1')
    const code =
      '<title>IB1</title>\n<p id="ib1">hello</p>\n<script>shuvix.sendPrompt("ib1")</script>'
    show(`before\n\n${fence(code)}\n\nafter`)

    const frame = onlyFrame()
    // 边界本身：多一个 allow-same-origin 就与宿主同源，一行 parent.api 拿到全部 IPC
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.hasAttribute('src')).toBe(false)
    expect(frame.getAttribute('srcdoc')).toBe(expectedDoc(code, 'ib1'))
    expect(frame.getAttribute('title')).toBe('Interactive figure')
    expect(frameHeight(frame)).toBe('120px')
    expect(toolbarTitle(figures()[0])).toBe('Interactive')
    expect(pendingOf()).toBeNull()
  })
})

describe('围栏闭合才挂（IB-2…5）', () => {
  it('IB-2 流式中、围栏没闭合：只有「已写 N 行」的占位；没有 iframe，也没有重跑 / 切换按钮', () => {
    const code = '<p>ib2</p>\n<script>\nconst a = 1'
    show(`intro\n\n\`\`\`interactive\n${code}`, { streaming: true })
    expect(pendingOf()?.textContent).toBe('Building the interactive figure… (3 lines)')
    expect(frames()).toHaveLength(0)
    expect(container.querySelector('[data-interactive-rerun]')).toBeNull()
    expect(container.querySelector('[data-interactive-toggle]')).toBeNull()
  })

  it('IB-3 围栏一闭合就挂（消息还在写）；消息写完那一刻还是同一个 iframe 节点、srcdoc 不变', async () => {
    await setTheme('ib3')
    const code = '<p>ib3</p>\n<script>shuvix.sendPrompt("LOADED")</script>'
    show(`intro\n\n\`\`\`interactive\n${code}`, { streaming: true })
    expect(pendingOf()).not.toBeNull()

    const closed = `intro\n\n${fence(code)}\n\nMARK-TAIL`
    show(closed, { streaming: true })
    const frame = onlyFrame()
    expect(pendingOf()).toBeNull()
    const doc = frame.getAttribute('srcdoc')
    expect(doc).toBe(expectedDoc(code, 'ib3'))

    // 流式标志翻成 false：不重挂（重挂 = 块里的脚本再跑一遍，sendPrompt 会再填一次输入框）
    show(closed, { streaming: false })
    expect(onlyFrame()).toBe(frame)
    expect(frame.isConnected).toBe(true)
    expect(frame.getAttribute('srcdoc')).toBe(doc)
  })

  it('IB-4 流式中却拿不到源文本：保守地当没写完（占位），即使围栏其实闭合了', () => {
    const code = '<p>ib4</p>'
    show(`${fence(code)}\n\ntail`, { streaming: true, withSource: false })
    expect(pendingOf()?.textContent).toBe('Building the interactive figure… (1 lines)')
    expect(frames()).toHaveLength(0)
  })

  it('IB-5 容器前缀：引用块里、列表项里的闭合围栏，流式中照样挂上', () => {
    show('> ```interactive\n> <p>ib5-quote</p>\n> ```\n\ntail', { streaming: true })
    expect(frames(), '引用块').toHaveLength(1)

    clear()
    show('- item\n\n  ```interactive\n  <p>ib5-list</p>\n  ```\n\ntail', { streaming: true })
    expect(frames(), '列表项').toHaveLength(1)
  })
})

describe('长得像的不跑、跑不了的说清楚（IB-6 / 7）', () => {
  it('IB-6 ```html / 大小写变体 / ```js / 空的 ```interactive / 外层 ````md 里的示例：都只是普通代码块', () => {
    const lookalikes = [
      fence('<p>ib6-html</p><script>1</script>', 'html'),
      fence('<p>ib6-cap</p>', 'Interactive'),
      fence('<p>ib6-upper</p>', 'INTERACTIVE'),
      fence('console.log("ib6")', 'js'),
      '```interactive\n```',
      '````md\n```interactive\n<p>ib6-nested</p>\n```\n````'
    ]
    for (const md of lookalikes) {
      clear()
      show(md)
      expect(frames(), md).toHaveLength(0)
      expect(figures(), md).toHaveLength(0)
      expect(unsupportedOf(), md).toBeNull()
      expect(container.querySelector('pre'), md).not.toBeNull()
    }
  })

  it('IB-7 宿主跑不了（没有 Provider / 没给开关 / 给了 false）：说明只在桌面端运行 + 源码，没有任何 iframe', () => {
    const code = '<p>ib7</p>\n<script>1</script>'
    for (const host of ['no-provider', 'omit', false] as const) {
      clear()
      show(fence(code), { host })
      const card = unsupportedOf()
      expect(card, String(host)).not.toBeNull()
      expect(card!.textContent, String(host)).toContain(
        'Interactive figures run in the ShuviX desktop app'
      )
      expect(card!.querySelector('pre')?.textContent, String(host)).toBe(code)
      expect(container.querySelectorAll('iframe'), String(host)).toHaveLength(0)
    }
  })
})

describe('只认自己那个 iframe 的消息（IB-8…14）', () => {
  it('IB-8 自己的 frame 报高度：按 40…720 夹住写到 iframe 上', () => {
    show(fence('<p>ib8</p>'))
    const frame = onlyFrame()
    expect(frame.contentWindow, 'jsdom 应当给挂上的 iframe 一个 contentWindow').not.toBeNull()
    post(frame.contentWindow, resize(300))
    expect(frameHeight(frame)).toBe('300px')
    post(frame.contentWindow, resize(5000))
    expect(frameHeight(frame)).toBe('720px')
    post(frame.contentWindow, resize(3))
    expect(frameHeight(frame)).toBe('40px')
  })

  it('IB-9 别的窗口发来的（宿主自己、另一块交互图、页上别的 iframe）：高度与输入框都不动', () => {
    show(`${fence('<p>ib9-a</p>')}\n\n${fence('<p>ib9-b</p>')}`)
    const [a, b] = frames()
    expect(frames()).toHaveLength(2)
    const foreign = document.createElement('iframe')
    document.body.appendChild(foreign)
    expect(foreign.contentWindow).not.toBeNull()

    for (const source of [window, b.contentWindow, foreign.contentWindow]) {
      post(source, resize(333))
      post(source, prompt('ib9 hijack'))
    }
    expect(frameHeight(a)).toBe('120px')
    // b 自己的消息落在 b 上是对的；a 必须一动不动 —— 再单独看 b 没被 window / foreign 改动
    expect(frameHeight(b)).toBe('333px')
    // 输入框只被 b 自己的那条 prompt 填过一次
    expect(inputText()).toBe('ib9 hijack')

    setInput('')
    post(window, prompt('from window'))
    post(foreign.contentWindow, prompt('from foreign'))
    post(foreign.contentWindow, resize(500))
    expect(inputText()).toBe('')
    expect(frameHeight(a)).toBe('120px')
    expect(frameHeight(b)).toBe('333px')
  })

  it('IB-10 来源对、形状不对（没标记 / 未知 type / NaN 高度）：什么都不变', () => {
    show(fence('<p>ib10</p>'))
    const frame = onlyFrame()
    post(frame.contentWindow, { type: 'resize', height: 300 })
    post(frame.contentWindow, { __shuvix: 1, type: 'navigate', url: 'https://example.com' })
    post(frame.contentWindow, resize(Number.NaN))
    post(frame.contentWindow, { type: 'prompt', text: 'untagged' })
    expect(frameHeight(frame)).toBe('120px')
    expect(inputText()).toBe('')
  })

  it('IB-11 sendPrompt 填进输入框：空输入框直接填；已有草稿另起一行接在后面（去掉草稿尾部空白）；只有空白的草稿当作空', () => {
    show(fence('<p>ib11</p>'))
    const frame = onlyFrame()

    setInput('')
    post(frame.contentWindow, prompt('Explain'))
    expect(inputText()).toBe('Explain')

    setInput('my draft  \n')
    post(frame.contentWindow, prompt('Explain'))
    expect(inputText()).toBe('my draft\nExplain')

    setInput('   ')
    post(frame.contentWindow, prompt('Explain'))
    expect(inputText()).toBe('Explain')
  })

  it('IB-12 只填、从不发送：ChatApi 上一次调用都没有，会话不在流式、消息列表不变', () => {
    show(fence('<p>ib12</p>'))
    const frame = onlyFrame()
    const before = useChatStore.getState()
    post(frame.contentWindow, prompt('Send me?'))

    expect(inputText()).toBe('Send me?')
    expect(apiCalls).toEqual([])
    const after = useChatStore.getState()
    expect(after.messages).toBe(before.messages)
    expect(after.sessionStreams).toEqual(before.sessionStreams)
    expect(after.sessionPendingPrompt).toEqual(before.sessionPendingPrompt)
  })

  it('IB-13 超长的 prompt（2001 字）整条丢弃，不截断', () => {
    show(fence('<p>ib13</p>'))
    const frame = onlyFrame()
    setInput('keep')
    post(frame.contentWindow, prompt('x'.repeat(2001)))
    expect(inputText()).toBe('keep')
  })

  it('IB-14 两块同在：A 的 prompt 只落一次（不是每块各落一次）；A 的高度只改 A', () => {
    show(`${fence('<p>ib14-a</p>')}\n\nmiddle\n\n${fence('<p>ib14-b</p>')}`)
    const [a, b] = frames()
    post(a.contentWindow, prompt('once'))
    expect(inputText()).toBe('once')
    post(a.contentWindow, resize(250))
    expect(frameHeight(a)).toBe('250px')
    expect(frameHeight(b)).toBe('120px')
  })
})

describe('源码 / 重跑 / 切主题（IB-15…17）', () => {
  it('IB-15 切到源码：没有 iframe、<pre> 是源码、重跑按钮收起；切回来又是 iframe；卸下再挂同一段仍是源码', () => {
    const code = '<p>ib15</p>\n<script>1</script>'
    show(fence(code))
    click(container.querySelector('[data-interactive-toggle]')!)
    expect(frames()).toHaveLength(0)
    expect(figures()[0].querySelector('pre')?.textContent).toBe(code)
    expect(container.querySelector('[data-interactive-rerun]')).toBeNull()

    click(container.querySelector('[data-interactive-toggle]')!)
    expect(frames()).toHaveLength(1)
    expect(container.querySelector('[data-interactive-rerun]')).not.toBeNull()

    // 再切到源码后卸下重挂（虚拟列表滚动时就是这样）：视图状态按源码记住
    click(container.querySelector('[data-interactive-toggle]')!)
    clear()
    show(fence(code))
    expect(frames()).toHaveLength(0)
    expect(figures()[0].querySelector('pre')?.textContent).toBe(code)
  })

  it('IB-16 重跑：换一个 iframe 节点（旧的已摘下），srcdoc 不变', () => {
    show(fence('<p>ib16</p>'))
    const before = onlyFrame()
    const doc = before.getAttribute('srcdoc')
    click(container.querySelector('[data-interactive-rerun]')!)
    const after = onlyFrame()
    expect(after).not.toBe(before)
    expect(before.isConnected).toBe(false)
    expect(after.getAttribute('srcdoc')).toBe(doc)
  })

  it('IB-17 切主题：换一个 iframe 节点、srcdoc 换成新主题的值；切回来与第一次逐字节相同', async () => {
    const code = '<p>ib17</p>'
    await setTheme('ib17a')
    show(fence(code))
    const first = onlyFrame()
    const firstDoc = first.getAttribute('srcdoc')
    expect(firstDoc).toBe(expectedDoc(code, 'ib17a'))

    await setTheme('ib17b-dark')
    const second = onlyFrame()
    expect(second).not.toBe(first)
    const secondDoc = second.getAttribute('srcdoc')!
    expect(secondDoc).toBe(expectedDoc(code, 'ib17b-dark'))
    expect(secondDoc).toContain(tokenValue('ib17b-dark', '--viz-1'))
    expect(secondDoc).toContain('color-scheme:dark')
    expect(secondDoc).not.toContain('ib17a')

    await setTheme('ib17a')
    expect(onlyFrame().getAttribute('srcdoc')).toBe(firstDoc)
  })
})

describe('卸载（IB-18）', () => {
  it('IB-18 卸下后 message 监听摘掉（同一个函数）；拿旧 frame 的名义再发，输入框不动', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    show(fence('<p>ib18</p>'))
    const frame = onlyFrame()
    const oldWin = frame.contentWindow
    const listeners = add.mock.calls.filter(([type]) => type === 'message').map(([, fn]) => fn)
    expect(listeners).toHaveLength(1)

    clear()
    const removed = remove.mock.calls.filter(([type]) => type === 'message').map(([, fn]) => fn)
    expect(removed).toContain(listeners[0])

    post(oldWin, prompt('after unmount'))
    expect(inputText()).toBe('')
  })
})

describe('.html 的 artifact 引用（IB-20…24）', () => {
  beforeEach(() => {
    act(() => {
      useChatStore.getState().setActiveSessionId('ib-artifacts')
    })
  })

  it('IB-20 ```artifact 指向 growth.html：内容进同一个沙箱，工具栏与 iframe 标题是 artifact 的标题', async () => {
    const content = '<title>Growth</title>\n<p>ib20</p>'
    artifactRead.mockResolvedValue({ name: 'growth.html', title: 'Growth', content })
    show('```artifact\ngrowth.html\n```')
    await flush()

    expect(artifactRead).toHaveBeenCalledWith({ sessionId: 'ib-artifacts', name: 'growth.html' })
    const frame = onlyFrame()
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('title')).toBe('Growth')
    expect(toolbarTitle(figures()[0])).toBe('Growth')
    expect(frame.getAttribute('srcdoc')).toContain(content)
    // 已落盘的东西是写完了的：不经过占位
    expect(pendingOf()).toBeNull()
  })

  it('IB-21 按名字判，不嗅内容：.html 里是一张 <svg> 也进沙箱（不内联）；.svg 里是 html + 脚本也只落 <pre>', async () => {
    const svgInHtml = '<svg viewBox="0 0 4 4" role="img" aria-label="ib21 chart"><rect/></svg>'
    artifactRead.mockResolvedValue({ name: 'growth.html', title: 'IB21', content: svgInHtml })
    show('```artifact\ngrowth.html\n```')
    await flush()
    expect(onlyFrame().getAttribute('srcdoc')).toContain(svgInHtml)
    expect(container.querySelector('svg[aria-label="ib21 chart"]')).toBeNull()

    clear()
    const htmlInSvg = '<title>x</title><script>window.ib21 = 1</script>'
    artifactRead.mockResolvedValue({ name: 'chart.svg', title: 'x', content: htmlInSvg })
    show('```artifact\nchart.svg\n```')
    await flush()
    expect(frames()).toHaveLength(0)
    expect(container.querySelectorAll('iframe')).toHaveLength(0)
    expect(container.querySelector('pre')?.textContent).toBe(htmlInSvg)
    expect(container.querySelector('script')).toBeNull()
  })

  it('IB-22 宿主跑不了交互图：.html 引用落成「只在桌面端运行」卡 + 内容', async () => {
    const content = '<title>IB22</title><p>ib22</p>'
    artifactRead.mockResolvedValue({ name: 'ib22.html', title: 'IB22', content })
    show('```artifact\nib22.html\n```', { host: false })
    await flush()
    expect(unsupportedOf()?.querySelector('pre')?.textContent).toBe(content)
    expect(container.querySelectorAll('iframe')).toHaveLength(0)
  })

  it('IB-23 找不到：「not found」卡，没有 iframe', async () => {
    artifactRead.mockResolvedValue(null)
    show('```artifact\nx.html\n```')
    await flush()
    expect(container.textContent).toContain('Artifact "x.html" not found in this session')
    expect(container.querySelectorAll('iframe')).toHaveLength(0)
  })

  it('IB-24 按标题引用（围栏里写 Growth）：宿主解析出的真名是 .html，照样进沙箱', async () => {
    const content = '<title>Growth</title>\n<p>ib24</p>'
    artifactRead.mockResolvedValue({ name: 'growth.html', title: 'Growth', content })
    show('```artifact\nGrowth\n```')
    await flush()
    expect(artifactRead).toHaveBeenCalledWith({ sessionId: 'ib-artifacts', name: 'Growth' })
    const frame = onlyFrame()
    expect(frame.getAttribute('srcdoc')).toContain(content)
    expect(container.querySelector('pre')).toBeNull()
  })
})
