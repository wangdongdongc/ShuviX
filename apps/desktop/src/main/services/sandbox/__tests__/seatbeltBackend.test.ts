/**
 * macOS 后端（backends/seatbelt/index.ts）—— 不起真的 sandbox-exec：spawnSync / existsSync /
 * realpathSync / tmpdir 都是替身。
 *
 *  - SB-1 wrap：固定的 sandbox-exec 绝对路径、-p profile、-D 参数一一对应、`--` 紧挨着 shell；
 *  - SB-2 startupFailure：只认 65 / 71 且第一行就是 sandbox-exec 自己那一行；
 *  - SB-3 probe：找不到 / spawn 出错 / 成功 / 各种失败的原因，以及它跑的是与真实 profile 同形的规格
 *    （拒读家目录、放回可读根与 cli-token、元数据、可写根 —— 外层若是 allow-default 沙箱，同形才探得出来）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  existsSync: vi.fn(),
  realpathSync: vi.fn(),
  tmpdir: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent', isPackaged: false } }))
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawnSync: mocks.spawnSync }
})
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: mocks.existsSync, realpathSync: mocks.realpathSync }
})
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, tmpdir: mocks.tmpdir }
})

import { SANDBOX_EXEC, createSeatbeltBackend } from '../backends/seatbelt'
import { compileSeatbeltProfile } from '../backends/seatbelt/profile'
import { buildSandboxSpec } from '../spec'
import type { SandboxHostPaths, SandboxSpec } from '../types'

const PATHS: SandboxHostPaths = {
  home: '/Users/u',
  userData: '/Users/u/Library/Application Support/ShuviX',
  shuvixHome: '/Users/u/.shuvix',
  toolResultsBase: '/Users/u/Library/Application Support/ShuviX/tool_results',
  uid: 501,
  cliSocket: '/Users/u/.shuvix/cli.sock',
  cliToken: '/Users/u/.shuvix/cli-token',
  appPaths: ['/Applications/ShuviX.app'],
  tmpRoot: '/private/tmp/shuvix-501'
}
const TMPDIR_RAW = '/var/folders/ab/xyz/T'
const TMPDIR_REAL = '/private/var/folders/ab/xyz/T'

function specOf(ws = '/Users/u/proj', grantedWrite: string[] = []): SandboxSpec {
  const result = buildSandboxSpec(
    PATHS,
    { sessionId: 'sess-1', workingDirectory: ws, grantedRead: [], grantedWrite },
    (p) => p
  )
  if (!result.ok) throw new Error(result.reason)
  return result.spec
}

beforeEach(() => {
  mocks.spawnSync.mockReset()
  mocks.spawnSync.mockReturnValue({ status: 0, stderr: '', stdout: '' })
  mocks.existsSync.mockReset()
  mocks.existsSync.mockReturnValue(true)
  mocks.realpathSync.mockReset()
  mocks.realpathSync.mockImplementation((p: string) => (p === TMPDIR_RAW ? TMPDIR_REAL : p))
  mocks.tmpdir.mockReset()
  mocks.tmpdir.mockReturnValue(TMPDIR_RAW)
})

describe('SB-1 wrap', () => {
  it('SB-1 [-p profile, -D Pk=v …, --, shell, …args]；文件是写死的绝对路径', () => {
    const spec = specOf('/Users/u/proj', ['/Volumes/a b=c'])
    const { profile, params } = compileSeatbeltProfile(spec)
    const wrapped = createSeatbeltBackend().wrap(spec, {
      file: '/bin/bash',
      args: ['-c', 'echo hi']
    })
    expect(SANDBOX_EXEC).toBe('/usr/bin/sandbox-exec')
    expect(wrapped.file).toBe('/usr/bin/sandbox-exec')
    expect(wrapped.args).toEqual([
      '-p',
      profile,
      ...Object.entries(params).flatMap(([k, v]) => ['-D', `${k}=${v}`]),
      '--',
      '/bin/bash',
      '-c',
      'echo hi'
    ])
  })

  it('SB-1 带 = 与空格的值仍是一个 argv 元素；-D 的对数恰等于参数个数；`--` 紧挨着 shell', () => {
    const odd = '/Volumes/a b=c'
    const spec = specOf('/Users/u/proj', [odd])
    const { params } = compileSeatbeltProfile(spec)
    const { args } = createSeatbeltBackend().wrap(spec, { file: '/bin/bash', args: ['-c', 'x'] })
    const defines = args.filter((_, i) => args[i - 1] === '-D')
    expect(args.filter((a) => a === '-D')).toHaveLength(Object.keys(params).length)
    expect(defines).toEqual(Object.entries(params).map(([k, v]) => `${k}=${v}`))
    expect(defines.some((d) => d.endsWith(`=${odd}`))).toBe(true)
    const dash = args.indexOf('--')
    expect(args[dash + 1]).toBe('/bin/bash')
    expect(args.lastIndexOf('--')).toBe(dash)
  })
})

describe('SB-2 startupFailure', () => {
  const b = createSeatbeltBackend()
  it.each([
    [65, 'sandbox-exec: unbound variable P9', 'sandbox-exec: unbound variable P9'],
    [
      71,
      '  \nsandbox-exec: sandbox_apply: Operation not permitted\n',
      'sandbox-exec: sandbox_apply: Operation not permitted'
    ],
    [1, 'sandbox-exec: whatever', null],
    [65, 'npm ERR!\nsandbox-exec: whatever', null],
    [null, 'sandbox-exec: whatever', null],
    [71, 'something else', null]
  ] as const)('SB-2 (%s, %j) → %j', (code, output, expected) => {
    expect(b.startupFailure(output, code)).toBe(expected)
  })
})

describe('SB-3 probe', () => {
  it('SB-3 /usr/bin/sandbox-exec 不存在 → 不可用（not found），不 spawn', () => {
    mocks.existsSync.mockReturnValue(false)
    const result = createSeatbeltBackend().probe(PATHS)
    expect(result.available).toBe(false)
    expect(!result.available && result.reason).toContain('not found')
    expect(mocks.existsSync).toHaveBeenCalledWith('/usr/bin/sandbox-exec')
    expect(mocks.spawnSync).not.toHaveBeenCalled()
  })

  it('SB-3 spawn 出错 → 原因是错误信息', () => {
    mocks.spawnSync.mockReturnValue({ error: new Error('spawn EACCES'), status: null, stderr: '' })
    expect(createSeatbeltBackend().probe(PATHS)).toEqual({
      available: false,
      reason: 'spawn EACCES'
    })
  })

  it('SB-3 退出 0 → 可用', () => {
    expect(createSeatbeltBackend().probe(PATHS)).toEqual({ available: true })
  })

  it('SB-3 退出 71 + 多行 stderr → 原因是第一行', () => {
    mocks.spawnSync.mockReturnValue({
      status: 71,
      stderr: 'sandbox-exec: sandbox_apply: Operation not permitted\nsecond line\n'
    })
    expect(createSeatbeltBackend().probe(PATHS)).toEqual({
      available: false,
      reason: 'sandbox-exec: sandbox_apply: Operation not permitted'
    })
  })

  it('SB-3 退出 65 + 空 stderr → sandbox-exec exited with 65', () => {
    mocks.spawnSync.mockReturnValue({ status: 65, stderr: '' })
    expect(createSeatbeltBackend().probe(PATHS)).toEqual({
      available: false,
      reason: 'sandbox-exec exited with 65'
    })
  })

  it('SB-3 跑的是与真实 profile 同形的规格：deny default、有参数、`--` 后是 /usr/bin/true；10 秒超时；工作区 = realpath(tmpdir())', () => {
    createSeatbeltBackend().probe(PATHS)
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1)
    const [file, args, opts] = mocks.spawnSync.mock.calls[0] as [
      string,
      string[],
      { timeout?: number }
    ]
    expect(file).toBe('/usr/bin/sandbox-exec')
    expect(args[0]).toBe('-p')
    expect(args[1]).toContain('(deny default)')
    expect(args[1]).toContain('(import "system.sb")')
    expect(args.filter((a) => a === '-D').length).toBeGreaterThanOrEqual(1)
    expect(args.slice(-2)).toEqual(['--', '/usr/bin/true'])
    expect(opts.timeout).toBe(10_000)
    expect(mocks.realpathSync).toHaveBeenCalledWith(TMPDIR_RAW)
    const defines = args
      .filter((_, i) => args[i - 1] === '-D')
      .map((d) => d.slice(d.indexOf('=') + 1))
    expect(defines).toContain(TMPDIR_REAL)
    expect(defines).not.toContain(TMPDIR_RAW)
  })

  /** 探测时传给 sandbox-exec 的 -D 参数（键 → 值） */
  function probeDefines(): Map<string, string> {
    const [, args] = mocks.spawnSync.mock.calls[0] as [string, string[]]
    return new Map(
      args
        .filter((_, i) => args[i - 1] === '-D')
        .map((d) => [d.slice(0, d.indexOf('=')), d.slice(d.indexOf('=') + 1)] as const)
    )
  }

  it('SB-3b 探测的 profile 与真实的同形：拒读家目录恰一行（参数就是家目录）、放回可读根与 cli-token、只放元数据的上级目录、写只放可写根', () => {
    createSeatbeltBackend().probe(PATHS)
    const [, args] = mocks.spawnSync.mock.calls[0] as [string, string[]]
    const lines = args[1].split('\n')
    const defines = probeDefines()
    const valuesOf = (line: string): string[] =>
      [...line.matchAll(/\(param "(P\d+)"\)/g)].map((m) => defines.get(m[1])!)

    const denyReads = lines.filter((l) => l.startsWith('(deny file-read*'))
    expect(denyReads).toHaveLength(1)
    expect(denyReads[0]).toMatch(/^\(deny file-read\* \(subpath \(param "P\d+"\)\)\)$/)
    expect(valuesOf(denyReads[0])).toEqual([PATHS.home])

    // 放回：探测会话的会话目录（工作区 = realpath(tmpdir())）、程序目录、cli-token
    const allowBack = lines.filter((l) => /^\(allow file-read\*\s+\(/.test(l))
    expect(allowBack).toHaveLength(1)
    expect(valuesOf(allowBack[0])).toEqual(
      expect.arrayContaining([TMPDIR_REAL, ...PATHS.appPaths, PATHS.cliToken])
    )
    expect(lines.filter((l) => l.startsWith('(allow file-read-metadata '))).toHaveLength(1)

    const writes = lines.filter((l) => l.startsWith('(allow file-write* '))
    expect(writes).toHaveLength(1)
    expect(valuesOf(writes[0])).toContain(TMPDIR_REAL)
    expect(valuesOf(writes[0])).not.toContain(PATHS.cliToken)
  })

  it('SB-3b 探测用的是一个固定、安全的会话 id（"probe"）：它的临时目录、artifacts、工具结果都在参数里', () => {
    createSeatbeltBackend().probe(PATHS)
    const values = [...probeDefines().values()]
    expect(values).toContain(`${PATHS.shuvixHome}/artifacts/probe`)
    expect(values).toContain(`${PATHS.toolResultsBase}/probe`)
    expect(values.some((v) => v.startsWith(`${PATHS.tmpRoot}/`))).toBe(true)
  })

  it.each([
    ['家目录就是 realpath(tmpdir())', TMPDIR_REAL],
    ['家目录在 realpath(tmpdir()) 里', `${TMPDIR_REAL}/fake-home`]
  ])('SB-3 %s → 探测规格被拒（不可用），不 spawn', (_label, home) => {
    const result = createSeatbeltBackend().probe({
      ...PATHS,
      home,
      userData: `${home}/Library/Application Support/ShuviX`,
      shuvixHome: `${home}/.shuvix`,
      toolResultsBase: `${home}/Library/Application Support/ShuviX/tool_results`,
      cliSocket: `${home}/.shuvix/cli.sock`,
      cliToken: `${home}/.shuvix/cli-token`
    })
    expect(result.available).toBe(false)
    expect(!result.available && result.reason).toMatch(/^probe spec rejected: /)
    expect(mocks.spawnSync).not.toHaveBeenCalled()
  })
})
