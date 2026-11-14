/**
 * 窗口位置与大小的记忆 —— 给「一类窗口开很多扇」的窗口用（文件预览窗口、md 窗口）。
 *
 * 这类窗口按文件各开各的，按文件逐个记会让设置表无限长，所以**一类窗口只记一份**：用户最近一次
 * 亲手摆过（拖动 / 缩放）的那扇窗的位置与大小。下一扇新窗口按这份大小开在这个位置上；同类窗口
 * 此刻已经开着几扇，就再错开几步，免得完全叠在一起。
 *
 * 只记用户摆出来的：
 *  - 窗口从没被动过（bounds 还是开窗时那一份）不记 —— 否则错开出来的位置会被当成用户的选择，
 *    每多开一扇就往右下漂一步；
 *  - 最小化 / 全屏 / 最大化时的 bounds 不是用户摆的那个窗口，不记。
 *
 * 存下的位置已不在任何显示器上（外接屏拔了）就不用它，只沿用大小（收到主工作区以内），位置交回调用方的默认。
 *
 * 纯逻辑：存取与显示器都由调用方注入，这里不碰 electron 与数据库。
 */

export interface FrameBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface FrameSize {
  width: number
  height: number
}

/** 显示器的工作区（electron `Display.workArea`） */
export type WorkArea = FrameBounds

/** 被记录的窗口 —— BrowserWindow 的一个子集 */
export interface TrackedWindow {
  getBounds(): FrameBounds
  isDestroyed(): boolean
  isMinimized(): boolean
  isFullScreen(): boolean
  isMaximized(): boolean
  on(event: 'move' | 'resize' | 'close', listener: () => void): unknown
}

export interface WindowFrameMemoryDeps {
  read: (key: string) => string | undefined
  write: (key: string, value: string) => void
  /** 各显示器的工作区，主显示器在第一个；抛错按「没有显示器信息」处理 */
  workAreas: () => WorkArea[]
}

export interface FramePlacement extends FrameSize {
  x?: number
  y?: number
}

export interface WindowFrameMemory {
  /**
   * 新窗口该用的大小与位置。
   * @param key 设置键（一类窗口一个）
   * @param min 窗口的最小尺寸；存下的比它小就当没存过
   * @param openCount 同类窗口此刻已经开着几扇（每扇错开一步）
   * @returns 没有可用的记录时回 null（调用方用自己的默认）；有位置时带 x / y
   */
  placement(key: string, min: FrameSize, openCount: number): FramePlacement | null
  /** 开窗后调用：之后用户拖动 / 缩放这扇窗就记下来 */
  track(key: string, win: TrackedWindow): void
}

/** 新窗口相对上一扇错开的像素 */
export const FRAME_CASCADE_STEP = 24
/** 拖动 / 缩放后多久记一次 */
export const FRAME_SAVE_DEBOUNCE_MS = 500

/** 这块矩形还在某个工作区里（标题栏那一条至少露出 80×40 —— 够把窗口拖回来） */
function onSomeArea(areas: WorkArea[], x: number, y: number, width: number): boolean {
  return areas.some((a) => {
    const overlapX = Math.min(x + width, a.x + a.width) - Math.max(x, a.x)
    const overlapY = Math.min(y + 40, a.y + a.height) - Math.max(y, a.y)
    return overlapX >= 80 && overlapY >= 40
  })
}

function sameBounds(a: FrameBounds, b: FrameBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export function createWindowFrameMemory(deps: WindowFrameMemoryDeps): WindowFrameMemory {
  const areasNow = (): WorkArea[] => {
    try {
      return deps.workAreas()
    } catch {
      return []
    }
  }

  const readSaved = (key: string): Partial<FrameBounds> => {
    try {
      const raw = deps.read(key)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      return parsed && typeof parsed === 'object' ? (parsed as Partial<FrameBounds>) : {}
    } catch {
      return {}
    }
  }

  return {
    placement(key, min, openCount) {
      const saved = readSaved(key)
      const width = Math.round(Number(saved.width))
      const height = Math.round(Number(saved.height))
      if (!(width >= min.width) || !(height >= min.height)) return null

      const areas = areasNow()
      // 位置只认数字：`null` / `''` 经 Number() 会变成 0，不能当成「左上角」
      const x = typeof saved.x === 'number' ? Math.round(saved.x) : NaN
      const y = typeof saved.y === 'number' ? Math.round(saved.y) : NaN
      if (Number.isFinite(x) && Number.isFinite(y) && onSomeArea(areas, x, y, width)) {
        const offset = Math.max(0, openCount) * FRAME_CASCADE_STEP
        // 错开后跑出屏幕了（开了很多扇）就回到记下的位置本身
        const shifted = onSomeArea(areas, x + offset, y + offset, width)
        return { width, height, x: shifted ? x + offset : x, y: shifted ? y + offset : y }
      }
      // 位置用不了：只沿用大小，且不超过主工作区（记录来自一块更大的、已经不在的屏幕）
      const primary = areas[0]
      return primary
        ? {
            width: Math.max(min.width, Math.min(width, primary.width)),
            height: Math.max(min.height, Math.min(height, primary.height))
          }
        : { width, height }
    },

    track(key, win) {
      const initial = win.getBounds()
      let timer: ReturnType<typeof setTimeout> | null = null

      const save = (): void => {
        if (win.isDestroyed()) return
        if (win.isMinimized() || win.isFullScreen() || win.isMaximized()) return
        const bounds = win.getBounds()
        // 没被动过：开窗时那一份（含错开出来的位置）不是用户的选择
        if (sameBounds(bounds, initial)) return
        try {
          deps.write(
            key,
            JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
          )
        } catch {
          // 记不下来不影响窗口本身
        }
      }
      const schedule = (): void => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          save()
        }, FRAME_SAVE_DEBOUNCE_MS)
      }

      // `move` / `resize` 三个平台都有（`moved` / `resized` 在 Linux 上没有）；拖动中连续触发，靠防抖收成一次
      win.on('move', schedule)
      win.on('resize', schedule)
      win.on('close', () => {
        if (timer) clearTimeout(timer)
        timer = null
        save()
      })
    }
  }
}
