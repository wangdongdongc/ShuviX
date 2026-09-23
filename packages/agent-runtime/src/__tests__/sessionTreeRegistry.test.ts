/**
 * SessionTreeRegistry —— 进程内「sessionId → 共享 Session 实例」缓存的 LRU 名额。
 *
 * 契约：`maxUnpinned` 只数**未钉住**的槽。钉住的槽（有运行时的会话、宿主的内存会话）既不被逐出，
 * 也不占这个名额。曾经的实现拿缓存总数比上限：钉住的一多，每个刚打开的旁观树都会在打开的同一刻
 * 被逐出，下一个读者只好再开一份分叉实例 —— 这正是这个缓存要防的事，而且只有在「开着好几条会话」
 * 时才出现，单测不钉就没人看得见。
 *
 * 不碰 pi：open / create / exists 都是桩，Session 用带编号的假对象（只比同一性）。
 * 逐出按 lastUsed（Date.now）排序，所以时钟用假的、每步拨 1ms，顺序才是确定的。
 *
 *   R1  maxUnpinned 2 + 3 个钉住槽：打开 2 个未钉住的都留着（反复 get，open / create 各只调一次）
 *   R2  第 3 个未钉住的只逐出最久没用的那个未钉住槽
 *   R3  钉住的槽不管打开多少未钉住的都不被逐出
 *   R4  并发 get 共享一次 open；open 失败的槽不留在缓存里
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Session } from '@earendil-works/pi-agent-core'
import { createSessionTreeRegistry } from '../sessionTreeRegistry'

/** 假 Session：只用来比同一性，带上是谁、第几次构造的 */
type FakeTree = { id: string; via: 'open' | 'create'; n: number }

let serial = 0
const fake = (id: string, via: FakeTree['via']): Session =>
  ({ id, via, n: ++serial }) as unknown as Session

/** 拨一下时钟：两次操作的 lastUsed 必须能分出先后 */
const tick = (): void => {
  vi.setSystemTime(Date.now() + 1)
}

interface Harness {
  registry: ReturnType<typeof createSessionTreeRegistry>
  open: Mock<(id: string) => Promise<Session>>
  create: Mock<(id: string) => Promise<Session>>
  opens: (id: string) => number
  creates: (id: string) => number
}

function setup(options: { maxUnpinned?: number; pinned?: (id: string) => boolean } = {}): Harness {
  const opened = new Map<string, number>()
  const created = new Map<string, number>()
  const bump = (m: Map<string, number>, id: string): void => {
    m.set(id, (m.get(id) ?? 0) + 1)
  }
  const open = vi.fn(async (id: string) => {
    bump(opened, id)
    return fake(id, 'open')
  })
  const create = vi.fn(async (id: string) => {
    bump(created, id)
    return fake(id, 'create')
  })
  // 约定：`pin*` 与 `new*` 的存储不存在（走 create），其余都「已存在」（走 open）
  const exists = vi.fn((id: string) => !id.startsWith('pin') && !id.startsWith('new'))
  const registry = createSessionTreeRegistry({
    open,
    create,
    exists,
    ...(options.maxUnpinned !== undefined ? { maxUnpinned: options.maxUnpinned } : {})
  })
  registry.setPinned(options.pinned ?? ((id) => id.startsWith('pin')))
  const opens = (id: string): number => opened.get(id) ?? 0
  const creates = (id: string): number => created.get(id) ?? 0
  return { registry, open, create, opens, creates }
}

