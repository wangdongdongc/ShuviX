/**
 * 组件页面的主题（widgetTheme.ts）—— 组件跟 ShuviX 选的那一套主题走：主题名单从 themes.css 自己读，三个设置值算出
 * 「模式 + 浅色那套 + 深色那套」，语义色名（WIDGET_THEME_COLORS）是对组件作者的契约，theme.css / Tailwind 声明 / 头部脚本
 * 都由它生成。纯函数，读仓库里的真文件对照（AppearanceTab.tsx 的名单、themes.css、Tailwind 自己的 theme.css）。
 *
 *   TH-1  widgetThemeSchemes()：正好 11 套（7 深 4 浅），与 AppearanceTab.tsx 文本里 DARK_THEMES / LIGHT_THEMES 的 id 一致
 *   TH-2  widgetThemeStateOf 表：缺省 = 深色 + GitHub 那一对；三种模式保留，别的（auto、空串、Dark）→ dark；放对一侧的 id
 *         保留；旧值 light / dark、放错一侧的、认不得的（nord-light、NORD、空串）、深色那格写 light → GitHub 那一对
 *   TH-3  currentWidgetTheme()：没注入 = 缺省；读取函数每次调用都现读；setWidgetThemeReader(null) 回到缺省
 *   TH-4  parseWidgetScheme：只认 light / dark；null、undefined、空串、Dark、system、' dark' → null
 *   TH-5  WIDGET_THEME_COLORS 的键正好是那 42 个名字（页面 / 表面 / 线 / 字 / 强调 / 状态 / 图表色）
 *   TH-6  改名护栏：取值里引用的每个 --theme-* 在 themes.css 的 11 个 `[data-theme='…']` 块里都有声明；引用的每个 --viz-*
 *         在 `:root, [data-theme]` 块里有声明
 *   TH-7  状态色就是 Tailwind 自己的值（node_modules/tailwindcss/theme.css）：light-dark(<emerald|amber|rose>-600, -400)
 *   TH-8  widgetThemeCss()：以 themes.css 全文（去掉尾部空白）开头，以一个 `:root {}` 结尾，里面每个 --widget-<名字>
 *         恰好声明一次、不多不少
 *   TH-9  WIDGET_TAILWIND_THEME：`@theme inline {}` 里每个键一行 `--color-<名字>: var(--widget-<名字>);`；dark 变体那一行
 *         原样；不提 prefers-color-scheme
 *   TH-10 themeBootScript：输出能被 new Function 解析；`var forced = null` / `"dark"`；状态里带 `</script>` 也不在输出里
 *         留下字面的 `</script`
 *   TH-11 Tailwind 真编译 `@import 'tailwindcss'` + exportThemeCss()：bg-surface → var(--widget-surface)；bg-accent/20 →
 *         对 var(--widget-accent) 的 color-mix；dark:bg-page → `[data-scheme=dark]` 选择器、没有媒体查询；fill-viz-2、
 *         text-on-accent 同理
 *
 * `@shuvix/app-shell/themes.css?raw` 在单测里读到真文件，靠 vitest.config.ts 的 `test.css.include`（vitest 缺省把 .css
 * 连带 `?raw` 换成空串 —— 那样名单是空的，所有 id 都落回 GitHub 那一对，theme.css 也没有主题块；TH-1 会先报）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compile } from 'tailwindcss'

vi.mock('../widgetService', () => ({ widgetService: {} }))
vi.mock('../../bundler', () => ({ bundlerResourcePath: (p: string) => p }))
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))

import {
  currentWidgetTheme,
  parseWidgetScheme,
  setWidgetThemeReader,
  themeBootScript,
  widgetThemeCss,
  widgetThemeSchemes,
  widgetThemeStateOf,
  WIDGET_TAILWIND_THEME,
  WIDGET_THEME_COLORS,
  type WidgetThemeState
} from '../widgetTheme'
import { exportThemeCss } from '../widgetExporter'

/** apps/desktop */
const DESKTOP_DIR = resolve(__dirname, '../../../../..')
const REPO_DIR = resolve(DESKTOP_DIR, '../..')
const THEMES_CSS = readFileSync(join(REPO_DIR, 'packages/app-shell/src/themes.css'), 'utf8')
const APPEARANCE_TAB = readFileSync(
  join(REPO_DIR, 'packages/app-shell/src/settings/AppearanceTab.tsx'),
  'utf8'
)
const requireHere = createRequire(import.meta.url)
const TAILWIND_DIR = dirname(requireHere.resolve('tailwindcss/package.json'))

