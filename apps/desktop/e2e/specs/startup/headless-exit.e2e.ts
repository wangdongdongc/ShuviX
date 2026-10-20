/**
 * 无头运行里**自己会退出**的那几种启动（docs/headless/design.md §1）—— 只用 `runToExit`，每个用例一个自己的临时 HOME
 * （/private/tmp 下）：`--help`、参数不对（退出码 2）、端口被占（退出码 1）。
 *
 * HX-1  `--help`（不带 --headless）→ 0；用法（第一行、--headless 那一行、--help 那一行）；没有就绪那一行；不写地址文件
 *       （模块导入先于解析，所以库照样会被建出来 —— 不断言它不在）
 * HX-2  `-h` 同上
 * HX-3  `--help --headless --port abc` → 0（--help 优先于参数错误）
 * HX-4  `--headless --port abc` → 2；恰一行「invalid --port value "abc"」；没有就绪那一行
 * HX-5  `--headless --port` → 2；「--port needs a value」那一行
 * HX-6  `--headless --network-port=80` → 2；别名报别名
 * HX-7  SHUVIX_HEADLESS=Yes + `--port 70000` → 2
 * HX-8  0.0.0.0:P 被占（无头一律监听 0.0.0.0，谁能连由策略定）→ 1；恰一行「cannot listen on port P: EADDRINUSE …」；
 *       没有就绪那一行；之后开始退出 / 退出完各一行；退出后地址文件不在
 * HX-8b 0.0.0.0:P 被占 + 弃用的 `--lan` → 1，同一行；弃用说明照样先打一行
 * HX-8c 0.0.0.0:P 被占 + SHUVIX_LAN=yes → 1，同一行
 *       （弃用的 `--bind` 不再决定监听在哪：这台电脑上没有的网卡也照常起来，见 headless-legacy-sharing.e2e.ts）
 * HX-10 `--bind 'a;b'` → 2；「invalid --bind value "a;b"」那一行；`--headless --bind`（缺值）→ 2；「--bind needs a value」那一行
 *       （弃用的参数照旧被校验：服务文件里写错了要看得见）
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { freePort, runToExit, type RunToExitResult } from '../../harness/launch'

const READY_PREFIX = 'ShuviX headless: ready — open one of: '
const USAGE_FIRST = 'Usage: shuvix --headless [--port <n>]'
const USAGE_HEADLESS = '  --headless          run without windows (same as SHUVIX_HEADLESS=1)'
const USAGE_HELP = '  --help, -h          print this help and exit'
const SHUTTING_DOWN = 'ShuviX headless: shutting down'
const STOPPED = 'ShuviX headless: stopped'
const LAN_DEPRECATED =
  'ShuviX headless: --lan is deprecated — who can connect is now the security policy network-admission; ' +
  'if you have none yet, it is written from this option once (~/.shuvix/policies/network-admission.md)'

const homes: string[] = []
const blockers: Server[] = []

function newHome(): string {
  const home = mkdtempSync('/private/tmp/shuvix-e2e-')
  mkdirSync(join(home, 'userdata'), { recursive: true })
  homes.push(home)
  return home
}

const lines = (text: string): string[] => text.split('\n').map((l) => l.replace(/\r$/, ''))
const countLine = (text: string, line: string): number =>
  lines(text).filter((l) => l === line).length
const hasReadyLine = (text: string): boolean => lines(text).some((l) => l.startsWith(READY_PREFIX))

async function block(port: number, host: string): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, () => resolveListen())
  })
  blockers.push(server)
  return server
}

async function unblock(server: Server): Promise<void> {
  blockers.splice(blockers.indexOf(server), 1)
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
}

afterAll(async () => {
  for (const server of [...blockers]) await unblock(server)
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

/** 断言一次参数错误的退出：退出码 2、恰一行、没有就绪那一行 */
function expectArgsError(result: RunToExitResult, line: string): void {
  expect(result.code, result.output.slice(-1500)).toBe(2)
  expect(countLine(result.stdout, line), result.stdout).toBe(1)
  expect(hasReadyLine(result.stdout)).toBe(false)
}

/** 断言一次「监听不了」的退出（HX-8 / 8b / 8c 端口被占共用） */
function expectListenError(
  result: RunToExitResult,
  home: string,
  port: number,
  reason = 'EADDRINUSE (the port is already in use)'
): void {
  const line = `ShuviX headless: cannot listen on port ${port}: ${reason}`
  expect(result.code, result.output.slice(-2000)).toBe(1)
  expect(countLine(result.stdout, line), result.stdout).toBe(1)
  expect(hasReadyLine(result.stdout)).toBe(false)
  const all = lines(result.stdout)
  const at = all.indexOf(line)
  expect(all.filter((l) => l === SHUTTING_DOWN)).toHaveLength(1)
  expect(all.filter((l) => l === STOPPED)).toHaveLength(1)
  expect(all.indexOf(SHUTTING_DOWN)).toBeGreaterThan(at)
  expect(all.indexOf(STOPPED)).toBeGreaterThan(all.indexOf(SHUTTING_DOWN))
  expect(existsSync(join(home, 'userdata', 'headless.json'))).toBe(false)
}

