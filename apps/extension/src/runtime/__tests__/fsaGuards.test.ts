/**
 * createFsaGuards 语义套件 —— 假 FileSystemPort（ guards 只用 stat），node 环境直跑。
 *
 * 与桌面 fileTime 同语义的对照钉板：recordRead 存「读取墙钟时刻」，
 * assertNotModifiedSinceRead 比对 port.stat 的 mtimeMs（50ms 容差）；
 * 文件已删（stat 为 null）放行；withFileLock 串行化同路径并发写。
 * （fsaPort.ts 顶部只有 type-only import，不在 node 下拖入 FSA/chrome.* 运行时。）
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { FileSystemPort, FileStat } from '@shuvix/agent-runtime'
import { createFsaGuards } from '../fsaPort'

const P = 'src/file.txt'

/** 假 port：guards 只调 stat，其余方法打到即失败 */
function makeFakePort(): { port: FileSystemPort; setStat(stat: FileStat | null): void } {
  let current: FileStat | null = { isFile: true, isDirectory: false, size: 1, mtimeMs: 0 }
  const port: FileSystemPort = {
    stat: () => Promise.resolve(current),
    readFile: () => {
      throw new Error('not used')
    },
    readTextLines: () => {
      throw new Error('not used')
    },
    readBytes: () => {
      throw new Error('not used')
    },
    writeFile: () => {
      throw new Error('not used')
    },
    readdir: () => {
      throw new Error('not used')
    }
  }
  return {
    port,
    setStat: (stat) => {
      current = stat
    }
  }
}

const fileStat = (mtimeMs: number): FileStat => ({
  isFile: true,
  isDirectory: false,
  size: 1,
  mtimeMs
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createFsaGuards', () => {
  it('EG-16: 无读取记录时 assert 抛 must-read', async () => {
    const { port } = makeFakePort()
    const guards = createFsaGuards(port)

    expect(guards.hasReadTime(P)).toBe(false)
    await expect(guards.assertNotModifiedSinceRead(P)).rejects.toThrow(
      `You must read file ${P} before overwriting it. Use the read tool first.`
    )
  })

  it('EG-16: recordRead 后 mtimeMs ≤ t+50 通过、> t+50 抛 modified（墙钟基线 + 容差边界）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { port, setStat } = makeFakePort()
    const guards = createFsaGuards(port)
    guards.recordRead(P)

    expect(guards.hasReadTime(P)).toBe(true)
    // 恰好 t 与 t+50：容差边界内，放行
    setStat(fileStat(1_000_000))
    await expect(guards.assertNotModifiedSinceRead(P)).resolves.toBeUndefined()
    setStat(fileStat(1_000_050))
    await expect(guards.assertNotModifiedSinceRead(P)).resolves.toBeUndefined()
    // t+51：越过容差，抛 modified-since
    setStat(fileStat(1_000_051))
    await expect(guards.assertNotModifiedSinceRead(P)).rejects.toThrow(
      /modified since it was last read/
    )
  })

  it('EG-16: stat 返回 null（文件已删）放行', async () => {
    const { port, setStat } = makeFakePort()
    const guards = createFsaGuards(port)
    guards.recordRead(P)

    setStat(null)
    await expect(guards.assertNotModifiedSinceRead(P)).resolves.toBeUndefined()
  })

  it('EG-16: withFileLock 串行化同一路径的并发写', async () => {
    const { port } = makeFakePort()
    const guards = createFsaGuards(port)
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const p1 = guards.withFileLock(P, async () => {
      order.push('first:in')
      await gate
      order.push('first:out')
    })
    const p2 = guards.withFileLock(P, async () => {
      order.push('second:in')
    })

    // 第一个仍占锁 → 第二个进不来
    await vi.waitFor(() => expect(order).toEqual(['first:in']))
    releaseFirst()
    await Promise.all([p1, p2])
    expect(order).toEqual(['first:in', 'first:out', 'second:in'])
  })
})
