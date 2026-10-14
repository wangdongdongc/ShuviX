/**
 * web 客户端 phase D 的两个小仓库（纯模块，node 环境）：
 *
 *  - `webDirectoryPick`（页面里的目录浏览器与调用方之间）：
 *   PK-1 快照：`{id:1}` 不带 startPath 键；`{id:2, startPath:'/a'}`；空串当没给；同一次选择的快照是同一个对象（读几次都
 *        一样，变了才换）；挂起与结束都通知订阅者
 *   PK-2 第二次挂起时上一次按取消（null）结束，id 递增
 *   PK-3 过期的 settle 什么也不做（不 resolve、不通知）；settle(id, 路径) / settle(id, null) resolve 并清掉
 *   PK-4 一个订阅者抛错（console.error 记下）不影响别的；派发途中注销别人不出事
 *  - `webPathNotice`（「在文件管理器中打开」在浏览器里的那张卡片）：
 *   PN-1 showServerPath 每次 id 递增（同一个路径也是新的一条）；过期的 dismiss 什么也不做；dismiss 当前那条 → null；
 *        订阅 / 注销 / 派发途中注销 / 抛错的订阅者与 WN-1 同样的纪律
 *
 * 两个仓库都是模块级状态：每条用例 resetModules 后重新导入。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type PickStore = typeof import('../webDirectoryPick')
type NoticeStore = typeof import('../webPathNotice')

let pick: PickStore
let notice: NoticeStore

/** 让已经 resolve 的 then 跑完 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 记下一个 promise 的结果（还没结束 → 'pending'） */
function track<T>(promise: Promise<T>): { value: T | 'pending' } {
  const box: { value: T | 'pending' } = { value: 'pending' }
  void promise.then((value) => (box.value = value))
  return box
}

beforeEach(async () => {
  vi.resetModules()
  pick = await import('../webDirectoryPick')
  notice = await import('../webPathNotice')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PK webDirectoryPick', () => {
  it('PK-1 快照的形状；同一次选择是同一个对象；挂起与结束都通知', async () => {
    const listener = vi.fn()
    pick.subscribeDirectoryPick(listener)
    expect(pick.currentDirectoryPick()).toBeNull()

    void pick.requestDirectoryPick()
    const first = pick.currentDirectoryPick()
    expect(first).toStrictEqual({ id: 1 })
    expect('startPath' in first!).toBe(false)
    expect(pick.currentDirectoryPick()).toBe(first)
    expect(listener).toHaveBeenCalledTimes(1)

    void pick.requestDirectoryPick('/a')
    const second = pick.currentDirectoryPick()
    expect(second).toStrictEqual({ id: 2, startPath: '/a' })
    expect(second).not.toBe(first)
    expect(pick.currentDirectoryPick()).toBe(second)

    void pick.requestDirectoryPick('')
    const third = pick.currentDirectoryPick()
    expect(third).toStrictEqual({ id: 3 })
    expect('startPath' in third!).toBe(false)
    expect(listener).toHaveBeenCalledTimes(3)

    pick.settleDirectoryPick(3, '/done')
    expect(pick.currentDirectoryPick()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(4)
    await flush()
  })

  it('PK-2 第二次挂起：上一次以 null 结束，id 递增', async () => {
    const first = track(pick.requestDirectoryPick('/one'))
    const firstId = pick.currentDirectoryPick()!.id
    const second = track(pick.requestDirectoryPick('/two'))
    const secondId = pick.currentDirectoryPick()!.id
    await flush()
    expect(first.value).toBeNull()
    expect(second.value).toBe('pending')
    expect(secondId).toBe(firstId + 1)

    pick.settleDirectoryPick(secondId, '/chosen')
    await flush()
    expect(second.value).toBe('/chosen')
  })

  it('PK-3 过期的 settle 什么也不做；settle(id, 路径 / null) resolve 并清掉', async () => {
    const listener = vi.fn()
    const a = track(pick.requestDirectoryPick())
    const idA = pick.currentDirectoryPick()!.id
    pick.subscribeDirectoryPick(listener)

    pick.settleDirectoryPick(idA + 1, '/wrong')
    pick.settleDirectoryPick(idA - 1, '/wrong')
    await flush()
    expect(a.value).toBe('pending')
    expect(listener).not.toHaveBeenCalled()
    expect(pick.currentDirectoryPick()).toStrictEqual({ id: idA })

    pick.settleDirectoryPick(idA, '/picked')
    await flush()
    expect(a.value).toBe('/picked')
    expect(pick.currentDirectoryPick()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)

    // 已经结束的那一次再 settle：不再通知
    pick.settleDirectoryPick(idA, '/again')
    expect(listener).toHaveBeenCalledTimes(1)

    const b = track(pick.requestDirectoryPick())
    const idB = pick.currentDirectoryPick()!.id
    pick.settleDirectoryPick(idB, null)
    await flush()
    expect(b.value).toBeNull()
    expect(pick.currentDirectoryPick()).toBeNull()
  })

  it('PK-4 一个订阅者抛错不影响别的；派发途中注销别人不出事', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = vi.fn()
    const thrower = vi.fn(() => {
      throw new Error('listener broke')
    })
    const after = vi.fn()
    pick.subscribeDirectoryPick(before)
    pick.subscribeDirectoryPick(thrower)
    pick.subscribeDirectoryPick(after)

    expect(() => void pick.requestDirectoryPick()).not.toThrow()
    expect(before).toHaveBeenCalledTimes(1)
    expect(thrower).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)

    // 派发途中：c 被 b 注销 —— 这一轮不再调 c，d 照调
    let offC: () => void = () => {}
    const b = vi.fn(() => offC())
    const c = vi.fn()
    const d = vi.fn()
    pick.subscribeDirectoryPick(b)
    offC = pick.subscribeDirectoryPick(c)
    pick.subscribeDirectoryPick(d)
    expect(() => void pick.requestDirectoryPick()).not.toThrow()
    expect(b).toHaveBeenCalledTimes(1)
    expect(c).not.toHaveBeenCalled()
    expect(d).toHaveBeenCalledTimes(1)
  })
})

