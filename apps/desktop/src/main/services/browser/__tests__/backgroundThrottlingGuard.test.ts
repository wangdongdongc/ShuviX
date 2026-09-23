/**
 * 主进程源码里一处运行期 `setBackgroundThrottling(` 调用都没有 —— 一条 lint 形状的用例，扫的是**源码**。
 *
 *   U9  src/main 下所有 .ts（跳过 __tests__）：调用表达式里不出现 `.setBackgroundThrottling(…)`
 *       （含 `?.` 与 `['setBackgroundThrottling'](…)` 两种写法）。
 *
 * 行为用例（U7 / U8）只能证明**今天那几条路**不调；这一条挡的是**以后**新加的调用：宿主窗口从没
 * 显示过时在运行期翻这个开关，会永久弄坏该 webContents 的 capturePage，而浏览器窗口是懒创建、以
 * 隐藏态起步的 —— 这种事故没有哪条用例会变红，症状只是截图工具与卡片快照全部失败。节流一律在
 * 构造 view 时用 `webPreferences.backgroundThrottling` 定。
 *
 * 为什么用 TypeScript 的语法树而不是正则：源码注释里就有 `webContents.setBackgroundThrottling()`
 * 这样的字样（解释为什么不许调），正则会把注释当成调用；语法树只看真正的调用表达式。
 * 路径从 `import.meta.url` 往上找 src/main，不按进程 cwd（与 guardedWindows.test.ts 同一做法）。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/src/main/services/browser/__tests__` 往上三层 */
const MAIN_DIR = resolve(HERE, '../../..')

const METHOD = 'setBackgroundThrottling'

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

/** 一段源码里调用 `<expr>.setBackgroundThrottling(…)` 的行号（1 起） */
function throttlingCalls(source: string, fileName = 'snippet.ts'): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : undefined
      if (name === METHOD) {
        lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return lines
}

const files = sourceFiles(MAIN_DIR).sort()

describe('主进程不在运行期翻后台节流', () => {
  it('U9 扫描器本身：认得三种调用写法，不把注释与字符串当调用', () => {
    expect(
      throttlingCalls(
        [
          'view.webContents.setBackgroundThrottling(false)',
          'wc?.setBackgroundThrottling (true)',
          "wc['setBackgroundThrottling'](false)"
        ].join('\n')
      )
    ).toEqual([1, 2, 3])
    expect(
      throttlingCalls(
        [
          '// webContents.setBackgroundThrottling() 会弄坏 capturePage',
          '/* wc.setBackgroundThrottling(false) */',
          "const s = 'wc.setBackgroundThrottling(false)'",
          'const opts = { backgroundThrottling: false }'
        ].join('\n')
      )
    ).toEqual([])
  })

  it('U9 扫到的确实是 src/main：浏览器模块的几个文件都在其中', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'index.ts',
        'services/browser/browserViewService.ts',
        'services/browser/browserCdpService.ts',
        'services/browser/browserWindowService.ts'
      ])
    )
    expect(files.some((f) => f.includes('__tests__'))).toBe(false)
  })

  it('U9 src/main 里没有一处运行期 setBackgroundThrottling( 调用', () => {
    const hits = files.flatMap((rel) =>
      throttlingCalls(readFileSync(join(MAIN_DIR, rel), 'utf8'), rel).map(
        (line) => `${rel}:${line}`
      )
    )
    expect(hits).toEqual([])
  })
})
