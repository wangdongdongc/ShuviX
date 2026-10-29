/**
 * 组件跟应用的主题走（2026-10-28，services/widget/widgetTheme.ts）—— 一条真的链路：设置（general.theme / darkTheme /
 * lightTheme）→ main/index.ts 注入的读取函数 → 页面骨架头部脚本在 `<html>` 上设 data-theme / data-scheme → theme.css
 * （带令牌的子资源）→ 真的 Tailwind 运行时把 `bg-surface`、`dark:` 解到 --widget-* 上 → Chromium 算出颜色；设置一变，
 * settingsService → 应用事件总线 → 组件服务器在 SSE 上推 `theme` → 页面就地换属性，不重载。单测里没有的就是这些：
 * 读取函数的接线、事件总线到 SSE、theme.css 的令牌钩子、真的 Tailwind 与真的颜色解析。
 *
 *   E-1 种一个组件（`bg-surface text-fg dark:underline`、useTheme() 显示主题名、一个计数器、挂载时设一次
 *       window.__mounted），设置为 深色 + nord / solarized-light，开在 Widget 面板里，接上它的 iframe target：
 *       data-theme=nord、data-scheme=dark；表面底色 = 页面里解析出的 --theme-bg-secondary（nord 的 #3b4252）；
 *       themeColor('accent') = rgb(136, 192, 208)；dark: 生效（下划线）。点一下计数器；darkTheme 改成 dracula →
 *       data-theme=dracula、__mounted 不变、计数器还是 1、显示的主题名跟着变；general.theme 改成 light →
 *       solarized-light / light、没有下划线、强调色变了；themeColor 的 success / viz-1-tint / on-accent 都是 rgb(a)(…)。
 *       最后把三个设置还原。
 *
 * 组件页面在 Widget 面板的跨源 iframe 里，自己有一个 CDP target（`iframe`）；页面里的 DOM 是这个 spec 自己写的组件，
 * 读它不经 pages.ts（与 widget-api.e2e.ts 同一种做法）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connect, listTargets, until, type CdpClient } from '../../harness/cdp'
import { launchApp, type E2EApp } from '../../harness/launch'
import { rightPanelPane, widgetPanelPane } from '../../harness/pages'

const WIDGET = 'theme-probe'
const THEME_KEYS = ['general.theme', 'general.darkTheme', 'general.lightTheme'] as const
const DEFAULTS: Record<(typeof THEME_KEYS)[number], string> = {
  'general.theme': 'dark',
  'general.darkTheme': 'github-dark',
  'general.lightTheme': 'github-light'
}

/** 组件界面：主题名、明暗、计数器；themeColor 挂在 window 上给 spec 调 */
const SCREEN_TSX = `import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { themeColor, useTheme } from 'shuvix/widget'

const w = window as unknown as { __mounted?: number; __themeColor?: (name: string) => string }
if (w.__mounted === undefined) w.__mounted = Math.random()
w.__themeColor = themeColor

function App() {
  const theme = useTheme()
  const [count, setCount] = useState(0)
  return (
    <div data-surface="" className="bg-surface text-fg dark:underline p-4">
      <span data-theme-id="">{theme.id}</span>
      <span data-theme-scheme="">{theme.scheme}</span>
      <button data-count="" onClick={() => setCount((c) => c + 1)}>
        {count}
      </button>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
`

let app: E2EApp
let frame: CdpClient | null = null
const original: Partial<Record<(typeof THEME_KEYS)[number], unknown>> = {}

function seedWidget(home: string): void {
  const dir = join(home, '.shuvix', 'widgets', WIDGET)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'widget.json'),
    JSON.stringify(
      { id: WIDGET, name: 'Theme probe', description: '', entryFile: 'index.tsx', createdAt: 1000 },
      null,
      2
    ) + '\n'
  )
  writeFileSync(join(dir, 'index.tsx'), SCREEN_TSX)
}

const setSetting = (key: string, value: string): Promise<unknown> =>
  app.main.eval(`window.api.settings.set(${JSON.stringify({ key, value })})`)

// ─── 组件页面（iframe 自己的 CDP target）里读 ─────────

interface PageState {
  theme: string | null
  scheme: string | null
  shownId: string
  shownScheme: string
  count: string
  mounted: number | null
}

const pageState = (): Promise<PageState> =>
  frame!.eval<PageState>(`(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    scheme: document.documentElement.getAttribute('data-scheme'),
    shownId: document.querySelector('[data-theme-id]')?.textContent ?? '',
    shownScheme: document.querySelector('[data-theme-scheme]')?.textContent ?? '',
    count: document.querySelector('[data-count]')?.textContent ?? '',
    mounted: typeof window.__mounted === 'number' ? window.__mounted : null
  }))()`)

/** 表面那一块此刻的计算样式 */
const surfaceStyle = (): Promise<{ background: string; decoration: string }> =>
  frame!.eval<{ background: string; decoration: string }>(`(() => {
    const s = getComputedStyle(document.querySelector('[data-surface]'))
    return { background: s.backgroundColor, decoration: s.textDecorationLine }
  })()`)

