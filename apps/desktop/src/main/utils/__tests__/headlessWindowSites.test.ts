/**
 * 主进程里每一处 `new BrowserWindow(` / `new WebContentsView(` 都想过「Linux 上无头运行时怎么办」—— 一条 lint 形状的
 * 用例，扫的是**源码**（与 services/browser/__tests__/backgroundThrottlingGuard.test.ts 同一做法：TypeScript 的语法树，
 * 注释与字符串里的字样不算）。
 *
 *   HW-G1a 扫描器本身：认得 `new BrowserWindow(…)` / `new WebContentsView()` / `new electron.BrowserWindow(…)`，
 *          不把注释、字符串、类型位置当成建窗口；只认真正出现的标识符（注释里的 rendersOffscreen 不算）
 *   HW-G1b 扫到的确实是 src/main（跳过 __tests__）：几处已知的建窗口文件都在其中
 *   HW-G1c 每一处建窗口 / view 的文件恰落在一类里：
 *          (1) 离屏 —— 引用 rendersOffscreen，恰是 stagingWindow / browserViewService / widgetPreviewService；
 *          (2) 无头时拒绝开窗 —— 引用 isHeadless 或 headlessWindowError，今天是 index / markdownWindowService /
 *              previewWindowService / widgetWindowService / browserWindowService；
 *          (3) 审过的少数几处（各带一句理由）：pinnedChatService、devtoolsDock、browserPopover、siteData；
 *          一类都不落的报错说「rendersOffscreen() 为真时离屏，或无头时拒绝」；审过的清单里没有过期的条目
 *
 * 为什么要它：Linux 上无头运行时 Chromium 跑在 Ozone 的 headless 平台上，Electron 39 在那里建任何**不离屏**的
 * BrowserWindow 都当场 SIGSEGV、整个服务退出（见 utils/headless.ts 的 rendersOffscreen）。行为用例只能证明今天那几条路
 * 做对了；以后新加一处建窗口、忘了想无头运行，没有哪条用例会变红 —— 症状只是服务器上的进程某一刻消失。
 * 路径从 `import.meta.url` 往上找 src/main，不按进程 cwd。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/src/main/utils/__tests__` 往上两层 */
const MAIN_DIR = resolve(HERE, '../..')

const CONSTRUCTORS = new Set(['BrowserWindow', 'WebContentsView'])

/** (1) 在 rendersOffscreen() 为真时离屏渲染的 */
const OFFSCREEN_SITES = [
  'services/browser/browserViewService.ts',
  'services/browser/stagingWindow.ts',
  'services/widgetPreviewService.ts'
]

/** (2) 无头运行时拒绝开窗的（今天的成员） */
const REFUSING_SITES = [
  'index.ts',
  'services/browser/browserWindowService.ts',
  'services/markdownWindowService.ts',
  'services/previewWindowService.ts',
  'services/widgetWindowService.ts'
]

