/**
 * mdMetaStore —— md 扩展元数据的内存快照（表 md_attrs，设计 docs/md-metadata-design.md）。
 *
 * 钉三件事：
 *   - **fillFor 的筛选**：只要全局 scope（''）、`fm` 命名空间、问的那类文件白名单（MD_FM_FILL_KEYS）里的键；
 *     一个都没有回 undefined（不是 {}）；白名单为空的类型连库都不查（ST-1..4）；
 *   - **快照**：读多次只查一次 findAll；写（setFill / unsetFill）经 DAO 落库后让快照失效，下一次读重载（ST-5/6）；
 *   - setFill 写的是全局 scope 的 `fm` 行（不带 scope 键，交 DAO 的缺省 ''）。
 *
 * DAO 是替身（findAll 返回可变的行表，upsert / delete 是 spy）。store 是单例且带快照，所以每个用例
 * `vi.resetModules()` 之后重新动态 import，拿到一个干净的实例。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MdAttr } from '../../../dao/types'

const dao = vi.hoisted(() => ({
  rows: [] as MdAttr[],
  findAll: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn()
}))

vi.mock('../../../dao/mdAttrDao', () => ({
  mdAttrDao: {
    findAll: dao.findAll,
    upsert: dao.upsert,
    delete: dao.delete
  }
}))

type Store = (typeof import('../store'))['mdMetaStore']
let store: Store

const U = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'
const V = '0199d3a2-0000-7000-8000-000000000000'

const row = (over: Partial<MdAttr> & Pick<MdAttr, 'key' | 'value'>): MdAttr => ({
  objectId: U,
  scope: '',
  ns: 'fm',
  updatedAt: 1,
  ...over
})

beforeEach(async () => {
  dao.rows = []
  dao.findAll.mockReset().mockImplementation(() => dao.rows.map((r) => ({ ...r })))
  dao.upsert.mockReset()
  dao.delete.mockReset().mockReturnValue(true)
  vi.resetModules()
  ;({ mdMetaStore: store } = await import('../store'))
})

describe('mdMetaStore.fillFor —— 筛选', () => {
  it('ST-1 只留全局 scope + fm + agent 白名单的两键：tools（白名单外）/ meta 命名空间 / 项目 scope / 别的对象一律不进；值原样', () => {
    dao.rows = [
      row({ key: 'shuvix-model', value: 'p/m' }),
      row({ key: 'shuvix-thinking', value: 'high' }),
      row({ key: 'shuvix-tools', value: 'bash' }),
      row({ ns: 'meta', key: 'enabled', value: false }),
      row({ scope: 'project:p1', key: 'shuvix-model', value: 'proj/m' }),
      row({ objectId: V, key: 'shuvix-model', value: 'other/m' }),
      row({ objectId: V, key: 'shuvix-thinking', value: 'low' })
    ]
    expect(store.fillFor(U, 'agent')).toEqual({ 'shuvix-model': 'p/m', 'shuvix-thinking': 'high' })
  })

  it('ST-2 没有可用的行 → undefined（不是 {}）：空表一次、只有白名单外的行一次（换一个干净实例）', async () => {
    expect(store.fillFor(U, 'agent')).toBeUndefined()
    dao.rows = [row({ key: 'shuvix-tools', value: 'bash' })]
    vi.resetModules()
    const { mdMetaStore: fresh } = await import('../store')
    expect(fresh.fillFor(U, 'agent')).toBeUndefined()
  })

  it.each(['bot', 'hook', 'policy'] as const)(
    'ST-3 白名单为空的类型 %s → undefined，且根本不查库',
    (kind) => {
      dao.rows = [row({ key: 'shuvix-model', value: 'p/m' })]
      expect(store.fillFor(U, kind)).toBeUndefined()
      expect(dao.findAll).not.toHaveBeenCalled()
    }
  )

  it('ST-4 同一行：按 agent 问拿得到，按 hook 问拿不到（按「哪类文件在问」过滤，不按存的时候是哪类）', () => {
    dao.rows = [row({ key: 'shuvix-model', value: 'p/m' })]
    expect(store.fillFor(U, 'agent')).toEqual({ 'shuvix-model': 'p/m' })
    expect(store.fillFor(U, 'hook')).toBeUndefined()
  })
})

describe('mdMetaStore —— 快照与写入', () => {
  it('ST-5 读两次只查一次库；setFill → upsert（无 scope 键）并让快照失效，下一次读重查且看得到新值；unsetFill → delete、回 DAO 的布尔、同样失效', () => {
    dao.rows = [row({ key: 'shuvix-model', value: 'p/m' })]
    store.fillFor(U, 'agent')
    store.fillFor(V, 'agent')
    expect(dao.findAll).toHaveBeenCalledTimes(1)

    dao.upsert.mockImplementation((attr: { objectId: string; key: string; value: unknown }) => {
      dao.rows.push(row({ objectId: attr.objectId, key: attr.key, value: attr.value }))
    })
    store.setFill(U, 'shuvix-thinking', 'low')
    expect(dao.upsert).toHaveBeenCalledTimes(1)
    expect(dao.upsert).toHaveBeenCalledWith({
      objectId: U,
      ns: 'fm',
      key: 'shuvix-thinking',
      value: 'low'
    })
    expect(dao.upsert.mock.calls[0][0]).not.toHaveProperty('scope')
    expect(store.fillFor(U, 'agent')).toEqual({ 'shuvix-model': 'p/m', 'shuvix-thinking': 'low' })
    expect(dao.findAll).toHaveBeenCalledTimes(2)

    dao.delete.mockImplementation((key: { objectId: string; key: string }) => {
      const before = dao.rows.length
      dao.rows = dao.rows.filter((r) => !(r.objectId === key.objectId && r.key === key.key))
      return dao.rows.length < before
    })
    expect(store.unsetFill(U, 'shuvix-model')).toBe(true)
    expect(dao.delete).toHaveBeenCalledWith({ objectId: U, ns: 'fm', key: 'shuvix-model' })
    expect(store.fillFor(U, 'agent')).toEqual({ 'shuvix-thinking': 'low' })
    expect(dao.findAll).toHaveBeenCalledTimes(3)
  })

  it('ST-6 unsetFill 删空（DAO 回 false）也让快照失效；upsert 抛错原样往外抛', () => {
    store.fillFor(U, 'agent')
    expect(dao.findAll).toHaveBeenCalledTimes(1)
    dao.delete.mockReturnValue(false)
    expect(store.unsetFill(U, 'shuvix-model')).toBe(false)
    store.fillFor(U, 'agent')
    expect(dao.findAll).toHaveBeenCalledTimes(2)

    dao.upsert.mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => store.setFill(U, 'shuvix-model', 'p/m')).toThrow('disk full')
  })
})