/** 一个变量在这个页面里解析出的颜色（用一个临时元素的 background-color 量） */
const resolved = (variable: string): Promise<string> =>
  frame!.eval<string>(`(() => {
    const probe = document.createElement('div')
    probe.style.backgroundColor = 'var(${variable})'
    document.body.appendChild(probe)
    const value = getComputedStyle(probe).backgroundColor
    probe.remove()
    return value
  })()`)

const themeColor = (name: string): Promise<string> =>
  frame!.eval<string>(`window.__themeColor(${JSON.stringify(name)})`)

async function shows(theme: string, scheme: 'light' | 'dark'): Promise<PageState> {
  return until(async () => {
    const s = await pageState()
    return s.theme === theme &&
      s.scheme === scheme &&
      s.shownId === theme &&
      s.shownScheme === scheme
      ? s
      : null
  }, `the widget page shows ${theme} (${scheme})`)
}

beforeAll(async () => {
  app = await launchApp()
  for (const key of THEME_KEYS) {
    original[key] = await app.main.eval(`window.api.settings.get(${JSON.stringify(key)})`)
  }
  await setSetting('general.theme', 'dark')
  await setSetting('general.darkTheme', 'nord')
  await setSetting('general.lightTheme', 'solarized-light')
  seedWidget(app.home)

  await until(
    () => app.main.eval<boolean>(`!!document.querySelector('button[data-side="right"]')`),
    'the right panel toggle'
  )
  const right = rightPanelPane(app.main)
  await right.open()
  await right.activateWidgetTab()
  const panel = widgetPanelPane(app.main)
  await panel.reload()
  await until(async () => (await panel.cardIds()).includes(WIDGET) || null, 'the widget card')
}, 120_000)

afterAll(async () => {
  frame?.close()
  if (app) {
    for (const key of THEME_KEYS) {
      const value = original[key]
      await setSetting(key, typeof value === 'string' && value ? value : DEFAULTS[key]).catch(
        () => {}
      )
    }
  }
  await app?.stop()
})

describe('widgets follow the app theme', () => {
  it('E-1 the page carries the chosen theme, swaps it live on a settings change and keeps its state', async () => {
    const panel = widgetPanelPane(app.main)
    await panel.clickCard(WIDGET)
    await until(async () => (await panel.foregroundApp()) === WIDGET || null, 'opened in panel')
    await until(() => panel.frameReady(WIDGET), 'the widget iframe')
    const target = await until(
      async () =>
        (await listTargets(app.port)).find(
          (t) => t.type === 'iframe' && t.url.includes(`/w/${WIDGET}/`)
        ),
      'the widget iframe target',
      30_000
    )
    frame = await connect(target.webSocketDebuggerUrl)
    await until(
      () => frame!.eval<boolean>(`!!document.querySelector('[data-count]')`),
      'the widget screen mounted',
      30_000
    )

    // 1. 深色 + nord：首帧就是它
    const first = await shows('nord', 'dark')
    expect(first.mounted).not.toBeNull()
    // Tailwind 运行时在挂载之后才出样式：等表面有了底色
    const secondary = await resolved('--theme-bg-secondary')
    expect(secondary).toBe('rgb(59, 66, 82)')
    const surface = await until(async () => {
      const s = await surfaceStyle()
      return s.background === secondary ? s : null
    }, 'bg-surface resolves to --theme-bg-secondary')
    expect(surface.decoration).toBe('underline')
    expect(await themeColor('accent')).toBe('rgb(136, 192, 208)')

    // 2. 界面状态：点一下计数器
    await frame.eval(`(document.querySelector('[data-count]').click(), true)`)
    await until(async () => (await pageState()).count === '1' || null, 'the counter at 1')

    // 3. 换深色那一套：就地换，不重载
    await setSetting('general.darkTheme', 'dracula')
    const dracula = await shows('dracula', 'dark')
    expect(dracula.mounted).toBe(first.mounted)
    expect(dracula.count).toBe('1')
    const draculaAccent = await themeColor('accent')
    expect(draculaAccent).not.toBe('rgb(136, 192, 208)')
    await until(
      async () =>
        (await surfaceStyle()).background === (await resolved('--theme-bg-secondary')) || null,
      'bg-surface follows dracula'
    )
    expect((await surfaceStyle()).background).not.toBe(secondary)

    // 4. 模式改成浅色：浅色那一套，dark: 不再生效
    await setSetting('general.theme', 'light')
    const light = await shows('solarized-light', 'light')
    expect(light.mounted).toBe(first.mounted)
    expect(light.count).toBe('1')
    await until(
      async () => ((await surfaceStyle()).decoration === 'none' ? true : null),
      'dark:underline off in light'
    )
    expect((await surfaceStyle()).background).toBe(await resolved('--theme-bg-secondary'))
    const lightAccent = await themeColor('accent')
    expect(lightAccent).toMatch(/^rgba?\(/)
    expect(lightAccent).not.toBe(draculaAccent)
    expect(lightAccent).not.toBe('rgb(136, 192, 208)')

    // 5. 要具体颜色的地方（oklch 的状态色、color-mix 的浅底、light-dark 的字色）都交回 rgb(a)
    for (const name of ['success', 'viz-1-tint', 'on-accent']) {
      expect(await themeColor(name), name).toMatch(/^rgba?\(/)
    }
  })
})
