/**
 * 「详情」那一层在浏览器历史里的记号（mobile/detailHistory.ts，纯函数）。
 *
 * 契约：详情首页那一条的 state 带 `shuvixMobileDetail: 'index'`，某一段的子页带那一段的名字；这两条照样带着
 * 对话页（与会话页第二层）的记号。`detailPageOf` 读出是哪一页（不是详情的条目、认不得的值 → null），
 * `detailDepthOf` 是它在对话页那一条上面第几层（0 / 1 / 2）—— 关对话页时要一起退掉这么多条。
 * 子页那一条还可以带 `shuvixMobileDetailDirect: true`：它是从对话页直接推入的（空对话页的入口行），下面没有
 * 首页那一条，所以只算 1 层。这个记号只在子页上、只在值恰好是 `true` 时算数。
 *
 *   DH-1  记号的名字
 *   DH-2  首页
 *   DH-3  五个子页
 *   DH-4  别的记号不碍事
 *   DH-5  不是详情的条目
 *   DH-6  认不得 / 形状不对的值
 *   DH-7  state 不是对象也不抛
 *   DH-8  直接推入的记号的名字
 *   DH-9  直接推入的子页：1 层
 *   DH-10 没有记号 / false：2 层
 *   DH-11 首页带着记号也不算
 *   DH-12 没有详情记号、认不得的详情值
 *   DH-14 不是布尔 true 的值
 *   DH-15 下面各层的记号不碍事
 *   DH-16 state 不是对象也不抛
 */
import { describe, expect, it } from 'vitest'
import {
  DETAIL_DIRECT_MARK,
  DETAIL_HISTORY_MARK,
  detailDepthOf,
  detailDirectOf,
  detailPageOf
} from '../detailHistory'

const SECTIONS = ['extensions', 'knowledge', 'paths', 'sessions', 'widgets'] as const

describe('detailHistory', () => {
  it('DH-1 the mark name is fixed', () => {
    expect(DETAIL_HISTORY_MARK).toBe('shuvixMobileDetail')
  })

  it('DH-2 the index page is read from a state', () => {
    const state = { [DETAIL_HISTORY_MARK]: 'index' }
    expect(detailPageOf(state)).toBe('index')
    expect(detailDepthOf(state)).toBe(1)
  })

  it.each(['extensions', 'knowledge', 'paths', 'sessions', 'widgets'] as const)(
    'DH-3 the section page %s is read from a state',
    (section) => {
      const state = { [DETAIL_HISTORY_MARK]: section }
      expect(detailPageOf(state)).toBe(section)
      expect(detailDepthOf(state)).toBe(2)
    }
  )

  it('DH-4 the marks of the layers below do not disturb it', () => {
    const state = { shuvixMobileChat: true, shuvixMobileScope: true, shuvixMobileDetail: 'paths' }
    expect(detailPageOf(state)).toBe('paths')
    expect(detailDepthOf(state)).toBe(2)
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
    ['a chat entry', { shuvixMobileChat: true }]
  ])('DH-5 %s is not a detail entry', (_label, state) => {
    expect(detailPageOf(state)).toBeNull()
    expect(detailDepthOf(state)).toBe(0)
  })

  it.each<[string, unknown]>([
    ['true', true],
    ['1', 1],
    ['an empty string', ''],
    ['a capitalised section', 'Paths'],
    ['a padded page', 'index '],
    ['an unknown word', 'bogus'],
    ['an array', ['paths']],
    ['an object', {}]
  ])('DH-6 %s as the mark value is rejected', (_label, value) => {
    const state = { shuvixMobileChat: true, [DETAIL_HISTORY_MARK]: value }
    expect(detailPageOf(state)).toBeNull()
    expect(detailDepthOf(state)).toBe(0)
  })

  it.each<[string, unknown]>([
    ['a string', 'x'],
    ['a number', 5],
    ['a boolean', true]
  ])('DH-7 a state that is %s does not throw', (_label, state) => {
    expect(detailPageOf(state)).toBeNull()
    expect(detailDepthOf(state)).toBe(0)
  })

  it('DH-8 the direct mark name is fixed', () => {
    expect(DETAIL_DIRECT_MARK).toBe('shuvixMobileDetailDirect')
  })

  it.each(SECTIONS)('DH-9 a section %s pushed directly is one layer above the chat', (section) => {
    const state = { [DETAIL_HISTORY_MARK]: section, [DETAIL_DIRECT_MARK]: true }
    expect(detailDirectOf(state)).toBe(true)
    expect(detailDepthOf(state)).toBe(1)
    expect(detailPageOf(state)).toBe(section)
  })

  it.each(SECTIONS)(
    'DH-10 a section %s without the mark, or with false, is two layers',
    (section) => {
      for (const state of [
        { [DETAIL_HISTORY_MARK]: section },
        { [DETAIL_HISTORY_MARK]: section, [DETAIL_DIRECT_MARK]: false }
      ]) {
        expect(detailDirectOf(state)).toBe(false)
        expect(detailDepthOf(state)).toBe(2)
        expect(detailPageOf(state)).toBe(section)
      }
    }
  )

  it('DH-11 the index is never direct', () => {
    const state = { [DETAIL_HISTORY_MARK]: 'index', [DETAIL_DIRECT_MARK]: true }
    expect(detailDirectOf(state)).toBe(false)
    expect(detailDepthOf(state)).toBe(1)
  })

  it('DH-12 the direct mark without a detail mark means nothing', () => {
    const state = { shuvixMobileChat: true, [DETAIL_DIRECT_MARK]: true }
    expect(detailDirectOf(state)).toBe(false)
    expect(detailDepthOf(state)).toBe(0)
  })

  it('DH-13 the direct mark beside an unknown detail value means nothing', () => {
    const state = { [DETAIL_HISTORY_MARK]: 'bogus', [DETAIL_DIRECT_MARK]: true }
    expect(detailDirectOf(state)).toBe(false)
    expect(detailDepthOf(state)).toBe(0)
  })

  it.each<[string, unknown]>([
    ["'true'", 'true'],
    ['1', 1],
    ['an object', {}],
    ['an array', []],
    ['null', null]
  ])('DH-14 %s as the direct value is not direct', (_label, value) => {
    const state = { [DETAIL_HISTORY_MARK]: 'paths', [DETAIL_DIRECT_MARK]: value }
    expect(detailDirectOf(state)).toBe(false)
    expect(detailDepthOf(state)).toBe(2)
  })

  it.each(SECTIONS)('DH-15 the marks of the layers below do not disturb a direct %s', (section) => {
    const state = {
      shuvixMobileChat: true,
      shuvixMobileScope: true,
      shuvixSettingsDepth: 1,
      [DETAIL_HISTORY_MARK]: section,
      [DETAIL_DIRECT_MARK]: true
    }
    expect(detailDirectOf(state)).toBe(true)
    expect(detailDepthOf(state)).toBe(1)
    expect(detailPageOf(state)).toBe(section)
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['a number', 5]
  ])('DH-16 a state that is %s is not direct and does not throw', (_label, state) => {
    expect(detailDirectOf(state)).toBe(false)
  })
})
