// @vitest-environment jsdom
/**
 * 手机布局的「长按 = 右键」（mobile/longPress.ts，jsdom + 假时钟）。
 *
 * 契约：一根手指按住不动 500ms → 在按住的元素上派发一次 contextmenu（冒泡、可取消、带按下的坐标）；
 * 松手 / 取消 / 挪动超过 10px / 第二根手指 → 不派发；长按成立后松手带出的那一下 click 被吞掉（只吞一次，
 * 下一次触摸重置；松手 600ms 后也不再吞）；浏览器自己的 contextmenu 先到 → 交给它，我们不再派发；
 * 我们先到 → 吞掉它的（preventDefault + stopPropagation），但不碰我们自己派发的那一次。
 *
 *   LP-1 按住 500ms → 恰一次 contextmenu（目标、冒泡、可取消、composed、clientX/Y = 按下点）；499ms 时什么都没有
 *   LP-2 500ms 之前 touchend / touchcancel → 2s 之后也什么都没有
 *   LP-3 挪动 hypot 11 → 取消；恰好 10 → 照样派发
 *   LP-4 两根手指按下 → 不派发；按住途中第二根手指按下 → 取消在等的那一次
 *   LP-5 长按成立后的 click：defaultPrevented、到不了目标；下一次 click 照常；没有长按的 click 照常
 *   LP-6 新的一次 touchstart 重置标记 → 那一下轻点的 click 照常
 *   LP-6b 长按 + 松手但没有 click：700ms 之后的一次 click 照常（CLICK_GRACE_MS = 600）
 *   LP-7 浏览器的（可信）contextmenu 在我们之后 → preventDefault + stopPropagation；在我们的计时器之前 →
 *        之后不再派发合成的，它自己也不被拦
 *   LP-8 我们自己派发的那一次不被捕获阶段的监听拦下
 *   LP-9 监听选项：touchstart / touchmove passive，contextmenu / click 捕获；拆卸摘掉全部六个并清掉在等的
 *        计时器；缺省挂在 document 上
 *
 * Shadow DOM 里的元素（Files 面板的文件树在 pierre 的 shadow root 里）：派发到按住的最里层元素
 * （composedPath()[0]），事件 composed，冒得出 shadow root。
 *   LP-10 装在 document / shadow 宿主的祖先上：按住 shadow 里的 label → label、行、宿主（target 重定向成宿主）、
 *         document 各恰收到一次；冒泡、可取消、composed、坐标 = 按下点
 *   LP-11 shadow 里长按成立后，下一次（composed）click 被吞、到不了 label / 行；再下一次照常
 *   LP-12 shadow 里挪动 hypot 11 → 取消；恰好 10 → 照样派发
 *   LP-13 [白盒] closed shadow root：外面看不进去 → 派发到宿主上，label / 行收不到
 *   LP-14 [白盒] composedPath() 为空 → 退回 e.target
 *
 * jsdom 造不出 isTrusted 的事件 —— 「浏览器自己的 contextmenu」那几条用一个记下监听的假 root，直接拿普通
 * 对象调监听函数。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installLongPressContextMenu } from '../longPress'

/**
 * jsdom 的 MouseEvent 只收它内部那个 Window 作 `view`，而 vitest 的 jsdom 环境里全局 `window`（连同
 * `document.defaultView`）是外面包的一层 —— 产品代码传的 `view: window` 会让构造直接抛。这里把 view 摘掉
 * （其余字段原样），并记下产品代码确实传了它。
 */
const viewsGiven: unknown[] = []
beforeAll(() => {
  const Native = window.MouseEvent
  class TestMouseEvent extends Native {
    constructor(type: string, init?: MouseEventInit) {
      if (init && 'view' in init) viewsGiven.push(init.view)
      const rest: MouseEventInit = { ...init }
      delete rest.view
      super(type, rest)
    }
  }
  vi.stubGlobal('MouseEvent', TestMouseEvent)
})
afterAll(() => {
  vi.unstubAllGlobals()
})

interface Point {
  clientX: number
  clientY: number
}

