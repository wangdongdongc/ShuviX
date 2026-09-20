/**
 * useAtMentions 的两个纯导出（A3 · @提及胶囊的匹配半边）：
 *
 *   - findActiveAt —— 「光标此刻在不在一次 @ 触发里」，弹层开合的唯一判据；
 *   - matchMentions —— 已登记引用在明文里的非重叠命中，胶囊镜像与发送替换共用。
 *
 * 只测纯函数导出，不建 hook 测试设施（renderHook/jsdom 都不引）——
 * 状态机部分由 e2e 在真实输入框里钉。
 * 语料刻意用 CJK 显示名 / 含空格名 / 近前缀名：匹配半边的边界（CJK 连写、
 * `@Shuvi`→`@Shuvi2` 续写降级）与引用指向什么无关，文件引用同样适用。
 */
import { describe, it, expect } from 'vitest'
import { buildMentionEntry, findActiveAt, matchMentions, type AtMention } from '../useAtMentions'
import type { AtSuggestionItem } from '../atMentionProviders'

/** 一条已登记的引用（text 含前导 @；rel 用一个不会撞上明文的路径） */
function mention(label: string): AtMention {
  return {
    text: `@${label}`,
    displayText: label,
    ref: { kind: 'file', rel: `docs/${label}.md`, base: label }
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

describe('findActiveAt —— 源前缀路由（B1b）', () => {
  const SOURCES = ['file', 'knowledge']

  it('`@源:query` 命中已注册源 → 路由该源，query 为冒号后文本', () => {
    expect(findActiveAt('@knowledge:配置', 13, SOURCES)).toEqual({
      at: 0,
      source: 'knowledge',
      query: '配置'
    })
    // 冒号后为空也算触发 —— 弹层此时列该源全员
    expect(findActiveAt('@knowledge:', 11, SOURCES)).toEqual({
      at: 0,
      source: 'knowledge',
      query: ''
    })
    expect(findActiveAt('看下 @file:src/a', 14, SOURCES)).toEqual({
      at: 3,
      source: 'file',
      query: 'src/a'
    })
  })

  it('前缀未注册 → 不路由，整体作为默认源 query', () => {
    expect(findActiveAt('@unknown:x', 10, SOURCES)).toEqual({ at: 0, query: 'unknown:x' })
  })

  it('无冒号 / 冒号在首字符 → 默认源（`@knowledge` 不是路由）', () => {
    expect(findActiveAt('@knowledge', 10, SOURCES)).toEqual({ at: 0, query: 'knowledge' })
    expect(findActiveAt('@:x', 3, SOURCES)).toEqual({ at: 0, query: ':x' })
  })

  it('空 sources（未传路由表）时含冒号文本一律默认源', () => {
    expect(findActiveAt('@knowledge:x', 12)).toEqual({ at: 0, query: 'knowledge:x' })
  })
})

describe('matchMentions —— CJK 语流边界（B2）', () => {
  it('登记 `@侦察兵` 后 `@侦察兵帮我看看` 命中（CJK 连写放行，后界不要求空白）', () => {
    const m = mention('侦察兵')
    const hits = matchMentions('@侦察兵帮我看看', [m])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ start: 0, end: 4 })
    expect(hits[0].mention).toBe(m)
  })

  it('`@Shuvi` 续写成 `@Shuvi2` → 后界破坏，降级为普通文字（零命中）', () => {
    const m = mention('Shuvi')
    expect(matchMentions('@Shuvi2', [m])).toEqual([])
    // 前后各摆一个完好命中，确认破坏只波及被续写的那一处
    const hits = matchMentions('@Shuvi 和 @Shuvi2', [m])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ start: 0, end: 6 })
  })
})

describe('matchMentions —— 前界与长 key 优先（B3）', () => {
  it('前界不满足（@ 前是词字符）不命中', () => {
    const m = mention('Shuvi')
    expect(matchMentions('mail@Shuvi ok', [m])).toEqual([])
  })

  it('`@Shuvi` 与 `@Shuvi2` 并存：长 key 优先，各归各的引用', () => {
    const short = mention('Shuvi')
    const long = mention('Shuvi2')
    const hits = matchMentions('@Shuvi2 @Shuvi', [short, long])
    expect(hits).toHaveLength(2)
    // 长 key 不被短 key 抢占：首个命中整段是 @Shuvi2
    expect(hits[0]).toMatchObject({ start: 0, end: 7 })
    expect(hits[0].mention).toBe(long)
    expect(hits[1]).toMatchObject({ start: 8, end: 14 })
    expect(hits[1].mention).toBe(short)
  })

  it('含空格显示名（`@😀 Bot`）按整体 key 命中单一区间', () => {
    const m = mention('😀 Bot')
    const text = 'ping @😀 Bot now'
    const hits = matchMentions(text, [m])
    expect(hits).toHaveLength(1)
    const { start, end } = hits[0]
    expect(text.slice(start, end)).toBe('@😀 Bot')
    expect(hits[0].mention).toBe(m)
  })
})

describe('buildMentionEntry —— 明文构造与消歧（B4）', () => {
  /** 一条知识库候选（标题 + 所属库；ref 用不同 entryPath 区分目标） */
  function knowledgeSuggestion(title: string, lib: string, entry = title): AtSuggestionItem {
    return {
      source: 'knowledge',
      label: title,
      detail: lib,
      displayText: `knowledge:${title}`,
      disambiguator: lib,
      ref: {
        kind: 'knowledge',
        entryPath: `knowledge/${lib}/${entry}.md`,
        baseName: lib,
        bundlePath: `/${entry}.md`,
        title
      }
    }
  }

  it('知识条目明文带源前缀：`@knowledge:<标题>`', () => {
    const entry = buildMentionEntry(knowledgeSuggestion('配置中心', 'notes'), [])
    expect(entry.text).toBe('@knowledge:配置中心')
    expect(entry.displayText).toBe('knowledge:配置中心')
  })

  it('明文撞上已登记的另一目标 → 自动加消歧后缀 `(<库名>)`', () => {
    const existing = buildMentionEntry(knowledgeSuggestion('配置中心', 'notes'), [])
    const second = buildMentionEntry(knowledgeSuggestion('配置中心', 'work'), [existing])
    expect(second.text).toBe('@knowledge:配置中心 (work)')
  })

  it('明文相同但指向同一目标 → 不加后缀（重复选中同一条目不产生新明文）', () => {
    const existing = buildMentionEntry(knowledgeSuggestion('配置中心', 'notes'), [])
    const again = buildMentionEntry(knowledgeSuggestion('配置中心', 'notes'), [existing])
    expect(again.text).toBe('@knowledge:配置中心')
  })

  it('文件候选不带消歧内容 → 撞名也维持现状明文（`@文件名`）', () => {
    const fileSuggestion: AtSuggestionItem = {
      source: 'file',
      label: 'a.ts',
      displayText: 'a.ts',
      ref: { kind: 'file', rel: 'src/b/a.ts', base: 'a.ts' }
    }
    const entry = buildMentionEntry(fileSuggestion, [mention('a.ts')])
    expect(entry.text).toBe('@a.ts')
  })
})
