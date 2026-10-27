/**
 * `WidgetRuntime`（主进程侧的组件宿主管理）—— `child_process.fork` 换成假的：返回一个 EventEmitter 做的假子进程
 * （send 带回调、kill 是 spy、exitCode、stdout / stderr 是 PassThrough），用例自己发 `{ready:true}`、应答、`exit`、`error`。
 * 计时器是假的；logger 的方法是 spy。
 *
 *   M-1 懒启动：构造时不 fork；第一个请求才 fork hostPath（execPath、ELECTRON_RUN_AS_NODE=1、serialization 'json'、带 ipc 的 stdio）；
 *       `{ready:true}` 之前不发请求、别的消息一概不理
 *   M-2 两个同时到的首个请求共用一次 fork；应答乱序也各回各的；不认识 / 不是数字的 id 不理
 *   M-3 错误应答 → WidgetRuntimeError（code + message）；call 的消息体 `{type:'call', …params, cpuMs: callCpuMs}`；
 *       CALL_CPU_MS < CALL_TIMEOUT_MS；超时：call / manifest = callTimeoutMs（manifest 的 cpuMs 10 秒），
 *       applySchema / query 60 秒，forget = callTimeoutMs + 10 秒；选项盖过缺省
 *   M-4 超过 callTimeoutMs：这次调用 timeout、SIGKILL 一次、别的在途请求 interrupted、running 为 false；下一个请求 fork 新的子进程
 *   M-5 ready 之后意外退出 → 在途请求 host_exited（说明里有 code 与 signal）；下一个请求重新拉起；
 *       已被换掉的旧子进程迟到的 exit 不连累新子进程的请求
 *   M-6 ready 之前退出 / 15 秒没 ready（也 SIGKILL）/ fork 抛错 / ready 之前的 error → host_unavailable，之后下一个请求重新拉起；
 *       send 回调报错 → 那个请求 host_unavailable、它的计时器清掉；ready 之后的 error 只记日志（不抛）
 *   M-7 没有宿主时 forget 不 fork；dispose → 在途请求 host_stopped、再 SIGKILL；子进程 stdout / stderr 的行进日志、没有空行
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  /** 发出去的消息 */
  readonly sent: Record<string, unknown>[] = []
  /** 设了就让下一次 send 的回调报这个错 */
  sendError: Error | null = null
  readonly send = vi.fn((message: Record<string, unknown>, cb?: (err: Error | null) => void) => {
    this.sent.push(message)
    const err = this.sendError
    this.sendError = null
    cb?.(err)
    return true
  })
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true)

  ready(): void {
    this.emit('message', { ready: true })
  }

  reply(id: unknown, result: unknown): void {
    this.emit('message', { id, ok: true, result })
  }

  fail(id: number, code: string, message: string): void {
    this.emit('message', { id, ok: false, error: { code, message } })
  }

  /** 最后发出的那条请求的 id */
  lastId(): number {
    return this.sent[this.sent.length - 1].id as number
  }
}