/** 在 `target` 上派发一次触摸事件（`touches` 经 defineProperty 塞进去；jsdom 没有 Touch 构造器） */
function touch(target: EventTarget, type: string, points: Point[] = []): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'touches', { value: points })
  target.dispatchEvent(e)
  return e
}

const at = (x: number, y: number): Point => ({ clientX: x, clientY: y })

/** 在 `target` 上派发一次（不可信的）click，回事件 */
function click(target: EventTarget): MouseEvent {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

let container: HTMLDivElement
let target: HTMLButtonElement
let dispose: (() => void) | null = null
/** 目标上收到的 contextmenu */
let menus: MouseEvent[]
/** 目标上收到的 click */
let clicks: MouseEvent[]

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  target = document.createElement('button')
  container.appendChild(target)
  document.body.appendChild(container)
  menus = []
  clicks = []
  target.addEventListener('contextmenu', (e) => menus.push(e as MouseEvent))
  target.addEventListener('click', (e) => clicks.push(e as MouseEvent))
})

afterEach(() => {
  dispose?.()
  dispose = null
  container.remove()
  vi.useRealTimers()
})

/** 装在容器上（真 DOM 冒泡 / 捕获） */
const install = (): void => {
  dispose = installLongPressContextMenu(container)
}

/** 一次成立的长按：按下 → 500ms → 松手 */
const longPress = (x = 30, y = 40): void => {
  touch(target, 'touchstart', [at(x, y)])
  vi.advanceTimersByTime(500)
  touch(target, 'touchend')
}

