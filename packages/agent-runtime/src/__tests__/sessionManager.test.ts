/**
 * SessionManager —— 「一个会话同一时刻只有一个运行时」这条不变式的回归测试。
 *
 * 为什么值得单独测：会话树只有一个 leaf 指针，两个运行时同时活着 = 两个 run 的消息
 * 交叉写进同一条分支，tool_use / tool_result 的配对当场作废，之后每一发请求都被 provider
 * 打回（实测报文 `tool call id bash:35 is not found`），会话永久卡死。这类损坏在 UI 上
 * 看不出来（消息都在，顺序也像那么回事），只有下一次请求才炸 —— 所以闸门必须在这一层守住。
 *
 * 用例都不碰 pi：`create` / `dispose` 是注入的，用可控的 deferred 模拟「关不掉的 run」。
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionManager } from '../sessionManager'

/** 手动控制落定时机的 Promise —— 用来模拟「abort 迟迟不返回」 */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** 让已排队的微任务跑完（断言「此刻还没发生」用） */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('SessionManager 运行时绑定', () => {
  it('SM-1: 旧运行时没关停完，ensure 不会造第二个', async () => {
    const gate = deferred()
    let created = 0
    const mgr = new SessionManager<{ id: number }>({
      create: () => ({ id: ++created }),
      dispose: () => gate.promise
    })

    const first = await mgr.ensure('s1')
    expect(first).toEqual({ id: 1 })

    const closing = mgr.remove('s1', 'invalidate')
    const next = mgr.ensure('s1')

    await flush()
    // 关停还卡着 —— 绝不能已经出生了第二个
    expect(created).toBe(1)
    expect(mgr.isClosing('s1')).toBe(true)

    gate.resolve()
    await closing
    expect(await next).toEqual({ id: 2 })
    expect(created).toBe(2)
  })

  it('SM-2: remove 返回的 Promise 落定 = dispose 已跑完（调用方可安全动会话树）', async () => {
    const gate = deferred()
    const order: string[] = []
    const mgr = new SessionManager<string>({
      create: () => 'inst',
      dispose: async () => {
        order.push('dispose:start')
        await gate.promise
        order.push('dispose:end')
      }
    })
    await mgr.ensure('s1')

    const closing = mgr.remove('s1').then(() => order.push('remove:resolved'))
    await flush()
    expect(order).toEqual(['dispose:start'])

    gate.resolve()
    await closing
    expect(order).toEqual(['dispose:start', 'dispose:end', 'remove:resolved'])
  })

  it('SM-3: 并发 remove 共享同一次关停，dispose 只跑一次', async () => {
    const gate = deferred()
    const dispose = vi.fn(() => gate.promise)
    const mgr = new SessionManager<string>({ create: () => 'inst', dispose })
    await mgr.ensure('s1')

    const a = mgr.remove('s1', 'invalidate')
    const b = mgr.remove('s1', 'destroy')
    gate.resolve()
    await Promise.all([a, b])

    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('SM-4: 创建在途时 remove —— 先等它出生再关，不留「已解绑却还活着」的孤儿', async () => {
    // 首个实例卡在 born 手里（模拟创建在途），之后的同步产出
    const born = deferred<{ id: number }>()
    let calls = 0
    const disposed: Array<{ id: number }> = []
    const mgr = new SessionManager<{ id: number }>({
      create: () => (++calls === 1 ? born.promise : { id: calls }),
      dispose: (_sid, inst) => {
        disposed.push(inst)
      }
    })

    const creating = mgr.ensure('s1')
    // 旧实现在这里 sessions.get() 拿到 undefined 就直接 return —— 新实例随后落进 map 成孤儿
    const closing = mgr.remove('s1', 'invalidate')
    born.resolve({ id: 1 })
    await closing

    // 在途那个实例被正常关停，而不是悄悄留在 map 里继续活着
    expect(disposed).toEqual([{ id: 1 }])
    // 等在 ensure 上的调用方拿到的是关停之后重建的那个（1 号已作废，交出去就是孤儿）
    expect(await creating).toEqual({ id: 2 })
  })

  it('SM-5: 关停期间 get/has 为空、isClosing 为真、tracked 仍为真（会话树不得被回收）', async () => {
    const gate = deferred()
    const mgr = new SessionManager<string>({ create: () => 'inst', dispose: () => gate.promise })
    await mgr.ensure('s1')

    const closing = mgr.remove('s1', 'invalidate')
    expect(mgr.get('s1')).toBeUndefined()
    expect(mgr.has('s1')).toBe(false)
    expect(mgr.isClosing('s1')).toBe(true)
    // 关停中的运行时可能还在写最后几条 entry —— 树实例必须继续钉住
    expect(mgr.tracked('s1')).toBe(true)

    gate.resolve()
    await closing
    expect(mgr.isClosing('s1')).toBe(false)
    expect(mgr.tracked('s1')).toBe(false)
  })

  it('SM-6: dispose 抛错不把会话永久钉死在关停态', async () => {
    let created = 0
    const mgr = new SessionManager<{ id: number }>({
      create: () => ({ id: ++created }),
      dispose: () => {
        throw new Error('清理炸了')
      }
    })
    await mgr.ensure('s1')

    await expect(mgr.remove('s1', 'invalidate')).resolves.toBeUndefined()
    expect(mgr.isClosing('s1')).toBe(false)
    expect(await mgr.ensure('s1')).toEqual({ id: 2 })
  })

  it('SM-7: onClosingChange 按 true → false 成对触发；无实例可关时不触发', async () => {
    const gate = deferred()
    const changes: boolean[] = []
    const mgr = new SessionManager<string>({
      create: () => 'inst',
      dispose: () => gate.promise,
      onClosingChange: (_sid, closing) => changes.push(closing)
    })

    await mgr.remove('nobody')
    expect(changes).toEqual([])

    await mgr.ensure('s1')
    const closing = mgr.remove('s1', 'invalidate')
    expect(changes).toEqual([true])

    gate.resolve()
    await closing
    expect(changes).toEqual([true, false])
  })

  it('SM-8: 关停 → 新建 → 再关停，能反复走（ensure 里的等待不会漏掉第二次关停）', async () => {
    let created = 0
    const gates = [deferred(), deferred()]
    let round = 0
    const mgr = new SessionManager<{ id: number }>({
      create: () => ({ id: ++created }),
      dispose: () => gates[round++].promise
    })

    await mgr.ensure('s1')
    const firstClose = mgr.remove('s1', 'invalidate')
    const pendingEnsure = mgr.ensure('s1')
    gates[0].resolve()
    await firstClose
    expect(await pendingEnsure).toEqual({ id: 2 })

    const secondClose = mgr.remove('s1', 'invalidate')
    const afterSecond = mgr.ensure('s1')
    await flush()
    expect(created).toBe(2)
    gates[1].resolve()
    await secondClose
    expect(await afterSecond).toEqual({ id: 3 })
  })
  it('SM-9: 关停的续跑排在 ensure 之后 —— 也不能把已作废的实例交出去', async () => {
    // 时序陷阱：born 落定时，ensure 的续跑先跑（它先 await 的），此刻 map 里躺着的
    // 仍是 1 号，只比身份会误判为「还绑着」。remove 是同步登记 closing 的，据此才拦得住。
    const born = deferred<{ id: number }>()
    let calls = 0
    const mgr = new SessionManager<{ id: number }>({
      create: () => (++calls === 1 ? born.promise : { id: calls }),
      dispose: () => undefined
    })

    const pendingEnsure = mgr.ensure('s1')
    const closing = mgr.remove('s1', 'invalidate')
    born.resolve({ id: 1 })
    await closing

    expect(await pendingEnsure).toEqual({ id: 2 })
    expect(mgr.get('s1')).toEqual({ id: 2 })
  })
})
