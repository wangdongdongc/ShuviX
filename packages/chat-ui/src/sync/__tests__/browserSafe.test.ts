/**
 * P3-08-11（静态）—— 视图同步客户端跑在浏览器里（桌面渲染进程、Chrome 侧边栏）：`sync/**` 与两个钩子
 * 只引 chord 的根入口 / `/context`、chat-protocol、React，以及 chat-ui 自己的模块；没有 `node:` 内建，
 * 没有 agent-runtime（它是主进程的）。
 *
 * 解读（设计稿的字面是「只引 chord 与 chat-protocol」）：钩子必须引 React 与 store，所以白名单再放进
 * `react` 与包内相对路径；禁止项不变。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', '..')

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : filesUnder(full)
    return /\.(ts|tsx)$/.test(name) ? [full] : []
  })
}

const SOURCES = [
  ...filesUnder(join(SRC, 'sync')),
  join(SRC, 'hooks', 'useSessionView.ts'),
  join(SRC, 'hooks', 'useAgentView.ts')
]

function importsOf(source: string): string[] {
  const out: string[] = []
  const re = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of source.matchAll(re)) out.push(match[1] ?? match[2])
  return out
}

const ALLOWED = (spec: string): boolean =>
  spec === '@earendil-works/chord' ||
  spec === '@earendil-works/chord/context' ||
  spec.startsWith('@shuvix/chat-protocol/') ||
  spec === 'react' ||
  spec.startsWith('./') ||
  spec.startsWith('../')

describe('P3-08-11 视图同步客户端是浏览器安全的', () => {
  it('扫到了文件（不在空集上恒真）', () => {
    expect(SOURCES.map((f) => relative(SRC, f)).sort()).toEqual(
      expect.arrayContaining(['sync/syncClient.ts', 'hooks/useSessionView.ts', 'hooks/useAgentView.ts'])
    )
  })

  it.each(SOURCES.map((f) => [relative(SRC, f), f]))('%s 只引白名单里的模块', (_name, file) => {
    const specs = importsOf(readFileSync(file, 'utf8'))
    expect(specs.length).toBeGreaterThan(0)
    const offenders = specs.filter((spec) => !ALLOWED(spec))
    expect(offenders).toEqual([])
    expect(specs.some((spec) => spec.startsWith('node:'))).toBe(false)
    expect(specs.some((spec) => spec.includes('agent-runtime'))).toBe(false)
  })
})
