/**
 * siteGrants —— 用户随消息带上的标签页所在的站点（`chrome` 的站点门与导航门据此不再问）。
 *
 *   SG-1  记下之后按会话查得到；没记过的站点、别的会话都查不到；
 *   SG-2  站点为 undefined / 空串一律「没授权」（`browserSiteOf` 对没有站点的地址回 undefined，
 *         这一步不能被当成通配）；
 *   SG-3  同一站点记两次是幂等的；忘掉一条会话只清它自己的，之后可以重新记；
 *   SG-4  这里只按调用方给的写法比（规整是 `browserSiteOf` 的事，见 browser/site.ts）；
 *   SG-5  模块入口（services/chromeBridge）导出的就是这三个函数。
 *
 * 模块级的 Map 跨用例存活 —— 每个用例用自己的会话 id。
 */
import { describe, expect, it, vi } from 'vitest'
import { forgetSiteGrants, grantSite, isSiteGranted } from '../siteGrants'

// SG-5 要加载模块入口：它带进 server（electron-log）与 browserState / backend（sessionDao 开库）
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))
vi.mock('../../../dao/sessionDao', () => ({ sessionDao: { pickSettings: () => undefined } }))

let seq = 0
/** 每个用例自己的会话 id（授权表是进程级的） */
const sid = (): string => `sg-session-${++seq}`

describe('siteGrants', () => {
  it('SG-1 记下之后按会话查得到；没记过的站点、别的会话都查不到', () => {
    const a = sid()
    const b = sid()
    grantSite(a, 'bank.example')
    expect(isSiteGranted(a, 'bank.example')).toBe(true)
    expect(isSiteGranted(a, 'other.example')).toBe(false)
    expect(isSiteGranted(b, 'bank.example')).toBe(false)
    expect(isSiteGranted(sid(), 'bank.example')).toBe(false)
  })

  it.each<[string, string | undefined]>([
    ['undefined', undefined],
    ['空串', '']
  ])('SG-2 站点为 %s → 没授权（哪怕这条会话记过别的站点）', (_l, site) => {
    const a = sid()
    grantSite(a, 'bank.example')
    expect(isSiteGranted(a, site)).toBe(false)
    expect(isSiteGranted(sid(), site)).toBe(false)
  })

  it('SG-2 记一个空串也不会让空站点变成「已授权」', () => {
    const a = sid()
    grantSite(a, '')
    expect(isSiteGranted(a, '')).toBe(false)
    expect(isSiteGranted(a, undefined)).toBe(false)
  })

  it('SG-3 重复记同一站点幂等；forgetSiteGrants 只清这条会话，之后还能重新记', () => {
    const a = sid()
    const b = sid()
    grantSite(a, 'a.example')
    grantSite(a, 'a.example')
    grantSite(a, 'b.example')
    grantSite(b, 'a.example')

    forgetSiteGrants(a)
    expect(isSiteGranted(a, 'a.example')).toBe(false)
    expect(isSiteGranted(a, 'b.example')).toBe(false)
    // 别的会话不受牵连
    expect(isSiteGranted(b, 'a.example')).toBe(true)

    // 忘掉之后再记：从头开始
    grantSite(a, 'b.example')
    expect(isSiteGranted(a, 'b.example')).toBe(true)
    expect(isSiteGranted(a, 'a.example')).toBe(false)
  })

  it('SG-3 忘掉一条从没记过的会话不抛', () => {
    expect(() => forgetSiteGrants(sid())).not.toThrow()
  })

  it('SG-4 按调用方给的写法比：不做大小写、结尾点、端口的规整（那是 browserSiteOf 的事）', () => {
    const a = sid()
    grantSite(a, 'a.example')
    expect(isSiteGranted(a, 'A.EXAMPLE')).toBe(false)
    expect(isSiteGranted(a, 'a.example.')).toBe(false)
    expect(isSiteGranted(a, 'a.example:8080')).toBe(false)
    expect(isSiteGranted(a, 'sub.a.example')).toBe(false)
  })

  it('SG-5 模块入口（services/chromeBridge）导出的就是这三个函数', async () => {
    const entry = await import('../index')
    expect(entry.grantSite).toBe(grantSite)
    expect(entry.isSiteGranted).toBe(isSiteGranted)
    expect(entry.forgetSiteGrants).toBe(forgetSiteGrants)
  })
})
