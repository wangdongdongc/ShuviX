/**
 * PowerShell 的解析与调用形态 —— Windows 上的命令工具不再经 Git Bash，而是直接起 PowerShell。
 * 钉的是 shell.ts 里 PowerShell 那一半：
 *
 *  - C1…C4 `getPowerShellConfig` 的解析顺序：Program Files 的 pwsh 7 → PATH 上的 pwsh（`where`，
 *    逐个做存在性校验）→ 系统自带的 5.1（SystemRoot → windir）→ 裸 `powershell.exe`；结果缓存；
 *    非 Windows 直接报错，指向 bash；
 *  - C5 `shellInvocation('powershell', cmd)`：固定参数一个不多一个不少，命令作为**单个** argv 元素、
 *    前面恰好一行前导（关进度条、无 BOM 的 UTF-8 输出），命令本身逐字节不动；
 *  - C6 bgTaskService 的唯一 spawn 路径按 shell 取调用形态，并带 windowsHide；任务面板记的是
 *    模型写的命令，不带前导；
 *  - C7 `powerShellCommandLineLength` 是 libuv（MSVCRT 规则）转义后长度的**上界** —— 长度上限按它判，
 *    低估一个字符就会放过一条 spawn 不起来的命令。
 *
 * 隔离方式同 bashShellConfig.test.ts：配置是模块级缓存，每条用例 vi.resetModules() 后动态 import；
 * node:fs.existsSync 与 child_process 按旋钮桩掉；process.platform 用 defineProperty 改、用完还原。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ─── 桩 ──────────────────────────────────────────────────────────────────────

/** node:fs.existsSync 的旋钮 —— 决定哪些路径「存在」（工厂闭包在调用时才读） */
const fsStub: { exists: (path: string) => boolean } = { exists: () => false }
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual,
    existsSync: (path: unknown) => fsStub.exists(String(path))
  }
})

/** `where` 的输出（null = 找不到，status 1）；spawnSync 的每一次调用都记下来 */
const whereStub: { stdout: string | null } = { stdout: null }
const spawnSyncCalls: unknown[][] = []
/** spawn 的旋钮 —— C6 换成假子进程；缺省委托真实现（本文件别处用不到 spawn） */
const spawnStub: { impl: ((...args: unknown[]) => unknown) | null } = { impl: null }
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const spawnSync = (...args: unknown[]): unknown => {
    spawnSyncCalls.push(args)
    return whereStub.stdout !== null
      ? { status: 0, stdout: whereStub.stdout }
      : { status: 1, stdout: '' }
  }
  const spawn = (...args: unknown[]): unknown =>
    spawnStub.impl
      ? spawnStub.impl(...args)
      : (actual.spawn as (...a: unknown[]) => unknown)(...args)
  return { ...actual, default: { ...actual, spawnSync, spawn }, spawnSync, spawn }
})

const USER_DATA_DIR = join(tmpdir(), `shuvix-pwsh-userdata-${Date.now()}`)
// bgTaskService → utils/paths 需要 app.getPath（日志目录）与 app.isPackaged（CLI 路径）
vi.mock('electron', () => ({ app: { getPath: () => USER_DATA_DIR, isPackaged: false } }))

/** 原始描述符 —— 还原时连 writable/enumerable 一起还原 */
const REAL_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM_DESC, value: platform })
}
function restorePlatform(): void {
  Object.defineProperty(process, 'platform', REAL_PLATFORM_DESC)
}

type ShellModule = typeof import('../../utils/toolUtils/shell')

/** 每次都拿一个全新的 shell 模块（绕开 cachedPowerShellConfig 单例） */
async function loadShell(): Promise<ShellModule> {
  vi.resetModules()
  return await import('../../utils/toolUtils/shell')
}

const PF_PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const SYS_PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PS_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command'
]

/** Windows 上起一个 pwsh 7 的环境（C5 / C6 / C7 共用） */
function windowsWithPwsh(): void {
  setPlatform('win32')
  vi.stubEnv('ProgramFiles', 'C:\\Program Files')
  fsStub.exists = (path) => path === PF_PWSH
}

