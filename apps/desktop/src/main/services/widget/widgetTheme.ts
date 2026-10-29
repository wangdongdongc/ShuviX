/**
 * 组件页面的主题 —— 组件跟 ShuviX 选的那套主题走，而不只是明暗
 *
 * 从前组件页面只靠 `prefers-color-scheme` 知道明暗（nativeTheme.themeSource 跟着 `general.theme`），
 * 用户选的是哪一套主题（`general.lightTheme` / `general.darkTheme`）没有渠道传进去，技能教的也是写死的
 * neutral / violet 色板。现在三件事一起送进组件页面：
 *
 *   - **主题令牌**：`/w/<id>/theme.css` 就是应用自己的 themes.css（`[data-theme]` 切换的纯 CSS 变量，每套主题
 *     自带 `color-scheme`），一份事实，不另抄；
 *   - **选哪一套**：页面骨架头部的一段脚本（themeBootScript）按「模式 + 浅色那套 + 深色那套」在 `<html>` 上设
 *     `data-theme` / `data-scheme`，首帧之前就设好；设置一变，主进程在每个组件页面已经连着的 SSE 上推 `theme`
 *     事件，脚本就地换属性 —— 不重载、不丢界面状态。`system` 模式按页面自己的媒体查询选：桌面里它跟
 *     nativeTheme，远程浏览器里跟那台设备，与 web 客户端自己的取法一致；强制明 / 暗时不看媒体查询，
 *     所以远程浏览器在「应用强制深色、设备是浅色」时组件也是深色；
 *   - **语义色名**（WIDGET_THEME_COLORS）：同一组名字三种写法 —— Tailwind 类（`bg-surface`、`text-fg`、`border-line`、
 *     `text-accent` …，WIDGET_TAILWIND_THEME）、CSS 变量（`var(--widget-accent)`，theme.css 末尾声明）、`shuvix/widget`
 *     的 `themeColor('accent')`。一个名字适配所有主题，不用再成对写 `dark:`。这层名字是对组件作者的长期契约 ——
 *     组件不直接写 `--theme-*`，以后改 themes.css 的变量名只改这里。`dark:` 也改成跟 `data-scheme` 走
 *     （而不是媒体查询），老组件在上面那种远程场景里同样变深。
 *
 * 导出的独立项目没有 ShuviX 服务器：widgetExporter 随包带同一份 theme.css + Tailwind 声明，index.html 里放同一段
 * 脚本、固定「跟系统 + GitHub 那一对」（WIDGET_EXPORT_THEME）。
 */

import themesCss from '@shuvix/app-shell/themes.css?raw'

export type WidgetScheme = 'light' | 'dark'

/** 选哪一套主题：模式（跟系统 / 强制明 / 强制暗）+ 浅色时用的那套 + 深色时用的那套 */
export interface WidgetThemeState {
  mode: 'system' | WidgetScheme
  light: string
  dark: string
}

const DEFAULT_LIGHT = 'github-light'
const DEFAULT_DARK = 'github-dark'

/** 导出项目里的选择：没有设置可读，跟系统明暗、用默认那一对 */
export const WIDGET_EXPORT_THEME: WidgetThemeState = {
  mode: 'system',
  light: DEFAULT_LIGHT,
  dark: DEFAULT_DARK
}

/** 设置这三个键变了，开着的组件页面就要换主题 */
export const WIDGET_THEME_SETTING_KEYS: readonly string[] = [
  'general.theme',
  'general.lightTheme',
  'general.darkTheme'
]

/**
 * 组件页面的主题令牌（`/w/<id>/theme.css`）：应用自己的那份 themes.css，再加语义色名的 `--widget-*` 变量。
 * 变量声明在 `:root` 上：页面只在 `<html>` 上挂主题，`var()` 在那里按那一套代入，换主题就重算
 */
export function widgetThemeCss(): string {
  const vars = Object.entries(WIDGET_THEME_COLORS)
    .map(([name, value]) => `  --widget-${name}: ${value};`)
    .join('\n')
  return `${themesCss.trimEnd()}\n\n/* ShuviX widgets: the theme color names (bg-<name> in Tailwind, var(--widget-<name>) in CSS) */\n:root {\n${vars}\n}\n`
}

