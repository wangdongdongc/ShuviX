/**
 * `utils/linuxRelaunch.ts`：判断 NoNewPrivs，以及不经 `app.relaunch()` 的重启（等父进程退出再启动）。
 *
 *   LR-1 hasNoNewPrivs：`NoNewPrivs:\t1` → true；`0`、没有这一行、读不到 → false；只认独立的一行（`NoNewPrivs:\t10` 不算）
 *   LR-2 relaunchAfterExit（真的 /bin/bash）：管道还开着时不启动；管道一关就启动；参数原样（空格、引号、$、--flag=x y）
 *   LR-3 真的父进程：一个 node 进程用同一段脚本和同样的 spawn 选项起 helper 后退出，它退出之后程序才启动
 *   LR-4 缺省的命令行：process.execPath + process.argv.slice(1)
 *   LR-6 继承来的 fd（0/1/2 以外）一开始就关：还在等父进程时，占着的那条管道另一端就读到 EOF，程序里也不再有它
 *   LR-5 扫描：src/main（跳过 __tests__）没有 `app.relaunch(` —— 它让新进程带上 NoNewPrivs，要重启用 relaunchAfterExit；
 *        扫描器本身认得 `app.relaunch()` / `electron.app.relaunch({…})`，不把注释、字符串当调用
 *
 * 路径从 `import.meta.url` 往上找 src/main，不按进程 cwd。Windows 上没有 /bin/bash，这个文件只在别的平台跑 spawn 的用例。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn as realSpawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { hasNoNewPrivs, relaunchAfterExit, WAIT_FOR_PARENT_EXIT_SCRIPT } from '../linuxRelaunch'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `…/src/main/utils/__tests__` 往上两层 */