beforeEach(() => {
  fsStub.exists = () => false
  whereStub.stdout = null
  spawnSyncCalls.length = 0
  spawnStub.impl = null
  // 宿主（跑测试的这台机器）上的这几个变量不该漏进用例
  vi.stubEnv('ProgramFiles', undefined)
  vi.stubEnv('SystemRoot', undefined)
  vi.stubEnv('windir', undefined)
})

afterEach(() => {
  restorePlatform()
  vi.unstubAllEnvs()
})

afterAll(() => {
  rmSync(USER_DATA_DIR, { recursive: true, force: true })
})

// ─── C1…C4：解析顺序 ─────────────────────────────────────────────────────────

describe('getPowerShellConfig：解析顺序', () => {
  it('C1 — Program Files 下装了 pwsh 7：直接用它，edition pwsh，不去问 PATH', async () => {
    windowsWithPwsh()
    const shell = await loadShell()

    expect(shell.getPowerShellConfig()).toEqual({ exe: PF_PWSH, edition: 'pwsh' })
    expect(spawnSyncCalls).toHaveLength(0)
  })

  it('C2 — Program Files 里没有、PATH 上有：取 `where` 列出的第一个存在的，结果缓存', async () => {
    setPlatform('win32')
    vi.stubEnv('ProgramFiles', 'C:\\Program Files')
    const first = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
    const second = 'D:\\tools\\pwsh\\pwsh.exe'
    whereStub.stdout = `${first}\r\n${second}\r\n`
    fsStub.exists = (path) => path === first || path === second
    const shell = await loadShell()

    const config = shell.getPowerShellConfig()
    expect(config).toEqual({ exe: first, edition: 'pwsh' })
    expect(spawnSyncCalls).toHaveLength(1)
    expect(spawnSyncCalls[0][0]).toBe('where')
    expect(spawnSyncCalls[0][1]).toEqual(['pwsh.exe'])

    // 第二次读缓存：不再 spawn，结果是同一个对象
    expect(shell.getPowerShellConfig()).toBe(config)
    expect(spawnSyncCalls).toHaveLength(1)
  })

  it('C3 — 没有 pwsh：SystemRoot 下自带的 5.1 在 → 用它，edition windows-powershell', async () => {
    setPlatform('win32')
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    fsStub.exists = (path) => path === SYS_PS
    const shell = await loadShell()

    expect(shell.getPowerShellConfig()).toEqual({ exe: SYS_PS, edition: 'windows-powershell' })
  })

  it('C3 — SystemRoot 没设、windir 设了 → 路径以 windir 为根', async () => {
    setPlatform('win32')
    vi.stubEnv('windir', 'D:\\Win')
    const builtin = 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    fsStub.exists = (path) => path === builtin
    const shell = await loadShell()

    expect(shell.getPowerShellConfig()).toEqual({ exe: builtin, edition: 'windows-powershell' })
  })

  it('C3 — 系统目录里也没有（精简环境）→ 交给 PATH 解析的裸 powershell.exe', async () => {
    setPlatform('win32')
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    const shell = await loadShell()

    expect(shell.getPowerShellConfig()).toEqual({
      exe: 'powershell.exe',
      edition: 'windows-powershell'
    })
  })

  it('C3 — `where` 列出的路径并不存在（where 会列出不可执行的同名项）→ 退回 5.1', async () => {
    setPlatform('win32')
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    whereStub.stdout = 'C:\\gone\\pwsh.exe\r\n'
    fsStub.exists = (path) => path === SYS_PS
    const shell = await loadShell()

    expect(shell.getPowerShellConfig()).toEqual({ exe: SYS_PS, edition: 'windows-powershell' })
    expect(spawnSyncCalls).toHaveLength(1)
  })

  it('C4 — 非 Windows 上没有 PowerShell 工具：直接报错并指向 bash', async () => {
    setPlatform('darwin')
    // 就算这台机器上装了 pwsh 也不用
    fsStub.exists = () => true
    whereStub.stdout = '/usr/local/bin/pwsh\n'
    const shell = await loadShell()

    expect(() => shell.getPowerShellConfig()).toThrow(/bash/)
  })
})

