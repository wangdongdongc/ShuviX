/**
 * widgetWindowService —— widget 独立窗口的注册表、「上次在独立窗口里打开」（preferWindow）与 bounds 记忆。
 *
 * electron 的 BrowserWindow 是一个事件发射器替身（记下构造参数；close() 依次发 close / closed），
 * screen.getAllDisplays 给一块 1440×900 的工作区；settingsDao 是内存表；widgetService / 日志 / rendererPage /
 * externalOpen 都是替身；appEventBus.publish 是间谍。每条用例重新导入被测模块（模块级的窗口表从空开始），
 * 用假定时器推进 bounds 的防抖。
 *
 *   WW-1 setPreferWindow(a,true) 合进已存状态（宽高 / 置顶保留）；preferWindowIds 只列 true 的；同值不再写；false 取消
 *   WW-2 open(a) 建一个窗口，发布 widget.changed 时 openIds 已含 a；再 open → 不新建，restore / show / focus；
 *        closed → openIds 不含 a、widgetService.stopWidget('a')；open 从不写 preferWindow
 *   WW-3 500ms 内三次 moved → +500ms 只写一次（取 getBounds）；resized 同理；close 立即写并取消待写；300×200 存成 320×240
 *   WW-4 关窗或防抖到点时最小化 / 全屏 → 不写 bounds，之前的保留
 *   WW-5 恢复：在显示器上 → 传 x/y/w/h；x=3000 → 只传 w/h；水平重叠恰 80 保留、79 丢；y=860 保留、861 丢；
 *        getAllDisplays 抛错 → 不传 x/y；存的宽 <320 或缺失 → 480×620 不传 x/y，但置顶 / preferWindow 照读
 *   WW-6 移动后的 bounds 保存与 setAlwaysOnTop 都保留 preferWindow:true
 *   WW-7 close(id) 未知 / 已销毁不抛；openIds 跳过已销毁的窗口
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  upsert: vi.fn(),
  windows: [] as unknown[],
  displays: vi.fn(),
  getById: vi.fn(),
  stopWidget: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn()
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeWindow extends Emitter {
    options: Record<string, unknown>
    bounds = { x: 10, y: 20, width: 600, height: 700 }
    minimized = false
    fullScreen = false
    alwaysOnTop: boolean
    destroyed = false
    restore = vi.fn(() => {
      this.minimized = false
    })
    show = vi.fn()
    focus = vi.fn()
    constructor(options: Record<string, unknown>) {
      super()
      this.options = options
      this.alwaysOnTop = options.alwaysOnTop === true
      mocks.windows.push(this)
    }
    getBounds(): Bounds {
      return { ...this.bounds }
    }
    isMinimized(): boolean {
      return this.minimized
    }
    isFullScreen(): boolean {
      return this.fullScreen
    }
    isAlwaysOnTop(): boolean {
      return this.alwaysOnTop
    }
    setAlwaysOnTop(v: boolean): void {
      this.alwaysOnTop = v
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    close(): void {
      if (this.destroyed) return
      this.emit('close')
      this.destroyed = true
      this.emit('closed')
    }
  }
  return {
    BrowserWindow: FakeWindow,
    screen: { getAllDisplays: () => mocks.displays() }
  }
})
vi.mock('../widget', () => ({
  widgetService: { getById: mocks.getById, stopWidget: mocks.stopWidget }
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../../utils/rendererPage', () => ({ loadRendererPage: vi.fn() }))
vi.mock('../../utils/appEventBus', () => ({
  appEventBus: { subscribe: mocks.subscribe, publish: mocks.publish }
}))
vi.mock('../../dao/settingsDao', () => ({
  settingsDao: {
    findByKey: (key: string) => mocks.store.get(key),
    upsert: (key: string, value: string) => {
      mocks.upsert(key, value)
      mocks.store.set(key, value)
    }
  }
}))
vi.mock('../externalOpen', () => ({ guardAppWindow: vi.fn() }))

type FakeWindow = EventEmitter & {
  options: Record<string, unknown>
  bounds: Bounds
  minimized: boolean
  fullScreen: boolean
  destroyed: boolean
  restore: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  close: () => void
}

type Service = typeof import('../widgetWindowService')
let svc: Service

const key = (id: string): string => `window.widgetWindow.${id}`
const saved = (id: string): Record<string, unknown> | undefined => {
  const raw = mocks.store.get(key(id))
  return raw ? JSON.parse(raw) : undefined
}
const seedSaved = (id: string, value: Record<string, unknown>): void => {
  mocks.store.set(key(id), JSON.stringify(value))
}
const writesFor = (id: string): number =>
  mocks.upsert.mock.calls.filter(([k]) => k === key(id)).length
const win = (i = mocks.windows.length - 1): FakeWindow => mocks.windows[i] as FakeWindow
const display = { workArea: { x: 0, y: 0, width: 1440, height: 900 } }

beforeEach(async () => {
  vi.useFakeTimers()
  mocks.store.clear()
  mocks.windows.length = 0
  mocks.upsert.mockClear()
  mocks.publish.mockReset()
  mocks.stopWidget.mockClear()
  mocks.displays.mockReset().mockReturnValue([display])
  mocks.getById
    .mockReset()
    .mockImplementation((id: string) => ({ id, name: `Widget ${id}`, archivedAt: 0 }))
  vi.resetModules()
  svc = await import('../widgetWindowService')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('preferWindow（WW-1）', () => {
  it('WW-1 setPreferWindow(true) 合进已存状态，保留宽高与置顶', () => {
    seedSaved('a-a', { width: 500, height: 600, alwaysOnTop: true })
    svc.setPreferWindow('a-a', true)
    expect(saved('a-a')).toEqual({
      width: 500,
      height: 600,
      alwaysOnTop: true,
      preferWindow: true
    })
  })

  it('WW-1 preferWindowIds 只列 true 的', () => {
    svc.setPreferWindow('a-a', true)
    seedSaved('b-b', { preferWindow: false })
    expect(svc.preferWindowIds(['a-a', 'b-b', 'c-c'])).toEqual(['a-a'])
  })

  it('WW-1 同值再设不再写', () => {
    svc.setPreferWindow('a-a', true)
    expect(writesFor('a-a')).toBe(1)
    svc.setPreferWindow('a-a', true)
    expect(writesFor('a-a')).toBe(1)
  })

  it('WW-1 设 false → 从 preferWindowIds 里拿掉', () => {
    svc.setPreferWindow('a-a', true)
    svc.setPreferWindow('a-a', false)
    expect(svc.preferWindowIds(['a-a'])).toEqual([])
    expect(saved('a-a')?.preferWindow).toBe(false)
  })
})

describe('打开 / 关闭（WW-2）', () => {
  it('WW-2 open 建一个窗口；发布 widget.changed 时 openIds 已含它', () => {
    const seen: string[][] = []
    mocks.publish.mockImplementation((e: { type: string }) => {
      if (e.type === 'widget.changed') seen.push(svc.openIds())
    })
    svc.open('a-a')
    expect(mocks.windows).toHaveLength(1)
    expect(seen).toEqual([['a-a']])
    expect(svc.openIds()).toEqual(['a-a'])
  })

  it('WW-2 再 open → 不新建窗口，restore / show / focus', () => {
    svc.open('a-a')
    const w = win()
    w.minimized = true
    svc.open('a-a')
    expect(mocks.windows).toHaveLength(1)
    expect(w.restore).toHaveBeenCalledTimes(1)
    expect(w.show).toHaveBeenCalled()
    expect(w.focus).toHaveBeenCalled()
  })

  it('WW-2 窗口关掉 → openIds 不含它，stopWidget 被调', () => {
    svc.open('a-a')
    win().close()
    expect(svc.openIds()).toEqual([])
    expect(mocks.stopWidget).toHaveBeenCalledWith('a-a')
  })

  it('WW-2 open（含之后的 bounds 保存）从不写 preferWindow', () => {
    svc.open('a-a')
    win().emit('moved')
    vi.advanceTimersByTime(600)
    win().close()
    for (const [, value] of mocks.upsert.mock.calls) {
      expect(JSON.parse(value as string)).not.toHaveProperty('preferWindow')
    }
    expect(svc.preferWindowIds(['a-a'])).toEqual([])
  })
})

describe('bounds 防抖保存（WW-3）', () => {
  it('WW-3 500ms 内三次 moved → 最后一次后 500ms 才写一次', () => {
    svc.open('a-a')
    const w = win()
    w.emit('moved')
    vi.advanceTimersByTime(200)
    w.emit('moved')
    vi.advanceTimersByTime(200)
    w.bounds = { x: 111, y: 222, width: 640, height: 480 }
    w.emit('moved')
    vi.advanceTimersByTime(499)
    expect(writesFor('a-a')).toBe(0)
    vi.advanceTimersByTime(1)
    expect(writesFor('a-a')).toBe(1)
    expect(saved('a-a')).toMatchObject({ x: 111, y: 222, width: 640, height: 480 })
    vi.advanceTimersByTime(5000)
    expect(writesFor('a-a')).toBe(1)
  })

  it('WW-3 resized 同理', () => {
    svc.open('a-a')
    const w = win()
    w.emit('resized')
    vi.advanceTimersByTime(300)
    w.emit('resized')
    vi.advanceTimersByTime(300)
    w.emit('resized')
    expect(writesFor('a-a')).toBe(0)
    vi.advanceTimersByTime(500)
    expect(writesFor('a-a')).toBe(1)
  })

  it('WW-3 close 立即写，并取消待写', () => {
    svc.open('a-a')
    const w = win()
    w.emit('moved')
    vi.advanceTimersByTime(100)
    w.close()
    expect(writesFor('a-a')).toBe(1)
    vi.advanceTimersByTime(2000)
    expect(writesFor('a-a')).toBe(1)
  })

  it('WW-3 300×200 存成 320×240', () => {
    svc.open('a-a')
    const w = win()
    w.bounds = { x: 5, y: 6, width: 300, height: 200 }
    w.close()
    expect(saved('a-a')).toMatchObject({ x: 5, y: 6, width: 320, height: 240 })
  })
})

describe('最小化 / 全屏不记（WW-4）', () => {
  const earlier = { x: 50, y: 60, width: 500, height: 400, alwaysOnTop: false }

  it('WW-4 关窗时最小化 → 不写，之前的保留', () => {
    seedSaved('a-a', earlier)
    svc.open('a-a')
    const w = win()
    w.minimized = true
    w.close()
    expect(writesFor('a-a')).toBe(0)
    expect(saved('a-a')).toEqual(earlier)
  })

  it('WW-4 关窗时全屏 → 不写', () => {
    seedSaved('a-a', earlier)
    svc.open('a-a')
    const w = win()
    w.fullScreen = true
    w.close()
    expect(writesFor('a-a')).toBe(0)
    expect(saved('a-a')).toEqual(earlier)
  })

  it('WW-4 防抖到点时最小化 / 全屏 → 不写', () => {
    seedSaved('a-a', earlier)
    svc.open('a-a')
    const w = win()
    w.emit('moved')
    w.minimized = true
    vi.advanceTimersByTime(600)
    expect(writesFor('a-a')).toBe(0)
    w.minimized = false
    w.fullScreen = true
    w.emit('resized')
    vi.advanceTimersByTime(600)
    expect(writesFor('a-a')).toBe(0)
    expect(saved('a-a')).toEqual(earlier)
  })
})

describe('恢复 bounds（WW-5）', () => {
  const openWith = (state: Record<string, unknown>): Record<string, unknown> => {
    seedSaved('a-a', state)
    svc.open('a-a')
    return win().options
  }

  it('WW-5 在显示器上 → 传 x / y / width / height', () => {
    const o = openWith({ x: 100, y: 120, width: 500, height: 600 })
    expect(o).toMatchObject({ x: 100, y: 120, width: 500, height: 600 })
  })

  it('WW-5 x=3000（显示器外）→ 不传 x / y，宽高照用', () => {
    const o = openWith({ x: 3000, y: 100, width: 500, height: 600 })
    expect(o).not.toHaveProperty('x')
    expect(o).not.toHaveProperty('y')
    expect(o).toMatchObject({ width: 500, height: 600 })
  })

  it('WW-5 水平重叠恰 80 保留，79 丢', () => {
    expect(openWith({ x: 1360, y: 100, width: 500, height: 600 })).toMatchObject({ x: 1360 })
    win().close()
    expect(openWith({ x: 1361, y: 100, width: 500, height: 600 })).not.toHaveProperty('x')
  })

  it('WW-5 y=860 保留，861 丢', () => {
    expect(openWith({ x: 100, y: 860, width: 500, height: 600 })).toMatchObject({ y: 860 })
    win().close()
    expect(openWith({ x: 100, y: 861, width: 500, height: 600 })).not.toHaveProperty('y')
  })

  it('WW-5 getAllDisplays 抛错 → 不传 x / y', () => {
    mocks.displays.mockImplementation(() => {
      throw new Error('no screen')
    })
    const o = openWith({ x: 100, y: 120, width: 500, height: 600 })
    expect(o).not.toHaveProperty('x')
    expect(o).not.toHaveProperty('y')
    expect(o).toMatchObject({ width: 500, height: 600 })
  })

  it('WW-5 宽 <320 → 480×620、不传 x / y，置顶 / preferWindow 照读', () => {
    const o = openWith({
      x: 100,
      y: 120,
      width: 300,
      height: 600,
      alwaysOnTop: true,
      preferWindow: true
    })
    expect(o).toMatchObject({ width: 480, height: 620, alwaysOnTop: true })
    expect(o).not.toHaveProperty('x')
    expect(o).not.toHaveProperty('y')
    expect(svc.preferWindowIds(['a-a'])).toEqual(['a-a'])
  })

  it('WW-5 没存宽高 → 480×620、不传 x / y，置顶照读', () => {
    const o = openWith({ x: 100, y: 120, alwaysOnTop: true, preferWindow: true })
    expect(o).toMatchObject({ width: 480, height: 620, alwaysOnTop: true })
    expect(o).not.toHaveProperty('x')
    expect(svc.preferWindowIds(['a-a'])).toEqual(['a-a'])
  })
})

describe('preferWindow 不被别的写入冲掉（WW-6）', () => {
  it('WW-6 移动后的保存与 setAlwaysOnTop 都保留 preferWindow:true', () => {
    svc.setPreferWindow('a-a', true)
    svc.open('a-a')
    const w = win()
    w.emit('moved')
    vi.advanceTimersByTime(600)
    expect(saved('a-a')?.preferWindow).toBe(true)
    expect(svc.setAlwaysOnTop('a-a', true)).toBe(true)
    expect(saved('a-a')).toMatchObject({ preferWindow: true, alwaysOnTop: true })
    w.close()
    expect(saved('a-a')?.preferWindow).toBe(true)
  })
})

describe('close / openIds 的边角（WW-7）', () => {
  it('WW-7 close 未知 id 不抛', () => {
    expect(() => svc.close('nope-x')).not.toThrow()
  })

  it('WW-7 close 已销毁的窗口不抛', () => {
    svc.open('a-a')
    win().destroyed = true
    expect(() => svc.close('a-a')).not.toThrow()
  })

  it('WW-7 openIds 跳过已销毁的窗口', () => {
    svc.open('a-a')
    svc.open('b-b')
    win(0).destroyed = true
    expect(svc.openIds()).toEqual(['b-b'])
  })

  it('WW-7 close(id) 关掉开着的窗口', () => {
    svc.open('a-a')
    svc.close('a-a')
    expect(svc.openIds()).toEqual([])
    expect(mocks.stopWidget).toHaveBeenCalledWith('a-a')
  })
})
