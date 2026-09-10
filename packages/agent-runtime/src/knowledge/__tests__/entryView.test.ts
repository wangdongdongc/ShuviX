/**
 * entryView —— 概念 → 条目视图（chat-protocol `KnowledgeEntry`）的纯投影。
 *
 * 视图是侧栏 / 管理页一行所需：不带正文、fields、sources、resource，作用域按路径算、信任档按
 * `verified` 推、「核实仍当前」按 verified / generated 时序判、过期按 `stale_after` 对注入的
 * now 判。这里钉的是形状（不多不少 —— 多出来的键会顺着 IPC 流到渲染端）与四个派生字段接进
 * 视图后的判定表；scopeKindOfPath / isVerificationCurrent / isStaleAfter 各自的边角在它们自己的
 * 测试里，这里只验它们确实被接上、且对的是视图里的那个字段。
 */
import { describe, it, expect } from 'vitest'
import type { KnowledgeEntry } from '@shuvix/chat-protocol/knowledge'
import type { KnowledgeConcept } from '../conceptFile'
import { toKnowledgeEntry } from '../entryView'

const NOW = new Date('2026-09-10T12:00:00Z')

const concept = (overrides: Partial<KnowledgeConcept> = {}): KnowledgeConcept => ({
  path: 'global/a.md',
  type: 'Memory',
  title: 'A',
  description: 'da',
  tags: ['x'],
  status: 'stable',
  sources: [],
  verified: [],
  fields: {},
  body: 'body',
  ...overrides
})

const stamp = (by: string, at: string): { by: string; at: string } => ({ by, at })

describe('toKnowledgeEntry — 形状', () => {
  it('EV-1 只带一行所需的键：概念内部（body / fields / sources / resource / staleAfter）不外泄，无 generated 则没有 generatedAt / generatedBy；标量逐字复制，tags 按值相等但不是同一数组', () => {
    const c = concept({
      body: '# heading\n\nlong body',
      fields: { type: 'Memory', custom: 'kept' },
      sources: [{ resource: 'https://example.com' }],
      resource: 'shuvix://project/p1',
      staleAfter: '2999-12-31'
    })
    const entry = toKnowledgeEntry(c, NOW)

    expect(Object.keys(entry).sort()).toEqual([
      'description',
      'path',
      'scope',
      'stale',
      'status',
      'tags',
      'title',
      'trustTier',
      'type',
      'verifiedCurrent'
    ])
    expect('generatedAt' in entry).toBe(false)
    expect('generatedBy' in entry).toBe(false)

    expect(entry).toMatchObject({
      path: 'global/a.md',
      type: 'Memory',
      title: 'A',
      description: 'da',
      status: 'stable'
    })
    expect(entry.tags).toEqual(['x'])
    expect(entry.tags).not.toBe(c.tags)
  })

  it('EV-2 有 generated 章 → generatedAt / generatedBy 逐字复制', () => {
    const entry = toKnowledgeEntry(
      concept({ generated: stamp('agent:coding/gpt-5', '2026-09-01T00:00:00Z') }),
      NOW
    )
    expect(entry.generatedAt).toBe('2026-09-01T00:00:00Z')
    expect(entry.generatedBy).toBe('agent:coding/gpt-5')
  })
})

describe('toKnowledgeEntry — 派生字段', () => {
  it('EV-3 scope 按 path 派生：六个作用域目录各归其类，bundle 根文件与未知顶层目录为 null', () => {
    const table: Array<[string, KnowledgeEntry['scope']]> = [
      ['NOTES.md', null],
      ['global/a.md', 'global'],
      ['projects/acme/project.md', 'project'],
      ['projects/acme/sessions/2026-09-01-x.md', 'session'],
      ['sessions/x.md', 'session'],
      ['bots/helper/bot.md', 'bot'],
      ['wiki/topic/x.md', 'wiki'],
      ['raw/x.md', 'raw'],
      ['misc/x.md', null]
    ]
    for (const [path, scope] of table) {
      expect({ path, scope: toKnowledgeEntry(concept({ path }), NOW).scope }).toEqual({
        path,
        scope
      })
    }
  })

  it('EV-4 trustTier：verified 空 → unverified；只有 agent 章 → machine-confirmed；含 human: 章 → human-reviewed', () => {
    const at = '2026-09-01T00:00:00Z'
    const tier = (verified: KnowledgeConcept['verified']): KnowledgeEntry['trustTier'] =>
      toKnowledgeEntry(concept({ verified }), NOW).trustTier

    expect(tier([])).toBe('unverified')
    expect(tier([stamp('agent:x', at)])).toBe('machine-confirmed')
    expect(tier([stamp('agent:x', at), stamp('human:alice', at)])).toBe('human-reviewed')
  })

  it('EV-5 verifiedCurrent：未核实恒 false（有无 generated 都一样）；核实过且无 generated → true；最近 verified.at ≥ generated.at → true（含相等）、早于 → false；多章取最近的一章', () => {
    const g = (at: string): KnowledgeConcept['generated'] => stamp('agent:g', at)
    const v = (at: string): KnowledgeConcept['verified'][number] => stamp('human:alice', at)
    const current = (o: Partial<KnowledgeConcept>): boolean =>
      toKnowledgeEntry(concept(o), NOW).verifiedCurrent

    // (a) 未核实
    expect(current({ verified: [] })).toBe(false)
    expect(current({ verified: [], generated: g('2026-09-01T00:00:00Z') })).toBe(false)
    // (b) 核实过、从未被宿主盖过 generated
    expect(current({ verified: [v('2026-09-01T00:00:00Z')] })).toBe(true)
    // (c) 核实不早于生成（含同一时刻）
    expect(
      current({ verified: [v('2026-09-02T00:00:00Z')], generated: g('2026-09-01T00:00:00Z') })
    ).toBe(true)
    expect(
      current({ verified: [v('2026-09-01T00:00:00Z')], generated: g('2026-09-01T00:00:00Z') })
    ).toBe(true)
    // (d) 核实之后又被改写
    expect(
      current({ verified: [v('2026-09-01T00:00:00Z')], generated: g('2026-09-02T00:00:00Z') })
    ).toBe(false)
    // (e) 旧章在生成之前、新章在生成之后 → 以最近一章为准
    expect(
      current({
        verified: [v('2026-08-01T00:00:00Z'), v('2026-09-03T00:00:00Z')],
        generated: g('2026-09-02T00:00:00Z')
      })
    ).toBe(true)
  })

  it('EV-6 stale 对注入的 now 判：stale_after 当日 UTC 零点起算过期；缺省与畸形日期恒不过期', () => {
    const stale = (staleAfter: string | undefined, now: Date): boolean =>
      toKnowledgeEntry(concept({ staleAfter }), now).stale

    expect(stale('2026-09-10', new Date('2026-09-09T23:59:59Z'))).toBe(false)
    expect(stale('2026-09-10', new Date('2026-09-10T00:00:00Z'))).toBe(true)
    expect(stale(undefined, NOW)).toBe(false)
    // 畸形：斜杠日期、不存在的日期，以及带时间的 ISO 串 —— 现状是 stale_after 只认
    // YYYY-MM-DD，带时间的写法当作无效 → 不过期，而不是按那个时刻判（NOW 已在它之后）
    expect(stale('2026/09/10', NOW)).toBe(false)
    expect(stale('2026-02-30', NOW)).toBe(false)
    expect(stale('2026-09-01T00:00:00Z', NOW)).toBe(false)
  })
})
