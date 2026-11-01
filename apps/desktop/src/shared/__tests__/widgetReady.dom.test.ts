// @vitest-environment jsdom
/**
 * `shared/widgetReady.ts` —— 小组件页面「画好了」的信号：页面骨架里的就绪脚本（`widgetReadyScript()`）在 `#root` 有了东西、
 * 开头那批请求都回来了、页面安静了 QUIET 毫秒之后，等一帧，向父页面 postMessage({ type })；最多等 MAX（从脚本开始算）。
 * 请求靠包一层 `window.fetch` 数，信号发出就换回原样。
 *
 * 脚本单独跑：`new Function('window', 'requestAnimationFrame', script)(fakeWin, raf)` —— `fakeWin` 只有 parent / fetch，
 * `document` / `MutationObserver` / `setTimeout` / `Date` 取测试这一边（jsdom 环境 + 假定时器，只假 setTimeout /
 * clearTimeout / Date；`advanceTimersByTimeAsync` 每个定时器之后让出一次，MutationObserver 的微任务跟着落定）。
 * rAF 缺省是同步的（`cb => cb()`：定时用例里「等一帧」不占时间），帧用例换成排队的、永不回调的或干脆没有。
 *
 *   RS-1  正常：框在 iframe 里；脚本开始后往 #root 挂东西、没有请求 → 79ms 没发、80ms 发出恰好一次，
 *         postMessage({ type: WIDGET_READY_MESSAGE }, '*')，载荷就是这个
 *   RS-2  等首屏数据：#root 一开始就有「Loading…」；50ms 发起一个请求（挂着）→ 100 / 500 / 1500ms 都没发；1500ms 回来、
 *         1510ms 改 #root → 1589ms 没发、1590ms 发
 *   RS-3  请求失败也算回来了：380ms 左右发；调用方拿到的 promise 照样以同一个错误拒绝；包装层自己不留未处理的拒绝
 *   RS-4  上限：(a) 请求一直不回 (b) 每 50ms 改一次 #root (c) #root 空着 / 没有 → 1999ms 没发、2000ms 恰好发一次
 *   RS-5  上限从脚本开始算：1990ms 才有东西 → 2000ms 发，不是 ~2070ms
 *   RS-6  顶层页面（parent === window）→ 从不发；fetch 原样没换
 *   RS-7  等一帧：(a) 排队的 rAF → 两次回调都跑完才发 (b) rAF 永不回调 / 没有 rAF → 决定之后 100ms 发
 *         (c) 帧与 100ms 的兜底都到了 → 只发一次
 *   RS-8  发出之后：fetch 换回原样；再改 DOM / 再发请求 / 再等 10s 都不发第二次；+100ms 之后一个定时器都不剩
 *   RS-9  透传：发之前包装层回 realFetch 回的同一个 promise、同样的参数、this 是 fakeWin；发之后留着的包装层照样透传、
 *         不改任何状态
 *   RS-10 脚本开始之后别人换了 fetch → 发之后还是别人的那个
 *   RS-11 (a) 0ms 有东西、60ms 又变了一下（#root 里 / #root 外都算）→ 100ms 没发、140ms 发
 *         (b) fakeWin.fetch 是 undefined → 不抛、保持 undefined、照样发 (c) parent.postMessage 抛 → 没有未捕获的错误
 *         (d) 两段脚本里都没有 `</script`（不分大小写）与 `<!--`，new Function 编得过
 *   RM-12 isWidgetReadyMessage：{type} / 带别的键 → true；null、undefined、字符串本身、别的 type、大写的 type、{}、[]、42、
 *         type 只是字符串化之后等于它的对象 → false
 *   RN-12 widgetReadyNowScript()：框在 iframe 里 → 同步发一次、不起定时器；顶层 → 不发；postMessage 抛 → 不抛
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  isWidgetReadyMessage,
  widgetReadyNowScript,
  widgetReadyScript,
  WIDGET_READY_MAX_WAIT_MS,
  WIDGET_READY_MESSAGE,
  WIDGET_READY_QUIET_MS
} from '../widgetReady'

type FrameCallback = () => void
type Raf = (cb: FrameCallback) => void

interface FakeWin {
  parent: unknown
  fetch?: unknown
  postMessage?: Mock
}

interface Deferred {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

const syncRaf: Raf = (cb) => cb()

let postMessage: Mock<(data: unknown, target: string) => void>
/** 每次 realFetch 被调时挂着的那个 promise 的开关（按调用顺序） */
let deferreds: Deferred[]
/** realFetch 回出去的 promise（按调用顺序） */
let returned: Array<Promise<unknown>>
let realFetch: Mock
let fakeWin: FakeWin

