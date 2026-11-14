/**
 * windowFrameMemory —— 一类窗口记一份「用户上次摆的位置与大小」。
 *
 * 契约：
 *   - placement：没有可用的记录（没存过 / 读不出 / 比最小尺寸小）→ null；有 → 记下的大小 + 位置，
 *     同类窗口已开着几扇就错开几步（FRAME_CASCADE_STEP），错开后跑出屏幕就回到记下的位置本身；
 *     记下的位置不在任何工作区里（标题栏那一条露不出 80×40）→ 只回大小（收到主工作区以内），不带 x / y；
 *   - track：用户拖动 / 缩放后防抖 FRAME_SAVE_DEBOUNCE_MS 记一次，close 时立刻记；窗口没被动过、
 *     最小化 / 全屏 / 最大化 / 已销毁时不记；写失败不抛。
 *
 * 存取与显示器都是注入的假件；计时器是假的。
 *
 * placement
 *   FM-1   没存过 → null
 *   FM-2   读不出 / 不成形的记录 → null，不抛
 *   FM-3   记录原样回（openCount 0）
 *   FM-4   每扇已开的窗口错开一步；负的 openCount 按 0
 *   FM-5   错开后跑出屏幕 → 回到记下的位置本身
 *   FM-6   比最小尺寸小 → null；恰好等于最小尺寸 → 可用
 *   FM-7   小数取整
 *   FM-8   位置不在任何屏幕上 → 只回大小，且不超过主工作区
 *   FM-9   远在屏幕外的负坐标 → 只回大小
 *   FM-10  第二块屏幕上的位置：屏幕在 → 用它；屏幕没了 → 只回大小（收到主工作区）
 *   FM-11  「还在屏幕上」的边界（横向至少露 80、纵向标题栏 40）
 *   FM-12  workAreas 抛错 / 回空 → 只回大小
 *   FM-12b 位置不是数字（null）→ 不当成 0，只回大小
 * track
 *   FM-13  move 防抖：连续触发只记最后一次；记下的能被 placement 读回
 *   FM-14  resize 也记
 *   FM-15  没被动过（含动了又回到原位）→ 不记，close 也不记
 *   FM-16  最小化 / 全屏 / 最大化 / 已销毁时不记；状态解除后照常记
 *   FM-17  (a) close 立刻记、之后不再记第二次 (b) 写失败不抛 (c) 同一个键下两扇窗：只有被动过的那扇记
 *          (d) 键各记各的
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWindowFrameMemory,
  FRAME_CASCADE_STEP,
  FRAME_SAVE_DEBOUNCE_MS,
  type FrameBounds,
  type TrackedWindow,
  type WindowFrameMemory,
  type WorkArea
} from '../windowFrameMemory'

const K = 'window.filePreview'
const K_MD = 'window.markdownWindow'
const MIN = { width: 360, height: 300 }
const PRIMARY: WorkArea = { x: 0, y: 25, width: 1440, height: 875 }
const SECOND: WorkArea = { x: 1440, y: 0, width: 1920, height: 1080 }
const STEP = FRAME_CASCADE_STEP

type TrackEvent = 'move' | 'resize' | 'close'

class FakeWindow implements TrackedWindow {
  bounds: FrameBounds
  destroyed = false
  minimized = false
  fullScreen = false
  maximized = false
  private readonly listeners = new Map<string, Array<() => void>>()

  constructor(bounds: FrameBounds = { x: 100, y: 80, width: 900, height: 760 }) {
    this.bounds = bounds
  }

  getBounds(): FrameBounds {
    return { ...this.bounds }
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  isFullScreen(): boolean {
    return this.fullScreen
  }
  isMaximized(): boolean {
    return this.maximized
  }
  on(event: TrackEvent, listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  emit(event: TrackEvent): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn()
  }
}

let store: Map<string, string>
let read: ReturnType<typeof vi.fn<(key: string) => string | undefined>>
let write: ReturnType<typeof vi.fn<(key: string, value: string) => void>>
let workAreas: ReturnType<typeof vi.fn<() => WorkArea[]>>
let memory: WindowFrameMemory

beforeEach(() => {
  store = new Map()
  read = vi.fn((key: string) => store.get(key))
  write = vi.fn((key: string, value: string) => {
    store.set(key, value)
  })
  workAreas = vi.fn(() => [PRIMARY])
  memory = createWindowFrameMemory({ read, write, workAreas })
})

afterEach(() => {
  vi.useRealTimers()
})

const save = (record: unknown, key = K): void => {
  store.set(key, typeof record === 'string' ? record : JSON.stringify(record))
}

describe('placement', () => {
  it('FM-1 没存过 → null', () => {
    expect(memory.placement(K, MIN, 0)).toBeNull()
  })

  it.each([
    ['不是 JSON', 'not json'],
    ['null', 'null'],
    ['数字', '42'],
    ['空对象', '{}'],
    ['只有位置', '{"x":10,"y":50}'],
    ['宽度不是数字', '{"x":10,"y":50,"width":"abc","height":700}']
  ])('FM-2 %s → null，不抛', (_label, raw) => {
    save(raw)
    expect(memory.placement(K, MIN, 0)).toBeNull()
  })

  it('FM-2 read 抛错 → null，不抛', () => {
    read.mockImplementation(() => {
      throw new Error('db closed')
    })
    expect(memory.placement(K, MIN, 0)).toBeNull()
  })

  it('FM-3 记录原样回（openCount 0）', () => {
    save({ x: 100, y: 80, width: 1000, height: 700 })
    expect(memory.placement(K, MIN, 0)).toEqual({ width: 1000, height: 700, x: 100, y: 80 })
  })

  it('FM-4 每扇已开的窗口错开一步；负的 openCount 按 0', () => {
    save({ x: 100, y: 80, width: 1000, height: 700 })
    expect(memory.placement(K, MIN, 1)).toEqual({
      width: 1000,
      height: 700,
      x: 100 + STEP,
      y: 80 + STEP
    })
    expect(memory.placement(K, MIN, 1)).toMatchObject({ x: 124, y: 104 })
    expect(memory.placement(K, MIN, 3)).toEqual({
      width: 1000,
      height: 700,
      x: 100 + 3 * STEP,
      y: 80 + 3 * STEP
    })
    expect(memory.placement(K, MIN, 3)).toMatchObject({ x: 172, y: 152 })
    expect(memory.placement(K, MIN, -2)).toEqual({ width: 1000, height: 700, x: 100, y: 80 })
  })

  it('FM-5 错开后跑出屏幕 → 回到记下的位置本身', () => {
    save({ x: 1300, y: 80, width: 1000, height: 700 })
    expect(memory.placement(K, MIN, 2)).toMatchObject({ x: 1300 + 2 * STEP, y: 80 + 2 * STEP })
    expect(memory.placement(K, MIN, 2)).toMatchObject({ x: 1348, y: 128 })
    expect(memory.placement(K, MIN, 3)).toMatchObject({ x: 1300, y: 80 })
  })

  it('FM-6 比最小尺寸小 → null；恰好等于最小尺寸 → 可用', () => {
    save({ x: 100, y: 80, width: 359, height: 700 })
    expect(memory.placement(K, MIN, 0)).toBeNull()
    save({ x: 100, y: 80, width: 1000, height: 299 })
    expect(memory.placement(K, MIN, 0)).toBeNull()
    save({ x: 100, y: 80, width: 360, height: 300 })
    expect(memory.placement(K, MIN, 0)).toEqual({ width: 360, height: 300, x: 100, y: 80 })
  })

  it('FM-7 小数取整', () => {
    save({ x: 100.4, y: 79.6, width: 1000.5, height: 699.5 })
    expect(memory.placement(K, MIN, 0)).toEqual({ x: 100, y: 80, width: 1001, height: 700 })
  })

  it('FM-8 位置不在任何屏幕上 → 只回大小，且不超过主工作区', () => {
    save({ x: 3000, y: 100, width: 1800, height: 1000 })
    for (const openCount of [0, 5]) {
      const result = memory.placement(K, MIN, openCount)
      expect(result).toEqual({ width: 1440, height: 875 })
      expect('x' in result!).toBe(false)
      expect('y' in result!).toBe(false)
    }
  })

  it('FM-9 远在屏幕外的负坐标 → 只回大小', () => {
    save({ x: -5000, y: -5000, width: 800, height: 600 })
    const result = memory.placement(K, MIN, 0)
    expect(result).toEqual({ width: 800, height: 600 })
    expect('x' in result!).toBe(false)
    expect('y' in result!).toBe(false)
  })

  it('FM-10 第二块屏幕上的位置：屏幕在 → 用它；屏幕没了 → 只回大小', () => {
    save({ x: 2000, y: 100, width: 1800, height: 1000 })
    workAreas.mockReturnValue([PRIMARY, SECOND])
    expect(memory.placement(K, MIN, 1)).toEqual({ width: 1800, height: 1000, x: 2024, y: 124 })

    workAreas.mockReturnValue([PRIMARY])
    const result = memory.placement(K, MIN, 1)
    expect(result).toEqual({ width: 1440, height: 875 })
    expect('x' in result!).toBe(false)
  })

  it.each([
    [1360, 80, true],
    [1361, 80, false],
    [-920, 80, true],
    [-921, 80, false],
    [100, 860, true],
    [100, 861, false],
    [100, 24, false]
  ])('FM-11 x:%i y:%i → 位置保留=%s', (x, y, kept) => {
    save({ x, y, width: 1000, height: 700 })
    const result = memory.placement(K, MIN, 0)
    if (kept) {
      expect(result).toEqual({ width: 1000, height: 700, x, y })
    } else {
      expect(result).toEqual({ width: 1000, height: 700 })
      expect('x' in result!).toBe(false)
      expect('y' in result!).toBe(false)
    }
  })

  it('FM-12 workAreas 抛错 / 回空 → 只回大小', () => {
    save({ x: 100, y: 80, width: 1000, height: 700 })
    workAreas.mockImplementation(() => {
      throw new Error('no screen module')
    })
    const thrown = memory.placement(K, MIN, 0)
    expect(thrown).toEqual({ width: 1000, height: 700 })
    expect('x' in thrown!).toBe(false)
    expect('y' in thrown!).toBe(false)

    workAreas.mockImplementation(() => [])
    const empty = memory.placement(K, MIN, 0)
    expect(empty).toEqual({ width: 1000, height: 700 })
    expect('x' in empty!).toBe(false)
    expect('y' in empty!).toBe(false)
  })

  it('FM-12b 位置不是数字（null）→ 不当成 0，只回大小', () => {
    save('{"x":null,"y":null,"width":900,"height":700}')
    workAreas.mockReturnValue([{ x: 0, y: 0, width: 1440, height: 900 }])
    const result = memory.placement(K, MIN, 0)
    expect(result).toEqual({ width: 900, height: 700 })
    expect('x' in result!).toBe(false)
    expect('y' in result!).toBe(false)
  })
})

describe('track', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  const MOVED: FrameBounds = { x: 300, y: 200, width: 900, height: 760 }
  const written = (call = 0): unknown => JSON.parse(write.mock.calls[call][1])

  it('FM-13 move 防抖：连续触发只记最后一次；记下的能被 placement 读回', () => {
    const win = new FakeWindow()
    memory.track(K, win)

    win.bounds = { ...MOVED }
    win.emit('move')
    vi.advanceTimersByTime(FRAME_SAVE_DEBOUNCE_MS - 1)
    expect(FRAME_SAVE_DEBOUNCE_MS - 1).toBe(499)
    expect(write).not.toHaveBeenCalled()

    win.emit('move')
    vi.advanceTimersByTime(FRAME_SAVE_DEBOUNCE_MS - 1)
    expect(write).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toBe(K)
    expect(written()).toEqual(MOVED)

    expect(memory.placement(K, MIN, 0)).toEqual(MOVED)
  })

  it('FM-14 resize 也记', () => {
    const win = new FakeWindow()
    memory.track(K, win)
    const resized = { x: 100, y: 80, width: 1100, height: 800 }
    win.bounds = { ...resized }
    win.emit('resize')
    vi.advanceTimersByTime(FRAME_SAVE_DEBOUNCE_MS)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0][0]).toBe(K)
    expect(written()).toEqual(resized)
  })

  it('FM-15 没被动过（含动了又回到原位）→ 不记，close 也不记', () => {
    const win = new FakeWindow()
    memory.track(K, win)

    win.emit('move')
    win.emit('resize')
    vi.advanceTimersByTime(FRAME_SAVE_DEBOUNCE_MS)
    expect(write).not.toHaveBeenCalled()

    win.emit('close')
    expect(write).not.toHaveBeenCalled()

    win.bounds = { ...win.bounds, x: 300 }
    win.bounds = { ...win.bounds, x: 100 }
    win.emit('move')
    vi.advanceTimersByTime(FRAME_SAVE_DEBOUNCE_MS)
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['minimized', 'fullScreen', 'maximized', 'destroyed'] as const)(
    'FM-16 %s 时不记；状态解除后照常记',
    (flag) => {
      const win = new FakeWindow()
      memory.track(K, win)

      win.bounds = { x: 0, y: 25, width: 1440, height: 875 }
      win[flag] = true
      win.emit('resize')
      vi.advanceTimersByTime(FRAME_SAVE_DEBOUNCE_MS)
      expect(write).not.toHaveBeenCalled()
      win.emit('close')
      expect(write).not.toHaveBeenCalled()

      if (flag === 'destroyed') return
      win[flag] = false
      win.bounds = { ...MOVED }
      win.emit('move')
      vi.advanceTimersByTime(FRAME_SAVE_DEBOUNCE_MS)
      expect(write).toHaveBeenCalledTimes(1)
      expect(written()).toEqual(MOVED)
    }
  )

  it('FM-17a close 立刻记，之后不再记第二次', () => {
    const win = new FakeWindow()
    memory.track(K, win)
    win.bounds = { ...MOVED }
    win.emit('move')
    vi.advanceTimersByTime(100)
    expect(write).not.toHaveBeenCalled()

    win.emit('close')
    expect(write).toHaveBeenCalledTimes(1)
    expect(written()).toEqual(MOVED)

    vi.advanceTimersByTime(1000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('FM-17b 写失败不抛（防抖那次与 close 那次）', () => {
    write.mockImplementation(() => {
      throw new Error('disk full')
    })
    const win = new FakeWindow()
    memory.track(K, win)
    win.bounds = { ...MOVED }
    win.emit('move')
    expect(() => vi.advanceTimersByTime(FRAME_SAVE_DEBOUNCE_MS)).not.toThrow()
    expect(() => win.emit('close')).not.toThrow()
    expect(write).toHaveBeenCalled()
  })

  it('FM-17c 同一个键下两扇窗：只有被动过的那扇记', () => {
    const a = new FakeWindow({ x: 100, y: 80, width: 900, height: 760 })
    const b = new FakeWindow({ x: 124, y: 104, width: 900, height: 760 })
    memory.track(K, a)
    memory.track(K, b)

    const movedB = { x: 400, y: 300, width: 1000, height: 700 }
    b.bounds = { ...movedB }
    b.emit('move')
    vi.advanceTimersByTime(FRAME_SAVE_DEBOUNCE_MS)
    expect(JSON.parse(store.get(K)!)).toEqual(movedB)

    a.emit('close')
    expect(JSON.parse(store.get(K)!)).toEqual(movedB)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('FM-17d 键各记各的', () => {
    const win = new FakeWindow()
    memory.track(K_MD, win)
    win.bounds = { ...MOVED }
    win.emit('move')
    vi.advanceTimersByTime(FRAME_SAVE_DEBOUNCE_MS)

    expect(write.mock.calls.map((c) => c[0])).toEqual([K_MD])
    expect([...store.keys()]).toEqual([K_MD])
    expect(memory.placement(K, MIN, 0)).toBeNull()
    expect(memory.placement(K_MD, { width: 480, height: 400 }, 0)).toEqual(MOVED)
  })
})