describe('long press = right click', () => {
  it('LP-1 a single touch held 500ms dispatches exactly one contextmenu on the touched element; nothing at 499ms', () => {
    install()
    touch(target, 'touchstart', [at(31, 47)])
    vi.advanceTimersByTime(499)
    expect(menus).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(menus).toHaveLength(1)
    const e = menus[0]
    expect(e).toBeInstanceOf(MouseEvent)
    expect(e.type).toBe('contextmenu')
    expect(e.target).toBe(target)
    expect(e.bubbles).toBe(true)
    expect(e.cancelable).toBe(true)
    // 同原生右键一样 composed：从 Shadow DOM 里派发也冒得出来（LP-10）
    expect(e.composed).toBe(true)
    expect([e.clientX, e.clientY]).toEqual([31, 47])
    expect(viewsGiven.at(-1)).toBe(window)
    // 一直按着也只有这一次
    vi.advanceTimersByTime(3000)
    expect(menus).toHaveLength(1)
  })

  it.each(['touchend', 'touchcancel'])(
    'LP-2 %s before 500ms dispatches nothing, even after 2s',
    (type) => {
      install()
      touch(target, 'touchstart', [at(10, 10)])
      vi.advanceTimersByTime(300)
      touch(target, type)
      vi.advanceTimersByTime(2000)
      expect(menus).toHaveLength(0)
    }
  )

  it('LP-3 moving more than 10px cancels; exactly 10px still fires', () => {
    install()
    // hypot(11, 0) = 11 > 10 → 取消
    touch(target, 'touchstart', [at(100, 100)])
    vi.advanceTimersByTime(200)
    touch(target, 'touchmove', [at(111, 100)])
    vi.advanceTimersByTime(1000)
    expect(menus).toHaveLength(0)
    touch(target, 'touchend')

    // hypot(6, 8) = 10 → 不算挪动
    touch(target, 'touchstart', [at(100, 100)])
    vi.advanceTimersByTime(200)
    touch(target, 'touchmove', [at(106, 108)])
    vi.advanceTimersByTime(300)
    expect(menus).toHaveLength(1)
    // 坐标是按下点，不是挪到的点
    expect([menus[0].clientX, menus[0].clientY]).toEqual([100, 100])
  })

  it('LP-4 a two-finger start fires nothing; a second finger during a hold cancels the pending one', () => {
    install()
    touch(target, 'touchstart', [at(10, 10), at(50, 50)])
    vi.advanceTimersByTime(1000)
    expect(menus).toHaveLength(0)
    touch(target, 'touchend')

    touch(target, 'touchstart', [at(10, 10)])
    vi.advanceTimersByTime(300)
    touch(target, 'touchstart', [at(10, 10), at(60, 60)])
    vi.advanceTimersByTime(1000)
    expect(menus).toHaveLength(0)
  })

  it('LP-5 the click right after a fired press is swallowed once; the next click and a click without a press pass', () => {
    install()
    // 没有长按的 click：照常
    const plain = click(target)
    expect(plain.defaultPrevented).toBe(false)
    expect(clicks).toHaveLength(1)

    longPress()
    expect(menus).toHaveLength(1)
    const swallowed = click(target)
    expect(swallowed.defaultPrevented).toBe(true)
    expect(clicks).toHaveLength(1) // 没到目标

    const next = click(target)
    expect(next.defaultPrevented).toBe(false)
    expect(clicks).toHaveLength(2)
  })

  it('LP-6 a fresh touchstart resets the mark, so that tap’s click passes', () => {
    install()
    longPress()
    expect(menus).toHaveLength(1)
    // 没有 click 跟上来；紧接着一次轻点
    touch(target, 'touchstart', [at(30, 40)])
    vi.advanceTimersByTime(80)
    touch(target, 'touchend')
    const tap = click(target)
    expect(tap.defaultPrevented).toBe(false)
    expect(clicks).toHaveLength(1)
    expect(menus).toHaveLength(1)
  })

  it('LP-6b after a fired press and release with no click, a click 700ms later passes', () => {
    install()
    longPress()
    vi.advanceTimersByTime(700)
    const late = click(target)
    expect(late.defaultPrevented).toBe(false)
    expect(clicks).toHaveLength(1)
  })

  describe('the browser’s own (trusted) contextmenu', () => {
    type Listener = (e: unknown) => void
    /** 假 root：只记下监听，交给用例直接调 */
    const fakeRoot = (): {
      root: HTMLElement
      listeners: Map<string, Listener>
    } => {
      const listeners = new Map<string, Listener>()
      const root = {
        addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
        removeEventListener: (type: string) => listeners.delete(type)
      } as unknown as HTMLElement
      return { root, listeners }
    }
    const nativeMenu = (): {
      isTrusted: true
      preventDefault: ReturnType<typeof vi.fn>
      stopPropagation: ReturnType<typeof vi.fn>
    } => ({ isTrusted: true, preventDefault: vi.fn(), stopPropagation: vi.fn() })

    it('LP-7 after ours it is prevented and stopped; before our timer it wins and ours never fires', () => {
      const { root, listeners } = fakeRoot()
      dispose = installLongPressContextMenu(root)
      const start = { touches: [at(5, 6)], target, composedPath: () => [target] }

      // 我们的先到 → 它的被拦
      listeners.get('touchstart')!(start)
      vi.advanceTimersByTime(500)
      expect(menus).toHaveLength(1)
      const late = nativeMenu()
      listeners.get('contextmenu')!(late)
      expect(late.preventDefault).toHaveBeenCalledTimes(1)
      expect(late.stopPropagation).toHaveBeenCalledTimes(1)
      listeners.get('touchend')!({ touches: [] })

      // 它的先到（我们的计时器还没到点）→ 交给它，我们不再派发
      vi.advanceTimersByTime(1000)
      listeners.get('touchstart')!(start)
      vi.advanceTimersByTime(300)
      const early = nativeMenu()
      listeners.get('contextmenu')!(early)
      expect(early.preventDefault).not.toHaveBeenCalled()
      expect(early.stopPropagation).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2000)
      expect(menus).toHaveLength(1)
    })

    it('LP-14 [white-box] an empty composedPath() falls back to e.target', () => {
      const { root, listeners } = fakeRoot()
      dispose = installLongPressContextMenu(root)
      listeners.get('touchstart')!({ touches: [at(7, 8)], target, composedPath: () => [] })
      vi.advanceTimersByTime(500)
      expect(menus).toHaveLength(1)
      expect(menus[0].target).toBe(target)
      expect([menus[0].clientX, menus[0].clientY]).toEqual([7, 8])
    })
  })

  it('LP-8 our own synthetic contextmenu is not prevented by the capture listener', () => {
    install()
    let seenDefaultPrevented: boolean | null = null
    let bubbledToContainerParent = false
    target.addEventListener('contextmenu', (e) => {
      seenDefaultPrevented = e.defaultPrevented
    })
    document.body.addEventListener('contextmenu', () => (bubbledToContainerParent = true), {
      once: true
    })
    touch(target, 'touchstart', [at(1, 2)])
    vi.advanceTimersByTime(500)
    expect(menus).toHaveLength(1)
    expect(seenDefaultPrevented).toBe(false)
    expect(menus[0].defaultPrevented).toBe(false)
    expect(bubbledToContainerParent).toBe(true)
  })

  it('LP-9 listener options, a disposer that removes all six and kills a pending timer, document by default', () => {
    const added: Array<[string, unknown, unknown]> = []
    const removed: Array<[string, unknown, unknown]> = []
    const root = {
      addEventListener: (type: string, fn: unknown, opts?: unknown) => added.push([type, fn, opts]),
      removeEventListener: (type: string, fn: unknown, opts?: unknown) =>
        removed.push([type, fn, opts])
    } as unknown as HTMLElement
    const off = installLongPressContextMenu(root)
    const optsOf = (type: string): unknown => added.find(([t]) => t === type)?.[2]
    expect(added.map(([t]) => t).sort()).toEqual(
      ['click', 'contextmenu', 'touchcancel', 'touchend', 'touchmove', 'touchstart'].sort()
    )
    expect(optsOf('touchstart')).toEqual({ passive: true })
    expect(optsOf('touchmove')).toEqual({ passive: true })
    expect(optsOf('contextmenu')).toBe(true)
    expect(optsOf('click')).toBe(true)
    off()
    expect(removed).toHaveLength(6)
    for (const [type, fn, opts] of added) {
      const hit = removed.find(([t, f]) => t === type && f === fn)
      expect(hit, type).toBeDefined()
      // 捕获的那两个必须带着 capture 摘，不然摘不掉
      if (opts === true) expect(hit![2], type).toBe(true)
    }

    // 拆卸清掉在等的计时器
    install()
    touch(target, 'touchstart', [at(3, 4)])
    vi.advanceTimersByTime(200)
    dispose!()
    dispose = null
    vi.advanceTimersByTime(2000)
    expect(menus).toHaveLength(0)

    // 缺省挂在 document 上
    const spy = vi.spyOn(document, 'addEventListener')
    const offDoc = installLongPressContextMenu()
    expect(spy.mock.calls.map(([t]) => t).sort()).toEqual(
      ['click', 'contextmenu', 'touchcancel', 'touchend', 'touchmove', 'touchstart'].sort()
    )
    spy.mockRestore()
    touch(target, 'touchstart', [at(9, 9)])
    vi.advanceTimersByTime(500)
    expect(menus).toHaveLength(1)
    offDoc()
  })
})