/** (3) 审过、既不离屏也不拒绝的：无头运行时根本走不到 */
const REVIEWED_SITES: Record<string, string> = {
  'services/pinnedChatService.ts':
    'pin requests only come from a desktop window (pinChat:pin is desktop-only, so a browser cannot ask for one)',
  'services/browser/devtoolsDock.ts':
    "only reachable from the browser window's shell, which never opens headless",
  'services/browser/browserPopover.ts':
    "only reachable from the browser window's shell (window.open), which never opens headless",
  'services/browser/siteData.ts':
    "only reachable from the browser window's shell (its settings page), which never opens headless"
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

interface Scan {
  /** `new BrowserWindow(…)` / `new WebContentsView(…)` 所在的行号（1 起） */
  sites: number[]
  /** 源码里真正出现的标识符（不含注释与字符串） */
  identifiers: Set<string>
}

function scan(source: string, fileName = 'snippet.ts'): Scan {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const sites: number[] = []
  const identifiers = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text)
    if (ts.isNewExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined
      if (name !== undefined && CONSTRUCTORS.has(name)) {
        sites.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { sites, identifiers }
}

const files = sourceFiles(MAIN_DIR).sort()
const scans = new Map(
  files.map((rel) => [rel, scan(readFileSync(join(MAIN_DIR, rel), 'utf8'), rel)])
)
/** 建窗口 / view 的文件 */
const creators = files.filter((rel) => scans.get(rel)!.sites.length > 0)

type Bucket = 'offscreen' | 'refuses headless' | 'reviewed'

function bucketsOf(rel: string): Bucket[] {
  const { identifiers } = scans.get(rel)!
  const buckets: Bucket[] = []
  if (identifiers.has('rendersOffscreen')) buckets.push('offscreen')
  if (identifiers.has('isHeadless') || identifiers.has('headlessWindowError')) {
    buckets.push('refuses headless')
  }
  if (Object.hasOwn(REVIEWED_SITES, rel)) buckets.push('reviewed')
  return buckets
}

describe('每一处建窗口都想过 Linux 上的无头运行（HW-G1）', () => {
  it('HW-G1a 扫描器本身：认得三种建法，不把注释、字符串、类型当成建窗口；标识符只算真出现的', () => {
    expect(
      scan(
        [
          'const win = new BrowserWindow({ show: false })',
          'const frontend = new WebContentsView()',
          'const other = new electron.BrowserWindow({})'
        ].join('\n')
      ).sites
    ).toEqual([1, 2, 3])
    const quiet = scan(
      [
        '// new BrowserWindow({ show: false }) 在无头运行时会崩',
        '/* new WebContentsView() */',
        "const s = 'new BrowserWindow({})'",
        'let win: BrowserWindow | null = null',
        'const isWin = win instanceof BrowserWindow',
        '// rendersOffscreen() 为真时离屏'
      ].join('\n')
    )
    expect(quiet.sites).toEqual([])
    expect(quiet.identifiers.has('rendersOffscreen')).toBe(false)
    expect(
      scan("import { rendersOffscreen } from '../utils/headless'").identifiers.has(
        'rendersOffscreen'
      )
    ).toBe(true)
  })

  it('HW-G1b 扫到的确实是 src/main：几处已知的建窗口文件都在其中，没有测试文件', () => {
    expect(files.some((f) => f.includes('__tests__'))).toBe(false)
    expect(creators).toEqual(
      expect.arrayContaining([
        'index.ts',
        'services/browser/stagingWindow.ts',
        'services/browser/browserViewService.ts',
        'services/widgetPreviewService.ts'
      ])
    )
  })

  it('HW-G1c 每一处建窗口 / view 的文件恰落在一类里：离屏、无头时拒绝、或审过', () => {
    const problems = creators.flatMap((rel) => {
      const buckets = bucketsOf(rel)
      const lines = scans.get(rel)!.sites.join(', ')
      if (buckets.length === 0) {
        return [
          `${rel} (line ${lines}) creates a window / view but does not handle Linux headless mode: ` +
            'make it offscreen (webPreferences.offscreen) when rendersOffscreen() is true, or refuse ' +
            'it headless (isHeadless() / headlessWindowError())'
        ]
      }
      if (buckets.length > 1) return [`${rel} is in more than one bucket: ${buckets.join(' + ')}`]
      return []
    })
    expect(problems).toEqual([])

    const inBucket = (bucket: Bucket): string[] =>
      creators.filter((rel) => bucketsOf(rel).includes(bucket)).sort()
    expect(inBucket('offscreen')).toEqual([...OFFSCREEN_SITES].sort())
    expect(inBucket('refuses headless')).toEqual([...REFUSING_SITES].sort())
    expect(inBucket('reviewed')).toEqual(Object.keys(REVIEWED_SITES).sort())

    // 审过的清单没有过期的条目：每一项都还建窗口 / view，且每一项都写了理由
    for (const [rel, reason] of Object.entries(REVIEWED_SITES)) {
      expect(creators, `${rel} is still a window / view creation site`).toContain(rel)
      expect(reason.trim().length, `${rel} has a reason`).toBeGreaterThan(0)
    }
  })
})