describe('headless: launches that exit on their own', () => {
  it('HX-1 --help prints the usage and exits 0', async () => {
    const home = newHome()
    const result = await runToExit({ home, args: ['--help'] })
    expect(result.code, result.output.slice(-1500)).toBe(0)
    expect(countLine(result.stdout, USAGE_FIRST)).toBe(1)
    expect(countLine(result.stdout, USAGE_HEADLESS)).toBe(1)
    expect(countLine(result.stdout, USAGE_HELP)).toBe(1)
    expect(hasReadyLine(result.stdout)).toBe(false)
    expect(existsSync(join(home, 'userdata', 'headless.json'))).toBe(false)
  }, 90_000)

  it('HX-2 -h does the same', async () => {
    const result = await runToExit({ home: newHome(), args: ['-h'] })
    expect(result.code, result.output.slice(-1500)).toBe(0)
    expect(countLine(result.stdout, USAGE_FIRST)).toBe(1)
    expect(countLine(result.stdout, USAGE_HEADLESS)).toBe(1)
    expect(countLine(result.stdout, USAGE_HELP)).toBe(1)
    expect(hasReadyLine(result.stdout)).toBe(false)
  }, 90_000)

  it('HX-3 --help wins over an argument error', async () => {
    const result = await runToExit({
      home: newHome(),
      args: ['--help', '--headless', '--port', 'abc']
    })
    expect(result.code, result.output.slice(-1500)).toBe(0)
    expect(countLine(result.stdout, USAGE_FIRST)).toBe(1)
  }, 90_000)

  it('HX-4 an invalid --port exits 2 with one line', async () => {
    const result = await runToExit({ home: newHome(), args: ['--headless', '--port', 'abc'] })
    expectArgsError(
      result,
      'ShuviX headless: invalid --port value "abc": use an integer between 1024 and 65535 (see shuvix --help)'
    )
  }, 90_000)

  it('HX-5 --port without a value exits 2', async () => {
    const result = await runToExit({ home: newHome(), args: ['--headless', '--port'] })
    expectArgsError(
      result,
      'ShuviX headless: --port needs a value (an integer between 1024 and 65535) (see shuvix --help)'
    )
  }, 90_000)

  it('HX-6 the alias names itself in the error', async () => {
    const result = await runToExit({ home: newHome(), args: ['--headless', '--network-port=80'] })
    expectArgsError(
      result,
      'ShuviX headless: invalid --network-port value "80": use an integer between 1024 and 65535 (see shuvix --help)'
    )
  }, 90_000)

  it('HX-7 SHUVIX_HEADLESS=Yes with an out-of-range port exits 2', async () => {
    const result = await runToExit({
      home: newHome(),
      args: ['--port', '70000'],
      env: { SHUVIX_HEADLESS: 'Yes' }
    })
    expectArgsError(
      result,
      'ShuviX headless: invalid --port value "70000": use an integer between 1024 and 65535 (see shuvix --help)'
    )
  }, 90_000)

  it('HX-8 a port in use on 0.0.0.0 exits 1 with the cannot-listen line', async () => {
    const home = newHome()
    const port = await freePort()
    const blocker = await block(port, '0.0.0.0')
    try {
      const result = await runToExit({
        home,
        args: ['--headless', '--port', String(port)],
        timeoutMs: 90_000
      })
      expectListenError(result, home, port)
    } finally {
      await unblock(blocker)
    }
  }, 120_000)

  it('HX-8b --lan with 0.0.0.0:P in use exits 1', async () => {
    const home = newHome()
    const port = await freePort()
    const blocker = await block(port, '0.0.0.0')
    try {
      const result = await runToExit({
        home,
        args: ['--headless', '--lan', '--port', String(port)],
        timeoutMs: 90_000
      })
      expectListenError(result, home, port)
      expect(countLine(result.stdout, LAN_DEPRECATED), result.stdout).toBe(1)
    } finally {
      await unblock(blocker)
    }
  }, 120_000)

  it('HX-8c SHUVIX_LAN=yes with 0.0.0.0:P in use exits 1', async () => {
    const home = newHome()
    const port = await freePort()
    const blocker = await block(port, '0.0.0.0')
    try {
      const result = await runToExit({
        home,
        args: ['--headless', '--port', String(port)],
        env: { SHUVIX_LAN: 'yes' },
        timeoutMs: 90_000
      })
      expectListenError(result, home, port)
    } finally {
      await unblock(blocker)
    }
  }, 120_000)

  it('HX-10 an invalid or missing --bind value exits 2 with one line', async () => {
    const invalid = await runToExit({ home: newHome(), args: ['--headless', '--bind', 'a;b'] })
    expectArgsError(
      invalid,
      'ShuviX headless: invalid --bind value "a;b": use a network interface name such as eth1, or an address of this computer (see shuvix --help)'
    )
    const missing = await runToExit({ home: newHome(), args: ['--headless', '--bind'] })
    expectArgsError(
      missing,
      'ShuviX headless: --bind needs a value (a network interface name such as eth1, or an address of this computer) (see shuvix --help)'
    )
  }, 120_000)
})
