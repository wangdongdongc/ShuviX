/**
 * 内置浏览器的内部页面地址（shared/browserInternalPages.ts）—— 主进程与渲染端共用的那两个纯函数。
 *
 *   BS-U1  internalPageUrl('settings') 是 `shuvix://settings`；每个 INTERNAL_PAGES 的页名都能来回转换；
 *          internalPageOf 认大小写不同、两端空白、结尾的 `/`、带 `?…` / `#…` 的写法；
 *   BS-U2  不认的一律回 null：不认识的页名（含 Object 原型上的名字）、多一段路径、没有页名、少了 `//`、
 *          别的协议、协议名前多了字母、空串。
 */
import { describe, expect, it } from 'vitest'
import {
  INTERNAL_PAGES,
  INTERNAL_SCHEME,
  internalPageOf,
  internalPageUrl
} from '../browserInternalPages'

describe('内部页面地址（BS-U1）', () => {
  it("BS-U1 internalPageUrl('settings') === 'shuvix://settings'；协议名是 shuvix", () => {
    expect(INTERNAL_SCHEME).toBe('shuvix')
    expect(internalPageUrl('settings')).toBe('shuvix://settings')
  })

  it('BS-U1 每个 INTERNAL_PAGES：页名 → 地址 → 页名 原样回来', () => {
    expect(INTERNAL_PAGES.length).toBeGreaterThan(0)
    for (const page of INTERNAL_PAGES) {
      expect(internalPageOf(internalPageUrl(page))).toBe(page)
    }
  })

  it.each([
    'shuvix://settings',
    'shuvix://settings/',
    'SHUVIX://Settings',
    '  shuvix://settings  ',
    '\tshuvix://settings\n',
    'shuvix://settings?x=1',
    'shuvix://settings#privacy',
    'shuvix://settings/?a#b'
  ])('BS-U1 %j → settings', (url) => {
    expect(internalPageOf(url)).toBe('settings')
  })
})

describe('不是内部页面（BS-U2）', () => {
  it.each([
    'shuvix://unknown',
    'shuvix://settings/privacy',
    'shuvix://toString',
    'shuvix://constructor',
    'shuvix://',
    'shuvix:settings',
    'chrome://settings',
    'https://settings',
    'xshuvix://settings',
    'about:blank',
    ''
  ])('BS-U2 %j → null', (url) => {
    expect(internalPageOf(url)).toBeNull()
  })
})
