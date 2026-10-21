/**
 * P3-02 · 纯投影：用户消息的来源（`metadata.origin`，2026-10-21）。投影拿到「条目 id → 来源」（`OriginByEntry`，
 * 投影器从 `SourceDoc` 解析好的，与显示侧车同一套落点），把它拷进那条用户消息的元数据；结构共享（`ProjectionMemo`）
 * 按值比较来源，与显示侧车同一口径。真流程（投影器、旁路、挂载）在 projector.origin.test.ts。
 *
 *   57 各种来源原样进 metadata.origin（与图片、内联 Token 并存）；交出的是拷贝；AgentView 一样；不给来源就没有这个键
 *   58 落在通知 / assistant / 不存在的条目上的来源：不起作用
 *   59 结构共享：新的 Map、值相等的新对象 → 整段历史沿用（built 0，同一个 messages 数组）
 *   60 结构共享：改一条的来源（换种类 / 去掉 / 只多一个 userAgent）→ 只重建那一条，其余原对象
 *   61 结构共享：memo 自己留一份 Map —— 调用方原地改同一个 Map，下一帧照样重建，不会误判为没变
 */
import type { InputOrigin } from '@shuvix/chat-protocol/types/inputOrigin'
import { describe, expect, it } from 'vitest'
import { ProjectionMemo, type OriginByEntry } from '../project'
import { A, IMAGE, IMAGE_META, K1, N, P, PA, U, display, text } from './support'

const LOCAL = { kind: 'local' } as const
const REMOTE = {
  kind: 'remote',
  clientId: 'ws:4',
  address: '192.168.1.20',
  userAgent: 'UA'
} as const
const REMOTE_NO_UA = { kind: 'remote', clientId: 'ws:4', address: '192.168.1.20' } as const
const CHROME = { kind: 'chrome', installId: 'inst-1' } as const
const TELEGRAM = { kind: 'telegram', botId: 'b1', userId: 'u1', chatId: 'c1' } as const
const PARENT = { kind: 'parent-session', sessionId: 'P1', title: '重构 parser' } as const
const OTHER = { kind: 'session', sessionId: 'X', title: 'T' } as const

/** 每次都新建的来源对象（投影器的旁路每次解析都交出新对象） */
const fresh = <T extends InputOrigin>(origin: T): T => structuredClone(origin)

const origins = (...pairs: [number, InputOrigin][]): OriginByEntry =>
  new Map(pairs.map(([id, origin]) => [id, fresh(origin)]))

/** 一段固定的转写：三条用户消息、两张卡、一条通知 */
const ENTRIES = [
  U(1, 'one', 10),
  A(2, [text('A2')], 11),
  U(3, [text('three'), IMAGE], 12),
  A(4, [text('A4')], 13),
  N(5, 'a notice'),
  U(6, 'six', 14)
]

