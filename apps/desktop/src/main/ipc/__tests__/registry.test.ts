/**
 * `ipc/registry.ts` —— 主进程的通道注册表（server mode phase A §3），与传输无关的核。
 * 每条用例 `vi.resetModules()` 后重新导入（注册表有模块级状态）；传输是记录型替身：`serve` / `pushTo` / `broadcast`
 * 记下调用，`owns` 可配，`onClientGone` 回一个 spy 注销函数。
 *
 *   RG-1 defineHandler / defineListener → `listDefinitions()` 按定义顺序回 `{ kind: 'handle'|'listen', channel, fn }`，
 *        fn 原样；改动回来的数组不影响下一次调用
 *   RG-2 重复定义抛 `already defined`（含先 handler 后 listener 同一通道）；第一条留下；已挂的传输收不到重复的那条
 *   RG-3 定义 a、b → 挂 T1 → 定义 c：T1 按顺序恰好收到 a、b、c 各一次；另一个名字的传输挂上时收到已有的与之后的；
 *        同名的第二个传输抛 `already attached`、什么也收不到
 *   RG-4 `pushTo(c, 'ch', a, b)` → 认它的传输 `pushTo(c, 'ch', [a, b])`；`pushTo(c, 'ch')` → `[]`；只用第一个
 *        `owns(c)` 为真的传输；没有传输认它 / 一个传输都没有 → 什么也不做、不抛
 *   RG-5 `isClientAlive` 交给认它的传输；没有 → false
 *   RG-6 `onClientGone` 交给认它的传输并原样交回它的注销函数；没有 → 回调永不触发，回来的函数无害
 *   RG-7 `broadcastToClients('ch', p)` → 每个已挂传输的 `broadcast('ch', [p])`；一个都没有 → 什么也不发生
 *   RG-8 静态：registry.ts 不 import 'electron'（语法树：import / export-from / import() / require）
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RegistryModule from '../registry'
import type { ChannelDefinition, ClientRef, ClientTransport } from '../registry'

type Registry = typeof RegistryModule

let registry: Registry

beforeEach(async () => {
  vi.resetModules()
  registry = await import('../registry')
})

interface FakeTransport extends ClientTransport {
  readonly served: ChannelDefinition[]
  readonly pushes: Array<[ClientRef, string, readonly unknown[]]>
  readonly broadcasts: Array<[string, readonly unknown[]]>
  readonly goneCalls: Array<[ClientRef, () => void]>
  readonly disposers: Array<ReturnType<typeof vi.fn>>
  alive: boolean
}

function fakeTransport(
  name: string,
  owns: (client: ClientRef) => boolean = () => true
): FakeTransport {
  const t: FakeTransport = {
    name,
    served: [],
    pushes: [],
    broadcasts: [],
    goneCalls: [],
    disposers: [],
    alive: true,
    serve(definition) {
      t.served.push(definition)
    },
    owns,
    pushTo(client, channel, payload) {
      t.pushes.push([client, channel, payload])
    },
    isClientAlive() {
      return t.alive
    },
    onClientGone(client, callback) {
      t.goneCalls.push([client, callback])
      const dispose = vi.fn()
      t.disposers.push(dispose)
      return dispose
    },
    broadcast(channel, payload) {
      t.broadcasts.push([channel, payload])
    }
  }
  return t
}

const client = (id = 7): ClientRef => ({ kind: 'window', id: `ipc:${id}`, webContentsId: id })

describe('RG-1 定义 → listDefinitions', () => {
  it('RG-1 按定义顺序回 { kind, channel, fn }，fn 原样', () => {
    const h1 = (): number => 1
    const l1 = (): void => {}
    const h2 = async (): Promise<string> => 'x'
    registry.defineHandler('a:one', h1)
    registry.defineListener('a:two', l1)
    registry.defineHandler('a:three', h2)
    const defs = registry.listDefinitions()
    expect(defs).toEqual([
      { kind: 'handle', channel: 'a:one', fn: h1 },
      { kind: 'listen', channel: 'a:two', fn: l1 },
      { kind: 'handle', channel: 'a:three', fn: h2 }
    ])
    expect(defs[0].fn).toBe(h1)
    expect(defs[1].fn).toBe(l1)
    expect(defs[2].fn).toBe(h2)
  })

  it('RG-1 改动回来的数组不影响下一次调用', () => {
    registry.defineHandler('a:one', () => 1)
    const first = registry.listDefinitions() as ChannelDefinition[]
    first.pop()
    first.push({ kind: 'handle', channel: 'bogus', fn: () => 0 })
    const second = registry.listDefinitions()
    expect(second.map((d) => d.channel)).toEqual(['a:one'])
    expect(second).not.toBe(first)
  })

  it('RG-1 一条都没定义 → 空数组', () => {
    expect(registry.listDefinitions()).toEqual([])
  })
})

describe('RG-2 重复定义', () => {
  it('RG-2 handler 重复 / listener 重复 / 先 handler 后 listener —— 都抛 already defined，第一条留下', () => {
    const first = (): string => 'first'
    registry.defineHandler('dup:h', first)
    expect(() => registry.defineHandler('dup:h', () => 'second')).toThrow('already defined')
    expect(() => registry.defineListener('dup:h', () => {})).toThrow('already defined')

    const firstListener = (): void => {}
    registry.defineListener('dup:l', firstListener)
    expect(() => registry.defineListener('dup:l', () => {})).toThrow('already defined')
    expect(() => registry.defineHandler('dup:l', () => 1)).toThrow('already defined')

    expect(registry.listDefinitions()).toEqual([
      { kind: 'handle', channel: 'dup:h', fn: first },
      { kind: 'listen', channel: 'dup:l', fn: firstListener }
    ])
  })

  it('RG-2 已挂的传输收不到重复的那条', () => {
    const t = fakeTransport('t1')
    registry.attachTransport(t)
    const first = (): number => 1
    registry.defineHandler('dup:x', first)
    expect(() => registry.defineHandler('dup:x', () => 2)).toThrow('already defined')
    expect(() => registry.defineListener('dup:x', () => {})).toThrow('already defined')
    expect(t.served).toEqual([{ kind: 'handle', channel: 'dup:x', fn: first }])
  })
})

describe('RG-3 挂传输', () => {
  it('RG-3 先定义 a、b → 挂 T1 → 定义 c：T1 按顺序恰好收到 a、b、c 各一次', () => {
    const a = (): number => 1
    const b = (): void => {}
    const c = (): number => 3
    registry.defineHandler('ch:a', a)
    registry.defineListener('ch:b', b)
    const t1 = fakeTransport('t1')
    registry.attachTransport(t1)
    expect(t1.served.map((d) => d.channel)).toEqual(['ch:a', 'ch:b'])
    registry.defineHandler('ch:c', c)
    expect(t1.served).toEqual([
      { kind: 'handle', channel: 'ch:a', fn: a },
      { kind: 'listen', channel: 'ch:b', fn: b },
      { kind: 'handle', channel: 'ch:c', fn: c }
    ])

    // 另一个名字的传输：已有的全给，之后的随来随给
    const t2 = fakeTransport('t2')
    registry.attachTransport(t2)
    expect(t2.served.map((d) => d.channel)).toEqual(['ch:a', 'ch:b', 'ch:c'])
    registry.defineListener('ch:d', () => {})
    expect(t1.served.map((d) => d.channel)).toEqual(['ch:a', 'ch:b', 'ch:c', 'ch:d'])
    expect(t2.served.map((d) => d.channel)).toEqual(['ch:a', 'ch:b', 'ch:c', 'ch:d'])
  })

  it('RG-3 同名的第二个传输抛 already attached，什么也收不到（之前、之后的定义都不收）', () => {
    registry.defineHandler('ch:a', () => 1)
    registry.attachTransport(fakeTransport('ipc'))
    const again = fakeTransport('ipc')
    expect(() => registry.attachTransport(again)).toThrow('already attached')
    registry.defineHandler('ch:b', () => 2)
    expect(again.served).toEqual([])
    // 它也不参与推送 / 广播
    registry.broadcastToClients('ev', 1)
    registry.pushTo(client(), 'ev', 1)
    expect(again.broadcasts).toEqual([])
    expect(again.pushes).toEqual([])
  })
})

describe('RG-4 pushTo', () => {
  it('RG-4 载荷打包成数组交给认它的传输；没有载荷 → []', () => {
    const t = fakeTransport('t1')
    registry.attachTransport(t)
    const c = client()
    const a = { a: 1 }
    const b = { b: 2 }
    registry.pushTo(c, 'ch', a, b)
    registry.pushTo(c, 'ch')
    expect(t.pushes).toEqual([
      [c, 'ch', [a, b]],
      [c, 'ch', []]
    ])
    expect(t.pushes[0][0]).toBe(c)
    expect(t.pushes[0][2][0]).toBe(a)
  })

  it('RG-4 只用第一个 owns(c) 为真的传输', () => {
    const notMine = fakeTransport('not-mine', () => false)
    const firstOwner = fakeTransport('first-owner', () => true)
    const secondOwner = fakeTransport('second-owner', () => true)
    registry.attachTransport(notMine)
    registry.attachTransport(firstOwner)
    registry.attachTransport(secondOwner)
    registry.pushTo(client(), 'ch', 1)
    expect(notMine.pushes).toEqual([])
    expect(firstOwner.pushes).toHaveLength(1)
    expect(secondOwner.pushes).toEqual([])
  })

  it('RG-4 没有传输认它 / 一个传输都没有 → 什么也不做、不抛', () => {
    expect(() => registry.pushTo(client(), 'ch', 1)).not.toThrow()
    const t = fakeTransport('t1', () => false)
    registry.attachTransport(t)
    expect(() => registry.pushTo(client(), 'ch', 1)).not.toThrow()
    expect(t.pushes).toEqual([])
  })
})

describe('RG-5 isClientAlive', () => {
  it('RG-5 交给认它的传输；没有 → false', () => {
    expect(registry.isClientAlive(client())).toBe(false)
    const other = fakeTransport('other', () => false)
    registry.attachTransport(other)
    expect(registry.isClientAlive(client())).toBe(false)
    const owner = fakeTransport('owner')
    registry.attachTransport(owner)
    expect(registry.isClientAlive(client())).toBe(true)
    owner.alive = false
    expect(registry.isClientAlive(client())).toBe(false)
  })
})

describe('RG-6 onClientGone', () => {
  it('RG-6 交给认它的传输，原样交回它的注销函数', () => {
    const t = fakeTransport('t1')
    registry.attachTransport(t)
    const c = client()
    const cb = vi.fn()
    const dispose = registry.onClientGone(c, cb)
    expect(t.goneCalls).toEqual([[c, cb]])
    expect(t.goneCalls[0][1]).toBe(cb)
    expect(dispose).toBe(t.disposers[0])
    expect(cb).not.toHaveBeenCalled()
  })

  it('RG-6 没有传输认它 → 回调永不触发，回来的函数无害', () => {
    const cb = vi.fn()
    const dispose = registry.onClientGone(client(), cb)
    expect(typeof dispose).toBe('function')
    expect(() => dispose()).not.toThrow()
    expect(() => dispose()).not.toThrow()
    const t = fakeTransport('t1', () => false)
    registry.attachTransport(t)
    const dispose2 = registry.onClientGone(client(), cb)
    expect(() => dispose2()).not.toThrow()
    expect(t.goneCalls).toEqual([])
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('RG-7 broadcastToClients', () => {
  it("RG-7 每个已挂传输都收到 broadcast('ch', [p])（不管认不认谁）", () => {
    const t1 = fakeTransport('t1')
    const t2 = fakeTransport('t2', () => false)
    registry.attachTransport(t1)
    registry.attachTransport(t2)
    const p = { p: 1 }
    registry.broadcastToClients('ch', p)
    expect(t1.broadcasts).toEqual([['ch', [p]]])
    expect(t2.broadcasts).toEqual([['ch', [p]]])
    expect(t1.broadcasts[0][1][0]).toBe(p)
  })

  it('RG-7 一个传输都没有 → 什么也不发生', () => {
    expect(() => registry.broadcastToClients('ch', 1)).not.toThrow()
  })
})

describe('RG-8 registry.ts 不碰 Electron', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))

  /** 源码里引到的模块名：import / export-from / import() / require() */
  function importedModules(source: string): string[] {
    const sf = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const found: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        found.push(node.moduleSpecifier.text)
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      ) {
        found.push(node.moduleReference.expression.text)
      } else if (ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
        const [arg] = node.arguments
        if ((isDynamicImport || isRequire) && arg && ts.isStringLiteralLike(arg))
          found.push(arg.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return found
  }

  it('RG-8 扫描器自检：四种引法都认得出，注释与字符串里的不算', () => {
    expect(
      importedModules(
        [
          "import { app } from 'electron'",
          "export { x } from './a'",
          "const m = await import('electron/main')",
          "const r = require('b')",
          "import e = require('c')",
          "// import { ipcMain } from 'electron'",
          'const s = "from \'electron\'"'
        ].join('\n')
      )
    ).toEqual(['electron', './a', 'electron/main', 'b', 'c'])
  })

  it("RG-8 registry.ts 没有引 'electron'（任何子路径都不算）", () => {
    const modules = importedModules(readFileSync(resolve(HERE, '../registry.ts'), 'utf8'))
    expect(modules.filter((m) => m === 'electron' || m.startsWith('electron/'))).toEqual([])
  })
})
