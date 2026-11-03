// @vitest-environment jsdom
/**
 * 弹层住的那份文档（browserPopoverHost.ts）：外壳 window.open 出来，样式表与 <html> 上的主题从外壳抄过去。
 *
 *   BPH-1  warm + mount 各调一次：window.open('', 约定的名字) 只有一次，回同一个 host；
 *   BPH-2  外壳的 link / style 抄过去（link 是绝对地址），透明的基础样式排在 head 最后，<html> 的属性一样；
 *   BPH-3  等样式表：link 加载完（或失败）才 ready，订阅者只通知一次；没有样式表也要等下一个微任务；
 *   BPH-4  外壳后来改了主题 / 字号、head 里多了样式表：跟过去，样式只抄一次，基础样式仍在最后、不重复；
 *   BPH-5  同名窗口里还有上次的东西（外壳刷新过）：清掉再抄；
 *   BPH-6  window.open 回 null / 抛了：回 null、记一条警告、ready 还是 null，下一次再试；
 *   BPH-7  窗口被关了：再开一个，新的抄完才 ready，旧窗口的样式表晚到不算数。
 *
 * 这个文件里没有 React，所以每条用例 resetModules 拿一份新的模块状态（React 测试文件不能这样，见 browserDomSupport）。
 * 上一条用例留下的 MutationObserver 还看着外壳的 head，所以 iframe 留到整个文件结束才摘。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

type HostModule = typeof import('../browserPopoverHost')
type FrameWindow = Window & typeof globalThis

const FRAME_NAME = 'shuvix-browser-popover'

let open: Mock<(...args: unknown[]) => unknown>
const frames: HTMLIFrameElement[] = []

function newFrameWindow(): FrameWindow {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  frames.push(frame)
  return frame.contentWindow as FrameWindow
}

async function load(): Promise<HostModule> {
  vi.resetModules()
  return import('../browserPopoverHost')
}

/** 把排着的微任务跑完（Promise.all + then、MutationObserver 都在这里） */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function addShellLink(href = '/assets/main.css'): HTMLLinkElement {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = href
  document.head.appendChild(link)
  return link
}

function addShellStyle(text: string): HTMLStyleElement {
  const style = document.createElement('style')
  style.textContent = text
  document.head.appendChild(style)
  return style
}

/** 抄过去的基础样式（透明背景那条） */
const isBaseStyle = (el: Element | null): boolean =>
  !!el && el.tagName === 'STYLE' && !!el.textContent?.includes('background:transparent')

beforeEach(() => {
  document.head.replaceChildren()
  for (const name of document.documentElement.getAttributeNames()) {
    document.documentElement.removeAttribute(name)
  }
  open = vi.fn()
  window.open = open as unknown as typeof window.open
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  for (const frame of frames) frame.remove()
})

describe('只开一次（BPH-1）', () => {
  it('BPH-1 warm 之后 mount 再要一次：window.open 只调一次，回同一个 host', async () => {
    const win = newFrameWindow()
    open.mockReturnValue(win)
    const mod = await load()

    mod.warmBrowserPopover()
    const first = mod.openPopoverHost()
    const second = mod.openPopoverHost()

    expect(open.mock.calls).toEqual([['', FRAME_NAME]])
    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(first?.win).toBe(win)
    expect(first?.root).toBe(win.document.body)
  })
})