describe('P3-02 · pure projector: input origins', () => {
  it('P3-02-57 metadata.origin per kind, next to images and inline tokens; a copy, not the input; AgentView agrees; no origins → no origin key anywhere', () => {
    const remote = fresh(REMOTE)
    const parent = fresh(PARENT)
    const entries = [U(3, [text('run PAYLOAD-K1 please'), IMAGE], 1000), U(4, 'p', 1001)]
    const inputs = {
      display: new Map([[3, display('run {{shuvixInlineToken:k1}} please', K1)]]),
      origins: new Map<number, InputOrigin>([
        [3, remote],
        [4, parent]
      ])
    }
    const view = P(entries, inputs)
    expect(view.messages.map((m) => m.metadata)).toStrictEqual([
      { images: [IMAGE_META], inlineTokens: K1, origin: REMOTE },
      { origin: PARENT }
    ])
    const projected = view.messages[0]!.metadata as { origin: { address: string } }
    expect(projected.origin).not.toBe(remote)
    projected.origin.address = 'MUTATED'
    expect(remote).toStrictEqual(REMOTE)
    expect(P(entries, inputs).messages[0]!.metadata).toMatchObject({ origin: REMOTE })

    const agent = PA(entries, inputs)
    expect(agent.messages).toStrictEqual(P(entries, inputs).messages)
    expect((agent.messages[1]!.metadata as { origin: object }).origin).not.toBe(parent)

    for (const bare of [P(entries, { display: inputs.display }), PA(entries)]) {
      expect(JSON.stringify(bare)).not.toContain('origin')
    }
  })

  it.each([
    ['local', LOCAL],
    ['remote', REMOTE],
    ['remote without a userAgent', REMOTE_NO_UA],
    ['chrome', CHROME],
    ['bare chrome', { kind: 'chrome' } as const],
    ['telegram', TELEGRAM],
    ['parent-session', PARENT],
    ['session', OTHER]
  ] as const)('P3-02-57 %s: the user message carries it verbatim', (_label, origin) => {
    const view = P([U(1, 'hi', 5)], { origins: origins([1, origin]) })
    expect(view.messages[0]!.metadata).toStrictEqual({ origin })
  })

  it('P3-02-58 origins keyed to a notice, an assistant or a missing entry are ignored; the notice keeps exactly its own metadata', () => {
    const view = P([N(5, 'n'), A(6, [text('a')]), U(7, 'u')], {
      origins: origins([5, REMOTE], [6, LOCAL], [99, PARENT])
    })
    expect(view.messages.map((m) => m.content)).toEqual(['n', 'a', 'u'])
    expect(view.messages[0]!.metadata).toStrictEqual({
      isSystemNotice: true,
      noticeKind: 'background'
    })
    expect(view.messages[2]!.metadata).toStrictEqual({})
    expect(JSON.stringify(view)).not.toContain('origin')
  })

  it('P3-02-59 memo: a new Map of deep-equal, freshly built origins reuses the whole history (built 0, the same messages array)', () => {
    const memo = new ProjectionMemo()
    const first = P(ENTRIES, { memo, origins: origins([1, LOCAL], [3, REMOTE], [6, PARENT]) })
    expect(memo.stats).toStrictEqual({ historyReused: false, built: 6, reused: 0 })
    const second = P(ENTRIES, { memo, origins: origins([1, LOCAL], [3, REMOTE], [6, PARENT]) })
    expect(memo.stats).toStrictEqual({ historyReused: true, built: 0, reused: 6 })
    expect(second.messages).toBe(first.messages)
  })

  it('P3-02-60 memo: changing one origin (local → remote), removing it, adding only a userAgent → exactly that message is rebuilt, every other one is the previous object', () => {
    const memo = new ProjectionMemo()
    const frames: [string, OriginByEntry, string][] = [
      ['local → remote', origins([1, REMOTE_NO_UA], [3, REMOTE_NO_UA], [6, PARENT]), '1'],
      ['removed', origins([3, REMOTE_NO_UA], [6, PARENT]), '1'],
      ['only a userAgent more', origins([3, REMOTE], [6, PARENT]), '3']
    ]
    let previous = P(ENTRIES, {
      memo,
      origins: origins([1, LOCAL], [3, REMOTE_NO_UA], [6, PARENT])
    })
    for (const [label, map, changed] of frames) {
      const next = P(ENTRIES, { memo, origins: map })
      expect(memo.stats, label).toStrictEqual({ historyReused: false, built: 1, reused: 5 })
      expect(next.messages).not.toBe(previous.messages)
      for (const [index, message] of next.messages.entries()) {
        if (message.id === changed) expect(message, label).not.toBe(previous.messages[index])
        else expect(message, `${label}: ${message.id}`).toBe(previous.messages[index])
      }
      const origin = (id: string): unknown =>
        (next.messages.find((m) => m.id === id)!.metadata as { origin?: unknown }).origin
      expect(origin(changed), label).toStrictEqual(map.get(Number(changed)))
      previous = next
    }
  })

  it('P3-02-61 memo keeps its own copy of the map: the caller mutating the SAME Map in place still rebuilds the next frame', () => {
    const memo = new ProjectionMemo()
    const map = new Map<number, InputOrigin>([[1, fresh(LOCAL)]])
    const first = P(ENTRIES, { memo, origins: map })
    map.set(1, fresh(TELEGRAM))
    const second = P(ENTRIES, { memo, origins: map })
    expect(memo.stats).toStrictEqual({ historyReused: false, built: 1, reused: 5 })
    expect(second.messages[0]).not.toBe(first.messages[0])
    expect(second.messages[0]!.metadata).toStrictEqual({ origin: TELEGRAM })
    map.delete(1)
    const third = P(ENTRIES, { memo, origins: map })
    expect(memo.stats).toStrictEqual({ historyReused: false, built: 1, reused: 5 })
    expect(third.messages[0]!.metadata).toStrictEqual({})
    // 同一个 Map、什么都没改 → 照样沿用
    const fourth = P(ENTRIES, { memo, origins: map })
    expect(memo.stats).toStrictEqual({ historyReused: true, built: 0, reused: 6 })
    expect(fourth.messages).toBe(third.messages)
  })
})
