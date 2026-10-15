/**
 * `utils/headlessInstance.ts` —— 无头实例的地址文件（`<userData>/headless.json`）与「第二个实例」的裁决
 * （docs/headless/design.md §1 Lifecycle）。地址文件用真的临时目录；判活注入或用真的进程。
 *
 *   HI-1 写 / 读来回：没有端口 → 没有 port 键；带端口恰好读回；文件是 JSON + 换行；不留 .tmp；再写覆盖
 *   HI-2 写进不存在的目录 → false、不抛、不留 .tmp
 *   HI-3 读：文件缺失 / 不是 JSON / 形状不对（null、数组、字符串、{}；pid 0 / -1 / 1.5 / "123" / 2**53；urls 缺 /
 *        不是数组 / 有非字符串；port "8123" / 1.5）→ null；多余的键丢掉
 *   HI-4 删：pid 对得上才删；别的 pid 留着；文件缺失不抛；坏文件留着
 *   HI-5 判活：自己活着；退出了的子进程不活；pid 1（EPERM）算活（root 下跳过）
 *   HI-6 裁决矩阵：没有地址文件 → 要无头说桌面在跑（1）、不要无头照旧（0、不打印）；地址文件在且 pid 活着 →
 *        打印它的地址（0）；还没地址 → 还在启动（0）；pid 死了 → 同没有文件；锁的持有者不是它 → 同没有文件；
 *        判活拿到的是地址里的 pid；不注入判活时用 kill(pid, 0)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_ADDRESS_FILE,
  isProcessAlive,
  readHeadlessAddress,
  removeHeadlessAddress,
  secondInstanceVerdict,
  writeHeadlessAddress
} from '../headlessInstance'

const DESKTOP_LINE =
  'ShuviX headless: the ShuviX desktop app is already running for this user; quit it first, then start ShuviX headless'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shuvix-headless-instance-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const file = (): string => join(dir, HEADLESS_ADDRESS_FILE)
const tmpFiles = (where: string): string[] =>
  existsSync(where) ? readdirSync(where).filter((name) => name.endsWith('.tmp')) : []
const writeRaw = (text: string): void => writeFileSync(file(), text)

describe('HI-1 / HI-2 写', () => {
  it('HI-1 写 / 读来回；JSON + 换行；不留 .tmp；再写覆盖', () => {
    expect(HEADLESS_ADDRESS_FILE).toBe('headless.json')
    expect(writeHeadlessAddress(dir, { pid: 4242, urls: [] })).toBe(true)
    const first = readHeadlessAddress(dir)
    expect(first).toStrictEqual({ pid: 4242, urls: [] })
    expect('port' in (first as object)).toBe(false)
    expect(readFileSync(file(), 'utf8')).toBe(`${JSON.stringify({ pid: 4242, urls: [] })}\n`)
    expect(tmpFiles(dir)).toStrictEqual([])

    const full = { pid: 4242, port: 8123, urls: ['http://127.0.0.1:8123'] }
    expect(writeHeadlessAddress(dir, full)).toBe(true)
    expect(readHeadlessAddress(dir)).toStrictEqual(full)
    expect(readFileSync(file(), 'utf8')).toBe(`${JSON.stringify(full)}\n`)
    expect(tmpFiles(dir)).toStrictEqual([])
    expect(readdirSync(dir)).toStrictEqual(['headless.json'])
  })

  it('HI-2 写进不存在的目录 → false、不抛、不留 .tmp', () => {
    const missing = join(dir, 'nope', 'deeper')
    let ok: boolean | undefined
    expect(() => {
      ok = writeHeadlessAddress(missing, { pid: 1, urls: [] })
    }).not.toThrow()
    expect(ok).toBe(false)
    expect(existsSync(missing)).toBe(false)
    expect(tmpFiles(dir)).toStrictEqual([])
    expect(readdirSync(dir)).toStrictEqual([])
  })
})

describe('HI-3 读', () => {
  it('HI-3 文件缺失 / 不是 JSON → null', () => {
    expect(readHeadlessAddress(dir)).toBeNull()
    writeRaw('{not json')
    expect(readHeadlessAddress(dir)).toBeNull()
  })

  it('HI-3 形状不对 → null', () => {
    const bad: unknown[] = [
      null,
      [],
      'x',
      {},
      { pid: 0, urls: [] },
      { pid: -1, urls: [] },
      { pid: 1.5, urls: [] },
      { pid: '123', urls: [] },
      { pid: 2 ** 53, urls: [] },
      { pid: 10 },
      { pid: 10, urls: 'http://a:1' },
      { pid: 10, urls: ['http://a:1', 2] },
      { pid: 10, port: '8123', urls: [] },
      { pid: 10, port: 1.5, urls: [] }
    ]
    for (const value of bad) {
      writeRaw(JSON.stringify(value))
      expect(readHeadlessAddress(dir), JSON.stringify(value)).toBeNull()
    }
  })

  it('HI-3 多余的键丢掉', () => {
    writeRaw(JSON.stringify({ pid: 10, port: 8123, urls: ['http://a:1'], extra: true, x: 'y' }))
    expect(readHeadlessAddress(dir)).toStrictEqual({ pid: 10, port: 8123, urls: ['http://a:1'] })
  })
})

describe('HI-4 删', () => {
  it('HI-4 pid 对得上才删；别的 pid 留着；缺失不抛；坏文件留着', () => {
    writeHeadlessAddress(dir, { pid: 10, urls: [] })
    removeHeadlessAddress(dir, 11)
    expect(existsSync(file())).toBe(true)
    removeHeadlessAddress(dir, 10)
    expect(existsSync(file())).toBe(false)
    expect(() => removeHeadlessAddress(dir, 10)).not.toThrow()

    writeRaw('{corrupt')
    removeHeadlessAddress(dir, 10)
    expect(readFileSync(file(), 'utf8')).toBe('{corrupt')
  })
})

describe('HI-5 判活', () => {
  it('HI-5 自己活着；退出了的子进程不活', async () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const pid = child.pid!
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))
    // 退出之后 Node 已经收过它（waitpid），pid 不再存在
    expect(isProcessAlive(pid)).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('HI-5 pid 1（不归我们管：EPERM）算活', () => {
    expect(isProcessAlive(1)).toBe(true)
  })
})

describe('HI-6 secondInstanceVerdict', () => {
  const alive = (): boolean => true
  const dead = (): boolean => false

  it('HI-6 没有地址文件', () => {
    expect(secondInstanceVerdict({ wantsHeadless: false, address: null, alive })).toStrictEqual({
      exitCode: 0
    })
    expect(secondInstanceVerdict({ wantsHeadless: true, address: null, alive })).toStrictEqual({
      line: DESKTOP_LINE,
      exitCode: 1
    })
  })

  it('HI-6 地址文件在、pid 活着 → 打印它的地址（要不要无头都一样）', () => {
    const address = { pid: 10, urls: ['http://a:1'] }
    for (const wantsHeadless of [false, true]) {
      expect(secondInstanceVerdict({ wantsHeadless, address, alive })).toStrictEqual({
        line: 'ShuviX headless: already running — open one of: http://a:1/',
        exitCode: 0
      })
    }
    expect(
      secondInstanceVerdict({ wantsHeadless: true, address: { pid: 10, urls: [] }, alive })
    ).toStrictEqual({ line: 'ShuviX headless: already running (still starting)', exitCode: 0 })
  })

  it('HI-6 pid 死了 → 同没有地址文件', () => {
    const address = { pid: 10, urls: ['http://a:1'] }
    expect(secondInstanceVerdict({ wantsHeadless: true, address, alive: dead })).toStrictEqual({
      line: DESKTOP_LINE,
      exitCode: 1
    })
    expect(secondInstanceVerdict({ wantsHeadless: false, address, alive: dead })).toStrictEqual({
      exitCode: 0
    })
  })

  it('HI-6 锁的持有者不是它 → 桌面在跑；是它 → 无头那一支', () => {
    const address = { pid: 10, urls: ['http://a:1'] }
    expect(
      secondInstanceVerdict({ wantsHeadless: true, address, lockHolderPid: 99, alive })
    ).toStrictEqual({ line: DESKTOP_LINE, exitCode: 1 })
    expect(
      secondInstanceVerdict({ wantsHeadless: true, address, lockHolderPid: 10, alive })
    ).toStrictEqual({
      line: 'ShuviX headless: already running — open one of: http://a:1/',
      exitCode: 0
    })
  })

  it('HI-6 判活拿到地址里的 pid；不注入时用真的 kill(pid, 0)', () => {
    const spy = vi.fn(() => true)
    secondInstanceVerdict({ wantsHeadless: true, address: { pid: 1234, urls: [] }, alive: spy })
    expect(spy).toHaveBeenCalledWith(1234)

    expect(
      secondInstanceVerdict({
        wantsHeadless: true,
        address: { pid: process.pid, urls: ['http://a:1'] }
      })
    ).toStrictEqual({
      line: 'ShuviX headless: already running — open one of: http://a:1/',
      exitCode: 0
    })
  })
})