describe('long press inside a shadow root (the Files tree)', () => {
  /** 一次 composed 的触摸事件（真的触摸事件都是 composed：冒得出 shadow root，document 上听得到） */
  function composedTouch(target: EventTarget, type: string, points: Point[] = []): Event {
    const e = new Event(type, { bubbles: true, cancelable: true, composed: true })
    Object.defineProperty(e, 'touches', { value: points })
    target.dispatchEvent(e)
    return e
  }

  /** 一次 composed 的（不可信的）click */
  function composedClick(target: EventTarget): MouseEvent {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
    target.dispatchEvent(e)
    return e
  }

  interface Seen {
    at: string
    target: EventTarget | null
    event: MouseEvent
  }

  let host: HTMLDivElement
  let row: HTMLButtonElement
  let label: HTMLSpanElement
  /** 各层收到的 contextmenu（记下是哪一层、那一层看到的 target） */
  let seen: Seen[]
  /** label / 行上收到的 click */
  let shadowClicks: string[]
  const docListener = (e: Event): void => {
    seen.push({ at: 'document', target: e.target, event: e as MouseEvent })
  }

  /** 宿主 div → shadow root（open / closed）→ 行 button → label span */
  const build = (mode: ShadowRootMode): void => {
    host = document.createElement('div')
    container.appendChild(host)
    const shadow = host.attachShadow({ mode })
    row = document.createElement('button')
    label = document.createElement('span')
    label.textContent = 'a.txt'
    row.appendChild(label)
    shadow.appendChild(row)
    for (const [name, el] of [
      ['label', label],
      ['row', row],
      ['host', host]
    ] as const) {
      el.addEventListener('contextmenu', (e) =>
        seen.push({ at: name, target: e.target, event: e as MouseEvent })
      )
    }
    label.addEventListener('click', () => shadowClicks.push('label'))
    row.addEventListener('click', () => shadowClicks.push('row'))
  }

  beforeEach(() => {
    seen = []
    shadowClicks = []
    document.addEventListener('contextmenu', docListener)
  })

  afterEach(() => {
    document.removeEventListener('contextmenu', docListener)
  })

  it.each([
    ['document (the default)', (): (() => void) => installLongPressContextMenu()],
    ['a light-DOM ancestor of the host', (): (() => void) => installLongPressContextMenu(container)]
  ])(
    'LP-10 installed on %s: holding a label in an open shadow root reaches label, row, host (retargeted) and document once each',
    (_, installIt) => {
      build('open')
      dispose = installIt()
      composedTouch(label, 'touchstart', [at(31, 47)])
      vi.advanceTimersByTime(500)

      expect(seen.map((s) => s.at)).toEqual(['label', 'row', 'host', 'document'])
      expect(seen[0].target).toBe(label)
      expect(seen[1].target).toBe(label)
      // 在宿主及外面看，target 被重定向成宿主 —— 证明事件是 composed 的、冒出了 shadow root
      expect(seen[2].target).toBe(host)
      expect(seen[3].target).toBe(host)
      const e = seen[0].event
      expect(seen.every((s) => s.event === e)).toBe(true)
      expect(e.bubbles).toBe(true)
      expect(e.cancelable).toBe(true)
      expect(e.composed).toBe(true)
      expect([e.clientX, e.clientY]).toEqual([31, 47])

      // 一直按着也只有这一次
      vi.advanceTimersByTime(2000)
      expect(seen).toHaveLength(4)
    }
  )

  it('LP-11 after a held press in the shadow root the next composed click is swallowed before label / row; the one after passes', () => {
    build('open')
    dispose = installLongPressContextMenu()
    composedTouch(label, 'touchstart', [at(20, 20)])
    vi.advanceTimersByTime(500)
    composedTouch(label, 'touchend')
    expect(seen.filter((s) => s.at === 'label')).toHaveLength(1)

    const swallowed = composedClick(label)
    expect(swallowed.defaultPrevented).toBe(true)
    expect(shadowClicks).toEqual([])

    const next = composedClick(label)
    expect(next.defaultPrevented).toBe(false)
    expect(shadowClicks).toEqual(['label', 'row'])
  })

  it('LP-12 a composed touchmove of 11px on the label cancels; exactly 10px still fires', () => {
    build('open')
    dispose = installLongPressContextMenu()
    composedTouch(label, 'touchstart', [at(100, 100)])
    vi.advanceTimersByTime(200)
    composedTouch(label, 'touchmove', [at(111, 100)])
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([])
    composedTouch(label, 'touchend')

    composedTouch(label, 'touchstart', [at(100, 100)])
    vi.advanceTimersByTime(200)
    composedTouch(label, 'touchmove', [at(106, 108)])
    vi.advanceTimersByTime(300)
    expect(seen.map((s) => s.at)).toEqual(['label', 'row', 'host', 'document'])
    expect([seen[0].event.clientX, seen[0].event.clientY]).toEqual([100, 100])
  })

  it('LP-13 [white-box] a closed shadow root cannot be looked into: the menu is dispatched on the host, label / row get nothing', () => {
    build('closed')
    dispose = installLongPressContextMenu()
    composedTouch(label, 'touchstart', [at(5, 5)])
    vi.advanceTimersByTime(500)
    expect(seen.filter((s) => s.at === 'label' || s.at === 'row')).toEqual([])
    const onHost = seen.filter((s) => s.at === 'host')
    expect(onHost).toHaveLength(1)
    expect(onHost[0].target).toBe(host)
  })
})
