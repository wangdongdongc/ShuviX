/**
 * 每个自有窗口都装了 externalOpen 的守卫 —— 一条 lint 形状的用例，扫的是**源码**本身。
 *
 * 这一条不验行为（那是 gate.test.ts 的 AG-39…53），它要挡的是另一种事故：**新加**一个
 * BrowserWindow 而忘了 guardAppWindow。那样的窗口一条用例都不会变红，症状只是它的页面能把
 * 应用窗口带去外站、或者把 `file:///…/X.app` 交给系统 —— 设置窗口与悬浮聊天窗口就是这么一路
 * 没有守卫的（直到 ffdcb489）。所以这里按文件数数：一个文件里有几个 `new BrowserWindow(`，
 * 就得有几次 `guardAppWindow(`。
 *
 * 路径从 `import.meta.url` 往上找 src/main，**不**按进程 cwd —— vitest 的 root 是 apps/desktop，
 * 但这条用例不该依赖它。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/src/main/services/externalOpen/__tests__` 往上三层 */
const MAIN_DIR = resolve(HERE, '../../..')

const NEW_WINDOW = /new BrowserWindow\(/g
const GUARD_CALL = /guardAppWindow\(/g

/**
 * 明确不需要守卫的窗口：文件（相对 src/main 的路径）→ 免检的窗口数。
 * 今天一个都没有。往这里加之前先想清楚那个窗口里会显示什么 —— 只要页面上可能出现不是我们写的
 * 链接或 iframe（PDF、widget 里模型写的 HTML、聊天里的模型输出），它就该有守卫。
 */
const UNGUARDED_ALLOWLIST: Record<string, number> = {}

/** 今天造窗口的文件与各自的窗口数；数目对不上说明有人新加/挪走了窗口，顺手把这张表也更新掉 */
const EXPECTED_WINDOW_FILES: Record<string, number> = {
  'index.ts': 2,
  'services/browser/browserWindowService.ts': 1,
  'services/browser/stagingWindow.ts': 1,
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

interface Counted {
  /** 相对 src/main 的路径 */
  rel: string
  windows: number
  guards: number
}

const counted: Counted[] = sourceFiles(MAIN_DIR)
  .sort()
  .map((rel) => {
    const source = readFileSync(join(MAIN_DIR, rel), 'utf8')
    return {
      rel,
      windows: source.match(NEW_WINDOW)?.length ?? 0,
      guards: source.match(GUARD_CALL)?.length ?? 0
    }
  })

/** 不造窗口的文件跳过（gate.ts 本身也在其中：它只**定义** guardAppWindow） */
const windowFiles = counted.filter((file) => file.windows > 0)

describe('自有窗口都装了 externalOpen 守卫', () => {
  it('AG-58 今天造窗口的就是这几个文件，别的文件一个窗口都不造', () => {
    expect(Object.fromEntries(windowFiles.map((file) => [file.rel, file.windows]))).toEqual(
      EXPECTED_WINDOW_FILES
    )
  })

  it.each(windowFiles)(
    'AG-58 $rel：$windows 处 new BrowserWindow( 配了同样多次 guardAppWindow(',
    (file: Counted) => {
      const exempt = UNGUARDED_ALLOWLIST[file.rel] ?? 0
      expect(file.guards).toBe(file.windows - exempt)
    }
  )
})
