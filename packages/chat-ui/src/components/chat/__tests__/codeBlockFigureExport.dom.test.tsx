// @vitest-environment jsdom
/**
 * 对话图卡上的「导出」按钮（CodeBlock 的 ```svg 与 ```artifact 两种图卡）—— jsdom。
 *
 * 面板本身在 figure/__tests__/figureExportPanel.dom.test.tsx；这里只钉**入口**：
 *
 *   - 什么时候有按钮（D-1/2/3/5/7）：写完了、画得出来的图才有；流式中途的半张图、净化判死的
 *     错误卡、还在取的 / 取不到的 / 不是 SVG 的产物、交互图都没有；
 *   - 按钮交给面板的是**哪一份**图（D-1/4/5/6）：屏幕上那份净化过的标记 —— 文件名取图的
 *     aria-label，产物则取产物的标题；切到源码视图也照样能导出；`<script>` 不会混进预览。
 *
 * 渲染：直接挂 CodeBlock 并给它 react-markdown 会给的 hast 节点（与 mermaidBlock.dom.test.tsx
 * 的 CB 组同一个搭法），流式用 MarkdownStreamingContext 包。烘焙在 jsdom 里能跑通靠三个桩：
 * `getComputedStyle`（给一份初值记录）、`SVGSVGElement.viewBox`、画布 `getContext` 回 null。
 * 产物走 `setChatApi` 注入的 artifact.read。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { ChatApi } from '@shuvix/chat-protocol/chatApi'

vi.mock('mermaid', () => ({ default: { initialize: () => {}, render: () => {} } }))

import { CodeBlock } from '../CodeBlock'
import { MarkdownStreamingContext } from '../markdownStreaming'
import { setChatApi } from '../../../api/chatApi'
import { useChatStore } from '../../../stores/chatStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ─── 桩 ───────────────────────────────────────────────────

const INITIAL: Record<string, string> = {
  fill: 'rgb(0, 0, 0)',
  'fill-opacity': '1',
  stroke: 'none',
  'stroke-opacity': '1',
  'font-family': 'Test Sans',
  'font-size': '14px',
  opacity: '1',
  'stop-color': 'rgb(0, 0, 0)',
  'stop-opacity': '1',
  'flood-color': 'rgb(0, 0, 0)',
  'flood-opacity': '1'
}
const realGetComputedStyle = window.getComputedStyle
const realGetContext = HTMLCanvasElement.prototype.getContext

/** artifact.read 的回答（用例自己拨）；身份必须稳定（ArtifactRefBlock 的 effect 依赖它） */
const artifactRead = vi.fn<(params: { sessionId: string; name: string }) => Promise<unknown>>()
const fakeApi = { artifact: { read: (p: { sessionId: string; name: string }) => artifactRead(p) } }

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } })
  setChatApi(fakeApi as unknown as ChatApi)
  Object.defineProperty(SVGSVGElement.prototype, 'viewBox', {
    configurable: true,
    get(this: SVGSVGElement) {
      const n = (this.getAttribute('viewBox') ?? '')
        .trim()
        .split(/[\s,]+/)
        .map(Number)
      const ok = n.length === 4 && n.every(Number.isFinite)
      const [x, y, width, height] = ok ? n : [0, 0, 0, 0]
      return { baseVal: { x, y, width, height } }
    }
  })
})

afterAll(() => {
  delete (SVGSVGElement.prototype as { viewBox?: unknown }).viewBox
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  artifactRead.mockReset()
  artifactRead.mockResolvedValue(null)
  useChatStore.getState().setActiveSessionId('s1')
  document.documentElement.setAttribute('data-theme', 'ROOT')
  window.getComputedStyle = ((el: Element) => {
    const probe = el.tagName === 'SPAN' ? (el as HTMLElement).style.color : ''
    return {
      getPropertyValue: (p: string) => INITIAL[p] ?? '',
      fontFamily: 'Test Sans',
      fontSize: '14px',
      fontWeight: '400',
      lineHeight: '20px',
      colorScheme: 'light',
      color: probe.includes('var(') ? 'rgb(30, 31, 32)' : 'rgb(0, 0, 0)'
    }
  }) as unknown as typeof window.getComputedStyle
  HTMLCanvasElement.prototype.getContext = (() =>
    null) as unknown as typeof HTMLCanvasElement.prototype.getContext
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  window.getComputedStyle = realGetComputedStyle
  HTMLCanvasElement.prototype.getContext = realGetContext
})

// ─── 挂载 ──────────────────────────────────────────────────

/** react-markdown 交给 CodeBlock 的 hast：pre > code.language-<lang> > text */
interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}
const hast = (lang: string, text: string): HastNode => ({
  type: 'element',
  tagName: 'pre',
  properties: {},
  children: [
    {
      type: 'element',
      tagName: 'code',
      properties: { className: [`language-${lang}`] },
      children: [{ type: 'text', value: text }]
    }
  ]
})

