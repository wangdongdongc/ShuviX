/**
 * bundlePaths —— bundle **内**的纯路径算术（不查会话、不查项目、不碰磁盘）。
 * 钉三张表：路径归一 / 越界判定、slug 派生、重名文件名派生。
 *
 * 「这条绝对路径属于哪个 bundle」不在这里 —— 那是宿主的事（桌面 services/knowledge/）。
 */
import { describe, it, expect } from 'vitest'
import { dedupeFileName, escapesBundle, normalizeBundlePath, slugify } from '../bundlePaths'

describe('normalizeBundlePath / escapesBundle', () => {
  it('SC-2 反斜杠 → /，剥 ./ 与前后斜杠，压缩重复分隔符；`..` 段越界，`..b` 只是个名字', () => {
    expect(normalizeBundlePath('./././a//b\\c.md/')).toBe('a/b/c.md')
    expect(escapesBundle('/a/../b.md')).toBe(true)
    expect(escapesBundle('a/..b.md')).toBe(false)
    expect(escapesBundle('..')).toBe(true)
    expect(escapesBundle('global/x.md')).toBe(false)
  })
})

describe('slugify', () => {
  it('SC-3 标点归 -、ASCII 小写、Unicode 字母保留、NFC 归一、截 60 无尾 -、空结果回落', () => {
    expect(slugify('Token Refresh: Pitfalls!!')).toBe('token-refresh-pitfalls')
    expect(slugify('登录态 丢失/修复')).toBe('登录态-丢失-修复')
    const composed = 'Café'
    const decomposed = 'Café'
    expect(slugify(decomposed)).toBe(slugify(composed))
    expect(slugify(composed)).toBe('café')
    const long = slugify(`${'a'.repeat(80)}-b`)
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long.endsWith('-')).toBe(false)
    expect(slugify('!!!')).toBe('entry')
    expect(slugify('!!!', 'project')).toBe('project')
  })
})

describe('dedupeFileName', () => {
  it('SC-4 重名追加 -2 / -3…；扩展名剥离大小写不敏感；不重名原样返回', () => {
    const taken = new Set(['a.md', 'a-2.md'])
    expect(dedupeFileName('a.md', (n) => taken.has(n))).toBe('a-3.md')
    expect(dedupeFileName('A.MD', (n) => n === 'A.MD')).toBe('A-2.md')
    expect(dedupeFileName('fresh.md', () => false)).toBe('fresh.md')
  })
})
