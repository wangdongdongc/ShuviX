/**
 * unattendedPages —— 没人在看、也不是 tab 的页面（read 工具的隐藏页面）的记号。
 * 分区上的 will-download 靠它认出这种页面（见 browserViewExternalOpen.test.ts 的 ST-U9c）。
 */
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { isUnattendedPage, markUnattendedPage } from '../unattendedPages'

const fakeWebContents = (): WebContents => ({}) as WebContents

describe('unattendedPages', () => {
  it('UP-1 标过的才算：别的页面不算', () => {
    const hidden = fakeWebContents()
    const tab = fakeWebContents()
    expect(isUnattendedPage(hidden)).toBe(false)
    markUnattendedPage(hidden)
    expect(isUnattendedPage(hidden)).toBe(true)
    expect(isUnattendedPage(tab)).toBe(false)
  })

  it('UP-2 没有页面（null / undefined）不算，也不抛', () => {
    expect(isUnattendedPage(null)).toBe(false)
    expect(isUnattendedPage(undefined)).toBe(false)
  })

  it('UP-3 标两次没事', () => {
    const hidden = fakeWebContents()
    markUnattendedPage(hidden)
    markUnattendedPage(hidden)
    expect(isUnattendedPage(hidden)).toBe(true)
  })
})
