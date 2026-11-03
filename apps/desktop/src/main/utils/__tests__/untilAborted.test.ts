/**
 * untilAborted —— 工具里的等待都要过它：signal 一落就不再等（回退先立闸门、再等工具结束，不竞争就互相等死）。
 *
 *   UA-1 值与拒绝原样穿过；落定之后 abort 监听摘掉，之后再中止不影响什么
 *   UA-2 等待中中止 → 以 `signal.reason` 拒绝（底下的事不管）；已经中止 → 当场拒绝
 *   UA-3 不再等之后底下的 promise 才失败 → 不变成未处理的拒绝（已中止进来的、等待中被中止的）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { untilAborted } from '../untilAborted'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** 过几轮宏任务：未处理拒绝事件在微任务清空之后才发 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('untilAborted', () => {
  it('UA-1 值原样穿过；之后 abort 监听摘掉，再中止什么也不发生', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')

    await expect(untilAborted(Promise.resolve('value'), controller.signal)).resolves.toBe('value')

    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(add.mock.calls[0][0]).toBe('abort')
    expect(remove.mock.calls[0][0]).toBe('abort')
    expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1])
    expect(() => controller.abort(new Error('late'))).not.toThrow()
  })

  it('UA-1 拒绝原样穿过（不是 signal 的 reason）；之后 abort 监听同样摘掉', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const failure = new Error('boom')

    await expect(untilAborted(Promise.reject(failure), controller.signal)).rejects.toBe(failure)

    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1])
  })

  it('UA-2 等待中中止 → 以 signal.reason 拒绝，不等底下的 promise', async () => {
    const controller = new AbortController()
    const work = deferred<string>()
    const reason = new Error('stop')
    const pending = untilAborted(work.promise, controller.signal)

    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    work.resolve('too late')
  })

  it('UA-2 已经中止 → 当场拒绝，不挂监听', async () => {
    const reason = new Error('already')
    const signal = AbortSignal.abort(reason)
    const add = vi.spyOn(signal, 'addEventListener')

    await expect(untilAborted(new Promise<string>(() => {}), signal)).rejects.toBe(reason)

    expect(add).not.toHaveBeenCalled()
  })

  describe('UA-3 不再等之后才失败', () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      seen.push(reason)
    }

    afterEach(() => {
      process.off('unhandledRejection', onUnhandled)
      seen.length = 0
    })

    it('UA-3 已经中止进来，底下的 promise 之后才拒绝 → 没有未处理的拒绝', async () => {
      process.on('unhandledRejection', onUnhandled)
      const work = deferred<string>()
      const reason = new Error('already')

      await expect(untilAborted(work.promise, AbortSignal.abort(reason))).rejects.toBe(reason)
      work.reject(new Error('later failure'))
      await settle()

      expect(seen).toEqual([])
    })

    it('UA-3 等待中被中止，底下的 promise 之后才拒绝 → 同样没有', async () => {
      process.on('unhandledRejection', onUnhandled)
      const controller = new AbortController()
      const work = deferred<string>()
      const reason = new Error('stop')
      const pending = untilAborted(work.promise, controller.signal)

      controller.abort(reason)
      await expect(pending).rejects.toBe(reason)
      work.reject(new Error('later failure'))
      await settle()

      expect(seen).toEqual([])
    })
  })
})