const mocks = vi.hoisted(() => ({
  fork: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('child_process', () => ({ fork: mocks.fork }))
vi.mock('../../../../logger', () => ({ createLogger: () => mocks.logger }))

import {
  CALL_CPU_MS,
  CALL_TIMEOUT_MS,
  WidgetRuntime,
  WidgetRuntimeError,
  type CallParams
} from '../widgetRuntime'

let children: FakeChild[] = []

const TARGET = { widgetId: 'w-one', dbPath: '/data/w-one/data.sqlite' }
const PARAMS: CallParams = {
  target: TARGET,
  bundlePath: '/data/w-one/api.js',
  bundleHash: 'abc',
  op: 'addBook',
  mode: 'write',
  args: { title: 'Dune' },
  caller: { kind: 'user', label: 'user' },
  dryRun: false
}

/** 让排着的 Promise 回调都跑完（假计时器不碰微任务） */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** 记下一个 Promise 落定的状态（不让拒绝变成未处理） */
function track<T>(p: Promise<T>): {
  promise: Promise<T>
  state: () => 'pending' | 'fulfilled' | 'rejected'
  value: () => T | undefined
  error: () => unknown
} {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  let value: T | undefined
  let error: unknown
  p.then(
    (v) => {
      state = 'fulfilled'
      value = v
    },
    (e) => {
      state = 'rejected'
      error = e
    }
  )
  return { promise: p, state: () => state, value: () => value, error: () => error }
}

function child(n = children.length - 1): FakeChild {
  const c = children[n]
  if (!c) throw new Error(`no child #${n}`)
  return c
}

/** 发一个请求、让宿主 ready，返回被追踪的 Promise 与那条请求的 id */
async function startedWith<T>(
  fire: () => Promise<T>
): Promise<{ t: ReturnType<typeof track<T>>; id: number; c: FakeChild }> {
  const t = track(fire())
  await flush()
  const c = child()
  if (c.listenerCount('message') > 0 && c.sent.length === 0) c.ready()
  await flush()
  return { t, id: c.lastId(), c }
}

beforeEach(() => {
  vi.useFakeTimers()
  children = []
  mocks.fork.mockReset().mockImplementation(() => {
    const c = new FakeChild()
    children.push(c)
    return c
  })
  for (const fn of Object.values(mocks.logger)) fn.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('M-1 懒启动', () => {
  it('M-1 构造时不 fork；第一个请求 fork；ready 之前不发、别的消息不理', async () => {
    const rt = new WidgetRuntime({ hostPath: '/app/widgetHost.js', execPath: '/app/Electron' })
    expect(mocks.fork).not.toHaveBeenCalled()
    expect(rt.running).toBe(false)

    const q = track(rt.query(TARGET, 'SELECT 1'))
    await flush()
    expect(mocks.fork).toHaveBeenCalledTimes(1)
    const [path, args, options] = mocks.fork.mock.calls[0] as [
      string,
      string[],
      {
        execPath: string
        env: Record<string, string>
        stdio: unknown[]
        serialization: string
      }
    ]
    expect(path).toBe('/app/widgetHost.js')
    expect(args).toEqual([])
    expect(options.execPath).toBe('/app/Electron')
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(options.serialization).toBe('json')
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe', 'ipc'])

    const c = child()
    // ready 之前：什么都不发，应答形状的消息、杂消息都不理
    c.emit('message', { id: 1, ok: true, result: 'too early' })
    c.emit('message', { hello: 'world' })
    c.emit('message', null)
    await flush()
    expect(c.send).not.toHaveBeenCalled()
    expect(rt.running).toBe(false)
    expect(q.state()).toBe('pending')

    c.ready()
    await flush()
    expect(rt.running).toBe(true)
    expect(c.sent).toEqual([{ type: 'query', target: TARGET, sql: 'SELECT 1', id: 1 }])
    c.reply(1, { output: 'OK' })
    await flush()
    expect(q.value()).toEqual({ output: 'OK' })
    rt.dispose()
  })

  it('M-1 缺省用当前进程的可执行文件、与主进程包同目录的 widgetHost.js', async () => {
    const rt = new WidgetRuntime()
    void track(rt.query(TARGET, 'SELECT 1'))
    await flush()
    const [path, , options] = mocks.fork.mock.calls[0] as [string, string[], { execPath: string }]
    expect(path.endsWith('widgetHost.js')).toBe(true)
    expect(options.execPath).toBe(process.execPath)
    rt.dispose()
  })
})

describe('M-2 共用一次启动、按 id 配对', () => {
  it('M-2 两个同时到的首个请求只 fork 一次；乱序应答各回各的；不认识的 id 不理', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    const a = track(rt.query(TARGET, 'SELECT 1'))
    const b = track(rt.query(TARGET, 'SELECT 2'))
    await flush()
    expect(mocks.fork).toHaveBeenCalledTimes(1)
    const c = child()
    c.ready()
    await flush()
    expect(c.sent.map((m) => [m.id, m.sql])).toEqual([
      [1, 'SELECT 1'],
      [2, 'SELECT 2']
    ])

    c.reply(99, { output: 'nobody' })
    c.reply('2', { output: 'string id' })
    c.emit('message', { ok: true, result: 'no id' })
    await flush()
    expect(a.state()).toBe('pending')
    expect(b.state()).toBe('pending')

    c.reply(2, { output: 'second' })
    await flush()
    expect(b.value()).toEqual({ output: 'second' })
    expect(a.state()).toBe('pending')
    c.reply(1, { output: 'first' })
    await flush()
    expect(a.value()).toEqual({ output: 'first' })
    // 同一个 id 再来一次：已经没人等了
    c.reply(1, { output: 'again' })
    await flush()
    expect(mocks.fork).toHaveBeenCalledTimes(1)
    rt.dispose()
  })
})

describe('M-3 应答、消息体与超时', () => {
  it('M-3 错误应答 → WidgetRuntimeError（code + message）', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    const { t, id, c } = await startedWith(() => rt.applySchema(TARGET, 'CREATE TABLE x(a)'))
    c.fail(id, 'schema_failed', 'table x already exists')
    await flush()
    expect(t.state()).toBe('rejected')
    const err = t.error() as WidgetRuntimeError
    expect(err).toBeInstanceOf(WidgetRuntimeError)
    expect(err.code).toBe('schema_failed')
    expect(err.message).toBe('table x already exists')
    rt.dispose()
  })

  it('M-3 call / manifest 的消息体：cpuMs 来自选项（缺省 CALL_CPU_MS）；manifest 10 秒', async () => {
    expect(CALL_CPU_MS).toBeLessThan(CALL_TIMEOUT_MS)

    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    const { id, c } = await startedWith(() => rt.call(PARAMS))
    expect(c.sent[0]).toEqual({ type: 'call', ...PARAMS, cpuMs: CALL_CPU_MS, id })
    void track(rt.manifest('code();'))
    await flush()
    expect(c.sent[1]).toEqual({
      type: 'manifest',
      bundleCode: 'code();',
      cpuMs: 10_000,
      id: id + 1
    })
    rt.dispose()

    const custom = new WidgetRuntime({ hostPath: '/h.js', callCpuMs: 1234 })
    const second = await startedWith(() => custom.call(PARAMS))
    expect(second.c.sent[0]).toMatchObject({ type: 'call', cpuMs: 1234 })
    custom.dispose()
  })

  /** 一个请求的超时：差 1 毫秒还在等，到点 → timeout */
  async function expectTimeout(
    rt: WidgetRuntime,
    fire: () => Promise<unknown>,
    ms: number
  ): Promise<void> {
    const { t } = await startedWith(fire)
    await vi.advanceTimersByTimeAsync(ms - 1)
    expect(t.state()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(t.state()).toBe('rejected')
    expect((t.error() as WidgetRuntimeError).code).toBe('timeout')
    expect((t.error() as Error).message).toContain(`within ${Math.round(ms / 1000)} seconds`)
    rt.dispose()
  }

  it.each([
    ['call', {}, (rt: WidgetRuntime) => rt.call(PARAMS), CALL_TIMEOUT_MS],
    ['manifest', {}, (rt: WidgetRuntime) => rt.manifest('x'), CALL_TIMEOUT_MS],
    ['applySchema', {}, (rt: WidgetRuntime) => rt.applySchema(TARGET, 'x'), 60_000],
    ['query', {}, (rt: WidgetRuntime) => rt.query(TARGET, 'x'), 60_000],
    ['call（选项 5 秒）', { callTimeoutMs: 5000 }, (rt: WidgetRuntime) => rt.call(PARAMS), 5000],
    [
      'manifest（选项 5 秒）',
      { callTimeoutMs: 5000 },
      (rt: WidgetRuntime) => rt.manifest('x'),
      5000
    ],
    [
      'query（不随选项）',
      { callTimeoutMs: 5000 },
      (rt: WidgetRuntime) => rt.query(TARGET, 'x'),
      60_000
    ]
  ] as const)('M-3 %s 的超时', async (_label, options, fire, ms) => {
    const rt = new WidgetRuntime({ hostPath: '/h.js', ...options })
    await expectTimeout(rt, () => fire(rt), ms)
  })

  it.each([
    ['缺省', {}, CALL_TIMEOUT_MS + 10_000],
    ['选项 5 秒', { callTimeoutMs: 5000 }, 15_000]
  ] as const)('M-3 forget 的超时 = callTimeoutMs + 10 秒（%s）', async (_label, options, ms) => {
    const rt = new WidgetRuntime({ hostPath: '/h.js', ...options })
    // 先让宿主跑起来（没有宿主时 forget 什么都不做）
    const { id, c } = await startedWith(() => rt.query(TARGET, 'SELECT 1'))
    c.reply(id, { output: 'OK' })
    await flush()
    const t = track(rt.forget('w-one'))
    await flush()
    expect(c.sent[1]).toMatchObject({ type: 'forget', widgetId: 'w-one' })
    await vi.advanceTimersByTimeAsync(ms - 1)
    expect(t.state()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect((t.error() as WidgetRuntimeError).code).toBe('timeout')
    rt.dispose()
  })
})

describe('M-4 超时杀宿主', () => {
  it('M-4 这次调用 timeout，SIGKILL 一次，别的在途请求 interrupted，下一个请求 fork 新的', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js', callTimeoutMs: 5000 })
    const { t: slow, c } = await startedWith(() => rt.call(PARAMS))
    await vi.advanceTimersByTimeAsync(1000)
    const other = track(rt.query(TARGET, 'SELECT 1'))
    const otherCall = track(rt.call({ ...PARAMS, target: { widgetId: 'w-two', dbPath: '/d2' } }))
    await flush()

    await vi.advanceTimersByTimeAsync(4000)
    expect(slow.state()).toBe('rejected')
    expect((slow.error() as WidgetRuntimeError).code).toBe('timeout')
    for (const p of [other, otherCall]) {
      expect(p.state()).toBe('rejected')
      expect((p.error() as WidgetRuntimeError).code).toBe('interrupted')
    }
    expect(c.kill).toHaveBeenCalledTimes(1)
    expect(c.kill).toHaveBeenCalledWith('SIGKILL')
    expect(rt.running).toBe(false)
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('timed out after 5000ms')
    )

    // 别的请求自己的计时器也清掉了：再等多久都不会第二次杀
    await vi.advanceTimersByTimeAsync(120_000)
    expect(c.kill).toHaveBeenCalledTimes(1)

    const next = await startedWith(() => rt.query(TARGET, 'SELECT 2'))
    expect(mocks.fork).toHaveBeenCalledTimes(2)
    expect(next.c).not.toBe(c)
    next.c.reply(next.id, { output: 'fresh' })
    await flush()
    expect(next.t.value()).toEqual({ output: 'fresh' })
    rt.dispose()
  })
})

describe('M-5 宿主意外退出', () => {
  it('M-5 ready 之后退出 → 在途请求 host_exited（带 code 与 signal）；下一个请求重新拉起', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    const { t, c } = await startedWith(() => rt.call(PARAMS))
    const q = track(rt.query(TARGET, 'SELECT 1'))
    await flush()

    c.exitCode = 1
    c.emit('exit', 1, null)
    await flush()
    for (const p of [t, q]) {
      expect(p.state()).toBe('rejected')
      const err = p.error() as WidgetRuntimeError
      expect(err.code).toBe('host_exited')
      expect(err.message).toContain('code 1')
      expect(err.message).toContain('signal null')
    }
    expect(rt.running).toBe(false)

    const killed = track(rt.query(TARGET, 'SELECT 2'))
    await flush()
    expect(mocks.fork).toHaveBeenCalledTimes(2)
    const c2 = child()
    c2.ready()
    await flush()
    c2.signalCode = 'SIGKILL'
    c2.emit('exit', null, 'SIGKILL')
    await flush()
    expect((killed.error() as WidgetRuntimeError).message).toContain('signal SIGKILL')

    const next = await startedWith(() => rt.query(TARGET, 'SELECT 3'))
    expect(mocks.fork).toHaveBeenCalledTimes(3)
    next.c.reply(next.id, { output: 'ok' })
    await flush()
    expect(next.t.value()).toEqual({ output: 'ok' })
    rt.dispose()
  })

  it('M-5 已被换掉的旧子进程迟到的 exit 不连累新子进程的请求', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js', callTimeoutMs: 1000 })
    const { c: old } = await startedWith(() => rt.call(PARAMS))
    await vi.advanceTimersByTimeAsync(1000) // 超时 → 杀掉旧的（它还没报 exit）
    expect(old.kill).toHaveBeenCalledWith('SIGKILL')

    const next = await startedWith(() => rt.query(TARGET, 'SELECT 1'))
    expect(next.c).not.toBe(old)
    old.signalCode = 'SIGKILL'
    old.emit('exit', null, 'SIGKILL')
    await flush()
    expect(next.t.state()).toBe('pending')
    expect(rt.running).toBe(true)

    next.c.reply(next.id, { output: 'still fine' })
    await flush()
    expect(next.t.value()).toEqual({ output: 'still fine' })
    rt.dispose()
  })
})

describe('M-6 启动失败与传输错误', () => {
  it('M-6 ready 之前退出 → host_unavailable；之后下一个请求重新拉起', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    const t = track(rt.query(TARGET, 'SELECT 1'))
    await flush()
    child().emit('exit', 1, null)
    await flush()
    expect((t.error() as WidgetRuntimeError).code).toBe('host_unavailable')
    expect((t.error() as Error).message).toContain('exited while starting (code 1, signal null)')

    const next = await startedWith(() => rt.query(TARGET, 'SELECT 2'))
    expect(mocks.fork).toHaveBeenCalledTimes(2)
    next.c.reply(next.id, { output: 'ok' })
    await flush()
    expect(next.t.value()).toEqual({ output: 'ok' })
    rt.dispose()
  })

  it('M-6 15 秒没 ready → host_unavailable 并 SIGKILL；之后下一个请求重新拉起', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    const t = track(rt.query(TARGET, 'SELECT 1'))
    await flush()
    const c = child()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(t.state()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect((t.error() as WidgetRuntimeError).code).toBe('host_unavailable')
    expect((t.error() as Error).message).toContain('did not start in time')
    expect(c.kill).toHaveBeenCalledWith('SIGKILL')
    // 被杀的子进程这时才报 ready / exit：都不算数
    c.ready()
    c.emit('exit', null, 'SIGKILL')
    await flush()
    expect(rt.running).toBe(false)

    const next = await startedWith(() => rt.query(TARGET, 'SELECT 2'))
    expect(mocks.fork).toHaveBeenCalledTimes(2)
    next.c.reply(next.id, { output: 'ok' })
    await flush()
    expect(next.t.value()).toEqual({ output: 'ok' })
    rt.dispose()
  })

  it('M-6 fork 抛错 → host_unavailable；之后下一个请求重新拉起', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    mocks.fork.mockImplementationOnce(() => {
      throw new Error('spawn EACCES')
    })
    const t = track(rt.query(TARGET, 'SELECT 1'))
    await flush()
    expect(t.state()).toBe('rejected')
    expect(t.error()).toMatchObject({ code: 'host_unavailable', message: 'spawn EACCES' })

    const next = await startedWith(() => rt.query(TARGET, 'SELECT 2'))
    expect(mocks.fork).toHaveBeenCalledTimes(2)
    next.c.reply(next.id, { output: 'ok' })
    await flush()
    expect(next.t.value()).toEqual({ output: 'ok' })
    rt.dispose()
  })

  it('M-6 ready 之前的 error 事件 → host_unavailable；之后下一个请求重新拉起', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    const t = track(rt.query(TARGET, 'SELECT 1'))
    await flush()
    child().emit('error', new Error('spawn ENOENT'))
    await flush()
    expect(t.error()).toMatchObject({ code: 'host_unavailable', message: 'spawn ENOENT' })
    // 起动计时器清掉了：不会再去杀它
    await vi.advanceTimersByTimeAsync(20_000)
    expect(child().kill).not.toHaveBeenCalled()

    const next = await startedWith(() => rt.query(TARGET, 'SELECT 2'))
    expect(mocks.fork).toHaveBeenCalledTimes(2)
    rt.dispose()
    expect((await next.t.promise.catch((e: WidgetRuntimeError) => e.code)) as string).toBe(
      'host_stopped'
    )
  })

  it('M-6 send 回调报错 → 那个请求 host_unavailable、计时器清掉；别的请求不受影响', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    const first = await startedWith(() => rt.query(TARGET, 'SELECT 1'))
    first.c.reply(first.id, { output: 'ok' })
    await flush()
    expect(vi.getTimerCount()).toBe(0)

    first.c.sendError = new Error('channel closed')
    const t = track(rt.call(PARAMS))
    await flush()
    expect(t.error()).toMatchObject({ code: 'host_unavailable', message: 'channel closed' })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(first.c.kill).not.toHaveBeenCalled()
    expect(rt.running).toBe(true)

    const later = track(rt.query(TARGET, 'SELECT 2'))
    await flush()
    first.c.reply(first.c.lastId(), { output: 'later' })
    await flush()
    expect(later.value()).toEqual({ output: 'later' })
    rt.dispose()
  })

  it('M-6 ready 之后的 error 事件只记日志，不抛、不影响在途请求', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    const { t, id, c } = await startedWith(() => rt.query(TARGET, 'SELECT 1'))
    expect(() => c.emit('error', new Error('late trouble'))).not.toThrow()
    expect(mocks.logger.warn).toHaveBeenCalledWith('widget host error: late trouble')
    expect(t.state()).toBe('pending')
    c.reply(id, { output: 'ok' })
    await flush()
    expect(t.value()).toEqual({ output: 'ok' })
    rt.dispose()
  })
})