describe('样式与主题（BPH-2 / BPH-4 / BPH-5）', () => {
  it('BPH-2 link（绝对地址）与 style 抄过去，基础样式在 head 最后，<html> 的属性一样', async () => {
    const win = newFrameWindow()
    open.mockReturnValue(win)
    const shellLink = addShellLink('/assets/main.css')
    addShellStyle('.a { color: red }')
    document.documentElement.setAttribute('data-theme', 'github-dark')
    document.documentElement.setAttribute('style', '--app-font-size: 15px;')
    const mod = await load()

    mod.openPopoverHost()

    const doc = win.document
    const link = doc.head.querySelector('link')!
    expect(link.getAttribute('href')).toBe(shellLink.href)
    expect(shellLink.href).toMatch(/^https?:\/\//)
    expect(link.rel).toBe('stylesheet')
    expect([...doc.head.querySelectorAll('style')].map((s) => s.textContent)).toContain(
      '.a { color: red }'
    )
    expect(isBaseStyle(doc.head.lastElementChild)).toBe(true)
    expect(doc.documentElement.getAttribute('data-theme')).toBe('github-dark')
    expect(doc.documentElement.getAttribute('style')).toBe('--app-font-size: 15px;')
  })

  it('BPH-4 外壳改了主题 / 字号：弹层的 <html> 跟着', async () => {
    const win = newFrameWindow()
    open.mockReturnValue(win)
    document.documentElement.setAttribute('data-theme', 'github-light')
    const mod = await load()
    mod.openPopoverHost()
    const html = win.document.documentElement
    expect(html.getAttribute('data-theme')).toBe('github-light')

    document.documentElement.setAttribute('data-theme', 'github-dark')
    document.documentElement.style.setProperty('--app-font-size', '18px')
    await microtasks()

    expect(html.getAttribute('data-theme')).toBe('github-dark')
    expect(html.getAttribute('style')).toBe(document.documentElement.getAttribute('style'))
    expect(html.getAttribute('style')).toContain('--app-font-size')
  })

  it('BPH-4 外壳 head 里多了样式表：抄一次；再变也不重复，基础样式仍在最后、只有一份', async () => {
    const win = newFrameWindow()
    open.mockReturnValue(win)
    const mod = await load()
    mod.openPopoverHost()
    const head = win.document.head

    addShellStyle('.lazy-chunk { color: blue }')
    await microtasks()
    const copies = (): number =>
      [...head.querySelectorAll('style')].filter((s) => s.textContent?.includes('.lazy-chunk'))
        .length
    expect(copies()).toBe(1)
    expect(isBaseStyle(head.lastElementChild)).toBe(true)

    document.head.appendChild(document.createElement('meta'))
    await microtasks()
    expect(copies()).toBe(1)
    expect(isBaseStyle(head.lastElementChild)).toBe(true)
    expect([...head.querySelectorAll('style')].filter(isBaseStyle)).toHaveLength(1)
  })

  it('BPH-5 同名窗口里还有上次的 head 与 body：清掉再抄', async () => {
    const win = newFrameWindow()
    open.mockReturnValue(win)
    const doc = win.document
    doc.head.innerHTML = '<style data-stale>.old { color: red }</style>'
    doc.body.innerHTML = '<div data-stale>old bubble</div>'
    addShellStyle('.new { color: blue }')
    const mod = await load()

    mod.openPopoverHost()

    expect(doc.querySelector('[data-stale]')).toBeNull()
    expect(doc.body.children).toHaveLength(0)
    expect(doc.head.textContent).toContain('.new')
    expect(doc.head.textContent).not.toContain('.old')
  })
})

describe('什么时候算备好（BPH-3）', () => {
  it.each(['load', 'error'])('BPH-3 link 的 %s 来了才 ready，订阅者通知一次', async (eventName) => {
    const win = newFrameWindow()
    open.mockReturnValue(win)
    addShellLink()
    const mod = await load()
    const listener = vi.fn()
    mod.subscribePopoverHost(listener)

    const host = mod.openPopoverHost()
    await microtasks()
    expect(mod.readyPopoverHost()).toBeNull()
    expect(listener).not.toHaveBeenCalled()

    win.document.head.querySelector('link')!.dispatchEvent(new Event(eventName))
    await microtasks()
    expect(mod.readyPopoverHost()).toBe(host)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('BPH-3 没有样式表：当场还不算，下一个微任务才 ready；退订之后不再通知', async () => {
    const win = newFrameWindow()
    open.mockReturnValue(win)
    const mod = await load()
    const listener = vi.fn()
    const off = mod.subscribePopoverHost(listener)

    const host = mod.openPopoverHost()
    expect(mod.readyPopoverHost()).toBeNull()
    await microtasks()
    expect(mod.readyPopoverHost()).toBe(host)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    expect(mod.subscribePopoverHost(vi.fn())).toEqual(expect.any(Function))
  })
})

describe('开不出来（BPH-6）', () => {
  it.each([
    ['回 null', (): void => void open.mockReturnValueOnce(null)],
    [
      '抛了',
      (): void =>
        void open.mockImplementationOnce(() => {
          throw new Error('blocked')
        })
    ]
  ])('BPH-6 window.open %s：回 null、警告一条、不 ready；下一次再试', async (_label, arrange) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const win = newFrameWindow()
    arrange()
    open.mockReturnValue(win)
    const mod = await load()

    let result: unknown
    expect(() => {
      result = mod.openPopoverHost()
    }).not.toThrow()
    expect(result).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    await microtasks()
    expect(mod.readyPopoverHost()).toBeNull()

    const retry = mod.openPopoverHost()
    expect(open).toHaveBeenCalledTimes(2)
    expect(retry?.win).toBe(win)
    await microtasks()
    expect(mod.readyPopoverHost()).toBe(retry)
  })
})

describe('窗口被关了（BPH-7）', () => {
  it('BPH-7 再开一个；新的抄完才 ready；旧窗口的样式表晚到不算数', async () => {
    const oldWin = newFrameWindow()
    const newWin = newFrameWindow()
    open.mockReturnValueOnce(oldWin).mockReturnValueOnce(newWin)
    addShellLink()
    const mod = await load()

    const first = mod.openPopoverHost()
    expect(first?.win).toBe(oldWin)
    Object.defineProperty(oldWin, 'closed', { configurable: true, value: true })

    const second = mod.openPopoverHost()
    expect(open).toHaveBeenCalledTimes(2)
    expect(second?.win).toBe(newWin)
    await microtasks()
    expect(mod.readyPopoverHost()).toBeNull()

    oldWin.document.head.querySelector('link')!.dispatchEvent(new Event('load'))
    await microtasks()
    expect(mod.readyPopoverHost()).toBeNull()

    newWin.document.head.querySelector('link')!.dispatchEvent(new Event('load'))
    await microtasks()
    expect(mod.readyPopoverHost()).toBe(second)
  })
})
