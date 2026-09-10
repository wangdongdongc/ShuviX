/**
 * scopes —— 作用域 = 目录的纯路径算术（不查会话、不查项目）。
 * 钉三张表：作用域 ↔ 目录 ↔ 路径的双向对应、bundle 路径归一 / 越界判定、slug 与文件名派生。
 */
import { describe, it, expect } from 'vitest'
import {
  dedupeFileName,
  escapesBundle,
  isSessionScopePath,
  normalizeBundlePath,
  scopeDir,
  scopeLabel,
  scopeOfPath,
  sessionSummaryFileName,
  slugify,
  type KnowledgeScope
} from '../scopes'

describe('scopeDir ↔ scopeOfPath ↔ scopeLabel', () => {
  const SCOPES: [KnowledgeScope, string, string][] = [
    [{ kind: 'global' }, 'global', 'global'],
    [{ kind: 'project', projectSlug: 'acme' }, 'projects/acme', 'project acme'],
    [
      { kind: 'session', projectSlug: 'acme' },
      'projects/acme/sessions',
      'sessions of project acme'
    ],
    [{ kind: 'session' }, 'sessions', 'sessions'],
    [{ kind: 'bot', botName: 'alice' }, 'bots/alice', 'bot alice']
  ]

  it('SC-1 每种作用域的目录与人读标签', () => {
    for (const [scope, dir, label] of SCOPES) {
      expect(scopeDir(scope), JSON.stringify(scope)).toBe(dir)
      expect(scopeLabel(scope), JSON.stringify(scope)).toBe(label)
    }
  })

  it('SC-1 路径 → 作用域：根文件 / 目录本身 / 用户自建顶层为 null；会话目录路径本身算项目；前导斜杠与反斜杠容忍', () => {
    const table: [string, KnowledgeScope | null][] = [
      ['global/x.md', { kind: 'global' }],
      ['global', null],
      ['projects/acme/x.md', { kind: 'project', projectSlug: 'acme' }],
      ['projects/acme/sessions/2026-09-09-fix.md', { kind: 'session', projectSlug: 'acme' }],
      // 目录路径本身（3 段）落在项目作用域 —— 只有它下面的文件才是会话摘要
      ['projects/acme/sessions', { kind: 'project', projectSlug: 'acme' }],
      ['projects/acme', null],
      ['sessions/x.md', { kind: 'session' }],
      ['bots/alice/bot.md', { kind: 'bot', botName: 'alice' }],
      ['bots/alice', null],
      ['index.md', null],
      ['NOTES.md', null],
      // 用户自建的顶层目录不是保留作用域（`wiki` / `raw` 曾经是，已撤销 —— 它们现在
      // 和任何别的自建目录一样：照常扫描 / 索引 / 检索，只是宿主不认识它绑着谁）
      ['misc/x.md', null],
      ['wiki/auth/x.md', null],
      ['raw/2026-x/source.md', null],
      ['/global/x.md', { kind: 'global' }],
      ['global\\x.md', { kind: 'global' }]
    ]
    for (const [path, expected] of table) {
      expect(scopeOfPath(path), path).toEqual(expected)
    }
    // 无 slug 的会话作用域不带多余键
    expect(scopeOfPath('sessions/x.md')).not.toHaveProperty('projectSlug')
  })

  it('SC-1 isSessionScopePath 只对会话摘要目录下的文件为真', () => {
    expect(isSessionScopePath('projects/acme/sessions/2026-09-09-fix.md')).toBe(true)
    expect(isSessionScopePath('sessions/x.md')).toBe(true)
    for (const p of [
      'projects/acme/sessions',
      'projects/acme/x.md',
      'global/x.md',
      'bots/alice/bot.md',
      'index.md'
    ]) {
      expect(isSessionScopePath(p), p).toBe(false)
    }
  })
})

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

describe('sessionSummaryFileName / dedupeFileName', () => {
  it('SC-4 会话摘要文件名 = 日期-slug.md，空标题回落 session', () => {
    expect(sessionSummaryFileName('2026-09-09', 'Fix login')).toBe('2026-09-09-fix-login.md')
    expect(sessionSummaryFileName('2026-09-09', '')).toBe('2026-09-09-session.md')
  })

  it('SC-4 重名追加 -2 / -3…；扩展名剥离大小写不敏感；不重名原样返回', () => {
    const taken = new Set(['a.md', 'a-2.md'])
    expect(dedupeFileName('a.md', (n) => taken.has(n))).toBe('a-3.md')
    expect(dedupeFileName('A.MD', (n) => n === 'A.MD')).toBe('A-2.md')
    expect(dedupeFileName('fresh.md', () => false)).toBe('fresh.md')
  })
})
