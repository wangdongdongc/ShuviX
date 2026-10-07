import type { Session } from 'node:inspector'
import { describe, expect, it } from 'vitest'
import {
  createMainThreadStackCapture,
  toStackFrames,
  type CallFrameLike,
  type MainThreadStackCapture
} from '../mainThreadStack'

type Callback = (err: Error | null) => void

/** 只记录调用顺序的假 inspector 会话：post 的回调存起来、不自动应答 */
class FakeSession {
  log: string[] = []
  throwOn = new Set<string>()
  /** 抛哪个错（缺省带上失败的那一步） */
  failWith: Error | null = null
  handlers = new Map<string, (msg: { params: unknown }) => void>()
  callbacks = new Map<string, Callback>()

  private step(entry: string): void {
    this.log.push(entry)
    if (this.throwOn.has(entry)) throw this.failWith ?? new Error(`fake failure: ${entry}`)
  }

  connectToMainThread(): void {
    this.step('connect')
  }
  on(ev: string, h: (msg: { params: unknown }) => void): void {
    this.step(`on:${ev}`)
    this.handlers.set(ev, h)
  }
  post(method: string, cb: Callback): void {
    this.step(`post:${method}`)
    this.callbacks.set(method, cb)
  }
  disconnect(): void {
    this.step('disconnect')
  }

  emit(ev: string, params: unknown): void {
    const h = this.handlers.get(ev)
    if (!h) throw new Error(`no handler for ${ev}`)
    h({ params })
  }
  reply(method: string, err: Error | null = null): void {
    const cb = this.callbacks.get(method)
    if (!cb) throw new Error(`no pending ${method}`)
    cb(err)
  }
  count(entry: string): number {
    return this.log.filter((l) => l === entry).length
  }
}

const APP_URL = 'file:///x/out/main/index.js'

interface Harness {
  capture: MainThreadStackCapture
  sessions: FakeSession[]
  /** 最近一次建出来的会话 */
  readonly last: FakeSession
  createCalls(): number
}

function setup(opts: { prepare?: (s: FakeSession) => void; createThrows?: Error } = {}): Harness {
  const sessions: FakeSession[] = []
  let createCalls = 0
  const capture = createMainThreadStackCapture({
    maxFrames: 3,
    maxCaptures: 2,
    createSession: () => {
      createCalls++
      if (opts.createThrows) throw opts.createThrows
      const s = new FakeSession()
      opts.prepare?.(s)
      sessions.push(s)
      return s as unknown as Session
    }
  })
  return {
    capture,
    sessions,
    get last(): FakeSession {
      const s = sessions.at(-1)
      if (!s) throw new Error('no session created')
      return s
    },
    createCalls: () => createCalls
  }
}

/** 一次完整的抓取 + 收尾：paused → resume 回执 → disable 回执 */
function completeCycle(s: FakeSession): void {
  s.emit('Debugger.paused', { callFrames: [] })
  s.reply('Debugger.resume')
  s.reply('Debugger.disable')
}

describe('toStackFrames', () => {
  it('prefers a non-empty url, falls back to the scriptParsed map, else empty', () => {
    const urls = new Map([['7', 'file:///mapped.js']])
    const frames = toStackFrames(
      [
        { functionName: 'a', url: 'file:///direct.js', location: { scriptId: '7' } },
        { functionName: 'b', url: '', location: { scriptId: '7' } },
        { functionName: 'c', url: '', location: { scriptId: '99' } }
      ],
      10,
      urls
    )
    expect(frames.map((f) => f.url)).toEqual(['file:///direct.js', 'file:///mapped.js', ''])
  })

  it('converts 0-based positions to 1-based and fills missing fields', () => {
    const frames = toStackFrames(
      [{ functionName: 'f', location: { scriptId: '1', lineNumber: 0, columnNumber: 4 } }, {}],
      10
    )
    expect(frames).toEqual([
      { functionName: 'f', url: '', line: 1, column: 5 },
      { functionName: '', url: '', line: 0, column: 0 }
    ])
  })

  it('keeps at most max frames', () => {
    const many: CallFrameLike[] = Array.from({ length: 10 }, (_, i) => ({ functionName: `f${i}` }))
    expect(toStackFrames(many, 3).map((f) => f.functionName)).toEqual(['f0', 'f1', 'f2'])
  })
})