/**
 * 主题名 → 它是深色还是浅色，从 themes.css 自己读：每套主题块的第一条声明就是 `color-scheme`，
 * 新增一套主题不用回来改这里（AppearanceTab / settingsStore 的名单是界面那一侧的事）
 */
const THEME_SCHEMES: ReadonlyMap<string, WidgetScheme> = (() => {
  const map = new Map<string, WidgetScheme>()
  const re = /\[data-theme='([a-z0-9-]+)'\]\s*\{\s*color-scheme:\s*(light|dark)\s*;/g
  for (const m of themesCss.matchAll(re)) map.set(m[1], m[2] as WidgetScheme)
  return map
})()

/** 已知的主题名与它的明暗（测试与文档核对用） */
export function widgetThemeSchemes(): ReadonlyMap<string, WidgetScheme> {
  return THEME_SCHEMES
}

/** 一个槽位的设置值：认不出、或放错了明暗（深色那格里写了浅色主题）→ 默认那套；旧值 `light` / `dark` 同设置页的读法 */
function themeIdFor(raw: string | undefined, scheme: WidgetScheme): string {
  const fallback = scheme === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT
  if (!raw || raw === scheme) return fallback
  return THEME_SCHEMES.get(raw) === scheme ? raw : fallback
}

/** 从三个设置值算出选择（缺省与设置页一致：模式默认 dark） */
export function widgetThemeStateOf(settings: WidgetThemeSettings): WidgetThemeState {
  const mode = settings.mode === 'light' || settings.mode === 'system' ? settings.mode : 'dark'
  return {
    mode,
    light: themeIdFor(settings.light, 'light'),
    dark: themeIdFor(settings.dark, 'dark')
  }
}

/** 三个主题设置的原始值 */
export interface WidgetThemeSettings {
  mode?: string
  light?: string
  dark?: string
}

let readThemeSettings: () => WidgetThemeSettings = () => ({})

/**
 * 注入读设置的函数（main/index.ts 读 settings 表）。注入而不是直接引 settingsDao：那个模块一引就打开数据库，
 * 组件服务的单测不该碰它。没注入 = 默认（深色 + GitHub 那一对）
 */
export function setWidgetThemeReader(reader: (() => WidgetThemeSettings) | null): void {
  readThemeSettings = reader ?? (() => ({}))
}

/** 此刻的设置 */
export function currentWidgetTheme(): WidgetThemeState {
  return widgetThemeStateOf(readThemeSettings())
}

/** 页面骨架 URL 上的预览覆盖（`widget` 工具的 preview 给了 theme）：只认 light / dark */
export const WIDGET_SCHEME_PARAM = 'shuvix-scheme'

export function parseWidgetScheme(raw: string | null | undefined): WidgetScheme | null {
  return raw === 'light' || raw === 'dark' ? raw : null
}

/** 嵌进 `<script>` 的 JSON：`<` 转义，内容里的 `</script>` 不会提前结束脚本 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * 页面头部的主题脚本（不含 `<script>` 标签）。设好 `data-theme` / `data-scheme`，主题真变了才在 window 上发
 * `shuvix:theme`（`shuvix/widget` 的 useTheme 听它）；`window.__shuvixSetTheme(state)` 换一份选择（宿主收到 SSE
 * `theme` 时调）。`forced` = 预览强制的明暗：盖过模式，但浅色 / 深色用哪一套仍跟设置。
 */
export function themeBootScript(
  state: WidgetThemeState,
  forced: WidgetScheme | null = null
): string {
  return `(function () {
  var state = ${scriptJson(state)};
  var forced = ${scriptJson(forced)};
  var root = document.documentElement;
  var mq = window.matchMedia('(prefers-color-scheme: dark)');
  function apply() {
    var mode = forced || state.mode;
    var scheme = mode === 'system' ? (mq.matches ? 'dark' : 'light') : mode;
    var id = scheme === 'dark' ? state.dark : state.light;
    if (root.getAttribute('data-theme') === id && root.getAttribute('data-scheme') === scheme) return;
    root.setAttribute('data-theme', id);
    root.setAttribute('data-scheme', scheme);
    window.dispatchEvent(new CustomEvent('shuvix:theme', { detail: { id: id, scheme: scheme } }));
  }
  window.__shuvixSetTheme = function (next) {
    if (
      next &&
      (next.mode === 'system' || next.mode === 'light' || next.mode === 'dark') &&
      typeof next.light === 'string' &&
      typeof next.dark === 'string'
    )
      state = next;
    apply();
  };
  mq.addEventListener('change', apply);
  apply();
})();`
}

/**
 * Tailwind 语义色名（放进 `<style type="text/tailwindcss">`，导出项目里由 @tailwindcss/vite 处理同一段）。
 * `inline`：工具类直接写成 `var(--theme-*)`，在哪一层取值看那一层的 `data-theme`。
 *
 * 状态色不随主题变（themes.css 的状态色同样刻意不变）：用 Tailwind 色板的 600 / 400 两档，按页面实际的
 * `color-scheme` 用 light-dark() 取 —— 和技能原来教的 `text-emerald-600 dark:text-emerald-400` 是同一组颜色。
 * `on-accent`（实心强调色上的字）：浅色主题用白字（与应用自己的按钮一致），深色主题的强调色偏亮，用页面底色。
 */
const STATUS_COLORS: Record<'success' | 'warning' | 'danger', [string, string]> = {
  // emerald-600 / emerald-400
  success: ['oklch(59.6% 0.145 163.225)', 'oklch(76.5% 0.177 163.223)'],
  // amber-600 / amber-400
  warning: ['oklch(66.6% 0.179 58.318)', 'oklch(82.8% 0.189 84.429)'],
  // rose-600 / rose-400
  danger: ['oklch(58.6% 0.253 17.585)', 'oklch(71.2% 0.194 13.428)']
}

/** 语义色名 → 取值（键 = Tailwind 的颜色名：`bg-<键>` / `text-<键>` / `border-<键>` …） */
export const WIDGET_THEME_COLORS: Readonly<Record<string, string>> = (() => {
  const colors: Record<string, string> = {
    page: 'var(--theme-bg-primary)',
    surface: 'var(--theme-bg-secondary)',
    raised: 'var(--theme-bg-tertiary)',
    hover: 'var(--theme-bg-hover)',
    active: 'var(--theme-bg-active)',
    line: 'var(--theme-border-primary)',
    'line-subtle': 'var(--theme-border-secondary)',
    fg: 'var(--theme-text-primary)',
    'fg-muted': 'var(--theme-text-secondary)',
    'fg-subtle': 'var(--theme-text-tertiary)',
    accent: 'var(--theme-accent)',
    'accent-hover': 'var(--theme-accent-hover)',
    'accent-muted': 'var(--theme-accent-muted)',
    'on-accent': 'light-dark(#ffffff, var(--theme-bg-primary))'
  }
  for (const [name, [light, dark]] of Object.entries(STATUS_COLORS)) {
    colors[name] = `light-dark(${light}, ${dark})`
  }
  // 图表的分类色（与作图技能同一套 --viz-*）：系列色、浅底、同色深字
  for (let i = 1; i <= 8; i++) {
    colors[`viz-${i}`] = `var(--viz-${i})`
    colors[`viz-${i}-tint`] = `var(--viz-${i}-tint)`
    colors[`viz-${i}-ink`] = `var(--viz-${i}-ink)`
  }
  colors['viz-wash'] = 'var(--viz-wash)'
  return colors
})()

/** 类名指向 `--widget-*` 变量（theme.css 里声明），不再各写一遍取值 */
export const WIDGET_TAILWIND_THEME = `@theme inline {
${Object.keys(WIDGET_THEME_COLORS)
  .map((name) => `  --color-${name}: var(--widget-${name});`)
  .join('\n')}
}
@custom-variant dark (&:where([data-scheme=dark], [data-scheme=dark] *));
`