function show(lang: string, text: string, streaming?: boolean): void {
  const block = createElement(
    CodeBlock,
    { node: hast(lang, text) },
    createElement('code', { className: `language-${lang}` }, text)
  )
  act(() => {
    root.render(
      streaming === undefined
        ? block
        : createElement(MarkdownStreamingContext.Provider, { value: streaming }, block)
    )
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

// ─── 读取 ──────────────────────────────────────────────────

const exportButtons = (): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[data-figure-export]'))
const panel = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-figure-export-panel]')
const fileName = (): string => panel()?.querySelector('[data-figure-filename]')?.textContent ?? ''
const previewState = (): string | null =>
  panel()?.querySelector('[data-figure-preview]')?.getAttribute('data-figure-preview') ?? null
const previewSvg = (): string => {
  const src = panel()?.querySelector('img')?.getAttribute('src') ?? ''
  return decodeURIComponent(src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''))
}
const click = (el: Element): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
/** 点导出并等面板把图建好 */
async function openExport(): Promise<void> {
  const [btn] = exportButtons()
  expect(btn, '没有导出按钮').toBeDefined()
  click(btn)
  await flush()
  expect(panel()).not.toBeNull()
}

const FIGURE = (label: string, extra = ''): string =>
  `<svg viewBox="0 0 320 200" role="img" aria-label="${label}">${extra}<rect width="100" height="50" fill="var(--viz-1)"/></svg>`

// ═══════════════════════════════════════════════════════════════

describe('```svg 图卡（D-1…4, D-6）', () => {
  it('D-1 写完的图：恰好一个「Export」按钮；点开面板，文件名取图的 aria-label，图建得出来', async () => {
    show('svg', FIGURE('D1 probe'))
    expect(container.querySelector('svg[aria-label="D1 probe"]')).not.toBeNull()
    const buttons = exportButtons()
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe('Export')
    await openExport()
    expect(fileName()).toBe('D1 probe.png')
    expect(previewState()).toBe('ready')
    expect(previewSvg()).toContain('fill="#')
    expect(previewSvg()).not.toContain('var(')
  })

  it('D-2 流式中、还没写到 </svg>：图已经画着，但没有导出按钮；写完那一帧按钮出现', () => {
    const partial = '<svg viewBox="0 0 320 200" aria-label="D2"><rect width="100" height="50"/>'
    show('svg', partial, true)
    expect(container.querySelector('svg[aria-label="D2"] rect')).not.toBeNull()
    expect(exportButtons()).toHaveLength(0)

    show('svg', `${partial}</svg>`, true)
    expect(exportButtons()).toHaveLength(1)
  })

  it('D-3 净化判死（整段都是被禁元素）：错误卡、没有导出按钮', () => {
    show('svg', '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>')
    expect(container.textContent).toContain('<script>')
    expect(container.querySelector('svg')).toBeNull()
    expect(exportButtons()).toHaveLength(0)
  })

  it('D-4 切到源码视图：导出按钮还在，照样能建出图', async () => {
    show('svg', FIGURE('D4'))
    const toggle = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Source'
    )
    expect(toggle).toBeDefined()
    click(toggle!)
    expect(container.querySelector('pre')?.textContent).toContain('aria-label="D4"')
    expect(exportButtons()).toHaveLength(1)
    await openExport()
    expect(previewState()).toBe('ready')
    expect(fileName()).toBe('D4.png')
  })

  it('D-6 源码里的 <script> 被净化掉：交给面板的是净化后的那份', async () => {
    show('svg', FIGURE('D6', '<script>window.__pwned = 1</script>'))
    await openExport()
    expect(previewState()).toBe('ready')
    expect(previewSvg()).not.toMatch(/<script/i)
    expect(previewSvg()).toContain('<rect')
  })
})

describe('```artifact 图卡（D-5）', () => {
  it('D-5 .svg 产物：有按钮；文件名取产物的标题（压过图里的 aria-label）', async () => {
    artifactRead.mockResolvedValue({
      name: 'probe.svg',
      title: 'Revenue split',
      content: FIGURE('Inner label')
    })
    show('artifact', 'probe.svg')
    await flush()
    expect(artifactRead).toHaveBeenCalledWith({ sessionId: 's1', name: 'probe.svg' })
    expect(exportButtons()).toHaveLength(1)
    await openExport()
    expect(fileName()).toBe('Revenue split.png')
    expect(previewState()).toBe('ready')
  })

  it('D-5 还在取：没有按钮', async () => {
    artifactRead.mockReturnValue(
      new Promise(() => {
        // 永不落定
      })
    )
    show('artifact', 'pending.svg')
    await flush()
    expect(container.textContent).toContain('Rendering')
    expect(exportButtons()).toHaveLength(0)
  })

  it.each([
    ['内容不是 SVG', { name: 'notes.svg', title: 'Notes', content: 'just some text' }],
    ['.html（交互图，走沙箱）', { name: 'growth.html', title: 'Growth', content: '<div>hi</div>' }],
    ['找不到', null]
  ])('D-5 %s：没有按钮', async (_label, row) => {
    artifactRead.mockResolvedValue(row)
    show('artifact', row?.name ?? 'missing.svg')
    await flush()
    expect(artifactRead).toHaveBeenCalled()
    expect(exportButtons()).toHaveLength(0)
  })
})

describe('不导出的围栏（D-7）', () => {
  it('D-7 ```interactive：没有导出按钮', () => {
    show('interactive', '<div id="d7">interactive</div>')
    expect(container.textContent).toContain('interactive')
    expect(exportButtons()).toHaveLength(0)
  })
})
