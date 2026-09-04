/**
 * getShellConfig 的**形状**测试 —— 锁死 `--norc` 出现在每一个 bash 分支上，且 sh 回退分支上没有。
 *
 * 为什么这是正确性而非风格：macOS 的 /bin/bash 在非交互、非登录、未被当作 sh 调用时，
 * 若 fd 0 是 socket（libuv 的 'pipe' stdio 正是 socketpair）且 SHLVL 缺失或为 "0"，
 * 会在执行 `-c` 命令**之前**抢先 source ~/.bashrc（见 shell.ts 的 BASH_ARGS 注释）。
 * `--norc` 是把这条路堵死的那一个 flag，所以它在哪些分支上出现是必须被钉住的事实。
 *
 * 隔离方式：cachedShellConfig 是模块级单例且没有 reset 出口 —— 本文件**每条用例**都先
 * vi.resetModules() 再动态 import，谁都不会读到上一条用例缓存下来的结果。
 * （既有的 shell.test.ts 是无 mock 的纯函数测试，刻意不往那边加 fs/platform 桩。）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ─── 桩 ──────────────────────────────────────────────────────────────────────

/**
 * node:fs.existsSync 的行为旋钮 —— 决定哪些路径"存在"。
 * 默认委托真实 existsSync，用例按需覆盖（工厂里的闭包在调用时才读它）。
 */
const fsStub: { exists: (path: string) => boolean } = { exists: () => false }
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual,
    existsSync: (path: unknown) => fsStub.exists(String(path))
  }
})

/** child_process.spawnSync 的行为旋钮 —— `which bash` / `where bash.exe` 的结果 */
const bashOnPath: { path: string | null } = { path: null }
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    default: actual,
    spawnSync: () =>
      bashOnPath.path ? { status: 0, stdout: `${bashOnPath.path}\n` } : { status: 1, stdout: '' }
  }
})

/** 原始描述符 —— 还原时连 writable/enumerable 一起还原，不给同 worker 的后续文件留下痕迹 */
const REAL_PLATFORM_DESC = Object.getOwnPropertyDescriptor(process, 'platform')!

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM_DESC, value: platform })
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', REAL_PLATFORM_DESC)
}

/** 每次都拿一个全新的 shell 模块（绕开 cachedShellConfig 单例） */
async function loadShellConfig(): Promise<{ shell: string; args: string[] }> {
  vi.resetModules()
  const mod = await import('../../utils/toolUtils/shell')
  return mod.getShellConfig()
}

beforeEach(() => {
  fsStub.exists = () => false
  bashOnPath.path = null
})

afterEach(() => {
  restorePlatform()
  vi.unstubAllEnvs()
})

// ─── U1 / U11：每一个 bash 分支都带 --norc ───────────────────────────────────

describe('getShellConfig：bash 分支恒带 --norc', () => {
  it('U1 — Unix /bin/bash：args 恰为 ["--norc", "-c"]，顺序不可颠倒', async () => {
    setPlatform('darwin')
    fsStub.exists = (path) => path === '/bin/bash'

    const config = await loadShellConfig()

    expect(config.shell).toBe('/bin/bash')
    // 完全相等 —— 多一个参数或少一个都算回归
    expect(config.args).toEqual(['--norc', '-c'])
    // 顺序是语义：`bash -c --norc` 会把 --norc 当成要执行的命令
    expect(config.args.indexOf('--norc')).toBeLessThan(config.args.indexOf('-c'))
    expect(config.args[config.args.length - 1]).toBe('-c')
  })

  it('U1b — Unix PATH 中的 bash（无 /bin/bash）同样带 --norc', async () => {
    setPlatform('linux')
    bashOnPath.path = '/usr/local/bin/bash'
    fsStub.exists = () => false // /bin/bash 不存在

    const config = await loadShellConfig()

    expect(config.shell).toBe('/usr/local/bin/bash')
    expect(config.args).toEqual(['--norc', '-c'])
  })

  it('U11a — Windows Git Bash 分支带 --norc', async () => {
    setPlatform('win32')
    vi.stubEnv('ProgramFiles', 'C:\\Program Files')
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    fsStub.exists = (path) => path === gitBash

    const config = await loadShellConfig()

    expect(config.shell).toBe(gitBash)
    expect(config.args).toEqual(['--norc', '-c'])
  })

  it('U11b — Windows PATH 中的 bash.exe 分支带 --norc', async () => {
    setPlatform('win32')
    vi.stubEnv('ProgramFiles', 'C:\\Program Files')
    vi.stubEnv('ProgramFiles(x86)', undefined)
    const pathBash = 'C:\\tools\\bash.exe'
    bashOnPath.path = pathBash
    // Git Bash 不存在；但 findBashOnPath 找到后会再 existsSync 校验一次
    fsStub.exists = (path) => path === pathBash

    const config = await loadShellConfig()

    expect(config.shell).toBe(pathBash)
    expect(config.args).toEqual(['--norc', '-c'])
  })

  it('本机实际解析出的配置也带 --norc（防止上面四条把真实分支绕过去）', async () => {
    const { existsSync } = await vi.importActual<typeof import('node:fs')>('node:fs')
    fsStub.exists = (path) => existsSync(path)
    bashOnPath.path = null

    const config = await loadShellConfig()

    // Windows 上没装 bash 时 getShellConfig 会抛；本仓库的测试跑在 POSIX 上
    if (process.platform !== 'win32') {
      expect(config.shell).toMatch(/bash$/)
      expect(config.args).toEqual(['--norc', '-c'])
    }
  })
})

// ─── U10：sh 回退分支刻意**不带** --norc ─────────────────────────────────────

describe('getShellConfig：sh 回退分支', () => {
  /**
   * 守护用例（不是回归用例）——修复前后都绿。
   * 钉住的是那条刻意的例外：dash/busybox 不认 --norc，且 sh 模式（act_like_sh）
   * 本身就是 rshd 探测的抑制条件，加了只会在一批系统上把 bash 工具整个打死。
   */
  it('U10 — 没有任何 bash 时回退到裸 sh，args 恰为 ["-c"]', async () => {
    setPlatform('linux')
    fsStub.exists = () => false
    bashOnPath.path = null

    const config = await loadShellConfig()

    expect(config.shell).toBe('sh')
    expect(config.args).toEqual(['-c'])
    expect(config.args).not.toContain('--norc')
  })
})
