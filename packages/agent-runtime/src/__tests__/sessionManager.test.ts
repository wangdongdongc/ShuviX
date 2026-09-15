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

/**
 * 「这条会话有运行时」的区间 —— `onCreated` 开区间、`onClosingChange(…, false)` 闭区间。
 *
 * 扩展能力勾选只在创建运行时那一刻读一次，区间内只读：后端写入口按 `tracked` 拒绝，前端只能
 * 靠 `agent_created` / `agent_closing` 两个事件（宿主由这两个回调广播）把输入框与会话设置切成
 * 只读。两边口径一旦分叉，就会出现「UI 可勾、后端拒写」或「UI 锁着、其实已经可写」—— 所以
 * 这里用「前端镜像」（只看事件日志折叠出的锁态）在每个落定的时刻去对 `tracked()`。
 */
describe('SessionManager 运行时区间事件（扩展能力只读态的来源）', () => {
  /**
   * 前端镜像：按事件日志折叠出锁态 —— 与 chat-ui 的 sessionAgentCreated / sessionClosing 同一套规则：
   * `created` → 有运行时；`closing:x` → 关停态 = x，x 为 false 时同时清掉「有运行时」；
   * 锁 = 有运行时 || 关停中。
   */
  function mirrorLocked(log: readonly string[]): boolean {
    let created = false
    let closing = false
    for (const entry of log) {
      if (entry === 'created') created = true
      else if (entry === 'closing:true') closing = true
      else if (entry === 'closing:false') {
        closing = false
        created = false
      }
    }
    return created || closing
  }

  it('EXT-U-1 onCreated 恰一次：实例绑上之后、ensure 交出它之前；已存在或并发 ensure 都不重复通知', async () => {
    const order: string[] = []
    let calls = 0
    const create = vi.fn(() => ({ id: ++calls }))
    let seenInside: { has: boolean; got: unknown } | undefined
    const onCreated = vi.fn((sid: string, _instance: { id: number }) => {
      order.push('created')
      // 回调里就能拿到实例：宿主据此广播时，写入口的 tracked 判据早已成立
      seenInside = { has: mgr.has(sid), got: mgr.get(sid) }
    })
    const mgr = new SessionManager<{ id: number }>({ create, onCreated })

    const inst = await mgr.ensure('s1').then((v) => {
      order.push('resolved')
      return v
    })
    expect(inst).toEqual({ id: 1 })
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(onCreated.mock.calls[0]).toEqual(['s1', inst])
    expect(onCreated.mock.calls[0][1]).toBe(inst)
    expect(seenInside?.has).toBe(true)
    expect(seenInside?.got).toBe(inst)
    expect(order).toEqual(['created', 'resolved'])

    // 实例已存在：再 ensure 既不重建也不再通知
    expect(await mgr.ensure('s1')).toBe(inst)
    expect(onCreated).toHaveBeenCalledTimes(1)

    // 新会话并发两次 ensure：共享同一次创建，只通知一次
    const [a, b] = await Promise.all([mgr.ensure('s2'), mgr.ensure('s2')])
    expect(a).toBe(b)
    expect(create).toHaveBeenCalledTimes(2)
    expect(onCreated.mock.calls.filter((c) => c[0] === 's2')).toHaveLength(1)
  })

  it('EXT-U-2 没建出实例不通知、不留痕；通知自己抛错不影响实例', async () => {
    // (a) create 回 undefined（会话不存在）：没有运行时，区间根本没开始
    const onCreatedA = vi.fn()
    const none = new SessionManager<string>({ create: () => undefined, onCreated: onCreatedA })
    expect(await none.ensure('s1')).toBeUndefined()
    expect(onCreatedA).not.toHaveBeenCalled()
    expect(none.tracked('s1')).toBe(false)

    // (b) create reject：ensure 照样 reject，之后不再 tracked —— 一次失败的创建不能把勾选永久锁死
    const onCreatedB = vi.fn()
    const create = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('构造炸了'))
      .mockResolvedValueOnce('inst')
    const flaky = new SessionManager<string>({ create, onCreated: onCreatedB })
    await expect(flaky.ensure('s1')).rejects.toThrow('构造炸了')
    expect(onCreatedB).not.toHaveBeenCalled()
    expect(flaky.tracked('s1')).toBe(false)
    expect(await flaky.ensure('s1')).toBe('inst')
    expect(create).toHaveBeenCalledTimes(2)
    expect(onCreatedB).toHaveBeenCalledTimes(1)

    // (c) onCreated 抛错只算通知失败：实例照常交出、照常绑着
    const loud = new SessionManager<string>({
      create: () => 'inst',
      onCreated: () => {
        throw new Error('广播炸了')
      }
    })
    expect(await loud.ensure('s1')).toBe('inst')
    expect(loud.has('s1')).toBe(true)
  })

  it('EXT-U-3 创建 → 关停 → 重建：事件日志折叠出的锁态在每个落定时刻都等于 tracked()', async () => {
    const born = deferred<{ id: number }>()
    const gate = deferred()
    const log: string[] = []
    let calls = 0
    const mgr = new SessionManager<{ id: number }>({
      create: () => (++calls === 1 ? born.promise : { id: calls }),
      dispose: () => gate.promise,
      onCreated: () => log.push('created'),
      onClosingChange: (_sid, closing) => log.push(`closing:${closing}`)
    })

    // ① 创建在途：ensure 同步登记，写入口从这一刻起就该拒绝（此时前端还没收到任何事件，
    //    靠的是 agent.init 的 created = tracked 打底）
    const p = mgr.ensure('s1')
    expect(mgr.tracked('s1')).toBe(true)
    expect(mgr.has('s1')).toBe(false)
    expect(log).toEqual([])

    // ② 出生
    born.resolve({ id: 1 })
    await p
    expect(log).toEqual(['created'])
    expect(mgr.tracked('s1')).toBe(true)
    expect(mirrorLocked(log)).toBe(mgr.tracked('s1'))

    // ③ 关停在途：已摘牌（has 为假）但仍 tracked —— 前端据 closing:true 保持只读
    const r = mgr.remove('s1', 'invalidate')
    await flush()
    expect(log).toEqual(['created', 'closing:true'])
    expect(mgr.tracked('s1')).toBe(true)
    expect(mgr.has('s1')).toBe(false)
    expect(mirrorLocked(log)).toBe(mgr.tracked('s1'))

    // ④ 关停完毕：区间闭合，勾选重新可改
    gate.resolve()
    await r
    expect(log).toEqual(['created', 'closing:true', 'closing:false'])
    expect(mgr.tracked('s1')).toBe(false)
    expect(mirrorLocked(log)).toBe(mgr.tracked('s1'))

    // ⑤ 下一个运行时：新区间开始
    await mgr.ensure('s1')
    expect(log).toEqual(['created', 'closing:true', 'closing:false', 'created'])
    expect(mgr.tracked('s1')).toBe(true)
    expect(mirrorLocked(log)).toBe(mgr.tracked('s1'))
  })

  it('EXT-U-4 创建在途时被 remove：事件按 closing:true → created → closing:false 到达，最终镜像与 has 一致', async () => {
    // 时序陷阱：created 夹在 closing 的一对之间到达。前端若把 created 当成「此后一直有运行时」、
    // 或让 closing:false 只清关停态不清「有运行时」，这里就会停在错误的锁态上
    const born = deferred<{ id: number }>()
    const log: string[] = []
    let calls = 0
    const mgr = new SessionManager<{ id: number }>({
      create: () => (++calls === 1 ? born.promise : { id: calls }),
      dispose: () => undefined,
      onCreated: () => log.push('created'),
      onClosingChange: (_sid, closing) => log.push(`closing:${closing}`)
    })

    const e = mgr.ensure('s1')
    const r = mgr.remove('s1', 'invalidate')
    born.resolve({ id: 1 })
    await Promise.all([e, r])

    expect(log.slice(0, 3)).toEqual(['closing:true', 'created', 'closing:false'])
    // 是否重建出第二个实例不在这里钉；钉的是「前端看到的」与「此刻真有没有」对得上
    expect(mirrorLocked(log)).toBe(mgr.has('s1'))
  })
})
