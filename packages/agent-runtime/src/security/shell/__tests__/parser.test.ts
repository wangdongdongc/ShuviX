/**
 * 解析器生命周期 —— 必须独立文件：本文件调用 resetShellParserForTests() 直接改模块级单例，
 * vitest 默认按文件隔离模块状态，混进别的文件会把它们的 beforeAll 初始化掀掉。
 *
 * 这里钉的是三件事：未就绪时 facts 的**整体形状**（空集恒真的陷阱源头）、
 * init 的幂等与并发共享、以及失败后允许重试（否则一次坏字节会永久锁死解析能力）。
 */
import { describe, it, expect } from 'vitest'
import {
  analyzeShellCommand,
  initShellParser,
  isShellParserReady,
  resetShellParserForTests,
  MAX_NESTED_SHELL_DEPTH,
  MAX_SHELL_SOURCE_LENGTH
} from '../index'
import { loadShellParserWasmFromNodeModules } from '../nodeWasm'

/** 一份必然实例化失败的 wasm 字节 */
const GARBAGE = { runtime: new Uint8Array([0, 1, 2, 3]), grammar: new Uint8Array([4, 5]) }

async function ensureReady(): Promise<void> {
  if (!isShellParserReady()) await initShellParser(loadShellParserWasmFromNodeModules())
}

describe('解析器生命周期', () => {
  it('P1-1 未初始化：facts 整体为空壳，reason=not-initialized', () => {
    resetShellParserForTests()
    expect(isShellParserReady()).toBe(false)
    // 整对象断言而非逐字段：parsed=false 时的字段形状本身就是契约 ——
    // 只要有一个字段没被清空，上层的全称判断就会拿到「看起来有内容」的假事实
    expect(analyzeShellCommand('ls')).toEqual({
      source: 'ls',
      parsed: false,
      reason: 'not-initialized',
      errorSpans: [],
      wordOnly: false,
      wordOnlyCommands: [],
      literalCommands: [],
      dynamics: [],
      redirects: [],
      depthExceeded: false
    })
  })

  it('P1-2 并发调用共享同一个 in-flight Promise', async () => {
    resetShellParserForTests()
    const wasm = loadShellParserWasmFromNodeModules()
    const p1 = initShellParser(wasm)
    const p2 = initShellParser(wasm)
    // 同一引用 = 第二次调用没有重新实例化 wasm（语法在进程生命周期内固定）
    expect(p1).toBe(p2)
    await p1
    expect(isShellParserReady()).toBe(true)
  })

  it('P1-3 初始化失败后清掉 in-flight promise，允许换好字节重试', async () => {
    resetShellParserForTests()
    // 只断言 rejects，不断言错误全文：emscripten 的 abort 文案随版本变
    await expect(initShellParser(GARBAGE)).rejects.toThrow()
    expect(isShellParserReady()).toBe(false)
    await initShellParser(loadShellParserWasmFromNodeModules())
    expect(isShellParserReady()).toBe(true)
    expect(analyzeShellCommand('ls').wordOnly).toBe(true)
  })

  it('P1-4 已就绪后再喂坏字节：短路返回，不 reject 也不破坏现有解析器', async () => {
    await ensureReady()
    await expect(initShellParser(GARBAGE)).resolves.toBeUndefined()
    expect(analyzeShellCommand('ls -la').wordOnlyCommands).toEqual([['ls', '-la']])
  })

  it('P1-5 上限常量（U1/U2/L18 的锚点）', () => {
    expect(MAX_SHELL_SOURCE_LENGTH).toBe(10_000)
    expect(MAX_NESTED_SHELL_DEPTH).toBe(8)
  })
})