// ─── C5：调用形态 ────────────────────────────────────────────────────────────

/** 一条什么都占一点的多行命令：双引号、$env:、反引号、以 `-Foo` 结尾（像一个开关） */
const TRICKY = 'Write-Output "a b"\n$env:X = \'1\'; Get-ChildItem `\n  -Path $env:X -Foo'

describe('shellInvocation', () => {
  it('C5 — powershell：可执行文件是解析出的那个；参数恰好是固定六项 + 一个命令参数', async () => {
    windowsWithPwsh()
    const shell = await loadShell()
    const inv = shell.shellInvocation('powershell', TRICKY)

    expect(inv.file).toBe(PF_PWSH)
    expect(inv.args).toHaveLength(PS_ARGS.length + 1)
    expect(inv.args.slice(0, -1)).toEqual(PS_ARGS)

    // 命令是单个 argv 元素：前导一行 + 原样的命令（第一个换行之后逐字节相同）
    const payload = inv.args[inv.args.length - 1]
    const newline = payload.indexOf('\n')
    expect(newline).toBeGreaterThan(0)
    expect(payload.slice(newline + 1)).toBe(TRICKY)
    const prelude = payload.slice(0, newline)
    expect(prelude).toContain("$ProgressPreference = 'SilentlyContinue'")
    expect(prelude).toContain('UTF8Encoding]::new($false)')
    // [Text.Encoding]::UTF8 会在输出开头写 BOM
    expect(prelude).not.toContain('Encoding]::UTF8')
  })

  it('C5 — 对照：bash（darwin，/bin/bash 在）→ /bin/bash --norc -c <命令>，没有任何前导', async () => {
    setPlatform('darwin')
    fsStub.exists = (path) => path === '/bin/bash'
    const shell = await loadShell()

    expect(shell.shellInvocation('bash', TRICKY)).toEqual({
      file: '/bin/bash',
      args: ['--norc', '-c', TRICKY]
    })
  })
})

// ─── C6：bgTaskService 的 spawn ──────────────────────────────────────────────

/** 一个马上以 0 退出的假子进程（bgTaskService 只用 pid 与 exit / error 两个事件） */
function fakeChild(): EventEmitter & { pid: number } {
  const child = Object.assign(new EventEmitter(), { pid: 4242 })
  setTimeout(() => child.emit('exit', 0, null), 5)
  return child
}

describe('bgTaskService.runCommand 走 powershell', () => {
  it('C6 — spawn 收到 C5 的调用形态、windowsHide、不 detach、stdin 为 ignore；任务记的是原命令', async () => {
    vi.resetModules()
    // 同一张新模块图：期望值与被测代码用的是同一个 shell 模块实例
    const shell = await import('../../utils/toolUtils/shell')
    const bg = await import('../../services/bgTaskService')

    const spawned: unknown[][] = []
    spawnStub.impl = (...args: unknown[]) => {
      spawned.push(args)
      return fakeChild()
    }
    windowsWithPwsh()

    const toolCallId = `pwsh-c6-${Date.now()}`
    const outcome = await bg.runCommand({
      sessionId: 'pwsh-c6-session',
      toolCallId,
      shell: 'powershell',
      command: 'Get-Date',
      description: 'what time is it',
      cwd: tmpdir(),
      background: false,
      timeoutMs: 10_000
    })

    expect(outcome.kind).toBe('settled')
    expect(spawned).toHaveLength(1)
    const [file, args, opts] = spawned[0] as [string, string[], Record<string, unknown>]
    const expected = shell.shellInvocation('powershell', 'Get-Date')
    expect(file).toBe(PF_PWSH)
    expect(file).toBe(expected.file)
    expect(args).toEqual(expected.args)
    expect(opts.windowsHide).toBe(true)
    expect(opts.detached).toBe(false)
    expect((opts.stdio as unknown[])[0]).toBe('ignore')

    // 面板 / 通知里显示的是模型写的那条命令（info 取自任务的 subject），不是塞了前导的 argv
    expect(outcome.info.command).toBe('Get-Date')
  })
})