const MAIN_DIR = resolve(HERE, '../..')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} did not appear`)
    await sleep(20)
  }
}

describe('hasNoNewPrivs', () => {
  it.each([
    ['Name:\tshuvix\nNoNewPrivs:\t1\nSeccomp:\t0\n', true],
    ['NoNewPrivs:\t1', true],
    ['Name:\tshuvix\nNoNewPrivs:\t0\nSeccomp:\t0\n', false],
    ['Name:\tshuvix\nSeccomp:\t0\n', false],
    ['NoNewPrivs:\t10\n', false],
    ['XNoNewPrivs:\t1\n', false]
  ])('LR-1 %j → %s', (status, expected) => {
    expect(hasNoNewPrivs(() => status)).toBe(expected)
  })

  it('LR-1 读不到（比如没有 /proc）→ false', () => {
    expect(
      hasNoNewPrivs(() => {
        throw new Error('ENOENT')
      })
    ).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('relaunchAfterExit', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'linux-relaunch-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** 把收到的参数一行一个写进 out 的程序 */
  const programArgs = (out: string, ...args: string[]): string[] => [
    '-c',
    'printf "%s\\n" "$@" > "$0"',
    out,
    ...args
  ]

  it('LR-2 管道开着不启动，一关就启动；参数原样', async () => {
    const out = join(dir, 'out')
    const args = ['a b', "it's", '$HOME', '--flag=x y']
    const child = relaunchAfterExit('/bin/sh', programArgs(out, ...args))
    await sleep(300)
    expect(existsSync(out)).toBe(false)

    child.stdin!.destroy()
    await waitForFile(out)
    expect(readFileSync(out, 'utf8')).toBe(args.join('\n') + '\n')
  })

  it('LR-3 真的父进程退出之后才启动', async () => {
    const out = join(dir, 'out')
    const parentSource = `
      const { spawn } = require('node:child_process')
      const [script, out] = process.argv.slice(1)
      const child = spawn('/bin/bash', ['-c', script, 'bash', '/bin/sh', '-c', 'echo ran > "$0"', out], {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore']
      })
      child.unref()
      setTimeout(() => process.exit(0), 400)
    `
    const parent = realSpawn(
      process.execPath,
      ['-e', parentSource, WAIT_FOR_PARENT_EXIT_SCRIPT, out],
      {
        stdio: 'ignore'
      }
    )
    await sleep(200)
    // 父进程还活着
    expect(parent.exitCode).toBeNull()
    expect(existsSync(out)).toBe(false)
    await new Promise<void>((r) => parent.once('exit', () => r()))
    await waitForFile(out)
    expect(readFileSync(out, 'utf8')).toBe('ran\n')
  })

  it('LR-4 缺省：process.execPath + process.argv.slice(1)', async () => {
    const out = join(dir, 'out')
    const execPath = process.execPath
    const argv = process.argv
    Object.defineProperty(process, 'execPath', {
      value: '/bin/sh',
      configurable: true,
      writable: true
    })
    process.argv = ['/bin/sh', ...programArgs(out, '--no-sandbox', 'x y')]
    let child: ReturnType<typeof relaunchAfterExit>
    try {
      child = relaunchAfterExit()
    } finally {
      process.argv = argv
      Object.defineProperty(process, 'execPath', {
        value: execPath,
        configurable: true,
        writable: true
      })
    }
    child.stdin!.destroy()
    await waitForFile(out)
    expect(readFileSync(out, 'utf8')).toBe('--no-sandbox\nx y\n')
  })
})

describe.skipIf(process.platform === 'win32')('继承来的 fd', () => {
  it('LR-6 一开始就关掉：等待时那条管道的另一端已是 EOF，程序里也没有它', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'linux-relaunch-'))
    try {
      const out = join(dir, 'out')
      // fd 3 模拟漏下来的 Chromium fd（libuv 不会替 helper 关它）；程序报告自己手里的 fd 3 还开不开
      const helper = realSpawn(
        '/bin/bash',
        [
          '-c',
          WAIT_FOR_PARENT_EXIT_SCRIPT,
          'bash',
          '/bin/bash',
          '-c',
          'if { : >&3; } 2>/dev/null; then echo open > "$1"; else echo closed > "$1"; fi',
          'prog',
          out
        ],
        { stdio: ['pipe', 'ignore', 'ignore', 'pipe'] }
      )
      const leaked = helper.stdio[3] as NodeJS.ReadableStream
      leaked.resume()
      await new Promise<void>((resolve) => leaked.once('end', () => resolve()))
      // 管道另一端已 EOF，helper 还在等 stdin，程序没启动
      expect(helper.exitCode).toBeNull()
      expect(existsSync(out)).toBe(false)

      helper.stdin!.destroy()
      await waitForFile(out)
      expect(readFileSync(out, 'utf8')).toBe('closed\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('LR-5 主进程里没有 app.relaunch()', () => {
  function sourceFiles(dir: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue
        found.push(...sourceFiles(full))
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        found.push(full)
      }
    }
    return found
  }

  /** `<…>.app.relaunch(…)` / `app.relaunch(…)` 的调用数；注释和字符串不算 */
  function relaunchCalls(source: string): number {
    const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let count = 0
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const { name, expression: target } = node.expression
        const targetName = ts.isIdentifier(target)
          ? target.text
          : ts.isPropertyAccessExpression(target)
            ? target.name.text
            : undefined
        if (name.text === 'relaunch' && targetName === 'app') count++
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return count
  }

  it('扫描器认得调用，不认注释和字符串', () => {
    expect(relaunchCalls('app.relaunch()')).toBe(1)
    expect(relaunchCalls('electron.app.relaunch({ args: [] })')).toBe(1)
    expect(relaunchCalls('// app.relaunch()\nconst s = "app.relaunch()"')).toBe(0)
    expect(relaunchCalls('other.relaunch()')).toBe(0)
  })

  it('src/main 里一处都没有', () => {
    const files = sourceFiles(MAIN_DIR)
    expect(files.some((f) => f.endsWith(join('services', 'updateService.ts')))).toBe(true)
    const offenders = files
      .filter((f) => relaunchCalls(readFileSync(f, 'utf8')) > 0)
      .map((f) => relative(MAIN_DIR, f).split(sep).join('/'))
    expect(offenders).toStrictEqual([])
  })
})
