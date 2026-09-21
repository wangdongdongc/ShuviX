/**
 * agent-runtime 的 TS 源码里不许出现原始控制字节（< 0x20，制表 / 换行 / 回车除外）。
 *
 * 写文件的工具与子代理不止一次把「反斜杠 u 四个零」这类转义落成了真的 NUL 字节。
 * prettier、eslint、tsc 都看不见它们，git 会把整个文件当成二进制来 diff，评审时一个字都读不到。
 * 源码里要这样的字符时，写 TS 的 \x 转义或 String.fromCharCode(...)：解析出来的值一样，文件仍是文本。
 *
 * 扫描器是逐字节的 —— 这台机器上 `grep -P '[\x00-\x08…]'` 认得 0x01–0x1F 却会漏掉 NUL，
 * 所以第一条用例先证明它认得 NUL。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

const SRC = join(__dirname, '..')

/** 允许的控制字节：制表、换行、回车 */
const ALLOWED = new Set([9, 10, 13])

/** 逐字节找控制字节，返回「行:列 0x..」（列按字节数） */
function controlBytes(bytes: Uint8Array): string[] {
  const hits: string[] = []
  let line = 1
  let col = 1
  for (const b of bytes) {
    if (b < 0x20 && !ALLOWED.has(b))
      hits.push(`${line}:${col} 0x${b.toString(16).padStart(2, '0')}`)
    if (b === 10) {
      line++
      col = 1
    } else {
      col++
    }
  }
  return hits
}

/** dir 下全部 .ts（不进 node_modules 与隐藏目录） */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('X3 源码里没有原始控制字节', () => {
  it('X3 扫描器认得 NUL 与其它控制字节，放过制表 / 换行 / 回车', () => {
    const sample = Uint8Array.from([0x61, 0x00, 0x09, 0x0a, 0x0d, 0x62, 0x1b, 0x0a, 0x7f, 0x20])
    expect(controlBytes(sample)).toEqual(['1:2 0x00', '2:3 0x1b'])
  })

  it('X3 packages/agent-runtime/src 下的每个 .ts 都是干净的文本', () => {
    const files = tsFiles(SRC)
    // 真扫到了东西（路径算错时不会空转变绿）
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(join(SRC, '__tests__', 'sourceBytes.test.ts'))
    const offenders = files.flatMap((file) =>
      controlBytes(readFileSync(file)).map((hit) => `${relative(SRC, file)}:${hit}`)
    )
    expect(offenders).toEqual([])
  })
})