beforeEach(() => {
  serial = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LRU 名额只数未钉住的槽', () => {
  it('R1 3 个钉住槽 + 2 个未钉住（上限 2）：全都留着', async () => {
    const { registry, opens, creates } = setup({ maxUnpinned: 2 })
    const pins: Session[] = []
    for (const id of ['pin1', 'pin2', 'pin3']) {
      tick()
      pins.push(await registry.ensure(id))
    }
    tick()
    const u1 = await registry.get('u1')
    tick()
    const u2 = await registry.get('u2')

    // 反复取：都是缓存命中，没有第二次 open / create
    for (let round = 0; round < 3; round++) {
      tick()
      expect(await registry.get('u1')).toBe(u1)
      expect(await registry.ensure('u2')).toBe(u2)
      for (const [i, id] of ['pin1', 'pin2', 'pin3'].entries()) {
        expect(await registry.get(id)).toBe(pins[i])
      }
    }
    expect(opens('u1')).toBe(1)
    expect(opens('u2')).toBe(1)
    for (const id of ['pin1', 'pin2', 'pin3']) expect(creates(id)).toBe(1)
  })

  it('R2 第 3 个未钉住的只逐出最久没用的那个未钉住槽', async () => {
    const { registry, opens, creates } = setup({ maxUnpinned: 2 })
    // 钉住的槽最早建、之后再没碰过 —— 按 lastUsed 它是最旧的，照样不该被选中
    tick()
    const pin = await registry.ensure('pin1')
    tick()
    const u1 = await registry.get('u1')
    tick()
    await registry.get('u2')
    // 再用一次 u1：最久没用的变成 u2
    tick()
    await registry.get('u1')
    tick()
    const u3 = await registry.get('u3')

    // 先看留下来的（命中不建新槽，不会再触发逐出）
    expect(await registry.get('u1')).toBe(u1)
    expect(await registry.get('u3')).toBe(u3)
    expect(await registry.get('pin1')).toBe(pin)
    expect(opens('u1')).toBe(1)
    expect(opens('u3')).toBe(1)
    expect(creates('pin1')).toBe(1)

    // 再看被逐出的：u2 得重新 open
    tick()
    await registry.get('u2')
    expect(opens('u2')).toBe(2)
  })

  it('R3 钉住的槽不管打开多少未钉住的都不被逐出', async () => {
    const { registry, creates } = setup({ maxUnpinned: 2 })
    tick()
    const p1 = await registry.ensure('pin1')
    tick()
    const p2 = await registry.ensure('pin2')
    for (let i = 0; i < 20; i++) {
      tick()
      await registry.get(`u${i}`)
    }
    expect(await registry.get('pin1')).toBe(p1)
    expect(await registry.get('pin2')).toBe(p2)
    expect(creates('pin1')).toBe(1)
    expect(creates('pin2')).toBe(1)
  })

  it('R3 缺省上限（8）同样只数未钉住的：10 个钉住 + 8 个未钉住全留着', async () => {
    const { registry, opens } = setup()
    for (let i = 0; i < 10; i++) {
      tick()
      await registry.ensure(`pin${i}`)
    }
    const trees = new Map<string, Session>()
    for (let i = 0; i < 8; i++) {
      tick()
      trees.set(`u${i}`, (await registry.get(`u${i}`))!)
    }
    for (const [id, tree] of trees) {
      tick()
      expect(await registry.get(id)).toBe(tree)
    }
    for (const id of trees.keys()) expect(opens(id)).toBe(1)

    // 第 9 个未钉住的才开始逐出，而且逐出的是未钉住的最旧那个
    tick()
    await registry.get('u8')
    tick()
    await registry.get('u0')
    expect(opens('u0')).toBe(2)
  })
})

describe('R4 既有契约：在途去重与失败不缓存', () => {
  it('R4 并发 get 共享一次 open', async () => {
    const { registry, open } = setup()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    open.mockImplementationOnce(async (id: string) => {
      await gate
      return fake(id, 'open')
    })

    const all = Promise.all([registry.get('a'), registry.get('a'), registry.ensure('a')])
    release()
    const [s1, s2, s3] = await all
    expect(s1).not.toBeNull()
    expect(s1).toBe(s2)
    expect(s2).toBe(s3)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('R4 open 失败的槽不留在缓存里：下一次重新 open 并成功', async () => {
    const { registry, open } = setup()
    open.mockRejectedValueOnce(new Error('bad file'))

    await expect(registry.get('a')).rejects.toThrow('bad file')
    const retried = await registry.get('a')
    expect(retried).not.toBeNull()
    expect(open).toHaveBeenCalledTimes(2)
    // 成功之后才缓存
    expect(await registry.get('a')).toBe(retried)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('R4 create 失败同样不留槽（ensure 写路径）', async () => {
    const { registry, create } = setup()
    create.mockRejectedValueOnce(new Error('disk full'))

    await expect(registry.ensure('new1')).rejects.toThrow('disk full')
    const made = await registry.ensure('new1')
    expect(create).toHaveBeenCalledTimes(2)
    expect(await registry.ensure('new1')).toBe(made)
  })

  it('R4 存储不存在且未建过槽：get 回 null、不 open 也不 create', async () => {
    const { registry, open, create } = setup()
    expect(await registry.get('new-missing')).toBeNull()
    expect(open).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
})
