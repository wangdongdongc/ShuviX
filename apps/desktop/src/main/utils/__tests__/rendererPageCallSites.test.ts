/**
 * 自有窗口都经 loadRendererPage 加载渲染端 —— 一条 lint 形状的用例，扫的是**源码**本身
 * （与 externalOpen 的 guardedWindows.test.ts / AG-58 同一种写法）。
 *
 * 行为由 rendererPage.test.ts 管；这里挡的是另一种事故：**新加**一个窗口时照旧手写
 * `is.dev && ELECTRON_RENDERER_URL ? loadURL : loadFile` 那一段。那样的窗口一条用例都不会变红，
 * 症状只在开发态的虚拟机上出现：网络服务崩溃那次的加载挂住、没有重发，窗口永远不出来。
 * 所以按文件数数：
 *  - `renderer/index.html` 只在 rendererPage.ts 里出现；
 *  - `ELECTRON_RENDERER_URL` 只在 rendererPage.ts 与 externalOpen/gate.ts（导航守卫放行 HMR 地址）里出现；
 *  - 一个文件里有几个 `new BrowserWindow(`，就得有几次 `loadRendererPage(`（不加载页面的窗口除外，见下表）。
 *
 * 路径从 `import.meta.url` 往上找 src/main，不按进程 cwd。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/src/main/utils/__tests__` 往上两层 */
const MAIN_DIR = resolve(HERE, '../..')
/** 加载函数自己（定义处也匹配 `loadRendererPage(`，不算调用点） */
const HELPER = 'utils/rendererPage.ts'

const NEW_WINDOW = /new BrowserWindow\(/g
const PAGE_LOAD = /loadRendererPage\(/g

/**
 * 不加载渲染端页面的窗口：文件 → 这种窗口的个数。
 * 停放窗口（stagingWindow）从不显示、自己什么页面都不加载，只是浏览器 tab 的 view 不在卡片墙上时的宿主。
 * 往这里加之前先想清楚：只要窗口里显示的是我们的渲染端，它就该走 loadRendererPage。
 */
const NO_PAGE_WINDOWS: Record<string, number> = {
  'services/browser/stagingWindow.ts': 1
}

/** 今天调 loadRendererPage 的文件与次数（数目对不上说明有人新加/挪走了窗口，顺手把表也更新掉） */
const EXPECTED_PAGE_LOADS: Record<string, number> = {
  'index.ts': 2,
  'services/browser/browserWindowService.ts': 1,
  'services/markdownWindowService.ts': 1,
  'services/pinnedChatService.ts': 1,
  'services/widgetWindowService.ts': 1
}

/** src/main 下所有 .ts（跳过 __tests__），路径一律用 / 分隔，相对 src/main */
function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      found.push(...sourceFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      found.push(relative(MAIN_DIR, full).split(sep).join('/'))
    }
  }
  return found
}

interface Scanned {
  /** 相对 src/main 的路径 */
  rel: string
  source: string
  windows: number
  pageLoads: number
}

const scanned: Scanned[] = sourceFiles(MAIN_DIR)
  .sort()
  .map((rel) => {
    const source = readFileSync(join(MAIN_DIR, rel), 'utf8')
    return {
      rel,
      source,
      windows: source.match(NEW_WINDOW)?.length ?? 0,
      pageLoads: rel === HELPER ? 0 : (source.match(PAGE_LOAD)?.length ?? 0)
    }
  })

const windowFiles = scanned.filter((file) => file.windows > 0)

describe('自有窗口都经 loadRendererPage 加载渲染端', () => {
  it('扫到了源码（防止路径算错时整条用例空转成绿）', () => {
    expect(scanned.some((file) => file.rel === HELPER)).toBe(true)
    expect(windowFiles.length).toBeGreaterThan(0)
  })

  it('renderer/index.html 只在 rendererPage.ts 里出现', () => {
    const hits = scanned.filter((file) => file.source.includes('renderer/index.html'))
    expect(hits.map((file) => file.rel)).toEqual([HELPER])
  })

  it('ELECTRON_RENDERER_URL 只在 rendererPage.ts 与 externalOpen/gate.ts 里出现', () => {
    const hits = scanned.filter((file) => file.source.includes('ELECTRON_RENDERER_URL'))
    expect(hits.map((file) => file.rel).sort()).toEqual(
      ['services/externalOpen/gate.ts', HELPER].sort()
    )
  })

  it('调 loadRendererPage 的就是这几个文件、各这么多次', () => {
    const loads = scanned.filter((file) => file.pageLoads > 0)
    expect(Object.fromEntries(loads.map((file) => [file.rel, file.pageLoads]))).toEqual(
      EXPECTED_PAGE_LOADS
    )
  })

  it.each(windowFiles)(
    '$rel：$windows 处 new BrowserWindow( 配了同样多次 loadRendererPage(（不加载页面的除外）',
    (file: Scanned) => {
      const noPage = NO_PAGE_WINDOWS[file.rel] ?? 0
      expect(file.pageLoads).toBe(file.windows - noPage)
    }
  )
})