/** 框在 iframe 里的页面：parent 是另一个对象 */
function framedWin(): FakeWin {
  return { parent: { postMessage }, fetch: realFetch }
}

/**
 * 跑一次就绪脚本。`raf`：缺省同步；`'none'` = 不传 rAF（脚本里 typeof 不是 function）；函数 = 用它。
 * （不用参数缺省值区分「没给」与「给了 undefined」，免得 undefined 被换成同步的那个）
 */
function startScript(win: FakeWin, raf: Raf | 'none' = syncRaf): void {
  new Function('window', 'requestAnimationFrame', widgetReadyScript())(
    win,
    raf === 'none' ? undefined : raf
  )
}

const root = (): HTMLElement => {
  const el = document.getElementById('root')
  if (!el) throw new Error('no #root')
  return el
}

function addContent(text = 'hello'): void {
  const p = document.createElement('p')
  p.textContent = text
  root().appendChild(p)
}

const advance = (ms: number): Promise<void> => vi.advanceTimersByTimeAsync(ms).then(() => {})

const readyPayload = { type: WIDGET_READY_MESSAGE }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  document.body.innerHTML = '<div id="root"></div>'
  postMessage = vi.fn<(data: unknown, target: string) => void>()
  deferreds = []
  returned = []
  realFetch = vi.fn(function (this: unknown) {
    const p = new Promise((resolve, reject) => deferreds.push({ resolve, reject }))
    returned.push(p)
    return p
  })
  fakeWin = framedWin()
})

afterEach(async () => {
  // 用例中途失败时还在跑的脚本：推过上限让它发掉、断开它的 MutationObserver，免得串到下一条用例
  await advance(WIDGET_READY_MAX_WAIT_MS + 1000)
  vi.clearAllTimers()
  vi.useRealTimers()
  for (const d of deferreds) d.resolve(undefined)
})

describe('RS-1 正常路径', () => {
  it('RS-1 脚本开始后挂上东西、没有请求 → 79ms 没发、80ms 发出恰好一次，载荷就是 { type }', async () => {
    expect(WIDGET_READY_QUIET_MS).toBe(80)
    startScript(fakeWin)
    addContent()
    await advance(79)
    expect(postMessage).not.toHaveBeenCalled()
    await advance(1)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith({ type: WIDGET_READY_MESSAGE }, '*')
    expect(postMessage.mock.calls[0][0]).toStrictEqual(readyPayload)
    expect(Object.keys(postMessage.mock.calls[0][0] as object)).toEqual(['type'])
    await advance(5000)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })
})

describe('RS-2 等首屏数据', () => {
  it('RS-2 请求挂着时不发；回来、DOM 再变之后安静 80ms 才发', async () => {
    root().innerHTML = '<p>Loading…</p>'
    startScript(fakeWin)
    await advance(50)
    const fetchFn = fakeWin.fetch as () => Promise<unknown>
    void fetchFn()
    expect(realFetch).toHaveBeenCalledTimes(1)

    await advance(50) // 100
    expect(postMessage).not.toHaveBeenCalled()
    await advance(400) // 500
    expect(postMessage).not.toHaveBeenCalled()
    await advance(1000) // 1500
    expect(postMessage).not.toHaveBeenCalled()

    deferreds[0].resolve({ ok: true })
    await advance(10) // 1510
    expect(postMessage).not.toHaveBeenCalled()
    root().innerHTML = '<ul><li>a</li></ul>'
    await advance(79) // 1589
    expect(postMessage).not.toHaveBeenCalled()
    await advance(1) // 1590
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(readyPayload, '*')
  })
})