describe('PN-1 webPathNotice', () => {
  it('PN-1 id 递增（同一个路径也是新的一条）；过期的 dismiss 不动；dismiss 当前 → null', () => {
    const listener = vi.fn()
    notice.subscribeServerPath(listener)
    expect(notice.currentServerPath()).toBeNull()

    notice.showServerPath({ channel: 'app:open-folder', path: '/x', target: 'folder' })
    expect(notice.currentServerPath()).toStrictEqual({
      id: 1,
      channel: 'app:open-folder',
      path: '/x',
      target: 'folder'
    })
    notice.showServerPath({ channel: 'app:open-folder', path: '/x', target: 'folder' })
    expect(notice.currentServerPath()!.id).toBe(2)
    expect(listener).toHaveBeenCalledTimes(2)

    notice.dismissServerPath(1)
    expect(notice.currentServerPath()!.id).toBe(2)
    expect(listener).toHaveBeenCalledTimes(2)

    notice.dismissServerPath(2)
    expect(notice.currentServerPath()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(3)

    notice.dismissServerPath(2)
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('PN-1 订阅 / 注销；派发途中注销别人不打断这一轮；抛错的订阅者不影响别的', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = vi.fn()
    const offA = notice.subscribeServerPath(a)
    notice.showServerPath({ channel: 'c', path: '/1', target: 'file' })
    expect(a).toHaveBeenCalledTimes(1)
    offA()
    notice.showServerPath({ channel: 'c', path: '/2', target: 'file' })
    expect(a).toHaveBeenCalledTimes(1)

    let offC: () => void = () => {}
    const b = vi.fn(() => offC())
    const c = vi.fn()
    const thrower = vi.fn(() => {
      throw new Error('boom')
    })
    const d = vi.fn()
    notice.subscribeServerPath(b)
    offC = notice.subscribeServerPath(c)
    notice.subscribeServerPath(thrower)
    notice.subscribeServerPath(d)
    expect(() =>
      notice.showServerPath({ channel: 'c', path: '/3', target: 'folder' })
    ).not.toThrow()
    expect(b).toHaveBeenCalledTimes(1)
    expect(c).not.toHaveBeenCalled()
    expect(thrower).toHaveBeenCalledTimes(1)
    expect(d).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)

    notice.showServerPath({ channel: 'c', path: '/4', target: 'folder' })
    expect(b).toHaveBeenCalledTimes(2)
    expect(c).not.toHaveBeenCalled()
    expect(d).toHaveBeenCalledTimes(2)
  })
})
