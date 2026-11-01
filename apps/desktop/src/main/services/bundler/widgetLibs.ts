/**
 * 小组件界面可以 import 的库（react / react-dom / react-router / shuvix/widget 之外）—— 表在 widgetLibs.json，
 * scripts/vendor-widget-libs.mjs 按它把库连同依赖拷进 resources/bundler/vendor/node_modules。
 *
 * 两种库：
 * - **打进组件**（绝大多数）：打包器从 vendor 解析，按 package.json 的 `sideEffects` 摇树 —— 只用了 5 个图标就只带
 *   5 个图标。所以 vendor 里放的是包的原样文件，不是预打成一个文件的 bundle（那样摇不掉，见 react-all.esm.js）。
 * - **由宿主单独发**（`served`，目前只有 three）：太大、又摇不掉多少，打进每个组件就是每个组件一份 1 MB。打包时
 *   留作外部模块，页面骨架的 import map 把它指到 widget 服务的 `/w/<id>/lib/<name>@<version>/…`（长缓存、gzip）。
 */

import table from './widgetLibs.json'

export interface WidgetLibrary {
  readonly name: string
  readonly version: string
  /** 由宿主单独发：specifier（`/` 结尾 = 前缀）→ 包里的文件或目录 */
  readonly served?: Readonly<Record<string, string>>
  /** 导出的 Vite 项目用到它时补的 devDependencies */
  readonly exportTypes?: Readonly<Record<string, string>>
  /** 精确 specifier → 拒绝时给的提示 */
  readonly blocked?: Readonly<Record<string, string>>
}

export const WIDGET_LIBRARIES: readonly WidgetLibrary[] = Object.entries(table.libraries).map(
  ([name, lib]) => ({ name, ...(lib as Omit<WidgetLibrary, 'name'>) })
)

const byName = new Map(WIDGET_LIBRARIES.map((lib) => [lib.name, lib]))

/** 裸 specifier 的包名：`@scope/pkg/sub` → `@scope/pkg`，`pkg/sub` → `pkg` */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** 这个 specifier 属于哪个库（不在表里 → undefined） */
export function widgetLibraryOf(specifier: string): WidgetLibrary | undefined {
  return byName.get(packageNameOf(specifier))
}

/** 被挡下的 specifier 的提示（没挡 → undefined） */
export function blockedImportHint(specifier: string): string | undefined {
  return widgetLibraryOf(specifier)?.blocked?.[specifier]
}

/** 由宿主单独发的库，在 widget 服务上的路径前缀（相对 `/w/<id>/`） */
export function servedLibraryBase(lib: WidgetLibrary): string {
  return `lib/${lib.name}@${lib.version}/`
}

/**
 * served 库里，这个 specifier 对应包里的哪个文件：`three` → `build/three.module.js`，
 * `three/addons/x.js` → `examples/jsm/x.js`。不是 served 的 specifier，或带 `.` / `..` / 空段 → null。
 */
export function servedFileOf(specifier: string): { lib: WidgetLibrary; file: string } | null {
  const lib = widgetLibraryOf(specifier)
  if (!lib?.served) return null
  for (const [key, target] of Object.entries(lib.served)) {
    if (key.endsWith('/') ? specifier.startsWith(key) : specifier === key) {
      const file = key.endsWith('/') ? target + specifier.slice(key.length) : target
      const segments = file.split('/')
      if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\'))) return null
      return { lib, file }
    }
  }
  return null
}

/** 页面骨架的 import map：served 库的 specifier → `<base>lib/<name>@<version>/<文件>` */
export function widgetImportMap(base: string): { imports: Record<string, string> } {
  const imports: Record<string, string> = {}
  for (const lib of WIDGET_LIBRARIES) {
    for (const [key, target] of Object.entries(lib.served ?? {})) {
      imports[key] = `${base}${servedLibraryBase(lib)}${target}`
    }
  }
  return { imports }
}

/** 给人看的库清单（报错与提示里用） */
export function widgetLibraryNames(): string {
  return WIDGET_LIBRARIES.map((lib) => lib.name).join(', ')
}