// ─── C7：命令行长度的上界 ────────────────────────────────────────────────────

/**
 * libuv `quote_cmd_arg`（win/process.c）的逐行转写 —— spawn 在 Windows 上就是这样把一个 argv 元素
 * 拼进命令行的：没有空白与引号原样；没有引号与反斜杠只包一对引号；否则从尾往前走，紧挨在 `"`
 * 前（或参数末尾）的反斜杠翻倍，每个 `"` 前加一个反斜杠，最后整体包一对引号。
 */
function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""'
  if (!/[ \t"]/.test(arg)) return arg
  if (!/["\\]/.test(arg)) return `"${arg}"`
  const reversed: string[] = []
  let quoteHit = true
  for (let i = arg.length; i > 0; --i) {
    const ch = arg[i - 1]
    reversed.push(ch)
    if (quoteHit && ch === '\\') {
      reversed.push('\\')
    } else if (ch === '"') {
      quoteHit = true
      reversed.push('\\')
    } else {
      quoteHit = false
    }
  }
  return `"${reversed.reverse().join('')}"`
}

describe('powerShellCommandLineLength', () => {
  /** 前导（从真调用形态里切出来，不抄一份常量） */
  async function preludeOf(shell: ShellModule): Promise<string> {
    const payload = shell.shellInvocation('powershell', 'x').args.at(-1)!
    return payload.slice(0, payload.length - 1)
  }

  it('C7 — 没有引号与反斜杠的命令：前导长 + 命令长 + 2（外面那对引号）', async () => {
    windowsWithPwsh()
    const shell = await loadShell()
    const prelude = await preludeOf(shell)
    // 前提：前导本身不含 `"` / `\`，否则下面的等式要把它们也算上
    expect(prelude).not.toMatch(/["\\]/)

    for (const cmd of ['', 'Get-Date', "Write-Output 'a b'; $env:X", 'x'.repeat(5000)]) {
      expect(shell.powerShellCommandLineLength(cmd), JSON.stringify(cmd.slice(0, 20))).toBe(
        prelude.length + cmd.length + 2
      )
    }
  })

  it('C7 — 每多一个 `"` 或 `\\` 恰好多 2（字符本身 + 一个转义）', async () => {
    const shell = await loadShell()
    const base = 'Write-Output hi'
    const at = (cmd: string): number => shell.powerShellCommandLineLength(cmd)
    expect(at(base + '"') - at(base)).toBe(2)
    expect(at(base + '\\') - at(base)).toBe(2)
    expect(at(base + '""') - at(base)).toBe(4)
    expect(at(base + '\\"') - at(base)).toBe(4)
    expect(at(base + 'a') - at(base)).toBe(1)
  })

  it('C7 — 恒不小于 libuv 实际转义出的长度（尾随反斜杠、\\" 序列、成串反斜杠接引号）', async () => {
    windowsWithPwsh()
    const shell = await loadShell()
    const prelude = await preludeOf(shell)

    const cases = [
      'Get-Date',
      'C:\\dir\\',
      'C:\\dir\\\\\\',
      'echo \\"quoted\\"',
      'a\\\\\\\\"b',
      '"',
      '\\',
      '\\\\"\\\\"\\\\',
      'Write-Output "a b" "c\\d\\" \\\\server\\share\\',
      '"'.repeat(50) + '\\'.repeat(50),
      'x\t"y"\t\\'
    ]
    for (const cmd of cases) {
      const actual = quoteCmdArg(prelude + cmd).length
      expect(shell.powerShellCommandLineLength(cmd), JSON.stringify(cmd)).toBeGreaterThanOrEqual(
        actual
      )
    }

    // 自检：参照实现确实在转义（不是把输入原样还回来，那样上面的比较毫无意义）
    expect(quoteCmdArg('a "b"')).toBe('"a \\"b\\""')
    expect(quoteCmdArg('a b\\')).toBe('"a b\\\\"')
    expect(quoteCmdArg('a\\b c')).toBe('"a\\b c"')
    expect(quoteCmdArg('a\\\\"b c')).toBe('"a\\\\\\\\\\"b c"')
  })
})
