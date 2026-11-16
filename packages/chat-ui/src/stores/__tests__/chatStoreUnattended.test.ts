/**
 * chatStore 里「这一轮无人值守」的那张表（`sessionUnattended`，docs/unattended-run-design.md §6）：头部的图标读它。
 * 只记 true；按会话 id 存，与哪条会话是当前会话无关。
 *
 *   CS-1 `setUnattended(id, true)`：写进去；再写一次引用不变（不触发重渲染）
 *   CS-2 `setUnattended(id, false)`：键删掉（不是存 false）；本来就没有 → 引用不变
 *   CS-3 `setUnattendedSessions`：整份换掉；同一组 id（换个顺序）→ 引用不变
 *   CS-4 带重复 id 的列表按集合比（长度相等不等于相同）
 *   CS-5 不是当前会话的也记着；切换当前会话、清当前会话都不动别的会话的键
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from '../chatStore'
import { resetStore } from '../../__tests__/support/views'

const table = (): Record<string, true> => useChatStore.getState().sessionUnattended
const api = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()

beforeEach(() => {
  resetStore('a')
  useChatStore.setState({ sessionUnattended: {} })
})

describe('setUnattended', () => {
  it('CS-1 true 写进去；重复写同一个值引用不变', () => {
    api().setUnattended('a', true)
    expect(table()).toStrictEqual({ a: true })
    const first = table()
    api().setUnattended('a', true)
    expect(table()).toBe(first)
  })

  it('CS-2 false：有 → 键删掉；没有 → 引用不变', () => {
    const empty = table()
    api().setUnattended('a', false)
    expect(table()).toBe(empty)

    api().setUnattended('a', true)
    api().setUnattended('b', true)
    api().setUnattended('a', false)
    expect(table()).toStrictEqual({ b: true })
    expect('a' in table()).toBe(false)
  })

  it('CS-2 别的会话的键不受影响，别的表也不动', () => {
    useChatStore.setState({ sessionAskCounts: { a: 2 } })
    const asks = api().sessionAskCounts
    api().setUnattended('b', true)
    api().setUnattended('a', true)
    api().setUnattended('b', false)
    expect(table()).toStrictEqual({ a: true })
    expect(api().sessionAskCounts).toBe(asks)
  })
})

describe('setUnattendedSessions', () => {
  it('CS-3 整份换掉；清空', () => {
    api().setUnattended('a', true)
    api().setUnattendedSessions(['b', 'c'])
    expect(table()).toStrictEqual({ b: true, c: true })
    api().setUnattendedSessions([])
    expect(table()).toStrictEqual({})
  })

  it('CS-3 同一组 id（顺序不同）→ 同一引用', () => {
    api().setUnattendedSessions(['a', 'b'])
    const first = table()
    api().setUnattendedSessions(['b', 'a'])
    expect(table()).toBe(first)
    api().setUnattendedSessions(['a', 'b'])
    expect(table()).toBe(first)
  })

  it('CS-3 空对空 → 同一引用', () => {
    const first = table()
    api().setUnattendedSessions([])
    expect(table()).toBe(first)
  })

  it('CS-4 带重复 id 的列表按集合比：[a, a] 换掉 {a, b}', () => {
    api().setUnattendedSessions(['a', 'b'])
    api().setUnattendedSessions(['a', 'a'])
    expect(table()).toStrictEqual({ a: true })
  })

  it('CS-4 重复 id 的列表与同一集合相等 → 引用不变', () => {
    api().setUnattendedSessions(['a'])
    const first = table()
    api().setUnattendedSessions(['a', 'a', 'a'])
    expect(table()).toBe(first)
  })

  it('CS-4 一样多但不是同一组 → 换掉', () => {
    api().setUnattendedSessions(['a', 'b'])
    api().setUnattendedSessions(['a', 'c'])
    expect(table()).toStrictEqual({ a: true, c: true })
  })
})

describe('CS-5 按会话 id 存，与当前会话无关', () => {
  it('不是当前会话的也记着；切换当前会话不动它', () => {
    api().setUnattended('bg', true)
    expect(api().activeSessionId).toBe('a')
    expect(table().bg).toBe(true)

    api().setActiveSessionId('other')
    expect(table()).toStrictEqual({ bg: true })
    api().setActiveSessionId(null)
    expect(table()).toStrictEqual({ bg: true })
    api().setActiveSessionId('bg')
    expect(table()).toStrictEqual({ bg: true })
  })
})
