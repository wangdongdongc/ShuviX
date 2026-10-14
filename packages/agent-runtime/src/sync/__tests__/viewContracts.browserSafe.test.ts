/**
 * 视图同步的契约模块跑在浏览器里（桌面渲染进程、Chrome 侧边栏经 chat-ui 引它）：只许引 chord 的根入口与
 * typebox —— 没有 `node:` 内建、没有 chat-protocol 以外的包、没有 agent-runtime 的其它模块（会把 pi-* 拖进来）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'viewContracts.ts')

function importsOf(source: string): string[] {
  const out: string[] = []
  const re = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(re)) out.push(match[1] ?? match[2])
  return out
}

describe('viewContracts is browser-safe', () => {
  it('imports only the chord root entry and typebox', () => {
    const specs = importsOf(readFileSync(FILE, 'utf8'))
    expect(specs.length).toBeGreaterThan(0)
    expect(specs.filter((spec) => spec !== '@earendil-works/chord' && spec !== 'typebox')).toEqual(
      []
    )
  })
})
