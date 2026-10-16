/**
 * 「这页正被哪个会话使用」圆点的颜色（sessionColor.ts）（CB-U15b）。
 *
 * 会话 id → Chrome 标签组的 9 种颜色之一（chat-protocol sessionColorFor）→ 一个 `light-dark(…)` 色值：
 * 9 种颜色各是各的值，而且都不是「开了请求拦截」时的琥珀色。
 */
import { describe, expect, it } from 'vitest'
import { CHROME_GROUP_COLORS, sessionColorFor } from '@shuvix/chat-protocol/chromeBridge'
import { INTERCEPTING_DOT_COLOR, sessionDotColor } from '../sessionColor'

/** 每种颜色找一个落在它上面的会话 id */
function idsPerColor(): Map<string, string> {
  const found = new Map<string, string>()
  for (let i = 0; found.size < CHROME_GROUP_COLORS.length && i < 10_000; i++) {
    const id = `session-${i}`
    const color = sessionColorFor(id)
    if (!found.has(color)) found.set(color, id)
  }
  return found
}

describe('圆点颜色（CB-U15b）', () => {
  it('CB-U15b 9 种颜色 → 9 个各不相同的 light-dark() 值，没有一个是拦截时的琥珀色', () => {
    const ids = idsPerColor()
    expect([...ids.keys()].sort()).toEqual([...CHROME_GROUP_COLORS].sort())
    const values = [...ids.values()].map(sessionDotColor)
    expect(values).toHaveLength(9)
    expect(new Set(values).size).toBe(9)
    for (const v of values) {
      expect(v.startsWith('light-dark(')).toBe(true)
      expect(v).not.toBe(INTERCEPTING_DOT_COLOR)
    }
    expect(INTERCEPTING_DOT_COLOR.startsWith('light-dark(')).toBe(true)
  })

  it('CB-U15b 同一会话恒同一个值；同色的两个会话同一个值', () => {
    expect(sessionDotColor('s1')).toBe(sessionDotColor('s1'))
    const byColor = new Map<string, string[]>()
    for (let i = 0; i < 200; i++) {
      const id = `s-${i}`
      const c = sessionColorFor(id)
      byColor.set(c, [...(byColor.get(c) ?? []), id])
    }
    for (const ids of byColor.values()) {
      expect(new Set(ids.map(sessionDotColor)).size).toBe(1)
    }
  })
})
