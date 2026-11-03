// @vitest-environment jsdom
/**
 * settingsStore 读到设置之前的主题 —— 必须与 HTML 内联脚本首帧设的是同一个。
 *
 * 各窗口的外壳一挂载就按 store 写 data-theme，md / 文件预览 / widget / 悬浮窗又在首帧（ready-to-show）
 * 就显示：store 要是写死 github-dark，窗口就先白、再黑一下、等设置读回来才变回用户的主题。
 * 这里按「新开一个窗口」的样子跑：每条用例重新导入 store，内联脚本取自真的 index.html 与 web.html。
 *
 *   FT-1 什么都没存 → system / github-dark / github-light，loaded 还是 false
 *   FT-2 存过的那份原样进 store（亮色 + 具体主题、system、深色 + 具体主题）
 *   FT-3 theme 是认不得的字符串 → 按 dark，具体主题照读（内联脚本同样如此）
 *   FT-4 store 解析出的主题 id 与两份 HTML 的内联脚本一致（覆盖 FT-2/3 的各种存法 × 系统明暗）
 *   FT-5 读 localStorage 就抛 → 回缺省，导入不抛
 *   FT-6 设置读回来之后以设置为准，并写回 localStorage（主题与语言）
 *   FT-7 设置里没存 → system，语言记成 en（不看系统语言）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `apps/desktop/src/renderer/src/stores/__tests__` → `apps/desktop/src/renderer` */
const RENDERER_DIR = resolve(HERE, '../../..')

/** 一份 HTML 里那段不带属性的内联脚本 */
function inlineThemeScript(file: string): string {
  const source = readFileSync(join(RENDERER_DIR, file), 'utf8')
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  expect(scripts, `${file} 里应恰好有一段不带属性的 <script>`).toHaveLength(1)
  return scripts[0][1]
}

/** 新窗口里的 store：模块状态每次都是新的 */
async function freshStore(): Promise<(typeof import('../settingsStore'))['useSettingsStore']> {
  vi.resetModules()
  return (await import('../settingsStore')).useSettingsStore
}

function stubSystemDark(dark: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? dark : false
    })
  })
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  stubSystemDark(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as unknown as { matchMedia?: unknown }).matchMedia
})

describe('settingsStore 读到设置之前的主题', () => {
  it('FT-1 什么都没存 → 缺省，loaded 还是 false', async () => {
    const state = (await freshStore()).getState()
    expect(state.theme).toBe('system')
    expect(state.darkTheme).toBe('github-dark')
    expect(state.lightTheme).toBe('github-light')
    expect(state.loaded).toBe(false)
  })

  it('FT-2 存过的那份原样进 store', async () => {
    localStorage.setItem('theme', 'light')
    localStorage.setItem('darkTheme', 'tokyo-night')
    localStorage.setItem('lightTheme', 'solarized-light')
    const state = (await freshStore()).getState()
    expect(state.theme).toBe('light')
    expect(state.darkTheme).toBe('tokyo-night')
    expect(state.lightTheme).toBe('solarized-light')

    localStorage.setItem('theme', 'system')
    expect((await freshStore()).getState().theme).toBe('system')

    localStorage.setItem('theme', 'dark')
    expect((await freshStore()).getState().theme).toBe('dark')
  })

  it('FT-3 theme 认不得 → 按 dark，具体主题照读', async () => {
    localStorage.setItem('theme', 'banana')
    localStorage.setItem('darkTheme', 'nord')
    const state = (await freshStore()).getState()
    expect(state.theme).toBe('dark')
    expect(state.darkTheme).toBe('nord')
  })

  describe.each(['index.html', 'web.html'])('FT-4 与 %s 的内联脚本一致', (file) => {
    it.each([
      { stored: {}, systemDark: true },
      { stored: {}, systemDark: false },
      { stored: { theme: 'light' }, systemDark: true },
      { stored: { theme: 'light', lightTheme: 'one-light' }, systemDark: true },
      { stored: { theme: 'dark', darkTheme: 'tokyo-night' }, systemDark: false },
      { stored: { theme: 'system', darkTheme: 'nord' }, systemDark: true },
      { stored: { theme: 'system', lightTheme: 'catppuccin-latte' }, systemDark: false },
      { stored: { theme: 'banana', darkTheme: 'dracula' }, systemDark: false }
    ])('$stored 系统深色=$systemDark', async ({ stored, systemDark }) => {
      for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value)
      stubSystemDark(systemDark)
      new Function(inlineThemeScript(file))()

      const { theme, darkTheme, lightTheme } = (await freshStore()).getState()
      // 各窗口外壳的算法（App.tsx、MarkdownWindowShell 等）
      const mode = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
      const fromStore = mode === 'dark' ? darkTheme : lightTheme

      expect(fromStore).toBe(document.documentElement.getAttribute('data-theme'))
    })
  })

  it('FT-5 读 localStorage 就抛 → 回缺省，导入不抛', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const state = (await freshStore()).getState()
    expect(state.theme).toBe('system')
    expect(state.darkTheme).toBe('github-dark')
    expect(state.lightTheme).toBe('github-light')
  })

  it('FT-6 设置读回来之后以设置为准，并写回 localStorage', async () => {
    localStorage.setItem('theme', 'light')
    localStorage.setItem('lightTheme', 'one-light')
    const store = await freshStore()
    store.getState().loadSettings({
      'general.theme': 'dark',
      'general.darkTheme': 'nord',
      'general.language': 'ja'
    })
    const state = store.getState()
    expect(state.theme).toBe('dark')
    expect(state.darkTheme).toBe('nord')
    expect(state.lightTheme).toBe('github-light')
    expect(state.loaded).toBe(true)
    expect(localStorage.getItem('theme')).toBe('dark')
    expect(localStorage.getItem('darkTheme')).toBe('nord')
    expect(localStorage.getItem('lightTheme')).toBe('github-light')
    expect(localStorage.getItem('language')).toBe('ja')
  })

  it('FT-7 设置里没存 → system，语言记成 en（不看系统语言）', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
    localStorage.setItem('theme', 'light')
    localStorage.setItem('language', 'zh')
    const store = await freshStore()
    store.getState().loadSettings({})
    expect(store.getState().theme).toBe('system')
    expect(localStorage.getItem('theme')).toBe('system')
    expect(localStorage.getItem('language')).toBe('en')
  })
})
