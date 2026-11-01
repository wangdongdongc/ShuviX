// @vitest-environment jsdom
/**
 * `web/firstPaintBackground.ts` 与 `web.html` 的内联主题脚本 —— web 客户端的首帧底色。内联脚本在样式到之前给根元素垫上
 * 明暗（`color-scheme`）与上次记下的这个主题的底色（`localStorage['themeBg:<主题 id>']`）；样式到了之后
 * `settleFirstPaintBackground` 撤掉这两样，并记下每个主题此刻 body 的底色（之后 `data-theme` 一变再记一次）。
 *
 * 主题样式用一段 `<style>` 代替（nord / dracula 两个主题给 body 底色，别的主题没有规则 = 透明）；storage 缺省是假的
 * `{ setItem }`；改了属性之后等一个微任务（MutationObserver 的回调）。每条用例之前清掉 html 的属性与 style、清 localStorage。
 *
 *   FP-1 html 上垫着 background-color / color-scheme，还有一条 font-size → 撤完只剩 font-size；data-theme 不动
 *   FP-2 data-theme="nord" → setItem('themeBg:nord', body 的底色) 恰好一次（是 body 的，不是 html 内联的那个）
 *   FP-3 换成 dracula → 记 dracula，nord 不再写；改 class / data-scheme / style → 不再 setItem
 *   FP-4 没有 data-theme → 不 setItem；撤完之后去掉 data-theme → 不 setItem、不抛
 *   FP-5 setItem 抛 → 撤的时候不抛、样式照撤；之后换主题照样去写、没有未捕获的错误
 *   FP-6 storage = null → 只撤样式；文档没有 defaultView（createHTMLDocument）→ 只撤样式、不抛
 *   FP-7 缺省 storage：(a) 真的 window.localStorage 里记下 themeBg:nord (b) 读 localStorage 本身就抛 → 不抛、样式照撤
 *   FP-8 web.html 的内联脚本（取那段不带 src 的 <script>，matchMedia 是桩）：(a) 什么都没存 → github-dark、深色、不垫底色
 *        (b) theme=light + lightTheme=one-light + 记过它的底色 → one-light、浅色、垫上那个底色
 *        (c) theme=system + 系统深色 → github-dark、深色（系统浅色 → github-light、浅色）
 *        (d) 来回：settle 记下 nord 的底色 → 清掉 html → darkTheme=nord 再跑内联脚本 → 垫的正是记下的那个
 *   FP-9 body 底色透明的主题（没有它的规则）→ 不为它 setItem
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { settleFirstPaintBackground, THEME_BG_KEY_PREFIX } from '../firstPaintBackground'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `apps/desktop/src/renderer/src/web/__tests__` → `apps/desktop/src/renderer` */
const RENDERER_DIR = resolve(HERE, '../../..')

const NORD_BG = 'rgb(46, 52, 64)'
const DRACULA_BG = 'rgb(40, 42, 54)'

const html = (): HTMLElement => document.documentElement

let storage: { setItem: Mock<(key: string, value: string) => void> }

/** MutationObserver 的回调是微任务 */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

function resetHtml(): void {
  for (const name of ['data-theme', 'data-scheme', 'class', 'style']) html().removeAttribute(name)
}

/** web.html 里那段不带 src 的内联脚本 */
function inlineThemeScript(): string {
  const source = readFileSync(join(RENDERER_DIR, 'web.html'), 'utf8')
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  expect(scripts, 'web.html 里应恰好有一段不带属性的 <script>').toHaveLength(1)
  return scripts[0]
}

beforeAll(() => {
  const style = document.createElement('style')
  style.textContent = `
    [data-theme='nord'] body { background-color: ${NORD_BG}; }
    [data-theme='dracula'] body { background-color: ${DRACULA_BG}; }
  `
  document.head.appendChild(style)
})