const GITHUB = { light: 'github-light', dark: 'github-dark' }

/** AppearanceTab.tsx 里一份名单（`export const <NAME> … = [ … ]`）的 id */
function listIds(name: string): string[] {
  const block = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\n\\]`).exec(
    APPEARANCE_TAB
  )
  if (!block) throw new Error(`no ${name} in AppearanceTab.tsx`)
  return [...block[1].matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1])
}

/** 一个 CSS 块（选择器之后、第一个 `}` 之前；这些块里没有嵌套）里声明的自定义属性 */
function declaredIn(selector: RegExp, prefix: string): Set<string> {
  const m = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(THEMES_CSS)
  if (!m) throw new Error(`no block ${selector.source} in themes.css`)
  return new Set([...m[1].matchAll(new RegExp(`(${prefix}[a-z0-9-]+)\\s*:`, 'g'))].map((x) => x[1]))
}

/** WIDGET_THEME_COLORS 的取值里引用的变量（`var(--x)`），去重 */
function referenced(prefix: string): string[] {
  const out = new Set<string>()
  for (const value of Object.values(WIDGET_THEME_COLORS)) {
    for (const m of value.matchAll(new RegExp(`var\\((${prefix}[a-z0-9-]+)\\)`, 'g'))) {
      out.add(m[1])
    }
  }
  return [...out].sort()
}

const EXPECTED_NAMES = [
  'page',
  'surface',
  'raised',
  'hover',
  'active',
  'line',
  'line-subtle',
  'fg',
  'fg-muted',
  'fg-subtle',
  'accent',
  'accent-hover',
  'accent-muted',
  'on-accent',
  'success',
  'warning',
  'danger',
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `viz-${i}`),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `viz-${i}-tint`),
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `viz-${i}-ink`),
  'viz-wash'
]

afterEach(() => {
  setWidgetThemeReader(null)
})

describe('TH 主题名单与设置', () => {
  it('TH-1 11 套主题（7 深 4 浅），与设置页的两份名单一致', () => {
    const schemes = widgetThemeSchemes()
    const dark = listIds('DARK_THEMES')
    const light = listIds('LIGHT_THEMES')
    expect(dark).toHaveLength(7)
    expect(light).toHaveLength(4)

    expect(schemes.size).toBe(11)
    const darkHere = [...schemes].filter(([, s]) => s === 'dark').map(([id]) => id)
    const lightHere = [...schemes].filter(([, s]) => s === 'light').map(([id]) => id)
    expect(darkHere.sort()).toEqual([...dark].sort())
    expect(lightHere.sort()).toEqual([...light].sort())
  })

  it('TH-2 缺省 = 深色 + GitHub 那一对', () => {
    expect(widgetThemeStateOf({})).toEqual({ mode: 'dark', ...GITHUB })
  })

  it.each<[string | undefined, WidgetThemeState['mode']]>([
    ['light', 'light'],
    ['system', 'system'],
    ['dark', 'dark'],
    ['auto', 'dark'],
    ['', 'dark'],
    ['Dark', 'dark'],
    [undefined, 'dark']
  ])('TH-2 模式 %j → %s', (mode, expected) => {
    expect(widgetThemeStateOf({ mode }).mode).toBe(expected)
  })

  it('TH-2 放对一侧的主题保留', () => {
    expect(widgetThemeStateOf({ mode: 'system', light: 'solarized-light', dark: 'nord' })).toEqual({
      mode: 'system',
      light: 'solarized-light',
      dark: 'nord'
    })
    // 每一套都能放进它自己那一侧
    for (const [id, scheme] of widgetThemeSchemes()) {
      expect(widgetThemeStateOf({ [scheme]: id })[scheme], id).toBe(id)
    }
  })

  it.each<[string, { light?: string; dark?: string }]>([
    ['旧值 light / dark', { light: 'light', dark: 'dark' }],
    ['放错一侧', { light: 'nord', dark: 'github-light' }],
    ['认不得的 nord-light', { light: 'nord-light', dark: 'nord-light' }],
    ['大小写不对的 NORD', { light: 'NORD', dark: 'NORD' }],
    ['空串', { light: '', dark: '' }],
    ['深色那格写 light', { dark: 'light' }],
    ['浅色那格写 dark', { light: 'dark' }]
  ])('TH-2 %s → GitHub 那一对', (_label, slots) => {
    const state = widgetThemeStateOf({ mode: 'light', ...slots })
    expect(state).toEqual({ mode: 'light', ...GITHUB })
  })

  it('TH-3 currentWidgetTheme：没注入 = 缺省；每次现读；注入 null 回到缺省', () => {
    expect(currentWidgetTheme()).toEqual({ mode: 'dark', ...GITHUB })

    let value: { mode?: string; light?: string; dark?: string } = {
      mode: 'system',
      light: 'one-light',
      dark: 'nord'
    }
    const reader = vi.fn(() => value)
    setWidgetThemeReader(reader)
    expect(currentWidgetTheme()).toEqual({ mode: 'system', light: 'one-light', dark: 'nord' })
    value = { mode: 'light', light: 'catppuccin-latte', dark: 'dracula' }
    expect(currentWidgetTheme()).toEqual({
      mode: 'light',
      light: 'catppuccin-latte',
      dark: 'dracula'
    })
    expect(reader).toHaveBeenCalledTimes(2)

    setWidgetThemeReader(null)
    expect(currentWidgetTheme()).toEqual({ mode: 'dark', ...GITHUB })
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('TH-4 parseWidgetScheme 只认 light / dark', () => {
    expect(parseWidgetScheme('light')).toBe('light')
    expect(parseWidgetScheme('dark')).toBe('dark')
    for (const raw of [null, undefined, '', 'Dark', 'system', ' dark']) {
      expect(parseWidgetScheme(raw), JSON.stringify(raw)).toBeNull()
    }
  })
})

describe('TH 语义色名', () => {
  it('TH-5 键正好是那 42 个名字', () => {
    const keys = Object.keys(WIDGET_THEME_COLORS)
    expect(keys).toHaveLength(42)
    expect([...keys].sort()).toEqual([...EXPECTED_NAMES].sort())
  })

  it('TH-6 引用的 --theme-* 在 11 个主题块里都有声明；--viz-* 在 `:root, [data-theme]` 块里有声明', () => {
    const themeVars = referenced('--theme-')
    expect(themeVars.length).toBeGreaterThan(0)
    const ids = [...widgetThemeSchemes().keys()]
    expect(ids).toHaveLength(11)
    for (const id of ids) {
      const declared = declaredIn(new RegExp(`\\[data-theme='${id}'\\]`), '--theme-')
      for (const v of themeVars) expect(declared.has(v), `${id} declares ${v}`).toBe(true)
    }

    const vizVars = referenced('--viz-')
    expect(vizVars).toHaveLength(25)
    const vizDeclared = declaredIn(/:root,\s*\[data-theme\]/, '--viz-')
    for (const v of vizVars) expect(vizDeclared.has(v), v).toBe(true)
  })

  it('TH-7 状态色 = Tailwind 的 600（浅）/ 400（深）', () => {
    const tailwindTheme = readFileSync(join(TAILWIND_DIR, 'theme.css'), 'utf8')
    const tw = (name: string): string => {
      const m = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(tailwindTheme)
      if (!m) throw new Error(`no --color-${name} in tailwindcss/theme.css`)
      return m[1].trim()
    }
    const pairs: Array<[string, string]> = [
      ['success', 'emerald'],
      ['warning', 'amber'],
      ['danger', 'rose']
    ]
    for (const [name, hue] of pairs) {
      expect(WIDGET_THEME_COLORS[name], name).toBe(
        `light-dark(${tw(`${hue}-600`)}, ${tw(`${hue}-400`)})`
      )
    }
  })

  it('TH-8 widgetThemeCss = themes.css 全文 + 一个 :root 块，每个 --widget-<名字> 恰好一次', () => {
    const css = widgetThemeCss()
    expect(css.startsWith(THEMES_CSS.trimEnd())).toBe(true)

    const tail = css.slice(THEMES_CSS.trimEnd().length)
    const blocks = [...tail.matchAll(/:root\s*\{([^}]*)\}/g)]
    expect(blocks).toHaveLength(1)
    expect(tail.trimEnd().endsWith('}')).toBe(true)
    expect(tail.slice(blocks[0].index! + blocks[0][0].length).trim()).toBe('')

    const decls = [...blocks[0][1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)]
    const names = decls.map((d) => d[1])
    expect(names).toHaveLength(Object.keys(WIDGET_THEME_COLORS).length)
    expect(new Set(names).size).toBe(names.length)
    expect([...names].sort()).toEqual(
      Object.keys(WIDGET_THEME_COLORS)
        .map((n) => `--widget-${n}`)
        .sort()
    )
    for (const [, prop, value] of decls) {
      expect(value.trim(), prop).toBe(WIDGET_THEME_COLORS[prop.slice('--widget-'.length)])
    }
    // 第一个 --widget- 就是那个块里的：themes.css 自己不声明它们
    expect(THEMES_CSS).not.toContain('--widget-')
  })

  it('TH-9 Tailwind 声明：@theme inline 里每个名字一行；dark 变体跟 data-scheme；不提 prefers-color-scheme', () => {
    const theme = /@theme inline\s*\{([^}]*)\}/.exec(WIDGET_TAILWIND_THEME)
    expect(theme).not.toBeNull()
    const lines = theme![1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    expect(lines).toEqual(
      Object.keys(WIDGET_THEME_COLORS).map((n) => `--color-${n}: var(--widget-${n});`)
    )
    expect(WIDGET_TAILWIND_THEME.split('\n')).toContain(
      '@custom-variant dark (&:where([data-scheme=dark], [data-scheme=dark] *));'
    )
    expect(WIDGET_TAILWIND_THEME).not.toContain('prefers-color-scheme')
  })
})

describe('TH 头部脚本', () => {
  const STATE: WidgetThemeState = { mode: 'system', light: 'one-light', dark: 'nord' }

  it('TH-10 能解析；forced 原样写进去', () => {
    const plain = themeBootScript(STATE)
    expect(() => new Function(plain)).not.toThrow()
    expect(plain).toContain('var forced = null;')
    expect(plain).toContain(`var state = ${JSON.stringify(STATE)};`)

    const dark = themeBootScript(STATE, 'dark')
    expect(() => new Function(dark)).not.toThrow()
    expect(dark).toContain('var forced = "dark";')
    expect(themeBootScript(STATE, null)).toBe(plain)
  })

  it('TH-10 状态里的 `</script>` 不会在输出里留下字面的 `</script`', () => {
    const evil = {
      mode: 'dark',
      light: '</script><script>alert(1)</script>',
      dark: '</SCRIPT>'
    } as WidgetThemeState
    const out = themeBootScript(evil)
    expect(out.toLowerCase()).not.toContain('</script')
    expect(() => new Function(out)).not.toThrow()
  })
})

describe('TH-11 Tailwind 真的按这些名字出工具类', () => {
  it('TH-11 bg-surface / bg-accent/20 / dark:bg-page / fill-viz-2 / text-on-accent', async () => {
    const compiler = await compile(`@import 'tailwindcss';\n${exportThemeCss()}`, {
      base: TAILWIND_DIR,
      loadStylesheet: async (id: string, base: string) => {
        const path = id === 'tailwindcss' ? join(TAILWIND_DIR, 'index.css') : resolve(base, id)
        return { path, base: dirname(path), content: readFileSync(path, 'utf8') }
      }
    })
    const css = compiler.build([
      'bg-surface',
      'bg-accent/20',
      'dark:bg-page',
      'fill-viz-2',
      'text-on-accent'
    ])
    const rule = (selector: string): string => {
      const at = css.indexOf(selector)
      expect(at, selector).toBeGreaterThanOrEqual(0)
      // 一条规则：选择器到它自己的闭括号（color-mix 那条里套着一层 @supports）
      let depth = 0
      for (let i = css.indexOf('{', at); i < css.length; i++) {
        if (css[i] === '{') depth++
        else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1)
      }
      throw new Error(`unterminated rule ${selector}`)
    }

    expect(rule('.bg-surface {')).toContain('background-color: var(--widget-surface);')
    expect(rule('.bg-accent\\/20 {')).toMatch(
      /color-mix\(in [a-z]+, var\(--widget-accent\) 20%, transparent\)/
    )
    const dark = rule('.dark\\:bg-page:')
    expect(dark).toContain('[data-scheme=dark]')
    expect(dark).toContain('background-color: var(--widget-page);')
    expect(rule('.fill-viz-2 {')).toContain('fill: var(--widget-viz-2);')
    expect(rule('.text-on-accent {')).toContain('color: var(--widget-on-accent);')

    // dark: 不靠媒体查询（远程浏览器里「应用强制深色、设备浅色」也要变深）
    const utilities = css.slice(css.indexOf('@layer utilities'))
    expect(utilities).not.toContain('prefers-color-scheme')
  })
})