describe('M-7 forget / dispose / 子进程输出', () => {
  it('M-7 没有宿主时 forget 不 fork，直接结束', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    await expect(rt.forget('w-one')).resolves.toBeUndefined()
    expect(mocks.fork).not.toHaveBeenCalled()
  })

  it('M-7 dispose → 在途请求 host_stopped，然后 SIGKILL；之后不再有计时器', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    const { t, c } = await startedWith(() => rt.call(PARAMS))
    const q = track(rt.query(TARGET, 'SELECT 1'))
    await flush()

    rt.dispose()
    await flush()
    for (const p of [t, q]) {
      expect(p.state()).toBe('rejected')
      expect(p.error()).toMatchObject({
        code: 'host_stopped',
        message: 'The widget host was stopped.'
      })
    }
    expect(c.kill).toHaveBeenCalledTimes(1)
    expect(c.kill).toHaveBeenCalledWith('SIGKILL')
    expect(rt.running).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('M-7 已经退出的子进程 dispose 时不再 kill', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    const { id, c } = await startedWith(() => rt.query(TARGET, 'SELECT 1'))
    c.reply(id, { output: 'ok' })
    await flush()
    c.exitCode = 0
    rt.dispose()
    expect(c.kill).not.toHaveBeenCalled()
  })

  it('M-7 子进程 stdout → info、stderr → warn，逐行、带 [host] 前缀、没有空行', async () => {
    const rt = new WidgetRuntime({ hostPath: '/h.js' })
    void track(rt.query(TARGET, 'SELECT 1'))
    await flush()
    const c = child()
    c.stdout.emit('data', 'hello\n\n  \nworld\n')
    c.stderr.emit('data', 'oops\n')
    expect(mocks.logger.info.mock.calls).toEqual([['[host] hello'], ['[host] world']])
    expect(mocks.logger.warn.mock.calls).toEqual([['[host] oops']])
    rt.dispose()
  })
})