describe('RS-3 请求失败也算回来了', () => {
  it('RS-3 300ms 拒绝 → 380ms 发；调用方的 promise 以同一个错误拒绝；没有未处理的拒绝', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      addContent()
      startScript(fakeWin)
      const p = (fakeWin.fetch as () => Promise<unknown>)()
      const outcome = p.then(
        () => 'resolved',
        (e: unknown) => e
      )
      await advance(300)
      expect(postMessage).not.toHaveBeenCalled()
      const boom = new Error('network down')
      deferreds[0].reject(boom)
      await advance(79) // 379
      expect(postMessage).not.toHaveBeenCalled()
      await advance(1) // 380
      expect(postMessage).toHaveBeenCalledTimes(1)
      expect(await outcome).toBe(boom)
      // 让 Node 的未处理拒绝检测跑一轮（它在微任务清空之后报；setImmediate 没有被假掉）
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('RS-4 上限', () => {
  it('RS-4a 请求一直不回 → 1999ms 没发、2000ms 发恰好一次', async () => {
    expect(WIDGET_READY_MAX_WAIT_MS).toBe(2000)
    addContent()
    startScript(fakeWin)
    void (fakeWin.fetch as () => Promise<unknown>)()
    await advance(1999)
    expect(postMessage).not.toHaveBeenCalled()
    await advance(1)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(readyPayload, '*')
    await advance(3000)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('RS-4b 每 50ms 改一次 #root（从不安静）→ 1999ms 没发、2000ms 发恰好一次', async () => {
    addContent('0')
    startScript(fakeWin)
    for (let t = 50; t <= 1950; t += 50) {
      await advance(50)
      root().firstElementChild!.textContent = String(t)
    }
    await advance(49) // 1999
    root().firstElementChild!.textContent = 'last'
    expect(postMessage).not.toHaveBeenCalled()
    await advance(1) // 2000
    expect(postMessage).toHaveBeenCalledTimes(1)
    await advance(3000)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['#root 空着', '<div id="root"></div>'],
    ['没有 #root', '<main></main>'],
    ['#root 只有文字没有元素', '<div id="root">Loading…</div>']
  ])('RS-4c %s → 1999ms 没发、2000ms 发恰好一次', async (_what, body) => {
    document.body.innerHTML = body
    startScript(fakeWin)
    await advance(1999)
    expect(postMessage).not.toHaveBeenCalled()
    await advance(1)
    expect(postMessage).toHaveBeenCalledTimes(1)
    await advance(3000)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })
})

describe('RS-5 上限从脚本开始算', () => {
  it('RS-5 1990ms 才有东西 → 2000ms 发，不再多等 80ms', async () => {
    startScript(fakeWin)
    await advance(1990)
    addContent()
    await advance(9) // 1999
    expect(postMessage).not.toHaveBeenCalled()
    await advance(1) // 2000
    expect(postMessage).toHaveBeenCalledTimes(1)
  })
})

describe('RS-6 顶层页面', () => {
  it('RS-6 parent === window → 从不发；fetch 原样没换；不起定时器', async () => {
    const top: FakeWin = { parent: null, fetch: realFetch, postMessage }
    top.parent = top
    addContent()
    startScript(top)
    expect(top.fetch).toBe(realFetch)
    expect(vi.getTimerCount()).toBe(0)
    root().innerHTML = '<p>changed</p>'
    await advance(10_000)
    expect(postMessage).not.toHaveBeenCalled()
    expect(top.fetch).toBe(realFetch)
  })
})

describe('RS-7 等一帧', () => {
  it('RS-7a 排队的 rAF → 两次回调都跑完才发', async () => {
    const frames: FrameCallback[] = []
    const queued: Raf = (cb) => {
      frames.push(cb)
    }
    const runFrame = (): void => {
      const batch = frames.splice(0)
      for (const cb of batch) cb()
    }
    addContent()
    startScript(fakeWin, queued)
    await advance(80)
    // 决定发了：排了第一帧，还没发
    expect(frames).toHaveLength(1)
    expect(postMessage).not.toHaveBeenCalled()
    runFrame()
    expect(frames).toHaveLength(1)
    expect(postMessage).not.toHaveBeenCalled()
    runFrame()
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(readyPayload, '*')
  })

  it.each<[string, Raf | 'none']>([
    ['rAF 永不回调', () => {}],
    ['没有 rAF', 'none']
  ])('RS-7b %s → 决定之后 100ms 发', async (_what, raf) => {
    addContent()
    startScript(fakeWin, raf)
    await advance(80) // 决定
    expect(postMessage).not.toHaveBeenCalled()
    await advance(99) // 179
    expect(postMessage).not.toHaveBeenCalled()
    await advance(1) // 180
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith(readyPayload, '*')
    await advance(1000)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('RS-7c 帧先到、兜底后到 → 只发一次', async () => {
    const frames: FrameCallback[] = []
    addContent()
    startScript(fakeWin, (cb) => {
      frames.push(cb)
    })
    await advance(80)
    frames.shift()!()
    frames.shift()!()
    expect(postMessage).toHaveBeenCalledTimes(1)
    await advance(100) // 兜底的 100ms 也到了
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('RS-7c 兜底先到、帧后到 → 只发一次', async () => {
    const frames: FrameCallback[] = []
    addContent()
    startScript(fakeWin, (cb) => {
      frames.push(cb)
    })
    await advance(180)
    expect(postMessage).toHaveBeenCalledTimes(1)
    frames.shift()!()
    frames.shift()!()
    expect(frames).toHaveLength(0)
    expect(postMessage).toHaveBeenCalledTimes(1)
  })
})

describe('RS-8 发出之后', () => {
  it('RS-8 fetch 换回原样；再变、再请求、再等都不发第二次；+100ms 一个定时器都不剩', async () => {
    addContent()
    startScript(fakeWin)
    expect(fakeWin.fetch).not.toBe(realFetch)
    await advance(80)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(fakeWin.fetch).toBe(realFetch)

    root().innerHTML = '<p>after</p>'
    document.body.setAttribute('data-x', '1')
    void (fakeWin.fetch as () => Promise<unknown>)()
    deferreds[0].resolve(null)
    await advance(10_000)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('RS-8 发出之后 100ms：兜底定时器也走完，一个都不剩', async () => {
    addContent()
    startScript(fakeWin)
    await advance(80)
    expect(postMessage).toHaveBeenCalledTimes(1)
    await advance(100)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('RS-9 透传', () => {
  it('RS-9 发之前：包装层回同一个 promise、同样的参数、this 是 fakeWin', async () => {
    addContent()
    startScript(fakeWin)
    const wrapper = fakeWin.fetch as (...args: unknown[]) => Promise<unknown>
    expect(wrapper).not.toBe(realFetch)
    const init = { method: 'POST', body: '{}' }
    const p = wrapper('/w/x/api/list', init)
    expect(realFetch).toHaveBeenCalledTimes(1)
    expect(p).toBe(returned[0])
    expect(realFetch.mock.calls[0]).toHaveLength(2)
    expect(realFetch.mock.calls[0][0]).toBe('/w/x/api/list')
    expect(realFetch.mock.calls[0][1]).toBe(init)
    expect(realFetch.mock.contexts[0]).toBe(fakeWin)
    deferreds[0].resolve('ok')
    expect(await p).toBe('ok')
  })

  it('RS-9 发之后：留着的包装层照样透传、不改状态（不再计数、不起定时器、不再发）', async () => {
    addContent()
    startScript(fakeWin)
    const wrapper = fakeWin.fetch as (...args: unknown[]) => Promise<unknown>
    await advance(180)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(fakeWin.fetch).toBe(realFetch)
    expect(vi.getTimerCount()).toBe(0)

    const p = wrapper('/b', { cache: 'no-store' })
    expect(p).toBe(returned[0])
    expect(realFetch.mock.calls[0]).toEqual(['/b', { cache: 'no-store' }])
    expect(realFetch.mock.contexts[0]).toBe(fakeWin)
    expect(vi.getTimerCount()).toBe(0)
    deferreds[0].resolve('late')
    expect(await p).toBe('late')
    await advance(5000)
    expect(vi.getTimerCount()).toBe(0)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(fakeWin.fetch).toBe(realFetch)
  })
})

describe('RS-10 别人换过的 fetch', () => {
  it('RS-10 脚本开始之后别人换了 fetch → 发之后还是别人的', async () => {
    addContent()
    startScript(fakeWin)
    const theirs = vi.fn()
    fakeWin.fetch = theirs
    await advance(180)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(fakeWin.fetch).toBe(theirs)
  })
})

describe('RS-11 杂项', () => {
  it.each([
    [
      '#root 里',
      (): void => {
        root().firstElementChild!.textContent = 'changed'
      }
    ],
    [
      '#root 外',
      (): void => {
        document.body.appendChild(document.createElement('aside'))
      }
    ]
  ])('RS-11a 0ms 有东西、60ms 在%s变了一下 → 100ms 没发、140ms 发', async (_where, mutate) => {
    addContent()
    startScript(fakeWin)
    await advance(60)
    mutate()
    await advance(40) // 100
    expect(postMessage).not.toHaveBeenCalled()
    await advance(39) // 139
    expect(postMessage).not.toHaveBeenCalled()
    await advance(1) // 140
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('RS-11b fakeWin.fetch 是 undefined → 不抛、保持 undefined、照样发', async () => {
    const win: FakeWin = { parent: { postMessage } }
    addContent()
    expect(() => startScript(win)).not.toThrow()
    expect('fetch' in win).toBe(false)
    await advance(80)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(win.fetch).toBeUndefined()
  })

  it('RS-11c parent.postMessage 抛 → 没有未捕获的错误', async () => {
    const throwing = vi.fn(() => {
      throw new Error('cross-origin denied')
    })
    const win: FakeWin = { parent: { postMessage: throwing }, fetch: realFetch }
    addContent()
    startScript(win)
    await expect(advance(80)).resolves.toBeUndefined()
    expect(throwing).toHaveBeenCalledTimes(1)
    await expect(advance(1000)).resolves.toBeUndefined()
    expect(throwing).toHaveBeenCalledTimes(1)
    expect(win.fetch).toBe(realFetch)
  })

  it('RS-11d 两段脚本：没有 </script 与 <!--，new Function 编得过', () => {
    for (const script of [widgetReadyScript(), widgetReadyNowScript()]) {
      expect(script).not.toMatch(/<\/script/i)
      expect(script).not.toContain('<!--')
      expect(() => new Function('window', 'requestAnimationFrame', script)).not.toThrow()
    }
  })
})

describe('RM-12 isWidgetReadyMessage', () => {
  it('RM-12 认 { type } 与带别的键的', () => {
    expect(isWidgetReadyMessage({ type: WIDGET_READY_MESSAGE })).toBe(true)
    expect(isWidgetReadyMessage({ type: WIDGET_READY_MESSAGE, extra: 1 })).toBe(true)
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['字符串本身', WIDGET_READY_MESSAGE],
    ['别的 type', { type: 'other' }],
    ['大写的 type', { type: WIDGET_READY_MESSAGE.toUpperCase() }],
    ['空对象', {}],
    ['空数组', []],
    ['数字', 42],
    ['type 字符串化之后才等于它', { type: { toString: () => WIDGET_READY_MESSAGE } }],
    ['type 是 String 包装对象', { type: Object(WIDGET_READY_MESSAGE) }]
  ])('RM-12 %s → false', (_what, data) => {
    expect(isWidgetReadyMessage(data)).toBe(false)
  })
})

describe('RN-12 widgetReadyNowScript', () => {
  const runNow = (win: FakeWin): void => {
    new Function('window', widgetReadyNowScript())(win)
  }

  it('RN-12 框在 iframe 里 → 同步发一次 ({type}, "*")，不起定时器', () => {
    runNow(fakeWin)
    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith({ type: WIDGET_READY_MESSAGE }, '*')
    expect(postMessage.mock.calls[0][0]).toStrictEqual(readyPayload)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('RN-12 顶层 → 不发', () => {
    const top: FakeWin = { parent: null, postMessage }
    top.parent = top
    runNow(top)
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('RN-12 postMessage 抛 → 不抛', () => {
    const throwing = vi.fn(() => {
      throw new Error('denied')
    })
    expect(() => runNow({ parent: { postMessage: throwing } })).not.toThrow()
    expect(throwing).toHaveBeenCalledTimes(1)
  })
})
