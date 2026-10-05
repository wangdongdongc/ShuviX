/**
 * node:sqlite 实验特性警告的过滤（裁决 Q20）：只吞那一条，别的警告原样送达。
 *
 *   D10-09 SQLite 的那条在三种发法下（type 字串 / options 对象 / 名为 ExperimentalWarning 的 Error）都被吞掉；
 *   D10-10 别的警告一条不少、原样送达（Fetch 的实验警告、带 code 的弃用警告、普通 Warning、
 *          正文提到 SQLite 的弃用警告）；
 *   D10-11 装两次只包一层；拆掉之后 `process.emitWarning` 还原；
 *   D10-12 真进程：装上过滤再加载 node:sqlite，stderr 里没有那条、有别的；对照组（不装）有那条。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  installSqliteWarningFilter,
  isSqliteExperimentalWarning,
  sqliteWarningFilterInstalled,
  uninstallSqliteWarningFilterForTests
} from '../nodeWarnings'

const SQLITE_MESSAGE = 'SQLite is an experimental feature and might change at any time'

let received: Error[] = []
const onWarning = (warning: Error): void => void received.push(warning)

/** 等 process 'warning' 事件（Node 在 nextTick 上发）落定 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

beforeEach(() => {
  received = []
  process.on('warning', onWarning)
})

afterEach(() => {
  process.off('warning', onWarning)
  uninstallSqliteWarningFilterForTests()
})

describe('D10-09 SQLite 的实验特性警告被吞掉', () => {
  it('D10-09 三种发法都不送达', async () => {
    installSqliteWarningFilter()
    process.emitWarning(SQLITE_MESSAGE, 'ExperimentalWarning')
    process.emitWarning(SQLITE_MESSAGE, { type: 'ExperimentalWarning' })
    const error = new Error(SQLITE_MESSAGE)
    error.name = 'ExperimentalWarning'
    process.emitWarning(error)
    await tick()
    expect(received).toEqual([])
  })

  it('D10-09 判定函数：只认 ExperimentalWarning + 正文提到 SQLite', () => {
    expect(isSqliteExperimentalWarning(SQLITE_MESSAGE, 'ExperimentalWarning')).toBe(true)
    expect(isSqliteExperimentalWarning(SQLITE_MESSAGE, { type: 'ExperimentalWarning' })).toBe(true)
    expect(isSqliteExperimentalWarning(SQLITE_MESSAGE, 'DeprecationWarning')).toBe(false)
    expect(isSqliteExperimentalWarning(SQLITE_MESSAGE)).toBe(false)
    expect(isSqliteExperimentalWarning('Fetch is experimental', 'ExperimentalWarning')).toBe(false)
  })
})

describe('D10-10 别的警告原样送达', () => {
  it('D10-10 每条恰送达一次，名字 / 正文 / code 不变', async () => {
    installSqliteWarningFilter()
    process.emitWarning('The Fetch API is an experimental feature', 'ExperimentalWarning')
    process.emitWarning('Buffer() is deprecated', 'DeprecationWarning', 'DEP0005')
    process.emitWarning('plain warning')
    process.emitWarning('SQLite option x is deprecated', 'DeprecationWarning')
    await tick()
    expect(
      received.map((w) => [w.name, w.message, (w as Error & { code?: string }).code])
    ).toEqual([
      ['ExperimentalWarning', 'The Fetch API is an experimental feature', undefined],
      ['DeprecationWarning', 'Buffer() is deprecated', 'DEP0005'],
      ['Warning', 'plain warning', undefined],
      ['DeprecationWarning', 'SQLite option x is deprecated', undefined]
    ])
  })
})

describe('D10-11 幂等与还原', () => {
  it('D10-11 装两次：SQLite 照吞，别的恰送达一次；拆掉之后 emitWarning 还原', async () => {
    const original = process.emitWarning
    installSqliteWarningFilter()
    const wrapped = process.emitWarning
    installSqliteWarningFilter()
    expect(process.emitWarning).toBe(wrapped)
    expect(sqliteWarningFilterInstalled()).toBe(true)

    process.emitWarning(SQLITE_MESSAGE, 'ExperimentalWarning')
    process.emitWarning('other', 'Warning')
    await tick()
    expect(received.map((w) => w.message)).toEqual(['other'])

    uninstallSqliteWarningFilterForTests()
    expect(process.emitWarning).toBe(original)
    expect(sqliteWarningFilterInstalled()).toBe(false)
  })
})

describe('D10-12 真进程', () => {
  const modulePath = fileURLToPath(new URL('../nodeWarnings.ts', import.meta.url))

  function run(withFilter: boolean): string {
    const script = [
      withFilter
        ? `const m = await import(${JSON.stringify(modulePath)}); m.installSqliteWarningFilter();`
        : '',
      "await import('node:sqlite');",
      "process.emitWarning('The Fetch API is an experimental feature', 'ExperimentalWarning');"
    ].join('\n')
    const result = spawnSync(
      process.execPath,
      // TS 源码直接跑（类型擦除）；模块类型提示与类型擦除自己的警告与断言无关
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 20000 }
    )
    return result.stderr
  }

  it('D10-12 装上过滤：没有 SQLite 那条，有 Fetch 那条；对照组有 SQLite 那条', () => {
    const filtered = run(true)
    expect(filtered).not.toContain('SQLite is an experimental feature')
    expect(filtered).toContain('The Fetch API is an experimental feature')

    const control = run(false)
    expect(control).toContain('SQLite is an experimental feature')
  })
})