beforeEach(() => {
  resetHtml()
  localStorage.clear()
  storage = { setItem: vi.fn<(key: string, value: string) => void>() }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('FP-1 撤掉垫的两样', () => {
  it('FP-1 background-color / color-scheme 撤掉，font-size 留着；data-theme 不动', async () => {
    html().setAttribute('data-theme', 'nord')
    html().setAttribute(
      'style',
      'background-color: rgb(9, 9, 9); color-scheme: dark; font-size: 12px'
    )
    settleFirstPaintBackground(document, storage)
    await flush()
    expect(html().style.getPropertyValue('background-color')).toBe('')
    expect(html().style.getPropertyValue('color-scheme')).toBe('')
    expect(html().style.getPropertyValue('font-size')).toBe('12px')
    expect(html().style.length).toBe(1)
    expect(html().getAttribute('data-theme')).toBe('nord')
  })
})

describe('FP-2 / FP-3 记下每个主题 body 的底色', () => {
  it('FP-2 data-theme="nord" → 记 body 的底色，恰好一次', async () => {
    THEME_BG_KEY_PREFIX satisfies 'themeBg:'
    html().setAttribute('data-theme', 'nord')
    html().style.backgroundColor = 'rgb(9, 9, 9)'
    settleFirstPaintBackground(document, storage)
    await flush()
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(storage.setItem).toHaveBeenCalledWith('themeBg:nord', NORD_BG)
  })

  it('FP-3 换 dracula → 记 dracula、nord 不再写；改 class / data-scheme / style 不再写', async () => {
    html().setAttribute('data-theme', 'nord')
    settleFirstPaintBackground(document, storage)
    await flush()
    html().setAttribute('data-theme', 'dracula')
    await flush()
    expect(storage.setItem.mock.calls).toEqual([
      ['themeBg:nord', NORD_BG],
      ['themeBg:dracula', DRACULA_BG]
    ])

    html().setAttribute('class', 'dark')
    await flush()
    html().setAttribute('data-scheme', 'dark')
    await flush()
    html().style.fontSize = '14px'
    await flush()
    expect(storage.setItem).toHaveBeenCalledTimes(2)
  })
})

describe('FP-4 没有主题', () => {
  it('FP-4 没有 data-theme → 不 setItem', async () => {
    settleFirstPaintBackground(document, storage)
    await flush()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('FP-4 撤完之后去掉 data-theme → 不 setItem、不抛', async () => {
    const errors: unknown[] = []
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error ?? e.message)
    }
    window.addEventListener('error', onError)
    try {
      html().setAttribute('data-theme', 'nord')
      settleFirstPaintBackground(document, storage)
      await flush()
      expect(storage.setItem).toHaveBeenCalledTimes(1)
      html().removeAttribute('data-theme')
      await flush()
      expect(storage.setItem).toHaveBeenCalledTimes(1)
      expect(errors).toEqual([])
    } finally {
      window.removeEventListener('error', onError)
    }
  })
})

describe('FP-5 存不进去', () => {
  it('FP-5 setItem 抛 → 不抛、样式照撤；之后换主题照样去写，没有未捕获的错误', async () => {
    const errors: unknown[] = []
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error ?? e.message)
    }
    window.addEventListener('error', onError)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwing = {
      setItem: vi.fn(() => {
        throw new DOMException('quota exceeded', 'QuotaExceededError')
      })
    }
    try {
      html().setAttribute('data-theme', 'nord')
      html().setAttribute('style', 'background-color: rgb(9, 9, 9); color-scheme: dark')
      expect(() => settleFirstPaintBackground(document, throwing)).not.toThrow()
      expect(html().style.length).toBe(0)
      expect(throwing.setItem).toHaveBeenCalledTimes(1)

      html().setAttribute('data-theme', 'dracula')
      await flush()
      expect(throwing.setItem).toHaveBeenCalledTimes(2)
      expect(throwing.setItem).toHaveBeenLastCalledWith('themeBg:dracula', DRACULA_BG)
      expect(errors).toEqual([])
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('error', onError)
    }
  })
})

