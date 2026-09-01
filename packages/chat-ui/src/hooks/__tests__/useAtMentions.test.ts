/**
 * useAtMentions 的两个纯导出（A3 · @提及胶囊的匹配半边）：
 *
 *   - findActiveAt —— 「光标此刻在不在一次 @ 触发里」，弹层开合的唯一判据；
 *   - matchMentions —— 已登记引用在明文里的非重叠命中，胶囊镜像与发送替换共用。
 *
 * 只测纯函数导出，不建 hook 测试设施（renderHook/jsdom 都不引）——
 * 状态机部分由 e2e（specs/bots/at-mention.e2e.ts）在真实输入框里钉。
 * 语料偏 bot 提及（CJK 显示名 / 含空格显示名 / 近前缀身份键）：文件引用侧的
 * 老路径已有既有行为兜底，bot 侧的边界（CJK 连写、`@Shuvi`→`@Shuvi2` 续写降级）
 * 是本轮新增的语义。
 */
import { describe, it, expect } from 'vitest'
import { findActiveAt, matchMentions, type AtMention } from '../useAtMentions'

/** 一条已登记的 bot 提及（text 含前导 @；rel 走 `bot:` 名字空间） */
function botMention(name: string, displayName: string): AtMention {
  return {
    kind: 'bot',
    text: `@${displayName}`,
    rel: `bot:${name}`,
    base: displayName,
    botName: name
  }
}

describe('findActiveAt（B1）', () => {
  it('行首 @ 触发并回传 query', () => {
    expect(findActiveAt('@qui', 4)).toEqual({ at: 0, query: 'qui' })
    // 空 query（刚敲下 @）也算触发 —— 弹层此时列全员
    expect(findActiveAt('@', 1)).toEqual({ at: 0, query: '' })
  })

  it('空白后 @ 触发（词边界成立）', () => {
    expect(findActiveAt('大家好 @qui', 8)).toEqual({ at: 4, query: 'qui' })
    expect(findActiveAt('hello\n@sc', 9)).toEqual({ at: 6, query: 'sc' })
  })

  it('词中 @（email 形）不触发', () => {
    expect(findActiveAt('user@example', 12)).toBeNull()
    expect(findActiveAt('a@b', 3)).toBeNull()
  })

  it('@ 与光标间遇空白即中断', () => {
    // 光标已越过 `@qui ` 的空格 —— 触发早已结束，不得再把后面的词当 query
    expect(findActiveAt('@qui hello', 10)).toBeNull()
    expect(findActiveAt('@qui ', 5)).toBeNull()
  })
})

describe('matchMentions —— CJK 语流边界（B2）', () => {
  it('登记 `@侦察兵` 后 `@侦察兵帮我看看` 命中（CJK 连写放行，后界不要求空白）', () => {
    const m = botMention('scout', '侦察兵')
    const hits = matchMentions('@侦察兵帮我看看', [m])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ start: 0, end: 4 })
    expect(hits[0].mention).toBe(m)
  })

  it('`@Shuvi` 续写成 `@Shuvi2` → 后界破坏，降级为普通文字（零命中）', () => {
    const m = botMention('shuvi', 'Shuvi')
    expect(matchMentions('@Shuvi2', [m])).toEqual([])
    // 前后各摆一个完好命中，确认破坏只波及被续写的那一处
    const hits = matchMentions('@Shuvi 和 @Shuvi2', [m])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ start: 0, end: 6 })
  })
})

describe('matchMentions —— 前界与长 key 优先（B3）', () => {
  it('前界不满足（@ 前是词字符）不命中', () => {
    const m = botMention('shuvi', 'Shuvi')
    expect(matchMentions('mail@Shuvi ok', [m])).toEqual([])
  })

  it('`@Shuvi` 与 `@Shuvi2` 并存：长 key 优先，各归各的引用', () => {
    const short = botMention('shuvi', 'Shuvi')
    const long = botMention('shuvi2', 'Shuvi2')
    const hits = matchMentions('@Shuvi2 @Shuvi', [short, long])
    expect(hits).toHaveLength(2)
    // 长 key 不被短 key 抢占：首个命中整段是 @Shuvi2
    expect(hits[0]).toMatchObject({ start: 0, end: 7 })
    expect(hits[0].mention).toBe(long)
    expect(hits[1]).toMatchObject({ start: 8, end: 14 })
    expect(hits[1].mention).toBe(short)
  })

  it('含空格显示名（`@😀 Bot`）按整体 key 命中单一区间', () => {
    const m = botMention('emoji-bot', '😀 Bot')
    const text = 'ping @😀 Bot now'
    const hits = matchMentions(text, [m])
    expect(hits).toHaveLength(1)
    const { start, end } = hits[0]
    expect(text.slice(start, end)).toBe('@😀 Bot')
    expect(hits[0].mention).toBe(m)
  })
})