describe('createMainThreadStackCapture', () => {
  it('request() connects, registers listeners, then fires enable + pause without waiting', () => {
    const h = setup()
    h.capture.request()
    expect(h.last.log).toEqual([
      'connect',
      'on:Debugger.scriptParsed',
      'on:Debugger.paused',
      'post:Debugger.enable',
      'post:Debugger.pause'
    ])
  })

  it('captures the paused frames, resumes synchronously and resolves urls via scriptParsed', () => {
    const h = setup()
    h.capture.request()
    const s = h.last
    s.emit('Debugger.scriptParsed', { scriptId: '1', url: APP_URL })
    s.emit('Debugger.scriptParsed', { scriptId: '2', url: '' })
    s.emit('Debugger.paused', {
      callFrames: [
        {
          functionName: 'busyWait',
          url: '',
          location: { scriptId: '1', lineNumber: 92, columnNumber: 2 }
        },
        { functionName: 'other', url: '', location: { scriptId: '2', lineNumber: 0 } },
        { functionName: 'emit', url: 'node:events', location: { scriptId: '3', lineNumber: 466 } },
        { functionName: 'dropped', url: 'node:x', location: { scriptId: '4' } }
      ]
    })
    expect(s.log.at(-1)).toBe('post:Debugger.resume')
    expect(h.capture.take()).toEqual({
      state: 'captured',
      frames: [
        { functionName: 'busyWait', url: APP_URL, line: 93, column: 3 },
        { functionName: 'other', url: '', line: 1, column: 0 },
        { functionName: 'emit', url: 'node:events', line: 467, column: 0 }
      ]
    })
    expect(h.capture.take()).toEqual({ state: 'skipped', reason: 'no capture requested' })
  })

  it('tears down resume → disable → disconnect', () => {
    const h = setup()
    h.capture.request()
    const s = h.last
    s.emit('Debugger.paused', { callFrames: [] })
    expect(s.log.at(-1)).toBe('post:Debugger.resume')
    s.reply('Debugger.resume')
    expect(s.log.at(-1)).toBe('post:Debugger.disable')
    s.reply('Debugger.disable')
    expect(s.log.slice(-3)).toEqual(['post:Debugger.resume', 'post:Debugger.disable', 'disconnect'])
  })

  describe('teardown failures still disconnect and free the slot', () => {
    it('resume throws → disconnect directly', () => {
      const h = setup({ prepare: (s) => s.throwOn.add('post:Debugger.resume') })
      h.capture.request()
      expect(() => h.last.emit('Debugger.paused', { callFrames: [] })).not.toThrow()
      expect(h.last.log.slice(-2)).toEqual(['post:Debugger.resume', 'disconnect'])
      expect(h.capture.take().state).toBe('captured')
      h.capture.request()
      expect(h.sessions).toHaveLength(2)
    })

    it('disable throws → disconnect when the resume reply arrives', () => {
      const h = setup({ prepare: (s) => s.throwOn.add('post:Debugger.disable') })
      h.capture.request()
      const s = h.last
      s.emit('Debugger.paused', { callFrames: [] })
      expect(s.count('disconnect')).toBe(0)
      expect(() => s.reply('Debugger.resume')).not.toThrow()
      expect(s.log.slice(-2)).toEqual(['post:Debugger.disable', 'disconnect'])
      h.capture.request()
      expect(h.sessions).toHaveLength(2)
    })

    it('disconnect throws → swallowed', () => {
      const h = setup({ prepare: (s) => s.throwOn.add('disconnect') })
      h.capture.request()
      expect(() => completeCycle(h.last)).not.toThrow()
      expect(h.last.log.at(-1)).toBe('disconnect')
      h.capture.request()
      expect(h.sessions).toHaveLength(2)
    })
  })

  it('paused without callFrames → captured with no frames, still resumed', () => {
    const h = setup()
    h.capture.request()
    h.last.emit('Debugger.paused', { callFrames: undefined })
    expect(h.last.log.at(-1)).toBe('post:Debugger.resume')
    expect(h.capture.take()).toEqual({ state: 'captured', frames: [] })
  })

  it('an enable error makes this capture unavailable and still tears the session down', () => {
    const h = setup()
    h.capture.request()
    const s = h.last
    s.reply('Debugger.enable', new Error('agent disabled'))
    expect(h.capture.take()).toEqual({ state: 'unavailable', reason: 'agent disabled' })
    expect(s.log.at(-1)).toBe('post:Debugger.resume')
    // 之后再来的错误 / 成功回执都被忽略
    s.reply('Debugger.pause', new Error('later'))
    s.reply('Debugger.pause', null)
    expect(s.count('post:Debugger.resume')).toBe(1)
    s.reply('Debugger.resume')
    s.reply('Debugger.disable')
    expect(s.log.slice(-3)).toEqual(['post:Debugger.resume', 'post:Debugger.disable', 'disconnect'])
    expect(h.capture.take()).toEqual({ state: 'skipped', reason: 'no capture requested' })
    // 不是永久性的：下一次照样开会话
    h.capture.request()
    expect(h.sessions).toHaveLength(2)
  })

  it('a successful reply never marks the capture as failed', () => {
    const h = setup()
    h.capture.request()
    h.last.reply('Debugger.enable', null)
    h.last.reply('Debugger.pause', null)
    expect(h.last.count('post:Debugger.resume')).toBe(0)
    h.last.emit('Debugger.paused', { callFrames: [] })
    expect(h.capture.take()).toEqual({ state: 'captured', frames: [] })
  })

  it('a synchronous throw from post(enable) is handled like an enable error', () => {
    const h = setup({ prepare: (s) => s.throwOn.add('post:Debugger.enable') })
    expect(() => h.capture.request()).not.toThrow()
    const s = h.last
    expect(s.count('post:Debugger.pause')).toBe(0)
    expect(h.capture.take()).toEqual({
      state: 'unavailable',
      reason: 'fake failure: post:Debugger.enable'
    })
    s.reply('Debugger.resume')
    s.reply('Debugger.disable')
    expect(s.log.at(-1)).toBe('disconnect')
    h.capture.request()
    expect(h.sessions).toHaveLength(2)
  })

  it('a connect failure turns capture off for good', () => {
    const h = setup({
      prepare: (s) => {
        s.throwOn.add('connect')
        s.failWith = new Error('no worker')
      }
    })
    h.capture.request()
    expect(h.capture.take()).toEqual({
      state: 'unavailable',
      reason: 'inspector unavailable: no worker'
    })
    h.capture.request()
    expect(h.createCalls()).toBe(1)
    expect(h.capture.take()).toEqual({
      state: 'unavailable',
      reason: 'inspector unavailable: no worker'
    })
  })

  it('a createSession failure turns capture off for good', () => {
    const h = setup({ createThrows: new Error('no worker') })
    h.capture.request()
    expect(h.capture.take()).toEqual({
      state: 'unavailable',
      reason: 'inspector unavailable: no worker'
    })
    h.capture.request()
    expect(h.createCalls()).toBe(1)
    expect(h.capture.take()).toEqual({
      state: 'unavailable',
      reason: 'inspector unavailable: no worker'
    })
  })

  it('reports a miss when the main thread never paused, keeping the session open', () => {
    const h = setup()
    h.capture.request()
    expect(h.capture.take()).toEqual({
      state: 'missed',
      reason: 'main thread did not pause after resuming'
    })
    expect(h.last.count('post:Debugger.resume')).toBe(0)
    expect(h.last.count('disconnect')).toBe(0)
  })

  it('a late pause after a miss is resumed and torn down, its frames discarded', () => {
    const h = setup()
    h.capture.request()
    h.capture.take()
    const s = h.last
    s.emit('Debugger.paused', {
      callFrames: [{ functionName: 'late', url: APP_URL, location: { lineNumber: 1 } }]
    })
    expect(s.log.at(-1)).toBe('post:Debugger.resume')
    s.reply('Debugger.resume')
    s.reply('Debugger.disable')
    expect(s.log.at(-1)).toBe('disconnect')
    expect(h.capture.take()).toEqual({ state: 'skipped', reason: 'no capture requested' })
  })

  it('a request while the previous session is still in flight is skipped', () => {
    const h = setup()
    h.capture.request()
    h.capture.take() // missed
    h.capture.request()
    expect(h.capture.take()).toEqual({
      state: 'skipped',
      reason: 'previous capture still in flight'
    })
    expect(h.createCalls()).toBe(1)
    completeCycle(h.last)
    h.capture.request()
    expect(h.createCalls()).toBe(2)
  })

  it('stops after maxCaptures sessions', () => {
    const h = setup()
    h.capture.request()
    completeCycle(h.last)
    h.capture.take()
    // 第二次：missed，之后晚到的 paused 收尾
    h.capture.request()
    h.capture.take()
    completeCycle(h.last)
    expect(h.createCalls()).toBe(2)
    h.capture.request()
    expect(h.createCalls()).toBe(2)
    expect(h.capture.take()).toEqual({ state: 'skipped', reason: 'capture limit (2) reached' })
  })

  it('an enable error followed by a queued pause resumes twice without throwing', () => {
    const h = setup()
    h.capture.request()
    const s = h.last
    s.reply('Debugger.enable', new Error('agent disabled'))
    expect(() => s.emit('Debugger.paused', { callFrames: [] })).not.toThrow()
    expect(s.count('post:Debugger.resume')).toBe(2)
    expect(h.capture.take()).toEqual({ state: 'unavailable', reason: 'agent disabled' })
    expect(() => {
      s.reply('Debugger.resume')
      s.reply('Debugger.disable')
    }).not.toThrow()
    expect(s.log.at(-1)).toBe('disconnect')
    h.capture.request()
    expect(h.sessions).toHaveLength(2)
  })
})