describe('FP-6 没有地方存 / 没有窗口', () => {
  it('FP-6 storage = null → 只撤样式：不读底色、不再看着 data-theme', async () => {
    const view = document.defaultView!
    const computed = vi.spyOn(view, 'getComputedStyle')
    // 前面用例留下的观察者（产品从不 disconnect）每次换主题各读一次底色：先数出这个基数
    html().setAttribute('data-theme', 'nord')
    await flush()
    const leftover = computed.mock.calls.length
    computed.mockClear()

    html().setAttribute('style', 'background-color: rgb(9, 9, 9); color-scheme: dark')
    expect(() => settleFirstPaintBackground(document, null)).not.toThrow()
    expect(html().style.length).toBe(0)
    expect(computed).not.toHaveBeenCalled()
    // 换主题：只有留下的那些观察者在读，这一次没有多装一个
    html().setAttribute('data-theme', 'dracula')
    await flush()
    expect(computed).toHaveBeenCalledTimes(leftover)
  })

  it('FP-6 文档没有 defaultView → 只撤样式、不抛、不 setItem', async () => {
    const doc = document.implementation.createHTMLDocument('detached')
    expect(doc.defaultView).toBeNull()
    doc.documentElement.setAttribute('data-theme', 'nord')
    doc.documentElement.setAttribute(
      'style',
      'background-color: rgb(9, 9, 9); color-scheme: dark; font-size: 12px'
    )
    expect(() => settleFirstPaintBackground(doc, storage)).not.toThrow()
    expect(doc.documentElement.style.getPropertyValue('background-color')).toBe('')
    expect(doc.documentElement.style.getPropertyValue('color-scheme')).toBe('')
    expect(doc.documentElement.style.getPropertyValue('font-size')).toBe('12px')
    doc.documentElement.setAttribute('data-theme', 'dracula')
    await flush()
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})

describe('FP-7 缺省 storage', () => {
  it('FP-7a 不传参数 → 记进真的 window.localStorage', async () => {
    html().setAttribute('data-theme', 'nord')
    settleFirstPaintBackground()
    await flush()
    expect(window.localStorage.getItem('themeBg:nord')).toBe(NORD_BG)
  })

  it('FP-7b 读 localStorage 本身就抛 → 不抛、样式照撤', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(() => window.localStorage).toThrow()
    html().setAttribute('data-theme', 'nord')
    html().setAttribute('style', 'background-color: rgb(9, 9, 9); color-scheme: dark')
    expect(() => settleFirstPaintBackground()).not.toThrow()
    expect(html().style.length).toBe(0)
  })
})

describe('FP-8 web.html 的内联脚本', () => {
  let dark = true

  beforeEach(() => {
    dark = true
    ;(window as unknown as { matchMedia: unknown }).matchMedia = vi.fn((query: string) => ({
      media: query,
      matches: query === '(prefers-color-scheme: dark)' ? dark : false
    }))
  })

  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia
  })

  const runInline = (): void => {
    new Function(inlineThemeScript())()
  }

  it('FP-8a 什么都没存 → github-dark、深色、不垫底色', () => {
    runInline()
    expect(html().getAttribute('data-theme')).toBe('github-dark')
    expect(html().style.colorScheme).toBe('dark')
    expect(html().style.backgroundColor).toBe('')
  })

  it('FP-8b theme=light + lightTheme=one-light + 记过底色 → one-light、浅色、垫上那个底色', () => {
    localStorage.setItem('theme', 'light')
    localStorage.setItem('lightTheme', 'one-light')
    localStorage.setItem('themeBg:one-light', 'rgb(1, 2, 3)')
    runInline()
    expect(html().getAttribute('data-theme')).toBe('one-light')
    expect(html().style.colorScheme).toBe('light')
    expect(html().style.backgroundColor).toBe('rgb(1, 2, 3)')
  })

  it('FP-8c theme=system + 系统深色 → github-dark、深色', () => {
    localStorage.setItem('theme', 'system')
    runInline()
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)')
    expect(html().getAttribute('data-theme')).toBe('github-dark')
    expect(html().style.colorScheme).toBe('dark')
  })

  it('FP-8c theme=system + 系统浅色 → github-light、浅色', () => {
    localStorage.setItem('theme', 'system')
    dark = false
    runInline()
    expect(html().getAttribute('data-theme')).toBe('github-light')
    expect(html().style.colorScheme).toBe('light')
  })

  it('FP-8d 来回：settle 记下的 nord 底色，下次打开垫的正是它', async () => {
    html().setAttribute('data-theme', 'nord')
    settleFirstPaintBackground(document, window.localStorage)
    await flush()
    const stored = localStorage.getItem(THEME_BG_KEY_PREFIX + 'nord')
    expect(stored).toBe(NORD_BG)

    resetHtml()
    localStorage.setItem('darkTheme', 'nord')
    runInline()
    expect(html().getAttribute('data-theme')).toBe('nord')
    expect(html().style.colorScheme).toBe('dark')
    expect(html().style.backgroundColor).toBe(stored)
  })
})

describe('FP-9 透明的底色不记', () => {
  it('FP-9 没有规则的主题（body 透明）→ 不为它 setItem', async () => {
    html().setAttribute('data-theme', 'github-dark')
    settleFirstPaintBackground(document, storage)
    await flush()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('FP-9 从 nord 换到没有规则的主题 → 只记过 nord', async () => {
    html().setAttribute('data-theme', 'nord')
    settleFirstPaintBackground(document, storage)
    await flush()
    html().setAttribute('data-theme', 'solarized-light')
    await flush()
    expect(storage.setItem.mock.calls).toEqual([['themeBg:nord', NORD_BG]])
  })
})
